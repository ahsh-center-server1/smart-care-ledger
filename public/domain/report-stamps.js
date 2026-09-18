/**
 * domain/report-stamps.js — 결재 도장의 날짜를 읽고 쓰는 한 곳
 *
 * 왜 이 파일이 생겼나 — 「작성일: Invalid Date」
 *   보고서 문서의 createdAt 은 서버가 찍는 Firestore Timestamp 다. 화면은
 *   그것을 `new Date(report.createdAt)` 에 그대로 넣었는데, Timestamp 는
 *   Date 가 아는 모양(문자열·숫자)이 아니라서 결과가 Invalid Date 였다.
 *   인쇄물에 그대로 찍히는 값이라 그냥 넘길 수 없다.
 *
 *   반대로 결재 도장(submittedAt · teamApprovedAt · centerApprovedAt)은
 *   report-workflow.js 가 ISO 문자열로 찍는다. **한 문서 안에 두 모양이
 *   섞여 있다** — 어느 쪽이 올지 부르는 쪽이 알아야 하면 언젠가 또 틀린다.
 *
 * 왜 도장을 다시 계산하지 않는가
 *   담당·팀장·센터장 칸의 이름과 날짜는 **결재한 그 순간** 문서에 박힌다
 *   (STAGE_STAMPS). 나중에 담당이 바뀌든 팀장이 퇴사하든 인쇄물은 그대로다.
 *   지금의 배정표에서 이름을 다시 찾으면 과거 결재 문서가 조용히 달라진다.
 *
 * DOM·Firestore를 모르므로 Node에서 그대로 테스트된다.
 */

'use strict';

/**
 * 무엇이 오든 Date 로. 읽을 수 없으면 **null** 이다.
 *
 * 0(1970년)을 돌려주면 「1970. 1. 1.」이 인쇄되고, 그것은 Invalid Date 보다
 * 나쁘다 — 틀렸다는 것조차 보이지 않는다.
 */
export function toDateValue(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  // Firestore Timestamp — SDK 객체(toDate)와 직렬화된 모양({seconds,…}) 둘 다.
  if (typeof v === 'object') {
    if (typeof v.toDate === 'function') {
      try { const d = v.toDate(); return Number.isNaN(d.getTime()) ? null : d; }
      catch { return null; }
    }
    const sec = v.seconds ?? v._seconds;
    if (typeof sec === 'number') {
      const nano = v.nanoseconds ?? v._nanoseconds ?? 0;
      return new Date(sec * 1000 + Math.floor(nano / 1e6));
    }
    return null;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'YYYY. M. D.' — 읽을 수 없으면 빈 문자열(자리는 비워 둔다). */
export function formatStampDate(v) {
  const d = toDateValue(v);
  return d ? d.toLocaleDateString('ko-KR') : '';
}

/**
 * 인쇄물 머리·꼬리에 적을 한 줄.
 *
 * **제출일이 기준이다.** 작성일은 담당자가 초안을 만든 날이라 결재 라인의
 * 누구에게도 근거가 되지 않는다. 회수하면 제출 도장이 지워지므로(도장 정리)
 * 그때는 다시 작성일로 떨어진다 — 아직 제출되지 않은 문서이기 때문이다.
 */
export function reportDateLine(report) {
  const submitted = formatStampDate(report && report.submittedAt);
  if (submitted) return { label: '제출일', date: submitted };
  const created = formatStampDate(report && report.createdAt);
  return { label: '작성일', date: created || '-' };
}

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
