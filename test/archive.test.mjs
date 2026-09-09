import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  makeDb, makeBucket, FieldValue, FakeHttpsError, silentLogger,
} from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const archiveFns = require('../functions/archive-fns.js');
const { computeCaps, rankOf } = require('../functions/perm-catalog.cjs');

// sharp 는 functions/ 의 의존이다. 대역 이미지 대신 **진짜 JPEG** 을 만들어
// 실제 재압축 경로를 태운다 — 가짜 바이트로는 sharp 가 던지고 끝난다.
const requireFn = createRequire(new URL('../functions/package.json', import.meta.url));
const sharp = requireFn('sharp');

/** 큰 JPEG 하나. 900px 로 줄이면 확실히 작아진다. */
const BIG_JPEG = await sharp({
  create: { width: 2000, height: 1500, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
}).jpeg({ quality: 95 }).toBuffer();

/**
 * 연도 마감 — 나눠 도는 작업이 **끝나고, 두 번 세지 않는가.**
 *
 * 왜 서버로 왔나
 *   · 마감은 마감된 달의 거래를 지운다. 규칙이 그것을 막게 되면서 브라우저에서
 *     도는 마감은 그 자체로 거부된다(센터장에게 lock.bypass 를 주는 것은 답이 아니다).
 *   · 보관 재압축이 최종 객체를 덮어쓴다. Web SDK 에는 generation 사전조건이
 *     없어 같은 순간의 증빙 교체를 조용히 뭉갠다.
 *
 * 여기서 확인하는 것
 *   · 여러 번 나눠 불러도 끝난다 (무한 루프가 없다)
 *   · 중간에 끊고 다시 불러도 사본이 중복되지 않고 잔액이 두 번 더해지지 않는다
 *   · 재압축이 읽은 그 객체일 때만 덮어쓴다
 */

function build(seed = {}, objects = {}) {
  const db = makeDb({
    'authz/센터장': {
      uid: '센터장', enabled: true, accessibleClientIds: ['c1'],
      caps: computeCaps(rankOf({ role: '센터장' }), {}),
    },
    'authz/담당자': {
      uid: '담당자', enabled: true, accessibleClientIds: ['c1'],
      caps: computeCaps(rankOf({ role: '담당자' }), {}),
    },
    ...seed,
  });
  const bucket = makeBucket();
  for (const [p, d] of Object.entries(objects)) bucket.put(p, d);
  const { runArchive } = archiveFns({
    db, getBucket: () => bucket, callable: (n, h) => h,
    HttpsError: FakeHttpsError, logger: silentLogger, FieldValue,
  });
  return { db, bucket, runArchive };
}

const as = (uid) => ({ auth: { uid } });

/** 끝날 때까지 부른다. 라운드 수도 돌려준다 — 무한 루프를 잡기 위해. */
async function runToCompletion(runArchive, year = 2025, cap = 100) {
  let out = { done: false };
  let rounds = 0;
  while (!out.done) {
    if (++rounds > cap) throw new Error(`끝나지 않습니다 (${rounds}회, phase=${out.phase})`);
    out = await runArchive({ ...as('센터장'), data: { year } });
  }
  return { out, rounds };
}

function seedTrx(db, n, accountId = 'a1') {
  for (let i = 0; i < n; i++) {
    db.docs.set(`transactions/t${String(i).padStart(4, '0')}`, {
      clientId: 'c1', accountId, date: `2025-0${(i % 9) + 1}-15`,
      amountIn: 0, amountOut: 100, type: '지출',
    });
  }
}

// ─────────────────────────────────────────────

test('권한이 없으면 시작조차 못 한다', async () => {
  const { runArchive } = build();
  await assert.rejects(
    () => runArchive({ ...as('담당자'), data: { year: 2025 } }),
    (e) => e.code === 'permission-denied',
  );
});

test('연도가 이상하면 거부한다', async () => {
  const { runArchive } = build();
  for (const year of ['올해', 1999, 3000, null]) {
    await assert.rejects(
      () => runArchive({ ...as('센터장'), data: { year } }),
      (e) => e.code === 'invalid-argument', String(year),
    );
  }
});

test('거래를 옮기고 원본을 지운다', async () => {
  const { db, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 1000, initialBalanceDate: '2025-01-01' },
  });
  seedTrx(db, 5);

  const { out } = await runToCompletion(runArchive);
  assert.equal(out.done, true);
  assert.equal(out.count, 5);
  for (let i = 0; i < 5; i++) {
    const id = `t${String(i).padStart(4, '0')}`;
    assert.equal(db.docs.has(`transactions/${id}`), false, `${id} 원본이 남았습니다`);
    assert.equal(db.docs.has(`archive_2025/${id}`), true, `${id} 사본이 없습니다`);
  }
  // 사본은 원본 ID 를 그대로 쓴다 — 재시도해도 복제되지 않는 근거다.
  assert.equal(db.docs.get('archive_2025/t0000').archivedFrom, 't0000');
});

