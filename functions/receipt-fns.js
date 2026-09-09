'use strict';

/**
 * 영수증 최종화 — 브라우저는 스테이징에만 올리고, **옮기는 것은 서버가 한다.**
 *
 * 왜 서버여야 하나
 *   예전에는 브라우저가 `receipts/{clientId}/…` 최종 경로에 직접 쓰고, 그 URL 을
 *   거래 문서에 적었다. 그러면 두 가지가 열린다:
 *     · 아무 clientId 나 적어 남의 폴더에 파일을 만들 수 있다(규칙이 범위를
 *       보게 고쳤지만, 그건 담당 안에서의 이야기다)
 *     · 이미 붙은 증빙을 조용히 덮어쓸 수 있다 — 감사 근거가 사라진다
 *
 *   그리고 무엇보다, Storage 복사와 Firestore 갱신은 **한 트랜잭션으로 묶을 수
 *   없다.** 그 사이에서 실패했을 때 무엇을 남기고 무엇을 되돌릴지 정해 두지
 *   않으면 "사진은 있는데 거래가 없거나" 그 반대가 쌓인다.
 *
 * 상태 기계는 receipt-jobs.cjs 에 있다(순수 모듈, 테스트 34건).
 * 이 파일은 그 규칙에 Firestore·Storage 를 붙이는 일만 한다.
 *
 * 흐름
 *   1. startReceiptUpload  서버가 job 문서를 만들고 uploadId 를 준다
 *   2. (브라우저)          receiptStaging/{uid}/{uploadId}/source 에 올린다
 *   3. finalizeReceipts    선점 → 복사 → 거래 연결 → 스테이징 정리
 *
 * 복사가 create-only 인 이유
 *   최종 경로는 uploadId 로 결정된다. 두 작업자가 같은 원본을 같은 목적지로
 *   복사하면 내용이 같으므로, 먼저 도착한 쪽이 이기고 나중 쪽은 412 를 받는다.
 *   그때 이미 있는 객체의 generation 을 읽어 이어 간다 — 실패가 아니다.
 */

const {
  STATES, canClaim, claimPatch, holdsLease,
  finalPath, stagingPath, jobPath, newJob,
} = require('./receipt-jobs.cjs');
const { capName } = require('./perm-catalog.cjs');

const AUTHZ = 'authz';
const TRANSACTIONS = 'transactions';
const CONFIG = 'config';
const LOCKED_MONTHS_DOC = 'lockedMonths';

/** 한 번에 최종화할 수 있는 건수. 사진 묶음 업로드의 현실적인 상한. */
const MAX_ITEMS = 30;

/** uploadId 형식 — Storage 경로와 Firestore 문서 ID 로 동시에 쓰인다. */
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

