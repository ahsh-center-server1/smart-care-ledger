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
 *   3. completeReceiptUpload 또는 AI 판독이 실제 staging 객체를 확인해 analyzed로 전환
 *   4. finalizeReceipts    선점 → 복사 → 거래 연결 → 스테이징 정리
 *
 * 복사가 create-only 인 이유
 *   최종 경로는 uploadId 로 결정된다. 두 작업자가 같은 원본을 같은 목적지로
 *   복사하면 내용이 같으므로, 먼저 도착한 쪽이 이기고 나중 쪽은 412 를 받는다.
 *   그때 이미 있는 객체의 metadata·generation이 현재 원본과 일치할 때만 이어 간다.
 */

const {
  STATES, canClaim, claimPatch, holdsLease,
  finalPath, stagingPath, jobPath, newJob,
} = require('./receipt-jobs.cjs');
const { fixedCan } = require('./fixed-role-policy.cjs');

const AUTHZ = 'authz';
const ACCOUNTS = 'accounts';
const TRANSACTIONS = 'transactions';
const CONFIG = 'config';
const LOCKED_MONTHS_DOC = 'lockedMonths';
const AUDIT_LOGS = 'auditLogs';
const AUDIT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;
const RECEIPT_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

/** 한 번에 최종화할 수 있는 건수. 사진 묶음 업로드의 현실적인 상한. */
const MAX_ITEMS = 30;

/** uploadId 형식 — Storage 경로와 Firestore 문서 ID 로 동시에 쓰인다. */
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

