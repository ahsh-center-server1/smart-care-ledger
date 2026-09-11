'use strict';

/** 만료된 임시 영수증 job과 Storage 객체의 보상 정리. */

const { STATES, finalPath, stagingPath, jobPath } = require('./receipt-jobs.cjs');

const TRANSACTIONS = 'transactions';
const AUDIT_LOGS = 'auditLogs';
const AUDIT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 100;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

module.exports = function receiptCleanup(ctx) {
  const { db, getBucket, onSchedule, logger, FieldValue } = ctx;

  /** `final → staging → job`. 확인할 수 없는 최종 객체는 삭제하지 않는다. */
  async function cleanupExpiredJob(snap) {
    const job = snap.data() || {};
    const uid = String(job.uid || '');
    const uploadId = String(job.uploadId || '');
    if (!uid || !UPLOAD_ID.test(uploadId) || !job.clientId) {
      logger.warn('[cleanupReceiptJobs] 식별할 수 없는 job을 보존합니다', { path: snap.ref.path });
      return { kept: true, reason: 'invalid-job' };
    }

    const bucket = getBucket();
    const final = job.finalPath || finalPath(job.clientId, uploadId);
    const attached = [STATES.ATTACHED, STATES.CLEANUP_PENDING, STATES.COMPLETED]
      .includes(job.state);
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
      await snap.ref.delete();
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

  return { cleanupReceiptJobs };
};

module.exports.CLEANUP_BATCH = CLEANUP_BATCH;
