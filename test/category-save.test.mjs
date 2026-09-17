// test/category-save.test.mjs
//
// 분류 이름·색상 수정 — **이름을 바꾸면 장부가 따라오는가.**
//
// 거래는 분류를 문자열로 들고 있다. 이름만 바꾸면 기존 거래가 옛 이름에 남아
// 보고서 집계가 두 줄로 갈라진다. 그런데 공통 분류를 관리하는 팀장·센터장은
// trx.edit 을 갖지 않으므로(작성자·결재자 분리) 브라우저에서는 그 일괄 수정을
// 할 수 없다 — 이름만 바뀌고 거래는 그대로 남는 절반의 상태가 된다.
// 그래서 서버가 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, FieldValue, FakeHttpsError, silentLogger } from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const categoryFns = require('../functions/category-fns.js');
const { fixedCan } = require('../functions/fixed-role-policy.cjs');

const MY = 'c1';
const OTHER = 'c9';

function authz(uid, role, ids = [MY]) {
  return { uid, role, enabled: true, isAdmin: false, accessibleClientIds: ids,
    leaderClientIds: role === '팀장' ? ids : [] };
}

/** requireCaller 의 최소 구현. 실제와 같은 고정 정책으로 판정한다. */
function makeRequireCaller(db) {
  return async (auth) => {
    const snap = await db.doc(`authz/${auth.uid}`).get();
    const d = snap.data() || {};
    const can = (key) => fixedCan(d, key);
    const ids = d.role === '팀장' ? d.leaderClientIds : d.accessibleClientIds;
    return {
      uid: auth.uid, can,
      require(key, what) {
        if (!can(key)) throw new FakeHttpsError('permission-denied', `${what} 권한이 없습니다.`);
      },
      requireSees(clientId) {
        const ok = can('client.view.all') || (ids || []).includes(String(clientId));
        if (!ok) throw new FakeHttpsError('permission-denied', '담당하지 않는 입주자입니다.');
      },
    };
  };
}

function build(seed = {}) {
  const db = makeDb({
    'authz/담당자': authz('담당자', '담당자'),
    'authz/팀장': authz('팀장', '팀장'),
    'authz/입력자': authz('입력자', '입력자'),
    ...seed,
  });
  const fns = categoryFns({
    db,
    callable: (_name, handler) => handler,
    requireCaller: makeRequireCaller(db),
    HttpsError: FakeHttpsError,
    logger: silentLogger,
    FieldValue,
  });
  return { db, fns };
}

const as = (uid) => ({ auth: { uid } });
const def = (category, type = '지출', clientId) => ({
  keyword: '', type, category, subcategory: '', sortOrder: 1,
  ...(clientId ? { clientId } : {}),
});
const trx = (category, clientId = MY, date = '2026-09-05') => ({ clientId, date, category });

// ── 색상 ────────────────────────────────────────────────────

test('색상만 바꾸면 거래는 건드리지 않는다', async () => {
  const { db, fns } = build({
    'categories/k1': def('식비', '지출', MY),
    'transactions/t1': trx('식비'),
  });
  const out = await fns.saveCategory({
    ...as('담당자'), data: { type: '지출', clientId: MY, from: '식비', to: '식비', color: '#ff0000' },
  });
  assert.equal(db.docs.get('categories/k1').color, '#ff0000');
  assert.equal(out.transactions, 0);
  assert.equal(db.docs.get('transactions/t1').category, '식비');
});

test('색상 형식이 아니면 거절한다 — 화면이 style 에 그대로 넣는다', async () => {
  const { fns } = build({ 'categories/k1': def('식비', '지출', MY) });
  for (const color of ['red', 'javascript:x', '#ff00', '#gggggg']) {
    await assert.rejects(
      () => fns.saveCategory({ ...as('담당자'), data: { type: '지출', clientId: MY, from: '식비', color } }),
      (e) => e.code === 'invalid-argument', `${color} 를 받아들였습니다`);
  }
});

// ── 이름 변경이 장부를 끌고 간다 ─────────────────────────────

test('이름을 바꾸면 그 분류를 쓰는 거래가 함께 바뀐다', async () => {
  const { db, fns } = build({
    'categories/k1': def('식비', '지출', MY),
    'transactions/t1': trx('식비'),
    'transactions/t2': trx('식비'),
    'transactions/t3': trx('교통비'),
  });
  const out = await fns.saveCategory({
    ...as('담당자'), data: { type: '지출', clientId: MY, from: '식비', to: '부식비' },
  });
  assert.equal(out.transactions, 2);
  assert.equal(db.docs.get('categories/k1').category, '부식비');
  assert.equal(db.docs.get('transactions/t1').category, '부식비');
  assert.equal(db.docs.get('transactions/t2').category, '부식비');
  assert.equal(db.docs.get('transactions/t3').category, '교통비', '다른 분류를 건드렸습니다');
});

test('자동분류 규칙도 따라간다 — 빠뜨리면 다음 업로드가 사라진 이름으로 분류한다', async () => {
  const { db, fns } = build({
    'categories/k1': def('식비', '지출', MY),
    'categories/r1': { keyword: '마트', type: '지출', category: '식비', clientId: MY },
    'categories/r2': { keyword: '버스', type: '지출', category: '교통비', clientId: MY },
  });
  const out = await fns.saveCategory({
    ...as('담당자'), data: { type: '지출', clientId: MY, from: '식비', to: '부식비' },
  });
  assert.equal(out.rules, 1);
  assert.equal(db.docs.get('categories/r1').category, '부식비');
  assert.equal(db.docs.get('categories/r2').category, '교통비');
});

