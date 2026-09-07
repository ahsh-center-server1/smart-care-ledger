// public/domain/data-reset.js
//
// 전체 초기화의 규칙 — 순수 모듈. DOM·Firestore를 모른다.
//
// 왜 별도 모듈인가
//   기존 초기화는 8개 컬렉션을 `await deleteDoc` 한 건씩 지웠다. 그래서
//   (1) 수천 건이면 매우 느리고 (2) 중간에 실패하면 **DB가 반쯤 지워진 채 남고**
//   (3) 어디까지 지웠는지 알 수 없어 이어서 진행할 수도 없었다.
//   확인 문구도 브라우저 prompt() 하나였다.
//
//   지울 대상 목록과 진행 상태 계산을 여기로 옮겨, 화면에 보여주는 체크리스트와
//   실제로 지우는 목록이 **같은 출처**를 쓰게 한다. 종전에는 화면 설명문에
//   "거래/계좌/입주자/보고서"만 적혀 있었는데 실제로는 카테고리·고정항목·설정까지
//   지웠다 — 사용자가 동의한 범위와 실제 범위가 달랐다.

'use strict';

/**
 * 확인 문구. 화면과 (서버 검증을 붙일 때) 서버가 같은 상수를 쓴다.
 * 되돌릴 수 없는 작업이므로 클릭 한 번으로는 실행되지 않게 한다.
 */
export const DATA_RESET_CONFIRM_TEXT = '초기화';

/**
 * 초기화가 지우는 컬렉션과 한글 이름.
 *
 * **이 표가 화면 체크리스트와 삭제 목록을 동시에 구동한다.** 둘을 따로 적으면
 * 반드시 어긋나고, 어긋나면 사용자가 동의하지 않은 데이터가 지워진다.
 *
 * 여기 없는 것은 지우지 않는다:
 *   users·userSecrets — 직원 계정. 지우면 아무도 로그인할 수 없다.
 *   auditLogs         — 변경 이력. 초기화로 기록을 없앨 수 있으면 기록의 의미가 없다
 *                       (규칙에서도 삭제가 막혀 있다).
 *   archive_YYYY      — 마감 보관본. 초기화의 목적은 운영 데이터 정리다.
 */
export const RESET_COLLECTIONS = [
  { col: 'transactions',  label: '거래 내역' },
  { col: 'reports',       label: '보고서·결재 기록' },
  { col: 'accounts',      label: '계좌' },
  { col: 'clients',       label: '입주자' },
  { col: 'categories',    label: '분류·자동분류 규칙' },
  { col: 'fixedItems',    label: '고정 수입/지출' },
  { col: 'budgets',       label: '예산' },
  { col: 'excelUploads',  label: '엑셀 업로드 이력' },
];

/** 초기화가 **보존하는** 것 — 화면에 함께 보여줘야 사용자가 안심할 수 있다. */
export const RESET_PRESERVED = [
  '직원 계정과 비밀번호',
  '변경 이력(감사 로그)',
  '마감 보관본(archive_연도)',
  '권한 등급표',
];

/**
 * Firestore 배치 한 번에 담을 삭제 건수.
 *
 * 상한은 500인데 499로 잡는다 — 같은 배치에 진행 상태 갱신 1건을 함께 실어
 * "지운 것과 진행 표시"가 원자적으로 커밋되게 하기 위해서다. 500으로 두면
 * 진행 표시를 합칠 때마다 배치가 넘쳐 실패한다.
 */
export const MAX_DELETES_PER_BATCH = 499;

/** 진행 상태 문서 id. */
export const RESET_OPERATION_ID = 'data-reset';

/**
 * 진행 중 상태가 아직 유효한가(다른 사람이 지금 돌리고 있는가).
 *
 * 브라우저가 닫히면 진행 상태가 'running'으로 영원히 남아 아무도 다시
 * 실행할 수 없게 된다. 그래서 일정 시간이 지난 'running'은 죽은 것으로 보고
 * 이어서 진행할 수 있게 한다.
 *
 * @param {Object|null} state  systemOperations/data-reset 문서
 * @param {number} [now]
 * @param {number} [staleMs]   이 시간 넘게 갱신이 없으면 죽은 것으로 본다
 */
export function isResetLockActive(state, now = Date.now(), staleMs = 10 * 60 * 1000) {
  if (!state || state.status !== 'running') return false;
  const at = Date.parse(state.updatedAt || state.startedAt || '');
  if (Number.isNaN(at)) return false;      // 시각을 못 읽으면 잠긴 것으로 보지 않는다
  return now - at < staleMs;
}

/**
 * 이어서 진행할 컬렉션 목록.
 *
 * 중단된 초기화는 이미 지운 컬렉션을 다시 훑을 필요가 없다. 다만 마지막으로
 * 처리 중이던 컬렉션은 **다시 포함한다** — 그 안에서 몇 건까지 지웠는지는
 * 알 수 없으므로 남은 것을 다시 훑어야 한다(삭제는 멱등하다).
 */
export function remainingCollections(state) {
  const done = new Set((state && state.doneCollections) || []);
  return RESET_COLLECTIONS.filter(c => !done.has(c.col));
}

/**
 * 진행률(0~100). 컬렉션 단위로만 센다 — 시작 전에는 총 건수를 모른다.
 */
export function resetProgressPercent(state) {
  const done = ((state && state.doneCollections) || []).length;
  return Math.round((done / RESET_COLLECTIONS.length) * 100);
}

/** 진행 상황을 한 줄로. */
export function resetProgressLabel(state) {
  const done = ((state && state.doneCollections) || []).length;
  const total = RESET_COLLECTIONS.length;
  const deleted = Object.values((state && state.deletedCounts) || {})
    .reduce((s, n) => s + Number(n || 0), 0);
  return `${done}/${total} 항목 완료 · ${deleted.toLocaleString('ko-KR')}건 삭제`;
}

/** 입력한 확인 문구가 맞는가. 앞뒤 공백은 허용한다. */
export function isResetConfirmed(input) {
  return String(input == null ? '' : input).trim() === DATA_RESET_CONFIRM_TEXT;
}
