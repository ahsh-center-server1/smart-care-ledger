import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/state.js';
import { getSetupState } from '../public/modules/setup.js';


/** 역할·데이터를 세팅하고 단계 상태를 계산한다 */
function stateAs(role, { categories = [], clients = [], accounts = [], isAdmin = false } = {}) {
  S.user = { userId: 'tester', name: '테스터', role, isAdmin };
  S.authz = { uid: 'tester', role, isAdmin, enabled: true };
  S.authzStatus = 'ready';
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

test.afterEach(() => { S.user = null; S.authz = null; S.authzStatus = 'idle'; S.permOverride = null; });

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

test('담당자는 어느 개설 단계도 진행할 수 없다', () => {
  const { steps } = stateAs('담당자');
  // 기본 분류는 clientId 가 없는 **공통 분류**라 settings.category.common 이
  // 필요하다. 담당자가 가진 settings.category(입주자 전용)로는 못 만든다 —
  // 예전에는 여기서 settings.category 를 보고 버튼을 띄운 뒤 규칙이 거부했다.
  assert.equal(steps.find(s => s.key === 'categories').can, false);
  assert.equal(steps.find(s => s.key === 'clients').can, false);
  assert.equal(steps.find(s => s.key === 'accounts').can, false);
});

// ─────────────────────────────────────────────
// 부팅 — 이것이 깨지면 새 배포가 기동되지 않는다
//
// 한때 세 단계가 전부 막혀 있었다. 첫 관리자(signup 이 만드는 센터장+관리자)가
// 분류도 입주자도 계좌도 만들 수 없어, 빈 DB 에서 아무도 시작할 수 없었다.
// 권한 하나만 다시 닫혀도 같은 상태로 돌아가므로 역할별로 못 박아 둔다.
// ─────────────────────────────────────────────
test('첫 관리자(센터장+관리자)가 빈 배포를 끝까지 진행할 수 있다', () => {
  const { steps, complete } = stateAs('센터장', { isAdmin: true });
  assert.equal(complete, false, '빈 DB 인데 완료로 보입니다');
  const blocked = steps.filter(s => !s.can).map(s => s.key);
  assert.deepEqual(
    blocked, [],
    `첫 관리자가 진행할 수 없는 단계가 있습니다: ${blocked.join(', ')}\n`
    + '이 상태로 배포하면 빈 DB 에서 아무도 시스템을 열 수 없습니다.',
  );
});

test('팀장도 시설 개설 단계를 끝까지 진행할 수 있다', () => {
  const { steps } = stateAs('팀장');
  assert.deepEqual(steps.map(s => s.can), [true, true, true]);
});

test('입력자는 어떤 단계도 진행할 수 없다', () => {
  const { steps } = stateAs('입력자');
  assert.ok(steps.every(s => !s.can), '입력자가 진행 가능한 단계가 있습니다');
});

test('관리자 플래그는 업무 설정 단계를 열지 않는다', () => {
  const { steps } = stateAs('입력자', { isAdmin: true });
  assert.ok(steps.every(s => !s.can), '관리자가 업무 권한을 상속했습니다');
});

test('본인 담당 입주자가 없어도 조직에 입주자가 있으면 설정은 완료로 본다', () => {
  // 담당자에게 배정된 입주자가 없는 상황 — 설정 문제가 아니라 배정 문제이므로
  // 마법사가 아니라 "담당 배정을 요청하세요" 안내가 나가야 한다.
  S.user = { userId: 'tester', role: '담당자', isAdmin: false };
  S.authz = { uid: 'tester', role: '담당자', isAdmin: false, enabled: true };
  S.authzStatus = 'ready';
  S.categories = [cat];
  S.allClients = [client];   // 조직에는 있음
  S.clients = [];            // 본인 담당은 없음
  S.allAccounts = [account];
  S.accounts = [];
  assert.equal(getSetupState().complete, true);
});

test('로그인하지 않은 상태에서도 예외 없이 계산된다', () => {
  S.user = null; S.permOverride = null;
  S.categories = []; S.allClients = []; S.clients = [];
  S.allAccounts = []; S.accounts = [];
  const { complete, steps } = getSetupState();
  assert.equal(complete, false);
  assert.ok(steps.every(s => !s.can), '비로그인 상태에서 권한이 열려 있습니다');
});
