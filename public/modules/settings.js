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
import { iconSvg } from '../utils/icons.js';
import { toast, showConfirm, showLoading, escAttr, escHtml } from '../utils/ui.js';
import { fb, fdb, batchUpdateDocs, batchDeleteDocs, batchAddDocs, batchMixedOps } from '../services/firestore.js';
import { deleteManyFromStorage } from '../services/storage.js';
import { COLS, DEFAULT_CATEGORIES, cs } from '../constants.js';
import { formatDate } from '../domain/timestamps.js';
const SYSTEM_OPS = COLS.SYSTEM_OPS;
// loadTransactions: settings.js에서 직접 호출 없음 — modals.js(Task 4)에서 사용
import { fetchBaseData, refetchUsers, refetchClients, refetchAccounts, refetchCategories } from './core.js';
import { openModal, renderFixedItemsList } from './modals.js';
import { initSettingsShell, switchSettingsTab, registerPanel } from './settings-shell.js';
import { registerCrudDeps } from './settings-crud.js';
import { renderSettingsOverview, refreshOverviewBadges } from './settings-overview.js';
import { renderSettingsAudit } from './settings-audit.js';
import { renderTeamsPanel } from './settings-teams.js';
import { auditLog } from '../services/audit.js';
import {
  DATA_RESET_CONFIRM_TEXT, RESET_PRESERVED, MAX_DELETES_PER_BATCH,
  RESET_OPERATION_ID, isResetLockActive, remainingCollections,
  resetProgressPercent, resetProgressLabel, isResetConfirmed,
} from '../domain/data-reset.js';
import { can, unavailableMessage } from './permissions.js';
// 권한 패널은 settings-permissions.js 로 나갔다. 여기서 다시 내보내는 이유는
// app.js 의 전역 등록과 설정 탭 전환이 이 모듈을 통해 부르기 때문이다.
import { renderPermissionPanel } from './settings-permissions.js';
import { openCategoryEdit } from './settings-category.js';
import { resetStaffPassword } from './password.js';
export { renderPermissionPanel };

