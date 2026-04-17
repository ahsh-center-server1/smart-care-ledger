/**
 * modules/settings.js — Smart Care Ledger v2
 * 설정 / 관리 (직원·입주자·계좌·카테고리·규칙·고정항목·예산·마감)
 *
 * 주의: 교차모듈 참조(openModal, loadFixedItems, renderFixedItemsList,
 * fetchBaseData, loadTransactions 등)는 app.js에서 window로 노출되거나
 * import되어 사용된다. 이 파일은 직접 import하지 않고 런타임 전역을 참조한다.
 */

'use strict';

import { S } from '../state.js';
import { toast, showConfirm, showLoading } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import { COLS } from '../constants.js';
import { fetchBaseData, loadTransactions } from './core.js';
import { openModal, renderFixedItemsList } from './modals.js';

// ─────────────────────────────────────────────
// 직원·입주자·계좌 관리 통합 렌더
// ─────────────────────────────────────────────
export function renderManagement(){
  const isAdmin=['관리자','센터장','팀장'].includes(S.user?.role);
  // B005: admin-staff 섹션 및 등록 버튼 역할별 표시/숨김
  const adminStaff=document.getElementById('admin-staff');
  if(adminStaff)adminStaff.style.display=isAdmin?'block':'none';
  const btnAddClient=document.getElementById('btn-add-client');
  const btnAddAccount=document.getElementById('btn-add-account');
  if(btnAddClient)btnAddClient.style.display=isAdmin?'':'none';
  if(btnAddAccount)btnAddAccount.style.display=isAdmin?'':'none';
  const sl=document.getElementById('staff-list'); if(sl)sl.innerHTML='';
  if(isAdmin&&sl)S.users.forEach(u=>{
    const d=document.createElement('div'); d.className='card'; d.style.cssText='padding:12px 14px;display:flex;justify-content:space-between;align-items:center;';
    d.innerHTML=`<div><div style="font-weight:700;color:var(--text);">${u.name||u.userId}</div><div style="font-size:12px;color:var(--muted);">${u.role||''} ${u.team?'· '+u.team:''}</div></div><div style="display:flex;gap:6px;"><button class="icon-btn" onclick="openModal('staff',S.users.find(x=>x.id==='${u.id}'))" style="color:#64748b;">✏️</button></div>`;
    sl.appendChild(d);
  });
  const cl=document.getElementById('client-list'); if(cl)cl.innerHTML='';
  if(cl)S.clients.forEach(c=>{
    const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:10px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;${c.active===false?'opacity:0.55;':''}`;
    const leader=S.users.find(u=>String(u.id)===String(c.teamLeader));
    const inactiveBtn=isAdmin?`<button class="icon-btn" title="${c.active===false?'활성화':'비활성화'}" onclick="toggleClientActive('${c.id}',${c.active===false})" style="color:${c.active===false?'#10b981':'#94a3b8'};">${c.active===false?'🔓':'🔒'}</button>`:'';
    d.innerHTML=`<div><div style="font-weight:700;color:var(--text);">${c.name}${c.active===false?' <span style="font-size:11px;color:#ef4444;">[비활성]</span>':''}</div><div style="font-size:11px;color:var(--muted);">${leader?'팀장: '+leader.name:''}</div></div><div style="display:flex;gap:4px;">${inactiveBtn}<button class="icon-btn" onclick="openModal('client',S.clients.find(x=>x.id==='${c.id}'))" style="color:#64748b;">✏️</button></div>`;
    cl.appendChild(d);
  });
  const al=document.getElementById('account-list'); if(al)al.innerHTML='';
  if(al)S.accounts.forEach(a=>{
    const client=S.clients.find(c=>c.id===a.clientId);
    const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:10px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;${a.active===false?'opacity:0.55;':''}`;
    const inactiveBtn=isAdmin?`<button class="icon-btn" title="${a.active===false?'활성화':'비활성화'}" onclick="toggleAccountActive('${a.id}',${a.active===false})" style="color:${a.active===false?'#10b981':'#94a3b8'};">${a.active===false?'🔓':'🔒'}</button>`:'';
    d.innerHTML=`<div><div style="font-weight:700;color:var(--text);">${a.label}${a.active===false?' <span style="font-size:11px;color:#ef4444;">[비활성]</span>':''}</div><div style="font-size:11px;color:var(--muted);">${client?.name||''}</div><div style="font-size:12px;font-weight:700;color:var(--blue);">${Number(a.currentBalance||0).toLocaleString()}원</div></div><div style="display:flex;gap:4px;">${inactiveBtn}<button class="icon-btn" onclick="openModal('account',S.accounts.find(x=>x.id==='${a.id}'))" style="color:#64748b;">✏️</button></div>`;
    al.appendChild(d);
  });
}

