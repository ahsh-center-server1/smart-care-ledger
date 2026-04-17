/**
 * modules/transactions.js — Smart Care Ledger v2
 * 거래내역: 필터, 정렬, 테이블 렌더링, CRUD, 드래그 정렬
 */

'use strict';

import { S } from '../state.js';
import { COLS, CAT_COLORS, cs } from '../constants.js';
import { toast, showConfirm, showLoading, setText } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import { loadTransactions } from './core.js';
import { openModal, closeModal } from './modals.js';

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

// ─────────────────────────────────────────────
export function applyFilters() {
  const kw=(document.getElementById('h-search')?.value||'').toLowerCase();
  const sd=document.getElementById('h-start')?.value||'';
  const ed=document.getElementById('h-end')?.value||'';
  const tf=document.getElementById('h-type')?.value||'all';
  const rf=document.getElementById('h-receipt')?.value||'all';
  const af=document.getElementById('h-account')?.value||'';   // ① 계좌 필터
  S.filteredTrx=S.transactions.filter(t=>{
    const desc=String(t.description||'').toLowerCase();
    return desc.includes(kw)
      &&(!sd||t.date>=sd)&&(!ed||t.date<=ed)
      &&(tf==='all'||t.type===tf)
      &&(rf==='all'||(rf==='yes'?!!t.receiptUrl:!t.receiptUrl))
      &&(!af||t.accountId===af);   // ① 계좌 필터 조건
  });
  const key=S.sortKey, dir=S.sortDir;
  S.filteredTrx.sort((a,b)=>{
    let vA, vB;
    // 계좌명 기준 정렬
    if(key==='_accLabel'){
      vA=S.accounts.find(ac=>ac.id===a.accountId)?.label||'';
      vB=S.accounts.find(ac=>ac.id===b.accountId)?.label||'';
      if(vA<vB)return dir==='asc'?-1:1; if(vA>vB)return dir==='asc'?1:-1; return 0;
    }
    vA=a[key]; vB=b[key];
    // 숫자 필드는 숫자로 비교
    if(key==='amountIn'||key==='amountOut'){
      vA=Number(vA||0); vB=Number(vB||0);
      return dir==='asc'?vA-vB:vB-vA;
    }
    vA=String(vA||''); vB=String(vB||'');
    if(vA<vB)return dir==='asc'?-1:1; if(vA>vB)return dir==='asc'?1:-1; return 0;
  });
  renderHistoryTable(); renderPagination();
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
    tbody.innerHTML='<tr><td colspan="9"><div class="empty-state"><div class="icon">👤</div>위에서 입주자를 선택하세요</div></td></tr>';
    if(ce)ce.textContent=''; return;
  }
  if (!total) {
    tbody.innerHTML='<tr><td colspan="9"><div class="empty-state"><div class="icon">📭</div>거래 내역이 없습니다</div></td></tr>';
    if(ce)ce.textContent=''; return;
  }
  const start=(S.page-1)*S.pageSize, end=Math.min(start+S.pageSize,total);
  if(ce)ce.textContent=`총 ${total}건 (${start+1}–${end})`;
  tbody.innerHTML='';
  const isInputOnly=S.user?.role==='입력자';
  S.filteredTrx.slice(start,end).forEach((t,idx)=>{
    const c=cs(t.category), tr=document.createElement('tr');
    tr.dataset.id=t.id; tr.dataset.idx=String(start+idx);
    tr.draggable=!isInputOnly;
    // 유형 뱃지 (자산이동/취소는 별도 표시)
    const typeTag=(t.type==='자산이동')?'<span style="font-size:10px;background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px;margin-left:4px;">↕이동</span>'
                 :(t.type==='취소')?'<span style="font-size:10px;background:#f4f4f5;color:#71717a;padding:1px 5px;border-radius:4px;margin-left:4px;">취소</span>':'';
    const accName=S.accounts.find(a=>a.id===t.accountId)?.label||'';
    tr.innerHTML=`
      <td style="text-align:center;width:28px;cursor:grab;color:#cbd5e1;font-size:16px;user-select:none;${isInputOnly?'display:none;':''}" class="drag-handle" title="드래그로 순서 변경">⠿</td>
      <td style="text-align:center;width:36px;${isInputOnly?'display:none;':''}"><input type="checkbox" class="row-check" value="${t.id}" data-acc="${t.accountId}" style="accent-color:var(--blue);width:14px;height:14px;cursor:pointer;"></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--sub);white-space:nowrap;">${t.date||''}</td>
      <td><div style="position:relative;display:inline-block;">
        <span class="cat-chip" data-id="${t.id}" style="background:${c.bg};color:${c.text};border-color:${c.border};">
          <span class="cat-dot" style="background:${c.dot};"></span><span class="cat-label">${t.category||'미분류'}</span>
        </span>
        <div class="cat-dd" id="dd-${t.id}"></div>
      </div></td>
      <td class="trx-edit" data-id="${t.id}" style="cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${t.description||''}">${t.description||''}${typeTag}</td>
      <td style="font-size:11px;color:var(--muted);white-space:nowrap;">${accName}</td>
      <td style="text-align:right;" class="col-in">${t.amountIn>0?'<span style="color:'+(t.type==='자산이동'?'#0ea5e9':'')+'">'+'+'+t.amountIn.toLocaleString()+'원</span>':''}</td>
      <td style="text-align:right;" class="col-out">${
        t.type==='자산이동'?'<span style="color:#0ea5e9;">'+Math.abs(t.amountOut).toLocaleString()+'원</span>':
        t.type==='취소'?'<span style="color:#a1a1aa;">취소</span>':
        t.amountOut<0?'<span style="color:#059669;font-size:12px;">-'+Math.abs(t.amountOut).toLocaleString()+'원</span>':
        (t.amountOut>0?t.amountOut.toLocaleString()+'원':'')
      }</td>
      <td style="text-align:center;">
        ${t.receiptUrl
          ?`<button class="icon-btn receipt-view" data-url="${t.receiptUrl}" title="증빙 보기">📎</button>`
          :`<button class="icon-btn receipt-add" data-id="${t.id}" title="증빙 추가" style="color:#94a3b8;">＋</button>`}
      </td>
      <td style="text-align:center;"><div style="display:flex;justify-content:center;gap:4px;">${(()=>{
        const canEdit=S.user?.role!=='입력자'||(t.createdBy===S.user?.userId);
        return canEdit
          ?`<button class="icon-btn trx-edit-btn" data-id="${t.id}" title="수정" style="color:#64748b;" onmouseover="this.style.background='#dbeafe';this.style.color='#2563eb';" onmouseout="this.style.background='transparent';this.style.color='#64748b';">✏️</button>
        <button class="icon-btn trx-del-btn"  data-id="${t.id}" data-acc="${t.accountId}" title="삭제" style="color:#94a3b8;" onmouseover="this.style.background='#fee2e2';this.style.color='#dc2626';" onmouseout="this.style.background='transparent';this.style.color='#94a3b8';">🗑️</button>`
          :'';
      })()}</div></td>`;
    tr.querySelector('.trx-edit')?.addEventListener('click',    ()=>editTrx(t.id));
    tr.querySelector('.trx-edit-btn')?.addEventListener('click', ()=>editTrx(t.id));
    tr.querySelector('.trx-del-btn')?.addEventListener('click',  ()=>delTrx(t.id,t.accountId));
    tr.querySelector('.cat-chip').addEventListener('click',     e=>{e.stopPropagation();openCatDropdown(t.id,tr.querySelector('.cat-chip'),t.type);});
    // ⑧ 드래그앤드롭 순서 변경
    tr.addEventListener('dragstart', e=>{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',t.id);tr.style.opacity='0.4';});
    tr.addEventListener('dragend',   ()=>tr.style.opacity='1');
    tr.addEventListener('dragover',  e=>{e.preventDefault();e.dataTransfer.dropEffect='move';tr.style.background='#eff6ff';});
    tr.addEventListener('dragleave', ()=>tr.style.background='');
    tr.addEventListener('drop', e=>{e.preventDefault();tr.style.background='';const fromId=e.dataTransfer.getData('text/plain');if(fromId!==t.id)reorderTrx(fromId,t.id);});
    const rvBtn=tr.querySelector('.receipt-view');
    if(rvBtn)rvBtn.addEventListener('click',()=>openReceiptModal(rvBtn.dataset.url,t.id));
    const raBtn=tr.querySelector('.receipt-add');
    if(raBtn)raBtn.addEventListener('click',()=>openReceiptUpload(t.id));  // ★ 버그1 수정
    tbody.appendChild(tr);
  });
  document.addEventListener('click',closeCatDropdowns,{once:true});
}

// ★ 버그3 수정 — cat-label span만 변경
export function openCatDropdown(trxId, chipEl, type) {
  closeCatDropdowns();
  const dd=document.getElementById('dd-'+trxId); if(!dd)return;
  const _clientId=S.activeClient||'';
  // sortOrder 기준 정렬 (자주 쓰는 순서대로)
  const catsSorted=S.categories
    .filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===_clientId))
    .sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  const cats=[...new Set(catsSorted.map(c=>c.category))];
  if (!cats.includes('확인필요'))cats.push('확인필요');
  dd.innerHTML='';
  cats.forEach(cat=>{
    const c=cs(cat), item=document.createElement('div');
    item.className='cat-dd-item';
    item.innerHTML=`<span style="width:9px;height:9px;border-radius:50%;background:${c.dot};display:inline-block;flex-shrink:0;"></span>${cat}`;
    item.addEventListener('click',e=>{e.stopPropagation();saveCatChange(trxId,cat,chipEl);closeCatDropdowns();});
    dd.appendChild(item);
  });
  dd.classList.add('show');
}
export function closeCatDropdowns(){document.querySelectorAll('.cat-dd.show').forEach(d=>d.classList.remove('show'));}

