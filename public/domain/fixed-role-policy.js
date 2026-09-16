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
  '팀장': [
    'nav.report', 'nav.settings', 'nav.staff', 'trx.view.all', 'trx.csv',
    'receipt.print', 'report.own', 'report.approve.team', 'report.reject',
    'audit.view', 'assignments.manage',
  ],
  '센터장': [
    'nav.report', 'nav.settings', 'nav.staff', 'client.view.all', 'trx.view.all',
    'trx.csv', 'receipt.print', 'report.own', 'report.view.all',
    'report.approve.center', 'report.reject', 'report.revert',
    'settings.archive', 'audit.view', 'assignments.manage', 'staff.role.approve',
  ],
};
const technical = ['nav.settings', 'nav.staff', 'settings.staff', 'system.audit', 'system.ai', 'system.backup'];
const denied = ['lock.bypass', 'settings.permissions', 'settings.reset', 'trx.delete',
  'trx.delete.bulk', 'report.delete', 'report.release', 'settings.account',
  'settings.client', 'settings.category.common'];

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
