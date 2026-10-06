import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  makeDb, makeBucket, FieldValue, FakeHttpsError, silentLogger,
} from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const receiptFns = require('../functions/receipt-fns.js');
const jobs = require('../functions/receipt-jobs.cjs');
const { computeCaps, rankOf } = require('../functions/perm-catalog.cjs');

/**
 * 영수증 최종화 — **브라우저가 최종 경로를 쓰지 못하게 한 뒤** 무엇이 보장되는가.
 *
 * 확인하는 것
 *   · 담당 밖 입주자에게는 아무것도 못 한다
 *   · 이미 증빙이 있는 거래는 교체 권한이 있어야 바꾼다
 *   · 남이 입력한 거래에 붙이려면 더 높은 권한이 필요하다
 *   · 마감된 달에는 붙이지 못한다
 *   · 같은 업로드를 두 번 최종화해도 파일이 두 개 생기지 않는다(create-only)
 *   · 복사는 끝났는데 첨부가 실패하면 거래가 바뀌지 않는다
 */

const MY = 'c1';
const OTHER = 'c9';

function authz(uid, role, ids, extra = {}) {
  return {
    uid, role, enabled: true, accessibleClientIds: ids,
    caps: computeCaps(rankOf({ role, isAdmin: false }), {}),
    ...extra,
  };
}

function build(seed = {}, objects = {}) {
  const db = makeDb({
    'authz/입력자': authz('입력자', '입력자', [MY]),
    'authz/담당자': authz('담당자', '담당자', [MY]),
    'authz/팀장': authz('팀장', '팀장', [MY]),
    'accounts/a1': { clientId: MY, label: '생활비' },
    ...seed,
  });
  const bucket = makeBucket();
  for (const [p, d] of Object.entries(objects)) bucket.put(p, d);

  let n = 0;
  const fns = receiptFns({
    db,
    getBucket: () => bucket,
    callable: (name, handler) => handler,
    HttpsError: FakeHttpsError,
    logger: silentLogger,
    FieldValue,
    randomId: () => `id${++n}`.padEnd(8, '0'),
  });
  return { db, bucket, fns };
}

const as = (uid) => ({ auth: { uid } });

/** 스테이징에 파일이 올라간 상태의 job 하나. */
function staged(db, bucket, uid, uploadId, clientId = MY, state = jobs.STATES.ANALYZED) {
  bucket.put(jobs.stagingPath(uid, uploadId));
  const sourceGeneration = bucket.objects.get(jobs.stagingPath(uid, uploadId)).generation;
  db.docs.set(jobs.jobPath(uid, uploadId), {
    ...jobs.newJob({ uid, uploadId, clientId, now: Date.now() }), state, sourceGeneration,
  });
}

// ─────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────

test('업로드를 시작하면 job 문서와 올릴 자리가 생긴다', async () => {
  const { db, fns } = build();
  const out = await fns.startReceiptUpload({ ...as('담당자'), data: { clientId: MY } });

  assert.match(out.uploadId, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(out.stagingPath, jobs.stagingPath('담당자', out.uploadId));
  const job = db.docs.get(jobs.jobPath('담당자', out.uploadId));
  assert.equal(job.state, jobs.STATES.UPLOADED);
  assert.equal(job.clientId, MY);
});

test('담당 밖 입주자로는 시작할 수 없다', async () => {
  const { db, fns } = build();
  await assert.rejects(
    () => fns.startReceiptUpload({ ...as('담당자'), data: { clientId: OTHER } }),
    (e) => e.code === 'permission-denied',
  );
  assert.equal(db.commits, 0);
});

test('권한 정보가 없으면 무엇을 해야 하는지 말한다', async () => {
  const { fns } = build();
  await assert.rejects(
    () => fns.startReceiptUpload({ ...as('없는사람'), data: { clientId: MY } }),
    (e) => e.code === 'failed-precondition' && /백필/.test(e.message),
  );
});

test('업로드 확인이 실제 staging generation을 기록하고 analyzed로 전환한다', async () => {
  const { db, bucket, fns } = build();
  const started = await fns.startReceiptUpload({ ...as('담당자'), data: { clientId: MY } });
  bucket.put(started.stagingPath, 'image-bytes');
  const expected = bucket.objects.get(started.stagingPath).generation;

  const out = await fns.completeReceiptUpload({
    ...as('담당자'), data: { uploadId: started.uploadId },
  });
  assert.equal(out.sourceGeneration, expected);
  const job = db.docs.get(jobs.jobPath('담당자', started.uploadId));
  assert.equal(job.state, jobs.STATES.ANALYZED);
  assert.equal(job.sourceGeneration, expected);
});

test('staging 파일 확인 전에는 최종화할 수 없다', async () => {
  const { fns } = build();
  const started = await fns.startReceiptUpload({ ...as('담당자'), data: { clientId: MY } });
  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: started.uploadId, trxId: 't1' }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /이미 처리 중이거나 완료/);
});

