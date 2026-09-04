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
import { deleteManyFromStorage, recompressStorageImage } from '../services/storage.js';
import { COLS, DEFAULT_CATEGORIES } from '../constants.js';
// loadTransactions: settings.js에서 직접 호출 없음 — modals.js(Task 4)에서 사용
import { fetchBaseData, loadTransactions, refetchUsers, refetchClients, refetchAccounts, refetchCategories } from './core.js';
import { openModal, renderFixedItemsList } from './modals.js';
import { can, savePermissions, requiredRank, DEFAULT_MIN_RANK,
         SELECTABLE_RANKS, RANK_LABEL, PERM_SECTIONS } from './permissions.js';

// ─────────────────────────────────────────────
// 직원·입주자·계좌 관리 통합 렌더
// ─────────────────────────────────────────────
// ⚠️ 아래 함수들의 innerHTML에는 bare global 호출이 포함됨
// (openModal, toggleClientActive, toggleAccountActive 등)
// window 경유로 해석되므로 import된 심볼명으로 교체하면 런타임 오류 발생
export function renderManagement(){
  const isAdmin=can('nav.staff');
  updateSignupBadge();
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
        const d=document.createElement('div'); d.className='card'; d.style.cssText='padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px;background:#fffbeb;border-color:#fde68a;flex-wrap:wrap;';
        const roles=['입력자','담당자','팀장','센터장'];
        const roleOpts=roles.map(r=>`<option value="${r}"${(u.role||'입력자')===r?' selected':''}>${r}</option>`).join('');
        d.innerHTML=`<div><div style="font-weight:700;color:#92400e;">${escAttr(u.name||u.userId)}</div><div style="font-size:12px;color:#b45309;">${escAttr(u.userId||'')} ${u.team?'· '+escAttr(u.team):''}<span style="margin-left:6px;background:#fef3c7;border:1px solid #fde68a;border-radius:99px;padding:1px 7px;font-size:10px;color:#92400e;">승인 대기</span></div></div><div style="display:flex;gap:6px;align-items:center;"><select id="pending-role-${escAttr(u.id)}" class="input" title="승인할 역할(권한)을 선택하세요" style="width:auto;min-height:auto;height:32px;padding:4px 8px;font-size:12px;">${roleOpts}</select><button class="btn approve-staff-btn" style="font-size:12px;padding:5px 12px;min-height:32px;background:#10b981;border:none;">✓ 승인</button></div>`;
        // 인라인 onclick 대신 직접 바인딩 — 전역 함수 이름에 의존하지 않는다
        d.querySelector('.approve-staff-btn').addEventListener('click',()=>approveStaff(u.id));
        sl.appendChild(d);
      });
      const divider=document.createElement('div'); divider.style.cssText='height:1px;background:var(--border);margin:8px 0;'; sl.appendChild(divider);
    }
    // 승인된 직원 — 재직(활성)→퇴사(비활성) 순, 비활성 흐리게 + 재직/퇴사 토글
    const approvedUsers=S.users.filter(u=>u.approved!==false);
    const activeUsers=approvedUsers.filter(u=>u.active!==false);
    const inactiveUsers=approvedUsers.filter(u=>u.active===false);
    [...activeUsers,...inactiveUsers].forEach(u=>{
      const isActive=u.active!==false;
      const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:12px 14px;display:flex;justify-content:space-between;align-items:center;${!isActive?'opacity:0.6;background:#f8f9fa;':''}`;
      const toggleSwitch=`<div onclick="toggleStaffActive('${escAttr(u.id)}',${!isActive})" title="${isActive?'퇴사 등으로 비활성화(로그인 차단)':'다시 재직 상태로 전환'}" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
        <span style="display:inline-block;width:36px;height:20px;border-radius:10px;background:${isActive?'#10b981':'#cbd5e1'};transition:background 0.2s;position:relative;flex-shrink:0;">
          <span style="display:block;width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:${isActive?'18px':'2px'};transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></span>
        </span>
        <span style="font-size:10px;color:${isActive?'#10b981':'#94a3b8'};font-weight:700;min-width:28px;">${isActive?'재직':'퇴사'}</span>
      </div>`;
      d.innerHTML=`<div><div style="font-weight:700;color:${isActive?'var(--text)':'#94a3b8'};">${u.name||u.userId}</div><div style="font-size:12px;color:var(--muted);">${u.role||''} ${u.team?'· '+u.team:''}</div></div><div style="display:flex;gap:8px;align-items:center;">${toggleSwitch}<button class="icon-btn" onclick="openModal('staff',S.users.find(x=>x.id==='${escAttr(u.id)}'))" style="color:#64748b;">✏️</button></div>`;
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
    await refetchClients(); renderManagement();
  }catch(e){ toast('저장 오류: '+e.message,'error'); }
}
export async function toggleAccountActive(id,makeActive){
  try{
    const{doc,updateDoc}=fb();
    await updateDoc(doc(fdb(),COLS.ACCOUNTS,id),{active:makeActive});
    toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
    await refetchAccounts(); renderManagement();
  }catch(e){ toast('저장 오류: '+e.message,'error'); }
}
// 직원 재직/퇴사(비활성) 토글 — 비활성 시 로그인 차단, 데이터·결재 이력은 보존
export async function toggleStaffActive(id,makeActive){
  // 본인 계정 비활성화 방지 (셀프 잠금 방지)
  const self=S.users.find(u=>String(u.userId)===String(S.user?.userId));
  if(!makeActive&&self&&String(self.id)===String(id)){toast('본인 계정은 비활성화할 수 없습니다.','error');return;}
  try{
    // users 쓰기는 보안 규칙이 막는다. 서버가 등급을 확인하고,
    // 마지막 관리자를 비활성화해 영구 잠금되는 것도 막아 준다.
    await window._fbFn.call('setStaffActive')({ userId:id, active:makeActive });
    // 비활성화 대상이 어느 입주자의 팀장이면 안내 (결재 공백 방지)
    if(!makeActive){
      const asLeader=(S.allClients||S.clients).filter(c=>String(c.teamLeader)===String(id));
      if(asLeader.length)toast(`이 직원은 입주자 ${asLeader.length}명의 팀장입니다. 팀장을 재지정하거나, 공석 시 센터장이 팀장 결재를 대행할 수 있어요.`,'info',5000);
    }
    toast(makeActive?'재직 상태로 전환했습니다.':'퇴사(비활성) 처리했습니다. 해당 계정은 로그인할 수 없습니다.','success');
    await refetchUsers(); renderManagement();
  }catch(e){ toast('저장 오류: '+e.message,'error'); }
}

export function confirmDelete(type,id){
  const labels={client:'입주자',account:'계좌',staff:'직원'};
  const refetchByType={client:refetchClients,account:refetchAccounts,staff:refetchUsers};
  showConfirm(labels[type]+' 삭제',labels[type]+'를 삭제하시겠습니까?',async()=>{
    const{doc,deleteDoc}=fb();
    const cols={client:COLS.CLIENTS,account:COLS.ACCOUNTS,staff:COLS.USERS};
    await deleteDoc(doc(fdb(),cols[type],id));
    await (refetchByType[type]||fetchBaseData)();
    renderManagement();
    toast('삭제됨','success');
  },'삭제','btn btn-danger');
}

// ─────────────────────────────────────────────
// 설정 화면
// ─────────────────────────────────────────────
export async function loadSettings(){
  const isArchive=can('settings.archive');
  const isResetAdmin=can('settings.reset');          // 전체 초기화
  const canPerm=can('settings.permissions');        // 권한 설정 탭
  // 권한 없는 탭 버튼은 아예 숨김 (누르면 alert만 뜨는 '유령 탭' 제거)
  const archiveTabBtn=document.querySelector('.settings-tab-btn[data-tab="archive"]');
  if(archiveTabBtn)archiveTabBtn.style.display=isArchive?'':'none';
  const permTabBtn=document.querySelector('.settings-tab-btn[data-tab="permissions"]');
  if(permTabBtn)permTabBtn.style.display=canPerm?'':'none';
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
  // 이미 패널이 렌더링된 경우 재호출 금지 (편집 중 draft 초기화 방지)
  if(canPerm&&!document.getElementById('btn-perm-save'))renderPermissionPanel();
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
  const isAdmin=can('settings.category.common');
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
  const isAdmin=can('settings.category.common');
  const allCats=S.categories
    .filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===settingsClientId))
    .sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  const colors=type==='지출'?['#dc2626','#ea580c','#d97706','#16a34a','#2563eb','#9333ea','#c026d3']:['#059669','#0891b2','#1d4ed8'];
  const targetLabel=settingsClientId?clientName:'공통';
  const badgeId=type==='지출'?'exp-cat-target':'inc-cat-target';
  const badge=document.getElementById(badgeId); if(badge)badge.textContent=targetLabel;
  el.innerHTML='<p style="font-size:11px;color:var(--muted);margin-bottom:8px;width:100%;">⠿ 드래그로 순서 변경 | 자주 쓰는 카테고리를 앞으로</p>';
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
    if(cat!=='확인필요'&&!isCommonReadOnly)tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제',`"${cat}" 카테고리를 삭제하시겠습니까?`,()=>deleteCategory(type,cat,catDoc.clientId||''),'삭제','btn btn-danger'));
    el.appendChild(tag);
  });
}
export function renderRuleTags(){
  const el=document.getElementById('rule-tags'); if(!el)return;
  const settingsClientId=S.settings.settingsClientId||'';
  const clientName=settingsClientId?S.clients.find(c=>c.id===settingsClientId)?.name||'':'';
  const targetDisplay=settingsClientId?`— ${clientName}`:'— 공통';
  const ruleTargetLabel=settingsClientId?clientName:'공통';
  const ruleBadge=document.getElementById('rule-target'); if(ruleBadge)ruleBadge.textContent=ruleTargetLabel;
  el.innerHTML='';
  if(!S.settings.rules.length){el.innerHTML='<div class="empty-state" style="padding:20px;"><div class="icon">🏷️</div>등록된 규칙 없음</div>';return;}
  const settingsClientName=S.settings.settingsClientId?S.clients.find(c=>c.id===S.settings.settingsClientId)?.name||'':'';
  S.settings.rules.forEach(r=>{
    const tc=r.type==='지출'?'#dc2626':'#16a34a', tag=document.createElement('span');
    const isPersonal=!!r.clientId;
    tag.className='rule-tag'; tag.style.borderColor=tc+'33';
    tag.innerHTML=`<span style="font-size:13px;font-weight:700;color:var(--sub);">"${r.keyword}"</span><span style="font-size:11px;color:var(--muted);">→</span><span style="font-size:13px;font-weight:700;color:${tc};">${r.category}</span>`
      +(isPersonal?`<span style="font-size:10px;background:${tc}22;color:${tc};padding:1px 5px;border-radius:4px;">${settingsClientName||r.clientId}</span>`:'')
      +`<button class="cat-del">×</button>`;
    tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제',`"${r.keyword}" 규칙을 삭제하시겠습니까?`,()=>deleteRule(r.id||r.keyword),'삭제','btn btn-danger'));
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
  if(!clientId&&!can('settings.category.common')){
    toast('공통 카테고리는 팀장 이상만 추가할 수 있습니다.','error');
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
  await refetchCategories(); loadSettings();
  toast(`"${name}" 추가됨`,'success');
}
export async function deleteCategory(type,name,clientId=''){
  if(!clientId&&!can('settings.category.common')){
    toast('공통 카테고리는 팀장 이상만 삭제할 수 있습니다.','error');
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
  await refetchCategories(); loadSettings(); toast(`"${name}" 삭제됨`,'success');
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
  await refetchCategories(); loadSettings(); toast(`"${kw}" 규칙 추가됨`,'success');
}
export async function deleteRule(docId){
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),COLS.CATEGORIES,docId));
  await refetchCategories(); loadSettings(); toast('규칙 삭제됨','success');
}
// Phase 2 최적화: 배치 삭제 + 배치 추가
export async function resetCategories(){
  // 전 입주자의 카테고리와 자동분류 규칙을 모두 지우는 작업인데 검사가 없었다.
  // 설정 탭은 담당자도 들어오므로 버튼 하나로 조직 전체 분류가 날아갔다.
  if(!can('settings.category.common')){toast('공통 카테고리 초기화는 팀장 이상만 할 수 있습니다.','error');return;}
  showConfirm('기본값 초기화','기존 카테고리와 규칙을 모두 삭제하고 기본값으로 초기화합니다.',async()=>{
    const{getDocs,collection}=fb();
    const snap=await getDocs(collection(fdb(),COLS.CATEGORIES));
    // 배치 삭제
    const toDelete=snap.docs.map(d=>({col:COLS.CATEGORIES,docId:d.id}));
    if(toDelete.length)await batchDeleteDocs(toDelete);
    // 기본값 — 초기 설정 마법사(setup.js)와 같은 목록을 쓴다 (constants.js)
    const toAdd=DEFAULT_CATEGORIES.map(d=>({col:COLS.CATEGORIES,data:{...d}}));
    if(toAdd.length)await batchAddDocs(toAdd);
    await refetchCategories(); loadSettings(); toast('기본값으로 초기화됨','success');
  },'초기화','btn btn-danger');
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
  showConfirm(`${year}년 데이터 마감`,`${year}년 거래 데이터를 보관하고 계좌 기초잔액을 업데이트합니다.\n영수증·통장사진은 삭제하지 않고 저해상도로 압축 보관됩니다.\n이 작업은 되돌릴 수 없습니다.`,()=>executeArchive(year),'마감 실행','btn btn-danger');
}
// Phase 3 최적화: 배치 처리 + 500개 단위 자동 분할
export async function executeArchive(year){
  // 탭 버튼만 숨겨져 있었고 window.executeArchive는 노출되어 있었다
  if(!can('settings.archive')){toast('연도 마감 권한이 없습니다.','error');return;}
  showLoading(true);
  try{
    const{getDocs,collection,query,where,addDoc,doc}=fb();
    const db=fdb();
    const snap=await getDocs(query(collection(db,COLS.TRANSACTIONS),where('date','>=',year+'-01-01'),where('date','<=',year+'-12-31')));
    const trxList=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!trxList.length){showLoading(false);toast(`${year}년 거래 데이터가 없습니다.`,'error');return;}
    // 0. 아카이브 보관용 이미지 저해상도 재압축 — 삭제하지 않고 Storage 공간만 확보 (best-effort)
    //    (재압축을 위해 이미지를 다시 읽으므로 버킷 CORS 설정 필요. 실패해도 마감은 진행)
    let recompressed=0;
    toast('보관용 이미지 압축 중...','info',3000);
    for(const t of trxList){
      if(t.receiptUrl){const nu=await recompressStorageImage(t.receiptUrl);if(nu){t.receiptUrl=nu;recompressed++;}}
    }
    const yr=String(year);
    const bankUpdateMap={}; // accId → 재압축 반영된 bankStatements
    for(const acc of S.accounts){
      const stmts=acc.bankStatements||[]; let changed=false; const newStmts=[];
      for(const s of stmts){
        const item=typeof s==='string'?{url:s,month:''}:{...s};
        if(item.url&&(item.month||'').startsWith(yr)){const nu=await recompressStorageImage(item.url);if(nu){item.url=nu;changed=true;recompressed++;}}
        newStmts.push(item);
      }
      if(changed)bankUpdateMap[acc.id]=newStmts;
    }
    // 1. 배치 추가: archive_YYYY 테이블에 거래 복제 (재압축된 receiptUrl 반영, 500개씩 자동 분할)
    const archiveData=trxList.map(t=>({col:'archive_'+year,data:t}));
    await batchAddDocs(archiveData);
    // 2. 배치 업데이트: 계좌 기초잔액 + (재압축된) 통장사진 URL (500개 제한 자동 처리)
    const accUpdates=S.accounts.map(acc=>{
      const net=trxList.filter(t=>t.accountId===acc.id&&t.type!=='취소').reduce((s,t)=>s+(Number(t.amountIn||0)-Number(t.amountOut||0)),0);
      const newBal=(Number(acc.initialBalance||0))+net;
      const data={initialBalance:newBal,initialBalanceDate:(year+1)+'-01-01',currentBalance:newBal};
      if(bankUpdateMap[acc.id])data.bankStatements=bankUpdateMap[acc.id];
      return {col:COLS.ACCOUNTS,docId:acc.id,data};
    });
    if(accUpdates.length)await batchUpdateDocs(accUpdates);
    // 3. 배치 삭제: 원본 거래만 제거 (Storage 파일은 보관, 500개씩 자동 분할)
    const trxDeletes=trxList.map(t=>({col:COLS.TRANSACTIONS,docId:t.id}));
    await batchDeleteDocs(trxDeletes);
    // 4. 아카이브 기록 추가 (1건, 배치 불필요)
    await addDoc(collection(db,COLS.CONFIG),{type:'archive',year,archivedAt:new Date().toISOString(),count:trxList.length});
    await fetchBaseData(); loadSettings();
    toast(`${year}년 마감 완료! ${trxList.length}건 보관, 이미지 ${recompressed}건 압축.`,'success',5000);
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
  if(!can('settings.budget')){toast('예산 설정 권한이 없습니다.','error');return;}
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
      const storageUrls=[]; // Storage 고아 파일 방지: 삭제 전 파일 URL 수집
      for(const col of cols){
        const snap=await getDocs(collection(db,col));
        for(const d of snap.docs){
          const data=d.data();
          if(col===COLS.TRANSACTIONS&&data.receiptUrl)storageUrls.push(data.receiptUrl);
          else if(col===COLS.ACCOUNTS)(data.bankStatements||[]).forEach(s=>{if(s&&typeof s==='object'){if(s.url)storageUrls.push(s.url);if(s.thumbUrl)storageUrls.push(s.thumbUrl);}else if(typeof s==='string')storageUrls.push(s);});
          else if(col===COLS.EXCEL_UPLOADS&&data.url)storageUrls.push(data.url); // 구형 데이터 호환
          await deleteDoc(doc(db,col,d.id));
        }
      }
      // Firestore 삭제 후 Storage 파일도 전량 삭제(best-effort)
      await deleteManyFromStorage(storageUrls);
      await fetchBaseData();
      loadSettings();
      toast(`초기화 완료. 모든 데이터가 삭제되었습니다. (첨부 파일 ${storageUrls.length}건 정리)`,'success',5000);
    }catch(e){toast('초기화 오류: '+e.message,'error');}
    showLoading(false);
  },'초기화 실행','btn btn-danger');
}

// ─────────────────────────────────────────────
// 권한 관리 패널 (관리자 전용)
// ─────────────────────────────────────────────
export function renderPermissionPanel(){
  const container=document.getElementById('permission-panel-content');
  if(!container)return;

  // 편집용 초안 — 현재 유효 등급으로 시작한다
  const draft={};
  PERM_SECTIONS.forEach(sec=>Object.keys(sec.keys).forEach(k=>{draft[k]=requiredRank(k);}));

  const rankOpts=(cur)=>SELECTABLE_RANKS
    .map(r=>`<option value="${r}"${Number(cur)===r?' selected':''}>${escAttr(RANK_LABEL[r])}</option>`)
    .join('');

  function renderPanel(){
    const changed=Object.entries(draft).filter(([k,v])=>Number(v)!==DEFAULT_MIN_RANK[k]).length;
    container.innerHTML=`
      <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px;color:#5b21b6;line-height:1.6;">
        각 기능을 <b>어느 등급부터</b> 쓸 수 있는지 정합니다.
        등급은 <b>입력자 &lt; 담당자 &lt; 팀장 &lt; 센터장</b> 순이고,
        관리자 권한은 역할이 아니라 직원 등록 화면의 체크박스로 부여합니다.
        ${changed?`<div style="margin-top:6px;font-weight:700;">기본값과 다른 항목 ${changed}개</div>`:''}
      </div>
      <div style="overflow-x:auto;">
        ${PERM_SECTIONS.map(sec=>`
          <div style="font-weight:800;color:#fff;background:#3b82f6;padding:7px 12px;border-radius:8px 8px 0 0;font-size:12px;">${escAttr(sec.title)}</div>
          <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;margin-bottom:14px;">
            ${Object.entries(sec.keys).map(([key,label])=>{
              const isDefault=Number(draft[key])===DEFAULT_MIN_RANK[key];
              return `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 12px;border-bottom:1px solid #f1f5f9;">
                <span style="font-size:13px;color:var(--text);">${escAttr(label)}${isDefault?'':'<span style="margin-left:6px;font-size:10px;font-weight:700;color:#7c3aed;">변경됨</span>'}</span>
                <select class="perm-rank input" data-key="${escAttr(key)}" style="width:auto;min-height:auto;height:32px;padding:4px 8px;font-size:12px;flex-shrink:0;">${rankOpts(draft[key])}</select>
              </div>`;
            }).join('')}
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <button id="btn-perm-save" class="btn" style="padding:9px 20px;font-size:13px;">💾 저장</button>
        <button id="btn-perm-reset" style="padding:9px 20px;background:#fff;color:#64748b;border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">↺ 기본값으로</button>
      </div>`;

    container.querySelectorAll('.perm-rank').forEach(sel=>{
      sel.addEventListener('change',()=>{
        draft[sel.dataset.key]=Number(sel.value);
        renderPanel();   // '변경됨' 표시와 개수를 갱신
      });
    });

    document.getElementById('btn-perm-save')?.addEventListener('click',async()=>{
      try{
        await savePermissions(draft);
        toast('권한이 저장되었습니다. 새로고침 후 적용됩니다.','success',5000);
        setTimeout(()=>location.reload(),2000);
      }catch(e){toast('저장 실패: '+(e.message||'다시 시도하세요.'),'error');}
    });

    document.getElementById('btn-perm-reset')?.addEventListener('click',()=>{
      showConfirm('기본값으로','모든 기능의 최소 등급을 기본값으로 되돌립니다. 저장을 눌러야 반영됩니다.',()=>{
        Object.keys(draft).forEach(k=>{draft[k]=DEFAULT_MIN_RANK[k];});
        renderPanel();
        toast('기본값으로 되돌렸습니다. 저장을 눌러 적용하세요.','info');
      },'되돌리기');
    });
  }
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
  // 마감은 settings.archive(센터장·관리자), 권한 관리는 settings.reset(관리자)로 각각 게이트
  if(tab==='archive'&&!can('settings.archive')){
    alert('데이터 마감은 센터장·관리자만 사용할 수 있습니다.');
    return;
  }
  if(tab==='permissions'&&!can('settings.permissions')){
    alert('권한 관리는 관리자만 사용할 수 있습니다.');
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
// 회원가입 승인
// ─────────────────────────────────────────────
export async function approveStaff(userId) {
  const sel = document.getElementById('pending-role-' + userId);
  const role = sel?.value || '입력자';
  try {
    // users 쓰기는 보안 규칙이 막는다. 서버가 호출자 등급을 확인하고 처리한다
    // (예전에는 팀장이 신규 가입자를 센터장으로 승인할 수 있었다).
    await window._fbFn.call('approveStaff')({ userId, role, isAdmin: false });
    toast(`승인 완료 — ${role} 권한으로 로그인할 수 있습니다.`, 'success');
    await refetchUsers(); renderManagement(); updateSignupBadge();
  } catch(e) { toast('승인 오류: '+(e.message||'다시 시도하세요.'), 'error'); }
}

// 설정 네비게이션의 회원가입 승인 대기 뱃지 갱신 (관리 권한자에게만 표시)
export function updateSignupBadge(){
  const badge=document.getElementById('nav-settings-badge');
  if(!badge)return;
  const n=(can('nav.staff')&&Array.isArray(S.users))?S.users.filter(u=>u.approved===false).length:0;
  if(n>0){badge.textContent=n;badge.style.display='inline';}else badge.style.display='none';
}
