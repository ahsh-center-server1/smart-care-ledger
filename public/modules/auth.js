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
import { initPermissions, can } from './permissions.js';

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
    // Firestore users 컬렉션에서 직접 인증 (Cloud Functions 미사용)
    const { getDocs, collection, query, where } = fb();
    const snap = await getDocs(query(collection(fdb(), COLS.USERS), where('userId', '==', id)));

    if (snap.empty) {
      throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
    }

    const userData = snap.docs[0].data();
    if (userData.password !== pw) {
      throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    if (userData.approved === false) {
      throw new Error('관리자 승인 대기 중입니다. 담당자에게 문의하세요.');
    }

    // 세션에 사용자 정보 저장
    S.user = { userId: id, name: userData.name, role: userData.role, team: userData.team };
    sessionStorage.setItem('scl_user', JSON.stringify(S.user));

    // 권한 초기화
    await initPermissions();

    btn.disabled=false; btn.textContent='시스템 접속';
    await _enterApp();
  } catch(e) {
    errEl.textContent=e.message || '로그인 실패. 다시 시도하세요.';
    errEl.style.display='block';
    btn.disabled=false; btn.textContent='시스템 접속';
  }
}

export async function _enterApp() {
  showLoading(true);
  try {
    setText('user-name',   S.user.name||S.user.userId);
    setText('user-role',   S.user.role||'');
    document.getElementById('user-avatar').textContent=(S.user.name||'?').charAt(0);
    if (can('nav.staff')) document.getElementById('admin-staff').style.display='block';
    // 입력자 전용: 보고서/설정 nav + 일부 버튼 숨김
    const isInputOnly=!can('trx.view.all');
    document.querySelectorAll('.nav-item[data-view="report"],.nav-item[data-view="settings"]').forEach(el=>{
      el.style.display=isInputOnly?'none':'';
    });
    // 파일 업로드는 excel.upload 권한으로 직접 제어
    const elExcel=document.getElementById('btn-h-excel');
    if(elExcel)elExcel.style.display=can('excel.upload')?'':'none';
    // 나머지 입력자 제한 버튼
    ['btn-h-receipt-print','btn-trx-view-toggle','btn-bulk-del','btn-h-fixed'].forEach(id=>{
      const el=document.getElementById(id);
      if(el)el.style.display=isInputOnly?'none':'';
    });
    document.getElementById('login-view').style.display='none';
    await fetchBaseData();
    // isMobile / initMobileApp는 app.js에 정의됨 (모바일 전용, 미모듈화) — window 경유
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

// ─────────────────────────────────────────────
// 회원가입
// ─────────────────────────────────────────────
export async function handleSignup() {
  const name = (document.getElementById('signup-name').value||'').trim();
  const id   = (document.getElementById('signup-id').value||'').trim();
  const pw   = (document.getElementById('signup-pw').value||'').trim();
  const team = (document.getElementById('signup-team').value||'').trim();
  const errEl = document.getElementById('login-err');
  errEl.style.display='none';

  if (!name) { errEl.textContent='이름을 입력하세요.'; errEl.style.display='block'; return; }
  if (!id)   { errEl.textContent='아이디를 입력하세요.'; errEl.style.display='block'; return; }
  if (!/^[a-zA-Z0-9_]+$/.test(id)) { errEl.textContent='아이디는 영문·숫자·밑줄(_)만 사용 가능합니다.'; errEl.style.display='block'; return; }
  if (!pw)   { errEl.textContent='비밀번호를 입력하세요.'; errEl.style.display='block'; return; }

  const btn = document.getElementById('signup-btn');
  btn.disabled=true; btn.textContent='처리 중...';
  try {
    const { getDocs, collection, query, where, addDoc } = fb();
    // 아이디 중복 체크
    const dup = await getDocs(query(collection(fdb(), COLS.USERS), where('userId','==',id)));
    if (!dup.empty) throw new Error('이미 사용 중인 아이디입니다.');

    await addDoc(collection(fdb(), COLS.USERS), {
      userId: id, name, password: pw, role: '입력자', team, approved: false
    });

    // 로그인 폼으로 전환 + 안내 메시지
    document.getElementById('signup-form').style.display='none';
    document.getElementById('login-form').style.display='flex';
    errEl.style.color='#10b981';
    errEl.textContent='가입 신청이 완료되었습니다. 관리자 승인 후 로그인하세요.';
    errEl.style.display='block';
    document.getElementById('login-id').value=id;
  } catch(e) {
    errEl.textContent=e.message||'가입 오류. 다시 시도하세요.';
    errEl.style.display='block';
  } finally {
    btn.disabled=false; btn.textContent='가입 신청';
  }
}

// 로그인 이벤트 바인딩은 app.js bindEvents()에서 처리
