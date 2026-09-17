import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as policy from '../public/domain/fixed-role-policy.js';

const user = (role, extra = {}) => ({ role, enabled: true, ...extra });
const { fixedCan: can, fixedScopeFor: scope, computeFixedCaps, FIXED_POLICY_KEYS } = policy;

test('unknown, missing, and disabled principals fail closed', () => {
  for (const principal of [null, {}, user('unknown'), user('unknown', { isAdmin: true }),
    user('담당자', { enabled: false }), user('담당자', { enabled: undefined })]) {
    assert.ok(Object.values(computeFixedCaps(principal)).every(value => value === false));
  }
  for (const key of ['unknown', '__proto__', 'constructor', null]) {
    assert.equal(can(user('센터장', { isAdmin: true }), key), false);
  }
});

test('system admin is technical, not an inherited business role', () => {
  const admin = user(null, { isAdmin: true });
  assert.equal(can(admin, 'settings.staff'), true);
  assert.equal(can(admin, 'system.audit'), true);
  for (const key of ['trx.view.all', 'trx.create', 'report.approve.center', 'audit.view']) {
    assert.equal(can(admin, key), false);
    assert.equal(scope(admin, key), 'none');
  }
  const staffAdmin = user('담당자', { isAdmin: true });
  assert.equal(can(staffAdmin, 'trx.create'), true);
  assert.equal(can(staffAdmin, 'settings.staff'), true);
  assert.equal(can(staffAdmin, 'report.approve.center'), false);
  assert.equal(scope(staffAdmin, 'trx.create'), 'assignedClient');
});

test('review roles do not inherit transaction input or report authorship', () => {
  for (const role of ['팀장', '센터장']) {
    for (const key of ['trx.create', 'trx.edit', 'trx.transfer', 'receipt.replace', 'report.submit']) {
      assert.equal(can(user(role), key), false);
    }
  }
  assert.equal(can(user('팀장'), 'report.approve.team'), true);
  assert.equal(can(user('팀장'), 'report.approve.center'), false);
  assert.equal(can(user('센터장'), 'report.approve.center'), true);
  assert.equal(can(user('센터장'), 'report.approve.team'), false);
  assert.equal(scope(user('팀장'), 'trx.view.all'), 'assignedClient');
  assert.equal(scope(user('센터장'), 'trx.view.all'), 'allClients');
});

test('inputter requires downstream ownership while staff has assigned workflow grants', () => {
  assert.equal(can(user('입력자'), 'trx.edit'), true);
  assert.equal(can(user('입력자'), 'trx.view.all'), false);
  assert.equal(can(user('입력자'), 'receipt.attachAny'), false);
  assert.equal(scope(user('입력자'), 'trx.edit'), 'assignedClient');
  assert.equal(can(user('담당자'), 'report.submit'), true);
  assert.equal(can(user('담당자'), 'report.approve.team'), false);
});

test('overrides cannot enable denied destructive or policy editing operations', () => {
  const principal = user('센터장', { isAdmin: true, minRank: { 'trx.create': 1 },
    caps: { trxCreate: true }, permOverride: { 'settings.permissions': 1 } });
  for (const key of ['trx.create', 'lock.bypass', 'settings.permissions', 'settings.reset',
    'trx.delete', 'trx.delete.bulk', 'report.delete']) assert.equal(can(principal, key), false);
  assert.equal(can(user('입력자'), 'report.approve.center', { 'report.approve.center': 1 }), false);
});

test('all existing catalogue keys have an explicit fixed-policy decision', () => {
  const require = createRequire(import.meta.url);
  const { catalog } = require('../functions/perm-catalog.data.json');
  assert.deepEqual(Object.keys(catalog).filter(key => !FIXED_POLICY_KEYS.includes(key)), []);
});

