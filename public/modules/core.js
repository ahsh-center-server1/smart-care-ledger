/**
 * modules/core.js — Smart Care Ledger v2
 * 코어 흐름: 기본 데이터 로드, 거래 로드, 뷰 전환
 *
 * 순환 import 안전성:
 *   - core.js → Dash/Trx/Rpt/Settings (이 파일이 먼저 import)
 *   - Dash/Trx/Rpt/Settings → core.js (Tasks 2~4 이후 추가 예정)
 *   - 양방향 모두 함수 바디 내 호출만 있으므로 모듈 초기화 시점 undefined 없음
 */
'use strict';

import { S } from '../state.js';
import { COLS } from '../constants.js';
import { toast, showLoading, setText } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import * as Dash     from './dashboard.js';
import * as Trx      from './transactions.js';
import * as Rpt      from './report.js';
import * as Settings from './settings.js';
import { can } from './permissions.js';

export async function fetchBaseData() {
  const { getDocs, collection, query, where } = fb();
  const db=fdb(), isAdmin=can('nav.staff');
  const [uSnap,cSnap,aSnap,catSnap,rSnap] = await Promise.all([
    getDocs(collection(db,COLS.USERS)),
    getDocs(collection(db,COLS.CLIENTS)),
    getDocs(collection(db,COLS.ACCOUNTS)),
    getDocs(collection(db,COLS.CATEGORIES)),
    getDocs(collection(db,COLS.REPORTS)),
  ]);
  S.users      = uSnap.docs.map(d=>{const u={id:d.id,...d.data()};u.team=u.team||'';return u;});
  S.categories = catSnap.docs.map(d=>({id:d.id,...d.data()}));
  const allClients  = cSnap.docs.map(d=>({id:d.id,...d.data()}));
  const allAccounts = aSnap.docs.map(d=>({id:d.id,...d.data()}));
  const showInactive=S.settings?.showInactive||false;
  const activeClients=showInactive?allClients:allClients.filter(c=>c.active!==false);
  const activeAccounts=showInactive?allAccounts:allAccounts.filter(a=>a.active!==false);
  S.clients  = isAdmin ? activeClients : activeClients.filter(c=>String(c.userIds||'').split(',').map(s=>s.trim()).includes(String(S.user.userId)));
  S.accounts = activeAccounts.filter(a=>S.clients.some(c=>c.id===a.clientId));
  S.confirmedMonths=new Set(rSnap.docs.map(d=>d.data()).filter(r=>r.status==='confirmed').map(r=>`${r.clientId}_${r.year}-${String(r.month).padStart(2,'0')}`));
  // 당월 수입/지출 집계 (대시보드 카드 표시용)
  try {
    const now=new Date();
    const ym=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
    const ymStart=ym+'-01';
    const lastDay=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
    const ymEnd=ym+'-'+String(lastDay).padStart(2,'0');
    const tSnap=await getDocs(query(collection(db,COLS.TRANSACTIONS),where('date','>=',ymStart),where('date','<=',ymEnd)));
    const mStats={};
    S.clients.forEach(c=>{ mStats[c.id]={inc:0,exp:0}; });
    tSnap.docs.forEach(d=>{
      const t=d.data();
      if(!mStats[t.clientId])return;
      if(t.type==='수입')       mStats[t.clientId].inc+=Number(t.amountIn||0);
      else if(t.type==='지출') mStats[t.clientId].exp+=Number(t.amountOut||0);
      // 자산이동, 취소 → 집계 제외
    });
    S.monthlyStats=mStats;
  } catch(e) { S.monthlyStats={}; }
  rebuildSelectors();
}

export function isConfirmedLocked(clientId, dateStr){
  const ym=(dateStr||'').substring(0,7);
  return !!(S.confirmedMonths?.has(`${clientId}_${ym}`));
}

