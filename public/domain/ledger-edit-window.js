/**
 * domain/ledger-edit-window.js — 누가 언제까지 장부를 고칠 수 있나
 *
 * 규칙은 한 줄이다: **내가 결재한 뒤에는, 회수하기 전까지 못 고친다.**
 * 그런데 "내가 결재한 뒤"는 역할마다 다른 순간이다.
 *
 *   담당자·입력자  제출하는 순간부터      (draft·rejected 에서만 고친다)
 *   팀장           팀장 결재하는 순간부터 (draft·submitted·rejected 까지 고친다)
 *   센터장         최종 결재하는 순간부터 (confirmed 전까지 고친다)
 *
 * 왜 이렇게 두는가
 *   결재는 "그 시점의 숫자를 내가 봤다"는 서명이다. 서명한 뒤에 장부가 바뀌면
 *   서명이 가리키는 대상이 사라진다. 반대로 **아직 서명하지 않은 사람**은 지금
 *   보고 있는 것을 고칠 수 있어야 한다 — 그러지 않으면 오타 하나에도 반려하고
 *   담당자를 기다렸다가 다시 결재하는 왕복이 생긴다.
 *
 * 왜 상태가 아니라 색인인가
 *   보안 규칙은 거래를 쓸 때 보고서 문서를 찾아 읽을 수 없다(쓰기 한 번마다
 *   조회가 늘고, 애초에 쿼리를 못 한다). 그래서 서버가 config/lockedMonths 에
 *   (입주자, 월) → 단계 색인을 세 벌 유지하고, 규칙과 화면이 **같은 색인**을
 *   본다. 근거가 갈라지면 버튼은 보이는데 서버가 거부한다.
 *
 * DOM·Firestore를 모르므로 Node에서 그대로 테스트된다.
 */

'use strict';

/** 이 역할이 더 이상 고칠 수 없게 되는 단계. */
export const EDIT_BLOCKED_FROM = Object.freeze({
  '입력자': 'submitted',
  '담당자': 'submitted',
  '팀장': 'team_approved',
  '센터장': 'confirmed',
});

/**
 * 못 고치는 이유. 고칠 수 있으면 null.
 *
 * @param {string} role   authz 의 역할 문자열
 * @param {{submitted?:boolean, teamApproved?:boolean, confirmed?:boolean}} stage
 *        그 (입주자, 월)이 각 색인에 들어 있는가
 * @returns {'confirmed'|'team_approved'|'submitted'|null}
 */
export function ledgerEditBlockedBy(role, stage = {}) {
  // 마감은 역할과 무관하다. 여기서 먼저 답해야 센터장에게도 걸린다.
  if (stage.confirmed) return 'confirmed';
  // 역할을 모르면 가장 좁게 본다(fail-closed). 모르는 역할에 장부를 열어 주는
  // 쪽으로 틀리면, 권한 정보가 아직 안 온 화면에서 잠깐 전부 열린다.
  const from = EDIT_BLOCKED_FROM[role] || 'submitted';
  if (from === 'team_approved') return stage.teamApproved ? 'team_approved' : null;
  if (from === 'confirmed') return null;        // confirmed 는 위에서 이미 걸렀다
  return stage.submitted ? 'submitted' : null;
}

/**
 * 화면에 내보낼 문구. **어떻게 푸는지까지 말한다** —
 * 못 한다는 말만 남기면 사용자가 다음에 할 일을 모른다.
 */
export function ledgerEditBlockMessage(blockedBy) {
  if (blockedBy === 'confirmed') {
    return '최종 결재가 끝난 달의 거래는 수정할 수 없습니다. '
      + '(센터장이 결재를 취소하면 다시 편집할 수 있어요.)';
  }
  if (blockedBy === 'team_approved') {
    return '팀장 결재를 마친 달의 거래는 수정할 수 없습니다. '
      + '보고서에서 회수(팀장 결재 취소)한 뒤 수정하세요.';
  }
  if (blockedBy === 'submitted') {
    return '제출한 달의 거래는 수정할 수 없습니다. 보고서를 회수한 뒤 수정하세요.';
  }
  return '';
}
