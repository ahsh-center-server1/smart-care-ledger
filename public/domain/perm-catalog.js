// public/domain/perm-catalog.js
//
// 권한 카탈로그 — **저장소가 소유하는 정적 사실.** 순수 모듈이라 DOM·Firestore를 모른다.
//
// 왜 이 파일이 생겼나
//   권한 등급표가 두 벌이었다. 화면은 `config/permissions` 오버라이드를 읽고,
//   서버(firestore.rules · storage.rules · functions)는 등급 숫자를 하드코딩했다.
//   그래서 관리자가 등급을 **내리면** 버튼은 보이는데 서버가 거부했고(신고된 증상),
//   **올리면** 버튼은 숨는데 서버는 그대로 허용했다(보안 구멍).
//
//   여기가 그 유일한 출처다. 4개 집행 지점(UI · Firestore · Storage · Functions)이
//   이 표를 근거로 하고, test/contract/ 의 계약 테스트가 어긋남을 CI에서 잡는다.
//
// 왜 오버라이드와 분리하는가
//   `securityFloor`가 관리자 편집 문서에 있으면 관리자 계정 하나로 하한 자체를
//   내릴 수 있다. 그래서 하한·집행 지점·범위는 **배포로만** 바뀌고,
//   `config/permissions`에는 그 하한 이상의 오버라이드만 담긴다.
//
//   유효 등급 = max(securityFloor, override ?? defaultRank)
//
// 왜 caps 스냅샷인가
//   Storage 규칙은 평가당 Firestore 문서를 2개까지만 읽는다. `config/permissions`를
//   규칙에서 직접 읽으면 통장 경로(계좌 → 입주자 → 권한)가 한도를 넘는다.
//   그래서 서버가 사용자별 `authz/{uid}.caps`에 **불리언으로 미리 계산**해 두고,
//   규칙은 등급 계산 없이 그 불리언만 읽는다. 조회 1회로 끝난다.

'use strict';

import { COLS } from '../constants.js';

/**
 * 카탈로그 형태 버전. `authz/{uid}.capSchemaVersion`과 대조한다.
 *
 * 올릴 때는 반드시 (1) 두 버전을 함께 처리하는 Functions 배포 → (2) 전 사용자
 * caps 백필 → (3) 검증 → (4) 새 버전을 요구하는 Rules 배포 순서를 지킨다.
 * 순서를 뒤집으면 기존 authz 문서가 전부 불일치가 되어 **전원 차단**된다.
 */
export const CAP_SCHEMA_VERSION = 1;

/** 관리자 플래그가 갖는 등급. 역할과 직교한다(users.isAdmin). */
export const ADMIN_RANK = 99;

/** 설정 화면에서 고를 수 있는 등급. */
export const SELECTABLE_RANKS = [1, 2, 3, 4, ADMIN_RANK];

// ─────────────────────────────────────────────
// 범위 — "누구의 데이터까지 만질 수 있는가"
// ─────────────────────────────────────────────
export const SCOPE = {
  /** 대상이 특정 입주자에 매이지 않는다 (설정·감사 등). */
  NONE: 'none',
  /** 본인이 작성한 문서만 (transactions.createdBy). */
  OWN: 'ownRecord',
  /** 담당으로 배정된 입주자 (authz.accessibleClientIds). */
  ASSIGNED: 'assignedClient',
  /** 배정과 무관하게 전 입주자. */
  ALL: 'allClients',
};

// ─────────────────────────────────────────────
// 집행 지점 — "어디가 실제로 거부하는가"
// ─────────────────────────────────────────────
export const ENFORCE = {
  /** 화면에서 숨기거나 비활성화한다. 보안 경계가 아니다. */
  UI: 'ui',
  FIRESTORE: 'firestore',
  STORAGE: 'storage',
  /** 콜러블 함수가 검사한다. */
  FUNCTION: 'function',
  /** 상태 전이표를 함께 본다 (보고서 결재). */
  TRANSITION: 'transition',
};

/** 서버가 실제로 거부하는 집행 지점. UI만 있는 키는 보안 경계가 없다. */
export const SERVER_ENFORCED = [ENFORCE.FIRESTORE, ENFORCE.STORAGE, ENFORCE.FUNCTION];

