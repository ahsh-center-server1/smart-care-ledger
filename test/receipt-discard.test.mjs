// test/receipt-discard.test.mjs
//
// 판독만 하고 **저장하지 않은** 사진은 Storage 에 남으면 안 된다.
//
// 왜 이런 사진이 생기나
//   「영수증 사진」은 판독 전에 사진을 스테이징에 올린다 — 서버가 원본을 봐야
//   하므로 다른 길이 없다. 그런데 실제 쓰임 중 흔한 것이 **판독 결과만 보고
//   창을 닫는 것**이고, 몇 장을 「건너뛰기」로 두는 것도 마찬가지다. 그 사진들은
//   사용자가 "안 쓴다"고 정한 것인데도 파일은 이미 올라가 있다.
//
//   예전에는 TTL(24시간)만이 그것을 받았다. 무료 한도(5GB)를 저장하지 않은
//   사진으로 채우는 셈이라, 사용자가 정한 그 순간에 지운다.
//
// 여기서 지키는 선
//   ⑴ 아직 안 붙은 job 은 파일과 문서가 함께 사라진다
//   ⑵ **이미 거래에 붙은 증빙은 절대 지워지지 않는다** — 결재가 끝난 문서의
//      증빙이 사라지면 되돌릴 방법이 없다. 이것이 이 기능의 유일한 위험이다
//   ⑶ 남의 job 은 애초에 가리킬 수 없다(경로에 uid 가 들어 있다)
//   ⑷ 정리가 실패해도 사용자가 하려던 일을 막지 않는다

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

const MY = 'c1';

function authz(uid, role, ids) {
  return {
    uid, role, enabled: true, accessibleClientIds: ids,
    caps: computeCaps(rankOf({ role, isAdmin: false }), {}),
  };
}

