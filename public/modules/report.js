/**
 * modules/report.js — Smart Care Ledger v2
 * 보고서: 로드, 렌더링, 결재 흐름, 연간 통계
 */

'use strict';

import { S } from '../state.js';
import { COLS, STATUS_LABELS, STATUS_CLASSES, cs, lockKey } from '../constants.js';
import { toast, showConfirm, showLoading, setText, makeDraggable, escHtml } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import { chunkForInQuery } from '../services/in-query.js';
import { can, unavailableMessage } from './permissions.js';
import { calcAccountBalanceAsOf, sumIncomeExpense } from '../services/balance.js';
import { planTransition, availableActions, normalizeStatus } from '../domain/report-workflow.js';
// 신원 컨텍스트와 결재 문구 표는 report-actor.js 로 나갔다. 화살표는 한 방향이다.
import {
  actorContext, reportActorContext, TRANSITION_TOAST, TRANSITION_AUDIT,
  REVERT_LABEL, REVERT_MSG,
} from './report-actor.js';
export { actorContext, reportActorContext, TRANSITION_AUDIT };
import { auditLog } from '../services/audit.js';
import { getImageUrl } from '../services/storage.js';
import { reportChecklist, checklistLines } from '../domain/report-checklist.js';
import { getUnpaidMandatoryItems, openReceiptModal, openBankStatementModal } from './modals.js';
import { isConfirmedLocked } from './core.js';
import { hasReceipt, receiptAccess } from '../services/receipt-access.js';
import { rememberOpenReport, restorableReport } from '../domain/report-session.js';
import { sortTrx } from '../domain/trx-order.js';

// 보고서 필수 고정항목 미납 배너
function renderRptMandatoryBanner(clientId,year,month,trxList){
  const el=document.getElementById('rpt-mandatory-banner'); if(!el)return;
  const ym=year+'-'+String(month).padStart(2,'0');
  const unpaid=getUnpaidMandatoryItems(clientId,ym,trxList||null);
  if(!unpaid.length){el.style.display='none';el.innerHTML='';return;}
  const names=unpaid.map(f=>f.description||'(이름없음)').join(', ');
  el.style.display='';
  el.innerHTML='<div style="background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #dc2626;border-radius:8px;padding:10px 14px;margin-bottom:10px;font-size:13px;color:#991b1b;">'
    +'<span style="font-weight:700;">⚠️ '+year+'년 '+month+'월 필수 고정지출 '+unpaid.length+'건 미입력</span>'
    +'<span style="color:#7f1d1d;margin-left:8px;">'+names+'</span></div>';
}

// ─────────────────────────────────────────────
// 거래 캐시 활용 헬퍼
// ─────────────────────────────────────────────
/**
 * 보고서/연간 통계용 거래 fetch.
 *
 * **거래내역 탭의 캐시(S.transactions)를 건드리지 않는다.**
 * 예전에는 여기서 S.transactions·S.activeClient·S.trxRange를 덮어써서,
 * 보고서를 한 번 열면 거래내역 탭의 조회 범위가 조용히 'all'로 바뀌고
 * 데이터가 다른 입주자 것으로 교체됐다. 사용자는 거래내역 탭으로 돌아왔을 때
 * 자기가 보던 것과 다른 화면을 보게 된다.
 *
 * 대신 보고서 전용 캐시를 쓴다. 거래내역 탭이 마침 같은 입주자의 전체 이력을
 * 들고 있으면 그것을 재사용하지만, 쓰지는 않는다.
 */
async function getClientTrxAll(clientId) {
  // 거래내역 탭이 이미 같은 입주자의 전체 이력을 갖고 있으면 그대로 쓴다(읽기 절약)
  if (S.activeClient === clientId
      && S.trxRange === 'all'
      && Array.isArray(S.transactions)
      && S.transactions.length) {
    return S.transactions;
  }
  // 보고서 전용 캐시
  if (S.rptTrxCache && S.rptTrxCache.clientId === clientId
      && Array.isArray(S.rptTrxCache.rows)) {
    return S.rptTrxCache.rows;
  }
  const { getDocs, collection, query, where } = fb();
  const snap = await getDocs(query(collection(fdb(),COLS.TRANSACTIONS), where('clientId','==',clientId)));
  const trx = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  S.rptTrxCache = { clientId, rows: trx };
  return trx;
}

/** 거래가 바뀌면 보고서 캐시를 버린다 (다음 조회에서 다시 읽는다) */
export function invalidateReportTrxCache(clientId) {
  if (!clientId || S.rptTrxCache?.clientId === clientId) S.rptTrxCache = null;
}

// ─────────────────────────────────────────────
// 규칙 기반 자동 분석 (API 없음)
// ─────────────────────────────────────────────
export function generateRuleBasedSummary(reportData) {
  const { year, month, trxList, summary } = reportData;
  const { totalOut, balance } = summary;
  const catStats = summary.catStats || {};
  const fmt = n => Number(n).toLocaleString();

  // 전월 데이터 계산
  let prevMonth = month - 1, prevYear = year;
  if (prevMonth === 0) { prevMonth = 12; prevYear--; }
  const prevStr   = prevYear+'-'+String(prevMonth).padStart(2,'0');
  const prevTrxList = S.transactions.filter(t=>t.clientId===reportData.clientId&&(t.date||'').startsWith(prevStr)&&t.type!=='자산이동'&&t.type!=='취소');
  const prevOut   = prevTrxList.reduce((s,t)=>s+Number(t.amountOut||0),0);
  const prevCat   = {};
  prevTrxList.forEach(t=>{ if(t.type==='지출'){const k=t.category||'기타'; prevCat[k]=(prevCat[k]||0)+Number(t.amountOut||0);} });

  // 카테고리 순위
  const catKeys = Object.keys(catStats).sort((a,b)=>catStats[b].total-catStats[a].total);
  const top1    = catKeys[0], top2=catKeys[1], top3=catKeys[2];
  const top1Pct = totalOut>0?Math.round(catStats[top1]?.total/totalOut*100):0;

  // 문장 구성
  const lines = [];

  // ① 기본 요약
  if (totalOut > 0) {
    lines.push(`${year}년 ${month}월 총 지출은 ${fmt(totalOut)}원입니다.`);
  } else {
    lines.push(`${year}년 ${month}월 지출 내역이 없습니다.`);
  }

  // ② 주요 지출 카테고리
  if (top1) {
    let catSummary = `주요 지출 항목은 ${top1}(${fmt(catStats[top1].total)}원, ${top1Pct}%)`;
    if (top2) catSummary += `, ${top2}(${fmt(catStats[top2].total)}원)`;
    if (top3) catSummary += `, ${top3}(${fmt(catStats[top3].total)}원)`;
    catSummary += ' 순이었습니다.';
    lines.push(catSummary);
  }

  // ③ 전월 대비
  if (prevOut > 0 && totalOut > 0) {
    const diff = totalOut - prevOut;
    const pct  = Math.abs(Math.round(diff/prevOut*100));
    if (diff > 0)      lines.push(`전월 대비 지출이 ${fmt(diff)}원(${pct}%) 증가하였습니다.`);
    else if (diff < 0) lines.push(`전월 대비 지출이 ${fmt(Math.abs(diff))}원(${pct}%) 감소하였습니다.`);
    else               lines.push(`전월과 지출 규모가 동일합니다.`);

    // 카테고리별 전월 대비 특이사항
    const notable = catKeys.find(k => {
      const cur=catStats[k]?.total||0, prev=prevCat[k]||0;
      if (!prev) return cur>50000;
      return Math.abs(cur-prev)/prev > 0.3 && Math.abs(cur-prev) > 20000;
    });
    if (notable) {
      const cur=catStats[notable].total, prev=prevCat[notable]||0;
      const notablePct = prev>0?Math.abs(Math.round((cur-prev)/prev*100)):100;
      if (cur>prev) lines.push(`특히 ${notable} 항목이 전월 대비 ${notablePct}% 증가하였습니다.`);
      else          lines.push(`${notable} 항목은 전월 대비 ${notablePct}% 감소하였습니다.`);
    }
  }

  // ④ 잔액 상태
  if (balance >= 0) {
    lines.push(`이달 잔액은 ${fmt(balance)}원입니다.`);
  } else {
    lines.push(`이달 잔액이 ${fmt(Math.abs(balance))}원 부족합니다. 지출 관리가 필요합니다.`);
  }

  // ⑤ 확인필요 항목
  const uncat = catStats['확인필요']?.total||0;
  if (uncat > 0) {
    lines.push(`미분류(확인필요) 항목이 ${fmt(uncat)}원 있습니다. 카테고리 확인이 필요합니다.`);
  }

  // ⑥ 10만원 초과 단건 지출 상위 3건
  const bigTrx=(trxList||[])
    .filter(t=>t.type!=='자산이동'&&t.type!=='취소'&&Number(t.amountOut||0)>=100000)
    .sort((a,b)=>Number(b.amountOut||0)-Number(a.amountOut||0))
    .slice(0,3);
  if(bigTrx.length){
    const items=bigTrx.map(t=>`${t.description||'(내용없음)'}(${fmt(t.amountOut)}원)`).join(', ');
    lines.push(`10만원 이상 단건 지출 상위 ${bigTrx.length}건: ${items}.`);
  }

  return lines.join(' ');
}

