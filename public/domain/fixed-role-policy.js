export const FIXED_POLICY_VERSION = 1;
export const FIXED_ROLES = Object.freeze(['입력자', '담당자', '팀장', '센터장']);

const grants = {
  '입력자': ['trx.create', 'trx.edit', 'receipt.upload', 'receipt.attachOwn'],
  '담당자': [
    'nav.report', 'nav.settings', 'trx.view.all', 'trx.create', 'trx.edit',
    'trx.category.edit', 'trx.reorder', 'trx.transfer', 'trx.csv',
    'excel.upload', 'bankbook.upload', 'receipt.upload', 'receipt.attachOwn',
    'receipt.attachAny', 'receipt.replace', 'receipt.print', 'report.own',
    'report.draft', 'report.submit', 'report.recall', 'settings.category',
    'settings.fixed', 'settings.budget', 'audit.view',
  ],
  // 팀장·센터장의 settings.client · settings.account · settings.category.common 은
  // **시설을 개설·운영하는 권한**이다. 결재 권한이 아니라 관리 업무이므로
  // "검토 역할은 거래 입력을 물려받지 않는다"와 충돌하지 않는다.
  //
  // 한때 denied 였다. 이유는 위험해서가 아니라 **서버 절차가 없어서**였다:
  // 입주자 저장은 콜러블이 신규 등록을 거절했고, 계좌는 규칙이 담당 범위를
  // 전혀 보지 않았다. 그 결과 빈 DB에 첫 관리자가 들어가면 분류도 입주자도
  // 계좌도 만들 수 없어 **시스템이 기동되지 않았다.**
  // 절차가 생겼으므로(아래 근거) 연다:
  //   · saveClient 가 신규 등록을 담당 자동 배정과 함께 트랜잭션으로 처리
  //   · accounts 규칙이 seesClient·입주자 실재·필드 타입을 검사
  '팀장': [
    'nav.report', 'nav.settings', 'nav.staff', 'trx.view.all', 'trx.csv',
    'receipt.print', 'report.own', 'report.approve.team', 'report.reject',
    'audit.view', 'assignments.manage',
    'settings.client', 'settings.account', 'settings.category.common',
  ],
  '센터장': [
    'nav.report', 'nav.settings', 'nav.staff', 'client.view.all', 'trx.view.all',
    'trx.csv', 'receipt.print', 'report.own', 'report.view.all',
    'report.approve.center', 'report.reject', 'report.revert',
    'settings.archive', 'audit.view', 'assignments.manage', 'staff.role.approve',
    'settings.client', 'settings.account', 'settings.category.common',
  ],
};
const technical = ['nav.settings', 'nav.staff', 'settings.staff', 'system.audit', 'system.ai', 'system.backup'];
// 아무에게도 주지 않는 권한. **두 부류이고, 구분이 중요하다.**
//
// 한때 둘이 한 배열에 섞여 있었고, 그래서 "절차가 없어서 잠시 닫은 것"이
// "설계상 영원히 없는 것"과 같이 취급돼 그대로 굳었다. 시설 개설 권한
// (settings.client · settings.account · settings.category.common)이 그렇게
// 묶여 있다가 **빈 배포가 기동되지 않는** 상태를 만들었다.
//
// 화면 문구도 이 구분을 따른다. "권한이 없습니다"는 둘 다에 틀린 말이다 —
// 등급이 낮아서가 아니라 기능이 없는 것이고, 한쪽은 기다리면 생긴다.

/** 설계상 영구히 없다. 되살리려면 이 정책의 전제를 바꿔야 한다. */
const forbidden = [
  // 고정 역할 정책의 존재 이유 자체 — 정책을 정책으로 못 바꾸게 한다.
  'settings.permissions',
  // 통제 우회. 마감된 달의 편집과 전체 초기화는 감사 추적을 무의미하게 만든다.
  'lock.bypass', 'settings.reset',
  // 결재 단계 건너뛰기. 반려건은 작성·제출 절차로만 다시 올라간다
  // (전이표에도 없다 — public/domain/report-workflow.js 의 TRANSITIONS 참고).
  'report.release',
];

/**
 * 위험해서가 아니라 **안전한 절차가 아직 없어서** 닫혀 있다.
 *
 * 금전 기록 삭제는 "지울 수 있는가"가 아니라 "어떤 절차로 지우는가"의 문제다.
 * 사회복지시설의 장부라 보존 의무와 감사 추적이 걸려 있고, 그 설계가 서기
 * 전에는 여는 것보다 닫아 두는 편이 낫다. 절차가 생기면 열린다 —
 * 시설 개설 권한이 실제로 그렇게 열렸다.
 */
const pendingProcedure = ['trx.delete', 'trx.delete.bulk', 'report.delete'];

const denied = [...forbidden, ...pendingProcedure];

export const FORBIDDEN_KEYS = Object.freeze([...forbidden]);
export const PENDING_PROCEDURE_KEYS = Object.freeze([...pendingProcedure]);

/**
 * 이 권한이 닫혀 있다면 왜인가. 열려 있으면 null.
 * 화면은 이 값으로 문구를 고른다("아직 없다" vs "영원히 없다").
 */
export function deniedReason(key) {
  if (forbidden.includes(key)) return 'forbidden';
  if (pendingProcedure.includes(key)) return 'pending';
  return null;
}

export const FIXED_POLICY_KEYS = Object.freeze([...new Set([
  ...Object.values(grants).flat(), ...technical, ...denied,
])].sort());

function validUser(user) {
  return !!user && user.enabled === true && (
    FIXED_ROLES.includes(user.role)
    || (user.isAdmin === true && (user.role == null || user.role === ''))
  );
}

export function fixedCan(user, key) {
  if (!validUser(user) || !FIXED_POLICY_KEYS.includes(key)) return false;
  return (grants[user.role]?.includes(key) === true)
    || (user.isAdmin === true && technical.includes(key));
}

// Client scope is not an ownership or workflow decision. Consumers must also
// check the record author, submission/lock state, and approver separation.
export function fixedScopeFor(user, key) {
  if (!fixedCan(user, key) || technical.includes(key)) return 'none';
  return user.role === '센터장' ? 'allClients' : 'assignedClient';
}

export function computeFixedCaps(user) {
  return Object.fromEntries(FIXED_POLICY_KEYS.map(key => [
    key.replace(/\.([a-z])/g, (_, letter) => letter.toUpperCase()), fixedCan(user, key),
  ]));
}