test('기초잔액이 다음 해로 전진한다', async () => {
  const { db, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 1000, initialBalanceDate: '2025-01-01' },
  });
  seedTrx(db, 3);   // 지출 100 × 3

  await runToCompletion(runArchive);
  const acc = db.docs.get('accounts/a1');
  assert.equal(acc.initialBalance, 700);
  assert.equal(acc.initialBalanceDate, '2026-01-01');
  assert.equal(acc.currentBalance, 700);
});

test('취소 거래는 잔액에서 빠진다', async () => {
  const { db, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 1000, initialBalanceDate: '2025-01-01' },
  });
  db.docs.set('transactions/t1', { clientId: 'c1', accountId: 'a1', date: '2025-03-01', amountOut: 500, type: '취소' });
  db.docs.set('transactions/t2', { clientId: 'c1', accountId: 'a1', date: '2025-03-02', amountOut: 100, type: '지출' });

  await runToCompletion(runArchive);
  assert.equal(db.docs.get('accounts/a1').initialBalance, 900);
});

test('이미 전진한 계좌는 다시 전진하지 않는다', async () => {
  const { db, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 700, initialBalanceDate: '2026-01-01' },
  });
  seedTrx(db, 3);
  await runToCompletion(runArchive);
  assert.equal(db.docs.get('accounts/a1').initialBalance, 700, '잔액이 두 번 계산됐습니다');
});

test('다시 실행해도 사본이 중복되지 않고 잔액이 두 번 더해지지 않는다', async () => {
  const { db, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 1000, initialBalanceDate: '2025-01-01' },
  });
  seedTrx(db, 4);

  await runToCompletion(runArchive);
  const after = { ...db.docs.get('accounts/a1') };
  const archived = [...db.docs.keys()].filter(k => k.startsWith('archive_2025/')).length;

  // 같은 연도로 다시 — 이미 done 이므로 아무것도 하지 않는다
  const again = await runArchive({ ...as('센터장'), data: { year: 2025 } });
  assert.equal(again.done, true);
  assert.deepEqual(db.docs.get('accounts/a1'), after);
  assert.equal([...db.docs.keys()].filter(k => k.startsWith('archive_2025/')).length, archived);
});

test('중간에 끊겨도 이어서 진행된다', async () => {
  const { db, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 1000, initialBalanceDate: '2025-01-01' },
  });
  seedTrx(db, 6);

  // 두 번만 부르고 멈춘다
  await runArchive({ ...as('센터장'), data: { year: 2025 } });
  await runArchive({ ...as('센터장'), data: { year: 2025 } });
  const log = db.docs.get('config/archive_2025');
  assert.equal(log.status, 'in_progress');

  // 이어서 끝까지
  const { out } = await runToCompletion(runArchive);
  assert.equal(out.done, true);
  assert.equal(db.docs.get('accounts/a1').initialBalance, 400);
});

test('이력을 작업 전에 남긴다', async () => {
  // 예전에는 마지막에 남겨서, 중간에 끊기면 화면상 미마감으로 보이고
  // 다시 누르면 거래가 삼중으로 쌓였다.
  const { db, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 0, initialBalanceDate: '2025-01-01' },
  });
  seedTrx(db, 2);

  await runArchive({ ...as('센터장'), data: { year: 2025 } });
  const log = db.docs.get('config/archive_2025');
  assert.equal(log.status, 'in_progress', '작업 전에 이력이 없습니다');
  assert.equal(log.by, '센터장');
  assert.ok(log.startedAt);
});

test('비활성 계좌도 전진시킨다', async () => {
  // 화면의 S.accounts 는 활성 계좌만 담았다. 예전에는 비활성 계좌의 거래만
  // 삭제되고 기초잔액은 전진하지 않아 1년치가 영구 증발했다.
  const { db, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 1000, initialBalanceDate: '2025-01-01', active: false },
  });
  seedTrx(db, 2);

  await runToCompletion(runArchive);
  const acc = db.docs.get('accounts/a1');
  assert.equal(acc.initialBalanceDate, '2026-01-01', '비활성 계좌가 전진하지 않았습니다');
  assert.equal(acc.initialBalance, 800);
});

