import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/state.js';
import {
  TRANSITIONS, STAGE_STAMPS, STAGE_LEVEL,
  planTransition, availableActions, normalizeStatus, stampsFor, actorContext,
} from '../public/modules/report-workflow.js';

const as = (role, isAdmin = false) => { S.user = { userId: 'u1', name: '홍길동', role, isAdmin }; };
const CTX = { userId: 'u1', userName: '홍길동', now: '2026-09-04T00:00:00.000Z' };

test.afterEach(() => { S.user = null; S.permOverride = null; });

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

test('rejected에는 담당자 경로와 관리 경로가 둘 다 있다', () => {
  const r = TRANSITIONS.rejected;
  assert.equal(r.submit, 'submitted', '담당자 재제출 경로가 없습니다');
  assert.equal(r.release, 'draft', '담당자 부재 시 해제 경로가 없습니다');
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

test('배정 팀장이 센터장·관리자여도 팀장 결재 버튼이 나온다', () => {
  // 예전에는 role==='팀장'으로 묶여 있어 배정 팀장이 센터장이면
  // 결재 버튼이 아예 나오지 않아 보고서가 멈췄다.
  as('센터장');
  assert.equal(planTransition('approveTeam', 'submitted', { ...CTX, isAssignedLeader: true }).ok, true);
  as('입력자', true);
  assert.equal(planTransition('approveTeam', 'submitted', { ...CTX, isAssignedLeader: true }).ok, true);
});

test('팀장이 있으면 센터장이 팀장 단계를 대행할 수 없다', () => {
  // 모바일 앱은 센터장이면 무조건 팀장 결재를 할 수 있어서 순서 강제가 무력화됐다.
  as('센터장');
  const busy = planTransition('approveTeamProxy', 'submitted', { ...CTX, leaderVacant: false });
  assert.equal(busy.ok, false);
  assert.match(busy.reason, /팀장이 있어/);
  assert.equal(planTransition('approveTeamProxy', 'submitted', { ...CTX, leaderVacant: true }).ok, true);
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

test('반려 해제는 팀장 이상만', () => {
  as('담당자');
  assert.equal(planTransition('release', 'rejected', CTX).ok, false);
  as('팀장');
  assert.equal(planTransition('release', 'rejected', CTX).ok, true);
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

test('대행 결재는 결재란에 대행 표시를 남긴다', () => {
  as('센터장');
  const r = planTransition('approveTeamProxy', 'submitted', { ...CTX, leaderVacant: true });
  assert.match(r.set.teamApprovedByName, /대행/);
});

test('팀장 직접 제출은 제출·팀장결재 도장을 한 번에 찍는다', () => {
  as('팀장');
  const r = planTransition('submitAsLeader', 'draft', { ...CTX, isAssignedLeader: true });
  assert.equal(r.next, 'team_approved');
  assert.equal(r.set.submittedBy, 'u1');
  assert.equal(r.set.teamApprovedBy, 'u1');
  assert.ok(!/대행/.test(r.set.teamApprovedByName), '직접 제출인데 대행으로 표시됩니다');
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
test('report.js에서 status를 직접 쓰는 곳은 전이 실행 한 곳뿐이다', async () => {
  // 결재 함수가 하나씩 늘어나면서 각자 status를 쓰던 것이 이 앱의 결재 버그
  // 대부분의 원인이었다. 새 경로가 생기면 여기서 걸린다.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/modules/report.js', import.meta.url), 'utf8');
  // 객체 리터럴의 status 키만 본다 (report.status 같은 읽기는 제외)
  const writes = [...src.matchAll(/(?<![.\w])status\s*:\s*(?!plan\.next)[^,}\s]+/g)].map(m => m[0]);
  // 허용: 보고서를 처음 만들 때의 초안 생성(의견 저장 경로)
  const unexpected = writes.filter(w => !/status\s*:\s*'draft'/.test(w));
  assert.deepEqual(unexpected, [],
    `전이표를 거치지 않고 status를 쓰는 코드가 있습니다: ${unexpected.join(', ')}`);
  // 허용된 초안 생성은 딱 하나(의견 저장으로 보고서가 처음 만들어지는 경우)여야 한다
  assert.equal(writes.length, 1,
    `초안 직접 생성이 ${writes.length}곳입니다 — 전이표 우회 경로가 늘어났습니다`);
});

test('결재 함수는 모두 applyReportTransition을 통한다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/modules/report.js', import.meta.url), 'utf8');
  for (const fn of ['doApproval', 'doApprovalAsLeader', 'doTeamApproveProxy',
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
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/modules/report.js', import.meta.url), 'utf8');
  const creates = [...src.matchAll(/addDoc\(collection\(fdb\(\),\s*COLS\.REPORTS\)/g)];
  assert.ok(creates.length >= 2, `보고서 생성 경로를 찾지 못했습니다 (${creates.length}건)`);
  for (const m of creates) {
    // addDoc 직전 400자 안에 만들어진 data 객체를 본다
    const around = src.slice(Math.max(0, m.index - 400), m.index);
    assert.ok(/createdBy\s*:/.test(around),
      `createdBy 없이 보고서를 만드는 경로가 있습니다 (offset ${m.index})`);
  }
});
