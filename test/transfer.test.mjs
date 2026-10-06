import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, FieldValue, FakeHttpsError, silentLogger } from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const transferFns = require('../functions/transfer-fns.js');
const makeCaller = require('../functions/caller.cjs');
const { computeCaps, rankOf } = require('../functions/perm-catalog.cjs');

/**
 * 자산이동 — **다리가 하나뿐인 상태가 만들어지는가.**
 *
 * 이 기능은 세 번 고쳐졌다. 연속 쓰기 → 배치, 상대편 없이 저장 → 탐색,
 * 짝 어긋남 → 링크 정리. 그래도 한 곳이 남아 있었다: 상대편을 찾는 조회가
 * 배치 밖이라, 두 사람이 같은 순간 각자의 거래를 자산이동으로 바꾸면 둘 다
 * 같은 상대편을 발견했다. 서버는 그 조회까지 트랜잭션 안에 둔다.
 */

const C1 = 'c1';
const C2 = 'c2';

function authzOf(uid, role, ids) {
  return {
    uid, role, enabled: true, accessibleClientIds: ids,
    caps: computeCaps(rankOf({ role, isAdmin: false }), {}),
  };
}

function build(seed = {}) {
  const db = makeDb({
    'authz/담당자': authzOf('담당자', '담당자', [C1, C2]),
    'authz/입력자': authzOf('입력자', '입력자', [C1, C2]),
    'authz/좁은담당': authzOf('좁은담당', '담당자', [C1]),
    'accounts/a1': { clientId: C1, label: '생활비' },
    'accounts/a2': { clientId: C1, label: '적금' },
    'accounts/b1': { clientId: C2, label: '남의계좌' },
    ...seed,
  });
  const { requireCaller } = makeCaller({ db, HttpsError: FakeHttpsError });
  const { saveTransfer } = transferFns({
    db, callable: (n, h) => h, requireCaller,
    HttpsError: FakeHttpsError, logger: silentLogger, FieldValue,
  });
  return { db, saveTransfer };
}

const as = (uid) => ({ auth: { uid } });
const move = (over = {}) => ({
  fromAccountId: 'a1', toAccountId: 'a2', date: '2026-09-01',
  amount: 50000, description: '적금 이체', ...over,
});

// ─────────────────────────────────────────────

test('두 다리가 서로를 가리킨다', async () => {
  const { db, saveTransfer } = build();
  const out = await saveTransfer({ ...as('담당자'), data: move() });

  const o = db.docs.get('transactions/' + out.outId);
  const i = db.docs.get('transactions/' + out.inId);
  assert.equal(o.amountOut, 50000);
  assert.equal(i.amountIn, 50000);
  assert.equal(o.linkedTrxId, out.inId);
  assert.equal(i.linkedTrxId, out.outId);
  assert.equal(o.type, '자산이동');
  assert.equal(i.type, '자산이동');
  assert.equal(o.createdBy, '담당자', 'createdBy 를 서버가 정하지 않았습니다');
});

test('한 다리가 실패하면 다른 다리도 남지 않는다', async () => {
  // 장부에서 돈이 증발하는 방식이 이것이었다.
  const { db, saveTransfer } = build();
  db.failWrite = (path) => path.startsWith('transactions/');
  await assert.rejects(() => saveTransfer({ ...as('담당자'), data: move() }), /쓰기 실패/);
  assert.equal([...db.docs.keys()].filter(k => k.startsWith('transactions/')).length, 0);
});

test('같은 계좌로는 이동할 수 없다', async () => {
  const { saveTransfer } = build();
  await assert.rejects(
    () => saveTransfer({ ...as('담당자'), data: move({ toAccountId: 'a1' }) }),
    (e) => e.code === 'invalid-argument',
  );
});

test('담당 밖 계좌로는 옮길 수 없다', async () => {
  // 한쪽만 확인하면 담당 밖 입주자의 장부에 거래를 밀어 넣을 수 있다.
  const { db, saveTransfer } = build();
  await assert.rejects(
    () => saveTransfer({ ...as('좁은담당'), data: move({ toAccountId: 'b1' }) }),
    (e) => e.code === 'permission-denied',
  );
  assert.equal([...db.docs.keys()].filter(k => k.startsWith('transactions/')).length, 0);
});

test('자산이동 권한이 없으면 거부한다', async () => {
  const { saveTransfer } = build();
  await assert.rejects(
    () => saveTransfer({ ...as('입력자'), data: move() }),
    (e) => e.code === 'permission-denied',
  );
});

test('마감된 달에는 만들 수 없다', async () => {
  const { saveTransfer } = build({
    'config/lockedMonths': { months: { [`${C1}_2026-09`]: true } },
  });
  await assert.rejects(
    () => saveTransfer({ ...as('담당자'), data: move() }),
    (e) => e.code === 'failed-precondition' && /최종 결재가 끝난/.test(e.message),
  );
});

