'use strict';

module.exports = function receiptAccessFns(ctx) {
  const {
    db, getBucket, callable, HttpsError, requireAuthz, requireSees, fixedCan,
  } = ctx;

  const getReceiptAccessUrl = callable('getReceiptAccessUrl', async (request) => {
    const auth = request.auth;
    const currentAuthz = await requireAuthz(auth);
    const trxId = String((request.data || {}).trxId || '').trim();
    if (!trxId) throw new HttpsError('invalid-argument', '거래 식별자가 필요합니다.');
    const snap = await db.collection('transactions').doc(trxId).get();
    if (!snap.exists) throw new HttpsError('not-found', '거래를 찾을 수 없습니다.');
    const trx = snap.data() || {};
    const clientId = String(trx.clientId || '');
    requireSees(currentAuthz, clientId);
    if (!fixedCan(currentAuthz, 'trx.view.all') && String(trx.createdBy || '') !== auth.uid) {
      throw new HttpsError('permission-denied', '이 거래의 증빙을 열람할 권한이 없습니다.');
    }

    const path = String(trx.receiptPath || '');
    if (!path) {
      const legacyUrl = String(trx.receiptUrl || '');
      if (!legacyUrl) throw new HttpsError('not-found', '연결된 증빙이 없습니다.');
      return { url: legacyUrl, legacy: true };
    }
    if (!path.startsWith(`receipts/${clientId}/`)) {
      throw new HttpsError('failed-precondition', '증빙 경로가 거래의 입주자와 일치하지 않습니다.');
    }
    const file = getBucket().file(path);
    const [meta] = await file.getMetadata();
    if (trx.receiptGeneration != null
        && String(meta.generation) !== String(trx.receiptGeneration)) {
      throw new HttpsError('aborted', '증빙 파일이 갱신 중입니다. 잠시 후 다시 시도하세요.');
    }
    const [url] = await file.getSignedUrl({
      version: 'v4', action: 'read', expires: Date.now() + 5 * 60 * 1000,
    });
    // contentType 을 함께 준다. 최종 경로에 확장자가 없고 서명 URL 의 호스트도
    // firebasestorage 가 아니라서, 화면이 URL 문자열로 종류를 추측하면 전부
    // 빗나간다 — 실제로 미리보기가 📄 아이콘만 뜨는 원인이었다.
    return { url, contentType: String(meta.contentType || ''), expiresInSeconds: 300 };
  });

  return { getReceiptAccessUrl };
};
