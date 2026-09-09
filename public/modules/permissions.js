/**
 * permissions.js — Smart Care Ledger
 * 권한 판정
 *
 * 왜 등급표인가
 *   이전에는 32개 키 × 5개 역할 = 160개 체크박스 매트릭스였다. 그런데 실제 값을
 *   열별로 보면 **모든 권한이 역할 서열에 단조증가하고 예외가 하나도 없었다.**
 *   즉 160개 토글이 담고 있던 정보는 "이 기능은 몇 등급부터인가" 하나뿐이었다.
 *
 *   게다가 32개 중 15개는 코드에서 한 번도 읽히지 않으면서 설정 화면에는
 *   정상 스위치처럼 표시되고 저장까지 됐다. 관리자가 껐다고 생각한 권한이
 *   그대로 살아 있었다는 뜻이다.
 *
 * 등급표는 여기에 없다
 *   domain/perm-catalog.js 하나뿐이고, 같은 데이터를 서버가
 *   functions/perm-catalog.data.json 으로 받아 쓴다(생성물, 동작 동등성 테스트).
 *   이 파일이 자기 표를 갖고 있던 동안 서버는 firestore.rules 에 등급을
 *   하드코딩하고 있었다 — 그래서 등급을 바꿔도 아무 일도 일어나지 않았다.
 *
 * can() 이 무엇을 보는가
 *   서버가 집행하는 키는 **authz/{uid}.caps** 를 본다. 규칙이 읽는 바로 그
 *   문서다. 화면과 집행의 판단 근거가 하나이므로 "버튼은 보이는데 서버가
 *   거부한다"가 구조적으로 생기지 않는다.
 *
 *   caps 가 아직 없으면(백필 전) 등급 계산으로 물러선다. 그때는 예전과 같은
 *   상태이고, 백필을 돌리면 caps 쪽으로 넘어간다.
 */

'use strict';

import { S } from '../state.js';
import { fb, fdb } from '../services/firestore.js';
import { COLS } from '../constants.js';
import {
  PERM_CATALOG, PERM_KEYS, SERVER_ENFORCED_KEYS, SELECTABLE_RANKS,
  ROLE_RANK, ROLES, ADMIN_RANK, capName, effectiveRank,
} from '../domain/perm-catalog.js';

export { ROLE_RANK, ROLES, ADMIN_RANK, SELECTABLE_RANKS };

/** 등급 → 사람이 읽는 이름 (설정 화면 드롭다운용) */
export const RANK_LABEL = {
  1: '입력자 이상',
  2: '담당자 이상',
  3: '팀장 이상',
  4: '센터장 이상',
  [ADMIN_RANK]: '관리자만',
};

/**
 * 키별 기본 최소 등급. 카탈로그에서 파생한다 — 여기서 정하지 않는다.
 * 설정 화면이 "기본값과 다름"을 표시하는 데 쓴다.
 */
export const DEFAULT_MIN_RANK = Object.fromEntries(
  PERM_KEYS.map((k) => [k, PERM_CATALOG[k].defaultRank]),
);

/** 이 권한의 등급을 관리자가 조정할 수 있는가. 보안 하한이 걸린 키는 못 바꾼다. */
export function isConfigurable(key) {
  return PERM_CATALOG[key] ? PERM_CATALOG[key].configurable === true : false;
}

/** 조정할 수 없는 이유(화면 안내용). 조정 가능하면 빈 문자열. */
export function fixedReason(key) {
  const e = PERM_CATALOG[key];
  if (!e || e.configurable) return '';
  return e.defaultRank >= ADMIN_RANK
    ? '관리자 전용 — 등급을 낮출 수 없습니다'
    : `보안 하한 ${e.securityFloor}등급 — 낮출 수 없습니다`;
}

const SERVER_ENFORCED = new Set(SERVER_ENFORCED_KEYS);