// ─────────────────────────────────────────────
// 직원·입주자·계좌 관리 통합 렌더
// ─────────────────────────────────────────────
// ⚠️ 아래 함수들의 innerHTML에는 bare global 호출이 포함됨
// (openModal, toggleClientActive, toggleAccountActive 등)
// window 경유로 해석되므로 import된 심볼명으로 교체하면 런타임 오류 발생
export function renderManagement(){
  const canViewStaff=can('nav.staff');
  const canManageStaff=can('settings.staff');
  const canApproveStaffRole=can('staff.role.approve');
  const canManageAssignments=can('assignments.manage');
  const canManageClients=can('settings.client');
  const canManageAccounts=can('settings.account');
  const canViewAllClients=can('client.view.all');
  updateSignupBadge();
  // B005: admin-staff 섹션 및 등록 버튼 역할별 표시/숨김
  const adminStaff=document.getElementById('admin-staff');
  if(adminStaff)adminStaff.style.display=canViewStaff?'block':'none';
  const btnAddClient=document.getElementById('btn-add-client');
  const btnAddAccount=document.getElementById('btn-add-account');
  if(btnAddClient)btnAddClient.style.display=canManageClients?'':'none';
  if(btnAddAccount)btnAddAccount.style.display=canManageAccounts?'':'none';
  // 일괄 등록 버튼 표시 및 이벤트 바인딩 (관리자 전용)
  ['bulk-staff','bulk-client','bulk-account'].forEach(key=>{
    const btn=document.getElementById('btn-'+key);
    if(btn){
      const allowed={
        'bulk-staff':canManageStaff,'bulk-client':canManageClients,'bulk-account':canManageAccounts,
      }[key];
      btn.style.display=allowed?'':'none';
      if(!btn.dataset.bound){
        btn.dataset.bound='1';
        btn.addEventListener('click',()=>openModal(key));
      }
    }
  });
  const sl=document.getElementById('staff-list'); if(sl)sl.innerHTML='';
  if(canViewStaff&&sl){
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
        const requestControls=canManageStaff?`<div style="display:flex;gap:6px;align-items:center;"><select id="pending-role-${escAttr(u.id)}" class="input" title="요청할 역할을 선택하세요" style="width:auto;min-height:auto;height:32px;padding:4px 8px;font-size:12px;">${roleOpts}</select><button class="btn approve-staff-btn" style="font-size:12px;padding:5px 12px;min-height:32px;background:#10b981;border:none;">변경 요청</button></div>`:'<span style="font-size:12px;color:var(--muted);">시스템 관리자 요청 대기</span>';
        d.innerHTML=`<div><div style="font-weight:700;color:#92400e;">${escAttr(u.name||u.userId)}</div><div style="font-size:12px;color:#b45309;">${escAttr(u.userId||'')} ${u.team?'· '+escAttr(u.team):''}<span style="margin-left:6px;background:#fef3c7;border:1px solid #fde68a;border-radius:99px;padding:1px 7px;font-size:10px;color:#92400e;">승인 대기</span></div></div>${requestControls}`;
        d.querySelector('.approve-staff-btn')?.addEventListener('click',()=>approveStaff(u.id));
        sl.appendChild(d);
      });
      const divider=document.createElement('div'); divider.style.cssText='height:1px;background:var(--border);margin:8px 0;'; sl.appendChild(divider);
    }
    const privilegeChanges=S.users.filter(u=>u.privilegeChange&&['pending','approved'].includes(u.privilegeChange.state));
    if(privilegeChanges.length){
      const header=document.createElement('div');
      header.className='card';
      header.textContent=`역할·관리자 변경 대기 ${privilegeChanges.length}건`;
      sl.appendChild(header);
      privilegeChanges.forEach(u=>{
        const change=u.privilegeChange;
        const d=document.createElement('div'); d.className='card';
        const stateLabel=change.state==='approved'?'센터장 승인 완료 · 실행 대기':'센터장 승인 대기';
        const canAct=change.state==='approved'?canManageStaff:canApproveStaffRole;
        const controls=canAct?`<div><button class="btn privilege-change-btn">${change.state==='approved'?'변경 실행':'변경 승인'}</button><button class="btn privilege-cancel-btn">취소</button></div>`:'<span style="font-size:12px;color:var(--muted);">다른 권한 담당자 처리 대기</span>';
        d.innerHTML=`<div><strong>${escHtml(u.name||u.userId)}</strong><div style="font-size:12px;color:var(--muted);">${escHtml(u.role||'미승인')} → ${escHtml(change.role)}${change.isAdmin?' + 시스템 관리자':''} · ${stateLabel}</div></div>${controls}`;
        d.querySelector('.privilege-change-btn')?.addEventListener('click',()=>approveStaff(u.id,change));
        d.querySelector('.privilege-cancel-btn')?.addEventListener('click',()=>cancelStaffPrivilegeChange(u.id));
        sl.appendChild(d);
      });
    }
    // 승인된 직원 — 재직(활성)→퇴사(비활성) 순, 비활성 흐리게 + 재직/퇴사 토글
    const approvedUsers=S.users.filter(u=>u.approved!==false);
    const activeUsers=approvedUsers.filter(u=>u.active!==false);
    const inactiveUsers=approvedUsers.filter(u=>u.active===false);
    [...activeUsers,...inactiveUsers].forEach(u=>{
      const isActive=u.active!==false;
      const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:12px 14px;display:flex;justify-content:space-between;align-items:center;${!isActive?'opacity:0.6;background:#f8f9fa;':''}`;
      const toggleSwitch=canManageStaff?`<div onclick="toggleStaffActive('${escAttr(u.id)}',${!isActive})" title="${isActive?'퇴사 등으로 비활성화(로그인 차단)':'다시 재직 상태로 전환'}" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
        <span style="display:inline-block;width:36px;height:20px;border-radius:10px;background:${isActive?'#10b981':'#cbd5e1'};transition:background 0.2s;position:relative;flex-shrink:0;">
          <span style="display:block;width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:${isActive?'18px':'2px'};transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></span>
        </span>
        <span style="font-size:10px;color:${isActive?'#10b981':'#94a3b8'};font-weight:700;min-width:28px;">${isActive?'재직':'퇴사'}</span>
      </div>`:'';
      const editButton=canManageStaff&&isActive?`<button class="icon-btn" onclick="openModal('staff',S.users.find(x=>x.id==='${escAttr(u.id)}'))" style="color:#64748b;">✏️</button>`:'';
      // 비밀번호 재설정 — 관리자만. 결재에 닿는 계정은 서버가 2인을 요구한다.
      const pwButton=canManageStaff&&isActive&&String(u.id)!==String(S.user?.userId||'')
        ?`<button class="icon-btn pw-reset" data-id="${escAttr(u.id)}" data-name="${escAttr(u.name||u.userId)}" title="비밀번호 재설정(임시 비밀번호 발급)" style="color:#b45309;">${iconSvg('key')}</button>`:'';
      d.innerHTML=`<div><div style="font-weight:700;color:${isActive?'var(--text)':'#94a3b8'};">${escHtml(u.name||u.userId)}</div><div style="font-size:12px;color:var(--muted);">${escHtml(u.role||'')} ${u.team?'· '+escHtml(u.team):''}</div></div><div style="display:flex;gap:8px;align-items:center;">${toggleSwitch}${pwButton}${editButton}</div>`;
      d.querySelector('.pw-reset')?.addEventListener('click',ev=>{
        const b=ev.currentTarget;
        resetStaffPassword(b.dataset.id,b.dataset.name);
      });
      sl.appendChild(d);
    });
  }

  // 관리자: 전체 목록 / 비관리자: 담당 입주자만 (비활성 포함) — 입주자·계좌 공통 기준
  const myUserId=String(S.user?.userId||'');
  const visibleClients=(S.allClients?.length?S.allClients:S.clients).filter(c=>
    canViewAllClients||(()=>{
      const ids=String(c.userIds||'').split(',').map(s=>s.trim());
      const myDocId=String(S.users.find(u=>String(u.userId)===myUserId)?.id||'');
      if(String(S.authz?.role||S.user?.role||'')==='팀장'){
        return String(c.teamLeader||'')===myUserId||(myDocId&&String(c.teamLeader||'')===myDocId);
      }
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
      const toggleSwitch=canManageClients?`<div onclick="toggleClientActive('${escAttr(c.id)}',${!isActive})" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
        <span style="display:inline-block;width:36px;height:20px;border-radius:10px;background:${isActive?'#10b981':'#cbd5e1'};transition:background 0.2s;position:relative;flex-shrink:0;">
          <span style="display:block;width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:${isActive?'18px':'2px'};transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></span>
        </span>
        <span style="font-size:10px;color:${isActive?'#10b981':'#94a3b8'};font-weight:700;min-width:28px;">${isActive?'활성':'비활성'}</span>
      </div>`:'';
      const editButton=(canManageClients||canManageAssignments)?`<button class="icon-btn" onclick="openModal('client',(S.allClients||S.clients).find(x=>x.id==='${escAttr(c.id)}'))" style="color:#64748b;">✏️</button>`:'';
      d.innerHTML=`<div><div style="font-weight:700;color:${isActive?'var(--text)':'#94a3b8'};">${c.name}</div><div style="font-size:11px;color:var(--muted);">${leader?'팀장: '+leader.name:''}</div></div><div style="display:flex;gap:8px;align-items:center;">${toggleSwitch}${editButton}</div>`;
      cl.appendChild(d);
    });
  }

  // 계좌 목록: 담당 입주자의 계좌만 (비활성 포함), 활성→비활성 순 배치
  const al=document.getElementById('account-list'); if(al)al.innerHTML='';
  if(al){
    const allA=(S.allAccounts?.length?S.allAccounts:S.accounts).filter(a=>
      canViewAllClients||visibleClientIds.has(a.clientId)
    );
    const active=allA.filter(a=>a.active!==false);
    const inactive=allA.filter(a=>a.active===false);
    [...active,...inactive].forEach(a=>{
      const isActive=a.active!==false;
      const client=(S.allClients||S.clients).find(c=>c.id===a.clientId);
      const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:10px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;${!isActive?'opacity:0.6;background:#f8f9fa;':''}`;
      const toggleSwitch=canManageAccounts?`<div onclick="toggleAccountActive('${escAttr(a.id)}',${!isActive})" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
        <span style="display:inline-block;width:36px;height:20px;border-radius:10px;background:${isActive?'#10b981':'#cbd5e1'};transition:background 0.2s;position:relative;flex-shrink:0;">
          <span style="display:block;width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:${isActive?'18px':'2px'};transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></span>
        </span>
        <span style="font-size:10px;color:${isActive?'#10b981':'#94a3b8'};font-weight:700;min-width:28px;">${isActive?'활성':'비활성'}</span>
      </div>`:'';
      const editButton=canManageAccounts?`<button class="icon-btn" onclick="openModal('account',(S.allAccounts||S.accounts).find(x=>x.id==='${escAttr(a.id)}'))" style="color:#64748b;">✏️</button>`:'';
      d.innerHTML=`<div><div style="font-weight:700;color:${isActive?'var(--text)':'#94a3b8'};">${a.label}</div><div style="font-size:11px;color:var(--muted);">${client?.name||''}</div><div style="font-size:12px;font-weight:700;color:${isActive?'var(--blue)':'#94a3b8'};">${Number(a.currentBalance||0).toLocaleString()}원</div></div><div style="display:flex;gap:8px;align-items:center;">${toggleSwitch}${editButton}</div>`;
      al.appendChild(d);
    });
  }
}

