// 생성물 — 직접 고치지 마세요.
// public/domain/report-workflow.js 를 고치고 `npm run report-workflow:gen` 을 돌리세요.
// 원본과 이 파일이 어긋나면 화면과 서버가 다른 규칙으로 결재를 판정합니다.

/**
 * report-workflow.js — Smart Care Ledger
 * 보고서 결재 상태 머신 (순수 로직)
 *
 * 왜 분리하는가
 *   이전에는 "어떤 버튼을 그릴까"를 정하는 조건문이 곧 상태 머신이었다.
 *   실제 실행 함수(doApproval)는 현재 상태를 **보지 않고** 역할만 보고 전이했다.
 *
 *     const rules = { 담당자:{next:'submitted'}, 센터장:{next:'confirmed'}, ... };
 *     const update = { status: rules[role].next, ... };   // ← report.status 미검사
 *
 *   그래서 탭 두 개, 뒤로가기, 동시 편집, 콘솔에서 doApproval('approve') 직접 호출로
 *   draft → confirmed 한 번에 점프가 됐다. 제출자·팀장 결재란이 빈 채로
 *   "최종 결재완료"가 되고 그 달의 거래가 잠긴다.
 *
 *   여기서는 전이표 하나를 두고 **버튼 표시 여부와 무관하게** 실행 시점에
 *   현재 상태를 확인한다. 표에 없는 (상태, 액션) 조합은 거부한다.
 *
 * 도장(결재 기록) 정리
 *   전이할 때마다 "지금 상태보다 뒤 단계"의 도장을 반드시 지운다.
 *   예전에는 결재를 취소해도 teamApprovedByName이 남아 **취소된 서명이 인쇄물에
 *   계속 찍혔다.** 공문서 산출물이라 그냥 넘길 수 없다.
 *
 * 이 파일은 DOM·Firestore를 모르므로 Node에서 그대로 테스트된다.
 *
 * 왜 domain/ 으로 내려왔나 — 그리고 왜 can 을 인자로 받나
 *   같은 전이표를 **서버도 집행해야 한다.** 예전에는 브라우저만 이 표를 보고,
 *   서버(규칙)는 reports 쓰기를 등급으로만 막았다. 그래서 콘솔에서
 *   updateDoc(reports/…, {status:'confirmed'}) 한 줄이면 결재를 건너뛸 수 있었다.
 *
 *   functions/ 는 별도 배포 단위라 public/ 을 import 할 수 없다. 그래서
 *   tools/gen-report-workflow.mjs 가 이 파일을 기계적으로 CJS 로 옮긴다
 *   (export 만 떼어 낸다). 손으로 옮겨 적으면 전이표가 두 벌이 된다 —
 *   지금 고치고 있는 바로 그 문제다.
 *
 *   그러려면 import 가 없어야 한다. 권한 판정은 ctx.can 으로 주입받는다:
 *   화면은 permissions.js 의 can 을, 서버는 caps 로 만든 can 을 넘긴다.
 */

'use strict';

/** 결재 진행도. rejected는 이 사다리 밖(=진행도 0으로 취급). */
const STAGE_LEVEL = { draft: 0, submitted: 1, team_approved: 2, confirmed: 3 };

/** 단계별 도장 필드 */
const STAGE_STAMPS = {
  submitted:     ['submittedAt', 'submittedBy', 'submittedByName'],
  team_approved: ['teamApprovedAt', 'teamApprovedBy', 'teamApprovedByName'],
  confirmed:     ['centerApprovedAt', 'centerApprovedBy', 'centerApprovedByName'],
  rejected:      ['rejectedAt', 'rejectedBy', 'rejectedByName'],
};

/**
 * 허용 전이표. 여기 없는 조합은 거부한다.
 *
 *   draft ──submit──▶ submitted ──approveTeam──▶ team_approved ──approveCenter──▶ confirmed
 *     ▲                   │                          │                               │
 *     └──recall/revert────┘                          │                               │
 *     ▲                   └──reject──▶ rejected ◀────┘                               │
 *     └──release/submit───────────────────┘          ◀───────────revert──────────────┘
 */
