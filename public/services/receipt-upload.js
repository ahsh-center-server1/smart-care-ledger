/**
 * services/receipt-upload.js — 영수증 업로드의 유일한 입구
 *
 * 왜 서버를 거치나
 *   예전에는 브라우저가 최종 경로(`receipts/{clientId}/…`)에 직접 쓰고 그 URL 을
 *   거래 문서에 적었다. 그러면 이미 붙어 있는 증빙을 조용히 덮어쓸 수 있고,
 *   Storage 복사와 Firestore 갱신 사이에서 실패했을 때 "사진은 있는데 거래가
 *   없는" 상태가 쌓인다.
 *
 *   지금은 세 단계다:
 *     1. 스테이징(`receiptStaging/{uid}/{uploadId}/source`)에 올린다 —
 *        규칙이 경로의 uid 로 소유권을 보고, 덮어쓰기를 막는다.
 *     2. AI 판독은 그 staging 원본과 job 소유권을 서버가 확인한 뒤에만 한다.
 *     3. 서버가 최종 경로로 복사하고 거래에 붙인다(functions/receipt-fns.js).
 *
 *   최종 경로는 브라우저가 쓸 수 없다. 그것이 이 파일이 있는 이유다.
 */

'use strict';

import { invalidateReportTrxCache } from './firestore.js';

import { uploadToStorage } from './storage.js';

/** AI 판독 전에 서버가 job을 만들고 불변 staging 원본을 올린다. */
export async function prepareReceiptForAnalysis(clientId, file) {
  const { call } = window._fbFn;
  const started = await call('startReceiptUpload')({ clientId });
  const { uploadId, stagingPath } = started.data || {};
  if (!uploadId || !stagingPath) throw new Error('업로드를 시작하지 못했습니다.');
  await uploadToStorage(file, stagingPath);
  return { uploadId, stagingPath };
}

/**
 * 영수증 한 장을 올리고 거래에 붙인다.
 *
 * @param {Object} opts
 * @param {string} opts.clientId
 * @param {File}   opts.file
 * @param {string} [opts.trxId]  기존 거래에 붙일 때
 * @param {Object} [opts.draft]  새 거래를 만들 때 (date · amount · category …)
 * @returns {Promise<{trxId: string, url: string, path: string, created: boolean}>}
 */
export async function uploadReceipt({
  clientId, file, trxId, draft,
  expectedReceiptPath = '', expectedReceiptGeneration = '', expectedReceiptUrl = '',
}) {
  const { call } = window._fbFn;

  const started = await call('startReceiptUpload')({ clientId });
  const { uploadId, stagingPath } = started.data || {};
  if (!uploadId || !stagingPath) throw new Error('업로드를 시작하지 못했습니다.');

  await uploadToStorage(file, stagingPath);
  await call('completeReceiptUpload')({ uploadId });

  // 서버가 거래에 증빙을 붙였다(또는 초안 거래를 새로 만들었다).
  // 브라우저의 배치 헬퍼를 지나지 않으므로 보고서 캐시를 여기서 버린다 —
  // 영수증 쓰기의 입구가 이 파일 하나라, 호출부마다 기억할 필요가 없다.
  const res = await call('finalizeReceipts')({
    items: [{
      uploadId,
      ...(trxId ? { trxId, expectedReceiptPath, expectedReceiptGeneration, expectedReceiptUrl } : {}),
      ...(draft ? { draft } : {}),
    }],
  });
  const row = ((res.data || {}).results || [])[0];
  if (!row || !row.ok) throw new Error((row && row.error) || '증빙 저장에 실패했습니다.');
  if (row.created) {
    invalidateReportTrxCache('', { forceRefresh: true, clientIds: [clientId] });
  } else {
    invalidateReportTrxCache(clientId);
  }
  return row;
}

/**
 * 판독만 하고 **저장하지 않기로 한** 사진을 지금 버린다.
 *
 * 판독은 사진을 먼저 스테이징에 올려야 성립한다(서버가 원본을 봐야 한다).
 * 그래서 「건너뛰기」로 둔 사진, 창을 닫으며 남긴 사진도 이미 Storage 에 있다.
 * TTL 이 받아 주기는 하지만, 사용자가 안 쓴다고 정한 순간이 지울 수 있는 가장
 * 이른 때다 — 무료 한도(5GB)를 저장하지 않은 사진으로 채우지 않는다.
 *
 * **실패해도 던지지 않는다.** 이것은 정리이지 사용자가 하려던 일이 아니다.
 * 창을 닫는데 "정리 실패" 가 뜨면 사용자는 무엇이 잘못됐는지 알 수 없고,
 * 못 지운 것은 어차피 TTL 이 받는다.
 */
export async function discardReceiptUploads(uploadIds) {
  const ids = (uploadIds || []).map((v) => String(v || '')).filter(Boolean);
  if (!ids.length) return { discarded: 0, kept: 0 };
  try {
    const res = await window._fbFn.call('discardReceiptUploads')({ uploadIds: ids });
    return res.data || { discarded: 0, kept: ids.length };
  } catch (e) {
    console.debug('[영수증] 임시 사진 정리 실패 — TTL 에 맡깁니다', e);
    return { discarded: 0, kept: ids.length };
  }
}

/**
 * 여러 장을 한꺼번에. 사진 묶음 자동입력이 쓴다.
 *
 * 올리기는 **한 장씩 순서대로** 한다 — 예전에 병렬로 올렸다가 모바일에서
 * 메모리가 터졌다. 최종화는 한 번의 호출로 묶는다.
 *
 * @param {string} clientId
 * @param {Array<{file: File, trxId?: string, draft?: Object}>} entries
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function uploadReceipts(clientId, entries, onProgress) {
  const { call } = window._fbFn;
  const items = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let uploadId = String(e.uploadId || '');
    if (!uploadId) {
      const started = await call('startReceiptUpload')({ clientId });
      const stagingPath = (started.data || {}).stagingPath;
      uploadId = String((started.data || {}).uploadId || '');
      if (!uploadId || !stagingPath) throw new Error('업로드를 시작하지 못했습니다.');
      await uploadToStorage(e.file, stagingPath);
      await call('completeReceiptUpload')({ uploadId });
    }
    items.push({
      uploadId,
      ...(e.trxId ? {
        trxId: e.trxId,
        expectedReceiptPath: e.expectedReceiptPath || '',
        expectedReceiptGeneration: e.expectedReceiptGeneration || '',
        expectedReceiptUrl: e.expectedReceiptUrl || '',
      } : {}),
      ...(e.draft ? { draft: e.draft } : {}),
    });
    if (onProgress) onProgress(i + 1, entries.length);
  }

  const res = await call('finalizeReceipts')({ items });
  const out = res.data || { okCount: 0, failCount: entries.length, results: [] };
  const created = (out.results || []).some(row => row && row.ok && row.created);
  if (created) {
    invalidateReportTrxCache('', { forceRefresh: true, clientIds: [clientId] });
  } else {
    invalidateReportTrxCache(clientId);
  }
  return out;
}

export async function removeReceipt({
  trxId, expectedReceiptPath = '', expectedReceiptGeneration = '', expectedReceiptUrl = '',
}) {
  const { call } = window._fbFn;
  const res = await call('removeReceipt')({
    trxId, expectedReceiptPath, expectedReceiptGeneration, expectedReceiptUrl,
  });
  invalidateReportTrxCache();
  return res.data || { ok: false };
}
