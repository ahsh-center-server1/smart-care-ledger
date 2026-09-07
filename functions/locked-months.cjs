'use strict';

/**
 * 마감(최종 결재 완료) 월 색인 — 서버(Cloud Functions)용 CommonJS 구현.
 *
 * ⚠️ `public/constants.js`의 lockKey와 **동일한 키 형식**이어야 한다.
 *    test/locked-months.test.mjs가 양쪽을 대조하므로 한쪽만 고치면 실패한다.
 *
 * 파일이 두 벌인 이유: 브라우저는 public/ 아래 ESM만 불러올 수 있고,
 * Cloud Functions 배포 번들에는 functions/ 밖의 파일이 포함되지 않는다.
 * (functions/balance.cjs ↔ public/services/balance.js와 같은 구조)
 */

const LOCKED_MONTHS_DOC = 'lockedMonths';

/** 마감 색인의 키. */
function lockKey(clientId, year, month) {
  return `${clientId}_${year}-${String(month).padStart(2, '0')}`;
}

/** 보고서가 마감 상태인가. */
function isConfirmed(report) {
  return !!report && report.status === 'confirmed';
}

/**
 * 보고서 문서 변경에서 색인에 적용할 변경만 뽑아낸다.
 *
 * 반환: { key, locked } 또는 null(적용할 것 없음)
 *   locked=true  → months[key] = true
 *   locked=false → months[key] 삭제
 *
 * 순수 함수로 둔 이유: 이 환경에서는 Firestore 트리거를 에뮬레이터에 등록할 수 없어
 * (조직 이그레스 정책) 트리거 자체를 로컬에서 돌려볼 수 없다. 판단 로직만이라도
 * 테스트로 고정해 둔다.
 */
function lockIndexChange(before, after) {
  const doc = after || before;
  if (!doc || !doc.clientId || doc.year == null || doc.month == null) return null;

  const key = lockKey(doc.clientId, doc.year, doc.month);
  const was = isConfirmed(before);
  const now = isConfirmed(after);
  if (was === now) return null;                  // 마감 여부가 안 바뀌면 색인도 그대로
  return { key, locked: now };
}

/**
 * reports 전체에서 색인을 새로 만든다 (백필·복구용).
 * @param {Array} reports reports 문서 배열
 * @returns {Object} months 맵
 */
function buildLockIndex(reports) {
  const months = {};
  for (const r of (reports || [])) {
    if (!isConfirmed(r) || !r.clientId || r.year == null || r.month == null) continue;
    months[lockKey(r.clientId, r.year, r.month)] = true;
  }
  return months;
}

module.exports = { LOCKED_MONTHS_DOC, lockKey, isConfirmed, lockIndexChange, buildLockIndex };