// 별칭 (HTML inline 이벤트에서 참조)
export const renderUserManagement    = renderManagement;
export const renderClientManagement  = renderManagement;
export const renderAccountManagement = renderManagement;

// 변경(활성 전환·삭제)은 settings-crud.js에 있다 — 서버 콜러블로 옮기면서
// 유형별 분기가 늘었고, 이 파일은 이미 쪼갤 대상이었다.
// app.js의 전역 등록이 Settings 경유이므로 여기서 다시 내보낸다.
export {
  toggleClientActive, toggleAccountActive, toggleStaffActive, confirmDelete,
} from './settings-crud.js';

// ─────────────────────────────────────────────
// 설정 화면
// ─────────────────────────────────────────────
export async function loadSettings(){
  const isArchive=can('settings.archive');
  const isResetAdmin=can('settings.reset');          // 전체 초기화
  // 권한별 탭 노출은 settings-shell이 SETTINGS_TABS의 perm으로 판정한다
  // (화면에서 안 보이는 것과 눌러도 안 되는 것이 같은 근거를 쓴다).
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
  S.settings={...S.settings,expCats,incCats,rules,settingsClientId};
  // 입주자 목록이 늦게 도착해도 대상자 선택이 따라가게 한다.
  renderCategoryTarget();
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
  // 권한 패널은 셸이 그 탭을 열 때 그린다(registerPanel).
  initBudgetSection();
  // 탭 초기화
  renderCategoryTarget();
  initSettingsTabs();
}

