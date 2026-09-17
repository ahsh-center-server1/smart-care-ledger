'use strict';

export function hasReceipt(transaction) {
  return !!(transaction && (transaction.receiptPath || transaction.receiptUrl));
}

/**
 * 증빙 열람 정보를 받아 온다.
 *
 * **contentType 을 URL 로 추측하지 않는다.** 최종 경로는 uploadId 에서 나와
 * 확장자가 없고, 서명 URL 의 호스트도 firebasestorage 가 아니다. 그래서
 * 파일명·호스트로 종류를 판정하면 전부 빗나가고, 화면은 이미지 대신 📄
 * 아이콘만 띄운다 — 실제로 그렇게 미리보기가 죽어 있었다.
 *
 * @returns {Promise<{url:string, contentType:string}>}
 */
export async function receiptAccess(transactionOrId) {
  const trxId = typeof transactionOrId === 'string'
    ? transactionOrId
    : String((transactionOrId || {}).id || '');
  if (!trxId) {
    // 구형 데이터는 거래에 URL 이 직접 박혀 있다. 종류는 알 수 없으므로
    // 빈 문자열을 주고, 화면이 URL 모양으로 판정하게 둔다.
    const legacy = String((transactionOrId || {}).receiptUrl || '');
    if (legacy) return { url: legacy, contentType: '' };
    throw new Error('거래 식별자가 없어 증빙을 열 수 없습니다.');
  }
  const res = await window._fbFn.call('getReceiptAccessUrl')({ trxId });
  const url = String((res && res.data && res.data.url) || '');
  if (!url) throw new Error('증빙 열람 주소를 받지 못했습니다.');
  return { url, contentType: String((res.data && res.data.contentType) || '') };
}

/** URL 만 필요한 곳(일괄 출력 등)을 위한 얇은 래퍼. */
export async function receiptAccessUrl(transactionOrId) {
  return (await receiptAccess(transactionOrId)).url;
}

/**
 * 미리보기에서 무엇으로 그릴지 — **순수 함수**.
 *
 * contentType 이 있으면 그것만 본다. URL 로 추측하는 것은 구형 데이터
 * (거래에 URL 이 직접 박혀 있어 종류를 알 수 없는 경우) 전용 되돌림 경로다.
 *
 * 왜 분리했나: 서명 URL 은 확장자도 firebasestorage 호스트도 없어서 예전
 * 판정이 전부 빗나갔고, 그 로직이 DOM 함수 안에 있어 테스트되지 않았다.
 *
 * @returns {'drive'|'pdf'|'image'|'other'}
 */
export function receiptViewKind(url, contentType) {
  const u = String(url || '');
  if (!u) return 'other';
  if (/\/d\/([^/?]+)/.test(u)) return 'drive';

  const ct = String(contentType || '').toLowerCase();
  if (ct) {
    if (ct === 'application/pdf') return 'pdf';
    if (ct.startsWith('image/')) return 'image';
    return 'other';
  }

  // 이하 구형 데이터 전용.
  const isStorage = u.includes('firebasestorage.googleapis.com')
    || u.includes('storage.googleapis.com');
  if (/\.pdf/i.test(decodeURIComponent(u))) return 'pdf';
  if (/\.(jpg|jpeg|png|gif|webp|bmp)/i.test(u) || isStorage) return 'image';
  return 'other';
}
