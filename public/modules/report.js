/**
 * modules/report.js — Smart Care Ledger v2
 * 보고서: 로드, 렌더링, 결재 흐름, 연간 통계
 */

'use strict';

import { S } from '../state.js';
import { COLS, CAT_COLORS, STATUS_LABELS, STATUS_CLASSES, cs } from '../constants.js';
import { toast, showConfirm, showLoading, setText } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import { can } from './permissions.js';
import { calcAccountBalanceAsOf, sumIncomeExpense } from '../services/balance.js';
import { getImageUrl } from '../services/storage.js';
import { getUnpaidMandatoryItems } from './modals.js';

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
 * 같은 입주자의 전체 거래가 이미 S.transactions에 로드되어 있으면 캐시 재사용.
 * 그렇지 않으면 fetch 후 S.transactions에 저장 (다음 호출 시 재사용 가능).
 */
async function getClientTrxAll(clientId) {
  if (S.activeClient === clientId
      && S.trxRange === 'all'
      && Array.isArray(S.transactions)
      && S.transactions.length) {
    return S.transactions;
  }
  const { getDocs, collection, query, where } = fb();
  const snap = await getDocs(query(collection(fdb(),COLS.TRANSACTIONS), where('clientId','==',clientId)));
  const trx = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  S.transactions = trx;
  S.activeClient = clientId;
  S.trxRange = 'all';
  return trx;
}

