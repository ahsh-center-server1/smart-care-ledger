/**
 * modules/fixed-items.js — 고정항목 (입주자별 정기 수입·지출 템플릿)
 *
 * modals.js 에서 떼어 왔다. 그 파일은 1600줄을 넘겨 이미 예외 목록에 올라 있고,
 * test/architecture.test.mjs 가 "기능을 더할 곳이 아니라 쪼갤 곳"이라고 말한다.
 * 그 목록의 주석이 지목한 다섯 갈래 중 첫 번째다.
 *
 * 조회가 담당 범위로 좁혀져 있다
 *   고정항목에는 입주자별 금액이 들어 있어 보안 규칙이 담당 범위를 본다.
 *   규칙은 필터가 아니므로 넓게 물으면 쿼리가 통째로 거부된다 — 그래서
 *   core.js 의 fetchInScope 를 쓴다.
 */

'use strict';

import { S } from '../state.js';
import { iconSvg } from '../utils/icons.js';
import { parseAmount, attachAmountInput } from '../utils/amount-input.js';
import { COLS } from '../constants.js';
import { toast, showConfirm } from '../utils/ui.js';
import { fb, fdb, batchAddDocs } from '../services/firestore.js';
import { fetchInScope } from '../services/scoped-fetch.js';

/**
 * 화면 쪽 의존은 **주입받는다.**
 *
 * 직접 import 하면 modals.js → fixed-items.js → core.js → settings.js →
 * modals.js 로 순환에 끼어든다(openModal 이 이 파일의 렌더러를 부르기 때문에
 * 앞의 화살표는 끊을 수 없다). 그래서 뒤쪽 화살표를 주입으로 끊는다 —
 * settings-crud.js 가 같은 이유로 쓰는 방식이다.
 */
let shell = {
  open: () => {}, close: () => {},
  loadTransactions: async () => {},
  isConfirmedLocked: () => false,
  scope: () => ({ all: false, ids: [] }),
};
export function registerModalShell(next) { shell = { ...shell, ...next }; }