export async function loadTransactions(clientId) {
  if (!clientId) return;
  showLoading(true);
  try {
    const { getDocs, collection, query, where } = fb();
    const snap = await getDocs(query(collection(fdb(),COLS.TRANSACTIONS), where('clientId','==',clientId)));
    let allTrx = snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!can('trx.view.all')) allTrx=allTrx.filter(t=>t.createdBy===S.user.userId);
    S.transactions = allTrx.sort((a,b)=>{
      const oA=a.sortOrder!=null?a.sortOrder:99999;
      const oB=b.sortOrder!=null?b.sortOrder:99999;
      if(oA!==oB)return oA-oB;
      const dtA=(a.date||'')+(a.time?' '+a.time:'');
      const dtB=(b.date||'')+(b.time?' '+b.time:'');
      return dtA.localeCompare(dtB);
    });
    S.activeClient=clientId; S.page=1; S.sortKey='date'; S.sortDir='asc';
    Trx.rebuildAccountFilter();
    Trx.applyFilters();
    Rpt.syncReportTrxList();
  } catch(e) { toast('거래 로드 실패: '+e.message,'error'); }
  showLoading(false);
}

export function rebuildSelectors() {
  ['h-client','r-client','a-client'].forEach(id=>{
    const sel=document.getElementById(id); if(!sel)return;
    const prev=sel.value;
    sel.innerHTML='<option value="">입주자 선택...</option>';
    S.clients.forEach(c=>sel.add(new Option(c.name,c.id)));
    if (S.clients.some(c=>c.id===prev)) sel.value=prev;
  });
  Trx.rebuildAccountFilter();
}

export function changeView(view) {
  if(view==='management') view='settings';
  if((view==='report'&&!can('nav.report'))||(view==='settings'&&!can('nav.settings'))){
    toast('접근 권한이 없습니다.','error'); return;
  }
  if(view==='annual'){ changeView('report'); switchRptSubtab('annual'); return; }
  if(view!=='report'){
    const ra=document.getElementById('report-area');
    if(ra)ra.style.display='none';
    S.reportData=null;
  }
  ['dashboard','history','report','settings'].forEach(v=>{
    const el=document.getElementById('view-'+v); if(el)el.style.display=v===view?'block':'none';
  });
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.querySelector(`.nav-item[data-view="${view}"]`)?.classList.add('active');
  const titles={
    dashboard: ['대시보드','관리 중인 입주자를 선택하세요'],
    history:   ['거래 내역','입주자별 거래 내역'],
    report:    ['보고서','월별 금전관리 보고서'],
    settings:  ['설정','입주자·계좌·카테고리·시스템 설정'],
  };
  const [t,s]=titles[view]||['',''];
  setText('view-title',t); setText('view-sub',s);
  if (view==='dashboard') Dash.renderDashboard();
  if (view==='settings')  { Settings.renderManagement(); Settings.loadSettings(); }
  if (view==='report')    { Rpt.loadReportList(); switchRptSubtab('monthly'); }
}

export function switchRptSubtab(tab){
  ['monthly','annual'].forEach(t=>{
    const panel=document.getElementById('rpt-subtab-'+t);
    if(panel)panel.style.display=t===tab?'block':'none';
  });
  document.querySelectorAll('.rpt-subtab').forEach(btn=>{
    const isActive=btn.dataset.subtab===tab;
    btn.style.borderBottom=isActive?'2px solid var(--blue)':'none';
    btn.style.color=isActive?'var(--blue)':'var(--muted)';
    btn.style.marginBottom=isActive?'-2px':'0';
    btn.classList.toggle('active',isActive);
  });
  if(tab==='annual'){
    const cl=document.getElementById('a-client');
    if(cl&&!cl.options.length){S.clients.forEach(c=>cl.add(new Option(c.name,c.id)));}
    const yl=document.getElementById('a-year');
    if(yl&&!yl.options.length){const cy=new Date().getFullYear();for(let y=cy;y>=cy-5;y--)yl.add(new Option(y+'년',y));}
  }
}
