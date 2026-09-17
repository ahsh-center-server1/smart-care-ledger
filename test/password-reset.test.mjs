// test/password-reset.test.mjs
//
// 비밀번호 분실 처리.
//
// 이 파일이 지키는 것은 하나다 — **관리자 자격이 결재 권한으로 번지지 않는 것.**
//
// 관리자는 업무 권한과 직교한다(fixed-role-policy 의 전제). 그런데 남의
// 비밀번호를 발급할 수 있으면 잠시 센터장이 되어 결재할 수 있다. 그래서
// 결재에 닿는 계정(팀장·센터장·관리자)은 다른 관리자가 한 번 더 승인해야 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, FieldValue, FakeHttpsError, silentLogger } from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const passwordResetFns = require('../functions/password-reset-fns.js');

/** 결정적인 난수 — 테스트가 값을 예측할 수 있어야 한다. */
const fixedRandom = () => 0;

const Timestamp = {
  fromMillis: (ms) => ({ toMillis: () => ms, _ms: ms }),
};

function build(seed = {}, { now = Date.now() } = {}) {
  const db = makeDb({
    'users/admin1': { userId: 'admin1', name: '관리자1', role: '', isAdmin: true },
    'users/admin2': { userId: 'admin2', name: '관리자2', role: '', isAdmin: true },
    'users/staff': { userId: 'staff', name: '이담당', role: '담당자' },
    'users/typist': { userId: 'typist', name: '박입력', role: '입력자' },
    'users/leader': { userId: 'leader', name: '김팀장', role: '팀장' },
    'users/center': { userId: 'center', name: '최센터', role: '센터장' },
    ...seed,
  });
  const fns = passwordResetFns({
    db,
    callable: (_name, handler) => handler,
    requireCaller: async (auth) => {
      const snap = await db.doc(`users/${auth.uid}`).get();
      const d = snap.data() || {};
      return { uid: auth.uid, isAdmin: d.isAdmin === true };
    },
    HttpsError: FakeHttpsError,
    logger: silentLogger,
    FieldValue,
    Timestamp,
    // 평문을 담지 않는 가짜 해시. `hashed:\${pw}` 로 두면 "평문이 저장되지
    // 않는다"는 단언이 스텁 때문에 실패한다 — 검증 도구가 틀린 경우다.
    hashPassword: async (pw) => ({
      hash: 'h' + [...pw].reduce((a, c) => a + c.charCodeAt(0), 0), salt: 's',
    }),
    validUserId: (id) => /^[A-Za-z0-9_-]{2,40}$/.test(id),
    randomInt: fixedRandom,
    now,
  });
  return { db, fns };
}

const as = (uid) => ({ auth: { uid } });

// ── 누가 할 수 있는가 ────────────────────────────────────────

test('관리자가 아니면 시작할 수 없다', async () => {
  const { fns } = build();
  for (const who of ['staff', 'leader', 'center']) {
    await assert.rejects(
      () => fns.requestPasswordReset({ ...as(who), data: { userId: 'typist' } }),
      (e) => e.code === 'permission-denied', `${who} 가 통과했습니다`);
  }
});

test('본인 것은 이 통로로 바꾸지 않는다', async () => {
  // 임시 비밀번호가 필요 없는데도 계정이 잠시 잠긴다.
  const { fns } = build();
  await assert.rejects(
    () => fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'admin1' } }),
    (e) => e.code === 'failed-precondition');
});

test('퇴사 계정을 되살리는 통로가 되지 않는다', async () => {
  const { fns } = build({ 'users/gone': { userId: 'gone', role: '담당자', active: false } });
  await assert.rejects(
    () => fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'gone' } }),
    (e) => e.code === 'failed-precondition');
});

test('없는 직원·이상한 아이디를 거절한다', async () => {
  const { fns } = build();
  await assert.rejects(
    () => fns.requestPasswordReset({ ...as('admin1'), data: { userId: '없는사람' } }),
    (e) => e.code === 'invalid-argument' || e.code === 'not-found');
  await assert.rejects(
    () => fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'a b/c' } }),
    (e) => e.code === 'invalid-argument');
});

// ── 결재에 닿지 않는 계정 — 바로 발급 ────────────────────────

test('입력자·담당자는 관리자가 바로 발급한다', async () => {
  for (const who of ['typist', 'staff']) {
    const { db, fns } = build();
    const out = await fns.requestPasswordReset({ ...as('admin1'), data: { userId: who } });
    assert.ok(out.tempPassword, `${who} 에게 임시 비밀번호가 없습니다`);
    assert.equal(out.needsApproval, undefined);
    const secret = db.docs.get(`userSecrets/${who}`);
    assert.equal(secret.mustChangePassword, true, '강제 변경 표식이 없습니다');
    assert.ok(secret.hash && !secret.hash.includes(out.tempPassword), '평문이 저장됐습니다');
  }
});

test('임시 비밀번호는 응답에만 실리고 저장되지 않는다', async () => {
  const { db, fns } = build();
  const out = await fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'staff' } });
  const stored = JSON.stringify([...db.docs.values()]);
  assert.ok(!stored.includes(out.tempPassword),
    '임시 비밀번호가 평문으로 어딘가에 저장됐습니다');
});

