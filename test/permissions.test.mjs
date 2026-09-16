import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { S } from '../public/state.js';
import {
  can, myRank, roleCan, requiredRank, isConfigurable, savePermissions,
  ROLE_RANK, ROLES, DEFAULT_MIN_RANK, PERM_SECTIONS,
} from '../public/modules/permissions.js';
import { FIXED_POLICY_KEYS } from '../public/domain/fixed-role-policy.js';

function as(role, isAdmin = false) {
  S.user = { userId: 'u', role, isAdmin };
  S.authz = { uid: 'u', role, isAdmin, enabled: true };
  S.authzStatus = 'ready';
}

test.afterEach(() => {
  Object.assign(S, { user: null, authz: null, authzStatus: 'idle', caps: null,
    permOverride: null, accessibleClientIds: [], leaderClientIds: [] });
});

test('업무 역할 순서는 표시용이고 권한 상속을 뜻하지 않는다', () => {
  assert.deepEqual(ROLES, ['입력자', '담당자', '팀장', '센터장']);
  assert.ok(ROLE_RANK.입력자 < ROLE_RANK.담당자);
  assert.ok(ROLE_RANK.담당자 < ROLE_RANK.팀장);
  assert.ok(ROLE_RANK.팀장 < ROLE_RANK.센터장);
  assert.equal(roleCan('담당자', 'trx.create'), true);
  assert.equal(roleCan('팀장', 'trx.create'), false);
});

test('입력자는 본인 업무만, 담당자는 담당 장부 업무를 수행한다', () => {
  as('입력자');
  assert.equal(can('trx.create'), true);
  assert.equal(can('trx.edit'), true);
  assert.equal(can('receipt.attachOwn'), true);
  for (const key of ['trx.delete', 'trx.view.all', 'report.submit', 'settings.client']) {
    assert.equal(can(key), false, `입력자에게 ${key}가 열렸습니다`);
  }
  as('담당자');
  for (const key of ['trx.create', 'trx.view.all', 'excel.upload', 'report.submit']) {
    assert.equal(can(key), true, `담당자에게 ${key}가 닫혔습니다`);
  }
  assert.equal(can('report.approve.team'), false);
});

test('팀장과 센터장은 검토 권한만 받고 입력 권한을 상속하지 않는다', () => {
  as('팀장');
  assert.equal(can('report.approve.team'), true);
  assert.equal(can('assignments.manage'), true);
  assert.equal(can('trx.create'), false);
  assert.equal(can('settings.account'), false);
  as('센터장');
  assert.equal(can('report.approve.center'), true);
  assert.equal(can('settings.archive'), true);
  assert.equal(can('trx.create'), false);
  assert.equal(can('report.approve.team'), false);
});

test('시스템 관리자 자격은 기술 권한만 더한다', () => {
  as('', true);
  assert.equal(myRank(), 0);
  assert.equal(can('system.audit'), true);
  assert.equal(can('system.ai'), true);
  assert.equal(can('trx.create'), false);
  assert.equal(can('report.approve.center'), false);
  as('입력자', true);
  assert.equal(can('system.backup'), true);
  assert.equal(can('receipt.attachOwn'), true);
  assert.equal(can('trx.view.all'), false);
});

test('현재 authz만 신뢰하고 나머지는 실패 폐쇄한다', () => {
  S.user = { userId: 'u', role: '센터장', isAdmin: true };
  S.caps = { reportApproveCenter: true };
  assert.equal(can('report.approve.center'), false);
  S.authzStatus = 'ready';
  S.authz = { uid: '다른-사용자', role: '센터장', isAdmin: true, enabled: true };
  assert.equal(can('report.approve.center'), false);
  S.authz = { uid: 'u', role: '알수없는역할', isAdmin: true, enabled: true };
  assert.equal(can('system.audit'), false);
  S.authz = { uid: 'u', role: '센터장', isAdmin: false, enabled: false };
  assert.equal(can('report.approve.center'), false);
});

test('과거 권한표와 caps는 권한을 바꾸지 못한다', () => {
  as('입력자');
  S.permOverride = { 'report.approve.center': 1, 'receipt.upload': 99 };
  S.caps = { reportApproveCenter: true, receiptUpload: false };
  assert.equal(can('report.approve.center'), false);
  assert.equal(can('receipt.upload'), true);
  assert.equal(isConfigurable('receipt.upload'), false);
});

test('폐기된 권한표 저장은 네트워크 호출 전에 거부한다', async () => {
  as('센터장', true);
  await assert.rejects(savePermissions({ 'trx.create': 4 }), /저장할 수 없습니다/);
});

test('알 수 없는 키는 거부하고 기존 키에는 표시 호환값이 있다', () => {
  as('센터장');
  assert.equal(can('trx.nonexistent'), false);
  assert.equal(requiredRank('trx.nonexistent'), null);
  for (const key of Object.keys(DEFAULT_MIN_RANK)) assert.notEqual(requiredRank(key), null, key);
});

test('역할 안내 목록은 모든 고정 정책 키를 설명한다', () => {
  const shown = new Set(PERM_SECTIONS.flatMap(section => Object.keys(section.keys)));
  for (const key of FIXED_POLICY_KEYS) assert.ok(shown.has(key), `${key}가 안내에 없습니다`);
});

test('코드에서 호출하는 모든 can 키는 고정 정책에 등록되어 있다', () => {
  const used = new Set();
  for (const dir of ['../public/modules', '../public/services', '../public']) {
    const base = new URL(`${dir}/`, import.meta.url);
    for (const file of readdirSync(base)) {
      if (!file.endsWith('.js')) continue;
      const src = readFileSync(new URL(file, base), 'utf8');
      for (const match of src.matchAll(/\bcan\('([a-z][a-z.]*)'\)/g)) used.add(match[1]);
    }
  }
  assert.ok(used.size > 10);
  for (const key of used) assert.ok(FIXED_POLICY_KEYS.includes(key), `${key}가 고정 정책에 없습니다`);
});