module.exports = function receiptFns(ctx) {
  // 버킷은 **호출 시점에** 얻는다. 모듈을 읽는 순간 admin.storage().bucket() 을
  // 부르면 storageBucket 이 설정되지 않은 환경(배포 분석·테스트)에서 파일을
  // require 하는 것만으로 죽는다.
  const {
    db, getBucket, callable, HttpsError, logger, FieldValue, randomId,
    onSchedule = (_options, handler) => handler,
  } = ctx;

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

  const has = (authz, key) => fixedCan(authz, key);

  /** 담당이거나, 담당과 무관하게 전체를 보는 권한이 있거나. 규칙의 seesClient 와 같다. */
  function sees(authz, clientId) {
    if (has(authz, 'client.view.all')) return true;
    const ids = authz.role === '팀장' ? authz.leaderClientIds : authz.accessibleClientIds;
    return Array.isArray(ids) && ids.includes(String(clientId));
  }

  function requireSees(authz, clientId) {
    if (!sees(authz, clientId)) {
      throw new HttpsError('permission-denied', '담당하지 않는 입주자입니다.');
    }
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

  /** 업로드된 불변 staging 객체를 확인한 뒤에만 최종화 가능한 상태로 전환한다. */
  const completeReceiptUpload = callable('completeReceiptUpload', async (request) => {
    const auth = request.auth;
    const authz = await requireAuthz(auth);
    if (!has(authz, 'receipt.upload')) {
      throw new HttpsError('permission-denied', '증빙 업로드 권한이 없습니다.');
    }

    const uploadId = String((request.data || {}).uploadId || '');
    if (!UPLOAD_ID.test(uploadId)) {
      throw new HttpsError('invalid-argument', '업로드 식별자가 올바르지 않습니다.');
    }
    const ref = db.doc(jobPath(auth.uid, uploadId));
    const file = getBucket().file(stagingPath(auth.uid, uploadId));
    let meta;
    try {
      [meta] = await file.getMetadata();
    } catch (err) {
      if (Number(err && err.code) === 404) {
        throw new HttpsError('failed-precondition', '업로드된 파일을 찾을 수 없습니다.');
      }
      throw err;
    }
    const contentType = String(meta.contentType || '').toLowerCase();
    const size = Number(meta.size || 0);
    if (!RECEIPT_MIME.has(contentType) || size <= 0 || size >= MAX_RECEIPT_BYTES) {
      throw new HttpsError('invalid-argument', '허용되지 않은 이미지 형식이거나 파일 크기가 너무 큽니다.');
    }
    const sourceGeneration = String(meta.generation || '');
    if (!sourceGeneration) throw new HttpsError('failed-precondition', '파일 버전을 확인할 수 없습니다.');

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', '업로드 기록을 찾을 수 없습니다.');
      const job = snap.data() || {};
      if (job.uid !== auth.uid || job.uploadId !== uploadId) {
        throw new HttpsError('permission-denied', '본인의 업로드가 아닙니다.');
      }
      requireSees(authz, job.clientId);
      if (job.state !== STATES.UPLOADED) {
        throw new HttpsError('failed-precondition', '이미 확인했거나 처리 중인 업로드입니다.');
      }
      if (Number(job.expireAt && typeof job.expireAt.toMillis === 'function'
        ? job.expireAt.toMillis() : new Date(job.expireAt).getTime()) <= Date.now()) {
        throw new HttpsError('deadline-exceeded', '업로드 유효 시간이 지났습니다. 다시 올려 주세요.');
      }
      tx.update(ref, {
        state: STATES.ANALYZED,
        sourceGeneration,
        sourceContentType: contentType,
        sourceSize: size,
        analyzedAt: FieldValue.serverTimestamp(),
      });
    });
    return { ok: true, uploadId, sourceGeneration };
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
      if ([STATES.ATTACHED, STATES.CLEANUP_PENDING, STATES.COMPLETED].includes(job.state)
          && job.result && job.result.trxId) {
        return { job, replay: job.result };
      }
      const now = Date.now();
      if (!canClaim(job, now)) {
        throw new HttpsError('failed-precondition', '이미 처리 중이거나 완료된 업로드입니다.');
      }
      tx.update(ref, claimPatch({ token, now }));
      return { job, replay: null };
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
    const [sourceMeta] = await src.getMetadata();
    if (!job.sourceGeneration
        || String(sourceMeta.generation) !== String(job.sourceGeneration)) {
      throw new HttpsError('aborted', '업로드 파일이 확인 후 바뀌었습니다. 다시 올려 주세요.');
    }
    const expected = {
      uploadId: String(uploadId),
      jobId: jobPath(uid, uploadId),
      sourceGeneration: String(job.sourceGeneration),
    };

    try {
      await src.copy(dest, {
        preconditionOpts: { ifGenerationMatch: 0 },
        // 최종 경로에는 확장자가 없다(uploadId 에서 결정적으로 나온다).
        // 그래서 브라우저가 무엇인지 아는 단서는 contentType 뿐이다.
        // rewrite 는 본문을 주면 그 본문이 목적지 메타데이터가 되므로,
        // 원본의 것을 명시하지 않으면 잃을 수 있다.
        contentType: sourceMeta.contentType || job.sourceContentType || 'image/jpeg',
        // CopyOptions.metadata 는 **평평한** 커스텀 메타데이터 맵이다
        // ({[key]: string|number|boolean|null}). 한 겹 더 감싸면 값이 객체가
        // 되어 저장되지 않고, 되읽은 uploadId 가 undefined 라 **매번** 충돌로
        // 판정됐다 — 파일은 복사돼 있으니 "스토리지엔 있는데 저장 실패"가 된다.
        metadata: expected,
      });
    } catch (err) {
      if (Number(err && err.code) !== 412) throw err;
      logger.info('[finalizeReceipts] 최종 객체가 이미 있어 출처를 검증합니다', { uploadId });
    }

    const [meta] = await dest.getMetadata();
    const actual = meta.metadata || {};
    if (actual.uploadId !== expected.uploadId
        || actual.jobId !== expected.jobId
        || actual.sourceGeneration !== expected.sourceGeneration) {
      throw new HttpsError('failed-precondition', '최종 증빙 경로가 다른 업로드와 충돌했습니다.');
    }
    return {
      path: dest.name,
      generation: String(meta.generation),
      url: '',
    };
  }

  /** Storage 복사 결과를 lease 소유자가 아직 같은 동안 job에 기록한다. */
  async function recordCopy(jobRef, token, copied) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists || !holdsLease(snap.data(), token, Date.now())) {
        throw new HttpsError('aborted', '다른 처리와 겹쳐 중단했습니다. 다시 시도하세요.');
      }
      tx.update(jobRef, {
        finalPath: copied.path,
        finalGeneration: copied.generation,
      });
    });
  }

  async function releaseClaim(jobRef, token) {
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const job = snap.exists ? (snap.data() || {}) : {};
        if (job.state === STATES.FINALIZING && job.leaseToken === token) {
          tx.update(jobRef, {
            state: STATES.ANALYZED,
            leaseToken: '',
            leaseUntil: new Date(0),
          });
        }
      });
    } catch (releaseError) {
      logger.warn('[finalizeReceipts] 실패한 선점 해제 실패', {
        message: releaseError && releaseError.message,
      });
    }
  }

  /**
   * 거래에 붙이거나 새로 만든다. **한 트랜잭션**이고, 그 안에서 lease 를
   * 다시 확인한다 — 복사가 끝난 사이에 lease 를 빼앗겼다면 남의 결과를 덮게 된다.
   */
  async function attach({ auth, job, jobRef, token, item, copied }) {
    const clientId = String(job.clientId);
    const patch = {
      receiptPath: copied.path,
      receiptGeneration: copied.generation,
      receiptUrl: FieldValue.delete(),
      receiptMissing: false,
    };

    return db.runTransaction(async (tx) => {
      const authzRef = db.collection(AUTHZ).doc(auth.uid);
      const lockedRef = db.collection(CONFIG).doc(LOCKED_MONTHS_DOC);
      const jobSnap = await tx.get(jobRef);
      const authzSnap = await tx.get(authzRef);
      const lockedSnap = await tx.get(lockedRef);
      if (!holdsLease(jobSnap.data(), token, Date.now())) {
        throw new HttpsError('aborted', '다른 처리와 겹쳐 중단했습니다. 다시 시도하세요.');
      }
      if (!authzSnap.exists || (authzSnap.data() || {}).enabled !== true) {
        throw new HttpsError('permission-denied', '현재 계정 권한으로 처리할 수 없습니다.');
      }
      const currentAuthz = authzSnap.data() || {};
      requireSees(currentAuthz, clientId);
      const months = lockedSnap.exists ? ((lockedSnap.data() || {}).months || {}) : {};

      let trxId = String(item.trxId || '');
      if (trxId) {
        const ref = db.collection(TRANSACTIONS).doc(trxId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError('not-found', '연결할 거래를 찾을 수 없습니다.');
        const trx = snap.data() || {};
        if (String(trx.clientId) !== clientId) {
          throw new HttpsError('failed-precondition', '다른 입주자의 거래입니다.');
        }
        assertOpenMonth(months, currentAuthz, clientId, trx.date);

        // 본인 것인가 남의 것인가로 필요한 권한이 갈린다.
        const own = String(trx.createdBy || '') === auth.uid;
        const key = own ? 'receipt.attachOwn' : 'receipt.attachAny';
        if (!has(currentAuthz, key)) {
          throw new HttpsError('permission-denied',
            own ? '증빙 연결 권한이 없습니다.' : '다른 사람이 입력한 거래에 증빙을 연결할 권한이 없습니다.');
        }
        // 이미 붙어 있는 것을 바꾸는 것은 더 높은 권한이다 — 감사 근거를 덮는 일이다.
        if (trx.receiptPath || trx.receiptUrl) {
          if (!has(currentAuthz, 'receipt.replace')) {
            throw new HttpsError('permission-denied', '이미 증빙이 있는 거래입니다. 교체 권한이 필요합니다.');
          }
          const expectedPath = String(item.expectedReceiptPath || '');
          const expectedGeneration = String(item.expectedReceiptGeneration || '');
          const expectedUrl = String(item.expectedReceiptUrl || '');
          const currentPath = String(trx.receiptPath || '');
          const currentGeneration = String(trx.receiptGeneration || '');
          const currentUrl = String(trx.receiptUrl || '');
          const exact = currentPath
            ? expectedPath === currentPath && expectedGeneration === currentGeneration
            : expectedUrl === currentUrl && expectedGeneration === currentGeneration;
          if (!exact) {
            throw new HttpsError('aborted', '그 사이 증빙이 바뀌었습니다. 새로고침 후 다시 시도하세요.');
          }
        }
        tx.update(ref, patch);
      } else {
        if (!has(currentAuthz, 'trx.create')) {
          throw new HttpsError('permission-denied', '거래 입력 권한이 없습니다.');
        }
        const draft = item.draft || {};
        const accountId = String(draft.accountId || '').trim();
        if (!accountId) throw new HttpsError('invalid-argument', '계좌를 선택하세요.');
        const accountSnap = await tx.get(db.collection(ACCOUNTS).doc(accountId));
        if (!accountSnap.exists
            || String((accountSnap.data() || {}).clientId || '') !== clientId
            || (accountSnap.data() || {}).active === false) {
          throw new HttpsError('failed-precondition', '선택한 계좌가 해당 입주자 소속이 아닙니다.');
        }
        const date = String(draft.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new HttpsError('invalid-argument', '날짜가 올바르지 않습니다.');
        }
        const amount = Math.abs(Number(draft.amount) || 0);
        if (!amount) throw new HttpsError('invalid-argument', '금액이 올바르지 않습니다.');
        assertOpenMonth(months, currentAuthz, clientId, date);

        const ref = db.collection(TRANSACTIONS).doc();
        trxId = ref.id;
        tx.set(ref, {
          clientId,
          accountId,
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

      const result = {
        trxId, created: !item.trxId, url: copied.url,
        path: copied.path, generation: copied.generation,
      };
      tx.update(jobRef, {
        state: STATES.ATTACHED,
        trxId,
        finalPath: copied.path,
        finalGeneration: copied.generation,
        result,
      });
      const auditRef = db.collection(AUDIT_LOGS).doc();
      tx.set(auditRef, {
        action: item.trxId ? 'receipt.attach' : 'receipt.create',
        actorUid: auth.uid,
        clientId,
        targetId: trxId,
        uploadId: String(job.uploadId),
        timestamp: FieldValue.serverTimestamp(),
        expireAt: new Date(Date.now() + AUDIT_TTL_MS),
      });
      return result;
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
        const claimed = await claim(jobRef, token);
        if (claimed.replay) {
          results.push({ uploadId, ok: true, ...claimed.replay, replayed: true });
          continue;
        }
        const job = claimed.job;
        requireSees(authz, job.clientId);

        const copied = await copyToFinal(job, auth.uid, uploadId);
        await recordCopy(jobRef, token, copied);
        const out = await attach({ auth, job, jobRef, token, item, copied });

        // 첨부가 끝났다. 스테이징 정리는 실패해도 되돌리지 않는다 —
        // 예약 정리 함수가 job을 근거로 다시 치우며 최종 증빙은 보존한다.
        try {
          await jobRef.update({ state: STATES.CLEANUP_PENDING });
          await getBucket().file(stagingPath(auth.uid, uploadId)).delete({ ignoreNotFound: true });
          await jobRef.update({ state: STATES.COMPLETED });
        } catch (err) {
          logger.warn('[finalizeReceipts] 스테이징 정리 실패 — 예약 정리가 재시도합니다', {
            uploadId, message: err && err.message,
          });
        }

        results.push({ uploadId, ok: true, ...out });
      } catch (err) {
        await releaseClaim(jobRef, token);
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

  const { getReceiptAccessUrl } = require('./receipt-access-fns')({
    db, getBucket, callable, HttpsError, requireAuthz, requireSees, fixedCan,
  });

  /** 기존 증빙 연결을 해제한다. 최종 객체 삭제는 generation이 있을 때만 조건부로 한다. */
  const removeReceipt = callable('removeReceipt', async (request) => {
    const auth = request.auth;
    await requireAuthz(auth);
    const d = request.data || {};
    const trxId = String(d.trxId || '').trim();
    if (!trxId) throw new HttpsError('invalid-argument', '거래 식별자가 필요합니다.');

    const trxRef = db.collection(TRANSACTIONS).doc(trxId);
    let removed = null;
    await db.runTransaction(async (tx) => {
      const authzSnap = await tx.get(db.collection(AUTHZ).doc(auth.uid));
      const lockedSnap = await tx.get(db.collection(CONFIG).doc(LOCKED_MONTHS_DOC));
      const trxSnap = await tx.get(trxRef);
      if (!authzSnap.exists || (authzSnap.data() || {}).enabled !== true) {
        throw new HttpsError('permission-denied', '현재 계정 권한으로 처리할 수 없습니다.');
      }
      if (!trxSnap.exists) throw new HttpsError('not-found', '거래를 찾을 수 없습니다.');
      const currentAuthz = authzSnap.data() || {};
      const trx = trxSnap.data() || {};
      requireSees(currentAuthz, trx.clientId);
      if (!has(currentAuthz, 'receipt.replace')) {
        throw new HttpsError('permission-denied', '증빙 해제 권한이 없습니다.');
      }
      const months = lockedSnap.exists ? ((lockedSnap.data() || {}).months || {}) : {};
      assertOpenMonth(months, currentAuthz, trx.clientId, trx.date);

      const currentPath = String(trx.receiptPath || '');
      const currentGeneration = String(trx.receiptGeneration || '');
      const currentUrl = String(trx.receiptUrl || '');
      const exact = currentPath
        ? String(d.expectedReceiptPath || '') === currentPath
          && String(d.expectedReceiptGeneration || '') === currentGeneration
        : String(d.expectedReceiptUrl || '') === currentUrl
          && String(d.expectedReceiptGeneration || '') === currentGeneration;
      if (!exact) throw new HttpsError('aborted', '그 사이 증빙이 바뀌었습니다. 새로고침 후 다시 시도하세요.');

      removed = { path: currentPath, generation: currentGeneration };
      tx.update(trxRef, {
        receiptPath: FieldValue.delete(),
        receiptGeneration: FieldValue.delete(),
        receiptUrl: FieldValue.delete(),
        receiptMissing: false,
      });
      tx.set(db.collection(AUDIT_LOGS).doc(), {
        action: 'receipt.remove', actorUid: auth.uid,
        clientId: String(trx.clientId || ''), targetId: trxId,
        receiptPath: currentPath,
        receiptGeneration: currentGeneration,
        timestamp: FieldValue.serverTimestamp(),
        expireAt: new Date(Date.now() + AUDIT_TTL_MS),
      });
    });

    if (removed && removed.path && removed.generation) {
      try {
        await getBucket().file(removed.path).delete({
          ignoreNotFound: true,
          preconditionOpts: { ifGenerationMatch: removed.generation },
        });
      } catch (err) {
        // Firestore 연결은 이미 안전하게 끊겼다. 확인되지 않은 객체는 지우지 않고
        // orphan 감사 대상으로 남긴다.
        logger.warn('[removeReceipt] 최종 객체 조건부 삭제 실패', {
          trxId, path: removed.path, message: err && err.message,
        });
      }
    }
    return { ok: true, trxId };
  });

  const { cleanupReceiptJobs, cleanupExpiredJob } = require('./receipt-cleanup')({
    db, getBucket, onSchedule, logger, FieldValue, randomId,
  });

  const { discardReceiptUploads } = require('./receipt-discard')({
    db, callable, HttpsError, logger, requireAuthz, cleanupExpiredJob, maxItems: MAX_ITEMS,
  });

  return {
    startReceiptUpload, completeReceiptUpload, finalizeReceipts, getReceiptAccessUrl, removeReceipt,
    discardReceiptUploads, cleanupReceiptJobs,
  };
};

module.exports.MAX_ITEMS = MAX_ITEMS;
module.exports.UPLOAD_ID = UPLOAD_ID;