// 달력형 뷰
export function renderCalendarView(){
  const tbody=document.getElementById('h-body'), ce=document.getElementById('h-count');
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
    html+=`<div onclick="showCalendarDayDetail('${dateStr}')" style="min-height:60px;padding:4px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:${isToday?'#eff6ff':'#fff'};transition:background .15s;">
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
  const addBtn=`<button onclick="openModalWithDate('${dateStr}')" style="font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--green);color:var(--green);background:#fff;cursor:pointer;">✍️ 거래 추가</button>`;
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
  const {doc,updateDoc}=fb();
  await updateDoc(doc(fdb(),COLS.TRANSACTIONS,trxId),{category:newCat});
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
  if(pages<=1){el.innerHTML='';return;} el.innerHTML='';
  for(let p=1;p<=pages;p++){
    const btn=document.createElement('button'); btn.textContent=p;
    btn.style.cssText=`padding:6px 12px;border-radius:7px;font-size:13px;font-weight:700;border:1px solid var(--bm);cursor:pointer;background:${p===S.page?'var(--blue)':'#fff'};color:${p===S.page?'#fff':'var(--sub)'};`;
    btn.addEventListener('click',()=>{S.page=p;renderHistoryTable();renderPagination();});
    el.appendChild(btn);
  }
}

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
  if(isConfirmedLocked(data.clientId,data.date)){toast('최종 결재 완료된 월의 거래는 수정할 수 없습니다.','error');return;}
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
    applyFilters();   // 전체 재로드 없이 필터/정렬 유지
  } else {
    // 입력자: createdBy 필드 추가
    if(!data.createdBy&&S.user?.userId)data.createdBy=S.user.userId;
    await addDoc(collection(fdb(),COLS.TRANSACTIONS),data);
    await updateAccBalance(data.accountId);
    if(S.activeClient===data.clientId)await loadTransactions(data.clientId);
  }
  toast('저장되었습니다.','success');
}

export async function delTrx(id,accId){
  const trxCheck=S.transactions.find(x=>x.id===id);
  if(trxCheck&&isConfirmedLocked(trxCheck.clientId,trxCheck.date)){toast('최종 결재 완료된 월의 거래는 삭제할 수 없습니다.','error');return;}
  showConfirm('거래 삭제','이 거래 내역을 삭제하시겠습니까?',async()=>{
    const{doc,deleteDoc}=fb();
    const trx=S.transactions.find(x=>x.id===id);
    await deleteDoc(doc(fdb(),COLS.TRANSACTIONS,id));
    await updateAccBalance(accId);
    // B001: 자산이동 연결 거래 함께 삭제
    if(trx?.type==='자산이동'&&trx.linkedTrxId){
      await deleteDoc(doc(fdb(),COLS.TRANSACTIONS,trx.linkedTrxId));
      if(trx.linkedAccountId)await updateAccBalance(trx.linkedAccountId);
    }
    if(S.activeClient)await loadTransactions(S.activeClient);
    toast('삭제되었습니다.','success');
  });
}

// I002: 거래내역 CSV 내보내기 (현재 필터 기준)
export function exportFilteredCSV(){
  if(!S.filteredTrx||!S.filteredTrx.length){toast('내보낼 데이터가 없습니다.','info');return;}
  const client=S.clients.find(c=>c.id===S.activeClient)||{name:'전체'};
  const header=['날짜','시간','계좌','구분','분류','내용','수입','지출','증빙'];
  const rows=S.filteredTrx.map(t=>{
    const acc=S.accounts.find(a=>a.id===t.accountId)?.label||'';
    return [t.date||'',t.time||'',acc,t.type||'',t.category||'',t.description||'',t.amountIn||0,t.amountOut||0,t.receiptUrl?'O':''].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',');
  });
  const csv='\uFEFF'+[header.join(','),...rows].join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=client.name+'_거래내역_'+new Date().toISOString().split('T')[0]+'.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('CSV 다운로드 완료','success');
}

// ★ 버그4 수정 — 일괄 삭제 후 check-all 체크박스 초기화
export async function confirmBulkDelete(){
  const checked=Array.from(document.querySelectorAll('.row-check:checked'));
  if(!checked.length){toast('삭제할 항목을 선택하세요.','info');return;}
  // confirmed 월 거래 포함 여부 체크
  const lockedChecked=checked.filter(cb=>{const t=S.transactions.find(x=>x.id===cb.value);return t&&isConfirmedLocked(t.clientId,t.date);});
  if(lockedChecked.length){toast(`최종 결재 완료된 월의 거래 ${lockedChecked.length}건이 포함되어 있습니다. 해당 거래는 삭제할 수 없습니다.`,'error');return;}
  showConfirm('일괄 삭제',`선택한 ${checked.length}건을 삭제하시겠습니까?`,async()=>{
    const{doc,deleteDoc}=fb();
    const checkedIds=new Set(checked.map(c=>c.value));
    const linkedToDelete=[]; const linkedAccIds=new Set();
    for(const cb of checked){
      await deleteDoc(doc(fdb(),COLS.TRANSACTIONS,cb.value));
      // B001: 자산이동 연결 거래 수집
      const trx=S.transactions.find(x=>x.id===cb.value);
      if(trx?.type==='자산이동'&&trx.linkedTrxId&&!checkedIds.has(trx.linkedTrxId)){
        linkedToDelete.push(trx.linkedTrxId);
        if(trx.linkedAccountId)linkedAccIds.add(trx.linkedAccountId);
      }
    }
    // 연결 거래 삭제
    for(const lid of linkedToDelete)await deleteDoc(doc(fdb(),COLS.TRANSACTIONS,lid));
    const accIds=[...new Set([...checked.map(c=>c.dataset.acc),...linkedAccIds])];
    for(const a of accIds) await updateAccBalance(a);
    // ★ 체크박스 전체 초기화
    const checkAll=document.getElementById('check-all');
    if(checkAll)checkAll.checked=false;
    if(S.activeClient)await loadTransactions(S.activeClient);
    toast(`${checked.length}건 삭제.`,'success');
  });
}

export function editTrx(id){const t=S.transactions.find(x=>x.id===id);if(!t)return;openModal('trx',t);}

export async function updateAccBalance(accId){
  if(!accId)return;
  const{getDocs,collection,query,where,doc,getDoc,updateDoc}=fb();
  const accRef=doc(fdb(),COLS.ACCOUNTS,accId);
  const accSnap=await getDoc(accRef); if(!accSnap.exists())return;
  const acc=accSnap.data();
  const snap=await getDocs(query(collection(fdb(),COLS.TRANSACTIONS),where('accountId','==',accId)));
  let bal=Number(acc.initialBalance||0);
  // ⑫ initialBalanceDate 기준: 해당 날짜 이후 거래만 합산
  const baseDate=acc.initialBalanceDate||'';
  // 자산이동/취소는 수입/지출 합계에서 제외하지만 잔액에는 반영
  snap.docs.forEach(d=>{
    const t=d.data();
    if(baseDate&&(t.date||'')<baseDate)return; // 기준일 이전 거래 제외
    if(t.type==='취소')return; // 취소 거래는 잔액에 영향 없음
    // 2. 음수 amountOut(환불/취소성 지출)도 잔액에 정확히 반영
    bal+=(Number(t.amountIn||0)-Number(t.amountOut||0));
  });
  await updateDoc(accRef,{currentBalance:bal});
  const local=S.accounts.find(a=>a.id===accId); if(local)local.currentBalance=bal;
}

// ─────────────────────────────────────────────
// 거래내역 정렬/순서
// ─────────────────────────────────────────────
export async function reorderTrx(fromId,toId){
  if(fromId===toId)return;
  const fromIdx=S.filteredTrx.findIndex(x=>x.id===fromId);
  const toIdx  =S.filteredTrx.findIndex(x=>x.id===toId);
  if(fromIdx<0||toIdx<0)return;
  const arr=[...S.filteredTrx];
  const [moved]=arr.splice(fromIdx,1);
  arr.splice(toIdx,0,moved);
  const{doc,updateDoc}=fb();
  const base=(S.page-1)*S.pageSize;
  const pageItems=arr.slice(base,base+S.pageSize);
  for(let i=0;i<pageItems.length;i++){
    const t=pageItems[i];
    const newOrder=base+i;
    if(t.sortOrder!==newOrder){
      t.sortOrder=newOrder;
      await updateDoc(doc(fdb(),COLS.TRANSACTIONS,t.id),{sortOrder:newOrder});
      const orig=S.transactions.find(x=>x.id===t.id);
      if(orig)orig.sortOrder=newOrder;
    }
  }
  S.filteredTrx=arr;
  renderHistoryTable(); renderPagination();
  toast('순서가 저장되었습니다.','success',1500);
}