// ─────────────────────────────────────────────
// 고정항목
// ─────────────────────────────────────────────
export async function loadFixedItems(clientId){
  if(!clientId)return;
  const{getDocs,collection,query,where}=fb();
  const snap=await getDocs(query(collection(fdb(),COLS.FIXED_ITEMS),where('clientId','==',clientId)));
  S.fixedItems=snap.docs.map(d=>({id:d.id,...d.data()}));
}
export async function applyFixedItems(){
  const clientId=S.activeClient;
  if(!clientId){toast('입주자를 먼저 선택하세요.','error');return;}
  await loadFixedItems(clientId);
  if(!S.fixedItems.length){toast('등록된 고정항목이 없습니다. 설정에서 추가하세요.','info');return;}
  // 기본값: 이전 달
  const now=new Date();
  const prev=new Date(now.getFullYear(),now.getMonth()-1,1);
  const defaultYM=prev.getFullYear()+'-'+String(prev.getMonth()+1).padStart(2,'0');
  // 월 선택 모달
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">📌 고정항목 입력</h3>
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <label class="label">입력 대상 월</label>
        <input type="month" id="fi-month-sel" class="input" value="${defaultYM}" style="padding:8px 12px;">
      </div>
      <button id="fi-month-ok" class="btn" style="padding:11px;width:100%;">${iconSvg('pin')}이 달로 입력하기</button>
    </div>`;
  document.getElementById('modal-wrap').classList.add('show');
  document.getElementById('fi-month-ok').addEventListener('click',async()=>{
    const yearMonth=document.getElementById('fi-month-sel').value;
    if(!yearMonth){toast('월을 선택하세요.','error');return;}
    // 최종 결재 완료 월에는 고정항목 입력 불가
    if(shell.isConfirmedLocked(clientId,yearMonth+'-01')){toast(`${yearMonth}은 최종 결재 완료된 월이라 고정항목을 입력할 수 없습니다.`,'error',5000);return;}
    shell.close();
    const existing=S.transactions.filter(t=>(t.date||'').startsWith(yearMonth)&&t.isFixed);
    const existKeys=new Set(existing.map(t=>t.fixedItemId));
    const toAdd=S.fixedItems.filter(f=>!existKeys.has(f.id));
    if(!toAdd.length){toast(`${yearMonth} 고정항목이 이미 입력되었습니다.`,'info');return;}
    showConfirm('고정항목 입력',`${yearMonth} 기준 고정항목 ${toAdd.length}건을 입력하시겠습니까?`,async()=>{
      // 한 건씩 addDoc하면 중간에 끊겼을 때 절반만 들어간다 → 배치로 묶는다.
      // createdBy를 반드시 남긴다 — 보안 규칙이 모든 거래 생성에
      // createdBy == 본인 uid를 요구하므로, 없으면 **전부 거부된다.**
      await batchAddDocs(toAdd.map(f=>({col:COLS.TRANSACTIONS,data:{
        clientId,accountId:f.accountId,
        date:f.day?yearMonth+'-'+String(f.day).padStart(2,'0'):yearMonth+'-01',
        type:f.type,category:f.category,description:f.description,
        amountIn:f.type==='수입'?Number(f.amount):0,
        amountOut:f.type==='지출'?Number(f.amount):0,
        isFixed:true,fixedItemId:f.id,
        createdBy:String(S.user?.userId||''),
      }})));
      toast(`${toAdd.length}건 입력 완료`,'success');
      await shell.loadTransactions(clientId);
    },'입력');
  });
}
async function refreshAllFixedItems(){
  // 담당 범위로 좁혀 묻는다 — 규칙은 필터가 아니라, 넓게 물으면 통째로 거부된다.
  try{
    const snap=await fetchInScope(fdb(),COLS.FIXED_ITEMS,shell.scope('clientId'));
    S.allFixedItems=snap.docs.map(d=>({id:d.id,...d.data()}));
  }catch(e){/* no-op */}
}
export async function saveFixedItem(data){
  const{addDoc,setDoc,doc,collection}=fb();
  if(data.id){const id=data.id;delete data.id;await setDoc(doc(fdb(),COLS.FIXED_ITEMS,id),data);}
  else await addDoc(collection(fdb(),COLS.FIXED_ITEMS),data);
  await refreshAllFixedItems();
  toast('고정항목 저장됨','success');
}
export async function deleteFixedItem(id){
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),COLS.FIXED_ITEMS,id));
  await refreshAllFixedItems();
  toast('삭제됨','success');
}

// 필수 고정항목 중 해당 월에 미납된 항목 배열 반환
// @param clientId
// @param ym 'YYYY-MM'
// @param trxList 해당 월 거래 목록(없으면 S.transactions에서 자동 추출)
export function getUnpaidMandatoryItems(clientId, ym, trxList){
  if(!clientId||!ym)return[];
  // 미래 월은 알림 없음 — 당월 또는 과거만
  const now=new Date();
  const curYM=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  if(ym>curYM)return[];
  const pool=(S.allFixedItems&&S.allFixedItems.length)?S.allFixedItems:S.fixedItems;
  const mandatory=pool.filter(f=>f.clientId===clientId&&f.isMandatory);
  if(!mandatory.length)return[];
  const txs=Array.isArray(trxList)?trxList:S.transactions.filter(t=>t.clientId===clientId&&(t.date||'').startsWith(ym));
  const paidIds=new Set(txs.filter(t=>t.isFixed&&t.fixedItemId).map(t=>t.fixedItemId));
  return mandatory.filter(f=>!paidIds.has(f.id));
}

// ─────────────────────────────────────────────
// 고정항목 폼
// ─────────────────────────────────────────────
export function renderFixedItemForm(item){
  const isEdit=!!item;
  const accs=S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">⚙️ 고정항목 ${isEdit?'수정':'등록'}</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">계좌</label><select id="fi-acc" class="input" style="padding:8px 12px;"></select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">구분</label><select id="fi-type" class="input" style="padding:8px 12px;"><option value="지출">지출</option><option value="수입">수입</option></select></div>
        <div><label class="label">매월 몇 일</label><input type="number" id="fi-day" class="input" min="1" max="31" value="${isEdit?item.day||1:1}"></div>
      </div>
      <div><label class="label">카테고리</label><select id="fi-cat" class="input" style="padding:8px 12px;"></select></div>
      <div><label class="label">내용</label><input type="text" id="fi-desc" class="input" value="${isEdit?item.description||'':''}" placeholder="예: 국민연금, 복지관 이용료"></div>
      <div><label class="label">금액</label><input type="text" inputmode="numeric" id="fi-amt" class="input" value="${isEdit?item.amount||0:0}" style="text-align:right;"></div>
      <div style="display:flex;align-items:center;gap:8px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;">
        <input type="checkbox" id="fi-mandatory" ${isEdit&&item.isMandatory?'checked':''} style="width:16px;height:16px;cursor:pointer;accent-color:#dc2626;">
        <label for="fi-mandatory" style="font-size:13px;color:#991b1b;cursor:pointer;">필수 항목 (미납 시 알림 표시)</label>
      </div>
      <button id="fi-save" class="btn" style="width:100%;padding:11px;">${iconSvg('check')}저장</button>
    </div>`;
  const accSel=document.getElementById('fi-acc');
  accs.forEach(a=>accSel.add(new Option(a.label,a.id)));
  if(isEdit&&item.accountId)accSel.value=item.accountId;
  const catSel=document.getElementById('fi-cat');
  attachAmountInput(document.getElementById('fi-amt'));
  const fillCats=()=>{const type=document.getElementById('fi-type').value;catSel.innerHTML='';const cats=[...new Map(S.categories.filter(c=>c.keyword===''&&c.type===type).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(c=>[c.category,c.category])).keys()];cats.forEach(c=>catSel.add(new Option(c,c)));if(isEdit&&item.category)catSel.value=item.category;};
  fillCats();
  document.getElementById('fi-type').addEventListener('change',fillCats);
  document.getElementById('fi-save').addEventListener('click',async()=>{
    const data={clientId:S.activeClient,accountId:document.getElementById('fi-acc').value,type:document.getElementById('fi-type').value,day:Number(document.getElementById('fi-day').value)||1,category:document.getElementById('fi-cat').value,description:document.getElementById('fi-desc').value,amount:parseAmount(document.getElementById('fi-amt').value),isMandatory:!!document.getElementById('fi-mandatory')?.checked};
    if(isEdit)data.id=item.id;
    await saveFixedItem(data); shell.close();
  });
}

