// public/services/audit.js
//
// 변경 이력 쓰기.
//
// 설계 원칙 — 기록 실패가 본 작업을 막지 않는다
//   감사 로그는 부수 기록이다. 로그 쓰기가 실패했다고 거래 저장이 되돌아가면
//   사용자는 이유도 모른 채 입력을 잃는다. 그래서 auditLog()는 **절대 throw하지
//   않는다.** 실패는 콘솔에만 남긴다.
//
//   단, 같은 batch에 실을 수 있는 경우에는 그렇게 한다(auditOp). 원본 쓰기와
//   원자적으로 커밋되므로 "기록 없는 변경"이 구조적으로 불가능하다.
//   일괄 삭제·마감처럼 이미 batch를 쓰는 경로가 그렇다.

'use strict';

import { S } from '../state.js';
import { COLS } from '../constants.js';
import { fb, fdb } from './firestore.js';
import { buildAuditEntry } from '../domain/audit.js';

/** 현재 로그인 사용자를 actor로 쓴다. */
function currentActor() {
  const u = S.user;
  if (!u || !u.userId) return null;
  return { userId: u.userId, name: u.name, role: u.role };
}

/**
 * batch에 실을 수 있는 형태로 기록을 만든다.
 *
 * batchMixedOps의 add 연산 형식({col, data})으로 돌려주므로
 * 원본 쓰기와 같은 배열에 넣어 한 번에 커밋할 수 있다.
 *
 * @returns {Object|null} actor가 없으면 null (로그인 전 호출)
 */
export function auditOp(action, { resourceId, summary } = {}) {
  const actor = currentActor();
  if (!actor) return null;
  try {
    const { serverTimestamp } = fb();
    return {
      col: COLS.AUDIT_LOGS,
      data: {
        ...buildAuditEntry({ action, actor, resourceId, summary }),
        // 규칙이 timestamp == request.time 을 검사한다 — 소급 기록을 막는다.
        timestamp: serverTimestamp(),
      },
    };
  } catch (e) {
    console.warn('[audit] 기록 생성 실패:', action, e);
    return null;
  }
}

/**
 * 기록 한 건을 바로 쓴다. 실패해도 조용히 넘어간다.
 *
 * 본 작업과 원자적이지 않으므로, batch를 쓰는 경로에서는 auditOp를 쓸 것.
 */
export async function auditLog(action, opts) {
  const op = auditOp(action, opts);
  if (!op) return;
  try {
    const { addDoc, collection } = fb();
    await addDoc(collection(fdb(), op.col), op.data);
  } catch (e) {
    // 여기서 throw하면 거래 저장이 실패한 것처럼 보인다. 기록은 부수 작업이다.
    console.warn('[audit] 기록 실패:', action, e);
  }
}

/**
 * 최근 기록을 읽는다.
 *
 * 한 번만 조회하고 필터는 화면에서 한다 — 분류·검색을 서버 쿼리로 만들면
 * 조합마다 복합 인덱스가 필요하고 필터를 바꿀 때마다 읽기가 다시 나간다.
 * 100건이면 화면에서 걸러도 즉시 반응한다.
 *
 * @param {number} [limitCount=100]
 * @returns {Promise<Array>}
 */
export async function fetchRecentAuditLogs(limitCount = 100) {
  const { getDocs, collection, query, orderBy, limit } = fb();
  const snap = await getDocs(query(
    collection(fdb(), COLS.AUDIT_LOGS),
    orderBy('timestamp', 'desc'),
    limit(limitCount),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
