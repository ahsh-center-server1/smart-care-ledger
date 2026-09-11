// public/domain/audit.js
//
// 변경 이력(감사 로그) — 순수 모듈. DOM·Firestore를 모른다.
//
// 왜 필요한가
//   여러 직원이 같은 입주자의 금전 데이터를 만지는데 **누가 무엇을 언제 바꿨는지
//   기록이 전혀 없었다.** 잔액이 어긋났을 때, 결재가 취소됐을 때, 카테고리가
//   통째로 초기화됐을 때 — 원인을 찾을 방법이 없다. 사회복지시설의 금전관리는
//   외부 점검 대상이기도 하다.
//
// 이 기록이 보장하는 것과 못 하는 것 (정직하게)
//   보장: 한 번 쓰인 기록은 **수정·삭제할 수 없다**(규칙에서 update/delete 금지).
//         기록의 작성자는 **위조할 수 없다**(actorUid == 토큰 uid를 규칙이 검사).
//         시각은 **소급할 수 없다**(timestamp == request.time을 규칙이 검사).
//   못 함: 클라이언트가 뮤테이션을 하면서 **로그를 안 쓰는 것**은 막을 수 없다.
//         이 앱은 브라우저가 Firestore에 직접 쓰기 때문이다. 그것까지 막으려면
//         모든 쓰기를 Cloud Functions로 옮겨야 한다(다음 단계 과제).
//         그래서 이 기록은 "추가만 되는 정직한 장부"이지 "빠짐없는 장부"는 아니다.
//
// 보관
//   expireAt 필드에 Firestore TTL 정책을 걸어 2년 후 자동 삭제한다.
//   기록을 지우는 코드를 두지 않아도 저장 비용이 무한정 늘지 않는다.

'use strict';

/** 보관 기간. 회계 관련 기록이므로 2년으로 잡았다. */
export const AUDIT_RETENTION_DAYS = 730;

/**
 * 액션 코드 → 한글 설명.
 *
 * 이 표가 **모든 액션 코드의 유일한 목록이다.** 코드를 새로 쓰면서 여기에
 * 넣지 않으면 화면에 코드 문자열이 그대로 노출된다 —
 * test/audit.test.mjs가 라벨 없는 코드를 잡는다.
 */
export const ACTION_LABELS = {
  // 거래
  'trx.create':          '거래 입력',
  'trx.update':          '거래 수정',
  'trx.delete':          '거래 삭제',
  'trx.bulkDelete':      '거래 일괄 삭제',
  'trx.reorder':         '거래 순서 변경',
  'trx.transfer':        '자산이동 입력',

  // 엑셀·증빙
  'excel.upload':        '엑셀 업로드',
  'receipt.upload':      '증빙 첨부',
  'receipt.attach':      '기존 거래 증빙 연결',
  'receipt.create':      '영수증 거래 자동 입력',
  'receipt.remove':      '증빙 연결 해제',
  'receipt.orphan':      '확인 필요 증빙 발견',
  'receipt.delete':      '증빙 삭제',
  'receipt.missing':     '증빙 분실 표시',
  'bankbook.upload':     '통장 사진 업로드',

  // 보고서·결재
  'report.save':         '보고서 임시저장',
  'report.submit':       '보고서 제출',
  'report.approveTeam':  '팀장 결재',
  'report.approveCenter':'센터장 최종 결재',
  'report.reject':       '보고서 반려',
  'report.recall':       '보고서 회수',
  'report.revert':       '결재 취소',
  'report.release':      '반려 해제',
  'report.delete':       '보고서 삭제',
  'report.transition':   '보고서 상태 전이',

  // 입주자·계좌
  'client.create':       '입주자 등록',
  'client.update':       '입주자 수정',
  'client.delete':       '입주자 삭제',
  'client.activeChange': '입주자 활성/비활성',
  'account.create':      '계좌 등록',
  'account.update':      '계좌 수정',
  'account.delete':      '계좌 삭제',
  'account.activeChange':'계좌 활성/비활성',

  // 직원 (서버에서 기록)
  'staff.create':        '직원 등록',
  'staff.update':        '직원 정보 수정',
  'staff.approve':       '가입 승인',
  'staff.activeChange':  '직원 재직/퇴사',
  'staff.passwordReset': '비밀번호 초기화',

  // 분류·규칙·고정항목·예산
  'category.create':     '분류 추가',
  'category.delete':     '분류 삭제',
  'category.reorder':    '분류 순서 변경',
  'category.reset':      '분류 기본값 초기화',
  'rule.create':         '자동분류 규칙 추가',
  'rule.delete':         '자동분류 규칙 삭제',
  'fixedItem.create':    '고정항목 등록',
  'fixedItem.update':    '고정항목 수정',
  'fixedItem.delete':    '고정항목 삭제',
  'fixedItem.apply':     '고정항목 일괄 입력',
  'budget.update':       '예산 설정',

  // 시스템
  'permissions.update':  '권한 등급표 변경',
  'archive.run':         '연도 마감 실행',
  'archive.failed':      '연도 마감 실패',
  'data.reset':          '전체 초기화 실행',
  'data.resetFailed':    '전체 초기화 실패',
  'lockIndex.rebuild':   '마감 색인 재생성',

  // 인증 (서버에서 기록)
  'login.success':       '로그인',
  'login.failed':        '로그인 실패',
  'login.locked':        '로그인 잠금',

  // 자동입력
  'ai.receiptAnalyze':   '영수증 사진 분석',
};

