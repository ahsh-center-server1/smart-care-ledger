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
// 아무에게도 주지 않는다. 위의 셋과 달리 이쪽은 **절차가 없어서**가 아니라
// 그 자체가 위험해서 닫아 둔 것이다 — 되살리려면 별도 설계가 필요하다.
//   · 파괴적: trx.delete · trx.delete.bulk · report.delete (금전 기록 소실)
//   · 통제 우회: lock.bypass(마감 월 편집) · settings.reset(전체 초기화)
//   · 정책 자체 편집: settings.permissions (고정 역할 정책의 존재 이유)
//   · 결재 단계 건너뛰기: report.release
const denied = ['lock.bypass', 'settings.permissions', 'settings.reset', 'trx.delete',
  'trx.delete.bulk', 'report.delete', 'report.release'];

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