test('server artifact stays generated from the browser policy and behaves identically', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../tools/gen-fixed-role-policy.mjs', import.meta.url)), '--check']);
  const server = createRequire(import.meta.url)('../functions/fixed-role-policy.cjs');
  for (const role of [null, 'unknown', ...policy.FIXED_ROLES]) {
    for (const isAdmin of [false, true]) {
      for (const enabled of [false, true]) {
        const principal = user(role, { isAdmin, enabled });
        assert.deepEqual(server.computeFixedCaps(principal), computeFixedCaps(principal));
        for (const key of FIXED_POLICY_KEYS) {
          assert.equal(server.fixedScopeFor(principal, key), scope(principal, key));
        }
      }
    }
  }
});

// ─────────────────────────────────────────────
// 닫힌 권한의 분류
//
// 한때 "절차가 없어서 잠시 닫은 것"과 "설계상 영원히 없는 것"이 한 배열에
// 섞여 있었고, 그래서 전자가 후자처럼 굳어 빈 배포가 기동되지 않았다.
// 분류가 비면 같은 일이 반복되므로, 닫힌 키는 반드시 한쪽에 속해야 한다.
// ─────────────────────────────────────────────
test('닫힌 권한은 빠짐없이 한 부류로 분류된다', () => {
  const principals = [
    ...policy.FIXED_ROLES.flatMap(role => [
      user(role), user(role, { isAdmin: true }),
    ]),
    user(null, { isAdmin: true }),
  ];
  const closed = FIXED_POLICY_KEYS.filter(
    key => !principals.some(principal => can(principal, key)),
  );

  const classified = [...policy.FORBIDDEN_KEYS, ...policy.PENDING_PROCEDURE_KEYS];
  assert.deepEqual(
    closed.filter(k => !classified.includes(k)), [],
    '아무도 못 가지는데 분류되지 않은 권한이 있습니다 — 화면이 이유를 말할 수 없습니다',
  );
  assert.deepEqual(
    classified.filter(k => !closed.includes(k)), [],
    '분류돼 있는데 실제로는 누군가 가질 수 있는 권한이 있습니다',
  );
  // 두 부류는 겹치지 않는다 — 겹치면 문구가 둘 중 무엇이 될지 알 수 없다.
  assert.deepEqual(
    policy.FORBIDDEN_KEYS.filter(k => policy.PENDING_PROCEDURE_KEYS.includes(k)), [],
  );
});

test('deniedReason 은 열린 권한에 null 을 준다', () => {
  for (const key of ['trx.create', 'settings.client', 'settings.account', 'report.submit']) {
    assert.equal(policy.deniedReason(key), null, `${key}는 열려 있어야 합니다`);
  }
  for (const key of policy.FORBIDDEN_KEYS) assert.equal(policy.deniedReason(key), 'forbidden');
  for (const key of policy.PENDING_PROCEDURE_KEYS) assert.equal(policy.deniedReason(key), 'pending');
  // 모르는 키는 분류하지 않는다.
  for (const key of ['unknown', '__proto__', null]) {
    assert.equal(policy.deniedReason(key), null);
  }
});

test('통제 우회는 영구 금지이고, 삭제는 절차가 생겨 열렸다', () => {
  for (const key of ['settings.permissions', 'settings.reset', 'lock.bypass', 'report.release']) {
    assert.equal(policy.deniedReason(key), 'forbidden', `${key}는 설계상 영구히 없습니다`);
  }
  // 삭제는 "제출 전에만"이라는 절차가 생겨 담당자에게 열렸다. 권한이 아니라
  // **상태**가 막으므로(제출 색인) deniedReason 은 null 이어야 한다 —
  // pending 으로 남아 있으면 화면이 "아직 제공되지 않습니다"라고 거짓말한다.
  for (const key of ['trx.delete', 'trx.delete.bulk', 'report.delete']) {
    assert.equal(policy.deniedReason(key), null, `${key}는 열려 있습니다`);
    assert.equal(can(user('담당자'), key), true, `${key}는 담당자가 가집니다`);
    // 검토 역할은 장부에 손대지 않는다 — 삭제도 마찬가지다.
    for (const role of ['팀장', '센터장']) {
      assert.equal(can(user(role), key), false, `${role}이 ${key}를 얻었습니다`);
    }
  }
});