/** 권한 화면 표시용 그룹 (키 → 한글 이름) */
export const PERM_SECTIONS = [
  { title: '화면 접근', keys: {
    'nav.report': '보고서 탭', 'nav.settings': '설정 탭', 'nav.staff': '직원 관리',
    'client.view.all': '전 입주자 조회 (담당 배정 무관)',
  }},
  { title: '거래', keys: {
    'trx.create': '거래 입력', 'trx.edit': '거래 수정', 'trx.delete': '거래 삭제',
    'trx.view.all': '동료가 입력한 거래도 조회', 'trx.delete.bulk': '일괄 삭제',
    'trx.reorder': '순서 변경', 'trx.transfer': '자산이동', 'trx.category.edit': '분류 인라인 수정',
    'trx.csv': 'CSV 내보내기',
  }},
  { title: '엑셀·증빙', keys: {
    'excel.upload': '엑셀 업로드', 'receipt.upload': '증빙 업로드',
    'receipt.attachOwn': '본인 작성 거래에 증빙 연결',
    'receipt.attachAny': '남이 작성한 거래에 증빙 연결',
    'receipt.replace': '이미 붙은 증빙 교체',
    'receipt.print': '증빙 일괄 출력', 'bankbook.upload': '통장 사진 업로드',
  }},
  { title: '보고서·결재', keys: {
    'report.own': '담당 보고서 조회', 'report.view.all': '전체 보고서 조회',
    'report.draft': '임시저장', 'report.submit': '제출', 'report.recall': '회수',
    'report.approve.team': '팀장 결재', 'report.approve.center': '센터장 최종 결재',
    'report.reject': '반려', 'report.revert': '결재 취소', 'report.delete': '보고서 삭제',
    'report.release': '반려 해제 (담당자 부재 시)',
  }},
  { title: '설정', keys: {
    'settings.client': '입주자 관리', 'settings.account': '계좌 관리',
    'settings.staff': '직원 등록·수정',
    'settings.category': '입주자 전용 카테고리·규칙',
    'settings.category.common': '공통 카테고리·규칙 (전 입주자 영향)',
    'settings.fixed': '고정항목', 'settings.budget': '예산',
    'audit.view': '변경 이력 조회',
    'settings.archive': '연도 마감', 'settings.permissions': '권한 설정',
    'settings.reset': '전체 초기화', 'lock.bypass': '결재 완료 월 편집',
  }},
];

// ─────────────────────────────────────────────
// 판정
// ─────────────────────────────────────────────

/** 현재 사용자의 등급. 로그인하지 않았으면 0. */
export function myRank() {
  if (!S.user) return 0;
  if (S.user.isAdmin === true) return ADMIN_RANK;
  return ROLE_RANK[S.user.role] || 0;
}

/**
 * 이 사용자가 해당 기능을 쓸 수 있는가.
 * 모르는 키는 거부한다(fail-closed) — 오타나 미등록 기능이 조용히 열리지 않도록.
 *
 * 서버가 집행하는 키는 caps 를 본다. 규칙이 보는 것과 같은 값이라야
 * 화면과 집행이 어긋나지 않는다. caps 가 없으면(백필 전) 등급으로 물러선다.
 */
export function can(key) {
  if (!(key in PERM_CATALOG)) return false;
  if (!myRank()) return false;

  if (S.caps && SERVER_ENFORCED.has(key)) {
    return S.caps[capName(key)] === true;
  }
  const required = requiredRank(key);
  return required !== null && myRank() >= required;
}

/** 키에 필요한 최소 등급 (오버라이드·보안 하한 반영). 모르는 키는 null. */
export function requiredRank(key) {
  // 등급표에 없는 키는 오버라이드가 있어도 열지 않는다.
  // 오버라이드를 먼저 보면 config 문서에 아무 키나 넣어 권한을 만들어낼 수 있다.
  return effectiveRank(key, S.permOverride || {});
}

/** 특정 역할이 그 키를 쓸 수 있는지 (권한 화면 미리보기용) */
export function roleCan(role, key) {
  const required = requiredRank(key);
  if (required === null) return false;
  return (ROLE_RANK[role] || 0) >= required;
}

// ─────────────────────────────────────────────
// 오버라이드 로드·저장
// ─────────────────────────────────────────────

