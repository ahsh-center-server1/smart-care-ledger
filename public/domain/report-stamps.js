/**
 * domain/report-stamps.js — 결재 도장이 말하는 것
 *
 * **시각 변환은 여기 없다.** 그것은 `domain/timestamps.js` 하나가 한다 —
 * 이 앱에서 시각은 세 모양(Firestore Timestamp · ISO 문자열 · Date)으로
 * 저장되고, 변환기가 두 벌이 되면 고친 쪽만 고쳐진다. 여기 있는 것은
 * **도장에서 무엇을 읽을 것인가**뿐이다.
 *
 * 왜 도장을 다시 계산하지 않는가
 *   담당·팀장·센터장 칸의 이름은 **결재한 그 순간** 문서에 박힌다
 *   (report-workflow.js 의 STAGE_STAMPS). 나중에 담당이 바뀌든 팀장이
 *   퇴사하든 인쇄물은 그대로다. 지금의 배정표에서 이름을 다시 찾으면
 *   과거 결재 문서가 조용히 달라진다.
 *
 * DOM·Firestore를 모르므로 Node에서 그대로 테스트된다.
 */

'use strict';

/**
 * 결재란 세 칸 — **이름만.** 문서에 박힌 값만 읽는다.
 * 비어 있는 칸은 아직 그 단계를 지나지 않은 것이다.
 *
 * 날짜를 넣지 않는 이유: 결재란은 도장 자리다. 한 칸에 이름과 날짜가 함께
 * 들어가면 두 줄이 되어 인쇄물의 도장 칸이 빽빽해지고, 언제 결재됐는지는
 * 꼬리의 제출일(reportDateLine)과 화면의 결재 트랙이 이미 말한다.
 */
export function approvalStamps(report) {
  const r = report || {};
  return [
    { label: '담당',   name: r.submittedByName || '' },
    { label: '팀장',   name: r.teamApprovedByName || '' },
    { label: '센터장', name: r.centerApprovedByName || '' },
  ];
}

/**
 * 담당 칸에 적을 이름.
 *
 * 제출되면 제출한 사람, 아직이면 작성한 사람. **지금 보고 있는 사람은 아니다** —
 * 결재자가 열었을 뿐인데 인쇄물의 담당 칸에 결재자 이름이 찍히면, 보는 사람은
 * 결재 라인이 바뀐 것으로 읽는다.
 */
export function reportStaffName(report) {
  return (report && (report.submittedByName || report.createdByName)) || '-';
}
