'use strict';

import { S } from '../state.js';
import { escAttr } from '../utils/ui.js';
import { FORBIDDEN_KEYS, PENDING_PROCEDURE_KEYS, unavailableMessage } from './permissions.js';

const ROLE_GUIDE = {
  '입력자': { scope: '배정된 입주자의 본인 작성 자료 중심', tasks: ['거래 입력과 본인 미제출 자료 정정', '본인 거래에 영수증 추가', '제출·확정 자료는 담당자에게 정정 요청'] },
  '담당자': { scope: '배정된 입주자', tasks: ['담당 장부 관리와 미제출 자료 정정', '증빙·엑셀·통장 사진 입력', '보고서 작성·제출과 반려 자료 보완'] },
  '팀장': { scope: '담당 팀장으로 지정된 입주자', tasks: ['지정된 입주자 자료 검토와 1차 결재', '오류 자료 반려·정정 요청', '담당 배정 검토'] },
  '센터장': { scope: '시설 전체 입주자', tasks: ['시설 전체 자료 검토와 최종 결재', '사유를 기록한 확정 취소와 재결재', '마감 및 중요한 운영 변경 승인'] },
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
  const status = S.authzStatus === 'error'
    ? '<p role="alert">서버 권한 정보를 불러오지 못했습니다. 업무 접근은 허용되지 않습니다. 다시 로그인하거나 계정 담당자에게 확인해 주세요.</p>'
    : !capsReady
    ? '<p role="status">서버 권한 정보가 아직 확인되지 않았습니다. 아래 내용은 역할별 업무 안내이며 현재 접근 허용을 보장하지 않습니다. 계속되면 다시 로그인하거나 계정 담당자에게 확인해 주세요.</p>'
    : capsEmpty
      ? '<p role="status">현재 허용된 업무가 없습니다. 역할·담당 배정 및 계정 상태를 계정 담당자에게 확인해 주세요.</p>'
      : '<p>서버 권한 정보를 확인했습니다. 아래는 역할별 업무 안내이며, 개별 자료의 작성자·담당 범위·결재 상태에 따라 실행이 제한됩니다.</p>';
  // 누구에게도 열리지 않는 기능 안내.
  //
  // 이것이 없으면 사용자는 사라진 버튼을 보고 "내 등급이 낮아서"라고 읽고,
  // 팀장·센터장에게 요청하러 간다. 그쪽도 못 하므로 서로 시간만 쓴다.
  // 그래서 "누구도 못 한다"와 "언젠가 열린다"를 여기서 분명히 말해 둔다.
  const unavailable = `
      <h3>제공되지 않는 기능</h3>
      <p>아래는 역할과 무관하게 <strong>누구에게도</strong> 열리지 않습니다. 등급 문제가 아니므로 상급자에게 요청해도 실행할 수 없습니다.</p>
      <dl>
        <dt>영구히 제공되지 않음</dt>
        <dd><ul>${FORBIDDEN_KEYS.map(key => `<li>${escAttr(unavailableMessage(key).split(':')[0])}</li>`).join('')}</ul></dd>
        <dt>절차 준비 중 — 마련되면 열림</dt>
        <dd><ul>${PENDING_PROCEDURE_KEYS.map(key => `<li>${escAttr(unavailableMessage(key).split(':')[0])}</li>`).join('')}</ul></dd>
      </dl>
      <p style="color:var(--muted);">기록을 지우는 대신 정정 거래를 입력하거나, 마감된 자료는 확정 취소 → 수정 → 재결재 절차를 따릅니다.</p>`;

  container.innerHTML = `
    <section aria-label="내 역할 안내" style="color:var(--text);line-height:1.7;">
      <h3>내 역할과 담당 범위</h3>
      <dl>
        <dt>업무 역할</dt><dd>${escAttr(guide ? role : technicalOnly ? '업무 역할 없음' : '업무 역할 미지정')}</dd>
        <dt>시스템 관리자</dt><dd>${identity.isAdmin === true ? '지정됨' : '지정되지 않음'}</dd>
        <dt>역할의 업무 범위</dt><dd>${escAttr(guide?.scope || (technicalOnly ? '시스템 관리 업무만 가능' : '업무 역할과 담당 배정을 먼저 확인해 주세요.'))}</dd>
        <dt>현재 배정 정보</dt><dd>${capsReady ? (technicalOnly ? '금융 업무 담당 범위 없음' : role === '센터장' ? '시설 전체 입주자' : ids.length ? `입주자 ${ids.length}명 배정` : '개별 담당 배정 없음') : '확인 대기'}</dd>
      </dl>
      <p>시스템 관리자 자격만으로 금융 자료 수정이나 결재 권한이 부여되지 않습니다.</p>
      ${status}
      <h3>역할별 허용 업무 안내</h3>
      ${guide ? `<ul>${guide.tasks.map(task => `<li>${escAttr(task)}</li>`).join('')}</ul>` : technicalOnly ? '<p>업무 역할 없이 시스템 관리자 자격만 부여된 계정입니다.</p>' : '<p role="alert">알 수 없는 업무 역할입니다. 업무 권한을 추정하지 않습니다. 계정 담당자에게 역할 지정을 요청해 주세요.</p>'}
      ${identity.isAdmin === true && (guide || technicalOnly) ? '<h3>시스템 관리 업무 안내</h3><ul><li>직원 계정 운영과 승인된 역할 변경 실행</li><li>AI 설정·백업·보안 감사 확인</li><li>역할·관리자 변경은 별도 승인자가 필요하며, 다른 승인자가 없으면 보류</li></ul>' : ''}
      ${unavailable}
      <p style="color:var(--muted);">이 화면에서는 권한을 변경할 수 없습니다. 역할과 담당 변경은 직원·담당 배정 절차로 요청합니다. 마감 자료는 직접 수정하지 않고 확정 취소·수정·재결재 절차를 따릅니다.</p>
    </section>`;
}
