'use strict';

export function hasReceipt(transaction) {
  return !!(transaction && (transaction.receiptPath || transaction.receiptUrl));
}

export async function receiptAccessUrl(transactionOrId) {
  const trxId = typeof transactionOrId === 'string'
    ? transactionOrId
    : String((transactionOrId || {}).id || '');
  if (!trxId) {
    const legacy = String((transactionOrId || {}).receiptUrl || '');
    if (legacy) return legacy;
    throw new Error('거래 식별자가 없어 증빙을 열 수 없습니다.');
  }
  const res = await window._fbFn.call('getReceiptAccessUrl')({ trxId });
  const url = String((res && res.data && res.data.url) || '');
  if (!url) throw new Error('증빙 열람 주소를 받지 못했습니다.');
  return url;
}
