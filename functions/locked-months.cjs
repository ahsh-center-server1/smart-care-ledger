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

// ─────────────────────────────────────────────────────────────
// 제출 색인 — 삭제 가능 여부를 가른다
//
// 마감 색인(위)과 **다른 질문에 답한다.**
//   마감 색인: 최종 결재가 끝났는가 → 수정·삭제 전면 잠금
//   제출 색인: 결재 절차에 올라갔는가 → 삭제만 잠금(수정은 회수 후 가능)
//
// 삭제를 제출 전으로 제한하는 이유: 실제 삭제 수요는 엑셀 중복 업로드와 입력
// 오타이고, 둘 다 제출 전에 드러난다. 반면 결재자가 보고 있는(또는 이미 본)
// 달에서 거래가 사라지면 결재한 숫자와 장부가 달라진다 — 그때는 삭제가 아니라
// 회수·반려로 되돌린 뒤 고쳐야 한다.
//
// 같은 문서(config/lockedMonths)에 담는 이유: Storage 규칙이 아니라 Firestore
// 규칙이지만, 조회 수는 여전히 과금된다. 두 색인을 한 문서에 두면 거래 쓰기
// 한 번당 조회가 늘지 않는다.
// ─────────────────────────────────────────────────────────────

/** 결재 절차에 올라간 상태. 이 달의 거래는 삭제할 수 없다. */
const SUBMITTED_STATUSES = Object.freeze(['submitted', 'team_approved', 'confirmed']);

/** 보고서가 제출됐거나 그 이후 단계인가. */
function isSubmittedOrBeyond(report) {
  return !!report && SUBMITTED_STATUSES.includes(report.status);
}

/**
 * 보고서 변경에서 **제출 색인**에 적용할 변경만 뽑아낸다.
 * 반환 { key, submitted } 또는 null. lockIndexChange 와 같은 모양이다.
 */
function submitIndexChange(before, after) {
  const doc = after || before;
  if (!doc || !doc.clientId || doc.year == null || doc.month == null) return null;

  const key = lockKey(doc.clientId, doc.year, doc.month);
  const was = isSubmittedOrBeyond(before);
  const now = isSubmittedOrBeyond(after);
  if (was === now) return null;
  return { key, submitted: now };
}

/** reports 전체에서 제출 색인을 새로 만든다 (백필·복구용). */
function buildSubmitIndex(reports) {
  const months = {};
  for (const r of (reports || [])) {
    if (!isSubmittedOrBeyond(r) || !r.clientId || r.year == null || r.month == null) continue;
    months[lockKey(r.clientId, r.year, r.month)] = true;
  }
  return months;
}

// ─────────────────────────────────────────────────────────────
// 결재 색인 — **누가 언제까지 고칠 수 있나**를 가른다
//
// 세 번째 질문이다. 앞의 둘과 헷갈리면 안 된다.
//   마감 색인: 최종 결재가 끝났는가      → 아무도 못 고친다
//   제출 색인: 결재 절차에 올라갔는가    → 담당자가 못 고친다(결재자는 아직 본다)
//   결재 색인: 팀장 결재가 끝났는가      → 팀장도 못 고친다(센터장만 남는다)
//
// 왜 필요한가
//   "본인이 결재한 뒤에는 회수하기 전까지 고칠 수 없다"가 규칙이다. 그런데
//   그 경계는 역할마다 다르다 — 담당자는 제출 순간, 팀장은 팀장 결재 순간,
//   센터장은 최종 결재 순간이다. 상태 하나로는 답할 수 없고, 규칙은 보고서
//   문서를 직접 읽을 수 없으므로(거래 쓰기 한 번마다 조회가 늘어난다) 색인이
//   한 벌 더 필요하다.
//
// 같은 문서(config/lockedMonths)에 담는 이유는 앞의 둘과 같다: 거래 쓰기
// 한 번당 규칙 조회가 늘지 않게 하기 위해서다.
// ─────────────────────────────────────────────────────────────

/** 팀장 결재가 끝난 상태. 이 달의 거래는 팀장도 고칠 수 없다. */
const APPROVED_STATUSES = Object.freeze(['team_approved', 'confirmed']);

/** 보고서가 팀장 결재를 지났는가. */
function isTeamApprovedOrBeyond(report) {
  return !!report && APPROVED_STATUSES.includes(report.status);
}

/**
 * 보고서 변경에서 **결재 색인**에 적용할 변경만 뽑아낸다.
 * 반환 { key, approved } 또는 null. 앞의 둘과 같은 모양이다.
 */
function approveIndexChange(before, after) {
  const doc = after || before;
  if (!doc || !doc.clientId || doc.year == null || doc.month == null) return null;

  const key = lockKey(doc.clientId, doc.year, doc.month);
  const was = isTeamApprovedOrBeyond(before);
  const now = isTeamApprovedOrBeyond(after);
  if (was === now) return null;
  return { key, approved: now };
}

/** reports 전체에서 결재 색인을 새로 만든다 (백필·복구용). */
function buildApproveIndex(reports) {
  const months = {};
  for (const r of (reports || [])) {
    if (!isTeamApprovedOrBeyond(r) || !r.clientId || r.year == null || r.month == null) continue;
    months[lockKey(r.clientId, r.year, r.month)] = true;
  }
  return months;
}

module.exports = {
  LOCKED_MONTHS_DOC, lockKey, isConfirmed, lockIndexChange, buildLockIndex,
  SUBMITTED_STATUSES, isSubmittedOrBeyond, submitIndexChange, buildSubmitIndex,
  APPROVED_STATUSES, isTeamApprovedOrBeyond, approveIndexChange, buildApproveIndex,
};
