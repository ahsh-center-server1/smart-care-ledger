'use strict';

/** 만료된 임시 영수증 job과 Storage 객체의 보상 정리. */

const {
  STATES, ATTACHED_STATES, LEASE_MS, millis, finalPath, stagingPath, jobPath,
} = require('./receipt-jobs.cjs');

const TRANSACTIONS = 'transactions';
const AUDIT_LOGS = 'auditLogs';
const AUDIT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 100;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

module.exports = function receiptCleanup(ctx) {
  const { db, getBucket, onSchedule, logger, FieldValue, randomId } = ctx;

  async function claimCleanup(ref) {
    const token = randomId();
    return db.runTransaction(async (tx) => {
      const currentSnap = await tx.get(ref);
      if (!currentSnap.exists) return null;
      const current = currentSnap.data() || {};
      const now = Date.now();
      if (millis(current.expireAt) > now) return null;
      if (current.state === STATES.FINALIZING && millis(current.leaseUntil) > now) return null;
      if (current.state === STATES.CLEANING && millis(current.cleanupLeaseUntil) > now) return null;
      const preserveFinal = current.cleanupPreserveFinal === true
        || ATTACHED_STATES.includes(current.state);
      tx.update(ref, {
        state: STATES.CLEANING,
        cleanupToken: token,
        cleanupLeaseUntil: new Date(now + LEASE_MS),
        cleanupPreserveFinal: preserveFinal,
      });
      return { ...current, state: STATES.CLEANING, cleanupToken: token, cleanupPreserveFinal: preserveFinal };
    });
  }

  /** `final → staging → job`. 확인할 수 없는 최종 객체는 삭제하지 않는다. */
  async function cleanupExpiredJob(snap) {
    const job = await claimCleanup(snap.ref);
    if (!job) return { kept: true, reason: 'not-claimable' };
    const uid = String(job.uid || '');
    const uploadId = String(job.uploadId || '');
    if (!uid || !UPLOAD_ID.test(uploadId) || !job.clientId) {
      logger.warn('[cleanupReceiptJobs] 식별할 수 없는 job을 보존합니다', { path: snap.ref.path });
      return { kept: true, reason: 'invalid-job' };
    }

    const bucket = getBucket();
    const final = job.finalPath || finalPath(job.clientId, uploadId);
    const attached = job.cleanupPreserveFinal === true;
    let orphanReason = '';

    try {
      const finalFile = bucket.file(final);
      let meta = null;
      try { [meta] = await finalFile.getMetadata(); } catch (err) {
        if (Number(err && err.code) !== 404) throw err;
      }

      if (meta && !attached) {
        const refs = await db.collection(TRANSACTIONS)
          .where('receiptPath', '==', final).limit(1).get();
        if (!refs.empty) {
          orphanReason = '거래가 참조하는 최종 객체';
        } else {
          const custom = meta.metadata || {};
          const sourceMatches = custom.uploadId === uploadId
            && custom.jobId === jobPath(uid, uploadId)
            && String(custom.sourceGeneration || '') === String(job.sourceGeneration || '');
          const generationMatches = job.finalGeneration != null
            && String(job.finalGeneration) === String(meta.generation);
          if (sourceMatches && generationMatches) {
            await finalFile.delete({
              preconditionOpts: { ifGenerationMatch: String(meta.generation) },
            });
          } else {
            orphanReason = '출처 또는 generation 불일치';
          }
        }
      }

      if (orphanReason) {
        await db.collection(AUDIT_LOGS).doc().set({
          action: 'receipt.orphan', actorUid: 'system',
          clientId: String(job.clientId), uploadId, path: final, reason: orphanReason,
          timestamp: FieldValue.serverTimestamp(),
          expireAt: new Date(Date.now() + AUDIT_TTL_MS),
        });
      }

      await bucket.file(stagingPath(uid, uploadId)).delete({ ignoreNotFound: true });
      await db.runTransaction(async (tx) => {
        const current = await tx.get(snap.ref);
        const data = current.exists ? (current.data() || {}) : {};
        if (!current.exists || data.state !== STATES.CLEANING
            || data.cleanupToken !== job.cleanupToken) {
          throw new Error('cleanup lease를 잃었습니다');
        }
        tx.delete(snap.ref);
      });
      return { removed: true, orphan: !!orphanReason, finalPreserved: attached || !!orphanReason };
    } catch (err) {
      logger.warn('[cleanupReceiptJobs] 정리 실패 — job을 남겨 재시도합니다', {
        uid, uploadId, message: err && err.message,
      });
      return { kept: true, reason: 'cleanup-failed' };
    }
  }

  const cleanupReceiptJobs = onSchedule(
    { schedule: 'every 60 minutes', timeZone: 'Asia/Seoul' },
    async () => {
      const expired = await db.collectionGroup('items')
        .where('expireAt', '<=', new Date()).limit(CLEANUP_BATCH).get();
      const results = [];
      for (const snap of expired.docs) results.push(await cleanupExpiredJob(snap));
      logger.info('[cleanupReceiptJobs] 완료', {
        scanned: expired.size,
        removed: results.filter((r) => r.removed).length,
        kept: results.filter((r) => r.kept).length,
        orphans: results.filter((r) => r.orphan).length,
      });
    },
  );

  // cleanupExpiredJob 을 함께 내보낸다 — 「지금 버린다」(discardReceiptUploads)가
  // 같은 절차를 써야 하기 때문이다. 즉시 삭제를 따로 구현하면 최종 객체 보존·
  // generation 사전조건·orphan 감사 세 가지를 두 곳에서 맞춰야 하고, 어긋나는
  // 순간 **거래에 붙어 있는 증빙이 지워진다.**
  return { cleanupReceiptJobs, cleanupExpiredJob };
};

module.exports.CLEANUP_BATCH = CLEANUP_BATCH;
