import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/state.js';
import {
  TRANSITIONS, STAGE_STAMPS, STAGE_LEVEL,
  planTransition, availableActions, normalizeStatus, stampsFor,
} from '../public/domain/report-workflow.js';
// actorContext 는 S.user 를 보므로 화면 계층에 남았다(도메인은 S 를 모른다).
import { actorContext } from '../public/modules/report.js';
// 전이표는 이제 권한 판정을 주입받는다(서버가 같은 파일을 쓰기 때문이다).
// 화면 쪽 판정은 permissions.js 의 can 이고, 아래 as() 가 S.user 로 그것을 움직인다.
import { can } from '../public/modules/permissions.js';

const as = (role, isAdmin = false) => {
  S.user = { userId: 'u1', name: '홍길동', role, isAdmin };
  S.authz = { uid: 'u1', role, isAdmin, enabled: true };
  S.authzStatus = 'ready';
};
const CTX = { can, userId: 'u1', userName: '홍길동', now: '2026-09-04T00:00:00.000Z' };

test.afterEach(() => { S.user = null; S.authz = null; S.authzStatus = 'idle'; S.permOverride = null; });

// ─────────────────────────────────────────────
// 전이표 자체의 성질
// ─────────────────────────────────────────────
test('모든 전이의 도착 상태가 표에 정의된 상태다', () => {
  for (const [from, actions] of Object.entries(TRANSITIONS)) {
    for (const [action, to] of Object.entries(actions)) {
      assert.ok(to in TRANSITIONS, `${from} --${action}--> ${to}: 도착 상태가 표에 없습니다`);
    }
  }
});

test('모든 상태에서 빠져나갈 길이 있다 (막다른 상태 금지)', () => {
  // 반려된 보고서가 영구 정지되던 문제 — 담당자가 부재해도 길이 있어야 한다
  for (const [from, actions] of Object.entries(TRANSITIONS)) {
    assert.ok(Object.keys(actions).length > 0, `${from}에서 나갈 방법이 없습니다`);
  }
});

test('rejected는 작성·제출 절차로만 다시 진행한다', () => {
  const r = TRANSITIONS.rejected;
  assert.equal(r.submit, 'submitted', '담당자 재제출 경로가 없습니다');
  assert.equal(r.release, undefined);
});

test('confirmed에서 앞으로 더 갈 수 없다', () => {
  assert.deepEqual(Object.keys(TRANSITIONS.confirmed), ['revert']);
});

test('빈 상태·미지의 상태는 draft로 본다', () => {
  for (const v of ['', null, undefined, 'garbage', '  ']) {
    assert.equal(normalizeStatus(v), 'draft', `${JSON.stringify(v)}가 draft로 정규화되지 않습니다`);
  }
  assert.equal(normalizeStatus('team_approved'), 'team_approved');
});

// ─────────────────────────────────────────────
// 실행 시점 검증 — 이 앱 최대의 결재 버그
// ─────────────────────────────────────────────
test('draft에서 최종 결재로 바로 점프할 수 없다', () => {
  // 예전에는 doApproval이 report.status를 보지 않고 역할만 봤기 때문에
  // 센터장이 콘솔에서 doApproval('approve')를 부르면 draft → confirmed가 됐다.
  as('센터장');
  const r = planTransition('approveCenter', 'draft', CTX);
  assert.equal(r.ok, false);
  assert.match(r.reason, /draft/);
});

test('제출되지 않은 보고서를 팀장이 결재할 수 없다', () => {
  as('팀장');
  assert.equal(planTransition('approveTeam', 'draft', { ...CTX, isAssignedLeader: true }).ok, false);
  assert.equal(planTransition('approveTeam', 'rejected', { ...CTX, isAssignedLeader: true }).ok, false);
});

test('팀장 결재 없이 최종 결재할 수 없다 (순서 강제)', () => {
  as('센터장');
  assert.equal(planTransition('approveCenter', 'submitted', CTX).ok, false);
  assert.equal(planTransition('approveCenter', 'team_approved', CTX).ok, true);
});

