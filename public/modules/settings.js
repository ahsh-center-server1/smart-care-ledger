/**
 * modules/settings.js — Smart Care Ledger v2
 * 설정 / 관리 (직원·입주자·계좌·카테고리·규칙·고정항목·예산·마감)
 *
 * 의존성:
 *   - core.js  : fetchBaseData, loadTransactions (명시적 import)
 *   - modals.js: openModal, renderFixedItemsList (명시적 import)
 *   - innerHTML onclick 문자열 내 bare global: openModal, toggleClientActive,
 *     toggleAccountActive (window 경유 필수 — 변경 금지)
 */

'use strict';

import { S } from '../state.js';
import { toast, showConfirm, showLoading, escAttr } from '../utils/ui.js';
import { fb, fdb, batchUpdateDocs, batchDeleteDocs, batchAddDocs, batchMixedOps } from '../services/firestore.js';
import { COLS } from '../constants.js';
// loadTransactions: settings.js에서 직접 호출 없음 — modals.js(Task 4)에서 사용
import { fetchBaseData, loadTransactions } from './core.js';
import { openModal, renderFixedItemsList } from './modals.js';
import { can, savePermissions, DEFAULT_PERMISSIONS } from './permissions.js';

// ─────────────────────────────────────────────
// 직원·입주자·계좌 관리 통합 렌더
// ─────────────────────────────────────────────
// ⚠️ 아래 함수들의 innerHTML에는 bare global 호출이 포함됨
// (openModal, toggleClientActive, toggleAccountActive 등)
// window 경유로 해석되므로 import된 심볼명으로 교체하면 런타임 오류 발생
export function renderManagement(){
  const isAdmin=can('nav.staff');
  // B005: admin-staff 섹션 및 등록 버튼 역할별 표시/숨김
  const adminStaff=document.getElementById('admin-staff');
  if(adminStaff)adminStaff.style.display=isAdmin?'block':'none';
  const btnAddClient=document.getElementById('btn-add-client');
  const btnAddAccount=document.getElementById('btn-add-account');
  if(btnAddClient)btnAddClient.style.display=isAdmin?'':'none';
  if(btnAddAccount)btnAddAccount.style.display=isAdmin?'':'none';
  // 일괄 등록 버튼 표시 및 이벤트 바인딩 (관리자 전용)
  ['bulk-staff','bulk-client','bulk-account'].forEach(key=>{
    const btn=document.getElementById('btn-'+key);
    if(btn){
      btn.style.display=isAdmin?'':'none';
      if(!btn.dataset.bound){
        btn.dataset.bound='1';
        btn.addEventListener('click',()=>openModal(key));
      }
    }
  });
  const sl=document.getElementById('staff-list'); if(sl)sl.innerHTML='';
  if(isAdmin&&sl){
    // 승인 대기 직원 (노란 카드)
    const pendingUsers=S.users.filter(u=>u.approved===false);
    if(pendingUsers.length){
      const header=document.createElement('div');
      header.style.cssText='font-size:12px;font-weight:700;color:#92400e;margin-bottom:6px;padding:6px 10px;background:#fef3c7;border-radius:8px;border:1px solid #fde68a;';
      header.textContent=`⏳ 승인 대기 ${pendingUsers.length}명`;
      sl.appendChild(header);
      pendingUsers.forEach(u=>{
        const d=document.createElement('div'); d.className='card'; d.style.cssText='padding:12px 14px;display:flex;justify-content:space-between;align-items:center;background:#fffbeb;border-color:#fde68a;';
        d.innerHTML=`<div><div style="font-weight:700;color:#92400e;">${escAttr(u.name||u.userId)}</div><div style="font-size:12px;color:#b45309;">${u.role||'입력자'} ${u.team?'· '+u.team:''}<span style="margin-left:6px;background:#fef3c7;border:1px solid #fde68a;border-radius:99px;padding:1px 7px;font-size:10px;color:#92400e;">승인 대기</span></div></div><div style="display:flex;gap:6px;"><button class="btn" onclick="approveStaff('${escAttr(u.id)}')" style="font-size:12px;padding:5px 12px;background:#10b981;border:none;">✓ 승인</button></div>`;
        sl.appendChild(d);
      });
      const divider=document.createElement('div'); divider.style.cssText='height:1px;background:var(--border);margin:8px 0;'; sl.appendChild(divider);
    }
    // 승인된 직원
    S.users.filter(u=>u.approved!==false).forEach(u=>{
      const d=document.createElement('div'); d.className='card'; d.style.cssText='padding:12px 14px;display:flex;justify-content:space-between;align-items:center;';
      d.innerHTML=`<div><div style="font-weight:700;color:var(--text);">${u.name||u.userId}</div><div style="font-size:12px;color:var(--muted);">${u.role||''} ${u.team?'· '+u.team:''}</div></div><div style="display:flex;gap:6px;"><button class="icon-btn" onclick="openModal('staff',S.users.find(x=>x.id==='${escAttr(u.id)}'))" style="color:#64748b;">✏️</button></div>`;
      sl.appendChild(d);
    });
  }

  // 관리자: 전체 목록 / 비관리자: 담당 입주자만 (비활성 포함) — 입주자·계좌 공통 기준
  const myUserId=String(S.user?.userId||'');
  const visibleClients=(S.allClients?.length?S.allClients:S.clients).filter(c=>
    isAdmin||(()=>{
      const ids=String(c.userIds||'').split(',').map(s=>s.trim());
      const myDocId=String(S.users.find(u=>String(u.userId)===myUserId)?.id||'');
      return ids.includes(myUserId)||(myDocId&&ids.includes(myDocId));
    })()
  );
  const visibleClientIds=new Set(visibleClients.map(c=>c.id));

  // 입주자 목록: 활성→비활성 순 배치
  const cl=document.getElementById('client-list'); if(cl)cl.innerHTML='';
  if(cl){
    const active=visibleClients.filter(c=>c.active!==false);
    const inactive=visibleClients.filter(c=>c.active===false);
    [...active,...inactive].forEach(c=>{
      const isActive=c.active!==false;
      const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:10px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;${!isActive?'opacity:0.6;background:#f8f9fa;':''}`;
      const leader=S.users.find(u=>String(u.id)===String(c.teamLeader));
      const toggleSwitch=isAdmin?`<div onclick="toggleClientActive('${escAttr(c.id)}',${!isActive})" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
        <span style="display:inline-block;width:36px;height:20px;border-radius:10px;background:${isActive?'#10b981':'#cbd5e1'};transition:background 0.2s;position:relative;flex-shrink:0;">
          <span style="display:block;width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:${isActive?'18px':'2px'};transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></span>
        </span>
        <span style="font-size:10px;color:${isActive?'#10b981':'#94a3b8'};font-weight:700;min-width:28px;">${isActive?'활성':'비활성'}</span>
      </div>`:'';
      d.innerHTML=`<div><div style="font-weight:700;color:${isActive?'var(--text)':'#94a3b8'};">${c.name}</div><div style="font-size:11px;color:var(--muted);">${leader?'팀장: '+leader.name:''}</div></div><div style="display:flex;gap:8px;align-items:center;">${toggleSwitch}<button class="icon-btn" onclick="openModal('client',(S.allClients||S.clients).find(x=>x.id==='${escAttr(c.id)}'))" style="color:#64748b;">✏️</button></div>`;
      cl.appendChild(d);
    });
  }

  // 계좌 목록: 담당 입주자의 계좌만 (비활성 포함), 활성→비활성 순 배치
  const al=document.getElementById('account-list'); if(al)al.innerHTML='';
  if(al){
    const allA=(S.allAccounts?.length?S.allAccounts:S.accounts).filter(a=>
      isAdmin||visibleClientIds.has(a.clientId)
    );
    const active=allA.filter(a=>a.active!==false);
    const inactive=allA.filter(a=>a.active===false);
    [...active,...inactive].forEach(a=>{
      const isActive=a.active!==false;
      const client=(S.allClients||S.clients).find(c=>c.id===a.clientId);
      const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:10px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;${!isActive?'opacity:0.6;background:#f8f9fa;':''}`;
      const toggleSwitch=isAdmin?`<div onclick="toggleAccountActive('${escAttr(a.id)}',${!isActive})" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
        <span style="display:inline-block;width:36px;height:20px;border-radius:10px;background:${isActive?'#10b981':'#cbd5e1'};transition:background 0.2s;position:relative;flex-shrink:0;">
          <span style="display:block;width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:${isActive?'18px':'2px'};transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></span>
        </span>
        <span style="font-size:10px;color:${isActive?'#10b981':'#94a3b8'};font-weight:700;min-width:28px;">${isActive?'활성':'비활성'}</span>
      </div>`:'';
      d.innerHTML=`<div><div style="font-weight:700;color:${isActive?'var(--text)':'#94a3b8'};">${a.label}</div><div style="font-size:11px;color:var(--muted);">${client?.name||''}</div><div style="font-size:12px;font-weight:700;color:${isActive?'var(--blue)':'#94a3b8'};">${Number(a.currentBalance||0).toLocaleString()}원</div></div><div style="display:flex;gap:8px;align-items:center;">${toggleSwitch}<button class="icon-btn" onclick="openModal('account',(S.allAccounts||S.accounts).find(x=>x.id==='${escAttr(a.id)}'))" style="color:#64748b;">✏️</button></div>`;
      al.appendChild(d);
    });
  }
}