export async function renderFixedItemsList(clientId){
  if(!clientId)return;
  await loadFixedItems(clientId);
  const el=document.getElementById('fixed-items-list'); if(!el)return;
  el.innerHTML='';
  if(!S.fixedItems.length){el.innerHTML='<div style="font-size:13px;color:var(--muted);padding:8px 0;">등록된 고정항목이 없습니다.</div>';return;}
  S.fixedItems.forEach(f=>{
    const acc=S.accounts.find(a=>a.id===f.accountId)?.label||'-';
    const div=document.createElement('div');
    div.style.cssText='display:flex;justify-content:space-between;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px 14px;';
    const mandBadge=f.isMandatory?' <span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:4px;font-weight:700;">필수</span>':'';
    div.innerHTML='<div><div style="font-size:14px;font-weight:700;color:var(--text);">'+(f.description||'(이름없음)')+mandBadge+' <span style="font-size:12px;font-weight:400;color:var(--muted);">매월 '+(f.day||1)+'일</span></div><div style="font-size:12px;color:var(--muted);margin-top:2px;">'+acc+' · '+f.type+' · '+f.category+' · '+Number(f.amount||0).toLocaleString()+'원</div></div><div style="display:flex;gap:6px;"><button class="fi-edit-btn icon-btn edit" title="수정" style="color:#64748b;">'+iconSvg('pen',18)+'</button><button class="fi-del-btn icon-btn del" title="삭제" style="color:#94a3b8;">'+iconSvg('trash',18)+'</button></div>';
    div.querySelector('.fi-edit-btn').addEventListener('click',()=>{S.activeClient=clientId;shell.open('fixed-item',f);});
    div.querySelector('.fi-del-btn').addEventListener('click',()=>showConfirm('삭제','"'+f.description+'" 고정항목을 삭제하시겠습니까?',async()=>{await deleteFixedItem(f.id);renderFixedItemsList(clientId);}));
    el.appendChild(div);
  });
}
