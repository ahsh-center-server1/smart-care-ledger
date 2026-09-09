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
import { clearAuditCache } from './settings-audit.js';
import { refreshReceiptIntakeButtons } from './receipt-intake.js';
import { fnErrorMessage } from '../services/fn-errors.js';

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
    // 비밀번호 검증은 서버(Cloud Functions)에서 한다.
    // 예전에는 users 문서의 평문 비밀번호를 브라우저가 직접 비교했다.
    const { call } = window._fbFn;
    const res = await call('login')({ userId: id, password: pw });
    const { token, user } = res.data;

    // 커스텀 토큰으로 Firebase Auth 로그인 → 이후 모든 Firestore 요청에
    // request.auth가 실려 보안 규칙이 판정할 수 있다.
    const { auth, signInWithCustomToken } = window._fbAuth;
    await signInWithCustomToken(auth, token);

    // 세션은 Firebase Auth가 관리한다. sessionStorage에 역할을 저장하지 않는다
    // (예전에는 개발자도구에서 role을 관리자로 고쳐 새로고침하면 관리자가 됐다).
    S.user = user;

    await initPermissions();
    btn.disabled=false; btn.textContent='시스템 접속';
    await _enterApp();
  } catch(e) {
    errEl.textContent = fnErrorMessage(e, '로그인 실패. 다시 시도하세요.', fnEndpoint('login'));
    errEl.style.display='block';
    btn.disabled=false; btn.textContent='시스템 접속';
  }
}


/** 호출 대상 주소 — 실패 안내에 붙여 사용자가 직접 열어 볼 수 있게 한다 */
function fnEndpoint(name) {
  try { return window._fbFn?.endpoint?.(name) || ''; } catch (_) { return ''; }
}

export async function _enterApp() {
  showLoading(true);
  try {
    setText('user-name',   S.user.name||S.user.userId);
    setText('user-role',   S.user.role||'');
    document.getElementById('user-avatar').textContent=(S.user.name||'?').charAt(0);
    if (can('nav.staff')) document.getElementById('admin-staff').style.display='block';
    applyPermissionVisibility();
    document.getElementById('login-view').style.display='none';
    await fetchBaseData();
    // 화면 폭에 따른 분기는 없다. 모바일 전용 앱을 없애고 반응형 하나로 통합했으므로
    // 좁은 화면에서도 같은 데이터·같은 로직이 돈다(보이는 범위만 CSS로 줄인다).
    document.getElementById('app-view').style.display='block';
    changeView('dashboard');
  } catch(e) { toast('초기화 오류: '+e.message,'error'); }
  showLoading(false);
}

/**
 * 권한에 따라 메뉴·버튼 표시를 정한다.
 *
 * 입력자는 담당 입주자의 본인 작성 거래만 보고 수기 입력만 한다.
 * 보고서·설정은 물론 엑셀 업로드·증빙 출력·통장사진·CSV·일괄삭제·달력뷰까지
 * 전부 숨긴다(보안 규칙에서도 막히지만, 눌러서 실패하게 두지 않는다).
 */
function applyPermissionVisibility() {
  const show = (id, ok) => {
    const el = document.getElementById(id);
    if (el) el.style.display = ok ? '' : 'none';
  };

  // 보고서·설정 탭 — 사이드바와 하단 네비 양쪽
  document.querySelectorAll('.nav-item[data-view="report"],.mobile-nav-item[data-view="report"]')
    .forEach(el => { el.style.display = can('nav.report') ? '' : 'none'; });
  document.querySelectorAll('.nav-item[data-view="settings"],.mobile-nav-item[data-view="settings"]')
    .forEach(el => { el.style.display = can('nav.settings') ? '' : 'none'; });

  show('btn-h-excel',         can('excel.upload'));
  show('btn-h-receipt-print', can('receipt.print'));
  show('btn-bulk-del',        can('trx.delete.bulk'));
  show('btn-h-fixed',         can('settings.fixed'));

  // 영수증 사진 자동입력은 권한 + **서버에 API 키가 있는지**에 달려 있다.
  // 서버에 물어봐야 알 수 있으므로 비동기로 갱신한다(기본은 숨김).
  refreshReceiptIntakeButtons().catch(() => { /* 못 물어보면 숨긴 채로 둔다 */ });
  show('btn-csv-export',      can('trx.csv'));
  show('btn-trx-view-toggle', can('trx.view.all'));
}

export async function handleLogout() {
  // Firebase Auth 로그아웃 — watchAuthState가 감지해 로그인 화면으로 돌린다.
  try { await window._fbAuth.signOut(window._fbAuth.auth); } catch(e) { console.warn(e); }
  clearSessionState();
  document.getElementById('login-view').style.display='flex';
  document.getElementById('app-view').style.display='none';
  document.getElementById('login-id').value='';
  document.getElementById('login-pw').value='';
  document.getElementById('login-err').style.display='none';
  document.getElementById('admin-staff').style.display='none';
}