// ─────────────────────────────────────────────
// 기존 거래에 붙이기
// ─────────────────────────────────────────────

test('본인이 입력한 거래에 증빙을 붙인다', async () => {
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자', amountOut: 1000 },
  });
  staged(db, bucket, '담당자', 'up000001');

  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });

  assert.equal(out.okCount, 1, JSON.stringify(out.results));
  const trx = db.docs.get('transactions/t1');
  assert.equal(trx.receiptPath, jobs.finalPath(MY, 'up000001'));
  assert.equal(trx.receiptMissing, false);
  assert.ok(trx.receiptGeneration, 'generation 을 기록하지 않았습니다');
  assert.equal(trx.receiptUrl, undefined, '권한을 우회하는 영구 다운로드 URL을 저장했습니다');
  // 스테이징은 치웠다
  assert.equal(bucket.objects.has(jobs.stagingPath('담당자', 'up000001')), false);
  assert.equal(db.docs.get(jobs.jobPath('담당자', 'up000001')).state, jobs.STATES.COMPLETED);
});

test('증빙 열람 URL은 현재 담당 범위를 확인한 뒤 짧게 발급한다', async () => {
  const path = jobs.finalPath(MY, 'up000001');
  const { db, bucket, fns } = build({
    'authz/입력자': authz('입력자', '입력자', []),
    'transactions/t1': {
      clientId: MY, receiptPath: path, receiptGeneration: '1001',
    },
  }, { [path]: 'receipt' });
  db.docs.get('transactions/t1').receiptGeneration = bucket.objects.get(path).generation;

  const out = await fns.getReceiptAccessUrl({ ...as('담당자'), data: { trxId: 't1' } });
  assert.match(out.url, /^https:\/\/signed\.example\//);
  assert.equal(out.expiresInSeconds, 300);
  await assert.rejects(
    () => fns.getReceiptAccessUrl({ ...as('입력자'), data: { trxId: 't1' } }),
    (e) => e.code === 'permission-denied',
  );
});

test('입력자는 남이 입력한 거래에 붙일 수 없다', async () => {
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
  });
  staged(db, bucket, '입력자', 'up000001');

  const out = await fns.finalizeReceipts({
    ...as('입력자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /다른 사람이 입력한/);
  assert.equal(db.docs.get('transactions/t1').receiptPath, undefined);
});

test('담당자는 남이 입력한 거래에도 붙일 수 있다 (attachAny)', async () => {
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '입력자' },
  });
  staged(db, bucket, '담당자', 'up000001');

  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(out.okCount, 1, JSON.stringify(out.results));
});

test('이미 증빙이 있으면 교체 권한이 있어야 바꾼다', async () => {
  const seed = {
    'transactions/t1': {
      clientId: MY, date: '2026-09-01', createdBy: '입력자', receiptUrl: 'https://old',
    },
  };
  // 입력자는 receipt.replace 가 없다
  const a = build(seed);
  staged(a.db, a.bucket, '입력자', 'up000001');
  const r1 = await a.fns.finalizeReceipts({
    ...as('입력자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(r1.okCount, 0);
  assert.equal(a.db.docs.get('transactions/t1').receiptUrl, 'https://old', '증빙이 덮였습니다');

  const b = build(seed);
  staged(b.db, b.bucket, '담당자', 'up000001');
  const r2 = await b.fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{
      uploadId: 'up000001', trxId: 't1', expectedReceiptUrl: 'https://old',
    }] },
  });
  assert.equal(r2.okCount, 1, JSON.stringify(r2.results));
});