// ─────────────────────────────────────────────
// 규칙 기반 자동 분석 (API 없음)
// ─────────────────────────────────────────────
export function generateRuleBasedSummary(reportData) {
  const { year, month, trxList, summary } = reportData;
  const { totalIn, totalOut, balance } = summary;
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
    div.innerHTML=`<span style="width:22px;height:22px;border-radius:50%;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--sub);">${i+1}</span><span style="flex:1;font-size:14px;font-weight:600;">${k}</span><div style="flex:2;height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden;"><div style="height:100%;background:${c.dot};border-radius:99px;width:${pct}%;"></div></div><span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;width:90px;text-align:right;">${catMap[k].toLocaleString()}원</span><span style="font-size:12px;color:var(--muted);width:36px;text-align:right;">${pct}%</span>${hasBudget?`<span style="font-size:11px;width:80px;text-align:right;color:var(--muted);">예산 ${budget?budget.toLocaleString()+'원':'-'}</span><span style="font-size:11px;width:48px;text-align:right;font-weight:700;color:${achieveColor};">${achieve!==null?achieve+'%':'-'}</span>`:''}`;
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
    const trxList=allTrx
      .filter(t=>t.date&&t.date.startsWith(mStr))
      .sort((a,b)=>{
        // ⑧ sortOrder 우선, 같으면 날짜+시간 오름차순
        const oA = a.sortOrder!=null ? a.sortOrder : 99999;
        const oB = b.sortOrder!=null ? b.sortOrder : 99999;
        if(oA!==oB) return oA-oB;
        const dtA=(a.date||'')+(a.time?' '+a.time:'');
        const dtB=(b.date||'')+(b.time?' '+b.time:'');
        return dtA.localeCompare(dtB);
      });
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

export function renderReportView(){
  const{clientId,year,month,trxList,accs,accountRows,report,summary}=S.reportData;
  const client=S.clients.find(c=>c.id===clientId)||{name:'-'};
  const now=new Date(), curStatus=report?report.status:'';
  setText('rpt-period',`${year}년 ${month}월 거래 내역`);
  setText('rpt-created',`작성: ${now.toLocaleDateString('ko-KR')}`);
  setText('rpt-created-bottom',now.toLocaleDateString('ko-KR'));
  setText('rpt-client-name',client.name);
  setText('rpt-month-label',`${year}년 ${month}월`);
  setText('rpt-staff-name',report?.submittedByName||(S.user?.name||'-'));
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
    row.innerHTML=`<span style="font-size:14px;color:#374151;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.label}</span>`
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
    header.innerHTML=`<td colspan="6" style="padding:8px 6px;background:#f8fafc;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:800;color:#374151;">🏦 ${group.account.label||'미지정 계좌'} <span style="font-weight:600;color:#6b7280;margin-left:8px;">${group.items.length}건 · 수입 ${subIn.toLocaleString()}원 · 지출 ${subOut.toLocaleString()}원</span></td>`;
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
    tr.innerHTML=`<td style="padding:7px 4px;font-family:monospace;font-size:13px;color:#6b7280;white-space:nowrap;">${t.date||''}</td>`
      +`<td style="padding:4px 4px;overflow:hidden;white-space:nowrap;"><span style="display:inline-block;background:${catClr.bg};color:${catClr.text};border:1px solid ${catClr.border};border-radius:10px;padding:2px 6px;font-size:11px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.category||''}</span></td>`
      +`<td style="padding:7px 4px;font-size:13px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.description||''}${typeTag}</td>`
      +`<td style="padding:7px 4px;text-align:right;font-family:monospace;font-size:13px;color:#15803d;white-space:nowrap;">${Number(t.amountIn||0)>0?Number(t.amountIn).toLocaleString()+'원':''}</td>`
      +`<td style="padding:7px 4px;text-align:right;font-family:monospace;font-size:13px;color:#b91c1c;white-space:nowrap;">${Number(t.amountOut||0)>0?Number(t.amountOut).toLocaleString()+'원':''}</td>`
      +`<td style="padding:7px 4px;text-align:center;${t.type==='지출'&&!t.receiptUrl&&t.receiptMissing?'background:#fee2e2;':''}">${
        t.receiptUrl?'<button class="icon-btn rpt-rv" data-url="'+t.receiptUrl+'" title="증빙 보기">📎</button>':
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
    if(rvBtn)rvBtn.addEventListener('click',()=>openReceiptModal(rvBtn.dataset.url,t.id));
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
  // sortOrder 기준 기본 정렬 후 현재 보고서 정렬키 적용
  const baseSort=newTrxList.sort((a,b)=>{
    const oA=a.sortOrder!=null?a.sortOrder:99999;
    const oB=b.sortOrder!=null?b.sortOrder:99999;
    if(oA!==oB)return oA-oB;
    const dtA=(a.date||'')+(a.time?' '+a.time:'');
    const dtB=(b.date||'')+(b.time?' '+b.time:'');
    return dtA.localeCompare(dtB);
  });
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
  let imgIdx=0;
  const panel=document.createElement('div');
  panel.id='bank-float-panel';
  panel.style.cssText='position:fixed;right:16px;top:60px;width:400px;min-height:200px;max-height:90vh;z-index:9998;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);display:flex;flex-direction:column;resize:both;overflow:hidden;border:1px solid var(--border);';
  const renderImg=()=>{
    const it=imgs[imgIdx];
    const src=getImageUrl(it.url,'w800');
    panel.querySelector('#bfp-img').src=src;
    panel.querySelector('#bfp-label').textContent=`${it.label} (${imgIdx+1}/${imgs.length})`;
  };
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
  // 드래그
  const hdr=panel.querySelector('#bfp-header');
  let ox=0,oy=0,dragging=false;
  hdr.addEventListener('mousedown',e=>{dragging=true;ox=e.clientX-panel.offsetLeft;oy=e.clientY-panel.offsetTop;});
  document.addEventListener('mousemove',e=>{if(!dragging)return;panel.style.left=(e.clientX-ox)+'px';panel.style.top=(e.clientY-oy)+'px';panel.style.right='auto';});
  document.addEventListener('mouseup',()=>{dragging=false;});
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
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
  const client=S.clients.find(c=>c.id===S.reportData?.clientId);
  const teamLeaderId=String(client?.teamLeader||'');
  const isThisLeader=role==='팀장'&&userId===teamLeaderId;
  el.innerHTML='<div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;">의견</div>';
  const sections=[
    {key:'staffComment',  label:'담당자 의견', editable: role==='담당자'&&(!curStatus||curStatus==='draft'||curStatus==='rejected')},
    {key:'leaderComment', label:'팀장 의견',   editable: isThisLeader},
    {key:'centerComment', label:'센터장 의견', editable: role==='센터장'||role==='관리자'},
  ];
  sections.forEach(s=>{
    const val=report?.[s.key]||'';
    const div=document.createElement('div');
    div.style.cssText='margin-bottom:12px;';
    div.innerHTML='<div style="font-size:11px;font-weight:700;color:#6b7280;margin-bottom:6px;">'+s.label+'</div>';
    if(s.editable){
      div.innerHTML+='<textarea id="comment-'+s.key+'" style="width:100%;min-height:60px;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;resize:vertical;" placeholder="'+s.label+'을 입력하세요...">'+val+'</textarea>'
        +'<button onclick="saveComment(\''+s.key+'\')" style="margin-top:4px;font-size:12px;font-weight:700;color:var(--blue);border:1px solid #bfdbfe;background:#eff6ff;padding:4px 12px;border-radius:6px;cursor:pointer;">저장</button>';
    } else {
      div.innerHTML+='<div style="font-size:14px;color:#374151;min-height:30px;padding:8px 10px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">'+(val||'(없음)')+'</div>';
    }
    el.appendChild(div);
  });
}

export async function saveComment(key){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const val=document.getElementById('comment-'+key)?.value||'';
  const{doc,updateDoc,addDoc,collection}=fb();
  const{clientId,year,month,report}=S.reportData;
  const now=new Date().toISOString();
  if(report?.id){
    await updateDoc(doc(fdb(),COLS.REPORTS,report.id),{[key]:val});
    if(!S.reportData.report)S.reportData.report={};
    S.reportData.report[key]=val;
  } else {
    const data={clientId,year,month,status:'draft',createdAt:now,[key]:val};
    const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);
    S.reportData.report={id:ref.id,...data};
  }
  toast('의견이 저장되었습니다.','success',2000);
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
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
  const client=(S.allClients||S.clients).find(c=>c.id===S.reportData?.clientId);
  const teamLeaderId=String(client?.teamLeader||'');
  // teamLeader는 저장 경로에 따라 doc id 또는 userId로 들어올 수 있어 양쪽 모두로 매칭 (불일치 완화)
  const me=S.users.find(u=>String(u.id)===userId||String(u.userId)===userId);
  const isThisLeader=role==='팀장'&&(teamLeaderId===userId||(me&&teamLeaderId===String(me.id)));
  // 배정 팀장이 공석/삭제/역할변경/퇴사(비활성)면 vacant으로 간주 → 센터장·관리자가 대행
  const leaderUser=S.users.find(u=>String(u.id)===teamLeaderId||String(u.userId)===teamLeaderId);
  const leaderVacant=!teamLeaderId||!leaderUser||leaderUser.role!=='팀장'||leaderUser.active===false;
  const staffIds=String(client?.userIds||'').split(',').map(s=>s.trim());
  const isDirectStaff=staffIds.includes(userId);
  const isLeaderDirectSubmit=isThisLeader&&isDirectStaff;

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
    const done=curIdx>=ORDER.indexOf(s.key), dStr=s.date?new Date(s.date).toLocaleDateString('ko-KR',{month:'2-digit',day:'2-digit'}):'';
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
    '↩️ 결재 취소':'이미 한 결재를 취소하고 바로 이전 단계로 되돌립니다.',
    '✏️ 수정(초안)':'보고서를 작성 초안 상태로 되돌려 다시 수정할 수 있게 합니다.',
    '🗑️ 삭제':'보고서를 완전히 삭제합니다.',
  };
  const mkBtnTo=(container,lbl,style,fn)=>{const b=document.createElement('button');b.className='btn-sub';b.style.cssText=style+'font-size:13px;';b.textContent=lbl;if(ACTION_TIP[lbl])b.title=ACTION_TIP[lbl];b.addEventListener('click',fn);container.appendChild(b);};
  mkBtnTo(btns,'🖨️ 인쇄/PDF','color:var(--blue);border-color:#bfdbfe;',()=>{if(!S.reportData){toast('먼저 조회하세요.','error');return;}window.print();});
  mkBtnTo(btns,'📊 엑셀 저장','color:#059669;border-color:#a7f3d0;',exportReportExcel);

  // 하단: 제출/결재/반려 버튼
  const sbEl=document.getElementById('rpt-submit-btns');
  if(sbEl){
    sbEl.innerHTML='';
    sbEl.style.display='none';
    const mkBtn=(lbl,style,fn)=>mkBtnTo(sbEl,lbl,style,fn);
    const showSb=()=>{sbEl.style.display='flex';};

    if(role==='담당자'&&(!curStatus||curStatus==='draft'||curStatus==='rejected')){
      showSb();
      mkBtn('💾 임시저장','color:#64748b;border-color:#cbd5e1;',()=>doApproval('draft'));
      mkBtn('📤 제출','color:var(--amber);border-color:#fde68a;',()=>showConfirm('보고서 제출','제출 후에는 담당자가 수정할 수 없습니다.\n계속하시겠습니까?',()=>doApproval('approve'),'제출'));
    }
    // 담당자 본인이 제출한 보고서 회수 (submitted 상태 + 팀장 이상 역할 아닌 경우)
    if(can('report.recall')&&report?.createdBy===String(userId)&&curStatus==='submitted'&&!['팀장','센터장','관리자'].includes(role)){
      showSb();
      mkBtn('↩ 회수','color:#7c3aed;border-color:#ddd6fe;',()=>recallReport(report.id));
    }
    if(isLeaderDirectSubmit&&(!curStatus||curStatus==='draft')){
      showSb();
      mkBtn('💾 임시저장','color:#64748b;border-color:#cbd5e1;',()=>doApprovalAsLeader('draft'));
      mkBtn('📤 직접 제출','color:var(--amber);border-color:#fde68a;',()=>showConfirm('보고서 제출','담당 팀장으로서 직접 제출합니다.\n팀장 결재가 자동으로 완료됩니다.',()=>doApprovalAsLeader('submit_and_approve'),'제출'));
    }
    if(isThisLeader&&curStatus==='submitted'){
      showSb();
      const bApp=document.createElement('button');bApp.className='btn';bApp.style.cssText='background:var(--green);font-size:13px;padding:8px 14px;';
      bApp.textContent='✅ 팀장 결재';
      bApp.addEventListener('click',()=>showConfirm('팀장 결재','팀장 결재를 진행하시겠습니까?',()=>{openBankStatementsForApproval();doApproval('approve');},'결재'));
      sbEl.appendChild(bApp);
      mkBtn('↩️ 반려','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 반려','담당자에게 반려합니다.\n반려 사유를 팀장 의견란에 입력해 주세요.',()=>doReject(),'반려'));
      mkBtn('↩ 회수','color:#7c3aed;border-color:#ddd6fe;',()=>recallReport(report.id));
      mkBtn('✏️ 수정(초안)','color:#64748b;border-color:#cbd5e1;',()=>doRevertToDraft('팀장'));
      mkBtn('🗑️ 삭제','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 삭제','이 보고서를 삭제하시겠습니까?',()=>doDeleteReport(),'삭제','btn btn-danger'));
    }
    // 팀장 공석/무효 시: 센터장·관리자가 팀장 결재를 대행 (데스크톱에서도 보고서가 멈추지 않도록)
    if(!isThisLeader&&(role==='센터장'||role==='관리자')&&curStatus==='submitted'&&leaderVacant){
      showSb();
      const bProxy=document.createElement('button');bProxy.className='btn';bProxy.style.cssText='background:var(--green);font-size:13px;padding:8px 14px;';
      bProxy.textContent='✅ 팀장 결재 (대행)';
      bProxy.title='배정된 팀장이 없거나 퇴사/역할변경 상태여서, 센터장·관리자가 팀장 결재를 대행합니다.';
      bProxy.addEventListener('click',()=>showConfirm('팀장 결재 대행','배정된 팀장이 공석입니다. 센터장·관리자로서 팀장 결재를 대행할까요?',()=>{openBankStatementsForApproval();doTeamApproveProxy();},'대행 결재'));
      sbEl.appendChild(bProxy);
      mkBtn('↩️ 반려','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 반려','담당자에게 반려합니다.\n반려 사유를 의견란에 입력해 주세요.',()=>doReject(),'반려'));
    }
    if(isThisLeader&&curStatus==='team_approved'){
      showSb();
      mkBtn('↩ 회수','color:#7c3aed;border-color:#ddd6fe;',()=>recallReport(report.id));
      mkBtn('↩️ 결재 취소','color:#64748b;border-color:#cbd5e1;',()=>showConfirm('결재 취소','팀장 결재를 취소하고 제출 상태로 되돌립니다.',()=>doRevertToDraft('팀장'),'취소'));
    }
    if((role==='센터장'||role==='관리자')&&curStatus==='team_approved'){
      showSb();
      const bFinal=document.createElement('button');bFinal.className='btn';bFinal.style.cssText='font-size:13px;padding:8px 14px;';
      bFinal.textContent='🏁 최종 결재';
      bFinal.addEventListener('click',()=>showConfirm('최종 결재','최종 결재를 완료하시겠습니까?',()=>{openBankStatementsForApproval();doApproval('approve');},'결재'));
      sbEl.appendChild(bFinal);
      mkBtn('↩️ 반려','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 반려','반려합니다.\n반려 사유를 센터장 의견란에 입력해 주세요.',()=>doReject(),'반려'));
      mkBtn('↩ 회수','color:#7c3aed;border-color:#ddd6fe;',()=>recallReport(report.id));
      mkBtn('✏️ 수정(초안)','color:#64748b;border-color:#cbd5e1;',()=>doRevertToDraft('센터장'));
      mkBtn('🗑️ 삭제','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 삭제','이 보고서를 삭제하시겠습니까?',()=>doDeleteReport(),'삭제','btn btn-danger'));
    }
    if((role==='센터장'||role==='관리자')&&curStatus==='confirmed'){
      showSb();
      mkBtn('↩️ 결재 취소','color:#64748b;border-color:#cbd5e1;',()=>showConfirm('결재 취소','최종 결재를 취소하고 팀장결재 상태로 되돌립니다.',()=>doRevertToDraft('센터장'),'취소'));
      mkBtn('🗑️ 삭제','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 삭제','이 보고서를 삭제하시겠습니까?',()=>doDeleteReport(),'삭제','btn btn-danger'));
    }
  }
}

export async function doApproval(action){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{clientId,year,month,report,summary}=S.reportData;
  const{doc,updateDoc,collection,addDoc}=fb();
  const now=new Date().toISOString(), summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  if(action==='draft'){
    const data={clientId,year,month,status:'draft',summary:summaryStr,createdAt:now};
    if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),data);
    else{const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
    toast('임시저장되었습니다.','success');
  }else{
    const role=S.user?.role;
    const rules={
      담당자:{next:'submitted',atKey:'submittedAt',byKey:'submittedBy',nameKey:'submittedByName'},
      팀장:{next:'team_approved',atKey:'teamApprovedAt',byKey:'teamApprovedBy',nameKey:'teamApprovedByName'},
      센터장:{next:'confirmed',atKey:'centerApprovedAt',byKey:'centerApprovedBy',nameKey:'centerApprovedByName'},
      관리자:{next:'confirmed',atKey:'centerApprovedAt',byKey:'centerApprovedBy',nameKey:'centerApprovedByName'},
    };
    const rule=rules[role]; if(!rule){toast('결재 권한 없음','error');return;}
    const update={status:rule.next,summary:summaryStr,[rule.atKey]:now,[rule.byKey]:String(S.user.userId),[rule.nameKey]:S.user.name||''};
    if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),update);
    else{const data={clientId,year,month,createdAt:now,...update};const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
    toast({submitted:'제출되었습니다.',team_approved:'팀장 결재 완료.',confirmed:'최종 결재 완료.'}[rule.next]||'완료','success');
  }
  await loadReport(); loadReportList();
}

export async function doApprovalAsLeader(action){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{clientId,year,month,report,summary}=S.reportData;
  const{doc,updateDoc,collection,addDoc}=fb();
  const now=new Date().toISOString(), summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  if(action==='draft'){
    const data={clientId,year,month,status:'draft',summary:summaryStr,createdAt:now};
    if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),data);
    else{const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
    toast('임시저장되었습니다.','success');
  }else{
    const update={status:'team_approved',summary:summaryStr,submittedAt:now,submittedBy:String(S.user.userId),submittedByName:S.user.name||'',teamApprovedAt:now,teamApprovedBy:String(S.user.userId),teamApprovedByName:S.user.name||''};
    if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),update);
    else{const data={clientId,year,month,createdAt:now,...update};const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
    toast('팀장 직접 제출 완료! 센터장 결재 대기 중.','success');
  }
  await loadReport(); loadReportList();
}

export async function doReject(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  // 반려 사유 필수화 — 역할별 의견란(팀장/센터장) 값을 읽어 비어 있으면 반려를 막고 해당 칸으로 안내
  const role=S.user?.role||'';
  const commentKey=role==='팀장'?'leaderComment':'centerComment';
  const commentLabel=role==='팀장'?'팀장':'센터장';
  const ta=document.getElementById('comment-'+commentKey);
  const reason=(ta?.value||'').trim();
  if(!reason){
    toast(`반려하려면 아래 "${commentLabel} 의견"란에 반려 사유를 입력해 주세요.`,'error',4000);
    if(ta){ta.style.borderColor='#dc2626';ta.focus();ta.scrollIntoView({behavior:'smooth',block:'center'});}
    return;
  }
  const{clientId,year,month,report,summary}=S.reportData;
  const{doc,updateDoc,addDoc,collection}=fb();
  const now=new Date().toISOString();
  const summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  // 사유를 반려와 함께 기록 (별도 저장 버튼을 누르지 않아도 반영)
  const update={status:'rejected',summary:summaryStr,rejectedAt:now,rejectedBy:String(S.user.userId),rejectedByName:S.user.name||'',[commentKey]:reason};
  if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),update);
  else{const data={clientId,year,month,createdAt:now,...update};const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
  toast('보고서가 반려되었습니다.','info',4000);
  await loadReport(); loadReportList();
}

// 팀장 공석 대행 결재 — 센터장·관리자가 submitted→team_approved로 전진 (팀장 부재로 멈춘 보고서 해소)
// doApproval의 rules는 센터장/관리자를 confirmed로 보내므로 재사용 불가 → 전용 처리
export async function doTeamApproveProxy(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{report,summary}=S.reportData;
  if(!report?.id){toast('저장된 보고서가 없습니다.','error');return;}
  const{doc,updateDoc}=fb();
  const now=new Date().toISOString();
  const summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  // 대행 사실을 결재 기록에 남김
  const name=(S.user.name||S.user.userId||'')+' (팀장 대행)';
  await updateDoc(doc(fdb(),COLS.REPORTS,report.id),{status:'team_approved',summary:summaryStr,teamApprovedAt:now,teamApprovedBy:String(S.user.userId),teamApprovedByName:name});
  toast('팀장 결재를 대행 처리했습니다. 센터장 최종 결재 대기 중.','success');
  await loadReport(); loadReportList();
}

export async function doRevertToDraft(byRole){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{report,summary}=S.reportData;
  const{doc,updateDoc}=fb();
  const summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  let newStatus='draft';
  if(byRole==='팀장'&&S.reportData.report?.status==='team_approved')newStatus='submitted';
  if(byRole==='센터장'&&S.reportData.report?.status==='confirmed')newStatus='team_approved';
  if(!report?.id){toast('저장된 보고서가 없습니다.','error');return;}
  await updateDoc(doc(fdb(),COLS.REPORTS,report.id),{status:newStatus,summary:summaryStr});
  toast('상태가 변경되었습니다.','success');
  await loadReport(); loadReportList();
}

export async function doDeleteReport(){
  if(!S.reportData?.report?.id){toast('저장된 보고서가 없습니다.','error');return;}
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),COLS.REPORTS,S.reportData.report.id));
  S.reportData.report=null;
  toast('보고서가 삭제되었습니다.','success');
  document.getElementById('report-area').style.display='none';
  loadReportList();
}

// ─────────────────────────────────────────────
// 보고서 회수 (recall)
// ─────────────────────────────────────────────
export async function recallReport(reportId){
  const report=S.reportData?.report;
  if(!report||report.id!==reportId){toast('보고서를 찾을 수 없습니다.','error');return;}

  const role=S.user?.role;
  const isTeamLead=['팀장','센터장','관리자'].includes(role);
  const isCenter=['센터장','관리자'].includes(role);

  const canRecallAsAuthor=can('report.recall')&&report.createdBy===String(S.user?.userId)&&report.status==='submitted';
  const canRecallAsTeam=isTeamLead&&['submitted','team_approved'].includes(report.status);
  const canRecallAsCenter=isCenter&&report.status==='team_approved';

  if(!canRecallAsAuthor&&!canRecallAsTeam&&!canRecallAsCenter){
    toast('회수 권한이 없습니다.','error');return;
  }

  showConfirm('보고서 회수','보고서를 초안 상태로 되돌립니다. 계속하시겠습니까?',async()=>{
    showLoading(true);
    try{
      const{updateDoc,doc,deleteField}=fb();
      const updateData={status:'draft'};
      if(['submitted','team_approved'].includes(report.status)){
        updateData.submittedAt=deleteField();
        updateData.submittedBy=deleteField();
        updateData.submittedByName=deleteField();
      }
      if(report.status==='team_approved'){
        updateData.teamApprovedAt=deleteField();
        updateData.teamApprovedBy=deleteField();
        updateData.teamApprovedByName=deleteField();
      }
      await updateDoc(doc(fdb(),COLS.REPORTS,reportId),updateData);
      toast('보고서가 초안으로 회수되었습니다.','success');
      await loadReport();loadReportList();
    }catch(e){toast('회수 실패: '+e.message,'error');}
    finally{showLoading(false);}
  },'회수');
}

// 현재 사용자가 결재해야 하는 대기 보고서만 추림 (팀장=담당 입주자의 submitted, 센터장/관리자=team_approved)
function filterPendingForUser(list){
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
  return list.filter(r=>{
    const client=(S.allClients||S.clients).find(c=>c.id===r.clientId);
    const tlId=String(client?.teamLeader||'');
    if(role==='팀장'&&userId===tlId&&r.status==='submitted')return true;
    if((role==='센터장'||role==='관리자')&&r.status==='team_approved')return true;
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

export async function loadReportList(){
  const{getDocs,collection}=fb();
  const snap=await getDocs(collection(fdb(),COLS.REPORTS));
  const list=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.year*100+b.month)-(a.year*100+a.month));
  // confirmed 월 캐시 갱신 (결재 완료 즉시 반영)
  S.confirmedMonths=new Set(list.filter(r=>r.status==='confirmed').map(r=>`${r.clientId}_${r.year}-${String(r.month).padStart(2,'0')}`));
  const el=document.getElementById('rpt-list'); if(!el)return;
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
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
    tr.innerHTML=`<td style="padding:9px 10px;font-weight:600;color:var(--text);">${client.name}</td>
      <td style="padding:9px 10px;text-align:center;color:var(--sub);">${r.year}년</td>
      <td style="padding:9px 10px;text-align:center;color:var(--sub);">${r.month}월</td>
      <td style="padding:9px 10px;text-align:center;"><span class="${STATUS_CLASSES[r.status]||'rs-draft'}">${STATUS_LABELS[r.status]||r.status}</span></td>
      <td style="padding:9px 10px;color:var(--muted);font-size:12px;">${r.submittedByName||'-'}</td>
      <td style="padding:9px 10px;color:var(--muted);font-size:12px;">${r.createdAt?new Date(r.createdAt).toLocaleDateString('ko-KR'):'-'}</td>`;
    tr.addEventListener('mouseenter',()=>{if(S.reportData?.report?.id!==r.id)tr.style.background='var(--bg)';});
    tr.addEventListener('mouseleave',()=>{if(S.reportData?.report?.id!==r.id)tr.style.background='';});
    tr.addEventListener('click',()=>{
      if(S.reportData?.report?.id===r.id){
        const ra=document.getElementById('report-area');
        if(ra)ra.style.display='none';
        S.reportData=null;
        tbody.querySelectorAll('tr').forEach(t=>{t.style.background='';t.style.fontWeight='';});
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
  mergeCell(4,COLS_N-1,r,sMetaValue,report?.submittedByName||S.user?.name||'-');
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