/**
 * 로그아웃 시 전역 상태를 비운다.
 *
 * 예전에는 일부 필드만 지워서 공용 PC에서 다음 사용자에게 이전 사용자의
 * 직원 목록·입주자 목록이 남아 있었다. state.js에 필드를 추가할 때마다
 * 여기에 손으로 추가해야 하는 구조라서, 목록 대신 초기값으로 되돌린다.
 */
function clearSessionState() {
  S.user=null;
  S.users=[]; S.clients=[]; S.accounts=[]; S.categories=[];
  S.allClients=[]; S.allAccounts=[];
  S.transactions=[]; S.filteredTrx=[]; S.activeClient=null;
  S.trxRange='month'; S.page=1;
  S.reportData=null;
  S.confirmedMonths=new Set();
  S.reportList=null; S.rptTrxCache=null; S.rptListAllYears=false;
  S.permOverride=null; S.caps=null; S.accessibleClientIds=[];
  S.monthlyStats={}; S.mandatoryUnpaid={};
  S.fixedItems=[]; S.allFixedItems=[];
  S.excelTemp=[]; S.excelRawRows=[]; S.excelFile=null; S.excelMonth='';
  S.settings={ expCats:[], incCats:[], rules:[] };
  // 변경 이력 캐시는 S 밖(모듈 지역 변수)에 있다. 비우지 않으면 다음에
  // 로그인한 사람에게 남의 활동 기록이 그대로 보인다.
  clearAuditCache();
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
  if (pw.length < 8) { errEl.textContent='비밀번호는 8자 이상이어야 합니다.'; errEl.style.display='block'; return; }

  const btn = document.getElementById('signup-btn');
  btn.disabled=true; btn.textContent='처리 중...';
  try {
    // 아이디 중복 검사와 해시 저장을 서버가 한 트랜잭션으로 처리한다.
    // users가 비어 있으면 첫 계정을 관리자로 만들어, 승인해줄 사람이 없어
    // 아무도 로그인할 수 없던 신규 배포 교착을 해소한다.
    const { call } = window._fbFn;
    const res = await call('signup')({ userId: id, password: pw, name, team });

    document.getElementById('signup-form').style.display='none';
    document.getElementById('login-form').style.display='flex';
    errEl.style.color='#10b981';
    errEl.textContent = res.data?.message || '가입 신청이 완료되었습니다.';
    errEl.style.display='block';
    document.getElementById('login-id').value=id;
  } catch(e) {
    errEl.textContent = fnErrorMessage(e, '가입 오류. 다시 시도하세요.', fnEndpoint('signup'));
    errEl.style.display='block';
  } finally {
    btn.disabled=false; btn.textContent='가입 신청';
  }
}

/**
 * 새로고침·재접속 시 세션 복원.
 *
 * 예전 구현은 sessionStorage의 JSON을 검증 없이 신뢰하면서, 정작 쓰지도 않는
 * Firebase Auth 세션을 검사해 조건이 항상 참이 되어 **새로고침하면 무조건
 * 로그아웃**됐다. 이제 Firebase Auth가 세션을 관리하고, 역할·재직 여부는
 * 서버(users 문서)에서 다시 읽어 확인한다.
 */
export function watchAuthState(onReady) {
  const { auth, onAuthStateChanged } = window._fbAuth;
  let handled = false;

  onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) {
      S.user = null;
      if (!handled) { handled = true; onReady(false); }
      return;
    }
    try {
      // 토큰 클레임이 아니라 Firestore를 다시 읽는다 —
      // 퇴사 처리(active:false)나 역할 변경이 즉시 반영되도록.
      const { getDoc, doc } = fb();
      const snap = await getDoc(doc(fdb(), COLS.USERS, fbUser.uid));
      if (!snap.exists()) throw new Error('계정을 찾을 수 없습니다.');
      const u = snap.data();
      if (u.approved === false) throw new Error('승인 대기 중인 계정입니다.');
      if (u.active === false)   throw new Error('비활성화된 계정입니다.');

      S.user = {
        userId: fbUser.uid,
        name: u.name || fbUser.uid,
        role: u.role || '입력자',
        isAdmin: u.isAdmin === true,
        team: u.team || '',
      };
      await initPermissions();
      if (!handled) { handled = true; onReady(true); }
    } catch (err) {
      console.warn('세션 복원 실패:', err.message);
      try { await window._fbAuth.signOut(window._fbAuth.auth); } catch(_) {}
      S.user = null;
      if (!handled) { handled = true; onReady(false); }
    }
  });
}

// 로그인 이벤트 바인딩은 app.js bindEvents()에서 처리