test('다른 입주자의 거래에는 붙일 수 없다', async () => {
  const { db, bucket, fns } = build({
    'transactions/t9': { clientId: OTHER, date: '2026-09-01', createdBy: '담당자' },
  });
  staged(db, bucket, '담당자', 'up000001');

  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't9' }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /다른 입주자/);
});

test('마감된 달의 거래에는 붙일 수 없다', async () => {
  const { db, bucket, fns } = build({
    'config/lockedMonths': { months: { [`${MY}_2026-03`]: true } },
    'transactions/t1': { clientId: MY, date: '2026-03-15', createdBy: '담당자' },
  });
  staged(db, bucket, '담당자', 'up000001');

  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /최종 결재가 끝난/);
});

// ─────────────────────────────────────────────
// 새 거래 만들기
// ─────────────────────────────────────────────

test('거래가 없으면 초안으로 새로 만든다', async () => {
  const { db, bucket, fns } = build();
  staged(db, bucket, '담당자', 'up000001');

  const out = await fns.finalizeReceipts({
    ...as('담당자'),
    data: { items: [{ uploadId: 'up000001', draft: {
      date: '2026-09-01', amount: 12000, category: '식비', description: '김밥천국', accountId: 'a1',
    } }] },
  });

  assert.equal(out.okCount, 1, JSON.stringify(out.results));
  const trx = db.docs.get('transactions/' + out.results[0].trxId);
  assert.equal(trx.clientId, MY);
  assert.equal(trx.amountOut, 12000);
  assert.equal(trx.createdBy, '담당자', 'createdBy 를 서버가 정하지 않았습니다');
  assert.equal(trx.receiptMissing, false);
});

test('다른 입주자의 계좌로는 영수증 거래를 만들 수 없다', async () => {
  const { db, bucket, fns } = build({ 'accounts/a9': { clientId: OTHER } });
  staged(db, bucket, '담당자', 'up000001');
  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', draft: {
      date: '2026-09-01', amount: 12000, accountId: 'a9',
    } }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /해당 입주자 소속/);
  assert.equal([...db.docs.keys()].some(k=>k.startsWith('transactions/')), false);
});

test('비활성 계좌로는 영수증 거래를 만들 수 없다', async () => {
  const { db, bucket, fns } = build({
    'accounts/a1': { clientId: MY, label: '종료 계좌', active: false },
  });
  staged(db, bucket, '담당자', 'up000001');
  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{
      uploadId: 'up000001',
      draft: { accountId: 'a1', date: '2026-09-01', amount: 1000 },
    }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /계좌/);
});

test('날짜·금액이 이상하면 만들지 않는다', async () => {
  for (const draft of [{ date: '', amount: 1 }, { date: '2026-09-01', amount: 0 }, { date: '어제', amount: 5 }]) {
    const { db, bucket, fns } = build();
    staged(db, bucket, '담당자', 'up000001');
    const out = await fns.finalizeReceipts({
      ...as('담당자'), data: { items: [{ uploadId: 'up000001', draft }] },
    });
    assert.equal(out.okCount, 0, JSON.stringify(draft));
  }
});

// ─────────────────────────────────────────────
// 복사 · 동시성
// ─────────────────────────────────────────────

test('복사할 때 원본 contentType 을 명시한다 — 최종 경로엔 확장자가 없다', async () => {
  // 최종 경로는 uploadId 에서 나오므로 `receipts/c1/abc12345` 처럼 **확장자가
  // 없다.** 브라우저가 이미지임을 아는 단서는 contentType 뿐이고, rewrite 는
  // 본문을 주면 그 본문이 목적지 메타데이터가 되므로 명시하지 않으면 잃는다.
  // 잃으면 미리보기가 📄 아이콘만 뜬다(실제로 그랬다).
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자', amountOut: 1000 },
  });
  staged(db, bucket, '담당자', 'up000001');

  const seen = [];
  const origFile = bucket.file.bind(bucket);
  bucket.file = (name) => {
    const f = origFile(name);
    const origCopy = f.copy.bind(f);
    f.copy = (dest, opts) => { seen.push(opts); return origCopy(dest, opts); };
    return f;
  };
  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  bucket.file = origFile;

  assert.equal(out.okCount, 1, JSON.stringify(out.results));
  assert.equal(seen.length, 1, 'copy 가 한 번 불리지 않았습니다');
  assert.ok(seen[0].contentType,
    'copy 옵션에 contentType 이 없습니다 — 최종 객체가 종류를 잃어 미리보기가 깨집니다');
  assert.match(seen[0].contentType, /^image\//);
});