test('없는 계좌를 지정하면 거부한다', async () => {
  const { saveTransfer } = build();
  await assert.rejects(
    () => saveTransfer({ ...as('담당자'), data: move({ toAccountId: '없음' }) }),
    (e) => e.code === 'not-found',
  );
});

// ─────────────────────────────────────────────
// 기존 거래를 자산이동으로 바꾸기
// ─────────────────────────────────────────────

test('짝이 있으면 그 짝을 그대로 고친다', async () => {
  const { db, saveTransfer } = build({
    'transactions/out1': {
      clientId: C1, accountId: 'a1', date: '2026-09-01', type: '자산이동',
      amountOut: 30000, linkedTrxId: 'in1', createdBy: '옛담당',
    },
    'transactions/in1': {
      clientId: C1, accountId: 'a2', date: '2026-09-01', type: '자산이동',
      amountIn: 30000, linkedTrxId: 'out1', createdBy: '옛담당',
    },
  });

  const out = await saveTransfer({ ...as('담당자'), data: move({ existId: 'out1', amount: 70000 }) });
  assert.equal(out.outId, 'out1');
  assert.equal(out.inId, 'in1');
  assert.equal(db.docs.get('transactions/out1').amountOut, 70000);
  assert.equal(db.docs.get('transactions/in1').amountIn, 70000);
  // 남의 거래를 손대면서 자기 것으로 만들지 않는다
  assert.equal(db.docs.get('transactions/out1').createdBy, '옛담당');
});

test('상대편이 없으면 만든다 — 반쪽으로 저장하지 않는다', async () => {
  const { db, saveTransfer } = build({
    'transactions/e1': {
      clientId: C1, accountId: 'a1', date: '2026-09-01', type: '지출',
      amountOut: 50000, createdBy: '담당자',
    },
  });

  const out = await saveTransfer({ ...as('담당자'), data: move({ existId: 'e1' }) });
  assert.equal(out.createdMate, true);
  const mate = db.docs.get('transactions/' + out.inId);
  assert.equal(mate.amountIn, 50000);
  assert.equal(mate.linkedTrxId, 'e1');
  assert.equal(db.docs.get('transactions/e1').linkedTrxId, out.inId);
});

test('상대편 후보를 찾으면 연결한다', async () => {
  const { db, saveTransfer } = build({
    'transactions/e1': {
      clientId: C1, accountId: 'a1', date: '2026-09-01', type: '지출',
      amountOut: 50000, createdBy: '담당자',
    },
    'transactions/cand': {
      clientId: C1, accountId: 'a2', date: '2026-09-01', type: '수입',
      amountIn: 50000, amountOut: 0, createdBy: '담당자',
    },
  });

  const out = await saveTransfer({ ...as('담당자'), data: move({ existId: 'e1' }) });
  assert.equal(out.inId, 'cand');
  assert.equal(out.linkedExisting, true);
  assert.equal(db.docs.get('transactions/cand').type, '자산이동');
  assert.equal(db.docs.get('transactions/cand').linkedTrxId, 'e1');
});

test('후보가 여럿이면 저장을 막는다 — 사람이 정리해야 한다', async () => {
  const { db, saveTransfer } = build({
    'transactions/e1': {
      clientId: C1, accountId: 'a1', date: '2026-09-01', type: '지출',
      amountOut: 50000, createdBy: '담당자',
    },
    'transactions/c1x': { clientId: C1, accountId: 'a2', date: '2026-09-01', type: '수입', amountIn: 50000, amountOut: 0 },
    'transactions/c2x': { clientId: C1, accountId: 'a2', date: '2026-09-01', type: '수입', amountIn: 50000, amountOut: 0 },
  });

  await assert.rejects(
    () => saveTransfer({ ...as('담당자'), data: move({ existId: 'e1' }) }),
    (e) => e.code === 'failed-precondition' && /2건/.test(e.message),
  );
  assert.equal(db.docs.get('transactions/e1').type, '지출', '모호한데 저장됐습니다');
});

test('다른 입주자의 거래를 출금 다리로 삼을 수 없다', async () => {
  const { saveTransfer } = build({
    'transactions/e1': {
      clientId: C2, accountId: 'b1', date: '2026-09-01', type: '지출',
      amountOut: 50000, createdBy: '담당자',
    },
  });
  await assert.rejects(
    () => saveTransfer({ ...as('담당자'), data: move({ existId: 'e1' }) }),
    (e) => e.code === 'failed-precondition' && /입주자와 다릅니다/.test(e.message),
  );
});

test('로그인하지 않으면 거부한다', async () => {
  const { saveTransfer } = build();
  await assert.rejects(
    () => saveTransfer({ data: move() }),
    (e) => e.code === 'unauthenticated',
  );
});