// 별칭 (HTML inline 이벤트에서 참조)
export const renderUserManagement    = renderManagement;
export const renderClientManagement  = renderManagement;
export const renderAccountManagement = renderManagement;

export async function toggleClientActive(id,makeActive){
  const{doc,updateDoc}=fb();
  await updateDoc(doc(fdb(),COLS.CLIENTS,id),{active:makeActive});
  toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
  await fetchBaseData(); renderManagement();
}
export async function toggleAccountActive(id,makeActive){
  const{doc,updateDoc}=fb();
  await updateDoc(doc(fdb(),COLS.ACCOUNTS,id),{active:makeActive});
  toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
  await fetchBaseData(); renderManagement();
}

export function confirmDelete(type,id){
  const labels={client:'입주자',account:'계좌',staff:'직원'};
  showConfirm(labels[type]+' 삭제',labels[type]+'를 삭제하시겠습니까?',async()=>{
    const{doc,deleteDoc}=fb();
    const cols={client:COLS.CLIENTS,account:COLS.ACCOUNTS,staff:COLS.USERS};
    await deleteDoc(doc(fdb(),cols[type],id));
    await fetchBaseData(); renderManagement();
    toast('삭제됨','success');
  },'삭제');
}

// ─────────────────────────────────────────────
// 설정 화면
// ─────────────────────────────────────────────
export async function loadSettings(){
  const isArchive=['관리자','센터장'].includes(S.user?.role);
  const isResetAdmin=S.user?.role==='관리자';
  const archSec=document.getElementById('archive-section');
  if(archSec)archSec.style.display=isArchive?'block':'none';
  const resetSec=document.getElementById('reset-section');
  if(resetSec)resetSec.style.display=isResetAdmin?'block':'none';
  if(isArchive){
    const ySel=document.getElementById('archive-year');
    if(ySel&&!ySel.options.length){const cy=new Date().getFullYear();for(let y=cy-1;y>=cy-6;y--)ySel.add(new Option(y+'년',y));}
    loadArchiveHistory();
  }
  if(isResetAdmin&&!document.getElementById('btn-firebase-reset')?.dataset.bound){
    const btn=document.getElementById('btn-firebase-reset');
    if(btn){btn.dataset.bound='1';btn.addEventListener('click',executeFirebaseReset);}
  }
  const cSel=document.getElementById('settings-client-sel');
  if(cSel){
    const prev=cSel.value;
    cSel.innerHTML='<option value="">공통 (전체 입주자)</option>';
    S.clients.forEach(c=>cSel.add(new Option(c.name,c.id)));
    if(S.clients.some(c=>c.id===prev))cSel.value=prev;
    if(!cSel.dataset.bound){cSel.dataset.bound='1';cSel.addEventListener('change',loadSettings);}
  }
  const settingsClientId=document.getElementById('settings-client-sel')?.value||'';
  const expCats=[...new Set(S.categories.filter(c=>c.keyword===''&&c.type==='지출'&&(!c.clientId||c.clientId===settingsClientId)).map(c=>c.category))];
  const incCats=[...new Set(S.categories.filter(c=>c.keyword===''&&c.type==='수입'&&(!c.clientId||c.clientId===settingsClientId)).map(c=>c.category))];
  const rules=S.categories.filter(c=>c.keyword&&c.keyword!==''&&(!c.clientId||c.clientId===settingsClientId));
  S.settings={expCats,incCats,rules,settingsClientId};
  renderCatTags('지출'); renderCatTags('수입'); renderRuleTags(); updateRuleCatSel();
  const fixedClientSel=document.getElementById('fixed-client-sel');
  if(fixedClientSel){
    const prevFixed=fixedClientSel.value;
    fixedClientSel.innerHTML='<option value="">입주자를 선택하세요</option>';
    S.clients.forEach(c=>fixedClientSel.add(new Option(c.name,c.id)));
    if(S.clients.some(c=>c.id===prevFixed))fixedClientSel.value=prevFixed;
    if(!fixedClientSel.dataset.bound){fixedClientSel.dataset.bound='1';fixedClientSel.addEventListener('change',()=>renderFixedItemsList(fixedClientSel.value));}
    if(fixedClientSel.value)renderFixedItemsList(fixedClientSel.value);
  }
  const addFixedBtn=document.getElementById('btn-add-fixed-item');
  if(addFixedBtn&&!addFixedBtn.dataset.bound){
    addFixedBtn.dataset.bound='1';
    addFixedBtn.addEventListener('click',()=>{
      const cid=document.getElementById('fixed-client-sel')?.value;
      if(!cid){toast('입주자를 먼저 선택하세요.','error');return;}
      S.activeClient=cid; openModal('fixed-item');
    });
  }
  initBudgetSection();
}

