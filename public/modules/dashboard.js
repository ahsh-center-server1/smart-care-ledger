/**
 * modules/dashboard.js — Smart Care Ledger v2
 * 대시보드: 입주자 카드 그리드 렌더링
 */

'use strict';

import { S } from '../state.js';
import { loadTransactions, changeView } from './core.js';
import { emptyState } from '../utils/ui.js';

export function renderDashboard() {
  const grid=document.getElementById('client-grid'); if(!grid)return;
  grid.innerHTML='';
  if (!S.clients.length) { 
    grid.innerHTML = emptyState('👤', '등록된 입주자가 없습니다.', '입주자 등록하기', "changeView('settings')");
    return; 
  }
  S.clients.forEach(client=>{
    const card=document.createElement('div'); card.className='client-card';
    // F001: 입주자별 계좌 잔액 합산 미리보기
    const totalBal=S.accounts.filter(a=>a.clientId===client.id).reduce((s,a)=>s+Number(a.currentBalance||0),0);
    const balColor=totalBal>=0?'#10b981':'#ef4444';
    const stats=S.monthlyStats?.[client.id]||{inc:0,exp:0};
    const statsText=stats.inc===0&&stats.exp===0?'당월 거래 없음':`당월 수입 <span style="color:#10b981;">+${stats.inc.toLocaleString()}</span> / 지출 <span style="color:#ef4444;">-${stats.exp.toLocaleString()}</span>원`;
    card.innerHTML=`<div class="client-avatar">${client.name.charAt(0)}</div><div class="client-name">${client.name}</div><div style="font-size:12px;font-weight:700;color:${balColor};margin-top:4px;">${totalBal.toLocaleString()}원</div><div style="font-size:11px;color:var(--muted);margin-top:3px;">${statsText}</div>`;
    card.addEventListener('click',()=>{
      S.activeClient=client.id;
      const hc=document.getElementById('h-client'); if(hc)hc.value=client.id;
      changeView('history'); loadTransactions(client.id);
    });
    grid.appendChild(card);
  });
}
