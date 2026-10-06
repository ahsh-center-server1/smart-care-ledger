'use strict';

/**
 * 권한 카탈로그 — 서버(CommonJS) 쪽 판정.
 *
 * ⚠️ 데이터는 여기 없다. perm-catalog.data.json 을 읽고, 그 파일은
 *    `npm run perm-catalog:gen` 이 public/domain/perm-catalog.js 에서 만든다.
 *    **손으로 고치지 말 것** — 카탈로그는 그쪽이 유일한 출처다.
 *
 * 왜 데이터와 로직을 나눴나
 *   functions/ 는 별도 배포 단위라 런타임에 public/ 을 읽을 수 없다. 그렇다고
 *   43개 항목을 옮겨 적으면 등급표가 다시 두 벌이 된다 — 지금 고치는 문제다.
 *   그래서 데이터는 기계가 복사하고, 로직만 여기서 다시 쓴다.
 *
 *   로직을 두 번 쓰는 것은 여전히 갈라질 수 있다. 그래서
 *   test/perm-catalog-parity.test.mjs 가 전 키 × 전 등급 × 오버라이드 조합에서
 *   두 구현의 **결과**를 대조한다. 텍스트가 아니라 동작을 비교하므로,
 *   한쪽만 고치면 즉시 빨개진다.
 *
 * 왜 서버가 caps 를 미리 계산해 두는가
 *   Storage 규칙은 평가당 Firestore 문서를 2개까지만 읽는다. config/permissions
 *   를 규칙에서 직접 읽으면 통장 경로(계좌 → 입주자 → 권한)가 한도를 넘는다.
 *   그래서 등급 계산을 서버가 끝내 authz/{uid}.caps 에 불리언으로 심고,
 *   규칙은 그 값만 읽는다. 조회 1회로 끝난다.
 */

const DATA = require('./perm-catalog.data.json');

const CAP_SCHEMA_VERSION = DATA.capSchemaVersion;
const ADMIN_RANK = DATA.adminRank;
const SELECTABLE_RANKS = DATA.selectableRanks;
const SCOPE = DATA.scope;
const ENFORCE = DATA.enforce;
const SERVER_ENFORCED = DATA.serverEnforced;
const SERVER_ENFORCED_KEYS = DATA.serverEnforcedKeys;
const PERM_CATALOG = DATA.catalog;
const PERM_KEYS = Object.keys(PERM_CATALOG);

/** 역할 서열. 규칙·화면과 같은 표를 쓴다. */
// 역할 서열도 생성물에서 온다 — 손으로 적으면 브라우저와 갈라진다.
const ROLE_RANK = DATA.roleRank;

/**
 * 키 → caps 불리언 이름. `'trx.view.all'` → `'trxViewAll'`.
 * ESM 쪽 capName() 과 **같은 규칙**이어야 한다(동등성 테스트가 확인한다).
 */
function capName(key) {
  return String(key)
    .split('.')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/**
 * 유효 최소 등급. 오버라이드는 보안 하한 이상에서만 반영된다.
 * 모르는 키는 null — 호출부가 거부해야 한다(fail-closed).
 */
function effectiveRank(key, override) {
  const entry = PERM_CATALOG[key];
  if (!entry) return null;
  if (!entry.configurable) return entry.defaultRank;

  const raw = override && Object.prototype.hasOwnProperty.call(override, key)
    ? Number(override[key]) : NaN;
  const wanted = SELECTABLE_RANKS.includes(raw) ? raw : entry.defaultRank;
  return Math.max(entry.securityFloor, wanted);
}

/** 이 키에 적용되는 범위. 등급별로 다른 키는 해당 등급의 값을 준다. */
function scopeFor(key, rank) {
  const entry = PERM_CATALOG[key];
  if (!entry) return null;
  if (entry.scope) return entry.scope;
  if (!entry.scopeByRank) return SCOPE.NONE;

  const tiers = Object.keys(entry.scopeByRank).map(Number).sort((a, b) => a - b);
  let found = null;
  for (const t of tiers) { if (rank >= t) found = entry.scopeByRank[String(t)]; }
  return found;
}

/** 사용자의 등급. 관리자 플래그는 역할과 직교한다. */
function rankOf(user) {
  if (!user) return 0;
  if (user.isAdmin === true) return ADMIN_RANK;
  return ROLE_RANK[user.role] || 0;
}

/**
 * authz/{uid}.caps 에 심을 불리언 묶음.
 * 규칙은 등급 계산을 하지 않고 이 값만 읽는다.
 */
function computeCaps(rank, override) {
  const caps = {};
  for (const key of SERVER_ENFORCED_KEYS) {
    const required = effectiveRank(key, override);
    caps[capName(key)] = required !== null && rank >= required;
  }
  return caps;
}

/**
 * config/permissions 문서 → 유효한 오버라이드만.
 *
 * 카탈로그에 없는 키와 선택 불가 등급은 버린다. 이것을 하지 않으면
 * config 문서에 아무 키나 넣어 권한을 만들어낼 수 있다.
 */
function sanitizeOverride(stored) {
  const out = {};
  if (!stored || stored.schema !== 'minRank') return out;
  for (const [key, rank] of Object.entries(stored.minRank || {})) {
    const v = Number(rank);
    if (!(key in PERM_CATALOG)) continue;
    if (!SELECTABLE_RANKS.includes(v)) continue;
    out[key] = v;
  }
  return out;
}

module.exports = {
  CAP_SCHEMA_VERSION,
  ADMIN_RANK,
  SELECTABLE_RANKS,
  SCOPE,
  ENFORCE,
  SERVER_ENFORCED,
  SERVER_ENFORCED_KEYS,
  PERM_CATALOG,
  PERM_KEYS,
  ROLE_RANK,
  capName,
  effectiveRank,
  scopeFor,
  rankOf,
  computeCaps,
  sanitizeOverride,
};