// ─────────────────────────────────────────────
// 카테고리 관리
// ─────────────────────────────────────────────
export function renderCatTags(type){
  const id=type==='지출'?'exp-cat-tags':'inc-cat-tags';
  const el=document.getElementById(id); if(!el)return;
  const settingsClientId=S.settings.settingsClientId||'';
  const clientName=settingsClientId?S.clients.find(c=>c.id===settingsClientId)?.name||'':'';
  const allCats=S.categories
    .filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===settingsClientId))
    .sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  const colors=type==='지출'?['#dc2626','#ea580c','#d97706','#16a34a','#2563eb','#9333ea','#c026d3']:['#059669','#0891b2','#1d4ed8'];
  el.innerHTML='<p style="font-size:11px;color:var(--muted);margin-bottom:8px;">⠿ 드래그로 순서 변경 | 자주 쓰는 카테고리를 앞으로</p>';
  let dragSrc=null;
  const seen=new Set();
  allCats.forEach((catDoc,i)=>{
    const cat=catDoc.category; if(seen.has(cat+(catDoc.clientId||'')))return; seen.add(cat+(catDoc.clientId||''));
    const color=colors[i%colors.length], tag=document.createElement('span');
    const isPersonal=!!catDoc.clientId;
    tag.className='cat-tag'; tag.style.borderColor=color+'44'; tag.style.backgroundColor=color+'15';
    tag.style.cursor='grab'; tag.draggable=true; tag.dataset.docId=catDoc.id; tag.dataset.order=String(catDoc.sortOrder??i);
    tag.innerHTML=`<span style="font-size:11px;color:#94a3b8;margin-right:2px;">⠿</span><span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span><span style="font-size:13px;font-weight:700;color:${color};">${cat}</span>`
      +(isPersonal?`<span style="font-size:10px;background:${color}22;color:${color};padding:1px 5px;border-radius:4px;margin-left:2px;">${clientName}</span>`:'')
      +(cat==='확인필요'?'':`<button class="cat-del">×</button>`);
    tag.addEventListener('dragstart',e=>{dragSrc=tag;tag.style.opacity='0.5';e.dataTransfer.effectAllowed='move';});
    tag.addEventListener('dragend',()=>{tag.style.opacity='1';dragSrc=null;});
    tag.addEventListener('dragover',e=>{e.preventDefault();tag.style.outline='2px solid var(--blue)';});
    tag.addEventListener('dragleave',()=>tag.style.outline='');
    tag.addEventListener('drop',async e=>{
      e.preventDefault(); tag.style.outline='';
      if(!dragSrc||dragSrc===tag)return;
      const tags=[...el.querySelectorAll('.cat-tag')];
      const fromIdx=tags.indexOf(dragSrc), toIdx=tags.indexOf(tag);
      if(fromIdx<0||toIdx<0)return;
      if(fromIdx<toIdx)el.insertBefore(dragSrc,tag.nextSibling); else el.insertBefore(dragSrc,tag);
      const{doc,updateDoc}=fb();
      const newTags=[...el.querySelectorAll('.cat-tag')];
      for(let k=0;k<newTags.length;k++){
        const docId=newTags[k].dataset.docId;
        if(docId){await updateDoc(doc(fdb(),COLS.CATEGORIES,docId),{sortOrder:k});const cat=S.categories.find(c=>c.id===docId);if(cat)cat.sortOrder=k;}
      }
      toast('순서 저장됨','success',1500);
    });
    if(cat!=='확인필요')tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제',`"${cat}" 카테고리를 삭제하시겠습니까?`,()=>deleteCategory(type,cat,catDoc.clientId||''),'삭제'));
    el.appendChild(tag);
  });
}
export function renderRuleTags(){
  const el=document.getElementById('rule-tags'); if(!el)return;
  if(!S.settings.rules.length){el.innerHTML='<div class="empty-state" style="padding:20px;"><div class="icon">🏷️</div>등록된 규칙 없음</div>';return;}
  el.innerHTML='';
  const settingsClientName=S.settings.settingsClientId?S.clients.find(c=>c.id===S.settings.settingsClientId)?.name||'':'';
  S.settings.rules.forEach(r=>{
    const tc=r.type==='지출'?'#dc2626':'#16a34a', tag=document.createElement('span');
    const isPersonal=!!r.clientId;
    tag.className='rule-tag'; tag.style.borderColor=tc+'33';
    tag.innerHTML=`<span style="font-size:13px;font-weight:700;color:var(--sub);">"${r.keyword}"</span><span style="font-size:11px;color:var(--muted);">→</span><span style="font-size:13px;font-weight:700;color:${tc};">${r.category}</span>`
      +(isPersonal?`<span style="font-size:10px;background:${tc}22;color:${tc};padding:1px 5px;border-radius:4px;">${settingsClientName||r.clientId}</span>`:'')
      +`<button class="cat-del">×</button>`;
    tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제',`"${r.keyword}" 규칙을 삭제하시겠습니까?`,()=>deleteRule(r.id||r.keyword),'삭제'));
    el.appendChild(tag);
  });
}
export function updateRuleCatSel(){
  const type=document.getElementById('new-rule-type')?.value||'지출';
  const sel=document.getElementById('new-rule-cat'); if(!sel)return;
  sel.innerHTML='';
  const cats=[...new Set(S.categories.filter(c=>c.keyword===''&&c.type===type).map(c=>c.category))];
  cats.forEach(c=>sel.add(new Option(c,c)));
}
export async function addCategory(type,clientId=''){
  const inputId=type==='지출'?'new-exp-cat':'new-inc-cat';
  const input=document.getElementById(inputId);
  const name=(input?.value||'').trim();
  if(!name){toast('카테고리 이름을 입력하세요.','error');return;}
  const exists=S.categories.some(c=>c.keyword===''&&c.type===type&&c.category===name&&(c.clientId||'')===(clientId||''));
  if(exists){toast(`"${name}"은 이미 존재하는 카테고리입니다.`,'error');return;}
  const maxOrder=Math.max(0,...S.categories.filter(c=>c.keyword===''&&c.type===type).map(c=>c.sortOrder||0));
  const{addDoc,collection}=fb();
  const data={keyword:'',type,category:name,subcategory:'',sortOrder:maxOrder+1};
  if(clientId)data.clientId=clientId;
  await addDoc(collection(fdb(),COLS.CATEGORIES),data);
  if(input)input.value='';
  await fetchBaseData(); loadSettings();
  toast(`"${name}" 추가됨`,'success');
}
export async function deleteCategory(type,name,clientId=''){
  const{getDocs,collection,query,where,doc,deleteDoc}=fb();
  const snap=await getDocs(query(collection(fdb(),COLS.CATEGORIES),where('keyword','==',''),where('type','==',type),where('category','==',name)));
  for(const d of snap.docs){
    const data=d.data();
    if(clientId&&(data.clientId||'')!==clientId)continue;
    if(!clientId&&data.clientId)continue;
    await deleteDoc(doc(fdb(),COLS.CATEGORIES,d.id));
  }
  await fetchBaseData(); loadSettings(); toast(`"${name}" 삭제됨`,'success');
}
export async function addRule(){
  const kw=(document.getElementById('new-rule-kw')?.value||'').trim();
  const type=document.getElementById('new-rule-type')?.value||'지출';
  const cat=document.getElementById('new-rule-cat')?.value||'';
  const clientId=document.getElementById('settings-client-sel')?.value||'';
  if(!kw){toast('키워드를 입력하세요.','error');return;}
  if(!cat){toast('카테고리를 선택하세요.','error');return;}
  if(S.settings.rules.some(r=>r.keyword===kw&&(r.clientId||'')===(clientId||''))){toast(`"${kw}"는 이미 등록된 키워드입니다.`,'error');return;}
  const{addDoc,collection}=fb();
  const data={keyword:kw,type,category:cat,subcategory:''};
  if(clientId)data.clientId=clientId;
  await addDoc(collection(fdb(),COLS.CATEGORIES),data);
  const kwInput=document.getElementById('new-rule-kw'); if(kwInput)kwInput.value='';
  await fetchBaseData(); loadSettings(); toast(`"${kw}" 규칙 추가됨`,'success');
}
export async function deleteRule(docId){
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),COLS.CATEGORIES,docId));
  await fetchBaseData(); loadSettings(); toast('규칙 삭제됨','success');
}
export async function resetCategories(){
  showConfirm('기본값 초기화','기존 카테고리와 규칙을 모두 삭제하고 기본값으로 초기화합니다.',async()=>{
    const{getDocs,collection,doc,deleteDoc,addDoc}=fb();
    const snap=await getDocs(collection(fdb(),COLS.CATEGORIES));
    for(const d of snap.docs)await deleteDoc(doc(fdb(),COLS.CATEGORIES,d.id));
    const defaults=[
      {keyword:'',type:'지출',category:'식비',subcategory:'',sortOrder:0},
      {keyword:'',type:'지출',category:'교통비',subcategory:'',sortOrder:1},
      {keyword:'',type:'지출',category:'의료비',subcategory:'',sortOrder:2},
      {keyword:'',type:'지출',category:'생필품',subcategory:'',sortOrder:3},
      {keyword:'',type:'지출',category:'여가비',subcategory:'',sortOrder:4},
      {keyword:'',type:'지출',category:'기타',subcategory:'',sortOrder:5},
      {keyword:'',type:'지출',category:'확인필요',subcategory:'',sortOrder:6},
      {keyword:'',type:'수입',category:'수입',subcategory:'',sortOrder:0},
      {keyword:'',type:'수입',category:'확인필요',subcategory:'',sortOrder:1},
    ];
    for(const d of defaults)await addDoc(collection(fdb(),COLS.CATEGORIES),d);
    await fetchBaseData(); loadSettings(); toast('기본값으로 초기화됨','success');
  },'초기화');
}