const TRANSITIONS = {
  draft:         { save: 'draft', submit: 'submitted', submitAsLeader: 'team_approved' },
  submitted:     { approveTeam: 'team_approved', approveTeamProxy: 'team_approved',
                   reject: 'rejected', recall: 'draft', revert: 'draft' },
  team_approved: { approveCenter: 'confirmed', reject: 'rejected',
                   recall: 'draft', revert: 'submitted' },
  confirmed:     { revert: 'team_approved' },
  // 반려된 보고서가 영구 정지되지 않도록 탈출 경로를 둘 이상 보장한다.
  // 담당자가 퇴사·부재여도 팀장 이상이 release로 초안으로 되돌릴 수 있다.
  rejected:      { save: 'draft', submit: 'submitted', submitAsLeader: 'team_approved',
                   release: 'draft' },
};

/** 저장되지 않았거나 상태가 비어 있는 보고서는 draft로 본다. */
function normalizeStatus(status) {
  const s = String(status || '').trim();
  return s in TRANSITIONS ? s : 'draft';
}

/** 이 액션이 찍는 도장 단계들 */
const ACTION_STAMPS = {
  submit:           ['submitted'],
  submitAsLeader:   ['submitted', 'team_approved'],
  approveTeam:      ['team_approved'],
  approveTeamProxy: ['team_approved'],
  approveCenter:    ['confirmed'],
  reject:           ['rejected'],
};

/**
 * 액션별 권한 판정. ctx는 신원 정보(권한과 분리).
 * @returns {string|null} 거부 사유. null이면 통과.
 */
function permissionError(action, from, ctx) {
  const { isAuthor = false, isAssignedLeader = false, leaderVacant = false } = ctx;
  // 권한 판정은 주입받는다 — 화면과 서버가 서로 다른 근거를 쓰기 때문이다.
  // 넘기지 않으면 아무것도 허용하지 않는다(fail-closed).
  const can = typeof ctx.can === 'function' ? ctx.can : () => false;

  switch (action) {
    case 'save':
      return can('report.draft') ? null : '임시저장 권한이 없습니다.';

    case 'submit':
      return can('report.submit') ? null : '제출 권한이 없습니다.';

    case 'submitAsLeader':
      if (!can('report.submit')) return '제출 권한이 없습니다.';
      if (!can('report.approve.team')) return '팀장 결재 권한이 없습니다.';
      if (!isAssignedLeader) return '이 입주자의 담당 팀장이 아닙니다.';
      return null;

    case 'approveTeam':
      if (!can('report.approve.team')) return '팀장 결재 권한이 없습니다.';
      if (!isAssignedLeader) return '이 입주자의 담당 팀장이 아닙니다.';
      return null;

    // 팀장 공석 대행 — 배정 팀장이 없거나 퇴사/결재불가일 때만.
    // 이 조건이 없으면 센터장이 언제든 팀장 단계를 건너뛸 수 있다(모바일 앱이 그랬다).
    case 'approveTeamProxy':
      if (!can('report.approve.center')) return '대행 결재 권한이 없습니다.';
      if (!leaderVacant) return '배정된 팀장이 있어 대행할 수 없습니다.';
      return null;

    case 'approveCenter':
      return can('report.approve.center') ? null : '최종 결재 권한이 없습니다.';

    // 반려는 "지금 결재해야 할 사람"만 할 수 있다.
    // 아무 팀장이나 반려할 수 있게 두면, 배정 팀장이 아닌 사람에게는
    // 반려 버튼은 보이는데 사유를 적을 팀장 의견란이 열리지 않아 막힌다.
    case 'reject':
      if (!can('report.reject')) return '반려 권한이 없습니다.';
      if (from === 'team_approved') {
        return can('report.approve.center') ? null : '최종 결재 단계의 반려 권한이 없습니다.';
      }
      if (isAssignedLeader || can('report.approve.center')) return null;
      return '이 입주자의 담당 팀장이 아닙니다.';

    // 회수는 두 갈래다: 본인이 제출한 것을 되가져오거나(작성자),
    // 결재자가 잘못 올라온 것을 내리거나(팀장 이상).
    case 'recall':
      if (isAuthor && can('report.recall')) return null;
      if (can('report.approve.team')) return null;
      return '회수 권한이 없습니다.';

    // 결재 취소는 "직전 단계를 무르는 것"이므로 그 단계의 결재 권한이 필요하다.
    case 'revert':
      if (from === 'confirmed') {
        return can('report.revert') ? null : '최종 결재를 취소할 권한이 없습니다.';
      }
      return can('report.approve.team') ? null : '결재를 취소할 권한이 없습니다.';

    case 'release':
      return can('report.release') ? null : '반려 해제 권한이 없습니다.';

    default:
      return '알 수 없는 결재 동작입니다.';
  }
}

