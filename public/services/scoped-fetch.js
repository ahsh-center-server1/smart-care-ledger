/**
 * services/scoped-fetch.js — 담당 범위로 좁힌 조회
 *
 * 보안 규칙은 **필터가 아니다.** `getDocs(collection(db,'clients'))` 처럼 넓게
 * 물으면, 규칙 엔진이 결과 전체가 조건을 만족한다고 증명하지 못해 쿼리가
 * 통째로 거부된다 — 가져온 뒤 걸러내는 방식으로는 안 된다.
 *
 * 그래서 전 입주자 조회 권한이 없으면 담당 목록으로 나눠 묻는다.
 * `in` 절은 30개가 상한이라 chunkForInQuery 가 쪼갠다. 담당이 하나도 없으면
 * 빈 배열이 나오고 **무필터 조회로 흘러내리지 않는다** — 그것이 안전장치다.
 *
 * 범위를 인자로 받는 이유: services/ 는 화면 모듈(modules/)을 import 하지
 * 않는다. can() 도 S 도 여기서 읽지 않고 호출부가 넘긴다.
 */

'use strict';

import { fb } from './firestore.js';
import { chunkForInQuery } from './in-query.js';

/**
 * @param {Object} db Firestore 핸들
 * @param {string} col 컬렉션 이름
 * @param {Object} scope
 * @param {boolean} scope.all 전 입주자 조회 권한이 있는가
 * @param {string[]} scope.ids 담당 입주자 id 목록
 * @param {string|null} [scope.field] 범위 필드. 생략하면 문서 ID로 좁힌다.
 * @returns {Promise<{docs: Array}>} getDocs 결과와 같은 모양
 */
export async function fetchInScope(db, col, scope) {
  const { getDocs, collection, query, where, documentId } = fb();
  if (scope && scope.all) return getDocs(collection(db, col));

  const field = scope && scope.field ? scope.field : null;
  const docs = [];
  for (const chunk of chunkForInQuery((scope && scope.ids) || [])) {
    const clause = field ? where(field, 'in', chunk) : where(documentId(), 'in', chunk);
    const snap = await getDocs(query(collection(db, col), clause));
    snap.docs.forEach((d) => docs.push(d));
  }
  return { docs };
}