// ─────────────────────────────────────────────
// 카테고리 관리
// ─────────────────────────────────────────────
/**
 * 「카테고리 관리 대상」 선택.
 *
 * 두 가지를 지킨다.
 *   · 다시 그려도 **고르던 대상자를 잃지 않는다.** 예전에는 innerHTML 로
 *     select 를 통째로 새로 만들면서 선택값을 복원하지 않아, 다시 그릴 때마다
 *     「공통」으로 돌아갔다 — 고르는 것이 안 먹는 것처럼 보였다.
 *     (바로 아래 고정항목 선택은 처음부터 prevFixed 로 복원하고 있었다.)
 *   · 입주자 목록이 **나중에 도착해도** 따라간다. loadSettings 가 이 함수를
 *     부르므로, 데이터가 늦게 오는 경우에도 목록이 비어 있는 채로 굳지 않는다.
 */
export function renderCategoryTarget(){
  const el=document.getElementById('category-target-content');
  if(!el)return;
  const isAdmin=can('settings.category.common');
  const cSel=document.getElementById('settings-client-sel');
  const clientId=cSel?.value||S.settings?.settingsClientId||'';
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
  if(!newSel)return;
  // 고르던 대상자를 되돌려 놓는다. 담당에서 빠진 입주자면 공통으로 떨어진다.
  if(clientId&&S.clients.some(c=>c.id===clientId))newSel.value=clientId;
  if(!newSel.dataset.bound){
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
  const targetLabel=settingsClientId?clientName:'공통';
  const badgeId=type==='지출'?'exp-cat-target':'inc-cat-target';
  const badge=document.getElementById(badgeId); if(badge)badge.textContent=targetLabel;
  el.innerHTML='<p style="font-size:11px;color:var(--muted);margin-bottom:8px;width:100%;">⠿ 드래그로 순서 변경 | 자주 쓰는 카테고리를 앞으로</p>';
  let dragSrc=null;
  const seen=new Set();
  allCats.forEach((catDoc,i)=>{
    const cat=catDoc.category; if(seen.has(cat+(catDoc.clientId||'')))return; seen.add(cat+(catDoc.clientId||''));
    // 거래내역·보고서와 **같은 색**이어야 한다. 예전에는 여기만 팔레트에서
    // 순서대로 배정해서, 설정에서 본 색과 표에서 본 색이 서로 달랐다.
    const color=cs(cat).dot;
    const tag=document.createElement('span');
    const isPersonal=!!catDoc.clientId;
    const isCommon=!catDoc.clientId;
    const isCommonReadOnly=isCommon&&!isAdmin;
    tag.className='cat-tag'; tag.style.borderColor=color+'44'; tag.style.backgroundColor=color+'15';
    if(isCommonReadOnly)tag.style.opacity='0.6';
    tag.style.cursor=isCommonReadOnly?'default':'grab';
    tag.draggable=!isCommonReadOnly;
    tag.dataset.docId=catDoc.id;
    tag.dataset.order=String(catDoc.sortOrder??i);
    tag.innerHTML=`<span style="font-size:11px;color:#94a3b8;margin-right:2px;">⠿</span><span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span><span style="font-size:13px;font-weight:700;color:${color};">${escHtml(cat)}</span>`
      +(isPersonal?`<span style="font-size:10px;background:${color}22;color:${color};padding:1px 5px;border-radius:4px;margin-left:2px;">${clientName}</span>`:'')
      +(isCommonReadOnly?'':`<button class="cat-edit" title="이름·색상 수정">${iconSvg('pen')}</button>`)
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
    if(!isCommonReadOnly)tag.querySelector('.cat-edit').addEventListener('click',()=>openCategoryEdit(type,catDoc,color,async()=>{await refetchCategories();loadSettings();}));
    if(cat!=='확인필요'&&!isCommonReadOnly)tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제',`"${cat}" 카테고리를 삭제하시겠습니까?`,()=>deleteCategory(type,cat,catDoc.clientId||''),'삭제','btn btn-danger'));
    el.appendChild(tag);
  });
}
export function renderRuleTags(){
  const el=document.getElementById('rule-tags'); if(!el)return;
  const settingsClientId=S.settings.settingsClientId||'';
  const clientName=settingsClientId?S.clients.find(c=>c.id===settingsClientId)?.name||'':'';
  const ruleTargetLabel=settingsClientId?clientName:'공통';
  const ruleBadge=document.getElementById('rule-target'); if(ruleBadge)ruleBadge.textContent=ruleTargetLabel;
  el.innerHTML='';
  if(!S.settings.rules.length){el.innerHTML='<div class="empty-state" style="padding:20px;"><div class="icon">🏷️</div>등록된 규칙 없음</div>';return;}
  const settingsClientName=S.settings.settingsClientId?S.clients.find(c=>c.id===S.settings.settingsClientId)?.name||'':'';
  S.settings.rules.forEach(r=>{
    const tc=r.type==='지출'?'#dc2626':'#16a34a', tag=document.createElement('span');
    const isPersonal=!!r.clientId;
    tag.className='rule-tag'; tag.style.borderColor=tc+'33';
    tag.innerHTML=`<span style="font-size:13px;font-weight:700;color:var(--sub);">"${escHtml(r.keyword)}"</span><span style="font-size:11px;color:var(--muted);">→</span><span style="font-size:13px;font-weight:700;color:${tc};">${escHtml(r.category)}</span>`
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
      // 중단된 마감을 숨기지 않는다. 예전에는 이력을 마지막에 남겨서, 중간에
      // 끊기면 화면상 미마감으로 보이고 다시 누르면 거래가 삼중으로 쌓였다.
      const stuck=r.status==='in_progress';
      const when=r.archivedAt||r.startedAt;
      div.innerHTML=`<span>${escHtml(r.year)}년 마감${stuck?' <span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:5px;font-size:11px;font-weight:700;">중단됨 · 다시 실행하면 이어서 진행</span>':''}</span>`
        // archivedAt 은 서버 타임스탬프다 — new Date() 에 그냥 넣으면 Invalid Date.
        +`<span style="color:var(--muted);">${r.count??0}건 · ${escHtml(formatDate(when))}</span>`;
      el.appendChild(div);
    });
  }catch(e){console.warn('archive history:',e);}
}
export async function confirmArchive(){
  const year=Number(document.getElementById('archive-year')?.value);
  if(!year){toast('연도를 선택하세요.','error');return;}
  showConfirm(`${year}년 데이터 마감`,`${year}년 거래 데이터를 보관하고 계좌 기초잔액을 업데이트합니다.\n영수증·통장사진은 삭제하지 않고 저해상도로 압축 보관됩니다.\n이 작업은 되돌릴 수 없습니다.`,()=>executeArchive(year),'마감 실행','btn btn-danger');
}
/**
 * 연도 마감 — 그 해 거래를 archive_YYYY로 옮기고 기초잔액을 다음 해로 전진시킨다.
 *
 * 왜 이렇게 복잡한가
 *   예전에는 복사 → 기초잔액 전진 → 원본 삭제 → 이력 기록 순서였는데,
 *   3단계에서 실패하면 거래가 **두 벌 존재하면서 기초잔액은 이미 반영된** 상태가
 *   되어 잔액이 이중 계상됐다. 이력이 없으니 화면에는 미마감으로 보이고,
 *   다시 누르면 삼중이 됐다.
 *
 *   Firestore 배치는 500개 제한이 있어 1년치를 한 트랜잭션으로 묶을 수 없다.
 *   그래서 원자성 대신 **중단되어도 안전하게 다시 돌릴 수 있게** 만들었다.
 *
 *   1. 이력을 in_progress로 **먼저** 남긴다 → 중단돼도 흔적이 남는다
 *   2. 사본은 원본 문서 ID를 그대로 써서 저장한다 → 다시 돌려도 덮어쓸 뿐 복제되지 않는다
 *   3. 기초잔액 전진은 initialBalanceDate로 이미 했는지 확인한다 → 두 번 더해지지 않는다
 *   4. 원본 삭제는 원래 멱등하다
 *   5. 이력을 done으로 마무리
 *
 * 또 하나 — 예전에는 S.accounts(활성 계좌만)를 순회해서 **비활성 계좌는 거래만
 * 삭제되고 기초잔액은 전진하지 않아 1년치가 영구 증발했다.** 이제 전 계좌를 본다.
 */