test('마감된 달의 거래는 건드리지 않고, 몇 건인지 알려 준다', async () => {
  // 결재가 끝난 숫자는 서버도 소급해 고치지 않는다. 장부가 두 이름으로
  // 갈라지지만, 조용히 갈라지지 않는 것이 핵심이다.
  const { db, fns } = build({
    'categories/k1': def('식비', '지출', MY),
    'config/lockedMonths': { months: { [`${MY}_2026-08`]: true } },
    'transactions/open': trx('식비', MY, '2026-09-05'),
    'transactions/locked': trx('식비', MY, '2026-08-20'),
  });
  const out = await fns.saveCategory({
    ...as('담당자'), data: { type: '지출', clientId: MY, from: '식비', to: '부식비' },
  });
  assert.equal(out.transactions, 1);
  assert.equal(out.locked, 1);
  assert.equal(db.docs.get('transactions/open').category, '부식비');
  assert.equal(db.docs.get('transactions/locked').category, '식비');
});

test('입주자 전용 이름 변경은 그 입주자의 거래만 바꾼다', async () => {
  const { db, fns } = build({
    'authz/담당자': authz('담당자', '담당자', [MY, OTHER]),
    'categories/k1': def('식비', '지출', MY),
    'transactions/mine': trx('식비', MY),
    'transactions/theirs': trx('식비', OTHER),
  });
  await fns.saveCategory({
    ...as('담당자'), data: { type: '지출', clientId: MY, from: '식비', to: '부식비' },
  });
  assert.equal(db.docs.get('transactions/mine').category, '부식비');
  assert.equal(db.docs.get('transactions/theirs').category, '식비',
    '다른 입주자의 거래를 건드렸습니다');
});

test('공통 이름 변경은, 같은 이름의 전용 분류를 가진 입주자를 비켜 간다', async () => {
  // 그 입주자의 「식비」는 **다른 분류**다. 공통을 바꾼다고 따라가면 안 된다.
  const { db, fns } = build({
    'categories/common': def('식비', '지출'),
    'categories/own': def('식비', '지출', OTHER),
    'transactions/uses-common': trx('식비', MY),
    'transactions/uses-own': trx('식비', OTHER),
  });
  const out = await fns.saveCategory({
    ...as('팀장'), data: { type: '지출', clientId: '', from: '식비', to: '부식비' },
  });
  assert.equal(out.transactions, 1);
  assert.equal(db.docs.get('transactions/uses-common').category, '부식비');
  assert.equal(db.docs.get('transactions/uses-own').category, '식비');
  assert.equal(db.docs.get('categories/own').category, '식비', '전용 분류를 건드렸습니다');
});

// ── 권한 ────────────────────────────────────────────────────

test('담당자는 공통 분류를 바꿀 수 없다', async () => {
  const { fns } = build({ 'categories/common': def('식비') });
  await assert.rejects(
    () => fns.saveCategory({ ...as('담당자'), data: { type: '지출', clientId: '', from: '식비', to: 'x' } }),
    (e) => e.code === 'permission-denied');
});

test('담당 밖 입주자의 전용 분류는 바꿀 수 없다', async () => {
  const { fns } = build({ 'categories/k9': def('식비', '지출', OTHER) });
  await assert.rejects(
    () => fns.saveCategory({
      ...as('담당자'), data: { type: '지출', clientId: OTHER, from: '식비', to: 'x' } }),
    (e) => e.code === 'permission-denied');
});

test('입력자는 아무것도 바꿀 수 없다', async () => {
  const { fns } = build({ 'categories/k1': def('식비', '지출', MY) });
  await assert.rejects(
    () => fns.saveCategory({
      ...as('입력자'), data: { type: '지출', clientId: MY, from: '식비', to: 'x' } }),
    (e) => e.code === 'permission-denied');
});

// ── 입력 검증 ───────────────────────────────────────────────

test('같은 이름이 이미 있으면 거절한다 — 두 분류가 하나로 합쳐지면 되돌릴 수 없다', async () => {
  const { fns } = build({
    'categories/k1': def('식비', '지출', MY),
    'categories/k2': def('교통비', '지출', MY),
  });
  await assert.rejects(
    () => fns.saveCategory({
      ...as('담당자'), data: { type: '지출', clientId: MY, from: '식비', to: '교통비' } }),
    (e) => e.code === 'already-exists');
});

test('「확인필요」는 이름을 바꿀 수 없다', async () => {
  // 판독·업로드가 분류를 정하지 못했을 때 넣는 자리다. 이름이 바뀌면
  // 그 자리를 가리키는 코드가 조용히 어긋난다.
  const { fns } = build({ 'categories/k1': def('확인필요', '지출', MY) });
  await assert.rejects(
    () => fns.saveCategory({
      ...as('담당자'), data: { type: '지출', clientId: MY, from: '확인필요', to: '미분류' } }),
    (e) => e.code === 'failed-precondition');
  // 색상은 바꿀 수 있다.
  const out = await fns.saveCategory({
    ...as('담당자'),
    data: { type: '지출', clientId: MY, from: '확인필요', to: '확인필요', color: '#123456' },
  });
  assert.equal(out.transactions, 0);
});

test('빈 이름·긴 이름·없는 분류를 거절한다', async () => {
  const { fns } = build({ 'categories/k1': def('식비', '지출', MY) });
  const bad = async (data, code) => assert.rejects(
    () => fns.saveCategory({ ...as('담당자'), data: { type: '지출', clientId: MY, ...data } }),
    (e) => e.code === code, JSON.stringify(data));
  await bad({ from: '식비', to: '   ' }, 'invalid-argument');
  await bad({ from: '식비', to: '가'.repeat(21) }, 'invalid-argument');
  await bad({ from: '없는분류', to: 'x' }, 'not-found');
  await bad({ from: '식비', to: 'x', type: '이상한' }, 'invalid-argument');
});
