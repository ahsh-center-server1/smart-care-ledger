'use strict';

import { S } from '../state.js';
import { iconSvg } from '../utils/icons.js';
import { compareTrx, nextOrderInDay, planReorder, sortTrx } from '../domain/trx-order.js';
import { inLoadedRange, needsBroaderRange } from '../domain/trx-range.js';
import { COLS, cs } from '../constants.js';
import { toast, toastAction, showConfirm, escAttr, emptyState } from '../utils/ui.js';
import {
  fb, fdb, batchUpdateDocs, batchMixedOps, invalidateReportTrxCache,
} from '../services/firestore.js';
import { auditOp } from '../services/audit.js';
import { calcAccountBalance } from '../services/balance.js';
import { deleteFromStorage } from '../services/storage.js';
import { loadTransactions, isConfirmedLocked, trxDeleteBlockReason } from './core.js';
import { openModal, getUnpaidMandatoryItems, openReceiptModal, openReceiptUpload } from './modals.js';
import { can, unavailableMessage } from './permissions.js';
import { hasReceipt, receiptAccess } from '../services/receipt-access.js';
import {
  renderUnclassifiedBadge, isUnclassifiedTrx, resetFiltersUI,
  openCatDropdownUI, closeCatDropdowns, methodBadge, excludedBadge, readTrxFilters,
} from './transactions-widgets.js';

// 필수 고정항목 미납 배너 렌더 (당월 기준)
function renderTrxMandatoryBanner(){
  const el=document.getElementById('trx-mandatory-banner'); if(!el)return;
  if(!S.activeClient){el.style.display='none';el.innerHTML='';return;}
  const now=new Date();
  const ym=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  const unpaid=getUnpaidMandatoryItems(S.activeClient,ym,null);
  if(!unpaid.length){el.style.display='none';el.innerHTML='';return;}
  const names=unpaid.map(f=>f.description||'(이름없음)').join(', ');
  el.style.display='';
  el.innerHTML='<div style="background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #dc2626;border-radius:8px;padding:10px 14px;margin-bottom:10px;font-size:13px;color:#991b1b;">'
    +'<span style="font-weight:700;">⚠️ 이번 달 필수 고정지출 '+unpaid.length+'건 미입력</span>'
    +'<span style="color:#7f1d1d;margin-left:8px;">'+names+'</span></div>';
}

