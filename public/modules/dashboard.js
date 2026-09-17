/**
 * modules/dashboard.js — Smart Care Ledger v2
 * 대시보드: 입주자 카드 그리드 렌더링
 */

'use strict';

import { S } from '../state.js';
import { loadTransactions, changeView } from './core.js';
import { escHtml } from '../utils/ui.js';
import { renderSetupWizard } from './setup.js';

export function renderDashboard() {
  const grid=document.getElementById('client-grid'); if(!grid)return;
  grid.innerHTML='';

  // 준비가 덜 됐으면 초기 설정 마법사를 대신 보여준다.
  // 예전에는 "설정으로" 버튼 하나였는데, 등록 권한이 없는 사용자에게는
  // 설정 화면의 +등록 버튼이 숨겨져 있어 막다른 길이었다.
  if (renderSetupWizard()) return;

  if (!S.clients.length) {
    // 조직에는 입주자가 있지만 본인 담당이 배정되지 않은 경우
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="icon" aria-hidden="true">👤</div>
        <p>담당으로 지정된 입주자가 없습니다.<br>
        관리자나 팀장에게 담당 배정을 요청하세요.</p>
      </div>`;
    return;
  }
  S.clients.forEach(client=>{
    const card=document.createElement('div'); card.className='client-card';
    // 입주자별 계좌 잔액 합산.
    // currentBalance는 Cloud Functions의 syncAccountBalance 트리거가 전체 거래를
    // 근거로 계산해 소유한다. 대시보드는 거래를 로드하지 않으므로 이 값을 그대로 쓴다.
    const totalBal=S.accounts.filter(a=>a.clientId===client.id).reduce((s,a)=>s+Number(a.currentBalance||0),0);
    const balColor=totalBal>=0?'#10b981':'#ef4444';
    const stats=S.monthlyStats?.[client.id]||{inc:0,exp:0};
    // 입력자는 본인이 입력한 거래만 읽을 수 있으므로 그 합계는 당월 전체가 아니다.
    // 그것을 「당월 수입/지출」로 적으면 같은 카드가 사람에 따라 다른 금액을 보여준다.
    // 라벨을 바꿔 무엇을 더한 값인지 밝힌다.
    const statsLabel=stats.partial?'당월 본인 입력분':'당월';
    const statsText=stats.inc===0&&stats.exp===0
      ?(stats.partial?'당월 본인 입력분 없음':'당월 거래 없음')
      :`${statsLabel} 수입 <span style="color:#10b981;">+${stats.inc.toLocaleString()}</span> / 지출 <span style="color:#ef4444;">-${stats.exp.toLocaleString()}</span>원`;
    const unpaidCount=Number(S.mandatoryUnpaid?.[client.id]||0);
    const unpaidHTML=unpaidCount>0?`<div style="font-size:11px;color:#dc2626;font-weight:700;margin-top:3px;">⚠️ 필수항목 ${unpaidCount}건 미납</div>`:'';
    // 미분류는 월말에 몰아서 정리하는 일이라, 쌓이는 것을 미리 보여 준다.
    // **당월 기준**임을 밝힌다 — 요약 캐시가 당월만 담으므로 과거 건은 안 잡힌다.
    const unclassified=Number(stats.unclassified||0);
    const unclassifiedHTML=unclassified>0
      ?`<div style="font-size:11px;color:#b45309;font-weight:700;margin-top:3px;">🏷️ 당월 미분류 ${unclassified}건</div>`
      :'';
    const safeName=client.name||'(이름 없음)';
    card.innerHTML=`<div class="client-avatar">${escHtml(safeName.charAt(0))}</div><div class="client-name">${escHtml(safeName)}</div><div style="font-size:12px;font-weight:700;color:${balColor};margin-top:4px;">${totalBal.toLocaleString()}원</div><div style="font-size:11px;color:var(--muted);margin-top:3px;">${statsText}</div>${unpaidHTML}${unclassifiedHTML}`;
    card.addEventListener('click',()=>{
      S.activeClient=client.id;
      const hc=document.getElementById('h-client'); if(hc)hc.value=client.id;
      changeView('history'); loadTransactions(client.id);
    });
    grid.appendChild(card);
  });
}