test('최종 객체가 이미 있으면 출처 metadata가 일치할 때만 이어 간다', async () => {
  // 두 작업자가 같은 원본을 같은 목적지로 복사하면 내용이 같다.
  const finalP = jobs.finalPath(MY, 'up000001');
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
  }, { [finalP]: '먼저 복사된 것' });
  staged(db, bucket, '담당자', 'up000001');
  const job = db.docs.get(jobs.jobPath('담당자', 'up000001'));
  bucket.objects.get(finalP).metadata = {
    uploadId: 'up000001',
    jobId: jobs.jobPath('담당자', 'up000001'),
    sourceGeneration: job.sourceGeneration,
  };
  const genBefore = bucket.objects.get(finalP).generation;

  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });

  assert.equal(out.okCount, 1, JSON.stringify(out.results));
  assert.equal(bucket.objects.get(finalP).generation, genBefore, '이미 있는 객체를 덮었습니다');
  assert.equal(db.docs.get('transactions/t1').receiptGeneration, genBefore);
});

test('412 목적지의 출처 metadata가 다르면 충돌로 중단한다', async () => {
  const finalP = jobs.finalPath(MY, 'up000001');
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
  }, { [finalP]: '다른 업로드' });
  staged(db, bucket, '담당자', 'up000001');
  bucket.objects.get(finalP).metadata = {
    uploadId: 'different',
    jobId: 'receiptJobs/other/items/different', sourceGeneration: '999',
  };

  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /충돌/);
  assert.equal(db.docs.get('transactions/t1').receiptPath, undefined);
});

test('교체는 예상 경로와 generation이 모두 일치해야 한다', async () => {
  const seed = { 'transactions/t1': {
    clientId: MY, date: '2026-09-01', createdBy: '담당자',
    receiptPath: 'receipts/c1/old', receiptGeneration: '7', receiptUrl: 'https://old',
  } };
  const { db, bucket, fns } = build(seed);
  staged(db, bucket, '담당자', 'up000001');
  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{
      uploadId: 'up000001', trxId: 't1',
      expectedReceiptPath: 'receipts/c1/old', expectedReceiptGeneration: '6',
    }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /그 사이 증빙/);
  assert.equal(db.docs.get('transactions/t1').receiptGeneration, '7');
});

test('이미 최종화된 업로드는 같은 결과를 돌려주고 거래를 중복 생성하지 않는다', async () => {
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
  });
  staged(db, bucket, '담당자', 'up000001');

  await fns.finalizeReceipts({ ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] } });
  const again = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });

  assert.equal(again.okCount, 1);
  assert.equal(again.results[0].replayed, true);
  assert.equal(again.results[0].trxId, 't1');
});

test('첨부 성공 뒤 staging 정리 기록이 실패해도 성공을 반환하고 재호출은 같은 결과를 준다', async () => {
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
  });
  staged(db, bucket, '담당자', 'up000001');
  const jp = jobs.jobPath('담당자', 'up000001');
  db.failWrite = (path, op) => path === jp && op.op === 'update'
    && op.data.state === jobs.STATES.CLEANUP_PENDING;

  const first = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(first.okCount, 1);
  assert.equal(db.docs.get(jp).state, jobs.STATES.ATTACHED);

  db.failWrite = null;
  const second = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(second.okCount, 1);
  assert.equal(second.results[0].replayed, true);
  assert.equal(second.results[0].trxId, 't1');
});

test('lease 가 만료된 finalizing 은 다시 집을 수 있다', async () => {
  // 서버가 복사 중에 죽은 경우. 재개하지 못하면 그 job 은 영구 정지된다.
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
  });
  staged(db, bucket, '담당자', 'up000001', MY, jobs.STATES.FINALIZING);
  const jp = jobs.jobPath('담당자', 'up000001');
  db.docs.set(jp, { ...db.docs.get(jp), leaseToken: '죽은작업자', leaseUntil: Date.now() - 1 });

  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(out.okCount, 1, JSON.stringify(out.results));
});

