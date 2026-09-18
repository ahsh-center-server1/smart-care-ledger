/**
 * constants.js — Smart Care Ledger v2
 * 전역 상수 정의 (색상, 상태값, 컬렉션명, 설정값)
 */

'use strict';

// ─────────────────────────────────────────────
// Firestore 컬렉션명
// ─────────────────────────────────────────────
/**
 * 최종 결재 완료(마감) 월 색인 문서.
 *
 * 왜 별도 문서인가
 *   마감 여부는 **모든 역할이 알아야 한다** — 입력자도 마감된 달에는 거래를 넣을 수
 *   없어야 한다. 그런데 그 정보를 reports 컬렉션에서 직접 읽으면 보안 규칙과 충돌한다:
 *   reports는 담당자(등급 2) 이상만 읽을 수 있고, 입력자가 조회하면 쿼리가 거부되어
 *   **앱 초기화가 통째로 실패한다**(실제로 그런 상태였다).
 *
 *   그래서 "어느 (입주자, 월)이 잠겼는지"만 담은 문서를 따로 둔다. 금액·의견·결재자
 *   같은 내용은 들어가지 않으므로 전원 조회를 허용해도 안전하고, 조회는 쿼리 대신
 *   **문서 1건 읽기**라 읽기량도 준다.
 *
 *   이 문서는 Cloud Functions의 syncLockedMonths 트리거만 쓴다(Admin SDK).
 *   클라이언트는 규칙상 config를 쓸 수 없어 위조가 불가능하다.
 */
export const LOCKED_MONTHS_DOC = 'lockedMonths';
/** 팀 목록 문서(config/teams). 팀은 많아야 열 몇 개라 컬렉션으로 두지 않는다. */
export const TEAMS_DOC = 'teams';

/**
 * 마감 색인의 키. 서버(functions/locked-months.cjs)와 **같은 형식**이어야 한다.
 * test/locked-months.test.mjs가 양쪽을 대조한다.
 */
export function lockKey(clientId, year, month) {
  return `${clientId}_${year}-${String(month).padStart(2, '0')}`;
}

export const COLS = {
  USERS:         'users',
  CLIENTS:       'clients',
  ACCOUNTS:      'accounts',
  TRANSACTIONS:  'transactions',
  CATEGORIES:    'categories',
  REPORTS:       'reports',
  CONFIG:        'config',
  // 권한 스냅샷. 보안 규칙이 읽는 문서이고 브라우저는 자기 것만 읽는다.
  AUTHZ:         'authz',
  EXCEL_UPLOADS: 'excelUploads',
  // 변경 이력. 추가만 가능하고 수정·삭제는 규칙이 막는다(domain/audit.js 참고).
  AUDIT_LOGS:    'auditLogs',
  // 오래 걸리는 파괴적 작업(전체 초기화 등)의 진행 상태.
  // 중단되어도 어디까지 했는지 남아 이어서 진행할 수 있다.
  SYSTEM_OPS:    'systemOperations',
  // 월별 요약 캐시. 대시보드가 당월 거래 전체를 읽지 않게 하는 문서다
  // (domain/monthly-summary.js 참고). 서버 트리거가 sourceVersion을 올려
  // 낡음을 표시하고, 볼 수 있는 사람이 계산해서 채운다.
  SUMMARY_CACHES:'summaryCaches',
  BUDGETS:       'budgets',
  // 매월 같은 날 반복되는 항목. 예전에는 6곳에서 'fixedItems' 리터럴을
  // 직접 썼고, 그래서 권한 카탈로그가 이 컬렉션을 참조할 수 없었다.
  FIXED_ITEMS:   'fixedItems',
};

// ─────────────────────────────────────────────
// 카테고리 색상 — 판정은 domain/category-color.js 하나다.
// 예전에는 여기 표를 이름으로만 찾아서, 분류 이름을 바꾸면 회색이 됐다.
// ─────────────────────────────────────────────
export { CAT_COLORS, cs } from './domain/category-color.js';

/**
 * 결제수단 뱃지 색. 「무엇에 썼나」(분류)와 다른 축이라 색도 따로 둔다 —
 * 같은 색을 쓰면 두 뱃지가 한 덩어리로 읽힌다.
 */
export const METHOD_COLORS={
  '카드':    {bg:'#eef2ff',text:'#4338ca'},
  '계좌이체':{bg:'#f0fdfa',text:'#0f766e'},
  '자동이체':{bg:'#fef3c7',text:'#92400e'},
  '현금':    {bg:'#f0fdf4',text:'#15803d'},
};

// ─────────────────────────────────────────────
// 기본 카테고리
//
// 신규 배포 시 categories 컬렉션이 비어 있으면 거래 입력 폼의 분류 셀렉트가
// 비고 자동분류 규칙 추가가 항상 실패한다. 초기 설정 마법사와
// 설정 → 기본값 초기화가 이 목록을 함께 쓴다.
// ─────────────────────────────────────────────
export const DEFAULT_CATEGORIES = [
  { keyword:'', type:'지출', category:'식비',     subcategory:'', sortOrder:0 },
  { keyword:'', type:'지출', category:'교통비',   subcategory:'', sortOrder:1 },
  { keyword:'', type:'지출', category:'의료비',   subcategory:'', sortOrder:2 },
  { keyword:'', type:'지출', category:'생필품',   subcategory:'', sortOrder:3 },
  { keyword:'', type:'지출', category:'여가비',   subcategory:'', sortOrder:4 },
  { keyword:'', type:'지출', category:'기타',     subcategory:'', sortOrder:5 },
  { keyword:'', type:'지출', category:'확인필요', subcategory:'', sortOrder:6 },
  { keyword:'', type:'수입', category:'수입',     subcategory:'', sortOrder:0 },
  { keyword:'', type:'수입', category:'확인필요', subcategory:'', sortOrder:1 },
];

// ─────────────────────────────────────────────
// 보고서 상태
// ─────────────────────────────────────────────
export const STATUS_LABELS = {
  '':             '미저장',
  'draft':        '임시저장',
  'submitted':    '제출됨',
  'team_approved':'팀장 결재완료',
  'confirmed':    '최종 결재완료',
  'rejected':     '반려됨',
};

export const STATUS_CLASSES = {
  '':             'rs-draft',
  'draft':        'rs-draft',
  'submitted':    'rs-submitted',
  'team_approved':'rs-team',
  'confirmed':    'rs-confirmed',
  'rejected':     'rs-rejected',
};
