'use strict';

import { S } from '../state.js';
import { fb, fdb } from '../services/firestore.js';
import { COLS } from '../constants.js';
import {
  PERM_CATALOG, PERM_KEYS, SELECTABLE_RANKS, ROLE_RANK, ROLES, ADMIN_RANK,
} from '../domain/perm-catalog.js';
import {
  fixedCan, computeFixedCaps, deniedReason,
  FORBIDDEN_KEYS, PENDING_PROCEDURE_KEYS,
} from '../domain/fixed-role-policy.js';

export { ROLE_RANK, ROLES, ADMIN_RANK, SELECTABLE_RANKS };

// Legacy display exports only. Authorization never compares these ranks.
export const RANK_LABEL = {
  1: '입력자', 2: '담당자', 3: '팀장', 4: '센터장', [ADMIN_RANK]: '시스템 관리자',
};
export const DEFAULT_MIN_RANK = Object.fromEntries(
  PERM_KEYS.map(key => [key, PERM_CATALOG[key].defaultRank]),
);
export function isConfigurable() { return false; }
export function fixedReason() { return '역할별 고정 정책 — 개별 권한을 변경할 수 없습니다'; }

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
  { title: '담당·시스템 운영', keys: {
    'assignments.manage': '입주자 담당 배정 관리',
    'staff.role.approve': '직원 역할 변경 승인',
    'system.audit': '보안 감사', 'system.ai': 'AI 설정', 'system.backup': '백업 운영',
  }},
];


function currentIdentity() {
  return S.authzStatus === 'ready' && S.user?.userId === S.authz?.uid
    ? S.authz : null;
}

export function myRank() {
  const identity = currentIdentity();
  return identity?.enabled === true ? ROLE_RANK[identity.role] || 0 : 0;
}

export function can(key) { return fixedCan(currentIdentity(), key); }

/** 권한 키 → 사람이 읽는 이름. PERM_SECTIONS 를 평평하게 편 것이다. */
const KEY_LABEL = Object.fromEntries(
  PERM_SECTIONS.flatMap(section => Object.entries(section.keys)),
);

export { FORBIDDEN_KEYS, PENDING_PROCEDURE_KEYS };

/** 이 키가 누구에게도 열리지 않는가. 안내 화면이 목록을 만들 때 쓴다. */
export function isUnavailable(key) { return deniedReason(key) !== null; }

/**
 * can() 이 false 일 때 보여줄 문장.
 *
 * "권한이 없습니다"는 **등급이 낮다**는 뜻으로 읽힌다. 그런데 닫힌 기능에는
 * 틀린 말이다 — 센터장도 관리자도 못 하는 것이고, 승진해도 열리지 않는다.
 * 사용자가 "누구에게 부탁하면 되나"를 찾아 헤매게 만드는 대신, 기능이 없다는
 * 사실과 (절차 대기라면) 언젠가 열린다는 것을 말해 준다.
 */
export function unavailableMessage(key) {
  const name = KEY_LABEL[key] || key;
  switch (deniedReason(key)) {
    case 'forbidden':
      return `${name}: 제공되지 않는 기능입니다.`;
    case 'pending':
      return `${name}: 아직 제공되지 않습니다. 안전한 처리 절차가 준비되면 열립니다.`;
    default:
      return `${name} 권한이 없습니다.`;
  }
}

// Kept for legacy display callers; not a grant or a rank inheritance contract.
export function requiredRank(key) {
  return Object.hasOwn(DEFAULT_MIN_RANK, key) ? DEFAULT_MIN_RANK[key] : null;
}

export function roleCan(role, key) {
  return fixedCan({ role, enabled: true, isAdmin: false }, key);
}

export function hasLoadedIdentity() {
  const identity = currentIdentity();
  return identity?.enabled === true
    && Object.values(computeFixedCaps(identity)).some(value => value === true);
}

let permissionLoadSeq = 0;
/** 권한 상태를 fail-closed 로 비운다. 화면의 can() 은 전부 false 가 된다. */
function clearAuthzState() {
  S.permOverride = {};
  S.authz = null;
  S.caps = null;
  S.accessibleClientIds = [];
  S.leaderClientIds = [];
}

export async function initPermissions() {
  const seq = ++permissionLoadSeq;
  const uid = String(S.user?.userId || '');

  /**
   * **이미 서 있는 권한은 비우지 않는다.**
   *
   * 예전에는 무조건 맨 앞에서 caps 를 null 로 만들었다. 새로 세울 때는 맞는
   * 선택이지만(권한을 모르는 동안 버튼을 보이면 안 된다), 이미 서 있는 것을
   * 새로 고치는 경우에는 그 사이 can() 이 전부 false 가 된다.
   *
   * 로그인 때 그 순간이 하필 화면 그리는 중에 떨어졌다 —
   * signInWithCustomToken 이 onAuthStateChanged 를 깨우고, 그 관찰자가
   * 세션 복원으로 initPermissions 를 한 번 더 부르는데, 그 비우기가
   * _enterApp 한가운데 들어와 **빈 화면**이 됐다. 새로고침하면 관찰자만
   * 도니까 정상으로 보여서 원인이 가려졌다.
   *
   * 성공하면 통째로 갈아 끼우고, 실패하면 그때 비운다 — 중간 상태가 없다.
   */
  const refreshing = uid && S.authzStatus === 'ready' && S.authz?.uid === uid;
  if (!refreshing) {
    clearAuthzState();
    S.authzStatus = 'loading';
  }
  try {
    if (!uid) throw new Error('로그인 정보가 없습니다.');
    const { getDoc, doc } = fb();
    const snap = await getDoc(doc(fdb(), COLS.AUTHZ, uid));
    if (seq !== permissionLoadSeq || S.user?.userId !== uid) return;
    const data = snap.exists() ? snap.data() : null;
    const caps = computeFixedCaps(data);
    if (data?.enabled !== true || !Object.values(caps).some(value => value === true)) {
      throw new Error('사용 가능한 권한 정보가 없습니다. 관리자에게 문의하세요.');
    }
    const ids = value => Array.isArray(value)
      ? [...new Set(value.filter(id => typeof id === 'string' && id.length > 0))] : [];
    S.accessibleClientIds = ids(data.accessibleClientIds);
    S.leaderClientIds = ids(data.leaderClientIds);
    S.authz = {
      uid, role: data.role ?? '', isAdmin: data.isAdmin === true, enabled: true,
      accessibleClientIds: S.accessibleClientIds, leaderClientIds: S.leaderClientIds,
    };
    S.caps = caps;
    S.authzStatus = 'ready';
  } catch (err) {
    if (seq !== permissionLoadSeq || S.user?.userId !== uid) return;
    // 실패는 여기서 비운다 — 새로 고치다 실패했는데 옛 권한이 남으면
    // 강등·퇴사가 반영되지 않는다.
    clearAuthzState();
    S.authzStatus = 'error';
    console.warn('권한 정보 로드 실패 — 접근을 차단합니다:', err);
    throw err;
  }
}

export async function savePermissions() {
  throw new Error('역할별 고정 정책을 사용하므로 권한표를 저장할 수 없습니다.');
}
