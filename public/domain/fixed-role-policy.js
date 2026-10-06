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
    'settings.fixed', 'settings.budget',
    // 담당 입주자의 계좌를 직접 만들고 고친다. 계좌 개설·정정은 장부를 쓰는
    // 사람의 일상 업무이고, 팀장을 거치면 입력이 멈춘다.
    // **범위는 권한이 아니라 규칙이 잡는다** — accounts 규칙의 seesClient 가
    // 담당 배정 밖 입주자의 계좌를 막으므로, 이 키는 자동으로 담당 범위다.
    // 계좌는 물리 삭제가 아니라 비활성으로 다루므로 거래가 끊기지 않는다.
    'settings.account',
    // 삭제는 **제출 전에만** 가능하다. 권한이 아니라 상태가 막는다 —
    // config/lockedMonths.submittedMonths 색인을 규칙이 함께 본다.
    // 실제 삭제 수요(엑셀 중복 업로드·입력 오타)는 전부 제출 전에 드러나고,
    // 제출 뒤에 지우면 결재한 숫자와 장부가 달라진다.
    'trx.delete', 'trx.delete.bulk', 'report.delete',
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
  // trx.edit — 검토 역할도 **자기가 결재하기 전까지는** 장부를 고친다.
  //
  //   이것이 「작성자와 결재자의 분리」를 깨지 않는 이유: 분리가 막는 것은
  //   "내가 쓴 것을 내가 결재하는 것"이다. 결재자가 아직 서명하지 않은 숫자를
  //   고치는 것은 결재 행위가 아니라 검토 행위이고, 그 뒤에 반드시 자기 서명이
  //   따로 남는다. 반대로 **서명한 뒤에는 아무것도 못 고친다** — 서명이
  //   가리키는 숫자가 나중에 달라지면 서명이 뜻을 잃기 때문이다.
  //
  //   경계는 권한이 아니라 **단계**가 잡는다(domain/ledger-edit-window.js,
  //   firestore.rules 의 editableStage): 담당자는 제출하는 순간, 팀장은 팀장
  //   결재하는 순간, 센터장은 최종 결재하는 순간부터 닫힌다.
  //
  //   trx.create 는 주지 않는다. 오타·분류를 고치는 것과 없는 거래를 만들어
  //   넣는 것은 다른 일이고, 후자는 담당자의 일이다.
  '팀장': [
    'nav.report', 'nav.settings', 'nav.staff', 'trx.view.all', 'trx.csv',
    'trx.edit',
    'receipt.print', 'report.own', 'report.approve.team', 'report.reject',
    'assignments.manage',
    'settings.client', 'settings.account', 'settings.category.common',
  ],
  '센터장': [
    'nav.report', 'nav.settings', 'nav.staff', 'client.view.all', 'trx.view.all',
    'trx.csv', 'trx.edit', 'receipt.print', 'report.own', 'report.view.all',
    'report.approve.center', 'report.reject', 'report.revert',
    'settings.archive', 'audit.view', 'assignments.manage', 'staff.role.approve',
    'settings.client', 'settings.account', 'settings.category.common',
  ],
};
// 관리자(플래그)의 기술 권한. 업무 권한과 **직교**한다 — 이 목록에 업무 키를
// 넣으면 안 된다.
//
// audit.view 는 "누가 무엇을 언제 바꿨나"를 보는 감독 권한이다. 한때
// 담당자·팀장에게도 있었는데, 장부를 쓰는 사람이 서로의 수정 이력을 들여다볼
// 이유가 없고 설정 화면이 관리자 영역처럼 보이게 만들었다. 감독하는 자리
// (센터장·관리자)에만 둔다.
const technical = [
  'nav.settings', 'nav.staff', 'settings.staff',
  'audit.view', 'system.audit', 'system.ai', 'system.backup',
];
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
 * 절차가 생기면 열린다 — 지금까지 둘이 그렇게 열렸다.
 *
 *   시설 개설(settings.client · settings.account · settings.category.common)
 *     → saveClient 신규 등록 + accounts 규칙의 담당 범위 검사
 *   금전 기록 삭제(trx.delete · trx.delete.bulk · report.delete)
 *     → **제출 전에만** 허용. 제출 색인(locked-months.cjs)이 상태로 막는다
 *
 * 지금 비어 있다. 여기 키를 넣을 때는 "무엇이 준비되면 열리는가"를 함께 적는다 —
 * 그러지 않으면 "잠시 닫은 것"이 "영원히 없는 것"처럼 굳는다(실제로 그랬다).
 *
 * 콜러블로만 닫혀 있는 것도 성격은 같다: 입주자 비활성·물리 삭제
 * (setClientActive · deleteClient)는 보존 절차가 없어 failed-precondition 이다.
 * 정책 키가 아니라 여기 실리지 않는다.
 */
const pendingProcedure = [];

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