// 별칭 (HTML inline 이벤트에서 참조)
export const renderUserManagement    = renderManagement;
export const renderClientManagement  = renderManagement;
export const renderAccountManagement = renderManagement;

export async function toggleClientActive(id,makeActive){
  try{
    const{doc,updateDoc}=fb();
    await updateDoc(doc(fdb(),COLS.CLIENTS,id),{active:makeActive});
    toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
    await fetchBaseData(); renderManagement();
  }catch(e){ toast('저장 오류: '+e.message,'error'); }
}
export async function toggleAccountActive(id,makeActive){
  try{
    const{doc,updateDoc}=fb();
    await updateDoc(doc(fdb(),COLS.ACCOUNTS,id),{active:makeActive});
    toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
    await fetchBaseData(); renderManagement();
  }catch(e){ toast('저장 오류: '+e.message,'error'); }
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
  const isArchive=can('settings.archive');
  const isResetAdmin=can('settings.reset');
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
  const permSec=document.getElementById('permission-section');
  if(permSec)permSec.style.display=isResetAdmin?'block':'none';
  // 이미 패널이 렌더링된 경우 재호출 금지 (편집 중 draft 초기화 방지)
  if(isResetAdmin&&!document.getElementById('btn-perm-save'))renderPermissionPanel();
  initBudgetSection();
  // 탭 초기화
  renderCategoryTarget();
  initSettingsTabs();
}