test('이미 최종 결재된 보고서를 다시 결재할 수 없다', () => {
  as('센터장');
  assert.equal(planTransition('approveCenter', 'confirmed', CTX).ok, false);
});

test('알 수 없는 액션은 거부한다', () => {
  as('센터장', true);
  assert.equal(planTransition('hack', 'submitted', CTX).ok, false);
  assert.equal(planTransition('', 'draft', CTX).ok, false);
});

test('관리자여도 상태를 건너뛸 수 없다', () => {
  // 권한과 순서는 별개다. 관리자는 모든 권한을 갖지만 전이표는 못 넘는다.
  as('입력자', true);
  assert.equal(planTransition('approveCenter', 'submitted', CTX).ok, false);
});

// ─────────────────────────────────────────────
// 권한
// ─────────────────────────────────────────────
test('입력자는 어떤 결재 동작도 할 수 없다', () => {
  as('입력자');
  for (const [from, actions] of Object.entries(TRANSITIONS)) {
    for (const action of Object.keys(actions)) {
      assert.equal(planTransition(action, from, { ...CTX, isAuthor: true, isAssignedLeader: true, leaderVacant: true }).ok,
        false, `입력자가 ${from}에서 ${action}을 할 수 있습니다`);
    }
  }
});

test('배정 팀장이 아니면 팀장 결재를 할 수 없다', () => {
  as('팀장');
  const r = planTransition('approveTeam', 'submitted', { ...CTX, isAssignedLeader: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /담당 팀장/);
  assert.equal(planTransition('approveTeam', 'submitted', { ...CTX, isAssignedLeader: true }).ok, true);
});

test('센터장·관리자는 팀장 권한을 상속하지 않는다', () => {
  as('센터장');
  assert.equal(planTransition('approveTeam', 'submitted', { ...CTX, isAssignedLeader: true }).ok, false);
  as('입력자', true);
  assert.equal(planTransition('approveTeam', 'submitted', { ...CTX, isAssignedLeader: true }).ok, false);
});

test('공석이어도 정식 대행 지정 없이는 팀장 단계를 대행할 수 없다', () => {
  as('센터장');
  const busy = planTransition('approveTeamProxy', 'submitted', { ...CTX, leaderVacant: false });
  assert.equal(busy.ok, false);
  assert.equal(planTransition('approveTeamProxy', 'submitted', { ...CTX, leaderVacant: true }).ok, false);
});

test('팀장은 대행 결재를 할 수 없다 (센터장 이상 전용)', () => {
  as('팀장');
  assert.equal(planTransition('approveTeamProxy', 'submitted', { ...CTX, leaderVacant: true }).ok, false);
});

test('회수는 작성자 본인이거나 팀장 이상만', () => {
  as('담당자');
  assert.equal(planTransition('recall', 'submitted', { ...CTX, isAuthor: false }).ok, false,
    '남의 보고서를 회수할 수 있습니다');
  assert.equal(planTransition('recall', 'submitted', { ...CTX, isAuthor: true }).ok, true);
  as('팀장');
  assert.equal(planTransition('recall', 'submitted', { ...CTX, isAuthor: false }).ok, true);
});

test('최종 결재 취소는 센터장 이상만 (팀장은 못 푼다)', () => {
  as('팀장');
  assert.equal(planTransition('revert', 'confirmed', CTX).ok, false);
  as('센터장');
  assert.equal(planTransition('revert', 'confirmed', CTX).ok, true);
});

test('반려는 지금 결재할 차례인 사람만 할 수 있다', () => {
  // 배정 팀장이 아닌 팀장에게 반려 버튼만 보이면, 사유를 적을 팀장 의견란이
  // 열리지 않아 "사유를 입력하세요"에서 영원히 막힌다.
  as('팀장');
  assert.equal(planTransition('reject', 'submitted', { ...CTX, isAssignedLeader: false }).ok, false);
  assert.equal(planTransition('reject', 'submitted', { ...CTX, isAssignedLeader: true }).ok, true);
  // 팀장 결재까지 끝난 보고서는 센터장 몫이다
  assert.equal(planTransition('reject', 'team_approved', { ...CTX, isAssignedLeader: true }).ok, false);
  as('센터장');
  assert.equal(planTransition('reject', 'team_approved', CTX).ok, true);
  assert.equal(planTransition('reject', 'submitted', { ...CTX, isAssignedLeader: false }).ok, true,
    '센터장은 팀장 공석 대행 경로에서 반려할 수 있어야 합니다');
});

test('반려 해제 우회 동작은 폐기한다', () => {
  as('담당자');
  assert.equal(planTransition('release', 'rejected', CTX).ok, false);
  as('팀장');
  assert.equal(planTransition('release', 'rejected', CTX).ok, false);
});

// ─────────────────────────────────────────────
// 도장 정리 — 취소된 서명이 인쇄물에 남으면 안 된다
// ─────────────────────────────────────────────
test('제출하면 제출 도장이 찍힌다', () => {
  as('담당자');
  const r = planTransition('submit', 'draft', CTX);
  assert.equal(r.next, 'submitted');
  assert.equal(r.set.submittedAt, CTX.now);
  assert.equal(r.set.submittedBy, 'u1');
  assert.equal(r.set.submittedByName, '홍길동');
});

test('팀장 결재를 취소하면 팀장 도장이 지워진다', () => {
  as('팀장');
  const r = planTransition('revert', 'team_approved', CTX);
  assert.equal(r.next, 'submitted');
  for (const f of STAGE_STAMPS.team_approved) {
    assert.ok(r.clear.includes(f), `${f}가 지워지지 않습니다 — 취소된 서명이 인쇄물에 남습니다`);
  }
  // 제출 기록은 남아야 한다 (제출 상태로 돌아가는 것이므로)
  for (const f of STAGE_STAMPS.submitted) assert.ok(!r.clear.includes(f), `${f}까지 지워집니다`);
});

test('최종 결재를 취소하면 센터장 도장만 지워진다', () => {
  as('센터장');
  const r = planTransition('revert', 'confirmed', CTX);
  assert.equal(r.next, 'team_approved');
  for (const f of STAGE_STAMPS.confirmed) assert.ok(r.clear.includes(f));
  for (const f of [...STAGE_STAMPS.submitted, ...STAGE_STAMPS.team_approved]) {
    assert.ok(!r.clear.includes(f), `${f}까지 지워집니다`);
  }
});

test('회수하면 제출·결재 도장이 모두 지워진다', () => {
  as('팀장');
  const r = planTransition('recall', 'team_approved', CTX);
  assert.equal(r.next, 'draft');
  for (const f of [...STAGE_STAMPS.submitted, ...STAGE_STAMPS.team_approved, ...STAGE_STAMPS.confirmed]) {
    assert.ok(r.clear.includes(f), `${f}가 남습니다`);
  }
});

test('반려하면 이전 결재 도장이 지워지고 반려 도장만 남는다', () => {
  as('센터장');
  const r = planTransition('reject', 'team_approved', CTX);
  assert.equal(r.next, 'rejected');
  assert.equal(r.set.rejectedBy, 'u1');
  for (const f of [...STAGE_STAMPS.submitted, ...STAGE_STAMPS.team_approved]) {
    assert.ok(r.clear.includes(f), `${f}가 남습니다 — 반려된 보고서에 결재 서명이 남습니다`);
  }
  for (const f of STAGE_STAMPS.rejected) {
    assert.ok(!r.clear.includes(f), `방금 찍은 ${f}를 지우고 있습니다`);
  }
});

test('재제출하면 반려 도장이 지워진다', () => {
  as('담당자');
  const r = planTransition('submit', 'rejected', CTX);
  assert.equal(r.next, 'submitted');
  for (const f of STAGE_STAMPS.rejected) assert.ok(r.clear.includes(f), `${f}가 남습니다`);
});

test('어떤 전이든 도착 상태보다 뒤 단계의 도장은 남지 않는다', () => {
  as('센터장', true);
  const ctx = { ...CTX, isAuthor: true, isAssignedLeader: true, leaderVacant: true };
  for (const [from, actions] of Object.entries(TRANSITIONS)) {
    for (const action of Object.keys(actions)) {
      const r = planTransition(action, from, ctx);
      if (!r.ok) continue;
      const kept = new Set(stampsFor(r.next));
      for (const [stage, fields] of Object.entries(STAGE_STAMPS)) {
        const level = STAGE_LEVEL[stage];
        if (level !== undefined && level <= (STAGE_LEVEL[r.next] ?? 0)) continue;
        for (const f of fields) {
          if (f in r.set) continue;   // 이 액션이 방금 찍은 도장
          assert.ok(r.clear.includes(f),
            `${from} --${action}--> ${r.next}: ${f}가 정리되지 않습니다`);
          assert.ok(!kept.has(f));
        }
      }
    }
  }
});

test('정식 대행 지정 없는 대행 결재는 거부한다', () => {
  as('센터장');
  const r = planTransition('approveTeamProxy', 'submitted', { ...CTX, leaderVacant: true });
  assert.equal(r.ok, false);
});

// 예전에는 '제출 + 팀장결재 동시'(submitAsLeader) 동작이 있었다. 고정 역할
// 정책에서 팀장은 report.submit 을 갖지 않으므로 그 동작은 어떤 주체로도
// 성립하지 않고, 전이표에도 없다. 이름이 되살아나지 않는지까지 확인한다 —
// 전이표에 다시 넣으면 팀장이 자기 제출건을 스스로 결재하게 된다.
test('팀장 직접 제출 경로는 존재하지 않는다', () => {
  as('팀장');
  for (const from of Object.keys(TRANSITIONS)) {
    assert.equal(TRANSITIONS[from].submitAsLeader, undefined,
      `${from}에 submitAsLeader가 되살아났습니다`);
    assert.equal(planTransition('submitAsLeader', from, { ...CTX, isAssignedLeader: true }).ok,
      false);
  }
});

test('작성자는 팀장·센터장 역할이 있어도 자기 보고서를 결재하지 못한다', () => {
  as('팀장');
  assert.equal(planTransition('approveTeam', 'submitted', { ...CTX, isAssignedLeader: true, isAuthor: true }).ok, false);
  as('센터장');
  assert.equal(planTransition('approveCenter', 'team_approved', { ...CTX, isAuthor: true }).ok, false);
});

// ─────────────────────────────────────────────
// availableActions — 버튼 렌더와 실행이 갈라지지 않도록
// ─────────────────────────────────────────────
test('availableActions로 나온 액션은 전부 실행에 성공한다', () => {
  const ctx = { ...CTX, isAuthor: true, isAssignedLeader: true, leaderVacant: true };
  for (const role of ['입력자', '담당자', '팀장', '센터장']) {
    as(role);
    for (const from of Object.keys(TRANSITIONS)) {
      for (const action of availableActions(from, ctx)) {
        assert.equal(planTransition(action, from, ctx).ok, true,
          `${role}: ${from}에서 ${action} 버튼이 보이는데 실행은 거부됩니다`);
      }
    }
  }
});

test('availableActions에 없는 액션은 실행에 실패한다', () => {
  const ctx = { ...CTX, isAuthor: false, isAssignedLeader: false, leaderVacant: false };
  as('담당자');
  for (const from of Object.keys(TRANSITIONS)) {
    const shown = new Set(availableActions(from, ctx));
    for (const action of Object.keys(TRANSITIONS[from])) {
      if (shown.has(action)) continue;
      assert.equal(planTransition(action, from, ctx).ok, false,
        `${from}에서 ${action} 버튼은 숨겨져 있는데 실행은 통과합니다`);
    }
  }
});

test('담당자에게 draft에서 보이는 것은 임시저장과 제출뿐이다', () => {
  as('담당자');
  assert.deepEqual(availableActions('draft', CTX).sort(), ['save', 'submit']);
});

test('담당자는 제출한 뒤 자기 보고서만 되가져올 수 있다', () => {
  as('담당자');
  assert.deepEqual(availableActions('submitted', { ...CTX, isAuthor: true }), ['recall']);
  assert.deepEqual(availableActions('submitted', { ...CTX, isAuthor: false }), []);
});

// ─────────────────────────────────────────────
// actorContext
// ─────────────────────────────────────────────
test('createdBy가 있어야 작성자로 인정된다', () => {
  as('담당자');
  assert.equal(actorContext({ report: { createdBy: 'u1' } }).isAuthor, true);
  assert.equal(actorContext({ report: { createdBy: 'u2' } }).isAuthor, false);
  // createdBy를 쓰는 코드가 없던 시절 — 회수가 영원히 불가능했다
  assert.equal(actorContext({ report: {} }).isAuthor, false);
  assert.equal(actorContext({}).isAuthor, false);
});

// ─────────────────────────────────────────────
// 소스 수준 방어 — 전이표를 우회하는 경로가 생기지 않도록
// ─────────────────────────────────────────────
test('브라우저는 보고서 status를 쓰지 않는다', async () => {
  // 결재 함수가 하나씩 늘어나면서 각자 status를 쓰던 것이 이 앱의 결재 버그
  // 대부분의 원인이었다. 이제 reports 는 서버만 쓴다 — 화면에는 status 를
  // **적는** 코드가 하나도 없어야 한다(캐시에 담는 out.to 는 서버가 준 값이다).
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/modules/report.js', import.meta.url), 'utf8');
  const writes = [...src.matchAll(/(?<![.\w])status\s*:\s*(?!out\.to|'draft')[^,}\s]+/g)]
    .map(m => m[0]);
  assert.deepEqual(writes, [],
    `화면이 보고서 status 를 직접 씁니다: ${writes.join(', ')}`);
});

