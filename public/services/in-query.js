// public/services/in-query.js
//
// Firestore `in` 절 분할.
//
// 왜 필요한가
//   `where(field,'in',[...])`는 값이 최대 30개다. 앱은 그 한도를 넘으면
//   **필터를 아예 빼고 전체를 스캔하는 폴백**으로 넘어갔다(core.js의 당월 집계).
//   담당 입주자가 31명이 되는 순간 읽기량이 급증하고, 보안 규칙 아래에서는
//   범위를 벗어난 문서가 섞여 **쿼리 전체가 거부**된다.
//
//   그래서 폴백을 없애고 나눠서 조회한다. 빈 입력은 빈 배열을 돌려주므로
//   호출자가 "조회할 것이 없음"과 "전체 조회"를 헷갈릴 수 없다.

'use strict';

/**
 * Firestore `in`/`array-contains-any` 한 절에 넣을 수 있는 값의 개수.
 * 30이 상한이지만 여유를 두지 않는다 — 상한을 넘기면 런타임 오류로 바로 드러난다.
 */
export const IN_QUERY_CHUNK_SIZE = 30;

/**
 * 값 목록을 `in` 절 크기로 나눈다.
 *
 * @param {Array} items
 * @param {number} [size=IN_QUERY_CHUNK_SIZE]
 * @returns {Array<Array>} 빈 입력이면 `[]` — 조회를 아예 하지 않는다는 뜻이다.
 */
export function chunkForInQuery(items, size = IN_QUERY_CHUNK_SIZE) {
  const list = (items || []).filter((x) => x != null && x !== '');
  if (list.length === 0) return [];
  if (!(size > 0)) throw new RangeError('chunk 크기는 1 이상이어야 합니다');

  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