/** 유효한 액션 코드인가. */
export function isKnownAction(action) {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, action);
}

/** 화면에 보일 설명. 모르는 코드도 화면을 깨뜨리지 않고 코드를 그대로 보여준다. */
export function actionLabel(action) {
  return ACTION_LABELS[action] || String(action || '알 수 없는 작업');
}

/**
 * 액션 코드의 리소스 접두어. 조회 화면의 분류 필터가 쓴다.
 * 'report.approveTeam' → 'report'
 */
export function actionResource(action) {
  return String(action || '').split('.')[0] || '';
}

/** 조회 화면의 분류 필터 선택지 — 라벨 표에서 파생하므로 어긋날 수 없다. */
export const AUDIT_RESOURCES = (() => {
  const names = {
    trx: '거래', excel: '엑셀', receipt: '증빙', bankbook: '통장 사진',
    report: '보고서·결재', client: '입주자', account: '계좌', staff: '직원',
    category: '분류', rule: '자동분류 규칙', fixedItem: '고정항목',
    budget: '예산', permissions: '권한', archive: '마감', data: '초기화',
    lockIndex: '마감 색인', login: '로그인', ai: '자동입력',
  };
  const seen = [...new Set(Object.keys(ACTION_LABELS).map(actionResource))];
  return seen.map(key => ({ key, label: names[key] || key }));
})();

/**
 * 보관 만료 시각. Firestore TTL 정책이 이 필드를 본다.
 * @param {Date|number} [now]
 * @returns {Date}
 */
export function auditExpireAt(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  return new Date(ms + AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * 기록 한 건을 만든다.
 *
 * timestamp는 여기서 넣지 않는다 — 서버 시각(serverTimestamp)을 써야 소급
 * 기록을 막을 수 있고, 그 값은 Firestore SDK만 만들 수 있다. 쓰기 계층
 * (services/audit.js)이 채운다.
 *
 * @param {Object} p
 * @param {string} p.action     액션 코드 (ACTION_LABELS의 키)
 * @param {Object} p.actor      { userId, name, role }
 * @param {string} [p.resourceId] 대상 문서 id (거래 id, 입주자 id 등)
 * @param {Object} [p.summary]  사람이 읽을 요약. **금액·이름 외 민감 정보를 넣지 않는다.**
 * @param {Date|number} [p.now]
 * @returns {Object} Firestore에 쓸 필드 (timestamp 제외)
 */
export function buildAuditEntry({ action, actor, resourceId, summary, now = Date.now() }) {
  if (!action) throw new Error('감사 기록: action이 필요합니다');
  if (!actor || !actor.userId) throw new Error('감사 기록: actor.userId가 필요합니다');

  const entry = {
    action: String(action),
    // 규칙이 actorUid == 토큰 uid 를 검사한다. 마이그레이션 후 uid == userId.
    actorUid: String(actor.userId),
    actorName: String(actor.name || actor.userId),
    actorRole: String(actor.role || ''),
    expireAt: auditExpireAt(now),
  };
  if (resourceId) entry.resourceId = String(resourceId);
  if (summary && Object.keys(summary).length) entry.summary = pruneSummary(summary);
  return entry;
}

/**
 * 요약에서 빈 값을 걷어내고 문자열 길이를 제한한다.
 *
 * 길이를 제한하는 이유: 요약에 거래 내용이나 의견 전문이 들어가면
 * (1) 문서가 커져 조회 대역폭을 먹고 (2) 기록 자체가 개인정보 사본이 된다.
 * 무엇이 바뀌었는지 알 만큼만 남긴다.
 */
export function pruneSummary(summary, maxLen = 120) {
  const out = {};
  for (const [k, v] of Object.entries(summary || {})) {
    if (v == null || v === '') continue;
    out[k] = typeof v === 'string' && v.length > maxLen
      ? v.slice(0, maxLen) + '…'
      : v;
  }
  return out;
}

/**
 * 요약을 한 줄 문장으로 만든다. 조회 화면이 쓴다.
 * 키 이름을 한글로 바꿔 "clientName=홍길동" 같은 표시를 피한다.
 */
const SUMMARY_LABELS = {
  clientName: '입주자', accountLabel: '계좌', date: '날짜', amount: '금액',
  count: '건수', year: '연도', month: '월', category: '분류',
  from: '이전', to: '이후', role: '역할', reason: '사유',
  filename: '파일', keyword: '키워드', field: '항목', target: '대상',
};

export function summaryText(summary) {
  const parts = [];
  for (const [k, v] of Object.entries(summary || {})) {
    const label = SUMMARY_LABELS[k] || k;
    parts.push(`${label} ${formatValue(v)}`);
  }
  return parts.join(' · ');
}

function formatValue(v) {
  if (typeof v === 'number') return v.toLocaleString('ko-KR');
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  return String(v);
}
