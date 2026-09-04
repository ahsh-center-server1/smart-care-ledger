import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/state.js';
import { getSetupState } from '../public/modules/setup.js';
import { DEFAULT_PERMISSIONS } from '../public/modules/permissions.js';

/** 역할·데이터를 세팅하고 단계 상태를 계산한다 */
function stateAs(role, { categories = [], clients = [], accounts = [], isAdmin = false } = {}) {
  S.user = { userId: 'tester', name: '테스터', role, isAdmin };
  S.permissions = DEFAULT_PERMISSIONS;
  S.categories = categories;
  S.allClients = clients;
  S.clients = clients;
  S.allAccounts = accounts;
  S.accounts = accounts;
  return getSetupState();
}

const cat = { keyword: '', type: '지출', category: '식비' };
const client = { id: 'c1', name: '입주자 A' };
const account = { id: 'a1', clientId: 'c1', label: '통장' };

test.afterEach(() => { S.user = null; S.permissions = null; });

test('빈 배포 — 세 단계 모두 미완료', () => {
  const { steps, done, total, complete } = stateAs('센터장');
  assert.equal(total, 3);
  assert.equal(done, 0);
  assert.equal(complete, false);
  assert.deepEqual(steps.map(s => s.key), ['categories', 'clients', 'accounts']);
  assert.ok(steps.every(s => !s.done));
});

test('데이터가 채워지면 해당 단계가 완료된다', () => {
  const { done, complete } = stateAs('센터장', {
    categories: [cat], clients: [client], accounts: [account],
  });
  assert.equal(done, 3);
  assert.equal(complete, true);
});

test('부분 완료 — 카테고리만 있으면 1/3', () => {
  const { done, steps } = stateAs('센터장', { categories: [cat] });
  assert.equal(done, 1);
  assert.equal(steps.find(s => s.key === 'categories').done, true);
  assert.equal(steps.find(s => s.key === 'clients').done, false);
});

test('계좌 단계는 입주자 단계에 막혀 있다', () => {
  const { steps } = stateAs('센터장', { categories: [cat] });
  assert.equal(steps.find(s => s.key === 'accounts').blockedBy, 'clients');
});

test('담당자는 분류는 만들 수 있지만 입주자·계좌는 등록할 수 없다', () => {
  const { steps } = stateAs('담당자');
  assert.equal(steps.find(s => s.key === 'categories').can, true);   // nav.settings
  assert.equal(steps.find(s => s.key === 'clients').can, false);     // settings.client
  assert.equal(steps.find(s => s.key === 'accounts').can, false);
});

test('팀장은 세 단계를 모두 진행할 수 있다', () => {
  const { steps } = stateAs('팀장');
  assert.ok(steps.every(s => s.can), '팀장이 진행할 수 없는 단계가 있습니다');
});

test('입력자는 어떤 단계도 진행할 수 없다', () => {
  const { steps } = stateAs('입력자');
  assert.ok(steps.every(s => !s.can), '입력자가 진행 가능한 단계가 있습니다');
});

test('관리자 플래그는 역할과 무관하게 모든 단계를 연다', () => {
  // 마이그레이션 후 관리자는 role='센터장' + isAdmin. 역할이 입력자여도
  // 플래그가 있으면 can()이 전부 통과해야 한다.
  const { steps } = stateAs('입력자', { isAdmin: true });
  assert.ok(steps.every(s => s.can), '관리자 플래그가 무시되고 있습니다');
});

test('본인 담당 입주자가 없어도 조직에 입주자가 있으면 설정은 완료로 본다', () => {
  // 담당자에게 배정된 입주자가 없는 상황 — 설정 문제가 아니라 배정 문제이므로
  // 마법사가 아니라 "담당 배정을 요청하세요" 안내가 나가야 한다.
  S.user = { userId: 'tester', role: '담당자', isAdmin: false };
  S.permissions = DEFAULT_PERMISSIONS;
  S.categories = [cat];
  S.allClients = [client];   // 조직에는 있음
  S.clients = [];            // 본인 담당은 없음
  S.allAccounts = [account];
  S.accounts = [];
  assert.equal(getSetupState().complete, true);
});

test('로그인하지 않은 상태에서도 예외 없이 계산된다', () => {
  S.user = null; S.permissions = null;
  S.categories = []; S.allClients = []; S.clients = [];
  S.allAccounts = []; S.accounts = [];
  const { complete, steps } = getSetupState();
  assert.equal(complete, false);
  assert.ok(steps.every(s => !s.can), '비로그인 상태에서 권한이 열려 있습니다');
});
