// public/domain/action-items.js
//
// 「지금 손봐야 할 것」 판정 — 순수 함수. DOM·Firestore를 모른다.
//
// 왜 필요한가
//   이 앱은 잘못된 상태를 **조용히 견딘다**. 담당자가 배정되지 않은 입주자는
//   보고서를 만들 수 없고, 팀장이 지정되지 않으면 결재가 진행되지 않고,
//   기준일 없는 계좌는 잔액을 전 기간으로 합산해 통장과 어긋난다.
//   그런데 어느 화면에도 "무엇이 잘못됐는지" 나오지 않아, 결재 마감일에
//   문제를 발견하게 된다.
//
//   여기서 그 상태를 한 번에 계산해 설정 「개요」에 띄운다.
//
// 읽기 비용
//   **추가 읽기가 없다.** 전부 이미 메모리에 있는 값(S.users·allClients·
//   allAccounts·allFixedItems·mandatoryUnpaid)으로만 계산한다.
//   진단 화면을 만들려고 컬렉션을 새로 조회하면 그 자체가 할당량을 먹는다.

'use strict';

/**
 * 조치가 필요한 항목 목록을 만든다.
 *
 * @param {Object} data
 * @param {Array}  data.users           직원 전체
 * @param {Array}  data.clients         입주자 전체(비활성 포함)
 * @param {Array}  data.accounts        계좌 전체(비활성 포함)
 * @param {Array}  data.fixedItems      고정항목 전체
 * @param {Object} data.mandatoryUnpaid { clientId: 미납건수 }
 * @param {Array|null} data.reportList  보고서 목록 (아직 안 읽었으면 null)
 * @param {Function} data.can           권한 판정 (권한 없는 항목은 내지 않는다)
 * @returns {Array<{id,label,count,tab,severity}>} severity: 'warn' | 'info'
 */
export function computeActionItems(data) {
  const {
    users = [], clients = [], accounts = [], fixedItems = [],
    mandatoryUnpaid = {}, reportList = null, can = () => true,
  } = data || {};

  const items = [];
  const push = (id, label, count, tab, severity = 'warn') => {
    if (count > 0) items.push({ id, label, count, tab, severity });
  };

  // 활성 입주자만 본다 — 퇴소한 입주자에 담당자가 없는 것은 문제가 아니다.
  const activeClients = clients.filter(c => c.active !== false);
  const activeClientIds = new Set(activeClients.map(c => c.id));

  // ── 승인 대기 직원 ──
  // 승인하지 않으면 그 사람은 로그인할 수 없다. 가입 신청을 해 두고 며칠씩
  // 기다리는 일이 실제로 생긴다.
  if (can('settings.staff')) {
    push('pendingStaff', '승인 대기 중인 직원',
      users.filter(u => u.approved === false).length, 'list');
  }

  // ── 담당자 미배정 입주자 ──
  // userIds가 비면 담당자 화면에 그 입주자가 아예 나오지 않는다.
  if (can('settings.client')) {
    push('noOwner', '담당자가 배정되지 않은 입주자',
      activeClients.filter(c => splitIds(c.userIds).length === 0).length, 'list');

    // ── 팀장 미지정 입주자 ── 1차 결재자가 없어 결재가 멈춘다.
    push('noLeader', '팀장이 지정되지 않은 입주자 (결재 진행 불가)',
      activeClients.filter(c => !String(c.teamLeader || '').trim()).length, 'list');

    // ── 계좌가 없는 입주자 ── 거래를 넣을 곳이 없다.
    const clientIdsWithAccount = new Set(
      accounts.filter(a => a.active !== false).map(a => a.clientId),
    );
    push('noAccount', '계좌가 등록되지 않은 입주자',
      activeClients.filter(c => !clientIdsWithAccount.has(c.id)).length, 'list');
  }

  // ── 기준일 없는 계좌 ──
  // initialBalanceDate가 비면 잔액식이 전 기간을 합산한다. 통장 잔액과
  // 어긋나는 원인 중 가장 찾기 어려운 것이다.
  if (can('settings.account')) {
    push('noBaseDate', '기초잔액 기준일이 없는 계좌 (잔액이 어긋날 수 있음)',
      accounts.filter(a => a.active !== false
        && activeClientIds.has(a.clientId)
        && !String(a.initialBalanceDate || '').trim()).length, 'list');

    // ── 비활성 입주자에 남은 활성 계좌 ── 목록에 계속 뜨며 혼란을 준다.
    push('orphanAccount', '퇴소한 입주자에 남아 있는 활성 계좌',
      accounts.filter(a => a.active !== false && !activeClientIds.has(a.clientId)).length,
      'list', 'info');
  }

  // ── 당월 필수 고정항목 미납 ──
  if (can('settings.fixed')) {
    const unpaid = Object.entries(mandatoryUnpaid)
      .filter(([cid]) => activeClientIds.has(cid))
      .reduce((sum, [, n]) => sum + Number(n || 0), 0);
    push('unpaidFixed', '이번 달 아직 입력되지 않은 필수 고정항목', unpaid, 'fixed');

    // ── 계좌가 사라진 고정항목 ── 「고정항목 입력」이 그 건만 조용히 실패한다.
    const accountIds = new Set(accounts.map(a => a.id));
    push('brokenFixed', '계좌가 삭제된 고정항목 (입력이 실패함)',
      fixedItems.filter(f => f.accountId && !accountIds.has(f.accountId)).length, 'fixed');
  }

  // ── 결재가 멈춘 보고서 ──
  // reportList가 null이면 아직 안 읽은 것이다. 이 화면을 위해 새로 읽지는 않는다
  // (읽기 비용을 쓰지 않는 것이 이 진단의 전제다).
  if (reportList && can('report.view.all')) {
    const stalled = reportList.filter(
      r => r.status === 'submitted' || r.status === 'team_approved',
    ).length;
    push('pendingApproval', '결재를 기다리는 보고서', stalled, null, 'info');

    push('rejected', '반려된 채로 남아 있는 보고서',
      reportList.filter(r => r.status === 'rejected').length, null, 'info');
  }

  // 심각한 것(warn)을 위로, 같은 등급 안에서는 건수가 많은 것을 위로.
  const rank = s => (s === 'warn' ? 0 : 1);
  return items.sort((a, b) => rank(a.severity) - rank(b.severity) || b.count - a.count);
}

/** 'a, b , c' → ['a','b','c'] (빈 값 제거) */
export function splitIds(v) {
  return String(v == null ? '' : v)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
