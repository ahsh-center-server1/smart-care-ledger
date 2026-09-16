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
  // 장부에 직접 쓰는 권한은 검토 역할에 없다 — 이것이 이 테스트의 요점이다.
  for (const key of ['trx.create', 'trx.edit', 'trx.transfer', 'report.submit']) {
    assert.equal(can(key), false, `팀장이 입력 권한 ${key}를 상속했습니다`);
  }
  as('센터장');
  assert.equal(can('report.approve.center'), true);
  assert.equal(can('settings.archive'), true);
  assert.equal(can('trx.create'), false);
  assert.equal(can('report.approve.team'), false);
});

test('시설 개설·운영 권한은 검토 역할에 있고 그 아래에는 없다', () => {
  // settings.client · settings.account · settings.category.common 은 입력 권한이
  // 아니라 **시설을 열고 유지하는 관리 권한**이다. 한때 아무에게도 없었고,
  // 그래서 빈 DB 에 첫 관리자가 들어가면 분류·입주자·계좌를 하나도 만들 수 없어
  // 시스템이 기동되지 않았다(부팅 회귀 테스트는 test/setup.test.mjs).
  const OPS = ['settings.client', 'settings.account', 'settings.category.common'];
  for (const role of ['팀장', '센터장']) {
    as(role);
    for (const key of OPS) assert.equal(can(key), true, `${role}에게 ${key}가 닫혔습니다`);
  }
  // 담당자 이하로는 내려가지 않는다. 공통 분류는 전 입주자에게 영향을 주고,
  // 계좌의 기초잔액은 그 사람 장부 전체의 출발점이다.
  for (const role of ['담당자', '입력자']) {
    as(role);
    for (const key of OPS) assert.equal(can(key), false, `${role}이 ${key}를 얻었습니다`);
  }
  // 관리자 자격만으로는 열리지 않는다 — 기술 권한과 업무 권한은 직교한다.
  as('', true);
  for (const key of OPS) assert.equal(can(key), false, `관리자 자격이 ${key}를 열었습니다`);
});

test('통제 우회 권한은 여전히 아무에게도 없다', () => {
  // 절차가 없어서가 아니라 그 자체가 위험해서 닫혀 있다. 되살리려면 이 정책의
  // 전제를 바꿔야 하고, 그때까지 이 목록은 비어 있어야 한다.
  // (삭제 권한은 「제출 전에만」 절차가 생겨 담당자에게 열렸다 — 아래 테스트.)
  const FORBIDDEN = ['lock.bypass', 'settings.permissions', 'settings.reset',
    'report.release'];
  for (const role of ['입력자', '담당자', '팀장', '센터장']) {
    as(role);
    for (const key of FORBIDDEN) assert.equal(can(key), false, `${role}이 ${key}를 얻었습니다`);
    as(role, true);
    for (const key of FORBIDDEN) assert.equal(can(key), false, `${role}+관리자가 ${key}를 얻었습니다`);
  }
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

test('닫힌 기능의 안내 문구가 "권한 없음"과 구별된다', async () => {
  const { unavailableMessage } = await import('../public/modules/permissions.js');

  // 영구 금지 — "언젠가 열린다"고 읽히면 안 된다.
  const forbidden = unavailableMessage('settings.reset');
  assert.match(forbidden, /제공되지 않는/);
  assert.doesNotMatch(forbidden, /아직|권한이 없습니다/);

  // 등급·범위 문제는 그대로 "권한이 없습니다" — 이쪽은 요청하면 열린다.
  // 삭제도 이제 여기에 속한다: 담당자에게는 있고, 막는 것은 권한이 아니라
  // 제출 상태다.
  assert.match(unavailableMessage('settings.account'), /권한이 없습니다/);
  assert.match(unavailableMessage('trx.delete'), /권한이 없습니다/);

  // 이름을 사람이 읽을 수 있어야 한다(키를 그대로 노출하지 않는다).
  assert.match(unavailableMessage('trx.delete.bulk'), /일괄 삭제/);
});

test('닫힌 기능 문구가 상급자에게 요청하라고 말하지 않는다', async () => {
  const { unavailableMessage, FORBIDDEN_KEYS, PENDING_PROCEDURE_KEYS }
    = await import('../public/modules/permissions.js');
  // 아무도 못 하는 일을 "관리자에게 문의"로 안내하면 서로 시간만 쓴다.
  for (const key of [...FORBIDDEN_KEYS, ...PENDING_PROCEDURE_KEYS]) {
    const msg = unavailableMessage(key);
    assert.doesNotMatch(msg, /관리자에게|팀장에게|문의/, `${key}: ${msg}`);
  }
});