module.exports = function receiptFns(ctx) {
  // 버킷은 **호출 시점에** 얻는다. 모듈을 읽는 순간 admin.storage().bucket() 을
  // 부르면 storageBucket 이 설정되지 않은 환경(배포 분석·테스트)에서 파일을
  // require 하는 것만으로 죽는다.
  const { db, getBucket, callable, HttpsError, logger, FieldValue, randomId } = ctx;

  // ───────────────────────────────────────────────────────────
  // 권한 — 규칙과 같은 근거(authz/{uid})를 본다
  // ───────────────────────────────────────────────────────────

  async function requireAuthz(auth) {
    if (!auth || !auth.uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const snap = await db.collection(AUTHZ).doc(auth.uid).get();
    if (!snap.exists) {
      throw new HttpsError(
        'failed-precondition',
        '권한 정보가 아직 준비되지 않았습니다. 관리자에게 권한 백필을 요청하세요.',
      );
    }
    const d = snap.data() || {};
    if (d.enabled !== true) throw new HttpsError('permission-denied', '비활성화된 계정입니다.');
    return d;
  }

  const has = (authz, key) => (authz.caps || {})[capName(key)] === true;

  /** 담당이거나, 담당과 무관하게 전체를 보는 권한이 있거나. 규칙의 seesClient 와 같다. */
  function sees(authz, clientId) {
    if (has(authz, 'client.view.all')) return true;
    const ids = authz.accessibleClientIds;
    return Array.isArray(ids) && ids.includes(String(clientId));
  }

  function requireSees(authz, clientId) {
    if (!sees(authz, clientId)) {
      throw new HttpsError('permission-denied', '담당하지 않는 입주자입니다.');
    }
  }

  /** 마감된 달인가. 규칙과 같은 색인(config/lockedMonths)을 본다. */
  async function lockedMonths() {
    const snap = await db.collection(CONFIG).doc(LOCKED_MONTHS_DOC).get();
    return (snap.exists ? (snap.data() || {}).months : null) || {};
  }

  function assertOpenMonth(months, authz, clientId, date) {
    if (has(authz, 'lock.bypass')) return;
    const key = `${clientId}_${String(date || '').slice(0, 7)}`;
    if (months[key] === true) {
      throw new HttpsError('failed-precondition', `${String(date).slice(0, 7)}은 최종 결재가 끝난 월입니다.`);
    }
  }

  // ───────────────────────────────────────────────────────────
  // startReceiptUpload — job 문서를 만들고 올릴 자리를 알려 준다
  //
  // 브라우저가 uploadId 를 정하지 않는 이유: receiptJobs 는 규칙이 쓰기를
  // 전면 차단하므로 문서를 만들 수 있는 것은 서버뿐이고, 그 문서가 없으면
  // 최종화가 근거를 갖지 못한다.
  // ───────────────────────────────────────────────────────────
  const startReceiptUpload = callable('startReceiptUpload', async (request) => {
    const auth = request.auth;
    const authz = await requireAuthz(auth);
    if (!has(authz, 'receipt.upload')) {
      throw new HttpsError('permission-denied', '증빙 업로드 권한이 없습니다.');
    }

    const clientId = String((request.data || {}).clientId || '').trim();
    if (!clientId) throw new HttpsError('invalid-argument', '입주자를 선택하세요.');
    requireSees(authz, clientId);

    const now = Date.now();
    const uploadId = randomId();
    await db.doc(jobPath(auth.uid, uploadId)).set({
      ...newJob({ uid: auth.uid, uploadId, clientId, now }),
      createdAt: FieldValue.serverTimestamp(),
    });

    return { uploadId, stagingPath: stagingPath(auth.uid, uploadId) };
  });

  // ───────────────────────────────────────────────────────────
  // finalizeReceipts — 선점 → 복사 → 연결 → 정리
  // ───────────────────────────────────────────────────────────

  /** 이 작업자가 job 을 선점한다. 실패하면 누가 이미 하고 있다는 뜻이다. */
  async function claim(ref, token) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', '업로드 기록을 찾을 수 없습니다.');
      const job = snap.data() || {};
      const now = Date.now();
      if (!canClaim(job, now)) {
        throw new HttpsError('failed-precondition', '이미 처리 중이거나 완료된 업로드입니다.');
      }
      tx.update(ref, claimPatch({ token, now }));
      return job;
    });
  }

  /**
   * 스테이징 → 최종. **create-only.**
   *
   * 이미 있으면(412) 그 객체의 generation 을 읽어 이어 간다 — 같은 원본에서
   * 나온 같은 내용이므로 다시 복사할 이유가 없다.
   *
   * 다운로드 토큰을 직접 심는 이유: 화면이 URL 하나로 사진을 여는 기존
   * 동작을 그대로 두기 위해서다. 경로 기반 조회로 바꾸는 것은 표시 코드
   * 전반을 건드리는 별도 작업이고, 이 커밋의 목적(브라우저가 최종 경로를
   * 쓰지 못하게 하는 것)과는 다른 문제다.
   */
  async function copyToFinal(job, uid, uploadId) {
    const bucket = getBucket();
    const src = bucket.file(stagingPath(uid, uploadId));
    const dest = bucket.file(finalPath(job.clientId, uploadId));
    const token = randomId();

    try {
      await src.copy(dest, {
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { metadata: { firebaseStorageDownloadTokens: token } },
      });
    } catch (err) {
      if (Number(err && err.code) !== 412) throw err;
      logger.info('[finalizeReceipts] 최종 객체가 이미 있습니다 — 이어서 진행', { uploadId });
    }

    const [meta] = await dest.getMetadata();
    const savedToken = String((meta.metadata || {}).firebaseStorageDownloadTokens || '')
      .split(',')[0];
    return {
      path: dest.name,
      generation: String(meta.generation),
      url: downloadUrl(bucket.name, dest.name, savedToken),
    };
  }

  function downloadUrl(bucketName, path, token) {
    const encoded = encodeURIComponent(path);
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}`
      + `?alt=media&token=${token}`;
  }

  /**
   * 거래에 붙이거나 새로 만든다. **한 트랜잭션**이고, 그 안에서 lease 를
   * 다시 확인한다 — 복사가 끝난 사이에 lease 를 빼앗겼다면 남의 결과를 덮게 된다.
   */
  async function attach({ auth, authz, job, jobRef, token, item, copied, months }) {
    const clientId = String(job.clientId);
    const patch = {
      receiptPath: copied.path,
      receiptGeneration: copied.generation,
      receiptUrl: copied.url,
      receiptMissing: false,
    };

    return db.runTransaction(async (tx) => {
      const jobSnap = await tx.get(jobRef);
      if (!holdsLease(jobSnap.data(), token, Date.now())) {
        throw new HttpsError('aborted', '다른 처리와 겹쳐 중단했습니다. 다시 시도하세요.');
      }

      let trxId = String(item.trxId || '');
      if (trxId) {
        const ref = db.collection(TRANSACTIONS).doc(trxId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError('not-found', '연결할 거래를 찾을 수 없습니다.');
        const trx = snap.data() || {};
        if (String(trx.clientId) !== clientId) {
          throw new HttpsError('failed-precondition', '다른 입주자의 거래입니다.');
        }
        assertOpenMonth(months, authz, clientId, trx.date);

        // 본인 것인가 남의 것인가로 필요한 권한이 갈린다.
        const own = String(trx.createdBy || '') === auth.uid;
        const key = own ? 'receipt.attachOwn' : 'receipt.attachAny';
        if (!has(authz, key)) {
          throw new HttpsError('permission-denied',
            own ? '증빙 연결 권한이 없습니다.' : '다른 사람이 입력한 거래에 증빙을 연결할 권한이 없습니다.');
        }
        // 이미 붙어 있는 것을 바꾸는 것은 더 높은 권한이다 — 감사 근거를 덮는 일이다.
        if ((trx.receiptPath || trx.receiptUrl) && !has(authz, 'receipt.replace')) {
          throw new HttpsError('permission-denied', '이미 증빙이 있는 거래입니다. 교체 권한이 필요합니다.');
        }
        tx.update(ref, patch);
      } else {
        if (!has(authz, 'trx.create')) {
          throw new HttpsError('permission-denied', '거래 입력 권한이 없습니다.');
        }
        const draft = item.draft || {};
        const date = String(draft.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new HttpsError('invalid-argument', '날짜가 올바르지 않습니다.');
        }
        const amount = Math.abs(Number(draft.amount) || 0);
        if (!amount) throw new HttpsError('invalid-argument', '금액이 올바르지 않습니다.');
        assertOpenMonth(months, authz, clientId, date);

        const ref = db.collection(TRANSACTIONS).doc();
        trxId = ref.id;
        tx.set(ref, {
          clientId,
          accountId: String(draft.accountId || ''),
          date,
          type: draft.isCancellation ? '수입' : '지출',
          category: String(draft.category || '확인필요'),
          subcategory: '',
          description: String(draft.description || '(영수증)'),
          amountIn: draft.isCancellation ? amount : 0,
          amountOut: draft.isCancellation ? 0 : amount,
          createdBy: auth.uid,
          createdByName: String(draft.createdByName || ''),
          source: 'receipt-photo',
          createdAt: FieldValue.serverTimestamp(),
          ...patch,
        });
      }

      tx.update(jobRef, {
        state: STATES.ATTACHED,
        trxId,
        finalPath: copied.path,
        finalGeneration: copied.generation,
      });
      return { trxId, created: !item.trxId, url: copied.url, path: copied.path };
    });
  }

  const finalizeReceipts = callable('finalizeReceipts', async (request) => {
    const auth = request.auth;
    const authz = await requireAuthz(auth);

    const items = Array.isArray((request.data || {}).items) ? request.data.items : [];
    if (!items.length) throw new HttpsError('invalid-argument', '처리할 항목이 없습니다.');
    if (items.length > MAX_ITEMS) {
      throw new HttpsError('invalid-argument', `한 번에 ${MAX_ITEMS}건까지만 처리할 수 있습니다.`);
    }

    const months = await lockedMonths();
    const results = [];

    for (const item of items) {
      const uploadId = String((item || {}).uploadId || '');
      if (!UPLOAD_ID.test(uploadId)) {
        results.push({ uploadId, ok: false, error: '업로드 식별자가 올바르지 않습니다.' });
        continue;
      }

      const jobRef = db.doc(jobPath(auth.uid, uploadId));
      const token = randomId();
      try {
        const job = await claim(jobRef, token);
        requireSees(authz, job.clientId);

        const copied = await copyToFinal(job, auth.uid, uploadId);
        const out = await attach({ auth, authz, job, jobRef, token, item, copied, months });

        // 첨부가 끝났다. 스테이징 정리는 실패해도 되돌리지 않는다 —
        // 남은 파일은 TTL 이 치우고, 여기서 되돌리면 증빙이 사라진다.
        await jobRef.update({ state: STATES.CLEANUP_PENDING });
        try {
          await getBucket().file(stagingPath(auth.uid, uploadId)).delete({ ignoreNotFound: true });
          await jobRef.update({ state: STATES.COMPLETED });
        } catch (err) {
          logger.warn('[finalizeReceipts] 스테이징 정리 실패 — TTL 이 치웁니다', {
            uploadId, message: err && err.message,
          });
        }

        results.push({ uploadId, ok: true, ...out });
      } catch (err) {
        if (err instanceof HttpsError) {
          results.push({ uploadId, ok: false, error: err.message });
        } else {
          logger.error('[finalizeReceipts] 처리 실패', { uploadId, message: err && err.message });
          results.push({ uploadId, ok: false, error: '처리 중 오류가 발생했습니다.' });
        }
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    return { okCount, failCount: results.length - okCount, results };
  });

  return { startReceiptUpload, finalizeReceipts };
};

module.exports.MAX_ITEMS = MAX_ITEMS;
module.exports.UPLOAD_ID = UPLOAD_ID;