// ─────────────────────────────────────────────
// 연간 통계
// ─────────────────────────────────────────────
export async function loadAnnual(){
  const clientId=document.getElementById('a-client')?.value;
  const year=Number(document.getElementById('a-year')?.value);
  if(!clientId){toast('입주자를 선택하세요.','error');return;}
  showLoading(true);
  const{getDocs,collection,query,where}=fb();
  // 거래는 캐시 우선, 예산은 항상 fetch (작은 데이터)
  const [trxAll,budgetSnap]=await Promise.all([
    getClientTrxAll(clientId),
    getDocs(query(collection(fdb(),COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year))),
  ]);
  const budgetMap={};
  budgetSnap.docs.forEach(d=>{const b=d.data();budgetMap[b.category]=Number(b.amount||0);});
  const all=trxAll.filter(t=>t.date&&t.date.startsWith(String(year)));
  showLoading(false);
  let totalIn=0,totalOut=0;
  const monthly={},catMap={};
  for(let m=1;m<=12;m++)monthly[m]={in:0,out:0,count:0};
  all.forEach(t=>{
    const m=parseInt((t.date||'').split('-')[1])||0; if(!m)return;
    if(t.type==='자산이동'||t.type==='취소')return; // ④⑤ 집계 제외
    totalIn+=Number(t.amountIn||0); totalOut+=Number(t.amountOut||0);
    monthly[m].in+=Number(t.amountIn||0); monthly[m].out+=Number(t.amountOut||0); monthly[m].count++;
    if(t.type==='지출'){const k=t.category||'기타';catMap[k]=(catMap[k]||0)+Number(t.amountOut||0);}
  });
  setText('a-total-in',  totalIn.toLocaleString()+'원');
  setText('a-total-out', totalOut.toLocaleString()+'원');
  setText('a-balance',   (totalIn-totalOut).toLocaleString()+'원');
  setText('a-count',     all.length+'건');
  const mLabels=Array.from({length:12},(_,i)=>(i+1)+'월');
  Object.values(S.annualCharts).forEach(c=>c.destroy()); S.annualCharts={};
  S.annualCharts.monthly=new Chart(document.getElementById('a-monthly-chart').getContext('2d'),{type:'bar',data:{labels:mLabels,datasets:[{label:'수입',data:mLabels.map((_,i)=>monthly[i+1].in),backgroundColor:'rgba(16,185,129,.7)',borderRadius:4},{label:'지출',data:mLabels.map((_,i)=>monthly[i+1].out),backgroundColor:'rgba(244,63,94,.7)',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:11},color:'#64748b'}}},scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#94a3b8',font:{size:10},callback:v=>v>=10000?(v/10000).toFixed(0)+'만':''+v},grid:{color:'rgba(0,0,0,.04)'}}}}});
  const catKeys=Object.keys(catMap).sort((a,b)=>catMap[b]-catMap[a]);
  // 도넛 차트 삭제됨 (a-cat-chart 제거)
  let running=0;
  S.annualCharts.balance=new Chart(document.getElementById('a-balance-chart').getContext('2d'),{type:'line',data:{labels:mLabels,datasets:[{label:'잔액',data:mLabels.map((_,i)=>{running+=monthly[i+1].in-monthly[i+1].out;return running;}),borderColor:'var(--blue)',backgroundColor:'rgba(59,130,246,.08)',fill:true,tension:.4,pointRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#94a3b8',font:{size:10},callback:v=>v>=10000?(v/10000).toFixed(0)+'만':''+v},grid:{color:'rgba(0,0,0,.04)'}}}}});
  const tbody=document.getElementById('a-monthly-body'); tbody.innerHTML='';
  for(let m=1;m<=12;m++){const r=monthly[m];if(!r.count&&!r.in&&!r.out)continue;const tr=document.createElement('tr');tr.innerHTML=`<td style="font-weight:700;">${m}월</td><td style="text-align:right;" class="col-in">${r.in>0?'+'+r.in.toLocaleString()+'원':'-'}</td><td style="text-align:right;" class="col-out">${r.out>0?r.out.toLocaleString()+'원':'-'}</td><td style="text-align:right;font-weight:700;">${(r.in-r.out).toLocaleString()}원</td><td style="text-align:right;color:var(--muted);">${r.count}건</td>`;tbody.appendChild(tr);}
  const rankEl=document.getElementById('a-cat-rank'); rankEl.innerHTML='';
  const hasBudget=Object.keys(budgetMap).length>0;
  catKeys.slice(0,10).forEach((k,i)=>{
    const pct=totalOut>0?Math.round(catMap[k]/totalOut*100):0;
    const c=cs(k);
    const budget=budgetMap[k]||0;
    const achieve=budget>0?Math.round(catMap[k]/budget*100):null;
    const achieveColor=achieve===null?'var(--muted)':achieve>100?'#dc2626':achieve>80?'#f59e0b':'#10b981';
    const div=document.createElement('div');
    div.style.cssText='display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);';
    div.innerHTML=`<span style="width:22px;height:22px;border-radius:50%;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--sub);">${i+1}</span><span style="flex:1;font-size:14px;font-weight:600;">${escHtml(k)}</span><div style="flex:2;height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden;"><div style="height:100%;background:${c.dot};border-radius:99px;width:${pct}%;"></div></div><span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;width:90px;text-align:right;">${catMap[k].toLocaleString()}원</span><span style="font-size:12px;color:var(--muted);width:36px;text-align:right;">${pct}%</span>${hasBudget?`<span style="font-size:11px;width:80px;text-align:right;color:var(--muted);">예산 ${budget?budget.toLocaleString()+'원':'-'}</span><span style="font-size:11px;width:48px;text-align:right;font-weight:700;color:${achieveColor};">${achieve!==null?achieve+'%':'-'}</span>`:''}`;
    rankEl.appendChild(div);
  });
  document.getElementById('annual-content').style.display='block';
}


function getReportAccountRows(year,month,accs,allTrx){
  const mStr=`${year}-${String(month).padStart(2,'0')}`;
  const endDate=mStr+'-31';
  const prevYM=month===1?`${year-1}-12`:`${year}-${String(month-1).padStart(2,'0')}`;
  const prevEnd=prevYM+'-31';
  return (accs||[]).map(a=>{
    // 잔액은 services/balance.js 하나만 쓴다 (대시보드·설정과 값이 어긋나지 않도록)
    const prevBal=calcAccountBalanceAsOf(a,allTrx,prevEnd);
    const bal=calcAccountBalanceAsOf(a,allTrx,endDate);
    // 당월 수입/지출 집계 — 자산이동·취소는 제외
    const monthTrx=(allTrx||[]).filter(t=>t.accountId===a.id&&(t.date||'').startsWith(mStr));
    const {totalIn:monthlyIn,totalOut:monthlyOut}=sumIncomeExpense(monthTrx);
    return {...a,prevBal,monthlyIn,monthlyOut,bal};
  });
}

// ─────────────────────────────────────────────
// 보고서
// ─────────────────────────────────────────────
export async function loadReport(){
  const clientId=document.getElementById('r-client')?.value;
  const year=Number(document.getElementById('r-year')?.value);
  const month=Number(document.getElementById('r-month')?.value);
  if(!clientId){toast('입주자를 선택하세요.','error');return;}
  showLoading(true);
  try{
    const{getDocs,collection,query,where}=fb();
    const mStr=year+'-'+String(month).padStart(2,'0');
    // B002: 전체 거래 목록 보존 (계좌 현황 잔액 계산용) — 캐시 우선 사용
    const allTrx=await getClientTrxAll(clientId);
    const trxList=sortTrx(allTrx.filter(t=>t.date&&t.date.startsWith(mStr)));
    const accs=S.accounts.filter(a=>a.clientId===clientId);
    const rSnap=await getDocs(query(collection(fdb(),COLS.REPORTS),where('clientId','==',clientId),where('year','==',year),where('month','==',month)));
    const report=rSnap.empty?null:{id:rSnap.docs[0].id,...rSnap.docs[0].data()};
    let totalIn=0,totalOut=0; const catStats={};
    trxList.forEach(t=>{
      // ④⑤ 자산이동·취소는 수입/지출 집계에서 제외
      if(t.type==='자산이동'||t.type==='취소')return;
      totalIn+=Number(t.amountIn||0);
      // 2. 음수 amountOut(환불): 지출에서 차감 (음수값 그대로 더함)
      totalOut+=Number(t.amountOut||0);
      if(t.type==='지출'){
        const k=t.category||'기타';
        if(!catStats[k])catStats[k]={total:0};
        catStats[k].total+=Number(t.amountOut||0); // 음수면 자동 차감
      }
    });
    const accountRows=getReportAccountRows(year,month,accs,allTrx);
    S.reportData={clientId,year,month,trxList,allTrx,accs,accountRows,report,summary:{totalIn,totalOut,balance:totalIn-totalOut,catStats}};
    // 무엇을 보고 있었는지만 남긴다. 계산 결과는 돌아올 때 다시 만든다 —
    // 결재 문서라 낡은 숫자가 그대로 보이는 쪽이 더 위험하다.
    S.reportOpen=rememberOpenReport({clientId,year,month});
    renderReportView();
    document.getElementById('report-area').style.display='block';
    // 목록 테이블에서 현재 보고서 행 하이라이트
    const rptListEl=document.getElementById('rpt-list');
    if(rptListEl){
      rptListEl.querySelectorAll('tr').forEach(tr=>{tr.style.background='';});
      if(report?.id){
        const activeRow=rptListEl.querySelector(`tr[data-report-id="${report.id}"]`);
        if(activeRow)activeRow.style.background='#eff6ff';
      }
    }
    // report-area가 화면에 보이도록 스크롤
    document.getElementById('report-area')?.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){toast('보고서 로드 오류: '+e.message,'error');}
  showLoading(false);
}

/**
 * 보고서 화면을 닫는다 — 직접 닫은 것이므로 기억도 지운다.
 * 탭 이동(changeView)은 "잠깐 다른 걸 본다"라 기억을 남기고, 여기는 "그만 본다"다.
 */
export function closeReportView(){
  const ra=document.getElementById('report-area');
  if(ra)ra.style.display='none';
  S.reportData=null; S.reportOpen=null;
  document.querySelectorAll('#rpt-list tr').forEach(tr=>{tr.style.background='';tr.style.fontWeight='';});
  document.querySelectorAll('#rpt-list .card').forEach(el=>{el.style.background='';});
}

/**
 * 보고서 탭으로 돌아왔을 때 보던 것을 다시 연다.
 *
 * 기억해 둔 것으로 **다시 조회한다** — 그 사이 거래를 고쳤거나 동료가 결재했을
 * 수 있다. 담당에서 빠진 입주자면 조용히 선택 화면으로 남는다.
 */
export function restoreOpenReport(){
  const rec=restorableReport(S.reportOpen,S.clients);
  if(!rec){ S.reportOpen=null; S.reportData=null; return; }
  const rc=document.getElementById('r-client'),ry=document.getElementById('r-year'),rm=document.getElementById('r-month');
  if(!rc||!ry||!rm)return;
  rc.value=rec.clientId; ry.value=String(rec.year); rm.value=String(rec.month);
  // 연도 선택칸에 없는 해(6년 넘게 지난 보고서)면 복원하지 않는다.
  if(rc.value!==rec.clientId||Number(ry.value)!==rec.year||Number(rm.value)!==rec.month){
    S.reportOpen=null; return;
  }
  loadReport();
}

/**
 * 담당 칸에 적을 이름.
 *
 * 제출되면 제출한 사람, 아직이면 작성한 사람. **지금 보고 있는 사람은 아니다** —
 * 결재자가 열었을 뿐인데 인쇄물의 담당 칸에 결재자 이름이 찍히면, 보는 사람은
 * 결재 라인이 바뀐 것으로 읽는다.
 */
function reportStaffName(report){
  return report?.submittedByName||report?.createdByName||'-';
}

export function renderReportView(){
  const{clientId,year,month,trxList,accs,accountRows,report,summary}=S.reportData;
  const client=S.clients.find(c=>c.id===clientId)||{name:'-'};
  const now=new Date(), curStatus=report?report.status:'';
  setText('rpt-period',`${year}년 ${month}월 거래 내역`);
  // 작성일은 보고서가 처음 만들어진 날. 예전에는 항상 오늘을 찍어서
  // 작년 보고서를 다시 인쇄하면 오늘 날짜가 나왔다.
  const createdStr=new Date(report?.createdAt||now).toLocaleDateString('ko-KR');
  setText('rpt-created',`작성: ${createdStr}`);
  setText('rpt-created-bottom',createdStr);
  setText('rpt-client-name',client.name);
  setText('rpt-month-label',`${year}년 ${month}월`);
  // 제출 전이면 **작성자**를 쓴다. 예전에는 지금 보는 사람 이름으로 떨어져서,
  // 팀장이 아직 제출되지 않은 보고서를 열면 담당 칸에 팀장 이름이 찍혔다.
  // 저장되는 값은 아니지만 그대로 인쇄된다 — 결재 라인이 바뀐 것처럼 보인다.
  setText('rpt-staff-name',reportStaffName(report));
  setText('rpt-total-in', summary.totalIn.toLocaleString()+'원');
  setText('rpt-total-out',summary.totalOut.toLocaleString()+'원');
  setText('rpt-balance',  summary.balance.toLocaleString()+'원');
  setText('rpt-foot-in',  summary.totalIn>0?summary.totalIn.toLocaleString()+'원':'');
  setText('rpt-foot-out', summary.totalOut>0?summary.totalOut.toLocaleString()+'원':'');
  const lbl=STATUS_LABELS[curStatus]||curStatus,cls=STATUS_CLASSES[curStatus]||'rs-draft';
  const sl=document.getElementById('rpt-status-label'),ub=document.getElementById('rpt-status-badge');
  if(sl){sl.textContent=lbl;sl.className=cls;} if(ub){ub.textContent=lbl;ub.className=cls;}
  // 계좌 현황 — 기초잔액 + 기준일 이후 거래 합산으로 직접 계산 (전월 잔액 포함)
  const accEl=document.getElementById('rpt-accounts'); accEl.innerHTML='';
  (accountRows||getReportAccountRows(year,month,accs,S.reportData.allTrx)).forEach(a=>{
    const row=document.createElement('div');
    row.style.cssText='display:grid;grid-template-columns:minmax(120px,1fr) repeat(4,minmax(86px,auto));align-items:center;padding:7px 0;border-bottom:1px solid #f3f4f6;gap:8px;';
    row.innerHTML=`<span style="font-size:14px;color:#374151;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(a.label)}</span>`
      +`<span style="font-size:12px;color:#6b7280;text-align:right;white-space:nowrap;">전월 ${a.prevBal.toLocaleString()}원</span>`
      +`<span style="font-size:12px;color:#15803d;text-align:right;white-space:nowrap;">수입 +${a.monthlyIn.toLocaleString()}원</span>`
      +`<span style="font-size:12px;color:#b91c1c;text-align:right;white-space:nowrap;">지출 ${a.monthlyOut.toLocaleString()}원</span>`
      +`<span style="font-size:14px;font-weight:700;color:${a.bal>=0?'#111827':'#dc2626'};text-align:right;white-space:nowrap;">${a.bal.toLocaleString()}원</span>`;
    accEl.appendChild(row);
  });
  // 분류별 지출
  const catKeys=Object.keys(summary.catStats);
  const catEl=document.getElementById('rpt-cat-table'); catEl.innerHTML='';
  if(S.rptChart){S.rptChart.destroy();S.rptChart=null;}
  if(catKeys.length){
    const sortedCatKeys=[...catKeys].sort((a,b)=>(summary.catStats[b]?.total||0)-(summary.catStats[a]?.total||0));
    let tbl='<table style="width:100%;border-collapse:collapse;table-layout:fixed;">'
      +'<colgroup><col style="width:100px"><col style="width:200px"><col style="width:46px"><col></colgroup>'
      +'<thead><tr style="border-bottom:1px solid #e5e7eb;">'
      +'<th style="padding:6px 4px;text-align:left;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;">분류</th>'
      +'<th style="padding:6px 4px;text-align:right;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;">금액</th>'
      +'<th style="padding:6px 4px;text-align:right;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;">비율</th>'
      +'<th style="padding:6px 4px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;"></th>'
      +'</tr></thead><tbody>';
    sortedCatKeys.forEach((k,i)=>{
      const v=summary.catStats[k], pct=summary.totalOut>0?Math.round(v.total/summary.totalOut*100):0;
      const clr=cs(k);
      const color=clr.dot||'#64748b';
      tbl+='<tr style="border-bottom:1px solid #f3f4f6;">'
        +'<td style="padding:7px 4px;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
          +'<span style="display:inline-flex;align-items:center;gap:4px;background:'+clr.bg+';color:'+clr.text+';border:1px solid '+clr.border+';border-radius:12px;padding:2px 8px;font-size:12px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+k+'</span>'
        +'</td>'
        +'<td style="padding:7px 4px;text-align:right;font-family:monospace;font-size:13px;color:#111827;white-space:nowrap;">'+v.total.toLocaleString()+'원</td>'
        +'<td style="padding:7px 4px;text-align:right;font-size:13px;color:#6b7280;white-space:nowrap;">'+pct+'%</td>'
        +'<td style="padding:7px 8px;vertical-align:middle;">'
          +'<div style="height:10px;background:#f3f4f6;border-radius:99px;overflow:hidden;min-width:40px;">'
            +'<div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:99px;"></div>'
          +'</div></td>'
        +'</tr>';
    });
    catEl.innerHTML=tbl+'</tbody></table>';
  } else { catEl.innerHTML='<div style="color:#6b7280;font-size:13px;padding:10px 0;">지출 내역 없음</div>'; }
  // F002: 거래내역 테이블 렌더링 + 드래그 순서 변경 (정렬 초기화 후 렌더)
  S.rptSortKey='date'; S.rptSortDir='asc';
  renderRptTrxTable(trxList);
  updateRptSortArrows();
  // 결재/의견/차트/통장사진 (정의된 함수 호출)
  renderApproval(report,curStatus);
  renderComments(report,curStatus);
  // renderTrendChart 제거 (월별 추이 차트 삭제)
  if(S.rptTrendChart){S.rptTrendChart.destroy();S.rptTrendChart=null;}
  renderRptBankStatements(clientId,year,month);
  renderRptMandatoryBanner(clientId,year,month,trxList);
}

// F002: 보고서 거래내역 테이블 렌더링 (드래그앤드롭 포함)
export function renderRptTrxTable(trxList){
  const tbody=document.getElementById('rpt-trx-body'); if(!tbody)return;
  tbody.innerHTML='';
  if(!trxList||!trxList.length){
    const tr=document.createElement('tr');
    tr.innerHTML='<td colspan="6" style="text-align:center;color:#6b7280;padding:16px;font-size:13px;">거래 내역이 없습니다.</td>';
    tbody.appendChild(tr); return;
  }
  const confirmedLocked=isConfirmedLocked(S.reportData?.clientId, S.reportData?.trxList?.[0]?.date||'');
  const byAccount=new Map();
  (S.reportData?.accs||[]).forEach(a=>byAccount.set(a.id,{account:a,items:[]}));  
  trxList.forEach(t=>{
    if(!byAccount.has(t.accountId))byAccount.set(t.accountId,{account:S.accounts.find(a=>a.id===t.accountId)||{id:t.accountId,label:'미지정 계좌'},items:[]});
    byAccount.get(t.accountId).items.push(t);
  });
  byAccount.forEach(group=>{
    if(!group.items.length)return;
    const subIn=group.items.reduce((sum,t)=>t.type==='자산이동'||t.type==='취소'?sum:sum+Number(t.amountIn||0),0);
    const subOut=group.items.reduce((sum,t)=>t.type==='자산이동'||t.type==='취소'?sum:sum+Number(t.amountOut||0),0);
    const header=document.createElement('tr');
    header.className='rpt-account-group-row';
    header.innerHTML=`<td colspan="6" style="padding:8px 6px;background:#f8fafc;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:800;color:#374151;">🏦 ${escHtml(group.account.label||'미지정 계좌')} <span style="font-weight:600;color:#6b7280;margin-left:8px;">${group.items.length}건 · 수입 ${subIn.toLocaleString()}원 · 지출 ${subOut.toLocaleString()}원</span></td>`;
    tbody.appendChild(header);
    group.items.forEach(t=>{    
    const tr=document.createElement('tr');
    tr.dataset.id=t.id;
    const locked=confirmedLocked; // 최종 결재 완료 보고서는 드래그 불가
    tr.draggable=!locked;
    tr.style.cssText=`border-bottom:1px solid #f3f4f6;cursor:${locked?'default':'grab'};`;
    let typeTag='';
    if(t.type==='자산이동'){
      const srcId=Number(t.amountOut||0)>0?t.accountId:t.linkedAccountId;
      const dstId=Number(t.amountOut||0)>0?t.linkedAccountId:t.accountId;
      const src=S.accounts.find(a=>a.id===srcId)?.label||'?';
      const dst=S.accounts.find(a=>a.id===dstId)?.label||'?';
      typeTag='<span style="font-size:10px;background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px;margin-left:4px;">↕이동 '+src+' → '+dst+'</span>';
    } else if(t.type==='취소'){
      const sub=Number(t.amountIn||0)>0?'수입':'지출';
      typeTag='<span style="font-size:10px;background:#f4f4f5;color:#71717a;padding:1px 5px;border-radius:4px;margin-left:4px;">취소('+sub+')</span>';
    }
    const catClr=cs(t.category||'');
    tr.innerHTML=`<td style="padding:7px 4px;font-family:monospace;font-size:13px;color:#6b7280;white-space:nowrap;">${escHtml(t.date||'')}</td>`
      +`<td style="padding:4px 4px;overflow:hidden;white-space:nowrap;"><span style="display:inline-block;background:${catClr.bg};color:${catClr.text};border:1px solid ${catClr.border};border-radius:10px;padding:2px 6px;font-size:11px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.category||'')}</span></td>`
      +`<td style="padding:7px 4px;font-size:13px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.description||'')}${typeTag}</td>`
      +`<td style="padding:7px 4px;text-align:right;font-family:monospace;font-size:13px;color:#15803d;white-space:nowrap;">${Number(t.amountIn||0)>0?Number(t.amountIn).toLocaleString()+'원':''}</td>`
      +`<td style="padding:7px 4px;text-align:right;font-family:monospace;font-size:13px;color:#b91c1c;white-space:nowrap;">${Number(t.amountOut||0)>0?Number(t.amountOut).toLocaleString()+'원':''}</td>`
      +`<td style="padding:7px 4px;text-align:center;${t.type==='지출'&&!hasReceipt(t)&&t.receiptMissing?'background:#fee2e2;':''}">${
        hasReceipt(t)?'<button class="icon-btn rpt-rv" title="증빙 보기">📎</button>':
        (t.receiptMissing?'<span style="font-size:10px;font-weight:700;color:#b91c1c;background:#fecaca;padding:2px 6px;border-radius:4px;">분실</span>':'')
      }</td>`;
    if(!locked){
      tr.addEventListener('dragstart',e=>{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',t.id);tr.style.opacity='0.4';});
      tr.addEventListener('dragend',()=>tr.style.opacity='1');
      tr.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';tr.style.background='#eff6ff';});
      tr.addEventListener('dragleave',()=>tr.style.background='');
      tr.addEventListener('drop',e=>{e.preventDefault();tr.style.background='';const fid=e.dataTransfer.getData('text/plain');if(fid!==t.id)reorderRptTrx(fid,t.id);});
    }
    const rvBtn=tr.querySelector('.rpt-rv');
    if(rvBtn)rvBtn.addEventListener('click',async()=>{
      try{const a=await receiptAccess(t);openReceiptModal(a.url,t.id,{contentType:a.contentType});}
      catch(e){toast('증빙을 열지 못했습니다: '+(e.message||e),'error');}
    });
    tbody.appendChild(tr);
    });      
  });
}

// ─── 보고서 거래내역 정렬 ───
export function applyRptSort(list){
  const key=S.rptSortKey, dir=S.rptSortDir;
  return [...list].sort((a,b)=>{
    let vA, vB;
    if(key==='amountIn'||key==='amountOut'){
      vA=Number(a[key]||0); vB=Number(b[key]||0);
      return dir==='asc'?vA-vB:vB-vA;
    }
    if(key==='date'){
      // 날짜+시간 복합 정렬
      vA=(a.date||'')+(a.time?' '+a.time:'');
      vB=(b.date||'')+(b.time?' '+b.time:'');
    } else {
      vA=String(a[key]||''); vB=String(b[key]||'');
    }
    if(vA<vB)return dir==='asc'?-1:1;
    if(vA>vB)return dir==='asc'?1:-1;
    return 0;
  });
}

export function updateRptSortArrows(){
  document.querySelectorAll('[data-rpt-sort]').forEach(th=>{
    const arrow=th.querySelector('.rpt-sort-arrow');
    if(!arrow)return;
    if(th.dataset.rptSort===S.rptSortKey){
      arrow.textContent=S.rptSortDir==='asc'?' ↑':' ↓';
    } else {
      arrow.textContent=' ⇅';
    }
  });
}

// 거래 추가/수정 후 보고서 거래내역 자동 동기화
export function syncReportTrxList(){
  if(!S.reportData)return;
  const{clientId,year,month}=S.reportData;
  if(!clientId)return;
  const mStr=year+'-'+(String(month).padStart(2,'0'));
  // S.transactions(방금 재로드)에서 해당 월 거래 추출
  const newTrxList=S.transactions.filter(t=>t.clientId===clientId&&(t.date||'').startsWith(mStr));
  // 장부 순서로 먼저 세우고, 사용자가 고른 정렬키가 따로 있으면 그것을 얹는다
  const baseSort=sortTrx(newTrxList);
  S.reportData.trxList=baseSort;
  S.reportData.accountRows=getReportAccountRows(year,month,S.reportData.accs,S.transactions);  
  // 현재 보고서 정렬이 날짜 기본이 아니면 정렬 적용
  const sorted=(S.rptSortKey!=='date'||S.rptSortDir!=='asc')?applyRptSort(baseSort):baseSort;
  renderRptTrxTable(sorted);
  updateRptSortArrows();
}

export async function reorderRptTrx(fromId,toId){
  if(!S.reportData)return;
  const rd=S.reportData;
  if(isConfirmedLocked(rd.clientId,`${rd.year}-${String(rd.month).padStart(2,'0')}-01`)){toast('최종 결재 완료된 월의 거래는 순서를 변경할 수 없습니다. (센터장이 결재를 취소하면 다시 편집할 수 있어요.)','error');return;}
  const arr=[...S.reportData.trxList];
  const fi=arr.findIndex(x=>x.id===fromId), ti=arr.findIndex(x=>x.id===toId);
  if(fi<0||ti<0)return;
  const[moved]=arr.splice(fi,1); arr.splice(ti,0,moved);
  const{doc,updateDoc}=fb();
  for(let i=0;i<arr.length;i++){
    const t=arr[i]; if(t.sortOrder!==i){t.sortOrder=i;await updateDoc(doc(fdb(),COLS.TRANSACTIONS,t.id),{sortOrder:i});}
  }
  S.reportData.trxList=arr;
  renderRptTrxTable(arr);
  toast('순서 저장됨','success',1500);
}

// 통장사진을 별도 팝업 창에서 열기 (메인 탭 작업과 분리)
function openBankStmtWindow(url,label,month){
  if(!url)return;
  const w=Math.min(1100,Math.floor((window.screen.availWidth||1400)*0.85));
  const h=Math.min(900, Math.floor((window.screen.availHeight||900)*0.85));
  const left=Math.max(0,Math.floor(((window.screen.availWidth||1400)-w)/2));
  const top=Math.max(0,Math.floor(((window.screen.availHeight||900)-h)/2));
  const win=window.open('',('bs_'+Date.now()),`width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,scrollbars=yes,resizable=yes`);
  if(!win){toast('팝업 차단을 해제해주세요.','error');return;}
  const title=(label||'통장사진')+(month?' · '+month:'');
  const safeUrl=String(url).replace(/"/g,'&quot;');
  win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'+title+'</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#1f2937;color:#f9fafb;font-family:"Noto Sans KR",sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden;}header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#111827;border-bottom:1px solid #374151;}header h1{font-size:14px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}header a,header button{background:#374151;color:#f9fafb;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;text-decoration:none;font-weight:600;}header a:hover,header button:hover{background:#4b5563;}.viewer{flex:1;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px;background:#374151;}.viewer img{max-width:100%;height:auto;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.4);}</style></head><body><header><h1>📷 '+title+'</h1><a href="'+safeUrl+'" target="_blank" rel="noopener">🔗 원본</a><button onclick="window.close()">닫기 ×</button></header><div class="viewer"><img src="'+safeUrl+'" alt="통장사진"></div></body></html>');
  win.document.close();
  win.focus();
}

// ─────────────────────────────────────────────
// 보고서 통장 사진 (연월 기반)
// ─────────────────────────────────────────────
export async function renderRptBankStatements(clientId,year,month){
  const section=document.getElementById('rpt-bank-stmt-section');
  const gallery=document.getElementById('rpt-bank-stmt-gallery');
  const uploadBtn=document.getElementById('btn-upload-bank-stmt');
  if(!section||!gallery)return;
  const mStr=String(year)+'-'+String(month).padStart(2,'0');
  const accs=S.accounts.filter(a=>a.clientId===clientId);
  let stmts=[];
  accs.forEach(a=>{
    (a.bankStatements||[]).forEach(s=>{
      const item=typeof s==='string'?{url:s,month:'',label:a.label}:{...s,label:a.label||''};
      if(!item.month||item.month===mStr)stmts.push(item);
    });
  });
  section.style.display=stmts.length>0?'block':'none';
  gallery.innerHTML='';
  stmts.forEach(s=>{
    const thumb=getImageUrl(s.thumbUrl||s.url,'w300');
    const cell=document.createElement('div');
    cell.style.cssText='position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;cursor:pointer;';
    cell.innerHTML='<div style="font-size:10px;color:var(--muted);padding:4px 6px;background:var(--bg);">'+s.label+(s.month?' · '+s.month:'')+'</div>'
      +'<img src="'+thumb+'" style="width:100%;height:120px;object-fit:cover;" onerror="this.src=\'\'">';
    cell.addEventListener('click',()=>openBankStmtWindow(s.url,s.label,s.month));
    gallery.appendChild(cell);
  });
  if(uploadBtn){
    if(can('bankbook.upload')){
      uploadBtn.style.display='';
      uploadBtn.onclick=()=>openBankStatementFromReport(clientId,year,month);
    } else {
      uploadBtn.style.display='none';
    }
  }
  const viewBtn=document.getElementById('btn-view-bank-stmts');
  if(viewBtn){
    viewBtn.onclick=()=>openBankStatementsForApproval();
    viewBtn.style.display=stmts.length?'':'none';
  }
}

// ─────────────────────────────────────────────
// 결재 시 통장사진 새창으로 열기
export function openBankStatementsForApproval(){
  if(!S.reportData)return;
  const{year,month,accs}=S.reportData;
  const mStr=`${year}-${String(month).padStart(2,'0')}`;
  const imgs=[];
  (accs||[]).forEach(a=>{
    (a.bankStatements||[]).filter(b=>b.month===mStr&&b.url).forEach(b=>{
      imgs.push({url:b.url,label:a.label||''});
    });
  });
  if(!imgs.length){toast('해당 월 통장사진이 없습니다.','info');return;}
  // 기존 패널 제거
  document.getElementById('bank-float-panel')?.remove();
  const panel=document.createElement('div');
  panel.id='bank-float-panel';
  panel.style.cssText='position:fixed;right:16px;top:60px;width:400px;min-height:200px;max-height:90vh;z-index:9998;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);display:flex;flex-direction:column;resize:both;overflow:hidden;border:1px solid var(--border);';
  panel.innerHTML=`
    <div id="bfp-header" style="padding:10px 14px;background:var(--surface);border-bottom:1px solid var(--border);cursor:move;display:flex;align-items:center;gap:8px;user-select:none;">
      <span style="font-size:13px;font-weight:700;color:var(--text);flex:1;">📷 통장사진</span>
      <span id="bfp-label" style="font-size:12px;color:var(--muted);"></span>
      <button onclick="document.getElementById('bank-float-panel').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--muted);line-height:1;">×</button>
    </div>
    <div style="flex:1;overflow:auto;display:flex;flex-direction:column;align-items:center;padding:10px;gap:8px;">
      <img id="bfp-img" style="max-width:100%;border-radius:6px;display:block;" alt="통장사진" />
      ${imgs.length>1?`<div style="display:flex;gap:8px;margin-top:4px;">
        <button onclick="if(window._bfpIdx>0){window._bfpIdx--;document.getElementById('bank-float-panel').__renderImg();}" style="padding:4px 14px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;">‹ 이전</button>
        <button onclick="if(window._bfpIdx<window._bfpImgs.length-1){window._bfpIdx++;document.getElementById('bank-float-panel').__renderImg();}" style="padding:4px 14px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;">다음 ›</button>
      </div>`:''}
    </div>`;
  document.body.appendChild(panel);
  window._bfpImgs=imgs; window._bfpIdx=0;
  panel.__renderImg=()=>{
    const it=window._bfpImgs[window._bfpIdx];
    let src=it.url;
    src=getImageUrl(src,'w800');
    panel.querySelector('#bfp-img').src=src;
    panel.querySelector('#bfp-label').textContent=`${it.label} (${window._bfpIdx+1}/${window._bfpImgs.length})`;
  };
  panel.__renderImg();
  // 드래그 — 누르고 있는 동안에만 문서에 리스너가 붙는다(누수 없음)
  makeDraggable(panel, panel.querySelector('#bfp-header'));
}

export async function openBankStatementFromReport(clientId,year,month){
  const accs=S.accounts.filter(a=>a.clientId===clientId);
  if(!accs.length){toast('계좌가 없습니다.','error');return;}
  if(accs.length===1){openBankStatementModal(accs[0].id,year,month);return;}
  document.getElementById('modal-wrap').classList.add('show');
  const body=document.getElementById('modal-body');
  body.innerHTML='<h3 style="font-size:16px;font-weight:800;margin-bottom:14px;">📸 통장 사진 업로드</h3>'
    +'<p style="font-size:13px;color:var(--muted);margin-bottom:12px;">사진을 업로드할 계좌를 선택하세요.</p>'
    +'<div style="display:flex;flex-direction:column;gap:8px;">'
    +accs.map(a=>'<button class="btn-sub" style="color:var(--blue);border-color:#bfdbfe;padding:10px;font-size:13px;" onclick="closeModal();openBankStatementModal(\''+a.id+'\','+year+','+month+');">['+a.label+'] 선택</button>').join('')
    +'</div>';
}

// ⑦ 의견란 렌더링
export function renderComments(report,curStatus){
  const el=document.getElementById('rpt-comments-area'); if(!el)return;
  // 결재 버튼과 같은 컨텍스트를 쓴다. 예전에는 여기서 role==='담당자'로 갈라서
  // 팀장이 직접 담당인 입주자의 반려 보고서에 의견을 달 수 없었다.
  const ctx=reportActorContext();
  const st=normalizeStatus(curStatus);
  const canWriteStaff=can('report.submit')&&(st==='draft'||st==='rejected');
  el.innerHTML='<div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;">의견</div>';
  const sections=[
    {key:'staffComment',  label:'담당자 의견', editable: canWriteStaff},
    {key:'leaderComment', label:'팀장 의견',   editable: st==='submitted'&&ctx.isAssignedLeader&&can('report.approve.team')},
    {key:'centerComment', label:'센터장 의견', editable: st==='team_approved'&&can('report.approve.center')},
  ];
  sections.forEach(s=>{
    const val=report?.[s.key]||'';
    const div=document.createElement('div');
    div.style.cssText='margin-bottom:12px;';
    div.innerHTML='<div style="font-size:11px;font-weight:700;color:#6b7280;margin-bottom:6px;">'+s.label+'</div>';
    if(s.editable){
      div.innerHTML+='<textarea id="comment-'+s.key+'" style="width:100%;min-height:60px;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;resize:vertical;" placeholder="'+s.label+'을 입력하세요...">'+escHtml(val)+'</textarea>'
        +'<button onclick="saveComment(\''+s.key+'\')" style="margin-top:4px;font-size:12px;font-weight:700;color:var(--blue);border:1px solid #bfdbfe;background:#eff6ff;padding:4px 12px;border-radius:6px;cursor:pointer;">저장</button>';
    } else {
      div.innerHTML+='<div style="font-size:14px;color:#374151;min-height:30px;padding:8px 10px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">'+escHtml(val||'(없음)')+'</div>';
    }
    el.appendChild(div);
  });
}

export async function saveComment(key){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const val=document.getElementById('comment-'+key)?.value||'';
  const{clientId,year,month}=S.reportData;
  try{
    // reports 는 서버만 쓴다 — 결재 상태가 브라우저에서 바뀌면 안 되기 때문이다.
    const res=await window._fbFn.call('saveReportComment')({
      clientId,year,month,key,value:val,userName:S.user?.name||''});
    if(!S.reportData.report)S.reportData.report={clientId,year,month,status:'draft'};
    S.reportData.report.id=res.data.reportId;
    S.reportData.report[key]=val;
    patchReportCache(S.reportData.report);
    renderReportList();
    toast('의견이 저장되었습니다.','success',2000);
  }catch(e){toast('의견 저장 실패: '+(e.message||e),'error',5000);}
}

// ─────────────────────────────────────────────
// 보고서 월별 추이 차트
// ─────────────────────────────────────────────
export function renderTrendChart(clientId,baseYear,baseMonth){
  const ctx=document.getElementById('rpt-trend-chart'); if(!ctx)return;
  if(S.rptTrendChart){S.rptTrendChart.destroy();S.rptTrendChart=null;}
  const months=[];
  for(let i=5;i>=0;i--){
    const d=new Date(baseYear,baseMonth-1-i,1);
    months.push(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'));
  }
  const inData=[],outData=[];
  months.forEach(m=>{
    let inS=0,outS=0;
    S.transactions.forEach(t=>{
      if(t.clientId!==clientId||(t.date||'').substring(0,7)!==m)return;
      if(t.type==='자산이동'||t.type==='취소')return;
      inS+=Number(t.amountIn||0); outS+=Number(t.amountOut||0);
    });
    inData.push(inS); outData.push(outS);
  });
  S.rptTrendChart=new Chart(ctx.getContext('2d'),{type:'bar',data:{labels:months.map(m=>{const p=m.split('-');return parseInt(p[1])+'월';}),datasets:[{label:'수입',data:inData,backgroundColor:'rgba(16,185,129,.7)',borderRadius:4},{label:'지출',data:outData,backgroundColor:'rgba(244,63,94,.7)',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:11},color:'#64748b'}}},scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#94a3b8',font:{size:10},callback:v=>v>=10000?(v/10000).toFixed(0)+'만':''+v},grid:{color:'rgba(0,0,0,.04)'}}}}});
}

// 규칙 기반 자동 분석 핸들러
export function handleGenSummary(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const text=generateRuleBasedSummary(S.reportData);
  setText('rpt-summary-text',text);
  const printText=document.getElementById('rpt-summary-print-text');
  const printArea=document.getElementById('rpt-summary-print-area');
  const printCheck=document.getElementById('rpt-summary-print');
  if(printText)printText.textContent=text;
  if(printCheck?.checked&&printArea)printArea.style.display='block';
  toast('분석 완료','success',2000);
}

// ─────────────────────────────────────────────
// 결재
// ─────────────────────────────────────────────

export function renderApproval(report,curStatus){
  // 신원·권한 판정은 reportActorContext() 한 곳에서만 한다.
  // 예전에는 렌더와 실행이 각자 계산해서, 버튼이 보이는데 실행은 거부되거나
  // 그 반대인 상황이 생겼다.
  const ctx=reportActorContext();

  // 결재란
  const grid=document.getElementById('rpt-approval-grid'); grid.innerHTML='';
  [{label:'담당',name:report?.submittedByName||''},{label:'팀장',name:report?.teamApprovedByName||''},{label:'센터장',name:report?.centerApprovedByName||''}].forEach((s,i,arr)=>{
    const cell=document.createElement('div'); cell.style.cssText='width:88px;'+(i<arr.length-1?'border-right:1px solid #d1d5db;':'');
    cell.innerHTML='<div style="background:#f9fafb;padding:6px 8px;text-align:center;font-size:11px;font-weight:700;color:#6b7280;border-bottom:1px solid #d1d5db;">'+s.label+'</div><div style="height:58px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:7px;">'+(s.name?'<div style="font-size:12px;font-weight:700;color:#374151;">'+s.name+'</div>':'')+'</div>';
    grid.appendChild(cell);
  });

  // 결재 트랙
  const track=document.getElementById('rpt-track-inner'); track.innerHTML='';
  const ORDER=['','draft','submitted','team_approved','confirmed'], curIdx=ORDER.indexOf(curStatus);
  [{key:'submitted',label:'제출',icon:'✍️',name:report?.submittedByName||'',date:report?.submittedAt||''},{key:'team_approved',label:'팀장 결재',icon:'✔️',name:report?.teamApprovedByName||'',date:report?.teamApprovedAt||''},{key:'confirmed',label:'센터장 최종',icon:'🏁',name:report?.centerApprovedByName||'',date:report?.centerApprovedAt||''}].forEach((s,i,arr)=>{
    const done=curIdx>=ORDER.indexOf(s.key);
    const el=document.createElement('div'); el.style.cssText='display:flex;align-items:center;';
    el.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;"><div style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;background:'+(done?'var(--blue)':'#f1f5f9')+';color:'+(done?'#fff':'#94a3b8')+';">'+(done?s.icon:i+1)+'</div><div style="font-size:11px;font-weight:700;margin-top:5px;color:'+(done?'var(--blue)':'#94a3b8')+';">'+s.label+'</div>'+(s.name&&done?'<div style="font-size:10px;color:#94a3b8;">'+s.name+'</div>':'')+'</div>';
    track.appendChild(el);
    if(i<arr.length-1){const line=document.createElement('div');line.style.cssText='flex:1;height:2px;margin:0 6px;background:'+(done&&curIdx>ORDER.indexOf(s.key)?'var(--blue)':'#e2e8f0')+';';track.appendChild(line);}
  });

  // 상단: 인쇄/엑셀 버튼
  const btns=document.getElementById('rpt-action-btns'); btns.innerHTML='';
  // 결재 액션별 설명 (버튼에 마우스를 올리면 표시) — 회수/반려/결재취소/수정(초안) 구분이 헷갈리지 않도록
  const ACTION_TIP={
    '💾 임시저장':'제출하지 않고 작성 중인 상태로 저장합니다.',
    '📤 제출':'담당자가 팀장에게 결재를 요청합니다. 제출 후에는 회수하기 전까지 수정할 수 없어요.',
    '📤 직접 제출':'담당 팀장으로서 제출과 팀장 결재를 한 번에 처리합니다.',
    '↩ 회수':'내가 제출한 보고서를 다시 가져와 작성 상태로 되돌립니다. (팀장 결재 전)',
    '↩️ 반려':'담당자에게 되돌려 보내 수정을 요청합니다. 사유를 의견란에 적어 주세요.',
    '↩️ 팀장 결재 취소':'팀장 결재를 취소하고 제출 상태로 되돌립니다.',
    '↩️ 최종 결재 취소':'최종 결재를 취소하고 팀장 결재 상태로 되돌립니다.',
    '✏️ 수정(초안)':'제출을 취소하고 작성 초안 상태로 되돌려 다시 수정할 수 있게 합니다.',
    '🔓 반려 해제':'담당자가 부재일 때 반려 상태를 풀고 초안으로 되돌립니다.',
    '🗑️ 삭제':'보고서를 완전히 삭제합니다.',
  };
  const mkBtnTo=(container,lbl,style,fn)=>{const b=document.createElement('button');b.className='btn-sub';b.style.cssText=style+'font-size:13px;';b.textContent=lbl;if(ACTION_TIP[lbl])b.title=ACTION_TIP[lbl];b.addEventListener('click',fn);container.appendChild(b);};
  mkBtnTo(btns,'🖨️ 인쇄/PDF','color:var(--blue);border-color:#bfdbfe;',()=>{if(!S.reportData){toast('먼저 조회하세요.','error');return;}window.print();});
  mkBtnTo(btns,'📊 엑셀 저장','color:#059669;border-color:#a7f3d0;',exportReportExcel);

  renderSubmitChecklist(curStatus);

  // 하단: 제출/결재/반려 버튼
  // 버튼 목록은 전이표에서 직접 뽑는다 — 화면과 실행이 갈라질 수 없다.
  const sbEl=document.getElementById('rpt-submit-btns');
  if(sbEl){
    sbEl.innerHTML='';
    sbEl.style.display='none';
    const mkBtn=(lbl,style,fn)=>mkBtnTo(sbEl,lbl,style,fn);
    const showSb=()=>{sbEl.style.display='flex';};
    const mkPrimary=(lbl,bg,tip,fn)=>{
      const b=document.createElement('button');b.className='btn';
      b.style.cssText=(bg?'background:'+bg+';':'')+'font-size:13px;padding:8px 14px;';
      b.textContent=lbl; if(tip)b.title=tip;
      b.addEventListener('click',fn); sbEl.appendChild(b);
    };

    const avail=availableActions(curStatus,ctx);
    const has=a=>avail.includes(a);
    if(avail.length||can('report.delete'))showSb();

    if(has('save'))
      mkBtn('💾 임시저장','color:#64748b;border-color:#cbd5e1;',()=>applyReportTransition('save'));

    if(has('submit'))
      mkBtn('📤 제출','color:var(--amber);border-color:#fde68a;',()=>showConfirm('보고서 제출','제출 후에는 회수하기 전까지 수정할 수 없습니다.\n계속하시겠습니까?',()=>applyReportTransition('submit'),'제출'));

    if(has('approveTeam'))
      mkPrimary('✅ 팀장 결재','var(--green)','',()=>showConfirm('팀장 결재','팀장 결재를 진행하시겠습니까?',()=>{openBankStatementsForApproval();applyReportTransition('approveTeam');},'결재'));

    if(has('approveTeamProxy'))
      mkPrimary('✅ 팀장 결재 (대행)','var(--green)','배정된 팀장이 없거나 퇴사/역할변경 상태여서, 센터장·관리자가 팀장 결재를 대행합니다.',
        ()=>showConfirm('팀장 결재 대행','배정된 팀장이 공석입니다. 센터장·관리자로서 팀장 결재를 대행할까요?',()=>{openBankStatementsForApproval();applyReportTransition('approveTeamProxy');},'대행 결재'));

    if(has('approveCenter'))
      mkPrimary('🏁 최종 결재','','',()=>showConfirm('최종 결재','최종 결재를 완료하시겠습니까?',()=>{openBankStatementsForApproval();applyReportTransition('approveCenter');},'결재'));

    if(has('reject')){
      const box=can('report.approve.center')?'센터장':'팀장';
      mkBtn('↩️ 반려','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 반려','담당자에게 반려합니다.\n반려 사유를 '+box+' 의견란에 입력해 주세요.',()=>doReject(),'반려'));
    }

    if(has('recall'))
      mkBtn('↩ 회수','color:#7c3aed;border-color:#ddd6fe;',()=>recallReport(report?.id));

    if(has('revert')){
      const label=REVERT_LABEL[normalizeStatus(curStatus)]||'↩️ 결재 취소';
      const msg=REVERT_MSG[normalizeStatus(curStatus)]||'결재를 취소합니다.';
      mkBtn(label,'color:#64748b;border-color:#cbd5e1;',()=>showConfirm('결재 취소',msg,()=>applyReportTransition('revert'),'취소'));
    }

    // 반려 해제 — 담당자가 퇴사·부재여도 보고서가 영구 정지되지 않도록
    if(has('release'))
      mkBtn('🔓 반려 해제','color:#0369a1;border-color:#bae6fd;',()=>showConfirm('반려 해제','반려 상태를 풀고 초안으로 되돌립니다.\n담당자가 부재일 때 사용하세요.',()=>applyReportTransition('release'),'해제'));

    if(can('report.delete')&&report?.id)
      mkBtn('🗑️ 삭제','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 삭제','이 보고서를 삭제하시겠습니까?',()=>doDeleteReport(),'삭제','btn btn-danger'));

    if(!sbEl.children.length)sbEl.style.display='none';
  }
}

// ─────────────────────────────────────────────
// 결재 실행 — 모든 경로가 전이표를 통과한다
// ─────────────────────────────────────────────

/**
 * 결재 전이를 실행한다. **모든 결재 동작이 이 함수 하나를 통과한다.**
 * 버튼이 보이든 말든, 콘솔에서 직접 부르든, 전이표를 통과하지 못하면 거부된다.
 */
export async function applyReportTransition(action,extraSet){
  if(!S.reportData){toast('먼저 조회하세요.','error');return false;}
  const{clientId,year,month,report,summary}=S.reportData;

  // 화면도 전이표를 본다 — 서버에 갈 필요 없는 거부를 여기서 걸러 안내 문구를
  // 그대로 보여 주기 위해서다. **집행은 서버가 한다.** 이 검사를 지워도
  // 보안은 그대로이고, 서버가 같은 표로 다시 판정한다.
  const plan=planTransition(action,report?.status,reportActorContext());
  if(!plan.ok){toast(plan.reason,'error',4000);return false;}

  showLoading(true);
  try{
    const res=await window._fbFn.call('applyReportTransition')({
      clientId,year,month,action,
      summary:JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance}),
      extraSet:extraSet||{},
      userName:S.user?.name||'',
    });
    const out=res.data||{};

    const clientName=S.clients.find(c=>c.id===clientId)?.name||clientId;
    await auditLog(TRANSITION_AUDIT[action]||'report.save',{
      resourceId:out.reportId,
      summary:{clientName,year,month,from:out.from||'미저장',to:out.to},
    });

    const isReject=action==='reject';
    toast(TRANSITION_TOAST[action]||'처리되었습니다.',isReject?'info':'success',isReject?4000:3000);
    // 바뀐 것은 이 보고서 한 건이다. 목록 전체를 다시 읽지 않는다.
    // 지운 도장은 캐시에서도 비운다 — 그러지 않으면 회수한 뒤에도 목록의
    // '제출자' 칸에 이전 이름이 남는다.
    const cachePatch={status:out.to,...(extraSet||{})};
    for(const f of (out.cleared||[]))cachePatch[f]='';
    patchReportCache({...(S.reportData.report||{}),clientId,year,month,...cachePatch,id:out.reportId});
    await loadReport(); renderReportList();
    return true;
  }catch(e){
    toast('처리 실패: '+(e.message||e),'error',5000);
    return false;
  }finally{showLoading(false);}
}

/**
 * 구 호출부 호환 — action이 'draft'면 임시저장, 아니면 현재 상태에서
 * 내가 할 수 있는 전진 결재 하나를 골라 실행한다.
 * 예전에는 여기서 역할 문자열만 보고 report.status를 확인하지 않아
 * draft → confirmed 한 번에 점프가 가능했다.
 */
export async function doApproval(action){
  if(action==='draft')return applyReportTransition('save');
  const ctx=reportActorContext();
  const avail=availableActions(S.reportData?.report?.status,ctx);
  const forward=['approveCenter','approveTeam','approveTeamProxy','submit']
    .find(a=>avail.includes(a));
  if(!forward){toast('현재 상태에서 진행할 수 있는 결재가 없습니다.','error',4000);return false;}
  return applyReportTransition(forward);
}

export async function doTeamApproveProxy(){
  return applyReportTransition('approveTeamProxy');
}

export async function doReject(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return false;}
  // 반려 사유 필수 — 내가 쓸 수 있는 의견란을 기준으로 고른다.
  // 예전에는 role==='팀장' 문자열로 갈라서, 배정 팀장이 센터장이거나
  // 관리자면 엉뚱한 칸을 읽어 항상 "사유를 입력하세요"에 걸렸다.
  const useCenterBox=can('report.approve.center');
  const commentKey=useCenterBox?'centerComment':'leaderComment';
  const commentLabel=useCenterBox?'센터장':'팀장';
  const ta=document.getElementById('comment-'+commentKey);
  const reason=(ta?.value||'').trim();
  if(!reason){
    toast(`반려하려면 아래 "${commentLabel} 의견"란에 반려 사유를 입력해 주세요.`,'error',4000);
    if(ta){ta.style.borderColor='#dc2626';ta.focus();ta.scrollIntoView({behavior:'smooth',block:'center'});}
    return false;
  }
  // 사유를 반려와 함께 기록 (별도 저장 버튼을 누르지 않아도 반영)
  return applyReportTransition('reject',{[commentKey]:reason});
}

/** 결재 취소 — 되돌아갈 단계는 전이표가 정한다(byRole은 구 호출부 호환용). */
export async function doRevertToDraft(){
  return applyReportTransition('revert');
}

export async function doDeleteReport(){
  if(!can('report.delete')){toast(unavailableMessage('report.delete'),'error',5000);return false;}
  if(!S.reportData?.report?.id){toast('저장된 보고서가 없습니다.','error');return false;}
  const deletedId=S.reportData.report.id;
  const{clientId,year,month}=S.reportData;
  try{
    await window._fbFn.call('deleteReport')({clientId,year,month});
  }catch(e){toast('삭제 실패: '+(e.message||e),'error',5000);return false;}
  S.reportData.report=null;
  toast('보고서가 삭제되었습니다.','success');
  document.getElementById('report-area').style.display='none';
  dropReportFromCache(deletedId);
  renderReportList();
  return true;
}

// ─────────────────────────────────────────────
// 보고서 회수 (recall)
// createdBy가 기록되기 시작하면서 담당자 본인 회수가 실제로 동작한다.
// ─────────────────────────────────────────────
export async function recallReport(reportId){
  const report=S.reportData?.report;
  if(!report||(reportId&&report.id!==reportId)){toast('보고서를 찾을 수 없습니다.','error');return false;}
  return new Promise(resolve=>{
    showConfirm('보고서 회수','보고서를 초안 상태로 되돌립니다. 계속하시겠습니까?',
      async()=>{resolve(await applyReportTransition('recall'));},'회수');
  });
}

/**
 * 「제출 전 확인」 패널.
 *
 * **작성 단계에서만 보인다.** 결재자에게는 담당자가 해야 할 일 목록이므로
 * 자리만 차지한다. 그리고 **막지 않는다** — 현금 영수증 없는 지출, 아직
 * 분류를 정하지 못한 건, 이번 달만 건너뛰는 고정항목은 전부 실제로 일어난다.
 *
 * 추가 읽기가 없다. 보고서를 조회한 시점에 그 달 거래와 고정항목이 이미
 * 메모리에 있다.
 */
function renderSubmitChecklist(curStatus){
  const el=document.getElementById('rpt-checklist');
  if(!el)return;
  el.style.display='none'; el.innerHTML='';
  // 작성 중일 때만. 제출 뒤에는 고칠 수 없으므로 알려 줄 이유도 없다.
  if(!S.reportData||!can('report.submit'))return;
  if(curStatus!=='draft'&&curStatus!==''&&curStatus!=='rejected')return;

  const clientId=S.reportData.clientId;
  const fixedItems=(S.allFixedItems||[]).filter(f=>f&&f.clientId===clientId);
  const result=reportChecklist({transactions:S.reportData.trxList,fixedItems});
  const lines=checklistLines(result);

  if(result.clean){
    el.style.display='block';
    el.innerHTML='<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;'
      +'padding:10px 14px;font-size:13px;color:#15803d;">✓ 제출 전 확인할 것이 없습니다.</div>';
    return;
  }

  el.style.display='block';
  el.innerHTML='<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 14px;">'
    +'<div style="font-size:13px;font-weight:800;color:#92400e;margin-bottom:8px;">제출 전 확인</div>'
    +'<ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;">'
    +lines.map(l=>`<li style="font-size:13px;color:#78350f;">${escHtml(l.label)}`
      +`<div style="font-size:11px;color:#a16207;margin-top:1px;">${escHtml(l.hint)}</div></li>`).join('')
    +'</ul>'
    +'<div style="font-size:11px;color:#a16207;margin-top:8px;">'
    +'그대로 제출해도 됩니다 — 확인만 하시라는 안내입니다.</div>'
    +'</div>';
}

// 현재 사용자가 결재해야 하는 대기 보고서만 추림 (팀장=담당 입주자의 submitted, 센터장/관리자=team_approved)
function filterPendingForUser(list){
  const userId=String(S.user?.userId||'');
  // teamLeader에는 문서 ID가 들어 있을 수도 있어(마이그레이션 전 데이터) 양쪽으로 대조한다.
  // 이 대조가 없어서 팀장 결재 대기 뱃지가 항상 0건이었다.
  const me=(S.users||[]).find(u=>String(u.id)===userId||String(u.userId)===userId);
  const myDocId=me?String(me.id):'';
  return list.filter(r=>{
    const client=(S.allClients||S.clients).find(c=>c.id===r.clientId);
    const tlId=String(client?.teamLeader||'');
    const mine=!!tlId&&(tlId===userId||(!!myDocId&&tlId===myDocId));
    if(can('report.approve.team')&&mine&&r.status==='submitted')return true;
    if(can('report.approve.center')&&r.status==='team_approved')return true;
    return false;
  });
}

// 대시보드 진입/로그인 시 결재 대기 신호 갱신 (보고서 탭을 열지 않아도 표시)
// 대기 보고서(submitted/team_approved)만 조회해 read 비용 최소화.
export async function refreshPendingApprovalBadge(){
  const isApprover=can('report.approve.team')||can('report.approve.center');
  const badge=document.getElementById('nav-rpt-badge');
  const banner=document.getElementById('dash-approval-banner');
  if(!isApprover){ if(badge)badge.style.display='none'; if(banner)banner.style.display='none'; return; }
  let list=[];
  try{
    const{getDocs,collection,query,where}=fb();
    const snap=await getDocs(query(collection(fdb(),COLS.REPORTS),where('status','in',['submitted','team_approved'])));
    list=snap.docs.map(d=>({id:d.id,...d.data()}));
  }catch(e){ return; }
  const pending=filterPendingForUser(list);
  if(badge){ if(pending.length){badge.textContent=pending.length;badge.style.display='inline';}else badge.style.display='none'; }
  if(banner){
    if(pending.length){
      banner.style.display='flex';
      banner.textContent=`⏳ 결재 대기 ${pending.length}건 — 눌러서 보고서로 이동`;
    }else banner.style.display='none';
  }
}

/** confirmedMonths 키 — 서버 트리거와 같은 형식이어야 하므로 lockKey를 쓴다. */
const monthKey=r=>lockKey(r.clientId, r.year, r.month);

/**
 * 보고서 하나가 바뀌었을 때 캐시를 제자리에서 고친다.
 *
 * 예전에는 결재 버튼을 누를 때마다 `reports` 컬렉션 **전체**를 다시 읽었다.
 * 입주자 30명 × 36개월이면 클릭 한 번에 약 1,080문서다. 바뀐 것은 한 건인데.
 */
export function patchReportCache(report){
  if(!report?.id)return;
  if(!Array.isArray(S.reportList))S.reportList=[];
  const i=S.reportList.findIndex(r=>r.id===report.id);
  if(i>=0)S.reportList[i]={...S.reportList[i],...report};
  else S.reportList.push({...report});
  S.reportList.sort((a,b)=>(b.year*100+b.month)-(a.year*100+a.month));
  // 결재 완료 월 잠금도 함께 유지한다.
  // ⚠️ 목록에서 통째로 다시 만들면 안 된다 — 목록은 최근 연도만 담으므로
  //    예전 연도의 잠금이 통째로 풀린다.
  if(!S.confirmedMonths)S.confirmedMonths=new Set();
  if(report.status==='confirmed')S.confirmedMonths.add(monthKey(report));
  else S.confirmedMonths.delete(monthKey(report));
}

/** 보고서가 삭제되면 캐시에서도 뺀다 */
export function dropReportFromCache(reportId){
  if(!Array.isArray(S.reportList))return;
  const r=S.reportList.find(x=>x.id===reportId);
  if(r)S.confirmedMonths?.delete(monthKey(r));
  S.reportList=S.reportList.filter(x=>x.id!==reportId);
}

/** 목록에 담을 최소 연도 — 기본은 작년부터 (그 이전은 "전체 기간"으로 조회) */
export function reportListMinYear(){
  return S.rptListAllYears ? 0 : new Date().getFullYear()-1;
}

/**
 * 보고서 목록을 불러온다.
 *
 * @param {Object|boolean} [opts] `{force:true}`(또는 true)면 캐시를 무시하고 다시 읽는다.
 *
 * 캐시가 있으면 읽지 않고 그리기만 한다. 결재 동작은 바뀐 한 건만
 * patchReportCache로 고치므로, 결재할 때마다 전체를 다시 읽던 비용이 사라진다.
 */
export async function loadReportList(opts){
  const force=opts===true||(opts&&opts.force);
  if(!force&&Array.isArray(S.reportList)){renderReportList();return;}
  try{
    const{getDocs,collection,query,where}=fb();
    const minYear=reportListMinYear();
    const db=fdb();

    // 담당자는 **담당 입주자의 보고서만** 읽는다.
    //
    // 예전에는 전 입주자의 보고서를 다 읽었다. 두 가지가 잘못됐다:
    //   · 읽기 — 보고서 200건이면 담당 4명인 담당자도 200건을 낸다.
    //     이것이 담당자 한 세션의 읽기에서 가장 큰 항목이었다.
    //   · 범위 — 담당하지 않는 입주자의 결재 의견까지 브라우저로 내려온다.
    //     규칙은 등급 2 이상에게 reports를 열어 두므로 규칙이 막지 못한다.
    //     앱이 필요한 것만 요청해야 한다.
    //
    // 팀장·센터장(report.view.all)은 전체를 봐야 한다 — 결재 대기 목록이
    // 담당 배정과 무관하게 올라오기 때문이다.
    const rows=[];
    if(can('report.view.all')){
      const q=minYear>0
        ? query(collection(db,COLS.REPORTS),where('year','>=',minYear))
        : collection(db,COLS.REPORTS);
      const snap=await getDocs(q);
      snap.docs.forEach(d=>rows.push({id:d.id,...d.data()}));
    }else{
      // in 절은 30개 제한이 있으므로 나눠 조회한다. 담당 입주자가 없으면
      // chunkForInQuery가 빈 배열을 돌려주므로 **무필터 조회로 흘러내리지 않는다.**
      const myClientIds=(S.clients||[]).map(c=>c.id);
      for(const chunk of chunkForInQuery(myClientIds)){
        const clauses=[where('clientId','in',chunk)];
        if(minYear>0)clauses.push(where('year','>=',minYear));
        const snap=await getDocs(query(collection(db,COLS.REPORTS),...clauses));
        snap.docs.forEach(d=>rows.push({id:d.id,...d.data()}));
      }
    }
    S.reportList=rows.sort((a,b)=>(b.year*100+b.month)-(a.year*100+a.month));
  }catch(e){
    toast('보고서 목록 로드 실패: '+e.message,'error');
    if(!Array.isArray(S.reportList))S.reportList=[];
  }
  renderReportList();
}

export function renderReportList(){
  const list=S.reportList||[];
  const el=document.getElementById('rpt-list'); if(!el)return;
  const pendingEl=document.getElementById('rpt-pending-list');
  if(pendingEl){
    const pending=filterPendingForUser(list);
    const pendingCountEl=document.getElementById('rpt-pending-count');
    if(pendingCountEl)pendingCountEl.textContent=pending.length?pending.length+'건':'없음';
    pendingEl.innerHTML='';
    if(!pending.length){pendingEl.innerHTML='<div style="font-size:13px;color:var(--muted);padding:8px 0;">결재 대기 중인 보고서가 없습니다.</div>';}
    else pending.forEach(r=>{
      const client=S.clients.find(c=>c.id===r.clientId)||{name:r.clientId};
      const div=document.createElement('div');
      div.style.cssText='display:flex;justify-content:space-between;align-items:center;background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;margin-bottom:6px;cursor:pointer;';
      div.innerHTML='<div><div style="font-weight:700;color:#92400e;font-size:14px;">⏳ '+client.name+' — '+r.year+'년 '+r.month+'월</div><div style="font-size:12px;color:#b45309;margin-top:2px;">결재 대기 중</div></div><span class="'+(STATUS_CLASSES[r.status]||'rs-draft')+'">'+(STATUS_LABELS[r.status]||r.status)+'</span>';
      div.addEventListener('click',()=>{
        const rc=document.getElementById('r-client'),ry=document.getElementById('r-year'),rm=document.getElementById('r-month');
        if(rc)rc.value=r.clientId; if(ry)ry.value=r.year; if(rm)rm.value=r.month; loadReport();
      });
      pendingEl.appendChild(div);
    });
    const pendingWrap=document.getElementById('rpt-pending-wrap');
    if(pendingWrap)pendingWrap.style.display=can('report.view.all')?'block':'none';
    const badge=document.getElementById('nav-rpt-badge');
    if(badge){if(pending.length>0){badge.textContent=pending.length;badge.style.display='inline';}else badge.style.display='none';}
  }
  // 담당자 역할은 자신이 담당하는 대상자의 보고서만 표시 (S.clients는 이미 필터됨)
  const myClientIds=new Set(S.clients.map(c=>c.id));
  const visibleList=!can('report.view.all')?list.filter(r=>myClientIds.has(r.clientId)):list;
  const countEl=document.getElementById('rpt-list-count');
  if(countEl)countEl.textContent=visibleList.length+'건';
  if(!visibleList.length){el.innerHTML='<div class="empty-state"><div class="icon">📑</div>저장된 보고서가 없습니다.</div>';return;}
  el.innerHTML=''; // 매 호출마다 컨테이너 비우기 (중복 누적 방지)
  // 테이블 형식 렌더링
  const table=document.createElement('table');
  table.style.cssText='width:100%;border-collapse:collapse;font-size:13px;';
  table.innerHTML=`<thead><tr style="border-bottom:2px solid var(--border);">
    <th style="padding:8px 10px;text-align:left;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;white-space:nowrap;">입주자</th>
    <th style="padding:8px 10px;text-align:center;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">연도</th>
    <th style="padding:8px 10px;text-align:center;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">월</th>
    <th style="padding:8px 10px;text-align:center;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">상태</th>
    <th style="padding:8px 10px;text-align:left;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">제출자</th>
    <th style="padding:8px 10px;text-align:left;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">작성일</th>
  </tr></thead>`;
  const tbody=document.createElement('tbody');
  visibleList.forEach(r=>{
    const client=S.clients.find(c=>c.id===r.clientId)||{name:r.clientId};
    const tr=document.createElement('tr');
    tr.dataset.reportId=r.id;
    tr.style.cssText='border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s;';
    tr.innerHTML=`<td style="padding:9px 10px;font-weight:600;color:var(--text);">${escHtml(client.name)}</td>
      <td style="padding:9px 10px;text-align:center;color:var(--sub);">${r.year}년</td>
      <td style="padding:9px 10px;text-align:center;color:var(--sub);">${r.month}월</td>
      <td style="padding:9px 10px;text-align:center;"><span class="${STATUS_CLASSES[r.status]||'rs-draft'}">${escHtml(STATUS_LABELS[r.status]||r.status)}</span></td>
      <td style="padding:9px 10px;color:var(--muted);font-size:12px;">${escHtml(r.submittedByName||'-')}</td>
      <td style="padding:9px 10px;color:var(--muted);font-size:12px;">${r.createdAt?new Date(r.createdAt).toLocaleDateString('ko-KR'):'-'}</td>`;
    tr.addEventListener('mouseenter',()=>{if(S.reportData?.report?.id!==r.id)tr.style.background='var(--bg)';});
    tr.addEventListener('mouseleave',()=>{if(S.reportData?.report?.id!==r.id)tr.style.background='';});
    tr.addEventListener('click',()=>{
      if(S.reportData?.report?.id===r.id){
        closeReportView();
        return;
      }
      tbody.querySelectorAll('tr').forEach(t=>{t.style.background='';t.style.fontWeight='';});
      tr.style.background='#eff6ff';
      const rc=document.getElementById('r-client'),ry=document.getElementById('r-year'),rm=document.getElementById('r-month');
      if(rc)rc.value=r.clientId; if(ry)ry.value=r.year; if(rm)rm.value=r.month; loadReport();
      // 보고서 클릭 시 목록 자동 접기
      const listEl=document.getElementById('rpt-list');
      const arrowEl=document.getElementById('rpt-list-arrow');
      const refreshBtn=document.getElementById('btn-rpt-list-refresh');
      if(listEl)listEl.style.display='none';
      if(arrowEl)arrowEl.textContent='▶';
      if(refreshBtn)refreshBtn.style.display='none';
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  el.appendChild(table);
}

export async function exportReportExcel(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{clientId,year,month,trxList,accs,accountRows,report,summary}=S.reportData;
  const client=S.clients.find(c=>c.id===clientId)||{name:'-'};
  const XLSX=window.XLSX;
  if(!XLSX){toast('엑셀 라이브러리가 없습니다.','error');return;}

  // ── 스타일 헬퍼 ──
  const border={top:{style:'thin',color:{rgb:'E5E7EB'}},bottom:{style:'thin',color:{rgb:'E5E7EB'}},left:{style:'thin',color:{rgb:'E5E7EB'}},right:{style:'thin',color:{rgb:'E5E7EB'}}};
  const sTitle={font:{name:'맑은 고딕',sz:18,bold:true,color:{rgb:'111827'}},alignment:{horizontal:'left',vertical:'center'}};
  const sBrand={font:{name:'맑은 고딕',sz:9,bold:true,color:{rgb:'9CA3AF'}},alignment:{horizontal:'left',vertical:'center'}};
  const sPeriod={font:{name:'맑은 고딕',sz:11,color:{rgb:'6B7280'}},alignment:{horizontal:'left',vertical:'center'}};
  const sMetaLabel={font:{name:'맑은 고딕',sz:9,bold:true,color:{rgb:'9CA3AF'}},alignment:{horizontal:'left',vertical:'center'},fill:{fgColor:{rgb:'F9FAFB'}}};
  const sMetaValue={font:{name:'맑은 고딕',sz:12,bold:true,color:{rgb:'111827'}},alignment:{horizontal:'left',vertical:'center'},fill:{fgColor:{rgb:'F9FAFB'}}};
  const sSectionLabel={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'9CA3AF'}},alignment:{horizontal:'left',vertical:'center'}};
  const sSumIncLbl={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'16A34A'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'F0FDF4'}},border};
  const sSumIncVal={font:{name:'맑은 고딕',sz:14,bold:true,color:{rgb:'15803D'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'F0FDF4'}},border,numFmt:'#,##0"원"'};
  const sSumOutLbl={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'DC2626'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'FFF1F2'}},border};
  const sSumOutVal={font:{name:'맑은 고딕',sz:14,bold:true,color:{rgb:'B91C1C'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'FFF1F2'}},border,numFmt:'#,##0"원"'};
  const sSumBalLbl={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'2563EB'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'EFF6FF'}},border};
  const sSumBalVal={font:{name:'맑은 고딕',sz:14,bold:true,color:{rgb:'1D4ED8'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'EFF6FF'}},border,numFmt:'#,##0"원"'};
  const sThead={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'6B7280'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'F9FAFB'}},border};
  const sTd={font:{name:'맑은 고딕',sz:10,color:{rgb:'374151'}},alignment:{horizontal:'left',vertical:'center'},border};
  const sTdCtr={...sTd,alignment:{horizontal:'center',vertical:'center'}};
  const sTdNum={...sTd,alignment:{horizontal:'right',vertical:'center'},numFmt:'#,##0"원"'};
  const sTdNumIn={...sTdNum,font:{name:'맑은 고딕',sz:10,color:{rgb:'15803D'}}};
  const sTdNumOut={...sTdNum,font:{name:'맑은 고딕',sz:10,color:{rgb:'B91C1C'}}};
  const sTdPct={...sTd,alignment:{horizontal:'right',vertical:'center'},numFmt:'0"%"'};
  const sFootLbl={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'374151'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'F3F4F6'}},border};
  const sFootIn={...sTdNumIn,font:{name:'맑은 고딕',sz:11,bold:true,color:{rgb:'15803D'}},fill:{fgColor:{rgb:'F3F4F6'}}};
  const sFootOut={...sTdNumOut,font:{name:'맑은 고딕',sz:11,bold:true,color:{rgb:'B91C1C'}},fill:{fgColor:{rgb:'F3F4F6'}}};
  const sCmtLabel={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'9CA3AF'}},alignment:{horizontal:'left',vertical:'top'},fill:{fgColor:{rgb:'F9FAFB'}},border};
  const sCmtValue={font:{name:'맑은 고딕',sz:11,color:{rgb:'111827'}},alignment:{horizontal:'left',vertical:'top',wrapText:true},border};

  const ws={};
  const merges=[];
  const rows=[];
  let r=0;
  const setRow=(h)=>{rows[r]={hpt:h};};
  const set=(c,addr,style,val,fmt)=>{ws[addr]={t:typeof val==='number'?'n':'s',v:val,s:style};if(fmt)ws[addr].z=fmt;};
  const cell=(col,row)=>XLSX.utils.encode_cell({c:col,r:row});
  // 병합 범위 전체에 스타일을 채워 테두리가 끊기지 않도록 함
  // 값은 첫 셀에만, 나머지는 빈 문자열 + 동일 스타일
  const mergeCell=(c1,c2,row,style,val,fmt)=>{
    for(let cc=c1;cc<=c2;cc++){
      const addr=cell(cc,row);
      if(cc===c1){set(null,addr,style,val,fmt);}
      else {ws[addr]={t:'s',v:'',s:style};}
    }
    if(c2>c1)merges.push({s:{c:c1,r:row},e:{c:c2,r:row}});
  };
  const COLS_N=8; // 컬럼 0~7 (A~H)

  // ── 1. 타이틀 블록 ──
  mergeCell(0,COLS_N-1,r,sBrand,'CARE LEDGER');         setRow(20); r++;
  mergeCell(0,COLS_N-1,r,sTitle,'월별 금전관리 보고서');  setRow(30); r++;
  mergeCell(0,COLS_N-1,r,sPeriod,year+'년 '+month+'월 거래 내역'); setRow(20); r++;
  r++; // 공백 행

  // ── 2. 메타데이터 (입주자/기간/담당자) ──
  mergeCell(0,1,r,sMetaLabel,'입주자');
  mergeCell(2,3,r,sMetaLabel,'기간');
  mergeCell(4,COLS_N-1,r,sMetaLabel,'담당자');
  setRow(18); r++;
  mergeCell(0,1,r,sMetaValue,client.name);
  mergeCell(2,3,r,sMetaValue,year+'년 '+month+'월');
  mergeCell(4,COLS_N-1,r,sMetaValue,reportStaffName(report));
  setRow(22); r++;
  r++;

  // ── 3. 수입/지출/잔액 요약 ──
  mergeCell(0,COLS_N-1,r,sSectionLabel,'수입 / 지출 요약'); setRow(18); r++;
  // 라벨 행
  mergeCell(0,1,r,sSumIncLbl,'총 수입');
  mergeCell(2,4,r,sSumOutLbl,'총 지출');
  mergeCell(5,COLS_N-1,r,sSumBalLbl,'잔액');
  setRow(18); r++;
  // 값 행
  mergeCell(0,1,r,sSumIncVal,Number(summary.totalIn||0));
  mergeCell(2,4,r,sSumOutVal,Number(summary.totalOut||0));
  mergeCell(5,COLS_N-1,r,sSumBalVal,Number(summary.balance||0));
  setRow(28); r++;
  r++;

  // ── 4. 계좌 현황 ──
  mergeCell(0,COLS_N-1,r,sSectionLabel,'계좌 현황'); setRow(18); r++;
  mergeCell(0,2,r,sThead,'계좌');
  mergeCell(3,3,r,sThead,'전월 잔액');
  mergeCell(4,4,r,sThead,'수입');
  mergeCell(5,5,r,sThead,'지출');
  mergeCell(6,COLS_N-1,r,sThead,'현재 잔액');
  setRow(20); r++;
  (accountRows||getReportAccountRows(year,month,accs,S.reportData.allTrx)).forEach(a=>{
    mergeCell(0,2,r,sTd,a.label||'-');
    mergeCell(3,3,r,sTdNum,Number(a.prevBal||0));
    mergeCell(4,4,r,sTdNumIn,Number(a.monthlyIn||0));
    mergeCell(5,5,r,sTdNumOut,Number(a.monthlyOut||0));
    mergeCell(6,COLS_N-1,r,{...sTdNum,font:{name:'맑은 고딕',sz:11,bold:true,color:{rgb:Number(a.bal||0)>=0?'111827':'DC2626'}}},Number(a.bal||0));
    setRow(20); r++;
  });
  r++;

  // ── 5. 분류별 지출 ──
  const catKeys=Object.keys(summary.catStats||{});
  if(catKeys.length){
    mergeCell(0,COLS_N-1,r,sSectionLabel,'분류별 지출'); setRow(18); r++;
    mergeCell(0,3,r,sThead,'분류');
    mergeCell(4,6,r,sThead,'금액');
    mergeCell(7,7,r,sThead,'비율');
    setRow(20); r++;
    const sortedCatKeys=[...catKeys].sort((a,b)=>(summary.catStats[b]?.total||0)-(summary.catStats[a]?.total||0));
    sortedCatKeys.forEach(k=>{
      const v=summary.catStats[k];
      const pct=summary.totalOut>0?Math.round(v.total/summary.totalOut*100):0;
      mergeCell(0,3,r,sTd,k);
      mergeCell(4,6,r,sTdNumOut,Number(v.total||0));
      mergeCell(7,7,r,sTdPct,pct);
      setRow(20); r++;
    });
    r++;
  }

  // ── 6. 거래 내역 ──
  mergeCell(0,COLS_N-1,r,sSectionLabel,'거래 내역'); setRow(18); r++;
  mergeCell(0,1,r,sThead,'날짜');
  mergeCell(2,2,r,sThead,'분류');
  mergeCell(3,5,r,sThead,'내용');
  mergeCell(6,6,r,sThead,'수입');
  mergeCell(7,7,r,sThead,'지출');
  setRow(22); r++;
  const excelByAccount=new Map();
  (accs||[]).forEach(a=>excelByAccount.set(a.id,{account:a,items:[]}));  
  (trxList||[]).forEach(t=>{
    if(!excelByAccount.has(t.accountId))excelByAccount.set(t.accountId,{account:S.accounts.find(a=>a.id===t.accountId)||{label:'미지정 계좌'},items:[]});
    excelByAccount.get(t.accountId).items.push(t);
  });
  excelByAccount.forEach(group=>{
    if(!group.items.length)return;
    const subIn=group.items.reduce((sum,t)=>t.type==='자산이동'||t.type==='취소'?sum:sum+Number(t.amountIn||0),0);
    const subOut=group.items.reduce((sum,t)=>t.type==='자산이동'||t.type==='취소'?sum:sum+Number(t.amountOut||0),0);
    mergeCell(0,COLS_N-1,r,{...sThead,alignment:{horizontal:'left',vertical:'center'}},`🏦 ${group.account.label||'미지정 계좌'} (${group.items.length}건 · 수입 ${subIn.toLocaleString()}원 · 지출 ${subOut.toLocaleString()}원)`);
    setRow(20); r++;
    group.items.forEach(t=>{    
    mergeCell(0,1,r,sTdCtr,t.date||'');
    mergeCell(2,2,r,sTdCtr,t.category||'');
    let descTxt=t.description||'';
    if(t.type==='자산이동'){
      const srcId=Number(t.amountOut||0)>0?t.accountId:t.linkedAccountId;
      const dstId=Number(t.amountOut||0)>0?t.linkedAccountId:t.accountId;
      const src=S.accounts.find(a=>a.id===srcId)?.label||'?';
      const dst=S.accounts.find(a=>a.id===dstId)?.label||'?';
      descTxt=(descTxt?descTxt+' ':'')+'[↕이동 '+src+' → '+dst+']';
    } else if(t.type==='취소'){
      const sub=Number(t.amountIn||0)>0?'수입':'지출';
      descTxt=(descTxt?descTxt+' ':'')+'[취소('+sub+')]';
    }
    mergeCell(3,5,r,sTd,descTxt);
    const amtIn=Number(t.amountIn||0);
    const amtOut=Number(t.amountOut||0);
    mergeCell(6,6,r,amtIn>0?sTdNumIn:sTd,amtIn>0?amtIn:'');
    mergeCell(7,7,r,amtOut>0?sTdNumOut:sTd,amtOut>0?amtOut:'');
    setRow(18); r++;
    });      
  });
  // 거래내역 합계 행
  mergeCell(0,5,r,sFootLbl,'합계');
  mergeCell(6,6,r,sFootIn,Number(summary.totalIn||0));
  mergeCell(7,7,r,sFootOut,Number(summary.totalOut||0));
  setRow(22); r++;
  r++;

  // ── 7. 의견 (있을 때만) ──
  const cmts=[
    {label:'담당자 의견',value:report?.staffComment||''},
    {label:'팀장 의견',value:report?.leaderComment||''},
    {label:'센터장 의견',value:report?.centerComment||''}
  ].filter(c=>c.value);
  if(cmts.length){
    mergeCell(0,COLS_N-1,r,sSectionLabel,'의견'); setRow(18); r++;
    cmts.forEach(c=>{
      mergeCell(0,1,r,sCmtLabel,c.label);
      mergeCell(2,COLS_N-1,r,sCmtValue,c.value);
      setRow(48); r++;
    });
  }

  // ── 워크시트 설정 ──
  ws['!ref']=XLSX.utils.encode_range({s:{c:0,r:0},e:{c:COLS_N-1,r:r-1}});
  ws['!merges']=merges;
  ws['!cols']=[{wch:12},{wch:8},{wch:12},{wch:18},{wch:10},{wch:10},{wch:14},{wch:14}];
  ws['!rows']=rows;
  // 인쇄 옵션
  ws['!pageSetup']={orientation:'portrait',paperSize:9,fitToWidth:1,fitToHeight:0};
  ws['!margins']={left:0.4,right:0.4,top:0.5,bottom:0.5,header:0.3,footer:0.3};

  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,year+'년'+month+'월');
  XLSX.writeFile(wb,client.name+'_'+year+'년'+month+'월_금전관리.xlsx');
  toast('엑셀 저장 완료','success');
}