test('발급하면 감사 기록이 남는다', async () => {
  const { db, fns } = build();
  await fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'staff' } });
  const logs = [...db.docs.entries()].filter(([k]) => k.startsWith('auditLogs/'));
  assert.equal(logs.length, 1, '감사 기록이 없습니다 — 유일한 억제 장치다');
  assert.equal(logs[0][1].action, 'staff.passwordReset');
  assert.equal(logs[0][1].actorUid, 'admin1');
});

// ── 결재에 닿는 계정 — 2인 ──────────────────────────────────

test('팀장·센터장·관리자는 바로 발급되지 않는다', async () => {
  for (const who of ['leader', 'center', 'admin2']) {
    const { db, fns } = build();
    const out = await fns.requestPasswordReset({ ...as('admin1'), data: { userId: who } });
    assert.equal(out.needsApproval, true, `${who} 가 단독으로 발급됐습니다`);
    assert.equal(out.tempPassword, undefined);
    assert.equal(db.docs.has(`userSecrets/${who}`), false, '비밀번호가 이미 바뀌었습니다');
    assert.ok(db.docs.get(`passwordResets/${who}`), '대기 요청이 남지 않았습니다');
  }
});

test('요청한 사람이 스스로 승인할 수 없다 — 같으면 2인이 아니다', async () => {
  const { fns } = build();
  await fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'center' } });
  await assert.rejects(
    () => fns.approvePasswordReset({ ...as('admin1'), data: { userId: 'center' } }),
    (e) => e.code === 'permission-denied');
});

test('다른 관리자가 승인하면 발급된다', async () => {
  const { db, fns } = build();
  await fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'center' } });
  const out = await fns.approvePasswordReset({ ...as('admin2'), data: { userId: 'center' } });
  assert.ok(out.tempPassword);
  assert.equal(db.docs.get('userSecrets/center').mustChangePassword, true);
  // 승인 기록에 두 사람이 모두 남는다.
  const log = [...db.docs.values()].find(d => d.action === 'staff.passwordReset');
  assert.equal(log.actorUid, 'admin2');
  assert.equal(log.summary.승인자, 'admin1');
});

test('승인은 한 번만 쓰인다 — 대기 요청을 소비한다', async () => {
  // 남겨 두면 한 번의 승인으로 여러 번 발급된다.
  const { db, fns } = build();
  await fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'center' } });
  await fns.approvePasswordReset({ ...as('admin2'), data: { userId: 'center' } });
  assert.equal(db.docs.has('passwordResets/center'), false);
  await assert.rejects(
    () => fns.approvePasswordReset({ ...as('admin2'), data: { userId: 'center' } }),
    (e) => e.code === 'not-found');
});

test('대기 요청이 없으면 승인할 수 없다', async () => {
  const { fns } = build();
  await assert.rejects(
    () => fns.approvePasswordReset({ ...as('admin2'), data: { userId: 'center' } }),
    (e) => e.code === 'not-found');
});

test('만료된 요청은 승인되지 않는다', async () => {
  const { db, fns } = build();
  await fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'center' } });
  const req = db.docs.get('passwordResets/center');
  req.expiresAt = { toMillis: () => Date.now() - 1 };
  await assert.rejects(
    () => fns.approvePasswordReset({ ...as('admin2'), data: { userId: 'center' } }),
    (e) => e.code === 'deadline-exceeded');
});

test('승인도 관리자만 한다', async () => {
  const { fns } = build();
  await fns.requestPasswordReset({ ...as('admin1'), data: { userId: 'center' } });
  await assert.rejects(
    () => fns.approvePasswordReset({ ...as('center'), data: { userId: 'center' } }),
    (e) => e.code === 'permission-denied');
});

// ── 임시 비밀번호의 성질 ────────────────────────────────────

test('임시 비밀번호에 헷갈리는 글자가 없다', async () => {
  // 종이에 적어 건네는 값이다. 0/O, 1/l/I 가 섞이면 전화로 불러 줄 수 없다.
  const { __test } = passwordResetFns({
    db: makeDb({}), callable: (_n, h) => h, requireCaller: async () => ({}),
    HttpsError: FakeHttpsError, logger: silentLogger, FieldValue, Timestamp,
    hashPassword: async () => ({}), validUserId: () => true,
    randomInt: (n) => Math.floor(Math.random() * n),
  });
  for (let i = 0; i < 50; i += 1) {
    const pw = __test.makeTempPassword((n) => Math.floor(Math.random() * n));
    assert.ok(!/[0O1lI]/.test(pw), `헷갈리는 글자가 있습니다: ${pw}`);
    assert.match(pw, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  }
});

test('2인이 필요한 자리를 역할로 판정한다', async () => {
  const { __test } = passwordResetFns({
    db: makeDb({}), callable: (_n, h) => h, requireCaller: async () => ({}),
    HttpsError: FakeHttpsError, logger: silentLogger, FieldValue, Timestamp,
    hashPassword: async () => ({}), validUserId: () => true, randomInt: fixedRandom,
  });
  assert.equal(__test.needsTwoPeople({ role: '팀장' }), true);
  assert.equal(__test.needsTwoPeople({ role: '센터장' }), true);
  assert.equal(__test.needsTwoPeople({ role: '', isAdmin: true }), true);
  assert.equal(__test.needsTwoPeople({ role: '담당자' }), false);
  assert.equal(__test.needsTwoPeople({ role: '입력자' }), false);
  assert.equal(__test.needsTwoPeople({}), false);
});