/**
 * 키 → caps 불리언 이름. 손으로 관리하는 대응표를 두지 않는다 —
 * 하나만 빠뜨려도 규칙이 조용히 없는 값을 읽고, fail-closed라 기능이 죽는다.
 *
 *   'trx.view.all'             → 'trxViewAll'
 *   'settings.category.common' → 'settingsCategoryCommon'
 */
export function capName(key) {
  return String(key)
    .split('.')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// ─────────────────────────────────────────────
// 카탈로그
//
// 필드
//   defaultRank   기본 최소 등급
//   securityFloor 관리자가 이 아래로 내릴 수 없다. 배포로만 바뀐다
//   configurable  false면 설정 화면에서 읽기 전용
//   enforcement   실제로 거부하는 곳
//   resource      대상 컬렉션 (Firestore 집행 키만)
//   actions       create · update · delete
//   scopeByRank   등급마다 범위가 다른 키 (예: 입력자는 본인 작성분만)
//   scope         등급과 무관하게 범위가 하나인 키
//   allowedFields 이 작업이 바꿀 수 있는 필드. null이면 스키마 전체
//   immutableFields 어떤 경우에도 바뀌지 않는 필드
//   authorizeAgainst 'existing' | 'incoming' | 'both'
//   relatedResourceChecks 관계 무결성 (계좌가 그 입주자 소속인지 등)
//   transition    상태 전이 조건
// ─────────────────────────────────────────────
export const PERM_CATALOG = {

  // ── 거래 ────────────────────────────────────────────────
  // 거래 문서는 화면·자동화 7곳이 수정한다. "거래 수정" 하나로 묶으면
  // 순서 변경 권한이 금액 수정까지 열린다. 그래서 작업별로 나눈다.

  'trx.create': {
    defaultRank: 1, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.TRANSACTIONS, actions: ['create'],
    scopeByRank: { 1: SCOPE.ASSIGNED, 2: SCOPE.ASSIGNED, 3: SCOPE.ALL },
    // createdBy는 생성 시점에 본인 uid여야 한다(규칙이 요구한다).
    allowedFields: ['clientId', 'accountId', 'date', 'time', 'type', 'category',
      'subcategory', 'description', 'descRaw', 'amountIn', 'amountOut',
      'sortOrder', 'createdBy'],
    relatedResourceChecks: [{ field: 'accountId', mustBelongTo: 'clientId' }],
  },

  'trx.edit': {
    defaultRank: 1, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.TRANSACTIONS, actions: ['update'],
    scopeByRank: { 1: SCOPE.OWN, 2: SCOPE.ASSIGNED, 3: SCOPE.ALL },
    // 일반 편집 폼이 실제로 쓰는 필드만 (modals.js의 수기 입력 폼 기준).
    allowedFields: ['date', 'time', 'type', 'category', 'subcategory',
      'description', 'amountIn', 'amountOut', 'accountId'],
    // clientId를 불변으로 두고 accountId가 그 입주자 소속인지 검사하는 조합이
    // 핵심이다. 폼이 clientId를 선택한 계좌에서 파생시키므로, 이 검사가 없으면
    // 계좌를 바꿔 거래를 남의 입주자로 옮길 수 있다.
    immutableFields: ['clientId', 'createdBy', 'createdAt', 'isFixed', 'fixedItemId', 'descRaw'],
    authorizeAgainst: 'both',
    relatedResourceChecks: [{ field: 'accountId', mustBelongTo: 'clientId' }],
  },

  'trx.delete': {
    defaultRank: 1, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.TRANSACTIONS, actions: ['delete'],
    scopeByRank: { 1: SCOPE.OWN, 2: SCOPE.ASSIGNED, 3: SCOPE.ALL },
  },

  'trx.delete.bulk': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.TRANSACTIONS, actions: ['delete'], scope: SCOPE.ASSIGNED,
  },

  'trx.reorder': {
    defaultRank: 2, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.TRANSACTIONS, actions: ['update'], scope: SCOPE.ASSIGNED,
    allowedFields: ['sortOrder'],
    authorizeAgainst: 'both',
  },

  'trx.category.edit': {
    defaultRank: 2, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.TRANSACTIONS, actions: ['update'], scope: SCOPE.ASSIGNED,
    allowedFields: ['category', 'subcategory'],
    authorizeAgainst: 'both',
  },

  // 자산이동은 두 거래를 상호 링크하며 갱신한다. 규칙으로 표현할 수 없으므로
  // 서버 함수가 양쪽을 원자적으로 쓴다.
  'trx.transfer': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION],
    resource: COLS.TRANSACTIONS, actions: ['create', 'update'], scope: SCOPE.ASSIGNED,
    allowedFields: ['linkedAccountId', 'linkedTrxId', 'amountIn', 'amountOut'],
    relatedResourceChecks: [
      { field: 'accountId', mustBelongTo: 'clientId' },
      { field: 'linkedAccountId', mustBelongTo: 'clientId' },
    ],
  },

  'trx.view.all': {
    defaultRank: 2, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.TRANSACTIONS, actions: ['read'], scope: SCOPE.ASSIGNED,
  },

  // 브라우저 안에서만 일어난다. 서버 경계가 없는 것이 정상이다.
  'trx.csv': {
    defaultRank: 2, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI], scope: SCOPE.NONE,
  },

  // ── 엑셀·증빙 ───────────────────────────────────────────

  'excel.upload': {
    defaultRank: 2, securityFloor: 2, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE, ENFORCE.STORAGE],
    resource: COLS.EXCEL_UPLOADS, actions: ['create'], scope: SCOPE.ASSIGNED,
  },

  // 영수증은 4단계로 나눈다. 하나의 광역 권한으로 두면 입력자가 남의 거래
  // 증빙까지 바꿀 수 있게 된다 — 입력 자동화와 최소 권한이 충돌한다.
  'receipt.upload': {
    defaultRank: 1, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.STORAGE, ENFORCE.FUNCTION],
    scope: SCOPE.ASSIGNED,
  },
  'receipt.attachOwn': {
    defaultRank: 1, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION],
    resource: COLS.TRANSACTIONS, actions: ['update'], scope: SCOPE.OWN,
    allowedFields: ['receiptPath', 'receiptGeneration', 'receiptMissing'],
  },
  'receipt.attachAny': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION],
    resource: COLS.TRANSACTIONS, actions: ['update'], scope: SCOPE.ASSIGNED,
    allowedFields: ['receiptPath', 'receiptGeneration', 'receiptMissing'],
  },
  // 교체는 경로만이 아니라 generation까지 비교해야 한다. 연도 마감 재압축이
  // 같은 경로를 덮어써 generation을 바꾸므로, 경로만 보면 낡은 객체를 기준으로
  // 판정한다.
  'receipt.replace': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION],
    resource: COLS.TRANSACTIONS, actions: ['update'], scope: SCOPE.ASSIGNED,
    allowedFields: ['receiptPath', 'receiptGeneration', 'receiptMissing'],
    authorizeAgainst: 'both',
  },
  'receipt.print': {
    defaultRank: 2, securityFloor: 1, configurable: true,
    enforcement: [ENFORCE.UI], scope: SCOPE.NONE,
  },

  'bankbook.upload': {
    defaultRank: 2, securityFloor: 2, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.STORAGE], scope: SCOPE.ASSIGNED,
  },

  // ── 화면 접근 ───────────────────────────────────────────

  'nav.report':   { defaultRank: 2, securityFloor: 1, configurable: true,
                    enforcement: [ENFORCE.UI], scope: SCOPE.NONE },
  'nav.settings': { defaultRank: 2, securityFloor: 1, configurable: true,
                    enforcement: [ENFORCE.UI], scope: SCOPE.NONE },
  'nav.staff':    { defaultRank: 3, securityFloor: 3, configurable: false,
                    enforcement: [ENFORCE.UI], scope: SCOPE.NONE },

  'client.view.all': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.CLIENTS, actions: ['read'], scope: SCOPE.ALL,
  },

  // ── 보고서·결재 ─────────────────────────────────────────
  // 전이는 최소 등급이 아니라 현재 상태 + 담당 관계 + 결재 책임자를 함께 본다.
  // 그래서 전부 Functions 집행이고, Rules는 reports 직접 쓰기를 막는다.

  'report.own': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.REPORTS, actions: ['read'], scope: SCOPE.ASSIGNED,
  },
  'report.view.all': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.REPORTS, actions: ['read'], scope: SCOPE.ALL,
  },
  'report.draft': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION, ENFORCE.TRANSITION],
    resource: COLS.REPORTS, scope: SCOPE.ASSIGNED,
    transition: { from: ['draft', null], to: 'draft' },
  },
  'report.submit': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION, ENFORCE.TRANSITION],
    resource: COLS.REPORTS, scope: SCOPE.ASSIGNED,
    transition: { from: ['draft', 'rejected'], to: 'submitted' },
  },
  'report.recall': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION, ENFORCE.TRANSITION],
    resource: COLS.REPORTS, scope: SCOPE.ASSIGNED,
    transition: { from: ['submitted'], to: 'draft', requires: 'createdBy' },
  },
  'report.approve.team': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION, ENFORCE.TRANSITION],
    resource: COLS.REPORTS, scope: SCOPE.ASSIGNED,
    transition: { from: ['submitted'], to: 'team_approved', requires: 'assignedLeader' },
  },
  'report.approve.center': {
    defaultRank: 4, securityFloor: 4, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION, ENFORCE.TRANSITION],
    resource: COLS.REPORTS, scope: SCOPE.NONE,
    transition: { from: ['team_approved'], to: 'confirmed' },
  },
  'report.reject': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION, ENFORCE.TRANSITION],
    resource: COLS.REPORTS, scope: SCOPE.ASSIGNED,
    transition: { from: ['submitted', 'team_approved'], to: 'rejected', requires: 'currentApprover' },
  },
  'report.revert': {
    defaultRank: 4, securityFloor: 4, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION, ENFORCE.TRANSITION],
    resource: COLS.REPORTS, scope: SCOPE.NONE,
    transition: { from: ['confirmed', 'team_approved', 'submitted'], to: 'previous' },
  },
  // 담당자가 퇴사·부재여도 보고서가 영구 정지되지 않게 하는 탈출 경로.
  'report.release': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION, ENFORCE.TRANSITION],
    resource: COLS.REPORTS, scope: SCOPE.ASSIGNED,
    transition: { from: ['rejected'], to: 'draft' },
  },
  'report.delete': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION],
    resource: COLS.REPORTS, actions: ['delete'], scope: SCOPE.ASSIGNED,
  },

  // ── 설정 ────────────────────────────────────────────────

  // 담당 배정은 clients 원본 + authz + clientAccess 세 문서를 원자적으로
  // 갱신해야 한다. 브라우저 직접 쓰기(setDoc)는 규칙에서 막는다.
  'settings.client': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION],
    resource: COLS.CLIENTS, actions: ['create', 'update', 'delete'], scope: SCOPE.ALL,
  },
  'settings.account': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.ACCOUNTS, actions: ['create', 'update', 'delete'], scope: SCOPE.ALL,
  },
  // users 쓰기는 규칙이 전면 차단한다(역할·승인·비밀번호를 브라우저가 못 건드리게).
  // 그래서 집행이 FUNCTION 하나다.
  'settings.staff': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FUNCTION],
    resource: COLS.USERS, actions: ['create', 'update', 'delete'], scope: SCOPE.NONE,
  },
  'settings.category': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.CATEGORIES, actions: ['create', 'update', 'delete'], scope: SCOPE.ASSIGNED,
  },
  // 공통 분류는 전 입주자에게 영향을 준다. 예전에는 검사가 아예 없어서
  // 담당자가 버튼 하나로 전 입주자의 분류와 자동분류 규칙을 지울 수 있었다.
  'settings.category.common': {
    defaultRank: 3, securityFloor: 3, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.CATEGORIES, actions: ['create', 'update', 'delete'], scope: SCOPE.ALL,
  },
  'settings.fixed': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.FIXED_ITEMS, actions: ['create', 'update', 'delete'], scope: SCOPE.ASSIGNED,
  },
  'settings.budget': {
    defaultRank: 2, securityFloor: 2, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.BUDGETS, actions: ['create', 'update'], scope: SCOPE.ASSIGNED,
  },
  // 다른 직원의 활동 기록이므로 담당자 등급에는 열지 않는다.
  'audit.view': {
    defaultRank: 3, securityFloor: 3, configurable: true,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE],
    resource: COLS.AUDIT_LOGS, actions: ['read'], scope: SCOPE.NONE,
  },
  // 연도 마감은 이미지 재압축을 포함한다. 재압축은 최종 객체를 덮어쓰므로
  // 브라우저가 아니라 서버 archive job이 generation 조건부로 수행한다.
  'settings.archive': {
    defaultRank: 4, securityFloor: 4, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE, ENFORCE.FUNCTION, ENFORCE.STORAGE],
    resource: COLS.CONFIG, scope: SCOPE.NONE,
  },

  // ── 관리자만 ────────────────────────────────────────────

  // 오버라이드 저장은 전 사용자 caps 재계산과 한 트랜잭션이어야 한다.
  // 브라우저 setDoc으로는 그 원자성을 만들 수 없다.
  'settings.permissions': {
    defaultRank: ADMIN_RANK, securityFloor: ADMIN_RANK, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE, ENFORCE.FUNCTION],
    resource: COLS.CONFIG, scope: SCOPE.NONE,
  },
  'settings.reset': {
    defaultRank: ADMIN_RANK, securityFloor: ADMIN_RANK, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE, ENFORCE.STORAGE],
    resource: COLS.SYSTEM_OPS, scope: SCOPE.NONE,
  },
  // 최종 결재가 끝난 월의 편집. 지금은 화면(core.js isConfirmedLocked)에만 있고
  // 규칙에는 마감 관련 조건이 한 줄도 없다 — 개발자도구로 우회된다.
  'lock.bypass': {
    defaultRank: ADMIN_RANK, securityFloor: ADMIN_RANK, configurable: false,
    enforcement: [ENFORCE.UI, ENFORCE.FIRESTORE, ENFORCE.FUNCTION],
    // 잠금은 거래 쓰기에서 검사한다 — config/lockedMonths 색인과 대조해
    // 그 (입주자, 월)이 최종 결재됐으면 이 권한 없이는 거부한다.
    resource: COLS.TRANSACTIONS, actions: ['update', 'delete'], scope: SCOPE.NONE,
  },
};