// ─────────────────────────────────────────────
// 카테고리 관리
// ─────────────────────────────────────────────
export function renderCategoryTarget(){
  const el=document.getElementById('category-target-content');
  if(!el)return;
  const isAdmin=can('settings.reset');
  const cSel=document.getElementById('settings-client-sel');
  const clientId=cSel?.value||'';
  const isCommon=clientId==='';
  let html=`<div class="card" style="padding:20px;">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <span style="font-size:13px;font-weight:700;color:var(--sub);">📋 카테고리 관리 대상:</span>
      <select id="settings-client-sel" class="input" style="width:180px;padding:7px 10px;">
        <option value="">공통 (전체 입주자)</option>`;
  S.clients.forEach(c=>html+=`<option value="${c.id}">${c.name}</option>`);
  html+=`</select>
      <span style="font-size:12px;color:var(--muted);">특정 입주자 선택 시 해당 입주자 전용 카테고리가 표시됩니다.</span>
    </div>`;
  if(isCommon&&!isAdmin){
    html+=`<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px;margin-top:10px;font-size:13px;color:#dc2626;">
      <strong>⚠️ 읽기 전용</strong><br/>공통 카테고리는 관리자만 추가, 수정, 삭제할 수 있습니다.
    </div>`;
  }
  html+=`</div>`;
  el.innerHTML=html;
  const newSel=document.getElementById('settings-client-sel');
  if(newSel&&!newSel.dataset.bound){
    newSel.dataset.bound='1';
    newSel.addEventListener('change',loadSettings);
  }
}

