'use strict';

/**
 * discardReceiptUploads — 판독만 하고 저장하지 않은 사진을 **지금** 버린다.
 *
 * 왜 이런 사진이 생기나
 *   「영수증 사진」은 판독 전에 사진을 스테이징에 올린다 — 서버가 원본을 봐야
 *   하므로 다른 길이 없다. 그런데 사용자가 판독 결과만 보고 창을 닫거나 몇
 *   장을 「건너뛰기」로 두는 일이 흔하다. 그 사진들은 **저장하지 않기로 한
 *   것인데도** 파일은 이미 올라가 있다.
 *
 *   스테이징 TTL 을 두 시간으로 줄였지만(receipt-jobs.cjs) 그것은 그물이지
 *   정답이 아니다. 사용자가 "안 쓴다"고 정한 순간이 지울 수 있는 가장 이른
 *   때이고, 무료 한도 5GB 를 저장하지 않은 사진으로 채울 이유가 없다.
 *
 * 무엇을 지우지 않는가 — 이쪽이 더 중요하다
 *   이미 거래에 붙은 job(ATTACHED_STATES)은 건드리지 않는다. 최종 객체는 그
 *   거래의 증빙이고, 여기서 지우면 **결재가 끝난 문서의 증빙이 사라진다.**
 *   되돌릴 방법이 없는 유일한 위험이 이것이라, 판정을 예약 정리와 **같은
 *   함수**(receipt-cleanup.js 의 cleanupExpiredJob)에 맡긴다. 즉시 삭제를 따로
 *   구현하면 최종 객체 보존·generation 사전조건·orphan 감사 세 가지를 두 곳에서
 *   맞춰야 하고, 어긋나는 순간 조용히 증빙이 지워진다.
 *
 * 왜 권한 검사가 소유권뿐인가
 *   job 문서 경로에 uid 가 들어 있어(`receiptJobs/{uid}/items/{uploadId}`)
 *   남의 job 은 애초에 가리킬 수 없다. 자기가 올린 임시 파일을 자기가 지우는
 *   일이라 입주자 담당 여부를 다시 볼 이유가 없다.
 */

const { ATTACHED_STATES, jobPath } = require('./receipt-jobs.cjs');

/** uploadId 형식 — Storage 경로와 Firestore 문서 ID 로 동시에 쓰인다. */
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

module.exports = function receiptDiscard(ctx) {
  const {
    db, callable, HttpsError, logger, requireAuthz, cleanupExpiredJob, maxItems,
  } = ctx;

  const discardReceiptUploads = callable('discardReceiptUploads', async (request) => {
    const auth = request.auth;
    await requireAuthz(auth);

    const raw = (request.data || {}).uploadIds;
    const ids = Array.isArray(raw) ? raw.map((v) => String(v || '')) : [];
    if (!ids.length) return { discarded: 0, kept: 0 };
    if (ids.length > maxItems) {
      throw new HttpsError('invalid-argument', `한 번에 ${maxItems}건까지만 정리할 수 있습니다.`);
    }

    let discarded = 0;
    let kept = 0;
    for (const uploadId of ids) {
      if (!UPLOAD_ID.test(uploadId)) { kept += 1; continue; }
      const ref = db.doc(jobPath(auth.uid, uploadId));
      try {
        const snap = await ref.get();
        // 이미 없으면 목적은 달성된 것이다 — 실패로 세지 않는다.
        if (!snap.exists) { discarded += 1; continue; }
        if (ATTACHED_STATES.includes((snap.data() || {}).state)) { kept += 1; continue; }

        // 만료시키고 예약 정리와 같은 절차를 그대로 태운다.
        await ref.update({ expireAt: new Date(Date.now() - 1000) });
        const out = await cleanupExpiredJob(await ref.get());
        if (out && out.removed) discarded += 1; else kept += 1;
      } catch (err) {
        // 한 장이 남아도 TTL 이 받는다. 그것 때문에 나머지를 못 지우는 편이 나쁘다.
        logger.warn('[discardReceiptUploads] 정리 실패 — TTL 에 맡깁니다', {
          uploadId, message: err && err.message,
        });
        kept += 1;
      }
    }
    return { discarded, kept };
  });

  return { discardReceiptUploads };
};

module.exports.UPLOAD_ID = UPLOAD_ID;