// ─────────────────────────────────────────────
// 마감
// ─────────────────────────────────────────────
export async function loadArchiveHistory(){
  const{getDocs,collection,query,where}=fb();
  try{
    const snap=await getDocs(query(collection(fdb(),COLS.CONFIG),where('type','==','archive')));
    const list=snap.docs.map(d=>d.data()).sort((a,b)=>b.year-a.year);
    const el=document.getElementById('archive-history'); if(!el)return;
    el.innerHTML='';
    if(!list.length){el.innerHTML='<div style="font-size:13px;color:var(--muted);">마감 이력 없음</div>';return;}
    list.forEach(r=>{
      const div=document.createElement('div'); div.style.cssText='display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;';
      div.innerHTML=`<span>${r.year}년 마감</span><span style="color:var(--muted);">${r.count}건 · ${r.archivedAt?new Date(r.archivedAt).toLocaleDateString('ko-KR'):''}</span>`;
      el.appendChild(div);
    });
  }catch(e){console.warn('archive history:',e);}
}
export async function confirmArchive(){
  const year=Number(document.getElementById('archive-year')?.value);
  if(!year){toast('연도를 선택하세요.','error');return;}
  showConfirm(`${year}년 데이터 마감`,`${year}년 거래 데이터를 보관하고 계좌 기초잔액을 업데이트합니다.\n이 작업은 되돌릴 수 없습니다.`,()=>executeArchive(year),'마감 실행');
}
export async function executeArchive(year){
  showLoading(true);
  try{
    const{getDocs,collection,query,where,addDoc,doc,updateDoc,deleteDoc}=fb();
    const db=fdb();
    const snap=await getDocs(query(collection(db,COLS.TRANSACTIONS),where('date','>=',year+'-01-01'),where('date','<=',year+'-12-31')));
    const trxList=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!trxList.length){showLoading(false);toast(`${year}년 거래 데이터가 없습니다.`,'error');return;}
    for(const t of trxList)await addDoc(collection(db,'archive_'+year),t);
    for(const acc of S.accounts){
      const net=trxList.filter(t=>t.accountId===acc.id&&t.type!=='취소').reduce((s,t)=>s+(Number(t.amountIn||0)-Number(t.amountOut||0)),0);
      const newBal=(Number(acc.initialBalance||0))+net;
      await updateDoc(doc(db,COLS.ACCOUNTS,acc.id),{initialBalance:newBal,initialBalanceDate:(year+1)+'-01-01',currentBalance:newBal});
    }
    for(const t of trxList)await deleteDoc(doc(db,COLS.TRANSACTIONS,t.id));
    await addDoc(collection(db,COLS.CONFIG),{type:'archive',year,archivedAt:new Date().toISOString(),count:trxList.length});
    await fetchBaseData(); loadSettings();
    toast(`${year}년 마감 완료! ${trxList.length}건 보관.`,'success',5000);
  }catch(e){toast('마감 오류: '+e.message,'error');}
  showLoading(false);
}