export async function executeArchive(year){
  // 탭 버튼만 숨겨져 있었고 window.executeArchive는 노출되어 있었다
  if(!can('settings.archive')){toast('연도 마감 권한이 없습니다.','error');return;}
  showLoading(true);
  const btn=document.getElementById('btn-archive');
  try{
    // 마감은 **서버가** 한다. 두 가지가 브라우저에서는 불가능하다:
    //   · 마감된 달의 거래 삭제 — 규칙이 막는다(막아야 한다)
    //   · 보관 이미지 덮어쓰기 — Web SDK 에는 generation 사전조건이 없어
    //     같은 순간의 증빙 교체를 조용히 뭉갠다
    //
    // 한 해 거래가 수천 건이면 한 번의 호출로 끝나지 않으므로, 서버가
    // "아직 남았다"를 돌려주는 동안 계속 부른다. 모든 단계가 멱등이라
    // 중간에 끊겨도 같은 연도로 다시 실행하면 이어서 진행된다.
    let out={done:false}, rounds=0;
    while(!out.done){
      if(++rounds>200)throw new Error('마감이 끝나지 않습니다. 다시 실행하면 이어서 진행됩니다.');
      const res=await window._fbFn.call('runArchive')({year});
      out=res.data||{};
      const phase={copy:'거래 보관 중',balance:'기초잔액 전진 중',recompress:'보관 이미지 압축 중',done:'마무리'}[out.phase]||'진행 중';
      if(btn)btn.textContent=`${phase}... (${out.copied||out.count||0}건)`;
    }

    // 마감은 거래 원본을 삭제하고 기초잔액을 전진시킨다. 되돌릴 수 없으므로
    // 누가 언제 실행했는지가 남아야 한다.
    await auditLog('archive.run',{
      resourceId:'archive_'+year,
      summary:{ year, count:out.count||0 },
    });
    await fetchBaseData(); loadSettings();
    toast(`${year}년 마감 완료! ${out.count||0}건 보관, 이미지 ${out.recompressed||0}건 압축.`,'success',5000);
  }catch(e){
    // 실패도 기록한다 — 중단된 마감은 데이터가 어중간한 상태로 남을 수 있어
    // 나중에 "언제 무엇이 중단됐는지"가 복구의 출발점이 된다.
    await auditLog('archive.failed',{
      resourceId:'archive_'+year,
      summary:{ year, reason:String(e.message||e) },
    });
    toast(`마감 중단: ${e.message}\n같은 연도로 다시 실행하면 이어서 진행됩니다(사본은 중복되지 않습니다).`,'error',8000);
  }
  if(btn)btn.textContent='연도 마감 실행';
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
/**
 * 전체 초기화.
 *
 * 종전 구현의 문제
 *   · `await deleteDoc` 한 건씩 — 수천 건이면 매우 느리고, 중간에 실패하면
 *     **DB가 반쯤 지워진 채로 남으며** 어디까지 지웠는지 알 수 없어 이어서
 *     진행할 수도 없었다.
 *   · 확인이 브라우저 prompt() 하나.
 *   · 화면 설명은 "거래/계좌/입주자/보고서"인데 실제로는 카테고리·고정항목·
 *     설정(config)까지 지웠다 — 동의한 범위와 실제 범위가 달랐다.
 *     특히 config를 지우면 권한 등급표와 마감 색인이 함께 사라졌다.
 *
 * 지금
 *   · 지울 대상은 domain/data-reset.js의 표 하나가 정하고, 확인 창이 그 표를
 *     그대로 보여준다(보존되는 것도 함께).
 *   · 배치(499건)로 지우고 진행 상태를 systemOperations 문서에 남긴다 →
 *     중단되면 이어서 진행한다.
 *   · 성공·실패 모두 변경 이력에 남는다.
 */
export async function executeFirebaseReset(){
  if(!can('settings.reset')){toast(unavailableMessage('settings.reset'),'error',5000);return;}

  const{getDoc,doc}=fb();
  const db=fdb();
  const opRef=doc(db,SYSTEM_OPS,RESET_OPERATION_ID);

  // 다른 사람이 지금 돌리고 있으면 겹치지 않게 막는다.
  let state=null;
  try{ const s=await getDoc(opRef); state=s.exists()?s.data():null; }catch(e){ /* 상태를 못 읽으면 새로 시작 */ }
  if(isResetLockActive(state)){
    toast('초기화가 이미 진행 중입니다. 잠시 후 다시 확인하세요.','error',6000);
    return;
  }

  const resuming=state&&state.status==='running';
  const remaining=remainingCollections(state);
  const willDelete=remaining.map(c=>'· '+c.label).join('\n');
  const preserved=RESET_PRESERVED.map(p=>'· '+p).join('\n');

  showConfirm(
    resuming?'초기화 이어서 진행':'전체 초기화',
    `지웁니다:\n${willDelete}\n\n그대로 둡니다:\n${preserved}\n\n`
      + `되돌릴 수 없습니다. 계속하려면 다음 화면에 "${DATA_RESET_CONFIRM_TEXT}"를 입력하세요.`,
    async()=>{
      const code=prompt(`확인을 위해 "${DATA_RESET_CONFIRM_TEXT}"를 입력하세요:`);
      if(!isResetConfirmed(code)){toast('취소되었습니다.','info');return;}
      await runReset(opRef,state);
    },
    resuming?'이어서 진행':'초기화 실행','btn btn-danger');
}

/** 진행률 표시 갱신. */
function paintResetProgress(state,visible=true){
  const wrap=document.getElementById('reset-progress');
  if(!wrap)return;
  wrap.style.display=visible?'block':'none';
  const bar=document.getElementById('reset-progress-bar');
  if(bar)bar.style.width=resetProgressPercent(state)+'%';
  const label=document.getElementById('reset-progress-label');
  if(label)label.textContent=resetProgressLabel(state);
}

async function runReset(opRef,prevState){
  const{getDocs,collection,setDoc,updateDoc}=fb();
  const db=fdb();

  const doneCollections=[...((prevState&&prevState.doneCollections)||[])];
  const deletedCounts={...((prevState&&prevState.deletedCounts)||{})};
  const startedAt=(prevState&&prevState.startedAt)||new Date().toISOString();

  const touch=async(extra={})=>{
    const data={status:'running',startedAt,updatedAt:new Date().toISOString(),
      doneCollections,deletedCounts,by:String(S.user?.userId||''),...extra};
    await setDoc(opRef,data,{merge:true});
    paintResetProgress(data);
    return data;
  };

  showLoading(true);
  const storageUrls=[];   // Storage 고아 파일 방지: 삭제 전 URL을 모은다
  try{
    await touch();

    for(const {col,label} of remainingCollections(prevState)){
      // 컬렉션이 비어 있을 때까지 반복한다 — 한 배치가 499건이므로
      // 큰 컬렉션은 여러 번 돈다. 삭제는 멱등하므로 재시도해도 안전하다.
      for(;;){
        const snap=await getDocs(collection(db,col));
        if(snap.empty)break;
        const chunk=snap.docs.slice(0,MAX_DELETES_PER_BATCH);
        for(const d of chunk){
          const data=d.data();
          if(col===COLS.TRANSACTIONS&&data.receiptUrl)storageUrls.push(data.receiptUrl);
          else if(col===COLS.ACCOUNTS)(data.bankStatements||[]).forEach(s=>{
            if(s&&typeof s==='object'){if(s.url)storageUrls.push(s.url);if(s.thumbUrl)storageUrls.push(s.thumbUrl);}
            else if(typeof s==='string')storageUrls.push(s);
          });
          else if(col===COLS.EXCEL_UPLOADS&&data.url)storageUrls.push(data.url);
        }
        await batchDeleteDocs(chunk.map(d=>({col,docId:d.id})));
        deletedCounts[col]=(deletedCounts[col]||0)+chunk.length;
        await touch();
        if(chunk.length<MAX_DELETES_PER_BATCH)break;
      }
      doneCollections.push(col);
      await touch();
      toast(`${label} 삭제 완료`,'info',1500);
    }

    // Firestore 삭제 후 Storage 파일도 전량 삭제(best-effort)
    await deleteManyFromStorage(storageUrls);

    const total=Object.values(deletedCounts).reduce((s,n)=>s+Number(n||0),0);
    await updateDoc(opRef,{status:'done',finishedAt:new Date().toISOString()});
    await auditLog('data.reset',{summary:{count:total}});
    await fetchBaseData();
    loadSettings();
    paintResetProgress({doneCollections,deletedCounts},false);
    toast(`초기화 완료 — ${total}건 삭제, 첨부 파일 ${storageUrls.length}건 정리.`,'success',6000);
  }catch(e){
    // 상태를 'failed'로 남긴다 — 다음 실행이 이어서 진행할 수 있게.
    try{ await updateDoc(opRef,{status:'failed',error:String(e.message||e),
      updatedAt:new Date().toISOString()}); }catch(_){ /* 상태 기록 실패는 무시 */ }
    await auditLog('data.resetFailed',{summary:{reason:String(e.message||e)}});
    toast(`초기화 중단: ${e.message}\n다시 실행하면 남은 항목부터 이어서 진행합니다.`,'error',9000);
  }
  showLoading(false);
}


// ─────────────────────────────────────────────
// 탭 전환
// ─────────────────────────────────────────────
/**
 * 설정 탭 초기화.
 *
 * 탭 목록·권한·전환은 settings-shell.js(+settings-nav.js)가 담당한다.
 * 여기서는 각 탭이 열릴 때 어떤 렌더 함수를 부를지 등록하고, 카테고리
 * 서브탭만 바인딩한다.
 *
 * 왜 옮겼나: 종전에는 탭을 추가할 때 HTML 버튼 · 패널 div · 권한 if문 ·
 * 클래스 토글 네 곳을 손대야 했고, 가로 탭이라 개수가 늘면 무너졌다.
 * 이제 SETTINGS_TABS 배열 한 줄 + 패널 div 하나로 끝난다.
 */
export function initSettingsTabs(){
  // 탭별 렌더 함수 등록 (없는 탭은 정적 HTML만 보여진다)
  registerPanel('overview',    renderSettingsOverview);
  registerPanel('list',        renderManagement);
  registerPanel('audit',       renderSettingsAudit);
  registerPanel('team',        renderTeamsPanel);
  // 권한 패널은 편집 중인 draft를 들고 있다. 이미 그려져 있으면 다시 그리지 않는다
  // — 탭을 왕복할 때마다 저장하지 않은 변경이 사라지면 쓸 수 없다.
  registerPanel('permissions', () => {
    if (!document.getElementById('btn-perm-save')) renderPermissionPanel();
  });

  document.querySelectorAll('.category-subtab-btn').forEach(btn=>{
    if(btn.dataset.bound)return; btn.dataset.bound='1';
    btn.addEventListener('click',e=>{
      switchCategorySubtab(e.currentTarget.dataset.subtab);
    });
  });

  registerCrudDeps({ refresh: renderManagement, refetchUsers, refetchClients, refetchAccounts });
  initSettingsShell();
  // 열려 있지 않은 탭에도 알림 개수가 붙어야 한다 — 「개요」를 보지 않아도
  // 승인 대기나 미납이 있다는 것이 레일에서 보이게.
  refreshOverviewBadges();
}

// 다른 모듈·인라인 onclick이 부르던 이름을 유지한다.
export { switchSettingsTab };

export function switchCategorySubtab(subtab){
  document.querySelectorAll('.category-subtab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector(`[data-subtab="${subtab}"]`)?.classList.add('active');
  document.querySelectorAll('.subtab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById(`category-${subtab}-content`)?.classList.add('active');
}

// ─────────────────────────────────────────────
// 회원가입 승인
// ─────────────────────────────────────────────
export async function approveStaff(userId, requested=null) {
  const sel = document.getElementById('pending-role-' + userId);
  const role = requested?.role || sel?.value || '입력자';
  const isAdmin = requested?.isAdmin === true;
  try {
    // users 쓰기는 보안 규칙이 막는다. 서버가 호출자 등급을 확인하고 처리한다
    // (예전에는 팀장이 신규 가입자를 센터장으로 승인할 수 있었다).
    const response=await window._fbFn.call('approveStaff')({ userId, role, isAdmin });
    const state=response.data?.state;
    // 누구를 어떤 권한으로 들였는지가 가장 중요한 기록 중 하나다.
    await auditLog('staff.approve',{resourceId:userId,summary:{
      target:S.users.find(u=>u.id===userId)?.name||userId, role}});
    const msg={
      pending:'변경을 요청했습니다. 다른 센터장의 승인이 필요합니다.',
      approved:'승인했습니다. 다른 시스템 관리자의 실행을 기다립니다.',
      executed:`변경 완료 — ${role}${isAdmin?' + 시스템 관리자':''}`,
    }[state]||'처리 상태를 확인해 주세요.';
    toast(msg, state==='executed'?'success':'info', 5000);
    await refetchUsers(); renderManagement(); updateSignupBadge();
  } catch(e) { toast('승인 오류: '+(e.message||'다시 시도하세요.'), 'error'); }
}

export async function cancelStaffPrivilegeChange(userId){
  try{
    await window._fbFn.call('cancelStaffPrivilegeChange')({userId});
    toast('역할 변경 요청을 취소했습니다. 이력은 보존됩니다.','info');
    await refetchUsers(); renderManagement(); updateSignupBadge();
  }catch(e){toast('취소 오류: '+(e.message||'다시 시도하세요.'),'error');}
}

// 설정 네비게이션의 회원가입 승인 대기 뱃지 갱신 (관리 권한자에게만 표시)
export function updateSignupBadge(){
  const badge=document.getElementById('nav-settings-badge');
  if(!badge)return;
  const n=(can('nav.staff')&&Array.isArray(S.users))?S.users.filter(u=>u.approved===false).length:0;
  if(n>0){badge.textContent=n;badge.style.display='inline';}else badge.style.display='none';
}
