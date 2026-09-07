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
 * 구조
 *   역할은 서열 4단계. 관리자는 역할이 아니라 users.isAdmin 플래그(역할과 직교).
 *   각 키는 "최소 등급" 하나를 갖고, 관리자는 설정에서 그 등급만 조정한다.
 *   fail-closed — 모르는 키·역할은 거부한다(이전에는 더 느슨한 기본값으로 떨어졌다).
 *
 * 서버와의 관계
 *   firestore.rules / storage.rules가 같은 등급 체계를 토큰 클레임으로 재검증한다.
 *   여기서 숨기는 것은 UI 편의이고, 실제 차단은 서버가 한다.
 */

'use strict';

import { S } from '../state.js';
import { fb, fdb } from '../services/firestore.js';
import { COLS } from '../constants.js';

// ─────────────────────────────────────────────
// 역할 서열
// ─────────────────────────────────────────────
export const ROLE_RANK = { 입력자: 1, 담당자: 2, 팀장: 3, 센터장: 4 };
export const ROLES = Object.keys(ROLE_RANK);
export const ADMIN_RANK = 99;   // isAdmin 플래그가 갖는 등급

/** 등급 → 사람이 읽는 이름 (설정 화면 드롭다운용) */
export const RANK_LABEL = {
  1: '입력자 이상',
  2: '담당자 이상',
  3: '팀장 이상',
  4: '센터장 이상',
  [ADMIN_RANK]: '관리자만',
};

// ─────────────────────────────────────────────
// 키별 최소 등급 (기본값)
//
// 여기 없는 키는 can()이 false를 반환한다. 새 기능을 만들면 반드시 등록할 것.
// ─────────────────────────────────────────────
export const DEFAULT_MIN_RANK = {
  // ── 입력자 이상 — 담당 입주자의 본인 작성 거래만 ──
  'trx.create':            1,
  'trx.edit':              1,   // 입력자는 본인 작성분만 (호출부에서 createdBy 확인)
  'trx.delete':            1,

  // ── 담당자 이상 ──
  'nav.report':            2,
  'nav.settings':          2,
  'trx.view.all':          2,   // 끄면 본인 작성 거래만 보인다
  'trx.delete.bulk':       2,
  'trx.reorder':           2,
  'trx.transfer':          2,
  'trx.category.edit':     2,
  'trx.csv':               2,
  'excel.upload':          2,
  'receipt.upload':        2,
  'receipt.print':         2,
  'bankbook.upload':       2,
  'report.own':            2,
  'report.submit':         2,
  'report.recall':         2,
  'report.draft':          2,
  'settings.fixed':        2,
  'settings.budget':       2,
  'settings.category':     2,   // 입주자 전용 카테고리·규칙

  // ── 팀장 이상 ──
  'nav.staff':             3,
  'client.view.all':       3,   // 담당 배정과 무관하게 전 입주자 조회
  'report.view.all':       3,
  'report.approve.team':   3,
  'report.reject':         3,
  'report.delete':         3,
  // 반려된 보고서를 초안으로 되돌린다. 담당자가 퇴사·부재여도 보고서가
  // 영구 정지되지 않도록 하는 탈출 경로.
  'report.release':        3,
  'settings.client':       3,
  'settings.account':      3,
  'settings.staff':        3,
  // 변경 이력 조회. 누가 무엇을 바꿨는지는 관리 책임이 있는 사람이 봐야 하고,
  // 동시에 다른 직원의 활동 기록이므로 담당자 등급에는 열지 않는다.
  'audit.view':            3,
  // 공통 카테고리·규칙은 전 입주자에게 영향을 주므로 한 단계 높다.
  // 기본값 초기화도 이 권한으로 막는다 — 예전에는 검사가 아예 없어서
  // 담당자가 버튼 하나로 전 입주자의 분류와 자동분류 규칙을 지울 수 있었다.
  'settings.category.common': 3,

  // ── 센터장 이상 ──
  'report.approve.center': 4,
  'report.revert':         4,   // 결재 취소
  'settings.archive':      4,   // 연도 마감

  // ── 관리자만 ──
  'settings.permissions':  ADMIN_RANK,
  'settings.reset':        ADMIN_RANK,   // 전체 초기화
  'lock.bypass':           ADMIN_RANK,   // 최종 결재 완료 월 편집
};

/** 설정 화면에서 조정할 수 있는 등급 선택지 */
export const SELECTABLE_RANKS = [1, 2, 3, 4, ADMIN_RANK];

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
    'excel.upload': '엑셀 업로드', 'receipt.upload': '증빙 첨부',
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
 */
export function can(key) {
  const rank = myRank();
  if (!rank) return false;
  const required = requiredRank(key);
  if (required === null) return false;
  return rank >= required;
}

/** 키에 필요한 최소 등급 (오버라이드 반영). 모르는 키는 null. */
export function requiredRank(key) {
  // 등급표에 없는 키는 오버라이드가 있어도 열지 않는다.
  // 오버라이드를 먼저 보면 config 문서에 아무 키나 넣어 권한을 만들어낼 수 있다.
  if (!(key in DEFAULT_MIN_RANK)) return null;

  if (S.permOverride && key in S.permOverride) {
    const v = Number(S.permOverride[key]);
    if (SELECTABLE_RANKS.includes(v)) return v;
  }
  return DEFAULT_MIN_RANK[key];
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
 * 앱 시작 시 한 번. config/permissions 에서 등급 오버라이드를 읽는다.
 * 문서가 없거나 오류면 기본 등급표만 쓴다.
 */
export async function initPermissions() {
  S.permOverride = {};
  try {
    const { getDoc, doc } = fb();
    const snap = await getDoc(doc(fdb(), COLS.CONFIG, 'permissions'));
    if (!snap.exists()) return;

    const stored = snap.data() || {};
    // 구 형식(역할별 boolean 매트릭스)은 무시한다. 형식이 다르고, 어차피
    // 15개 키가 무반응이었으므로 이어받을 의미가 없다.
    if (stored.schema !== 'minRank') {
      console.info('이전 형식의 권한 설정을 건너뜁니다. 설정 화면에서 다시 지정하세요.');
      return;
    }
    const out = {};
    for (const [key, rank] of Object.entries(stored.minRank || {})) {
      const v = Number(rank);
      if (key in DEFAULT_MIN_RANK && SELECTABLE_RANKS.includes(v)) out[key] = v;
    }
    S.permOverride = out;
  } catch (err) {
    console.warn('권한 로드 실패, 기본 등급표 사용:', err);
  }
}

/**
 * 등급 오버라이드를 저장한다. 관리자만.
 * @param {Object} minRank - { 'trx.edit': 2, ... }
 */
export async function savePermissions(minRank) {
  if (!can('settings.permissions')) throw new Error('권한이 없습니다');

  // 기본값과 같은 항목은 저장하지 않는다 — 나중에 기본값을 바꾸면 따라오도록
  const diff = {};
  for (const [key, rank] of Object.entries(minRank || {})) {
    const v = Number(rank);
    if (!(key in DEFAULT_MIN_RANK)) continue;
    if (!SELECTABLE_RANKS.includes(v)) continue;
    if (v !== DEFAULT_MIN_RANK[key]) diff[key] = v;
  }

  const { setDoc, doc } = fb();
  await setDoc(doc(fdb(), COLS.CONFIG, 'permissions'), {
    schema: 'minRank',
    minRank: diff,
    updatedAt: new Date().toISOString(),
    updatedBy: String(S.user?.userId || ''),
  });
  S.permOverride = diff;
}
