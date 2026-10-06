import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  makeDb, makeBucket, FieldValue, FakeHttpsError, silentLogger,
} from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const aiFns = require('../functions/ai-fns.js');
const makeCaller = require('../functions/caller.cjs');
const { computeCaps, rankOf } = require('../functions/perm-catalog.cjs');
const { newJob, jobPath, stagingPath, STATES } = require('../functions/receipt-jobs.cjs');

const UID = 'staff-input';
const CLIENT = 'c1';
const UPLOAD = 'upload001';

function build({ extractReceipt, consumeRateLimits } = {}) {
  const db = makeDb({
    [`authz/${UID}`]: {
      uid: UID, role: '입력자', enabled: true, accessibleClientIds: [CLIENT],
      caps: computeCaps(rankOf({ role: '입력자', isAdmin: false }), {}),
    },
    [jobPath(UID, UPLOAD)]: newJob({
      uid: UID, uploadId: UPLOAD, clientId: CLIENT, now: Date.now(),
    }),
  });
  const bucket = makeBucket();
  bucket.put(stagingPath(UID, UPLOAD), Buffer.from('private-image'));
  const requireCaller = makeCaller({ db, HttpsError: FakeHttpsError }).requireCaller;
  const fns = aiFns({
    db, getBucket: () => bucket,
    callable: (_name, handler) => handler,
    requireCaller, HttpsError: FakeHttpsError, logger: silentLogger, FieldValue,
    Timestamp: { fromMillis: (ms) => new Date(ms) },
    aiProvider: { isAiConfigured: () => true },
    extractors: {
      extractReceipt: extractReceipt || (async () => ({
        extracted: { confidence: 0.9 }, usage: {}, bytes: 13,
      })),
      extractBankbook: async () => ({ extracted: { rows: [] }, usage: {}, bytes: 1 }),
    },
    ...(consumeRateLimits ? { rateLimiter: { consumeRateLimits } } : {}),
  });
  return { db, bucket, fns };
}

const asUser = (uploadId = UPLOAD) => ({ auth: { uid: UID }, data: { uploadId } });

test('영수증 AI는 소유권이 확인된 staging 원본을 읽고 job을 analyzed로 넘긴다', async () => {
  let received;
  const { db, fns } = build({
    extractReceipt: async (input) => {
      received = input;
      return { extracted: { confidence: 0.8 }, usage: {}, bytes: 13 };
    },
  });

  const out = await fns.analyzeReceipt(asUser());
  assert.equal(Buffer.from(received.base64, 'base64').toString(), 'private-image');
  assert.equal(received.mediaType, 'image/jpeg');
  assert.equal(out.extracted.confidence, 0.8);
  const job = db.docs.get(jobPath(UID, UPLOAD));
  assert.equal(job.state, STATES.ANALYZED);
  assert.ok(job.sourceGeneration);
});

test('job이 없거나 이미 analyzed면 AI를 호출하지 않는다', async () => {
  let calls = 0;
  const { db, fns } = build({
    extractReceipt: async () => {
      calls += 1;
      return { extracted: {}, usage: {}, bytes: 1 };
    },
  });
  await assert.rejects(() => fns.analyzeReceipt(asUser('missing01')), (e) => e.code === 'not-found');
  db.docs.set(jobPath(UID, UPLOAD), {
    ...db.docs.get(jobPath(UID, UPLOAD)), state: STATES.ANALYZED,
  });
  await assert.rejects(() => fns.analyzeReceipt(asUser()), (e) => e.code === 'failed-precondition');
  assert.equal(calls, 0);
});

test('판독 중 계정이 비활성화되면 결과를 최종화 가능한 상태로 넘기지 않는다', async () => {
  let db;
  const built = build({
    extractReceipt: async () => {
      db.docs.set(`authz/${UID}`, { ...db.docs.get(`authz/${UID}`), enabled: false });
      return { extracted: { confidence: 1 }, usage: {}, bytes: 13 };
    },
  });
  db = built.db;

  await assert.rejects(
    () => built.fns.analyzeReceipt(asUser()),
    (e) => e.code === 'permission-denied',
  );
  assert.equal(db.docs.get(jobPath(UID, UPLOAD)).state, STATES.UPLOADED);
});

test('프로젝트 한도 초과는 재시도 시간을 포함한 사용자 오류로 돌려준다', async () => {
  const { fns } = build({
    consumeRateLimits: async () => {
      const err = new Error('rate-limit-exceeded');
      err.retryAfterMs = 12_100;
      throw err;
    },
  });

  await assert.rejects(
    () => fns.analyzeReceipt(asUser()),
    (e) => e.code === 'resource-exhausted'
      && /13초 후/.test(e.message)
      && /직접 입력/.test(e.message),
  );
});