test('사본을 add 가 아니라 원본 ID 로 만든다', async () => {
  // 재시도가 사본을 복제하지 않는 근거다. 동작으로도 확인하지만(위),
  // 새 코드가 add 로 돌아가는 것은 원문에서 잡는 편이 빠르다.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../functions/archive-fns.js', import.meta.url), 'utf8');
  assert.ok(/\.doc\(d\.id\)/.test(src), '원본 ID 를 사본 ID 로 쓰지 않습니다');
  assert.ok(!/\.add\(/.test(src), 'add 는 재시도 시 사본을 복제합니다');
});

test('그 해 거래가 없어도 단계가 끝난다', async () => {
  const { runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 500, initialBalanceDate: '2025-01-01' },
  });
  const { out, rounds } = await runToCompletion(runArchive);
  assert.equal(out.done, true);
  assert.ok(rounds <= 5, `빈 마감에 ${rounds}회가 걸렸습니다`);
});

// ─────────────────────────────────────────────
// 재압축
// ─────────────────────────────────────────────

test('영수증을 저해상도로 다시 쓴다 — 경로가 없으면 URL 에서 되짚는다', async () => {
  const path = 'receipts/c1/old.jpg';
  const url = `https://firebasestorage.googleapis.com/v0/b/test-bucket/o/${encodeURIComponent(path)}?alt=media&token=t`;
  const { db, bucket, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 0, initialBalanceDate: '2025-01-01' },
  }, { [path]: BIG_JPEG });
  db.docs.set('transactions/t1', {
    clientId: 'c1', accountId: 'a1', date: '2025-05-01', amountOut: 10, receiptUrl: url,
  });

  const before = bucket.objects.get(path).generation;
  await runToCompletion(runArchive);
  const after = bucket.objects.get(path);
  assert.notEqual(after.generation, before, '옛 URL 의 영수증이 재압축되지 않았습니다');
  assert.ok(after.data.length < BIG_JPEG.length, '더 작아지지 않았습니다');
});

test('다운로드 토큰을 보존한다 — 나가 있는 URL 이 깨지면 안 된다', async () => {
  const path = 'receipts/c1/keep.jpg';
  const { db, bucket, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 0, initialBalanceDate: '2025-01-01' },
  }, { [path]: BIG_JPEG });
  bucket.objects.get(path).metadata = { firebaseStorageDownloadTokens: '토큰1' };
  db.docs.set('transactions/t1', {
    clientId: 'c1', accountId: 'a1', date: '2025-05-01', amountOut: 10, receiptPath: path,
  });

  await runToCompletion(runArchive);
  assert.equal(bucket.objects.get(path).metadata.firebaseStorageDownloadTokens, '토큰1');
});

test('그 사이 교체된 객체는 덮어쓰지 않는다', async () => {
  // 이것이 브라우저에서는 불가능했던 것이다 — uploadBytes 에는 사전조건이 없다.
  // 내려받은 **뒤에** 누군가 같은 경로를 교체한 상황을 만든다. 교체본도 진짜
  // 이미지여야 한다 — 아니면 sharp 가 먼저 던져서 save 까지 가지도 않는다.
  const path = 'receipts/c1/raced.jpg';
  const REPLACEMENT = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).jpeg().toBuffer();

  const { db, bucket, runArchive } = build({
    'accounts/a1': { clientId: 'c1', initialBalance: 0, initialBalanceDate: '2025-01-01' },
  }, { [path]: BIG_JPEG });
  db.docs.set('transactions/t1', {
    clientId: 'c1', accountId: 'a1', date: '2025-05-01', amountOut: 10, receiptPath: path,
  });

  const realFile = bucket.file.bind(bucket);
  bucket.file = (p) => {
    const f = realFile(p);
    if (p !== path) return f;
    const realDownload = f.download.bind(f);
    f.download = async () => {
      const out = await realDownload();
      bucket.put(path, REPLACEMENT);       // ← 내려받은 뒤 누군가 교체
      return out;
    };
    return f;
  };

  await runToCompletion(runArchive);
  assert.equal(
    bucket.objects.get(path).data, REPLACEMENT,
    '새 증빙이 옛 사진의 저해상도 판으로 덮였습니다',
  );
});

test('그 해 통장 사진도 줄인다', async () => {
  const path = 'bankbooks/c1/a1/2025-05.jpg';
  const url = `https://firebasestorage.googleapis.com/v0/b/test-bucket/o/${encodeURIComponent(path)}?alt=media&token=t`;
  const { bucket, runArchive } = build({
    'accounts/a1': {
      clientId: 'c1', initialBalance: 0, initialBalanceDate: '2025-01-01',
      bankStatements: [{ url, month: '2025-05' }, { url: 'https://x/o/other?alt=media', month: '2024-01' }],
    },
  }, { [path]: BIG_JPEG });

  const before = bucket.objects.get(path).generation;
  await runToCompletion(runArchive);
  assert.notEqual(bucket.objects.get(path).generation, before);
});
