'use strict';

import { S } from '../state.js';
import { escAttr } from '../utils/ui.js';
import { FORBIDDEN_KEYS, PENDING_PROCEDURE_KEYS, unavailableMessage } from './permissions.js';

/**
 * 역할별 안내.
 *
 * `lacks` 가 **가장 쓸모 있는 칸이다.** 사용자가 이 화면에 오는 이유는 대개
 * "버튼이 왜 없지?" 이고, 할 수 있는 일만 적어 두면 그 질문에 답하지 못한다.
 * 없는 것을 먼저 말해 주면 상급자에게 물으러 가는 발걸음이 줄어든다.
 * 근거는 CLAUDE.md §4 의 역할 표다.
 */
const ROLE_GUIDE = {
  '입력자': {
    scope: '배정된 입주자의 본인 작성 자료',
    tasks: ['거래 입력과 본인 미제출 자료 정정', '본인 거래에 영수증 추가', '제출·확정 자료는 담당자에게 정정 요청'],
    lacks: ['동료가 입력한 거래 조회', '엑셀 업로드', '보고서', '설정'],
  },
  '담당자': {
    scope: '배정된 입주자',
    tasks: ['담당 장부 관리와 미제출 자료 정정', '증빙·엑셀·통장 사진 입력', '보고서 작성·제출과 반려 자료 보완', '담당 입주자의 계좌·분류·고정항목·예산'],
    lacks: ['결재', '입주자·공통분류 신규 개설', '변경 이력 조회'],
  },
  '팀장': {
    scope: '담당 팀장으로 지정된 입주자',
    tasks: ['지정된 입주자 자료 검토와 1차 결재', '오류 자료 반려·정정 요청', '담당 배정', '입주자·계좌·공통분류 개설'],
    lacks: ['거래 입력·수정', '보고서 작성·제출', '변경 이력 조회'],
  },
  '센터장': {
    scope: '시설 전체 입주자',
    tasks: ['시설 전체 자료 검토와 최종 결재', '사유를 기록한 확정 취소와 재결재', '연도 마감', '담당 배정과 시설 개설'],
    lacks: ['거래 입력·수정', '보고서 작성·제출', '1차 결재(팀장 단계)'],
  },
};
export function renderPermissionPanel() {
  const container = document.getElementById('permission-panel-content');
  if (!container) return;
  if (!S.user) {
    container.innerHTML = '<p role="status">내 역할 정보를 확인하고 있습니다. 로그인이 완료된 뒤 다시 열어 주세요.</p>';
    return;
  }
  const ready = S.authzStatus === 'ready' && !!S.authz && S.user.userId === S.authz.uid;
  const identity = ready ? S.authz : S.user;
  if (S.user.active === false || (ready && identity.enabled !== true)) {
    container.innerHTML = '<p role="alert">비활성 계정입니다. 업무에 접근할 수 없습니다. 계정 담당자에게 확인해 주세요.</p>';
    return;
  }
  const role = typeof identity.role === 'string' ? identity.role : '';
  const guide = Object.hasOwn(ROLE_GUIDE, role) ? ROLE_GUIDE[role] : null;
  const technicalOnly = role === '' && identity.isAdmin === true;
  const assigned = role === '팀장' ? (S.authz?.leaderClientIds ?? S.leaderClientIds) : S.accessibleClientIds;
  const ids = Array.isArray(assigned) ? [...new Set(assigned.filter(id => typeof id === 'string' && id))] : [];
  const capsReady = ready && S.caps !== null && typeof S.caps === 'object' && !Array.isArray(S.caps);
  const capsEmpty = capsReady && !Object.values(S.caps).some(value => value === true);
  // 상태는 **색으로 먼저 읽힌다.** 예전에는 네 상태가 다 같은 문단이라,
  // "권한을 못 불러왔다"와 "확인했다"가 한눈에 구분되지 않았다.
  const banner = (tone, text, role_) => {
    const c = { bad: ['#fef2f2', '#fecaca', '#991b1b'], warn: ['#fffbeb', '#fde68a', '#92400e'],
      ok: ['#f0fdf4', '#bbf7d0', '#166534'] }[tone];
    return `<p role="${role_}" style="margin:0 0 16px 0;padding:12px 14px;background:${c[0]};`
      + `border:1px solid ${c[1]};border-left:4px solid ${c[2]};border-radius:8px;`
      + `color:${c[2]};font-size:13px;line-height:1.6;">${escAttr(text)}</p>`;
  };
  const status = S.authzStatus === 'error'
    ? banner('bad', '서버 권한 정보를 불러오지 못했습니다. 업무 접근은 허용되지 않습니다. 다시 로그인하거나 계정 담당자에게 확인해 주세요.', 'alert')
    : !capsReady
      ? banner('warn', '서버 권한 정보가 아직 확인되지 않았습니다. 아래는 역할별 안내이며 현재 접근 허용을 보장하지 않습니다.', 'status')
      : capsEmpty
        ? banner('warn', '현재 허용된 업무가 없습니다. 역할·담당 배정과 계정 상태를 계정 담당자에게 확인해 주세요.', 'status')
        : banner('ok', '서버 권한 정보를 확인했습니다. 개별 자료의 작성자·담당 범위·결재 상태에 따라 실행이 제한될 수 있습니다.', 'status');

  const chip = (text, bg, fg, bd) => `<span style="display:inline-block;padding:4px 10px;`
    + `border-radius:99px;background:${bg};color:${fg};border:1px solid ${bd};`
    + `font-size:12px;font-weight:800;">${escAttr(text)}</span>`;

  const roleLabel = guide ? role : technicalOnly ? '업무 역할 없음' : '업무 역할 미지정';
  const scopeText = guide?.scope
    || (technicalOnly ? '시스템 관리 업무만 가능' : '업무 역할과 담당 배정을 먼저 확인해 주세요');
  const assignText = !capsReady ? '확인 대기'
    : technicalOnly ? '담당 범위 없음'
      : role === '센터장' ? '시설 전체'
        : ids.length ? `입주자 ${ids.length}명` : '배정 없음';

  // 두 칸을 나란히 — 「할 수 있는 일」만 있으면 "왜 버튼이 없지?"에 답하지 못한다.
  const col = (title, items, mark, color) => `
    <div style="flex:1 1 220px;min-width:0;">
      <div style="font-size:13px;font-weight:800;color:${color};margin-bottom:8px;">${escAttr(title)}</div>
      <ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;">
        ${items.map(t => `<li style="display:flex;gap:8px;font-size:13px;line-height:1.5;">`
          + `<span style="color:${color};font-weight:800;flex:none;">${mark}</span>`
          + `<span>${escAttr(t)}</span></li>`).join('')}
      </ul>
    </div>`;

  const roleBody = guide
    ? `<div style="display:flex;flex-wrap:wrap;gap:24px;">
         ${col('할 수 있는 일', guide.tasks, '✓', '#15803d')}
         ${col('갖지 않는 것', guide.lacks, '✕', '#b91c1c')}
       </div>`
    : technicalOnly
      ? '<p style="margin:0;font-size:13px;">업무 역할 없이 시스템 관리자 자격만 부여된 계정입니다.</p>'
      : '<p role="alert" style="margin:0;font-size:13px;">알 수 없는 업무 역할입니다.'
        + ' 업무 권한을 추정하지 않습니다. 계정 담당자에게 역할 지정을 요청해 주세요.</p>';

  const card = (title, inner) => `
    <div class="ui-card" style="padding:18px;margin-bottom:14px;">
      <h3 style="margin:0 0 12px 0;font-size:15px;font-weight:800;">${escAttr(title)}</h3>
      ${inner}
    </div>`;

  // 누구에게도 열리지 않는 기능.
  //
  // 이것이 없으면 사용자는 사라진 버튼을 보고 "내 등급이 낮아서"라고 읽고
  // 상급자에게 요청하러 간다 — 그쪽도 못 하므로 서로 시간만 쓴다.
  // 빈 부류는 아예 그리지 않는다: 제목만 있고 목록이 비면
  // "여기 뭔가 있었는데 안 보인다"로 읽힌다.
  const group = (title, keys, tone) => (keys.length
    ? `<div style="margin-bottom:12px;">
         <div style="font-size:13px;font-weight:800;color:${tone};margin-bottom:6px;">${escAttr(title)}</div>
         <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:var(--muted-foreground);">
           ${keys.map(k => `<li>${escAttr(unavailableMessage(k).split(':')[0])}</li>`).join('')}
         </ul>
       </div>`
    : '');

  const adminCard = identity.isAdmin === true && (guide || technicalOnly)
    ? card('시스템 관리 업무', `
        <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;">
          <li>직원 계정 운영과 승인된 역할 변경 실행</li>
          <li>AI 설정·백업·보안 감사 확인</li>
          <li>역할·관리자 변경은 승인자가 따로 필요하며, 다른 승인자가 없으면 보류됩니다</li>
        </ul>
        <p style="margin:10px 0 0 0;font-size:13px;color:#b45309;">
          관리자 자격만으로는 <strong>금전 자료 수정이나 결재 권한이 생기지 않습니다.</strong>
          업무 권한은 위의 역할이 정합니다.</p>`)
    : '';

  container.innerHTML = `
    <section aria-label="내 역할 안내" style="color:var(--text);">
      ${status}
      ${card('내 역할', `
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
          ${chip(roleLabel, '#eff6ff', '#1d4ed8', '#bfdbfe')}
          ${identity.isAdmin === true ? chip('시스템 관리자', '#faf5ff', '#7e22ce', '#e9d5ff') : ''}
        </div>
        <dl style="margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;line-height:1.6;">
          <dt style="color:var(--muted-foreground);font-weight:700;">업무 범위</dt><dd style="margin:0;">${escAttr(scopeText)}</dd>
          <dt style="color:var(--muted-foreground);font-weight:700;">현재 배정</dt><dd style="margin:0;">${escAttr(assignText)}</dd>
        </dl>`)}
      ${card('이 역할이 하는 일', roleBody)}
      ${adminCard}
      ${card('아무도 할 수 없는 일', `
        <p style="margin:0 0 12px 0;font-size:13px;line-height:1.6;color:var(--muted-foreground);">
          아래는 역할과 무관하게 <strong>누구에게도</strong> 열리지 않습니다.
          등급 문제가 아니므로 상급자에게 요청해도 실행할 수 없습니다.</p>
        ${group('영구히 제공되지 않음', FORBIDDEN_KEYS, '#b91c1c')}
        ${group('절차 준비 중 — 마련되면 열립니다', PENDING_PROCEDURE_KEYS, '#b45309')}
        <p style="margin:0;font-size:13px;line-height:1.6;color:var(--muted-foreground);">
          기록을 지우는 대신 정정 거래를 입력하고, 마감된 자료는
          확정 취소 → 수정 → 재결재 절차를 따릅니다.</p>`)}
      <p style="margin:0;font-size:12px;line-height:1.7;color:var(--muted-foreground);">
        이 화면에서는 권한을 바꿀 수 없습니다. 역할·담당 변경은 직원·담당 배정 절차로 요청합니다.</p>
    </section>`;
}