/** 모든 권한 키. */
export const PERM_KEYS = Object.keys(PERM_CATALOG);

/** 서버가 실제로 거부하는 키 — caps 스냅샷이 필요한 대상. */
export const SERVER_ENFORCED_KEYS = PERM_KEYS.filter(
  k => PERM_CATALOG[k].enforcement.some(e => SERVER_ENFORCED.includes(e)),
);

/** 설정 화면에서 조정할 수 있는 키. */
export const CONFIGURABLE_KEYS = PERM_KEYS.filter(k => PERM_CATALOG[k].configurable);

/**
 * 유효 최소 등급. 오버라이드는 하한 이상에서만 반영된다.
 *
 * 모르는 키는 null — 호출부가 거부해야 한다(fail-closed). 오버라이드를 먼저
 * 보면 config 문서에 아무 키나 넣어 권한을 만들어낼 수 있다.
 */
export function effectiveRank(key, override) {
  const entry = PERM_CATALOG[key];
  if (!entry) return null;
  if (!entry.configurable) return entry.defaultRank;

  const raw = override && Object.prototype.hasOwnProperty.call(override, key)
    ? Number(override[key]) : NaN;
  const wanted = SELECTABLE_RANKS.includes(raw) ? raw : entry.defaultRank;
  return Math.max(entry.securityFloor, wanted);
}

/**
 * 이 키에 적용되는 범위. 등급별로 다른 키는 해당 등급의 값을 준다.
 * 등급이 표에 없으면 가장 가까운 아래 등급의 값을 쓴다.
 */
export function scopeFor(key, rank) {
  const entry = PERM_CATALOG[key];
  if (!entry) return null;
  if (entry.scope) return entry.scope;
  if (!entry.scopeByRank) return SCOPE.NONE;

  const tiers = Object.keys(entry.scopeByRank).map(Number).sort((a, b) => a - b);
  let found = null;
  for (const t of tiers) { if (rank >= t) found = entry.scopeByRank[t]; }
  return found;
}

/**
 * 서버가 authz/{uid}.caps에 심을 불리언 묶음을 계산한다.
 * Rules는 등급 계산을 하지 않고 이 값만 읽는다.
 */
export function computeCaps(rank, override) {
  const caps = {};
  for (const key of SERVER_ENFORCED_KEYS) {
    const required = effectiveRank(key, override);
    caps[capName(key)] = required !== null && rank >= required;
  }
  return caps;
}