// ─────────────────────────────────────────────
// 예산 관리
// ─────────────────────────────────────────────
export function initBudgetSection(){
  const cSel=document.getElementById('budget-client-sel');
  const ySel=document.getElementById('budget-year-sel');
  if(!cSel||!ySel)return;
  cSel.innerHTML='<option value="">입주자 선택</option>';
  S.clients.forEach(c=>cSel.add(new Option(c.name,c.id)));
  if(!ySel.options.length){
    const cy=new Date().getFullYear();
    for(let y=cy+1;y>=cy-3;y--)ySel.add(new Option(y+'년',y));
    ySel.value=cy;
  }
  if(!cSel.dataset.budgetBound){
    cSel.dataset.budgetBound='1';
    document.getElementById('btn-budget-load')?.addEventListener('click',loadBudgetForm);
    document.getElementById('btn-budget-save')?.addEventListener('click',saveBudget);
  }
}

export async function loadBudgetForm(){
  const clientId=document.getElementById('budget-client-sel')?.value;
  const year=Number(document.getElementById('budget-year-sel')?.value);
  if(!clientId||!year){toast('입주자와 연도를 선택하세요.','error');return;}
  const{getDocs,collection,query,where}=fb();
  const db=fdb();
  const [snap,prevSnap]=await Promise.all([
    getDocs(query(collection(db,COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year))),
    getDocs(query(collection(db,COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year-1))),
  ]);
  const existing={};
  snap.docs.forEach(d=>{const b=d.data();existing[b.category]=b.amount||0;});
  const prevBudget={};
  prevSnap.docs.forEach(d=>{const b=d.data();prevBudget[b.category]=b.amount||0;});
  const expCats=[...new Set([
    ...[...new Map(
      S.categories.filter(c=>c.type==='지출'&&c.keyword==='').sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(c=>[c.category,c.category])
    ).keys()],
    ...Object.keys(prevBudget),
  ])];
  const rows=document.getElementById('budget-cat-rows');
  if(!rows)return;
  const hasPrev=Object.keys(prevBudget).length>0;
  const hdr=hasPrev?`<div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:2px solid var(--border);font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;">
    <span style="width:120px;">카테고리</span>
    <span style="width:110px;text-align:right;">${year-1}년 예산</span>
    <span style="width:130px;text-align:right;">${year}년 예산</span>
  </div>`:'' ;
  rows.innerHTML=hdr+expCats.map(cat=>{
    const prev=prevBudget[cat]||0;
    const prevCol=hasPrev?`<span style="width:110px;text-align:right;font-size:12px;color:var(--muted);">${prev>0?prev.toLocaleString()+'원':'-'}</span>`:'';
    return`<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);">
      <span style="width:120px;font-size:13px;font-weight:600;color:var(--text);">${cat}</span>
      ${prevCol}
      <input type="number" class="input budget-amt" data-cat="${cat}" value="${existing[cat]||0}" min="0" style="width:130px;padding:6px 10px;text-align:right;" placeholder="0">
      <span style="font-size:12px;color:var(--muted);">원</span>
    </div>`;}).join('');
  document.getElementById('budget-form').style.display='block';
}

