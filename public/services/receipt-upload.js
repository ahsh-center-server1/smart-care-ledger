/**
 * services/receipt-upload.js — 영수증 업로드의 유일한 입구
 *
 * 왜 서버를 거치나
 *   예전에는 브라우저가 최종 경로(`receipts/{clientId}/…`)에 직접 쓰고 그 URL 을
 *   거래 문서에 적었다. 그러면 이미 붙어 있는 증빙을 조용히 덮어쓸 수 있고,
 *   Storage 복사와 Firestore 갱신 사이에서 실패했을 때 "사진은 있는데 거래가
 *   없는" 상태가 쌓인다.
 *
 *   지금은 두 단계다:
 *     1. 스테이징(`receiptStaging/{uid}/{uploadId}/source`)에 올린다 —
 *        규칙이 경로의 uid 로 소유권을 보고, 덮어쓰기를 막는다.
 *     2. 서버가 최종 경로로 복사하고 거래에 붙인다(functions/receipt-fns.js).
 *
 *   최종 경로는 브라우저가 쓸 수 없다. 그것이 이 파일이 있는 이유다.
 */

'use strict';

import { uploadToStorage } from './storage.js';

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
export async function uploadReceipt({ clientId, file, trxId, draft }) {
  const { call } = window._fbFn;

  const started = await call('startReceiptUpload')({ clientId });
  const { uploadId, stagingPath } = started.data || {};
  if (!uploadId || !stagingPath) throw new Error('업로드를 시작하지 못했습니다.');

  await uploadToStorage(file, stagingPath);

  const res = await call('finalizeReceipts')({
    items: [{ uploadId, ...(trxId ? { trxId } : {}), ...(draft ? { draft } : {}) }],
  });
  const row = ((res.data || {}).results || [])[0];
  if (!row || !row.ok) throw new Error((row && row.error) || '증빙 저장에 실패했습니다.');
  return row;
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
    const started = await call('startReceiptUpload')({ clientId });
    const { uploadId, stagingPath } = started.data || {};
    if (!uploadId || !stagingPath) throw new Error('업로드를 시작하지 못했습니다.');
    await uploadToStorage(e.file, stagingPath);
    items.push({ uploadId, ...(e.trxId ? { trxId: e.trxId } : {}), ...(e.draft ? { draft: e.draft } : {}) });
    if (onProgress) onProgress(i + 1, entries.length);
  }

  const res = await call('finalizeReceipts')({ items });
  return res.data || { okCount: 0, failCount: entries.length, results: [] };
}