test('남의 업로드는 건드릴 수 없다 — 경로에 uid 가 있다', async () => {
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
  });
  staged(db, bucket, '담당자', 'up000001');

  // 팀장이 담당자의 uploadId 로 시도한다 → 자기 경로에는 그 job 이 없다
  const out = await fns.finalizeReceipts({
    ...as('팀장'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /찾을 수 없습니다/);
});

test('첨부가 실패하면 거래도 job 도 완료로 넘어가지 않는다', async () => {
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
  });
  staged(db, bucket, '담당자', 'up000001');
  db.failWrite = (path) => path === 'transactions/t1';

  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: 'up000001', trxId: 't1' }] },
  });

  assert.equal(out.okCount, 0);
  assert.equal(db.docs.get('transactions/t1').receiptPath, undefined);
  assert.notEqual(db.docs.get(jobs.jobPath('담당자', 'up000001')).state, jobs.STATES.COMPLETED);
});

test('한 건이 실패해도 나머지는 처리된다', async () => {
  const { db, bucket, fns } = build({
    'transactions/t1': { clientId: MY, date: '2026-09-01', createdBy: '담당자' },
    'transactions/t9': { clientId: OTHER, date: '2026-09-01', createdBy: '담당자' },
  });
  staged(db, bucket, '담당자', 'up000001');
  staged(db, bucket, '담당자', 'up000002');

  const out = await fns.finalizeReceipts({
    ...as('담당자'),
    data: { items: [
      { uploadId: 'up000001', trxId: 't9' },   // 담당 밖 → 실패
      { uploadId: 'up000002', trxId: 't1' },   // 성공
    ] },
  });

  assert.equal(out.okCount, 1);
  assert.equal(out.failCount, 1);
  assert.ok(db.docs.get('transactions/t1').receiptPath);
});

