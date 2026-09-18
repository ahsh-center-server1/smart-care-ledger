// public/domain/timestamps.js
//
// 시각 하나를 사람이 읽는 글자로 — **모양이 세 가지이기 때문에** 여기 모은다.
//
// 이 앱에서 시각은 세 가지 모양으로 저장된다.
//   · Firestore Timestamp  — 서버가 `FieldValue.serverTimestamp()` 로 찍는 것
//                            (reports.createdAt, config.archivedAt, 감사 기록 …)
//   · ISO 문자열           — 결재 도장(submittedAt·teamApprovedAt …). 전이표가
//                            `new Date().toISOString()` 으로 만든다
//   · Date · 숫자          — 화면에서 방금 만든 값
//
// `new Date(값)` 은 뒤의 둘만 처리한다. **Timestamp 를 넣으면 조용히 Invalid
// Date 가 되고**, 화면에는 「작성일: Invalid Date」가 그대로 인쇄된다. 실제로
// 보고서 하단에 그렇게 찍혀 나갔다 — 오류도 콘솔 경고도 없었다.
//
// 그래서 값을 다루는 곳마다 각자 변환하지 않고 이 한 곳을 쓴다.
// `test/timestamps.test.mjs` 가 세 모양을 모두 지키고, 화면이 타임스탬프를
// `new Date()` 로 직접 감싸지 않는지도 함께 본다.

'use strict';

/**
 * 무엇이 들어오든 Date 로. 알 수 없으면 **null** 이다.
 *
 * 0(1970년)을 돌려주지 않는 이유: 결재 문서에 1970-01-01 이 인쇄되는 것이
 * 빈칸보다 나쁘다. 모르면 모른다고 해야 부르는 쪽이 대신할 값을 고를 수 있다.
 */
export function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // Firestore Timestamp — SDK 객체면 toDate(), 직렬화된 것이면 seconds 를 본다.
  if (typeof value.toDate === 'function') {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
  }
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = n => String(n).padStart(2, '0');

/** `2026. 9. 5.` — 인쇄물이 쓰던 모양 그대로. 모르면 fallback. */
export function formatDate(value, fallback = '') {
  const d = toDate(value);
  return d ? d.toLocaleDateString('ko-KR') : fallback;
}

/** `2026-09-05 14:03` — 목록·이력처럼 줄을 맞춰 읽는 곳. */
export function formatDateTime(value, fallback = '') {
  const d = toDate(value);
  if (!d) return fallback;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 보고서에 찍을 날짜 — **제출일이 있으면 제출일**이다.
 *
 * 결재 문서에서 의미가 있는 것은 담당자가 올린 날이다. 작성일(createdAt)은
 * 임시저장을 처음 누른 시점이라, 며칠 손보다 올린 보고서에서는 결재자가 본
 * 날짜와 어긋난다. 제출 전에는 제출일이 없으므로 그때만 작성일을 쓰고,
 * **무엇을 보여 주는지 이름표도 함께 바꾼다** — 같은 자리에 다른 뜻이
 * 들어가는데 이름이 그대로면 읽는 사람이 속는다.
 */
export function reportDateLine(report) {
  const submitted = toDate(report && report.submittedAt);
  if (submitted) return { label: '제출일', date: submitted };
  const created = toDate(report && report.createdAt);
  return { label: '작성일', date: created };
}