/**
 * 로그인 직후 한 번. 등급 오버라이드와 **권한 스냅샷**을 함께 읽는다.
 *
 * 두 문서를 읽는 이유가 다르다
 *   config/permissions — 설정 화면이 "지금 등급이 몇인가"를 보여주는 데 쓴다.
 *   authz/{uid}.caps   — can() 이 판정하는 근거. 규칙이 읽는 바로 그 값이다.
 *
 * caps 가 없어도 앱은 뜬다(백필 전 상태). 그때 can() 은 등급 계산으로
 * 물러서므로 예전과 같이 동작한다.
 */
export async function initPermissions() {
  S.permOverride = {};
  S.caps = null;
  S.accessibleClientIds = [];
  const { getDoc, doc } = fb();

  try {
    const snap = await getDoc(doc(fdb(), COLS.CONFIG, 'permissions'));
    if (snap.exists()) {
      const stored = snap.data() || {};
      // 구 형식(역할별 boolean 매트릭스)은 무시한다. 형식이 다르고, 어차피
      // 15개 키가 무반응이었으므로 이어받을 의미가 없다.
      if (stored.schema !== 'minRank') {
        console.info('이전 형식의 권한 설정을 건너뜁니다. 설정 화면에서 다시 지정하세요.');
      } else {
        const out = {};
        for (const [key, rank] of Object.entries(stored.minRank || {})) {
          const v = Number(rank);
          if (key in PERM_CATALOG && SELECTABLE_RANKS.includes(v)) out[key] = v;
        }
        S.permOverride = out;
      }
    }
  } catch (err) {
    console.warn('권한 등급표 로드 실패, 기본값 사용:', err);
  }

  try {
    const uid = String(S.user?.userId || '');
    if (!uid) return;
    const snap = await getDoc(doc(fdb(), COLS.AUTHZ, uid));
    // enabled 가 false 면 caps 를 믿지 않는다 — 규칙도 그렇게 판정한다.
    if (snap.exists() && snap.data()?.enabled === true) {
      const d = snap.data();
      S.caps = d.caps || null;
      // 담당 입주자 목록. 규칙이 범위를 이것으로 판정하므로, 앱의 조회도
      // 같은 목록으로 좁혀야 한다 — 넓게 물으면 쿼리가 통째로 거부된다
      // (규칙은 필터가 아니다).
      S.accessibleClientIds = Array.isArray(d.accessibleClientIds) ? d.accessibleClientIds : [];
    }
  } catch (err) {
    // 규칙이 authz 읽기를 막는 경우도 여기로 온다. 등급 계산으로 물러선다.
    console.warn('권한 스냅샷 로드 실패, 등급 계산으로 판정합니다:', err);
  }
}

/**
 * 등급 오버라이드를 저장한다. **서버가 저장하고 서버가 집행값까지 고친다.**
 *
 * 브라우저가 config/permissions 를 직접 쓰던 시절에는 등급표만 바뀌고
 * 규칙이 읽는 authz.caps 는 그대로였다 — 저장은 됐는데 아무것도 달라지지
 * 않았다. 그래서 규칙이 이 문서의 클라이언트 쓰기를 막고, 콜러블이
 * 두 곳을 함께 고친다.
 *
 * @param {Object} minRank - { 'trx.edit': 2, ... }
 * @returns {Promise<{changed:number, users:number, revoked:number, missingAuthz:number}>}
 */
export async function savePermissions(minRank) {
  if (!can('settings.permissions')) throw new Error('권한이 없습니다');

  // 조정할 수 없는 키는 보내지 않는다 — 서버가 이름을 대고 거절하므로,
  // 화면이 전체 목록을 그대로 보내면 저장이 통째로 실패한다.
  const payload = {};
  for (const [key, rank] of Object.entries(minRank || {})) {
    if (!(key in PERM_CATALOG)) continue;
    if (!isConfigurable(key)) continue;
    const v = Number(rank);
    if (SELECTABLE_RANKS.includes(v)) payload[key] = v;
  }

  const res = await window._fbFn.call('savePermissions')({ minRank: payload });

  // 저장이 끝난 뒤 다시 읽는다. 서버가 caps 까지 고쳤으므로 화면의 판정
  // 근거도 새것이어야 한다 — 여기서 갱신하지 않으면 새로고침 전까지
  // 화면만 옛 권한으로 남는다.
  await initPermissions();
  return res?.data || {};
}