test('업로드 식별자 형식을 검사한다', async () => {
  const { fns } = build();
  const out = await fns.finalizeReceipts({
    ...as('담당자'), data: { items: [{ uploadId: '../../etc/passwd' }] },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /식별자/);
});

test('한 번에 처리할 수 있는 건수에 상한이 있다', async () => {
  const { fns } = build();
  const items = Array.from({ length: 31 }, (_, i) => ({ uploadId: `up${String(i).padStart(6, '0')}` }));
  await assert.rejects(
    () => fns.finalizeReceipts({ ...as('담당자'), data: { items } }),
    (e) => e.code === 'invalid-argument',
  );
});

// ─────────────────────────────────────────────
// 해제 · 만료 정리
// ─────────────────────────────────────────────

test('증빙 해제는 경로와 generation이 일치할 때 거래·감사를 원자 갱신하고 파일을 지운다', async () => {
  const path = jobs.finalPath(MY, 'up000001');
  const { db, bucket, fns } = build({
    'transactions/t1': {
      clientId: MY, date: '2026-09-01', createdBy: '담당자',
      receiptPath: path, receiptGeneration: '1001', receiptUrl: 'https://old',
    },
  }, { [path]: 'receipt' });

  await fns.removeReceipt({
    ...as('담당자'), data: {
      trxId: 't1', expectedReceiptPath: path, expectedReceiptGeneration: '1001',
    },
  });

  const trx = db.docs.get('transactions/t1');
  assert.equal(trx.receiptPath, undefined);
  assert.equal(trx.receiptGeneration, undefined);
  assert.equal(bucket.objects.has(path), false);
  const audit = [...db.docs.values()].find((d) => d.action === 'receipt.remove');
  assert.equal(audit.receiptPath, path);
  assert.equal(audit.receiptGeneration, '1001');
});

test('증빙 해제의 예상 generation이 낡았으면 거래와 파일을 모두 보존한다', async () => {
  const path = jobs.finalPath(MY, 'up000001');
  const { db, bucket, fns } = build({
    'transactions/t1': {
      clientId: MY, date: '2026-09-01', createdBy: '담당자',
      receiptPath: path, receiptGeneration: '1001', receiptUrl: 'https://old',
    },
  }, { [path]: 'receipt' });

  await assert.rejects(
    () => fns.removeReceipt({
      ...as('담당자'), data: {
        trxId: 't1', expectedReceiptPath: path, expectedReceiptGeneration: '1000',
      },
    }),
    (e) => e.code === 'aborted',
  );
  assert.equal(db.docs.get('transactions/t1').receiptGeneration, '1001');
  assert.equal(bucket.objects.has(path), true);
});

test('만료된 미첨부 job은 검증된 final → staging → job 순서로 정리한다', async () => {
  const { db, bucket, fns } = build();
  staged(db, bucket, '담당자', 'up000001', MY, jobs.STATES.FINALIZING);
  const jp = jobs.jobPath('담당자', 'up000001');
  const final = jobs.finalPath(MY, 'up000001');
  bucket.put(final, 'copied');
  const meta = bucket.objects.get(final);
  const job = db.docs.get(jp);
  meta.metadata = {
    firebaseStorageDownloadTokens: 'token', uploadId: 'up000001', jobId: jp,
    sourceGeneration: job.sourceGeneration,
  };
  db.docs.set(jp, {
    ...job, finalPath: final, finalGeneration: meta.generation,
    expireAt: new Date(Date.now() - 1),
  });

  await fns.cleanupReceiptJobs();
  assert.equal(bucket.objects.has(final), false);
  assert.equal(bucket.objects.has(jobs.stagingPath('담당자', 'up000001')), false);
  assert.equal(db.docs.has(jp), false);
});

test('최종화 lease가 살아 있으면 TTL 정리가 선점하지 않는다', async () => {
  const { db, bucket, fns } = build();
  staged(db, bucket, '담당자', 'up000001', MY, jobs.STATES.FINALIZING);
  const jp = jobs.jobPath('담당자', 'up000001');
  db.docs.set(jp, {
    ...db.docs.get(jp),
    leaseToken: 'worker',
    leaseUntil: new Date(Date.now() + 60_000),
    expireAt: new Date(Date.now() - 1),
  });

  await fns.cleanupReceiptJobs();
  assert.equal(db.docs.has(jp), true);
  assert.equal(bucket.objects.has(jobs.stagingPath('담당자', 'up000001')), true);
});

test('job TTL 정리는 거래에 첨부된 최종 영수증을 삭제하지 않는다', async () => {
  const { db, bucket, fns } = build();
  staged(db, bucket, '담당자', 'up000001', MY, jobs.STATES.COMPLETED);
  const jp = jobs.jobPath('담당자', 'up000001');
  const final = jobs.finalPath(MY, 'up000001');
  bucket.put(final, 'attached');
  db.docs.set(jp, {
    ...db.docs.get(jp), finalPath: final,
    finalGeneration: bucket.objects.get(final).generation,
    expireAt: new Date(Date.now() - 1),
  });

  await fns.cleanupReceiptJobs();
  assert.equal(bucket.objects.has(final), true, '최종 영수증이 TTL로 삭제됐습니다');
  assert.equal(bucket.objects.has(jobs.stagingPath('담당자', 'up000001')), false);
  assert.equal(db.docs.has(jp), false);
});

test('출처 metadata가 다른 final은 지우지 않고 orphan 감사 대상으로 남긴다', async () => {
  const { db, bucket, fns } = build();
  staged(db, bucket, '담당자', 'up000001', MY, jobs.STATES.FINALIZING);
  const jp = jobs.jobPath('담당자', 'up000001');
  const final = jobs.finalPath(MY, 'up000001');
  bucket.put(final, 'unknown');
  const meta = bucket.objects.get(final);
  meta.metadata = { uploadId: 'different', jobId: 'different', sourceGeneration: '0' };
  db.docs.set(jp, {
    ...db.docs.get(jp), finalPath: final, finalGeneration: meta.generation,
    expireAt: new Date(Date.now() - 1),
  });

  await fns.cleanupReceiptJobs();
  assert.equal(bucket.objects.has(final), true);
  assert.equal(db.docs.has(jp), false);
  assert.ok([...db.docs.values()].some((d) => d.action === 'receipt.orphan'));
});
