// test/action-items.test.mjs
//
// 「지금 손봐야 할 것」 판정.
//
// 이 진단이 존재하는 이유는 앱이 잘못된 상태를 조용히 견디기 때문이다.
// 그래서 **놓치는 것(거짓 음성)이 가장 나쁘다** — 문제가 있는데 개요가 조용하면
// 진단 화면이 없는 것보다 나쁘다(있다고 믿게 되므로).
// 아래 테스트는 각 조건이 실제로 잡히는지, 그리고 정상 상태에서 헛경보를
// 내지 않는지 양쪽을 고정한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeActionItems, splitIds } from '../public/domain/action-items.js';

/** 아무 문제 없는 상태 */
function healthy(over = {}) {
  return {
    users: [
      { id: 'center', name: '김센터', approved: true, active: true },
      { id: 'staff', name: '이담당', approved: true, active: true },
    ],
    clients: [
      { id: 'c1', name: '홍길동', active: true, userIds: 'staff', teamLeader: 'leader' },
    ],
    accounts: [
      { id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '2026-01-01' },
    ],
    fixedItems: [{ id: 'f1', clientId: 'c1', accountId: 'a1', isMandatory: true }],
    fixedGap: { c1: { mandatory: 0, optional: 0 } },
    reportList: null,
    can: () => true,
    ...over,
  };
}

const ids = (items) => items.map(i => i.id);

test('정상 상태에서는 아무것도 내지 않는다 — 헛경보가 없어야 신뢰된다', () => {
  assert.deepEqual(computeActionItems(healthy()), []);
});

test('승인 대기 직원을 잡는다', () => {
  const items = computeActionItems(healthy({
    users: [
      { id: 'a', approved: true },
      { id: 'b', approved: false },
      { id: 'c', approved: false },
    ],
  }));
  const it = items.find(i => i.id === 'pendingStaff');
  assert.ok(it, '승인 대기를 잡지 못했다');
  assert.equal(it.count, 2);
  assert.equal(it.tab, 'list');
});

