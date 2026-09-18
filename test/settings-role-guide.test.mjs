import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/state.js';
import { renderPermissionPanel } from '../public/modules/settings-permissions.js';

function render(user, caps, ids = [], extra = {}) {
  const keys = ['user', 'caps', 'accessibleClientIds', 'leaderClientIds', 'authz', 'authzStatus'];
  const saved = Object.fromEntries(keys.map(key => [key, S[key]]));
  const doc = globalThis.document;
  const panel = { innerHTML: '' };
  try {
    Object.assign(S, { user, caps, accessibleClientIds: ids, leaderClientIds: [], authz: user ? { ...user, enabled: true } : null, authzStatus: caps === null ? 'loading' : 'ready' }, extra);
    globalThis.document = { getElementById: () => panel };
    renderPermissionPanel();
    return panel.innerHTML;
  } finally {
    Object.assign(S, saved);
    if (doc === undefined) delete globalThis.document;
    else globalThis.document = doc;
  }
}

test('역할 안내는 입력자도 읽을 수 있고 편집 제어를 만들지 않는다', () => {
  const html = render({ role: '입력자' }, { trxCreate: true }, ['a', 'a', 'b']);
  assert.match(html, /입력자/);
  // 라벨이 「현재 배정」이라 값에서 '배정'을 뺐다. 지키는 것은 **배정 수**다.
  assert.match(html, /입주자 2명/);
  assert.match(html, /본인 미제출/);
  assert.doesNotMatch(html, /<(?:button|select|input)\b|btn-perm-save|btn-perm-reset/);
});

test('업무 역할과 관리자 자격을 별개로 안내한다', () => {
  const html = render({ role: '입력자', isAdmin: true }, { trxCreate: true });
  // dl 에서 배지로 바꿨다. 지키는 것은 **둘이 따로 보인다**는 것이다.
  assert.match(html, /입력자/);
  assert.match(html, /시스템 관리자/);
  assert.match(html, /관리자 자격만으로는 .*금전 자료 수정이나 결재 권한이 생기지 않습니다/s);
  assert.doesNotMatch(html, /시설 전체 자료 검토와 최종 결재/);
});

test('미로그인·권한 미확인·빈 권한·비활성 상태를 안내한다', () => {
  assert.match(render(null, null), /정보를 확인하고 있습니다/);
  assert.match(render({ role: '담당자' }, null), /현재 접근 허용을 보장하지 않습니다/);
  assert.match(render({ role: '담당자' }, {}), /현재 허용된 업무가 없습니다/);
  assert.match(render({ role: '담당자', active: false }, {}), /비활성 계정/);
});

test('알 수 없는 역할을 권한으로 해석하거나 HTML로 삽입하지 않는다', () => {
  const html = render({ role: '<img src=x onerror=alert(1)>', isAdmin: true }, {});
  assert.match(html, /업무 역할 미지정/);
  assert.match(html, /업무 권한을 추정하지 않습니다/);
  assert.doesNotMatch(html, /<img|onerror/);
});

test('팀장과 센터장 범위를 구별한다', () => {
  const leader = render({ role: '팀장' }, { reportApproveTeam: true }, ['staff-only', 'leader-client'], { leaderClientIds: ['leader-client'] });
  assert.match(leader, /담당 팀장으로 지정된 입주자/);
  assert.match(leader, /입주자 1명/);
  assert.doesNotMatch(leader, /입주자 2명/);
  assert.match(render({ role: '센터장' }, { reportApproveCenter: true }), /시설 전체 입주자/);
});

test('기술 전용 관리자는 오류가 아니라 기술 업무만 안내한다', () => {
  const html = render({ role: '', isAdmin: true }, { systemAi: true }, ['old-client']);
  assert.match(html, /업무 역할 없음/);
  assert.match(html, /시스템 관리 업무만 가능/);
  assert.match(html, /AI 설정·백업·보안 감사/);
  assert.match(html, /다른 승인자가 없으면 보류/);
  assert.doesNotMatch(html, /알 수 없는 업무 역할|입주자 1명 배정|최종 결재/);
});

test('오래된 caps가 있어도 오류·로딩 상태에 접근 확인을 표시하지 않는다', () => {
  const error = render({ role: '담당자' }, { trxCreate: true }, ['a'], { authzStatus: 'error' });
  assert.match(error, /불러오지 못했습니다/);
  assert.match(error, /확인 대기/);
  assert.doesNotMatch(error, /서버 권한 정보를 확인했습니다|입주자 1명 배정/);
  assert.match(render({ role: '담당자' }, { trxCreate: true }, [], { authzStatus: 'loading' }), /현재 접근 허용을 보장하지 않습니다/);
});

test('확인된 authz 역할·활성 상태와 팀장 전용 배정을 우선한다', () => {
  const html = render({ role: '센터장', isAdmin: true }, { reportApproveTeam: true }, ['a', 'b'], {
    authz: { role: '팀장', isAdmin: false, enabled: true, leaderClientIds: ['b'] }, leaderClientIds: ['a', 'b'],
  });
  // dl 에서 배지로 바꿨다. 지키는 것은 **authz 의 역할이 이긴다**는 것이다.
  assert.match(html, /팀장/);
  assert.doesNotMatch(html, /센터장/);
  assert.match(html, /입주자 1명/);
  assert.doesNotMatch(html, /시설 전체 입주자|시스템 관리 업무 안내/);
  assert.match(render({ role: '담당자' }, {}, [], { authz: { enabled: false } }), /비활성 계정/);
});

test('안내 화면이 누구에게도 열리지 않는 기능을 알려 준다', () => {
  // 사라진 버튼을 보고 "내 등급이 낮아서"라고 읽으면 상급자에게 요청하러 간다.
  // 그쪽도 못 하므로 서로 시간만 쓴다 — 여기서 끊는다.
  const html = render({ role: '센터장' }, { reportApproveCenter: true });
  // 제목을 「아무도 할 수 없는 일」로 바꿨다(더 쉬운 말). 지키는 것은
  // **누구에게도 안 열린다는 사실을 말해 준다**는 것이다.
  assert.match(html, /아무도 할 수 없는 일/);
  assert.match(html, /누구에게도/);
  assert.match(html, /영구히 제공되지 않음/);
  assert.match(html, /전체 초기화/);
  // 절차가 생겨 열린 것은 목록에서 빠져야 한다. 남아 있으면 쓸 수 있는 기능을
  // "제공되지 않는다"고 안내하게 된다.
  assert.doesNotMatch(html, /거래 삭제/);
  // 빈 부류는 제목조차 그리지 않는다(지금 절차 대기는 비어 있다).
  assert.doesNotMatch(html, /절차 준비 중/);
  // 대안을 알려 준다 — 못 한다는 말만 남기지 않는다.
  assert.match(html, /정정 거래|확정 취소/);
});

test('안내 화면은 여전히 편집 제어를 만들지 않는다', () => {
  // 제공되지 않는 기능 목록을 추가하면서 버튼이 섞여 들어가면 안 된다.
  const html = render({ role: '센터장', isAdmin: true }, { reportApproveCenter: true });
  assert.doesNotMatch(html, /<(?:button|select|input|form)\b/);
});