export async function saveBudget(){
  const clientId=document.getElementById('budget-client-sel')?.value;
  const year=Number(document.getElementById('budget-year-sel')?.value);
  if(!clientId||!year)return;
  showLoading(true);
  try{
    const{getDocs,collection,query,where,doc,deleteDoc,addDoc}=fb();
    const db=fdb();
    const snap=await getDocs(query(collection(db,COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year)));
    for(const d of snap.docs)await deleteDoc(doc(db,COLS.BUDGETS,d.id));
    const inputs=document.querySelectorAll('.budget-amt');
    for(const inp of inputs){
      const amount=Number(inp.value)||0;
      if(amount>0)await addDoc(collection(db,COLS.BUDGETS),{clientId,year,category:inp.dataset.cat,amount});
    }
    toast('예산이 저장되었습니다.','success');
  }catch(e){toast('저장 오류: '+e.message,'error');}
  showLoading(false);
}

// ─────────────────────────────────────────────
// Firebase 초기화 (관리자 전용)
// ─────────────────────────────────────────────
export async function executeFirebaseReset(){
  if(S.user?.role!=='관리자'){toast('관리자만 초기화할 수 있습니다.','error');return;}
  showConfirm('Firebase 전체 초기화','모든 거래/계좌/입주자/보고서 데이터를 삭제합니다. 정말로 진행하시겠습니까?',async()=>{
    const code=prompt('확인을 위해 "초기화"를 입력하세요:');
    if(code!=='초기화'){toast('취소되었습니다.','info');return;}
    showLoading(true);
    try{
      const{getDocs,collection,deleteDoc,doc}=fb();
      const db=fdb();
      const cols=[COLS.TRANSACTIONS,COLS.CLIENTS,COLS.ACCOUNTS,COLS.CATEGORIES,COLS.REPORTS,COLS.CONFIG,COLS.EXCEL_UPLOADS,'fixedItems'];
      for(const col of cols){
        const snap=await getDocs(collection(db,col));
        for(const d of snap.docs)await deleteDoc(doc(db,col,d.id));
      }
      await fetchBaseData();
      loadSettings();
      toast('초기화 완료. 모든 데이터가 삭제되었습니다.','success',5000);
    }catch(e){toast('초기화 오류: '+e.message,'error');}
    showLoading(false);
  },'초기화 실행');
}