function build(seed = {}) {
  const db = makeDb({
    'authz/담당자': authz('담당자', '담당자', [MY]),
    'authz/다른담당': authz('다른담당', '담당자', [MY]),
    ...seed,
  });
  const bucket = makeBucket();
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

/** 스테이징에 파일이 올라간 job 하나. */
function staged(db, bucket, uid, uploadId, state = jobs.STATES.ANALYZED, extra = {}) {
  const path = jobs.stagingPath(uid, uploadId);
  bucket.put(path, 'photo-bytes');
  db.docs.set(jobs.jobPath(uid, uploadId), {
    ...jobs.newJob({ uid, uploadId, clientId: MY, now: Date.now() }),
    state,
    sourceGeneration: bucket.objects.get(path).generation,
    ...extra,
  });
  return path;
}

// ─────────────────────────────────────────────
// 지운다
// ─────────────────────────────────────────────

test('판독만 한 사진은 파일과 job 이 함께 사라진다', async () => {
  const { db, bucket, fns } = build();
  const path = staged(db, bucket, '담당자', 'upload01');

  const out = await fns.discardReceiptUploads({
    ...as('담당자'), data: { uploadIds: ['upload01'] },
  });

  assert.equal(out.discarded, 1);
  assert.equal(out.kept, 0);
  assert.ok(!bucket.objects.has(path), '스테이징 파일이 남아 있습니다');
  assert.ok(!db.docs.has(jobs.jobPath('담당자', 'upload01')), 'job 문서가 남아 있습니다');
});

test('여러 장을 한 번에 — 창을 닫을 때가 그렇다', async () => {
  const { db, bucket, fns } = build();
  for (const id of ['upload01', 'upload02', 'upload03']) staged(db, bucket, '담당자', id);

  const out = await fns.discardReceiptUploads({
    ...as('담당자'), data: { uploadIds: ['upload01', 'upload02', 'upload03'] },
  });
  assert.equal(out.discarded, 3);
  assert.equal(bucket.objects.size, 0);
});

test('이미 없는 것은 실패가 아니다 — 목적이 이미 달성됐다', async () => {
  const { fns } = build();
  const out = await fns.discardReceiptUploads({
    ...as('담당자'), data: { uploadIds: ['nosuchupload'] },
  });
  assert.equal(out.discarded, 1);
  assert.equal(out.kept, 0);
});

// ─────────────────────────────────────────────
// 지우지 않는다 — 이쪽이 더 중요하다
// ─────────────────────────────────────────────

for (const state of jobs.ATTACHED_STATES) {
  test(`이미 거래에 붙은 증빙(${state})은 지우지 않는다`, async () => {
    const { db, bucket, fns } = build();
    const final = jobs.finalPath(MY, 'upload01');
    bucket.put(final, 'receipt-bytes');
    staged(db, bucket, '담당자', 'upload01', state, { finalPath: final });

    const out = await fns.discardReceiptUploads({
      ...as('담당자'), data: { uploadIds: ['upload01'] },
    });

    assert.equal(out.discarded, 0);
    assert.equal(out.kept, 1);
    assert.ok(bucket.objects.has(final), '거래의 증빙이 지워졌습니다');
    assert.ok(db.docs.has(jobs.jobPath('담당자', 'upload01')), 'job 문서가 지워졌습니다');
  });
}

test('남의 job 은 가리킬 수 없다 — 경로가 자기 uid 로 고정된다', async () => {
  const { db, bucket, fns } = build();
  const path = staged(db, bucket, '다른담당', 'upload01');

  const out = await fns.discardReceiptUploads({
    ...as('담당자'), data: { uploadIds: ['upload01'] },
  });

  // 자기 경로에는 그 job 이 없으므로 「이미 없음」으로 끝난다.
  assert.equal(out.discarded, 1);
  assert.ok(bucket.objects.has(path), '남의 스테이징 파일이 지워졌습니다');
  assert.ok(db.docs.has(jobs.jobPath('다른담당', 'upload01')));
});

test('로그인하지 않았으면 아무것도 하지 않는다', async () => {
  const { fns } = build();
  await assert.rejects(
    () => fns.discardReceiptUploads({ auth: null, data: { uploadIds: ['upload01'] } }),
    (e) => e.code === 'unauthenticated',
  );
});

test('uploadId 꼴이 아니면 건드리지 않는다', async () => {
  const { fns } = build();
  const out = await fns.discardReceiptUploads({
    ...as('담당자'), data: { uploadIds: ['../../etc/passwd', 'x'] },
  });
  assert.equal(out.discarded, 0);
  assert.equal(out.kept, 2);
});

test('빈 목록은 서버를 부르는 값어치가 없다', async () => {
  const { db, fns } = build();
  const out = await fns.discardReceiptUploads({ ...as('담당자'), data: {} });
  assert.deepEqual(out, { discarded: 0, kept: 0 });
  assert.equal(db.commits, 0);
});

test('한 번에 보낼 수 있는 건수에 상한이 있다', async () => {
  const { fns } = build();
  await assert.rejects(
    () => fns.discardReceiptUploads({
      ...as('담당자'),
      data: { uploadIds: Array.from({ length: 50 }, (_, i) => `upload${String(i).padStart(3, '0')}`) },
    }),
    (e) => e.code === 'invalid-argument',
  );
});

// ─────────────────────────────────────────────
// TTL — 즉시 정리가 닿지 못한 것을 받는 그물
// ─────────────────────────────────────────────

test('스테이징 수명은 검토 창 하나보다 길고 하루보다 짧다', () => {
  const hour = 60 * 60 * 1000;
  assert.ok(jobs.STAGING_TTL_MS >= hour,
    '한 시간보다 짧으면 사진을 확인하는 동안 파일이 사라진다');
  assert.ok(jobs.STAGING_TTL_MS <= 6 * hour,
    '저장하지 않기로 한 사진을 반나절 넘게 들고 있을 이유가 없다');
});
