/**
 * modules/auth.js — Smart Care Ledger v2
 * 인증: 로그인, 앱 진입, 로그아웃
 */

'use strict';

import { S } from '../state.js';
import { COLS } from '../constants.js';
import { fb, fdb } from '../services/firestore.js';
import { toast, showLoading, setText } from '../utils/ui.js';
import { fetchBaseData, changeView } from './core.js';

// isMobile, initMobileApp — app.js에서 window로 노출됨 (core.js 미포함)
// window.onFirebaseReady, 이벤트 바인딩 — app.js에서 일괄 처리

// ─────────────────────────────────────────────
// 로그인 / 로그아웃
// ─────────────────────────────────────────────
export async function handleLogin() {
  const id    = (document.getElementById('login-id').value||'').trim();
  const pw    = (document.getElementById('login-pw').value||'').trim();
  const errEl = document.getElementById('login-err');
  errEl.style.display='none';
  if (!id||!pw) { errEl.textContent='아이디와 비밀번호를 입력하세요.'; errEl.style.display='block'; return; }
  const btn=document.getElementById('login-btn');
  btn.disabled=true; btn.textContent='접속 중...';
  try {
    const { getDocs, collection, query, where } = fb();
    const snap = await getDocs(query(collection(fdb(),COLS.USERS), where('userId','==',id), where('password','==',pw)));
    if (snap.empty) {
      errEl.textContent='아이디 또는 비밀번호가 올바르지 않습니다.';
      errEl.style.display='block'; btn.disabled=false; btn.textContent='시스템 접속'; return;
    }
    const d=snap.docs[0];
    S.user={...d.data(),userId:d.id};
    sessionStorage.setItem('scl_user',JSON.stringify(S.user));
    btn.disabled=false; btn.textContent='시스템 접속';
    await _enterApp();
  } catch(e) {
    errEl.textContent='오류: '+e.message; errEl.style.display='block';
    btn.disabled=false; btn.textContent='시스템 접속';
  }
}

export async function _enterApp() {
  showLoading(true);
  try {
    setText('user-name',   S.user.name||S.user.userId);
    setText('user-role',   S.user.role||'');
    document.getElementById('user-avatar').textContent=(S.user.name||'?').charAt(0);
    if (['관리자','센터장','팀장'].includes(S.user.role)) document.getElementById('admin-staff').style.display='block';
    // 입력자 전용: 보고서/설정 nav + 일부 버튼 숨김
    const isInputOnly=S.user.role==='입력자';
    document.querySelectorAll('.nav-item[data-view="report"],.nav-item[data-view="settings"]').forEach(el=>{
      el.style.display=isInputOnly?'none':'';
    });
    ['btn-h-excel','btn-h-receipt-print','btn-trx-view-toggle','btn-bulk-del','btn-h-fixed'].forEach(id=>{
      const el=document.getElementById(id);
      if(el)el.style.display=isInputOnly?'none':'';
    });
    document.getElementById('login-view').style.display='none';
    await fetchBaseData();
    if(window.isMobile()){
      window.initMobileApp();
    } else {
      document.getElementById('app-view').style.display='block';
      changeView('dashboard');
    }
  } catch(e) { toast('초기화 오류: '+e.message,'error'); }
  showLoading(false);
}

export function handleLogout() {
  S.user=null; S.transactions=[]; S.filteredTrx=[]; S.activeClient=null;
  S.clients=[]; S.accounts=[]; S.categories=[];
  S.driveToken=null; S.driveTokenExpiry=null;
  sessionStorage.removeItem('scl_user');
  document.getElementById('login-view').style.display='flex';
  document.getElementById('app-view').style.display='none';
  const mv=document.getElementById('mobile-view');
  if(mv)mv.style.display='none';
  document.getElementById('login-id').value='';
  document.getElementById('login-pw').value='';
  document.getElementById('login-err').style.display='none';
  document.getElementById('admin-staff').style.display='none';
}

// 로그인 이벤트 바인딩은 app.js bindEvents()에서 처리