test('담당자 미배정 입주자를 잡는다 — 담당자 화면에 아예 안 나오는 상태', () => {
  const items = computeActionItems(healthy({
    clients: [
      { id: 'c1', active: true, userIds: 'staff', teamLeader: 'leader' },
      { id: 'c2', active: true, userIds: '',      teamLeader: 'leader' },
      { id: 'c3', active: true, userIds: '  ,  ', teamLeader: 'leader' },   // 공백만
      { id: 'c4', active: true,                   teamLeader: 'leader' },   // 필드 없음
    ],
    accounts: [
      { id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a2', clientId: 'c2', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a3', clientId: 'c3', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a4', clientId: 'c4', active: true, initialBalanceDate: '2026-01-01' },
    ],
  }));
  assert.equal(items.find(i => i.id === 'noOwner').count, 3);
});

test('팀장 미지정 입주자를 잡는다 — 1차 결재자가 없어 결재가 멈춘다', () => {
  const items = computeActionItems(healthy({
    clients: [
      { id: 'c1', active: true, userIds: 's', teamLeader: 'leader' },
      { id: 'c2', active: true, userIds: 's', teamLeader: '' },
      { id: 'c3', active: true, userIds: 's' },
    ],
    accounts: [
      { id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a2', clientId: 'c2', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a3', clientId: 'c3', active: true, initialBalanceDate: '2026-01-01' },
    ],
  }));
  assert.equal(items.find(i => i.id === 'noLeader').count, 2);
});

test('기준일 없는 계좌를 잡는다 — 잔액이 전 기간 합산이 되어 통장과 어긋난다', () => {
  const items = computeActionItems(healthy({
    accounts: [
      { id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a2', clientId: 'c1', active: true, initialBalanceDate: '' },
      { id: 'a3', clientId: 'c1', active: true },
    ],
  }));
  assert.equal(items.find(i => i.id === 'noBaseDate').count, 2);
});

test('계좌 없는 입주자를 잡는다 — 거래를 넣을 곳이 없다', () => {
  const items = computeActionItems(healthy({
    clients: [
      { id: 'c1', active: true, userIds: 's', teamLeader: 'l' },
      { id: 'c2', active: true, userIds: 's', teamLeader: 'l' },
    ],
    accounts: [{ id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '2026-01-01' }],
  }));
  assert.equal(items.find(i => i.id === 'noAccount').count, 1);
});

test('비활성 계좌는 "계좌 있음"으로 세지 않는다', () => {
  const items = computeActionItems(healthy({
    accounts: [{ id: 'a1', clientId: 'c1', active: false, initialBalanceDate: '2026-01-01' }],
  }));
  assert.equal(items.find(i => i.id === 'noAccount').count, 1);
});

test('퇴소한 입주자는 진단 대상이 아니다 — 정리된 상태를 문제로 보면 목록이 쓸모없어진다', () => {
  const items = computeActionItems(healthy({
    clients: [
      { id: 'c1', active: true, userIds: 's', teamLeader: 'l' },
      { id: 'cOld', active: false, userIds: '', teamLeader: '' },   // 퇴소
    ],
  }));
  assert.equal(items.find(i => i.id === 'noOwner'), undefined);
  assert.equal(items.find(i => i.id === 'noLeader'), undefined);
  assert.equal(items.find(i => i.id === 'noAccount'), undefined);
});

test('퇴소한 입주자에 남은 활성 계좌는 참고 항목으로 낸다', () => {
  const items = computeActionItems(healthy({
    clients: [{ id: 'c1', active: true, userIds: 's', teamLeader: 'l' }],
    accounts: [
      { id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a2', clientId: 'cGone', active: true, initialBalanceDate: '2026-01-01' },
    ],
  }));
  const it = items.find(i => i.id === 'orphanAccount');
  assert.equal(it.count, 1);
  assert.equal(it.severity, 'info');
});

test('당월 필수 고정항목 미납을 합산한다', () => {
  const items = computeActionItems(healthy({
    clients: [
      { id: 'c1', active: true, userIds: 's', teamLeader: 'l' },
      { id: 'c2', active: true, userIds: 's', teamLeader: 'l' },
    ],
    accounts: [
      { id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a2', clientId: 'c2', active: true, initialBalanceDate: '2026-01-01' },
    ],
    fixedGap: { c1: { mandatory: 2 }, c2: { mandatory: 3 }, cGone: { mandatory: 99 } },   // 퇴소자 건은 제외
  }));
  assert.equal(items.find(i => i.id === 'unpaidFixed').count, 5);
});

test('계좌가 삭제된 고정항목을 잡는다 — 「고정항목 입력」이 그 건만 조용히 실패한다', () => {
  const items = computeActionItems(healthy({
    fixedItems: [
      { id: 'f1', clientId: 'c1', accountId: 'a1' },
      { id: 'f2', clientId: 'c1', accountId: 'deleted' },
      { id: 'f3', clientId: 'c1' },                    // 계좌 미지정은 다른 문제
    ],
  }));
  assert.equal(items.find(i => i.id === 'brokenFixed').count, 1);
});

test('보고서 목록을 아직 안 읽었으면(null) 보고서 항목을 내지 않는다', () => {
  // 이 진단 때문에 새로 조회하지 않는다는 것이 설계 전제다.
  const items = computeActionItems(healthy({ reportList: null }));
  assert.equal(items.find(i => i.id === 'pendingApproval'), undefined);
  assert.equal(items.find(i => i.id === 'rejected'), undefined);
});

test('보고서 목록이 있으면 결재 대기·반려를 낸다', () => {
  const items = computeActionItems(healthy({
    reportList: [
      { status: 'submitted' }, { status: 'team_approved' },
      { status: 'rejected' }, { status: 'confirmed' }, { status: 'draft' },
    ],
  }));
  assert.equal(items.find(i => i.id === 'pendingApproval').count, 2);
  assert.equal(items.find(i => i.id === 'rejected').count, 1);
});

test('권한이 없는 항목은 내지 않는다 — 갈 수 없는 곳으로 보내지 않게', () => {
  const items = computeActionItems(healthy({
    users: [{ id: 'b', approved: false }],
    clients: [{ id: 'c1', active: true, userIds: '', teamLeader: '' }],
    accounts: [{ id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '' }],
    fixedGap: { c1: { mandatory: 3 } },
    can: (key) => key === 'settings.fixed',    // 고정항목 권한만 있다
  }));
  assert.deepEqual(ids(items).sort(), ['unpaidFixed']);
});

test('심각한 항목(warn)이 참고 항목(info)보다 먼저 온다', () => {
  const items = computeActionItems(healthy({
    users: [{ id: 'b', approved: false }],
    accounts: [
      { id: 'a1', clientId: 'c1', active: true, initialBalanceDate: '2026-01-01' },
      { id: 'a2', clientId: 'cGone', active: true, initialBalanceDate: '2026-01-01' },
    ],
  }));
  const firstInfo = items.findIndex(i => i.severity === 'info');
  const lastWarn = items.map(i => i.severity).lastIndexOf('warn');
  assert.ok(firstInfo === -1 || lastWarn < firstInfo, '정렬이 심각도 순이 아니다');
});

test('빈 입력·누락 입력에도 깨지지 않는다', () => {
  assert.deepEqual(computeActionItems({}), []);
  assert.deepEqual(computeActionItems(null), []);
  assert.deepEqual(computeActionItems(undefined), []);
});

test('splitIds — 쉼표 구분, 공백 제거, 빈 값 제외', () => {
  assert.deepEqual(splitIds('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitIds(' a , b '), ['a', 'b']);
  assert.deepEqual(splitIds('a,,b'), ['a', 'b']);
  assert.deepEqual(splitIds(''), []);
  assert.deepEqual(splitIds(null), []);
  assert.deepEqual(splitIds(undefined), []);
  assert.deepEqual(splitIds(',,,'), []);
});
