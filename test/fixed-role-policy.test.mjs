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