function todayStr() {
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// ① 계좌 필터 셀렉터 업데이트 (현재 선택된 입주자 기준)
export function rebuildAccountFilter(){
  const sel=document.getElementById('h-account'); if(!sel)return;
  const prev=sel.value;
  sel.innerHTML='<option value="">전체 계좌</option>';
  const clientId=S.activeClient||'';
  const accs=clientId?S.accounts.filter(a=>a.clientId===clientId):[];
  accs.forEach(a=>sel.add(new Option(a.label,a.id)));
  if(accs.some(a=>a.id===prev))sel.value=prev; else sel.value='';
}

/**
 * 페이지 번호를 결과 범위 안으로 당긴다.
 *
 * 이 보정이 없어서, 5페이지를 보다가 검색어로 결과를 3건으로 좁히면
 * slice(400,3)이 되어 빈 표가 뜨고 카운터는 "총 3건 (401–3)"이 됐다.
 * 페이지 버튼도 사라져서(pages<=1) 1페이지로 돌아갈 방법이 없었다.
 */
export function clampPage(page, totalItems, pageSize) {
  const size = Number(pageSize) > 0 ? Number(pageSize) : 100;
  const pages = Math.max(1, Math.ceil(Math.max(0, Number(totalItems) || 0) / size));
  const p = Math.floor(Number(page));
  if (!Number.isFinite(p) || p < 1) return 1;
  return Math.min(p, pages);
}

// ─────────────────────────────────────────────
/**
 * 필터를 다시 적용한다.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.resetPage] 필터 조건이 바뀐 호출이면 true — 1페이지로 돌아간다.
 *
 * 페이지 범위는 opts와 무관하게 **항상 보정한다.** 예전에는 보정이 없어서,
 * 5페이지를 보다가 검색어로 결과를 3건으로 좁히면 slice(400,3)이 되어
 * 빈 표가 뜨고 카운터는 "총 3건 (401–3)"이 됐다. 페이지 버튼도 사라져서
 * (pages<=1) **1페이지로 돌아갈 방법이 없었다.**
 */
export function applyFilters(opts) {
  if (opts && opts.resetPage) S.page = 1;
  const {kw,sd,ed,tf,rf,mf,af}=readTrxFilters();
  // 캐시 범위 부족 시 추가 fetch (loadTransactions 끝나면 applyFilters 자동 재호출)
  if (S.activeClient && (sd || ed) && needsBroaderRange(sd, ed, S.trxRange)) {
    const reqStart = sd || '1900-01-01';
    const reqEnd   = ed || todayStr();
    loadTransactions(S.activeClient, { range: { start: reqStart, end: reqEnd } });
    return;
  }
  S.filteredTrx=S.transactions.filter(t=>{
    const desc=String(t.description||'').toLowerCase();
    return desc.includes(kw)
      &&(!sd||t.date>=sd)&&(!ed||t.date<=ed)
      &&(tf==='all'||t.type===tf)
      &&(rf==='all'||(rf==='yes'?hasReceipt(t):!hasReceipt(t)))
      &&(mf==='all'||(mf==='none'?!t.method:t.method===mf))
      &&(!af||t.accountId===af)&&(!S.onlyUnclassified||isUnclassifiedTrx(t));
  });
  renderUnclassifiedBadge(()=>applyFilters({resetPage:true}));
  const key=S.sortKey, sign=S.sortDir==='asc'?1:-1;
  const accLabel=t=>S.accounts.find(ac=>ac.id===t.accountId)?.label||'';
  S.filteredTrx.sort((a,b)=>{
    // 날짜순은 곧 장부 순서다 — 같은 날 안에서는 통장에 찍힌 순서를 따른다.
    // 예전에는 날짜 문자열만 비교하고 그 날 안의 순서는 정렬 안정성에 기댔다.
    if(key==='date')return sign*compareTrx(a,b);
    if(key==='amountIn'||key==='amountOut')return sign*(Number(a[key]||0)-Number(b[key]||0));
    const vA=key==='_accLabel'?accLabel(a):String(a[key]||'');
    const vB=key==='_accLabel'?accLabel(b):String(b[key]||'');
    return sign*vA.localeCompare(vB);
  });
  S.page=clampPage(S.page,S.filteredTrx.length,S.pageSize);
  renderHistoryTable(); renderPagination();
  renderTrxMandatoryBanner();
}

export function renderHistoryTable() {
  if(S.trxViewMode==='calendar'){renderCalendarView();return;}
  // 달력 뷰 div 숨기고 테이블 복원
  const calDiv=document.getElementById('h-calendar-view');
  if(calDiv){calDiv.style.display='none';}
  const tbl=document.getElementById('h-body')?.closest('table')?.parentElement;
  if(tbl)tbl.style.display='';
  const tbody=document.getElementById('h-body'), ce=document.getElementById('h-count');
  const total=S.filteredTrx.length;
  if (!S.activeClient) {
    tbody.innerHTML=`<tr><td colspan="9">${emptyState('👤', '위에서 입주자를 선택하세요')}</td></tr>`;
    if(ce)ce.textContent=''; return;
  }
  if (!total) {
    tbody.innerHTML=`<tr><td colspan="9">${emptyState('📭', '거래 내역이 없습니다', '거래 추가하기', "openModal('trx')")}</td></tr>`;
    if(ce)ce.textContent=''; return;
  }
  const start=(S.page-1)*S.pageSize, end=Math.min(start+S.pageSize,total);
  if(ce)ce.textContent=`총 ${total}건 (${start+1}–${end})`;
  tbody.innerHTML='';
  const isInputOnly=!can('trx.view.all');
  S.filteredTrx.slice(start,end).forEach((t,idx)=>{
    const c=cs(t.category), tr=document.createElement('tr');
    tr.dataset.id=t.id; tr.dataset.idx=String(start+idx);
    tr.draggable=!isInputOnly;
    // 유형 뱃지 (자산이동/취소는 별도 표시)
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
    const methodTag=methodBadge(t.method)+excludedBadge(t), accName=S.accounts.find(a=>a.id===t.accountId)?.label||'';
    tr.innerHTML=`
      <td style="text-align:center;width:28px;cursor:grab;color:#cbd5e1;font-size:16px;user-select:none;${isInputOnly?'display:none;':''}" class="drag-handle" title="드래그로 순서 변경">⠿</td>
      <td class="col-check" style="text-align:center;width:36px;${isInputOnly?'display:none;':''}"><input type="checkbox" class="row-check" value="${t.id}" data-acc="${t.accountId}" style="accent-color:var(--blue);width:14px;height:14px;cursor:pointer;"></td>
      <td data-label="날짜" style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--sub);white-space:nowrap;">${t.date||''}</td>
      <td data-label="카테고리"><div style="position:relative;display:inline-block;">
        <span class="cat-chip" data-id="${t.id}" style="background:${c.bg};color:${c.text};border-color:${c.border};">
          <span class="cat-dot" style="background:${c.dot};"></span><span class="cat-label">${t.category||'미분류'}</span>
        </span>
        <div class="cat-dd" id="dd-${t.id}"></div>
      </div></td>
      <td class="trx-edit" data-label="내용" data-id="${t.id}" style="cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${t.description||''}">${t.description||''}${methodTag}${typeTag}</td>
      <td data-label="계좌" style="font-size:11px;color:var(--muted);white-space:nowrap;">${accName}</td>
      <td data-label="수입" style="text-align:right;" class="col-in">${
        t.type==='취소'&&t.amountIn>0?'<span style="color:#a1a1aa;text-decoration:line-through;">+'+t.amountIn.toLocaleString()+'원</span>':
        t.amountIn>0?'<span style="color:'+(t.type==='자산이동'?'#0ea5e9':'')+'">'+'+'+t.amountIn.toLocaleString()+'원</span>':''
      }</td>
      <td data-label="지출" style="text-align:right;" class="col-out">${
        t.type==='자산이동'?'<span style="color:#0ea5e9;">'+Math.abs(t.amountOut).toLocaleString()+'원</span>':
        t.type==='취소'&&t.amountOut>0?'<span style="color:#a1a1aa;text-decoration:line-through;">'+t.amountOut.toLocaleString()+'원</span>':
        t.type==='취소'?'':
        t.amountOut<0?'<span style="color:#059669;font-size:12px;">+'+Math.abs(t.amountOut).toLocaleString()+'원 (환불)</span>':
        (t.amountOut>0?'-'+t.amountOut.toLocaleString()+'원':'')
      }</td>
      <td data-label="증빙" style="text-align:center;">
        ${hasReceipt(t)
          ?`<button class="icon-btn receipt-view" data-id="${t.id}" title="증빙 보기">${iconSvg('clip')}</button>`
          :`<span style="display:inline-flex;align-items:center;gap:3px;justify-content:center;">${
              can('receipt.upload')?`<button class="icon-btn receipt-add" data-id="${t.id}" title="증빙 추가" style="color:#94a3b8;">＋</button>`:''
            }${
              can('receipt.upload')
                ?`<button class="receipt-miss-toggle" data-id="${t.id}" title="${t.receiptMissing?'분실 표시 해제':'영수증 분실 표시'}" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;border:1px solid ${t.receiptMissing?'#fecaca':'#e5e7eb'};background:${t.receiptMissing?'#fee2e2':'transparent'};color:${t.receiptMissing?'#b91c1c':'#94a3b8'};cursor:pointer;">분실</button>`
                :(t.receiptMissing?'<span style="font-size:10px;font-weight:700;color:#b91c1c;background:#fee2e2;padding:1px 6px;border-radius:4px;border:1px solid #fecaca;">분실</span>':'')
            }</span>`}
      </td>
      <td data-label="관리" style="text-align:center;"><div style="display:flex;justify-content:center;gap:4px;flex-wrap:wrap;">${(()=>{
        const canEdit=can('trx.edit')&&(!isInputOnly||(t.createdBy===S.user?.userId));
        const moveBtns=!isInputOnly
          ?`<button class="icon-btn trx-up-btn" data-id="${t.id}" title="위로 이동" style="color:#94a3b8;font-size:12px;" onmouseover="this.style.background='#e0f2fe';this.style.color='#0369a1';" onmouseout="this.style.background='transparent';this.style.color='#94a3b8';">▲</button>
        <button class="icon-btn trx-down-btn" data-id="${t.id}" title="아래로 이동" style="color:#94a3b8;font-size:12px;" onmouseover="this.style.background='#e0f2fe';this.style.color='#0369a1';" onmouseout="this.style.background='transparent';this.style.color='#94a3b8';">▼</button>`
          :'';
        return canEdit
          ?`${moveBtns}<button class="icon-btn trx-edit-btn" data-id="${t.id}" title="수정" style="color:#64748b;" onmouseover="this.style.background='#dbeafe';this.style.color='#2563eb';" onmouseout="this.style.background='transparent';this.style.color='#64748b';">${iconSvg('pen')}</button>
        <button class="icon-btn trx-del-btn"  data-id="${t.id}" data-acc="${t.accountId}" title="삭제" style="color:#94a3b8;" onmouseover="this.style.background='#fee2e2';this.style.color='#dc2626';" onmouseout="this.style.background='transparent';this.style.color='#94a3b8';">${iconSvg('trash')}</button>`
          :'';
      })()}</div></td>`;
    tr.querySelector('.trx-edit')?.addEventListener('click',    ()=>editTrx(t.id));
    tr.querySelector('.trx-edit-btn')?.addEventListener('click', ()=>editTrx(t.id));
    tr.querySelector('.trx-del-btn')?.addEventListener('click',  ()=>delTrx(t.id,t.accountId));
    tr.querySelector('.trx-up-btn')?.addEventListener('click',   ()=>moveTrxRow(t.id,-1));
    tr.querySelector('.trx-down-btn')?.addEventListener('click', ()=>moveTrxRow(t.id,1));
    tr.querySelector('.cat-chip').addEventListener('click',     e=>{e.stopPropagation();openCatDropdown(t.id,tr.querySelector('.cat-chip'),t.type);});
    // ⑧ 드래그앤드롭 순서 변경
    tr.addEventListener('dragstart', e=>{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',t.id);tr.style.opacity='0.4';});
    tr.addEventListener('dragend',   ()=>tr.style.opacity='1');
    tr.addEventListener('dragover',  e=>{e.preventDefault();e.dataTransfer.dropEffect='move';tr.style.background='#eff6ff';});
    tr.addEventListener('dragleave', ()=>tr.style.background='');
    tr.addEventListener('drop', e=>{e.preventDefault();tr.style.background='';const fromId=e.dataTransfer.getData('text/plain');if(fromId!==t.id)reorderTrx(fromId,t.id);});
    const rvBtn=tr.querySelector('.receipt-view');
    if(rvBtn)rvBtn.addEventListener('click',async()=>{try{const a=await receiptAccess(t);openReceiptModal(a.url,t.id,{contentType:a.contentType});}
      catch(e){toast('증빙을 열지 못했습니다: '+(e.message||e),'error');}});
    const raBtn=tr.querySelector('.receipt-add');
    if(raBtn)raBtn.addEventListener('click',()=>openReceiptUpload(t.id));  // ★ 버그1 수정
    const rmBtn=tr.querySelector('.receipt-miss-toggle');
    if(rmBtn)rmBtn.addEventListener('click',()=>toggleReceiptMissing(t.id));
    tbody.appendChild(tr);
  });
  document.addEventListener('click',closeCatDropdowns,{once:true});
}

// 분류 인라인 드롭다운은 transactions-widgets.js 에 있다. saveCatChange 를
// 넘겨 순환을 만들지 않는다.
export const openCatDropdown=(trxId,chipEl,type)=>openCatDropdownUI(trxId,chipEl,type,saveCatChange);
export { closeCatDropdowns };

// 달력형 뷰
export function renderCalendarView(){
  const ce=document.getElementById('h-count');
  // calendarYM 없으면 첫 거래 기준으로 초기화 (S.transactions 전체 기준)
  if(!S.calendarYM){
    const ref=((S.transactions[0]||S.filteredTrx[0])?.date||new Date().toISOString().substring(0,7)+'-01');
    S.calendarYM=ref.substring(0,7);
  }
  // S.transactions에서 해당 월 직접 필터 (UI 날짜 필터와 무관)
  const allTrx=S.transactions.length?S.transactions:S.filteredTrx;
  const trx=allTrx.filter(t=>(t.date||'').startsWith(S.calendarYM));
  const ym=S.calendarYM;
  const [y,m]=[parseInt(ym.split('-')[0]),parseInt(ym.split('-')[1])];
  const firstDay=new Date(y,m-1,1).getDay(); // 0=일
  const daysInMonth=new Date(y,m,0).getDate();
  // 날짜별 거래 그룹 (이미 해당 월 필터된 trx)
  const byDate={};
  trx.forEach(t=>{byDate[t.date]=(byDate[t.date]||[]).concat(t);});
  // 테이블을 달력으로 교체
  const wrap=document.getElementById('h-body')?.closest('table')?.parentElement;
  if(!wrap)return;
  const calId='h-calendar-view';
  let cal=document.getElementById(calId);
  if(!cal){cal=document.createElement('div');cal.id=calId;wrap.parentElement?.insertBefore(cal,wrap);}
  wrap.style.display='none';
  cal.style.cssText='display:block;';
  const DAY_LABELS=['일','월','화','수','목','금','토'];
  let html=`<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
    <button onclick="moveCalendar(-1)" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:16px;">&#8249;</button>
    <span style="font-weight:700;font-size:15px;color:var(--text);flex:1;text-align:center;">${y}년 ${m}월 달력</span>
    <button onclick="moveCalendar(1)" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:16px;">&#8250;</button>
  </div>`;
  html+=`<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;">`;
  DAY_LABELS.forEach((d,i)=>html+=`<div style="text-align:center;font-size:11px;font-weight:700;padding:4px 0;color:${i===0?'#ef4444':i===6?'#3b82f6':'var(--muted)'};">${d}</div>`);
  for(let i=0;i<firstDay;i++)html+=`<div></div>`;
  for(let d=1;d<=daysInMonth;d++){
    const dateStr=`${ym}-${String(d).padStart(2,'0')}`;
    const dayTrx=byDate[dateStr]||[];
    const totalIn=dayTrx.reduce((s,t)=>s+Number(t.amountIn||0),0);
    const totalOut=dayTrx.reduce((s,t)=>s+Number(t.amountOut||0),0);
    const isToday=dateStr===new Date().toISOString().substring(0,10);
    html+=`<div onclick="showCalendarDayDetail('${escAttr(dateStr)}')" style="min-height:60px;padding:4px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:${isToday?'#eff6ff':'#fff'};transition:background .15s;">
      <div style="font-size:11px;font-weight:700;color:${isToday?'var(--blue)':'var(--text)'};">${d}</div>
      ${dayTrx.length?`<div style="font-size:9px;color:#10b981;margin-top:2px;">+${totalIn?totalIn.toLocaleString():''}</div><div style="font-size:9px;color:#ef4444;">-${totalOut?totalOut.toLocaleString():''}</div><div style="font-size:9px;color:var(--muted);">${dayTrx.length}건</div>`:''}
    </div>`;
  }
  html+=`</div>`;
  // 날짜 클릭 상세
  html+=`<div id="cal-day-detail" style="margin-top:14px;display:none;"></div>`;
  cal.innerHTML=html;
  if(ce)ce.textContent=trx.length+'건';
}

export function showCalendarDayDetail(dateStr){
  const detail=document.getElementById('cal-day-detail'); if(!detail)return;
  const allTrx=S.transactions.length?S.transactions:S.filteredTrx;
  const dayTrx=allTrx.filter(t=>t.date===dateStr);
  detail.style.display='block';
  const addBtn=`<button onclick="openModalWithDate('${escAttr(dateStr)}')" style="font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--green);color:var(--green);background:#fff;cursor:pointer;">${iconSvg('pen')}거래 추가</button>`;
  detail.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
    <div style="font-weight:700;font-size:13px;color:var(--text);">${dateStr} 거래 내역 (${dayTrx.length}건)</div>
    ${addBtn}
  </div>`
    +(dayTrx.length?dayTrx.map(t=>{const acc=S.accounts.find(a=>a.id===t.accountId)?.label||'';return`<div style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">${acc}</span><span style="font-size:11px;color:var(--muted);">${t.category||''}</span></div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;"><span>${t.description||'-'}</span><span style="font-weight:700;color:${t.amountIn?'#10b981':'#ef4444'};">${t.amountIn?'+'+Number(t.amountIn).toLocaleString():'-'+Number(t.amountOut||0).toLocaleString()}원</span></div>
    </div>`;}).join(''):'<div style="color:#9ca3af;font-size:13px;padding:8px 0;">이 날 거래 없음</div>');
}

export function openModalWithDate(dateStr){
  openModal('trx');
  setTimeout(()=>{
    const d=document.getElementById('trx-date');
    if(d){d.value=dateStr;}
  },80);
}

export function moveCalendar(dir){
  if(!S.calendarYM){
    const ref=(S.filteredTrx[0]?.date||new Date().toISOString().substring(0,7)+'-01');
    S.calendarYM=ref.substring(0,7);
  }
  const [y,m]=S.calendarYM.split('-').map(Number);
  const d=new Date(y,m-1+dir,1);
  S.calendarYM=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  renderCalendarView();
}

export async function saveCatChange(trxId, newCat, chipEl) {
  if(!can('trx.category.edit')){toast('분류 수정 권한이 없습니다.','error');return;}
  const lk=S.transactions.find(x=>x.id===trxId);
  if(lk&&isConfirmedLocked(lk.clientId,lk.date)){toast('최종 결재 완료된 월의 거래는 수정할 수 없습니다. (센터장이 결재를 취소하면 다시 편집할 수 있어요.)','error');return;}
  const {doc,updateDoc}=fb();
  await updateDoc(doc(fdb(),COLS.TRANSACTIONS,trxId),{category:newCat});
  invalidateReportTrxCache();
  [S.transactions,S.filteredTrx].forEach(arr=>{const t=arr.find(x=>x.id===trxId);if(t)t.category=newCat;});
  if (chipEl) {
    const c=cs(newCat);
    chipEl.style.background=c.bg; chipEl.style.color=c.text; chipEl.style.borderColor=c.border;
    chipEl.querySelector('.cat-dot').style.background=c.dot;
    // ★ 버그3 수정 — cat-label span만 정확히 변경
    const labelEl=chipEl.querySelector('.cat-label');
    if (labelEl) labelEl.textContent=newCat;
  }
  toast('카테고리 변경됨','success',2000);
}

export function renderPagination(){
  const el=document.getElementById('h-pages'); if(!el)return;
  const pages=Math.ceil(S.filteredTrx.length/S.pageSize);
  S.page=clampPage(S.page,S.filteredTrx.length,S.pageSize);
  if(pages<=1){el.innerHTML='';return;} el.innerHTML='';
  const cur=S.page;
  const go=p=>{
    if(p<1||p>pages||p===cur)return;
    S.page=p; renderHistoryTable(); renderPagination();
    // 페이지 이동 시 표 상단이 보이도록 스크롤 (아래에 머무는 문제 방지)
    document.getElementById('h-body')?.closest('.card')?.scrollIntoView({behavior:'smooth',block:'start'});
  };
  const mkBtn=(label,p,opts={})=>{
    const b=document.createElement('button'); b.textContent=label;
    const active=!!opts.active, disabled=!!opts.disabled;
    b.disabled=disabled;
    b.style.cssText=`min-width:40px;padding:8px 12px;border-radius:7px;font-size:13px;font-weight:700;border:1px solid var(--bm);cursor:${disabled?'not-allowed':'pointer'};background:${active?'var(--blue)':'#fff'};color:${active?'#fff':'var(--sub)'};opacity:${disabled?'.4':'1'};`;
    if(!disabled&&!active&&p!=null)b.addEventListener('click',()=>go(p));
    el.appendChild(b);
  };
  mkBtn('‹ 이전',cur-1,{disabled:cur===1});
  // 처음/끝 + 현재 주변만 노출, 나머지는 … 생략
  const nums=new Set([1,pages]);
  for(let p=cur-2;p<=cur+2;p++){if(p>=1&&p<=pages)nums.add(p);}
  let prev=0;
  [...nums].sort((a,b)=>a-b).forEach(p=>{
    if(p-prev>1){const s=document.createElement('span');s.textContent='…';s.style.cssText='padding:0 4px;color:var(--muted);align-self:center;';el.appendChild(s);}
    mkBtn(String(p),p,{active:p===cur}); prev=p;
  });
  mkBtn('다음 ›',cur+1,{disabled:cur===pages});
  const info=document.createElement('span');
  info.textContent=`${cur} / ${pages} 페이지`;
  info.style.cssText="align-self:center;margin-left:8px;font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace;";
  el.appendChild(info);
}

// 필터 초기화 UI 는 transactions-filters.js 에 있다. applyFilters 를 넘겨
// 순환을 만들지 않는다.
export const resetFilters=()=>resetFiltersUI(()=>applyFilters());

export function applyPeriod(p){
  const now=new Date(),y=now.getFullYear(),m=now.getMonth(),d=now.getDay();
  const fmt=dt=>dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
  let sd='',ed='';
  if(p==='this-month') {sd=fmt(new Date(y,m,1));ed=fmt(new Date(y,m+1,0));}
  if(p==='last-month') {sd=fmt(new Date(y,m-1,1));ed=fmt(new Date(y,m,0));}
  if(p==='this-week')  {const mon=new Date(now);mon.setDate(now.getDate()-(d===0?6:d-1));const sun=new Date(mon);sun.setDate(mon.getDate()+6);sd=fmt(mon);ed=fmt(sun);}
  if(p==='last-3month'){sd=fmt(new Date(y,m-2,1));ed=fmt(new Date(y,m+1,0));}
  if(p==='this-year')  {sd=y+'-01-01';ed=y+'-12-31';}
  const s=document.getElementById('h-start'),e=document.getElementById('h-end');
  if(s)s.value=sd; if(e)e.value=ed; applyFilters();
}

// ─────────────────────────────────────────────
// 거래 CRUD
// ─────────────────────────────────────────────
export async function saveTrx(data){
  // 실행 시점 검증. 예전에는 렌더 시점에만 can()을 봤고 이 함수들은 전부
  // window에 노출되어 있어 콘솔에서 직접 호출하면 그대로 통과했다.
  // (실제 차단은 보안 규칙이 하지만, 여기서도 막아 무의미한 요청을 줄인다)
  const editingOthers = data.id && data.createdBy && data.createdBy !== S.user?.userId;
  if(!can('trx.create')||(editingOthers&&!can('trx.view.all'))){
    toast('거래 저장 권한이 없습니다.','error'); return;
  }
  if(isConfirmedLocked(data.clientId,data.date)){toast('최종 결재 완료된 월의 거래는 추가/수정할 수 없습니다. (센터장이 결재를 취소하면 다시 편집할 수 있어요.)','error');return;}
  // 편집 시: 원본 거래가 확정 월에 있으면 다른 월로 이동/수정 금지
  if(data.id){const prev=S.transactions.find(x=>x.id===data.id);if(prev&&isConfirmedLocked(prev.clientId,prev.date)){toast('최종 결재 완료된 월의 거래는 수정할 수 없습니다. (센터장이 결재를 취소하면 다시 편집할 수 있어요.)','error');return;}}
  const {doc,addDoc,collection,updateDoc}=fb();
  const isEdit=!!data.id;
  if(isEdit){
    const id=data.id; delete data.id;
    await updateDoc(doc(fdb(),COLS.TRANSACTIONS,id),data);
    data.id=id;
    // ⑨ 수정 후 정렬 유지 — 로컬 배열만 업데이트 후 re-render
    const idx=S.transactions.findIndex(x=>x.id===id);
    if(idx>=0)S.transactions[idx]={...S.transactions[idx],...data};
    await updateAccBalance(data.accountId);
    invalidateReportTrxCache(data.clientId);
    applyFilters();   // 전체 재로드 없이 필터/정렬 유지
  } else {
    // 그 날의 맨 뒤에 놓는다. 예전에는 수기 입력에 sortOrder를 **아예 붙이지
    // 않아서** 전부 목록 맨 아래로 몰렸다(비교기가 값 없는 것을 99999로 봤다).
    if(data.sortOrder==null)data.sortOrder=nextOrderInDay(data.date,S.transactions,data.clientId);
    // 입력자: createdBy 필드 추가
    if(!data.createdBy&&S.user?.userId)data.createdBy=S.user.userId;
    data.id=(await addDoc(collection(fdb(),COLS.TRANSACTIONS),data)).id;
    // **방금 만든 문서의 내용을 이미 들고 있다.** 예전에는 여기서
    // loadTransactions 로 그 달을 통째로 다시 읽었다 — 수정 경로는 바로 위처럼
    // 로컬만 고치는데 생성 경로만 그랬고, 월초에 수기 입력을 한 건 할 때마다
    // 그 입주자의 한 달치를 다시 읽었다.
    //
    // 로드된 범위 밖(예: 몇 달 전 날짜)이면 끼워 넣지 않는다. 넣으면 필터가
    // 숨기지 못하는 유령 행이 남는다 — 사용자가 기간을 넓히면 보인다.
    if(S.activeClient===data.clientId&&inLoadedRange(data.date,S.trxRange)){
      S.transactions=sortTrx([...S.transactions,{...data}]);
    }
    updateAccBalance(data.accountId);
    invalidateReportTrxCache(data.clientId);
    applyFilters();
  }
  toast('저장되었습니다.','success'); return data.id;   // 증빙은 거래 생성 뒤에 서버가 붙인다
}

// 영수증 분실 표시 토글
export async function toggleReceiptMissing(id){
  const t=S.transactions.find(x=>x.id===id); if(!t)return;
  if(isConfirmedLocked(t.clientId,t.date)){toast('최종 결재 완료된 월의 거래는 수정할 수 없습니다. (센터장이 결재를 취소하면 다시 편집할 수 있어요.)','error');return;}
  const newVal=!t.receiptMissing;
  const{doc,updateDoc}=fb();
  try{
    await updateDoc(doc(fdb(),COLS.TRANSACTIONS,id),{receiptMissing:newVal});
    invalidateReportTrxCache(t.clientId);
    t.receiptMissing=newVal;
    applyFilters();
    toast(newVal?'영수증 분실 표시':'분실 표시 해제','success',1500);
  }catch(e){toast('저장 실패: '+e.message,'error');}
}

export async function delTrx(id,accId){
  const t=S.transactions.find(x=>x.id===id);
  const mine=!t||t.createdBy===S.user?.userId;
  // 두 거부를 한 문장으로 묶으면 안 된다 — 이유가 다르고 사용자가 할 일도 다르다.
  // 앞은 "이 기능이 아직 없다"(누구에게 부탁해도 안 된다), 뒤는 담당 범위 문제다.
  if(!can('trx.delete')){ toast(unavailableMessage('trx.delete'),'error',5000); return; }
  if(!mine&&!can('trx.view.all')){
    toast('동료가 입력한 거래는 삭제할 수 없습니다.','error'); return;
  }
  const blocked=trxDeleteBlockReason(S.transactions.find(x=>x.id===id));
  if(blocked){toast(blocked,'error',5000);return;}
  showConfirm('거래 삭제','이 거래 내역을 삭제하시겠습니까?\n삭제 후 잠시 동안 되돌릴 수 있습니다.',()=>{
    scheduleTrxDeletion([id]);
  },'삭제','btn btn-danger');
}

// 삭제 예약 — 화면에서 즉시 제거하고 '되돌리기' 유예(약 8초) 후 실제 Firestore 삭제.
// 엑셀 사용자에게 익숙한 실행취소(Ctrl+Z) 경험을 제공해 오클릭에 의한 영구 손실을 방지한다.
function scheduleTrxDeletion(ids){
  // 연결된 자산이동 거래도 함께 삭제 대상에 포함
  const allIds=new Set(ids);
  const linkedOnly=[];   // 체크되지 않았는데 연결 때문에 딸려오는 상대편
  ids.forEach(id=>{
    const t=S.transactions.find(x=>x.id===id);
    if(t?.type==='자산이동'&&t.linkedTrxId&&!allIds.has(t.linkedTrxId)){
      allIds.add(t.linkedTrxId);
      linkedOnly.push(t.linkedTrxId);
    }
  });
  // 딸려오는 상대편도 결재 잠금을 확인한다.
  // 예전에는 체크한 항목만 확인하고 뒤에 추가되는 linkedTrxId는 재확인하지 않아
  // **최종 결재 완료된 월의 거래가 삭제됐다.**
  const lockedLinked=linkedOnly
    .map(id=>S.transactions.find(x=>x.id===id))
    .filter(t=>t&&isConfirmedLocked(t.clientId,t.date));
  if(lockedLinked.length){
    toast('연결된 자산이동 상대편이 최종 결재 완료된 월에 있어 삭제할 수 없습니다. '
      +'(센터장이 결재를 취소하면 다시 삭제할 수 있어요.)','error',6000);
    return;
  }
  // 영향받는 계좌 + 삭제 대상 스냅샷 수집(되돌리기 복원용)
  const accIds=new Set();
  const removed=[];
  S.transactions.forEach(t=>{
    if(allIds.has(t.id)){
      removed.push(t);
      accIds.add(t.accountId);
      if(t.linkedAccountId)accIds.add(t.linkedAccountId);
    }
  });
  if(!removed.length)return;
  // 상대편이 화면 캐시 밖(다른 입주자·다른 기간)이면 스냅샷이 없다.
  // 삭제는 되지만 증빙 파일이 고아로 남으므로, 커밋 시점에 문서를 읽어 정리한다.
  const uncachedIds=[...allIds].filter(id=>!removed.some(t=>t.id===id));
  // 로컬 캐시에서 즉시 제거 후 재렌더 (화면상 삭제된 것처럼 보임)
  S.transactions=S.transactions.filter(t=>!allIds.has(t.id));
  S.filteredTrx=S.filteredTrx.filter(t=>!allIds.has(t.id));
  const checkAll=document.getElementById('check-all');
  if(checkAll)checkAll.checked=false;
  renderHistoryTable(); renderPagination();
  toastAction(`${removed.length}건을 삭제했습니다.`,'되돌리기',
    ()=>{ // 되돌리기: 캐시 복원 (applyFilters가 sortKey 기준 재정렬하므로 순서 자동 복원)
      removed.forEach(t=>{ if(!S.transactions.find(x=>x.id===t.id))S.transactions.push(t); });
      applyFilters();
      toast('삭제가 취소되었습니다.','success',2000);
    },
    8000,
    async()=>{ // 유예 만료: 실제 Firestore 삭제 커밋
      try{
        // 캐시 밖 상대편의 증빙 URL을 먼저 읽어둔다 (삭제하면 못 읽는다)
        const extraUrls=[];
        if(uncachedIds.length){
          const{getDoc,doc}=fb();
          for(const id of uncachedIds){
            try{
              const snap=await getDoc(doc(fdb(),COLS.TRANSACTIONS,id));
              const url=snap.exists()?snap.data().receiptUrl:'';
              if(url)extraUrls.push(url);
            }catch{ /* 못 읽어도 삭제는 진행한다 */ }
          }
        }
        // 삭제 기록을 같은 배치에 실어 원자적으로 커밋한다 — 삭제는 되고
        // 기록만 빠지는 상태가 생기지 않게. (되돌릴 수 없는 작업이다)
        const clientName=S.clients.find(c=>c.id===S.activeClient)?.name||S.activeClient||'';
        const logOp=auditOp(allIds.size>1?'trx.bulkDelete':'trx.delete',{
          resourceId:allIds.size===1?[...allIds][0]:undefined,
          summary:{clientName,count:allIds.size,
            amount:removed.reduce((s2,t)=>s2+Number(t.amountOut||0)+Number(t.amountIn||0),0)},
        });
        await batchMixedOps({
          deletes:[...allIds].map(docId=>({col:COLS.TRANSACTIONS,docId})),
          adds:logOp?[{col:logOp.col,data:logOp.data}]:[],
        });
        // 증빙 파일도 Storage에서 제거(고아 파일 방지, best-effort)
        removed.forEach(t=>{ if(t.receiptUrl)deleteFromStorage(t.receiptUrl); });
        extraUrls.forEach(u=>deleteFromStorage(u));
        for(const a of accIds)await updateAccBalance(a);
      }catch(e){toast('삭제 중 오류가 발생했습니다: '+e.message,'error');}
    }
  );
}

// I002: 거래내역 CSV 내보내기 (현재 필터 기준)
export function exportFilteredCSV(){
  if(!can('trx.csv')){toast('CSV 내보내기 권한이 없습니다.','error');return;}
  if(!S.filteredTrx||!S.filteredTrx.length){toast('내보낼 데이터가 없습니다.','info');return;}
  const client=S.clients.find(c=>c.id===S.activeClient)||{name:'전체'};
  const header=['날짜','시간','계좌','구분','분류','내용','수입','지출','증빙'];
  const rows=S.filteredTrx.map(t=>{
    const acc=S.accounts.find(a=>a.id===t.accountId)?.label||'';
    return [t.date||'',t.time||'',acc,t.type||'',t.category||'',t.description||'',t.amountIn||0,t.amountOut||0,hasReceipt(t)?'O':''].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',');
  });
  const csv='\uFEFF'+[header.join(','),...rows].join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=client.name+'_거래내역_'+new Date().toISOString().split('T')[0]+'.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('엑셀 파일로 저장했습니다.','success');
}

// 일괄 삭제 — 되돌리기 유예 후 배치 삭제 (scheduleTrxDeletion 재사용)
export async function confirmBulkDelete(){
  if(!can('trx.delete.bulk')){toast(unavailableMessage('trx.delete.bulk'),'error',5000);return;}
  const checked=Array.from(document.querySelectorAll('.row-check:checked'));
  if(!checked.length){toast('삭제할 항목을 선택하세요.','info');return;}
  // 마감·제출 월이 섞여 있으면 통째로 막는다(부분 삭제는 더 헷갈린다).
  const blockedRows=checked.map(cb=>trxDeleteBlockReason(S.transactions.find(x=>x.id===cb.value))).filter(Boolean);
  if(blockedRows.length){toast(`삭제할 수 없는 거래 ${blockedRows.length}건이 포함돼 있습니다. ${blockedRows[0]}`,'error',5000);return;}
  const ids=checked.map(c=>c.value);
  showConfirm('일괄 삭제',`선택한 ${ids.length}건을 삭제하시겠습니까?\n삭제 후 잠시 동안 되돌릴 수 있습니다.`,()=>{
    scheduleTrxDeletion(ids);
  },'삭제','btn btn-danger');
}

export function editTrx(id){const t=S.transactions.find(x=>x.id===id);if(!t)return;openModal('trx',t);}

/**
 * 화면에 보이는 잔액을 즉시 갱신한다 (낙관적 업데이트).
 *
 * ⚠️ Firestore의 currentBalance는 **여기서 쓰지 않는다.**
 *    Cloud Functions의 syncAccountBalance 트리거가 전체 거래를 근거로 계산해 소유한다.
 *
 * 이전 구현은 부분 로드된 S.transactions(기본 당월)로 계산한 값을 Firestore에
 * 덮어써서, 거래를 하나만 저장해도 지난 달 이전 기록이 잔액에서 사라졌다.
 * 게다가 입력자는 보안 규칙상 계좌 전체 거래를 읽을 수 없어 클라이언트에서는
 * 올바른 계산이 원천적으로 불가능하다.
 *
 * 따라서 여기서는 로컬 캐시만 손대고, 정확한 값은 트리거가 쓴 뒤
 * 다음 fetch에서 따라온다. 로드 범위 밖 거래가 있으면 이 값은 부정확할 수 있다.
 */
export function updateAccBalance(accId){
  if(!accId)return;
  const acc=S.accounts.find(a=>a.id===accId);
  if(!acc)return;
  acc.currentBalance=calcAccountBalance(acc,S.transactions);
}

// ─────────────────────────────────────────────
// 거래내역 정렬/순서
// ─────────────────────────────────────────────
// 드래그 대안: ▲/▼ 버튼으로 한 칸씩 이동 (현재 페이지 내에서만, reorderTrx 재사용)
export function moveTrxRow(id,dir){
  const base=(S.page-1)*S.pageSize;
  const pageEnd=Math.min(base+S.pageSize,S.filteredTrx.length);
  const i=S.filteredTrx.findIndex(x=>x.id===id);
  if(i<0)return;
  const target=i+dir;
  if(target<base||target>=pageEnd){toast(dir<0?'이 페이지의 맨 위입니다.':'이 페이지의 맨 아래입니다.','info',1500);return;}
  reorderTrx(id,S.filteredTrx[target].id);
}

/** 순서를 직접 바꿀 수 있는 정렬 상태인가 */
export function canReorderNow(){
  return S.sortKey==='sortOrder'||S.sortKey==='date';
}

/**
 * 드래그/버튼으로 거래 순서를 바꾼다. **그 날 안에서만.**
 *
 * 예전에는 화면의 한 페이지를 통째로 0..99로 다시 매겼다. 계좌 필터를 켠 채
 * 한 줄을 옮기면 필터 밖 같은 날 거래의 번호와 충돌했고, 엑셀이 준 큰 번호가
 * 0..99로 깎였다 — "한참 수정하다 보면 순서가 이상해진다"가 이것이다.
 *
 * 이제 판정도 대상도 domain/trx-order.js 가 정한다. 여기서는 권한과 결재
 * 잠금만 보고 쓴다.
 */
export async function reorderTrx(fromId,toId){
  if(!can('trx.reorder')){toast('순서 변경 권한이 없습니다.','error');return;}
  if(!canReorderNow()){
    toast('순서를 바꾸려면 날짜순으로 정렬한 상태여야 합니다.\n'
      +'지금 정렬 상태에서 옮기면 옮긴 자리가 화면과 다르게 저장됩니다.','error',5000);
    return;
  }
  const plan=planReorder(S.transactions,fromId,toId);
  if(!plan.ok){
    // 장부에서 3월 15일 줄을 3월 10일 앞으로 옮긴다는 것은 순서가 아니라
    // 날짜를 고치는 일이다. 말없이 무시하면 드래그가 먹지 않는 것처럼 보인다.
    if(plan.reason==='cross-date'){
      toast('날짜가 다른 거래끼리는 순서를 바꿀 수 없습니다.\n'
        +'날짜 자체가 잘못됐다면 거래를 수정하세요.','info',5000);
    }
    return;
  }
  if(!plan.changed.length)return;

  const client=S.transactions.find(x=>x.id===fromId)?.clientId;
  if(isConfirmedLocked(client,plan.date)){
    toast('최종 결재 완료된 월의 거래는 순서를 바꿀 수 없습니다. '
      +'(센터장이 결재를 취소하면 다시 편집할 수 있어요.)','error',6000);
    return;
  }

  await batchUpdateDocs(plan.changed.map(c=>
    ({col:COLS.TRANSACTIONS,docId:c.id,data:{sortOrder:c.sortOrder}})));
  for(const c of plan.changed){
    for(const arr of [S.transactions,S.filteredTrx]){
      const t=arr.find(x=>x.id===c.id); if(t)t.sortOrder=c.sortOrder;
    }
  }
  // 재정렬 뒤에 applyFilters를 부르지 않으면, 다음 필터 입력·저장 때
  // 정렬이 다시 적용되면서 방금 바꾼 순서가 원래대로 돌아간다.
  applyFilters();
  toast('순서가 저장되었습니다.','success',1500);
}