/**
 * 전이를 계산한다. **실행 직전에 반드시 호출한다.**
 *
 * @param {string} action  save|submit|submitAsLeader|approveTeam|approveTeamProxy|
 *                         approveCenter|reject|recall|revert|release
 * @param {string} current 현재 report.status (빈 값 허용)
 * @param {Object} ctx     { userId, userName, now, isAuthor, isAssignedLeader, leaderVacant }
 * @returns {{ok:true, from:string, next:string, set:Object, clear:string[]}}
 *        | {ok:false, reason:string}
 */
function planTransition(action, current, ctx = {}) {
  const from = normalizeStatus(current);
  const allowed = TRANSITIONS[from] || {};

  if (!(action in allowed)) {
    return { ok: false, reason: `현재 상태(${from})에서는 할 수 없는 동작입니다.`, from };
  }
  const denied = permissionError(action, from, ctx);
  if (denied) return { ok: false, reason: denied, from };

  const next = allowed[action];
  const now = ctx.now || new Date().toISOString();
  const userId = String(ctx.userId || '');
  const userName = String(ctx.userName || '');

  // 이 액션이 찍는 도장
  const set = {};
  for (const stage of (ACTION_STAMPS[action] || [])) {
    const [atKey, byKey, nameKey] = STAGE_STAMPS[stage];
    set[atKey] = now;
    set[byKey] = userId;
    set[nameKey] = (action === 'approveTeamProxy' && stage === 'team_approved')
      ? `${userName || userId} (팀장 대행)`   // 대행 사실을 결재란에 남긴다
      : userName;
  }

  // 도착 상태보다 뒤 단계의 도장은 전부 지운다.
  // rejected는 진행도 0 취급이라 반려 시 제출·결재 기록이 함께 정리된다
  // (반려된 보고서에 팀장 결재 서명이 남아 있으면 안 된다).
  const keepLevel = STAGE_LEVEL[next] ?? 0;
  const clear = [];
  for (const [stage, fields] of Object.entries(STAGE_STAMPS)) {
    const level = STAGE_LEVEL[stage];
    if (level !== undefined && level <= keepLevel) continue;
    for (const f of fields) if (!(f in set)) clear.push(f);
  }

  return { ok: true, from, next, set, clear };
}

/** 결재란에 이름을 표시해도 되는가 — 도장이 정리되었는지 검증용(테스트에서 사용) */
function stampsFor(status) {
  const level = STAGE_LEVEL[normalizeStatus(status)] ?? 0;
  const out = [];
  for (const [stage, fields] of Object.entries(STAGE_STAMPS)) {
    const l = STAGE_LEVEL[stage];
    if (l !== undefined && l > 0 && l <= level) out.push(...fields);
  }
  return out;
}

/**
 * 현재 사용자가 이 보고서에서 쓸 수 있는 액션 목록.
 * 버튼 렌더링이 전이표와 갈라지지 않도록 화면도 이 함수를 쓴다.
 */
function availableActions(current, ctx = {}) {
  const from = normalizeStatus(current);
  return Object.keys(TRANSITIONS[from] || {})
    .filter(a => permissionError(a, from, ctx) === null);
}

module.exports = { STAGE_LEVEL, STAGE_STAMPS, TRANSITIONS, normalizeStatus, planTransition, stampsFor, availableActions };