test('서버의 전이 실행만 status를 쓴다', async () => {
  // 집행이 서버로 옮겨 갔으니 이 불변식도 서버에서 지켜야 한다.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../functions/report-fns.js', import.meta.url), 'utf8')
    // 주석 속 예시(공격 재현 코드)가 위반으로 잡히지 않게 걷어낸다.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const writes = [...src.matchAll(/(?<![.\w])status\s*:\s*([^,}\s]+)/g)].map(m => m[1]);
  // 허용: 전이표가 계산한 다음 상태, 의견 저장으로 처음 만들어지는 초안,
  // 그리고 이미 있는 값을 그대로 옮겨 적는 것(로그 등) — 상태를 **고르는** 것이 아니다.
  const unexpected = writes.filter(
    (w) => w !== 'plan.next' && w !== "'draft'" && !/^\w+\.status$/.test(w));
  assert.deepEqual(unexpected, [],
    `전이표를 거치지 않고 status를 쓰는 코드가 있습니다: ${unexpected.join(', ')}`);
  assert.ok(writes.includes('plan.next'), '전이 결과를 쓰는 곳이 없습니다');
});

test('결재 함수는 모두 applyReportTransition을 통한다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/modules/report.js', import.meta.url), 'utf8');
  for (const fn of ['doApproval', 'doTeamApproveProxy',
                    'doReject', 'doRevertToDraft', 'recallReport']) {
    const start = src.indexOf(`export async function ${fn}(`);
    assert.ok(start > 0, `${fn}이 없습니다`);
    const body = src.slice(start, src.indexOf('\nexport ', start + 1));
    assert.ok(body.includes('applyReportTransition'),
      `${fn}이 전이표를 거치지 않습니다`);
  }
});

test('보고서를 새로 만드는 모든 경로가 createdBy를 기록한다', async () => {
  // createdBy를 쓰는 코드가 없어서 담당자 회수 기능이 죽어 있었다.
  // 이제 서버가 만든다 — 그리고 **서버가 값을 정한다.** 클라이언트가 적을 수
  // 있으면 남의 이름으로 보고서를 만들어 그것을 회수할 수 있다.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../functions/report-fns.js', import.meta.url), 'utf8');
  const creates = [...src.matchAll(/tx\.set\(reportRef,|ref\.set\(\{/g)];
  assert.ok(creates.length >= 2, `보고서 생성 경로를 찾지 못했습니다 (${creates.length}건)`);
  for (const m of creates) {
    const around = src.slice(m.index, m.index + 500);
    assert.ok(/createdBy:\s*auth\.uid/.test(around),
      `createdBy 를 서버가 정하지 않는 생성 경로가 있습니다 (offset ${m.index})`);
  }
});