export function renderCatTags(type){
  const id=type==='지출'?'exp-cat-tags':'inc-cat-tags';
  const el=document.getElementById(id); if(!el)return;
  const settingsClientId=S.settings.settingsClientId||'';
  const clientName=settingsClientId?S.clients.find(c=>c.id===settingsClientId)?.name||'':'';
  const isAdmin=can('settings.reset');
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
    const isCommon=!catDoc.clientId;
    const isCommonReadOnly=isCommon&&!isAdmin;
    tag.className='cat-tag'; tag.style.borderColor=color+'44'; tag.style.backgroundColor=color+'15';
    if(isCommonReadOnly)tag.style.opacity='0.6';
    tag.style.cursor=isCommonReadOnly?'default':'grab';
    tag.draggable=!isCommonReadOnly;
    tag.dataset.docId=catDoc.id;
    tag.dataset.order=String(catDoc.sortOrder??i);
    tag.innerHTML=`<span style="font-size:11px;color:#94a3b8;margin-right:2px;">⠿</span><span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span><span style="font-size:13px;font-weight:700;color:${color};">${cat}</span>`
      +(isPersonal?`<span style="font-size:10px;background:${color}22;color:${color};padding:1px 5px;border-radius:4px;margin-left:2px;">${clientName}</span>`:'')
      +(cat==='확인필요'||isCommonReadOnly?'':`<button class="cat-del">×</button>`);
    if(!isCommonReadOnly){
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
        // Phase 2 최적화: 배치 업데이트
        const newTags=[...el.querySelectorAll('.cat-tag')];
        const toUpdate=[];
        for(let k=0;k<newTags.length;k++){
          const docId=newTags[k].dataset.docId;
          if(docId){
            toUpdate.push({col:COLS.CATEGORIES,docId,data:{sortOrder:k}});
            const cat=S.categories.find(c=>c.id===docId);
            if(cat)cat.sortOrder=k;
          }
        }
        if(toUpdate.length)await batchUpdateDocs(toUpdate);
        toast('순서 저장됨','success',1500);
      });
    }
    if(cat!=='확인필요'&&!isCommonReadOnly)tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제',`"${cat}" 카테고리를 삭제하시겠습니까?`,()=>deleteCategory(type,cat,catDoc.clientId||''),'삭제'));
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
  if(!clientId&&!can('settings.reset')){
    toast('공통 카테고리는 관리자만 추가할 수 있습니다.','error');
    return;
  }
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
  if(!clientId&&!can('settings.reset')){
    toast('공통 카테고리는 관리자만 삭제할 수 있습니다.','error');
    return;
  }
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
// Phase 2 최적화: 배치 삭제 + 배치 추가
export async function resetCategories(){
  showConfirm('기본값 초기화','기존 카테고리와 규칙을 모두 삭제하고 기본값으로 초기화합니다.',async()=>{
    const{getDocs,collection}=fb();
    const snap=await getDocs(collection(fdb(),COLS.CATEGORIES));
    // 배치 삭제
    const toDelete=snap.docs.map(d=>({col:COLS.CATEGORIES,docId:d.id}));
    if(toDelete.length)await batchDeleteDocs(toDelete);
    // 기본값 준비
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
    // 배치 추가
    const toAdd=defaults.map(d=>({col:COLS.CATEGORIES,data:d}));
    if(toAdd.length)await batchAddDocs(toAdd);
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
// Phase 3 최적화: 배치 처리 + 500개 단위 자동 분할
export async function executeArchive(year){
  showLoading(true);
  try{
    const{getDocs,collection,query,where,addDoc,doc}=fb();
    const db=fdb();
    const snap=await getDocs(query(collection(db,COLS.TRANSACTIONS),where('date','>=',year+'-01-01'),where('date','<=',year+'-12-31')));
    const trxList=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!trxList.length){showLoading(false);toast(`${year}년 거래 데이터가 없습니다.`,'error');return;}
    // 1. 배치 추가: archive_YYYY 테이블에 거래 복제 (500개씩 자동 분할)
    const archiveData=trxList.map(t=>({col:'archive_'+year,data:t}));
    await batchAddDocs(archiveData);
    // 2. 배치 업데이트: 계좌별 기초잔액 업데이트 (500개 제한 자동 처리)
    const accUpdates=S.accounts.map(acc=>{
      const net=trxList.filter(t=>t.accountId===acc.id&&t.type!=='취소').reduce((s,t)=>s+(Number(t.amountIn||0)-Number(t.amountOut||0)),0);
      const newBal=(Number(acc.initialBalance||0))+net;
      return {col:COLS.ACCOUNTS,docId:acc.id,data:{initialBalance:newBal,initialBalanceDate:(year+1)+'-01-01',currentBalance:newBal}};
    });
    if(accUpdates.length)await batchUpdateDocs(accUpdates);
    // 3. 배치 삭제: 원본 거래 제거 (500개씩 자동 분할)
    const trxDeletes=trxList.map(t=>({col:COLS.TRANSACTIONS,docId:t.id}));
    await batchDeleteDocs(trxDeletes);
    // 4. 아카이브 기록 추가 (1건, 배치 불필요)
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

// Phase 2 최적화: 배치 혼합 작업 사용
export async function saveBudget(){
  const clientId=document.getElementById('budget-client-sel')?.value;
  const year=Number(document.getElementById('budget-year-sel')?.value);
  if(!clientId||!year)return;
  showLoading(true);
  try{
    const{getDocs,collection,query,where}=fb();
    const db=fdb();
    const snap=await getDocs(query(collection(db,COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year)));
    // 배치 작업: 기존 삭제 + 새 추가
    const ops={
      deletes:snap.docs.map(d=>({col:COLS.BUDGETS,docId:d.id})),
      adds:[]
    };
    const inputs=document.querySelectorAll('.budget-amt');
    inputs.forEach(inp=>{
      const amount=Number(inp.value)||0;
      if(amount>0)ops.adds.push({col:COLS.BUDGETS,data:{clientId,year,category:inp.dataset.cat,amount}});
    });
    // 배치 혼합 작업 (delete + add)
    if(ops.deletes.length||ops.adds.length)await batchMixedOps(ops);
    toast('예산이 저장되었습니다.','success');
  }catch(e){toast('저장 오류: '+e.message,'error');}
  showLoading(false);
}

// ─────────────────────────────────────────────
// Firebase 초기화 (관리자 전용)
// ─────────────────────────────────────────────
export async function executeFirebaseReset(){
  if(!can('settings.reset')){toast('권한이 없습니다.','error');return;}
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

// ─────────────────────────────────────────────
// 권한 관리 패널 (관리자 전용)
// ─────────────────────────────────────────────
const PERM_SECTIONS=[
  {label:'📌 내비게이션',keys:['nav.report','nav.settings','nav.staff']},
  {label:'💳 거래내역',keys:['trx.view.all','trx.create','trx.edit','trx.delete','trx.delete.bulk','trx.reorder','trx.transfer','trx.category.edit','trx.csv']},
  {label:'📁 엑셀·증빙',keys:['excel.upload','receipt.upload','receipt.print','bankbook.upload']},
  {label:'📑 보고서',keys:['report.view.all','report.view.own','report.draft','report.edit','report.delete','report.recall','report.submit','report.approve.team','report.approve.center','report.reject']},
  {label:'⚙️ 설정',keys:['settings.staff','settings.client','settings.account','settings.fixed','settings.archive','settings.reset']},
];
const PERM_LABELS={
  'nav.report':'보고서 탭','nav.settings':'설정 탭','nav.staff':'직원관리 패널',
  'trx.view.all':'전체 거래 조회','trx.create':'수기 입력','trx.edit':'거래 수정',
  'trx.delete':'거래 삭제','trx.delete.bulk':'일괄 삭제','trx.reorder':'드래그 순서 변경',
  'trx.transfer':'자산이동 입력','trx.category.edit':'카테고리 인라인 수정','trx.csv':'CSV 내보내기',
  'excel.upload':'엑셀 업로드','receipt.upload':'영수증 업로드','receipt.print':'영수증 일괄 출력',
  'bankbook.upload':'통장 사진 업로드',
  'report.view.all':'전체 보고서 열람','report.view.own':'본인 담당 열람','report.draft':'초안 작성',
  'report.edit':'보고서 수정','report.delete':'보고서 삭제','report.recall':'보고서 회수',
  'report.submit':'보고서 제출','report.approve.team':'팀장 결재','report.approve.center':'센터장 결재','report.reject':'보고서 반려',
  'settings.staff':'직원 등록/수정/삭제','settings.client':'입주자 관리','settings.account':'계좌 관리',
  'settings.fixed':'고정항목 관리','settings.archive':'연도 마감','settings.reset':'전체 초기화',
};
const ROLES=['입력자','담당자','팀장','센터장','관리자'];

export function renderPermissionPanel(){
  const container=document.getElementById('permission-panel-content');
  if(!container)return;
  // 현재 저장된 권한 또는 기본값
  const perms=S.permissions||DEFAULT_PERMISSIONS;
  // 편집용 임시 복사본 (deep copy)
  const draft=JSON.parse(JSON.stringify(perms));
  // 역할 탭
  let activeRole=ROLES[1]; // 기본: 담당자
  function renderPanel(){
    container.innerHTML=`
      <div style="display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap;">
        ${ROLES.map(r=>`<button onclick="window._permSetRole('${escAttr(r)}')" style="padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;border:1.5px solid ${r===activeRole?'#7c3aed':'#e2e8f0'};background:${r===activeRole?'#f5f3ff':'#fff'};color:${r===activeRole?'#7c3aed':'#64748b'};cursor:pointer;">${r}</button>`).join('')}
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr>
            <th style="text-align:left;padding:8px 10px;background:#1e293b;color:#fff;font-size:11px;min-width:120px;">권한</th>
            <th style="padding:8px 10px;background:#1e293b;color:#fff;font-size:11px;min-width:60px;text-align:center;">허용</th>
          </tr></thead>
          <tbody>
            ${PERM_SECTIONS.map(sec=>`
              <tr><td colspan="2" style="background:#3b82f6;color:#fff;font-weight:700;padding:6px 10px;font-size:11px;">${sec.label}</td></tr>
              ${sec.keys.map(key=>{
                const val=draft[activeRole]?.[key]??DEFAULT_PERMISSIONS[activeRole]?.[key]??false;
                return `<tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:7px 10px;color:#475569;">${PERM_LABELS[key]||key}</td>
                  <td style="text-align:center;padding:7px 10px;">
                    <input type="checkbox" data-role="${activeRole}" data-key="${key}" ${val?'checked':''} style="width:15px;height:15px;cursor:pointer;accent-color:#7c3aed;">
                  </td>
                </tr>`;
              }).join('')}
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
        <button id="btn-perm-save" style="padding:9px 20px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">💾 저장</button>
        <button id="btn-perm-reset" style="padding:9px 20px;background:#fff;color:#64748b;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">↺ 기본값으로 초기화</button>
      </div>
    `;
    // 체크박스 이벤트
    container.querySelectorAll('input[type=checkbox]').forEach(cb=>{
      cb.addEventListener('change',()=>{
        const r=cb.dataset.role;
        const k=cb.dataset.key;
        if(!draft[r])draft[r]={};
        draft[r][k]=cb.checked;
      });
    });
    // 저장 버튼
    document.getElementById('btn-perm-save')?.addEventListener('click',async()=>{
      // draft에서 누락된 역할/키는 DEFAULT_PERMISSIONS로 채움
      const full={};
      ROLES.forEach(r=>{full[r]={};Object.keys(DEFAULT_PERMISSIONS[r]).forEach(k=>{full[r][k]=draft[r]?.[k]??DEFAULT_PERMISSIONS[r][k];});});
      try{
        await savePermissions(full);
        toast('권한이 저장되었습니다. 5초 후 페이지가 새로고침됩니다.','success');
        setTimeout(()=>location.reload(),5000);
      }catch(e){toast('저장 실패: '+e.message,'error');}
    });
    // 기본값 초기화 버튼
    document.getElementById('btn-perm-reset')?.addEventListener('click',()=>{
      const code=prompt('모든 역할 권한을 기본값으로 초기화합니다.\\n확인을 위해 "초기화"를 입력하세요:');
      if(code!=='초기화')return;
      ROLES.forEach(r=>Object.keys(DEFAULT_PERMISSIONS[r]).forEach(k=>{if(!draft[r])draft[r]={};draft[r][k]=DEFAULT_PERMISSIONS[r][k];}));
      renderPanel();
      toast('기본값으로 초기화되었습니다. 저장 버튼을 눌러 적용하세요.','info');
    });
  }
  window._permSetRole=(r)=>{activeRole=r;renderPanel();};
  renderPanel();
}

// ─────────────────────────────────────────────
// 탭 전환 함수
// ─────────────────────────────────────────────
export function initSettingsTabs(){
  document.querySelectorAll('.settings-tab-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
      const tab=e.target.dataset.tab;
      switchSettingsTab(tab);
    });
  });
  document.querySelectorAll('.category-subtab-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
      const subtab=e.target.dataset.subtab;
      switchCategorySubtab(subtab);
    });
  });
}

export function switchSettingsTab(tab){
  if(['archive','permissions'].includes(tab)&&!can('settings.reset')){
    alert('관리자만 접근 가능합니다.');
    return;
  }
  document.querySelectorAll('.settings-tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`)?.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById(`${tab}-tab-content`)?.classList.add('active');
}

export function switchCategorySubtab(subtab){
  document.querySelectorAll('.category-subtab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector(`[data-subtab="${subtab}"]`)?.classList.add('active');
  document.querySelectorAll('.subtab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById(`category-${subtab}-content`)?.classList.add('active');
}

// ─────────────────────────────────────────────
// 회원가입 승인 (inline onclick에서 호출)
// ─────────────────────────────────────────────
window.approveStaff = async (docId) => {
  const { doc, updateDoc } = fb();
  try {
    await updateDoc(doc(fdb(), COLS.USERS, docId), { approved: true });
    toast('승인 완료. 해당 직원이 로그인 가능합니다.', 'success');
    await fetchBaseData(); renderManagement();
  } catch(e) { toast('승인 오류: '+e.message, 'error'); }
};
