/**
 * modules/core.js — Smart Care Ledger v2
 * 코어 흐름: 기본 데이터 로드, 거래 로드, 뷰 전환
 *
 * 순환 import 안전성:
 *   - core.js → Dash/Trx/Rpt/Settings (이 파일이 먼저 import)
 *   - Dash/Trx/Rpt/Settings → core.js (Tasks 2~4 이후 추가 예정)
 *   - 양방향 모두 함수 바디 내 호출만 있으므로 모듈 초기화 시점 undefined 없음
 */
'use strict';

import { S } from '../state.js';
import { COLS, LOCKED_MONTHS_DOC, lockKey } from '../constants.js';
import { toast, showLoading, setText } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import { chunkForInQuery } from '../services/in-query.js';
import * as Dash     from './dashboard.js';
import * as Trx      from './transactions.js';
import * as Rpt      from './report.js';
import * as Settings from './settings.js';
import { can } from './permissions.js';

/**
 * 기본 데이터 로드.
 * @param {Object} [opts]
 * @param {string[]} [opts.only] - 갱신할 컬렉션만 명시 ('users'|'clients'|'accounts'|'categories'|'reports'|'monthlyStats')
 *                                  미지정 시 전체 로드 (로그인·새로고침용)
 */
export async function fetchBaseData(opts) {
  const { getDocs, getDoc, collection, doc, query, where } = fb();
  // 담당 입주자만 볼지 전체를 볼지 — 네비게이션 메뉴 권한이 아니라 전용 키로 판정한다.
  // 예전에는 can('nav.staff')를 썼기 때문에 팀장의 메뉴 표시를 끄면
  // 팀장이 전 입주자를 못 보게 되는 숨은 부작용이 있었다.
  const db=fdb(), viewAllClients=can('client.view.all');
  const only = opts && Array.isArray(opts.only) ? new Set(opts.only) : null;
  const need = key => !only || only.has(key);

  // 각 컬렉션을 필요한 경우에만 fetch (병렬)
  const tasks = [];
  if (need('users'))      tasks.push(['users',      getDocs(collection(db,COLS.USERS))]);
  if (need('clients'))    tasks.push(['clients',    getDocs(collection(db,COLS.CLIENTS))]);
  if (need('accounts'))   tasks.push(['accounts',   getDocs(collection(db,COLS.ACCOUNTS))]);
  if (need('categories')) tasks.push(['categories', getDocs(collection(db,COLS.CATEGORIES))]);
  // 마감 월 색인 — 예전에는 reports를 status='confirmed'로 조회해 만들었다.
  // 그런데 보안 규칙은 reports를 담당자(등급 2) 이상만 읽게 하므로, 입력자가
  // 로그인하면 이 조회가 거부되고 아래 Promise.all이 깨져 **앱 초기화가 통째로
  // 실패**했다(화면이 빈 채로 멈춤). 규칙을 적용한 뒤에야 드러나는 문제였다.
  //
  // 그래서 금액·의견 없이 잠긴 (입주자, 월) 키만 담은 config/lockedMonths 문서를
  // 읽는다. 전 역할이 조회할 수 있고, 쿼리가 아니라 문서 1건이라 읽기도 준다.
  // 갱신은 Cloud Functions의 syncLockedMonths 트리거만 한다.
  if (need('reports'))    tasks.push(['lockedMonths', getDoc(doc(db,COLS.CONFIG,LOCKED_MONTHS_DOC))]);

  const results = await Promise.all(tasks.map(t=>t[1]));
  const snapMap = {};
  tasks.forEach((t,i)=>{ snapMap[t[0]] = results[i]; });

  if (snapMap.users) {
    S.users = snapMap.users.docs.map(d=>{const u={id:d.id,...d.data()};u.team=u.team||'';return u;});
  }
  if (snapMap.categories) {
    S.categories = snapMap.categories.docs.map(d=>({id:d.id,...d.data()}));
  }

  // clients/accounts는 활성/비활성 + 권한 필터링이 함께 들어가므로 한 묶음으로 처리
  if (snapMap.clients || snapMap.accounts) {
    if (snapMap.clients) {
      S.allClients = snapMap.clients.docs.map(d=>({id:d.id,...d.data()}));
    }
    if (snapMap.accounts) {
      S.allAccounts = snapMap.accounts.docs.map(d=>({id:d.id,...d.data()}));
    }
    const showInactive=S.settings?.showInactive||false;
    const activeClients=showInactive?S.allClients:S.allClients.filter(c=>c.active!==false);
    const activeAccounts=showInactive?S.allAccounts:S.allAccounts.filter(a=>a.active!==false);
    S.clients  = viewAllClients ? activeClients : activeClients.filter(c=>{
      // 마이그레이션 후 userId가 곧 users 문서 ID이므로 키 공간이 하나다.
      // (예전에는 userIds에 로그인 아이디, teamLeader에 문서 ID가 들어가 있어
      //  S.users에서 문서 ID를 되찾아 양쪽을 대조해야 했다)
      const ids=String(c.userIds||'').split(',').map(x=>x.trim());
      return ids.includes(String(S.user.userId));
    });
    S.accounts = activeAccounts.filter(a=>S.clients.some(c=>c.id===a.clientId));
  }

  if (snapMap.lockedMonths) {
    // 문서가 없으면(최초 배포·백필 전) 빈 집합이 된다. 그 상태에서는 잠금이 걸리지
    // 않으므로, 관리자가 설정에서 「마감 색인 재생성」을 눌러 백필해야 한다.
    const months = (snapMap.lockedMonths.exists() ? snapMap.lockedMonths.data().months : null) || {};
    S.confirmedMonths = new Set(Object.keys(months).filter(k => months[k]));
  }

  // 당월 수입/지출 집계 (대시보드 카드 표시용)
  // 본인 담당 입주자만 쿼리하여 read 절감 (Firestore 'in' 절은 최대 30개)
  if (need('monthlyStats')) {
    try {
      const now=new Date();
      const ym=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
      const ymStart=ym+'-01';
      const lastDay=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
      const ymEnd=ym+'-'+String(lastDay).padStart(2,'0');
      const myClientIds = S.clients.map(c=>c.id);
      // 입력자는 본인이 만든 거래만 읽을 수 있다. 규칙 엔진은 결과 전체가 조건을
      // 충족함을 증명할 수 없으면 쿼리를 통째로 거부하므로, 클라이언트가
      // createdBy 필터를 함께 걸어야 한다 (firestore.rules의 transactions 블록).
      // 이 필터가 없어서 입력자의 대시보드 집계 쿼리가 조용히 거부되고 ₩0으로 보였다.
      // 복합 인덱스: clientId + createdBy + date (firestore.indexes.json)
      const scoped = !can('trx.view.all')
        ? [where('createdBy','==',String(S.user.userId))]
        : [];
      let docs = [];
      if (myClientIds.length === 0) {
        docs = [];
      } else {
        // 'in' 절은 최대 30개 — 담당 입주자가 많으면 나눠서 조회한다.
        // 예전에는 30명을 넘으면 **전 입주자 한 달치**를 스캔하는 폴백이 돌았고,
        // 그것이 규칙상 거부되거나(입력자·담당자) 읽기 폭증의 원인이 됐다.
        const chunks = chunkForInQuery(myClientIds);
        const snaps = await Promise.all(chunks.map(ids => getDocs(query(
          collection(db,COLS.TRANSACTIONS),
          where('clientId','in',ids),
          where('date','>=',ymStart),
          where('date','<=',ymEnd),
          ...scoped))));
        docs = snaps.flatMap(s => s.docs);
      }
      const mStats={};
      S.clients.forEach(c=>{ mStats[c.id]={inc:0,exp:0}; });
      // 필수 고정항목 미납 카운트 계산을 위해 클라이언트별로 매칭된 fixedItemId 집합 수집
      const paidFixedIdsByClient={};
      S.clients.forEach(c=>{ paidFixedIdsByClient[c.id]=new Set(); });
      docs.forEach(d=>{
        const t=d.data();
        if(!mStats[t.clientId])return;
        if(t.type==='수입')       mStats[t.clientId].inc+=Number(t.amountIn||0);
        else if(t.type==='지출') mStats[t.clientId].exp+=Number(t.amountOut||0);
        // 자산이동, 취소 → 집계 제외
        if(t.isFixed&&t.fixedItemId&&paidFixedIdsByClient[t.clientId]){
          paidFixedIdsByClient[t.clientId].add(t.fixedItemId);
        }
      });
      S.monthlyStats=mStats;

      // 필수 고정항목 전체 로드 + 미납 카운트
      try {
        const fSnap=await getDocs(collection(db,'fixedItems'));
        S.allFixedItems=fSnap.docs.map(d=>({id:d.id,...d.data()}));
        const unpaid={};
        S.clients.forEach(c=>{
          const mandatory=S.allFixedItems.filter(f=>f.clientId===c.id&&f.isMandatory);
          const paid=paidFixedIdsByClient[c.id]||new Set();
          unpaid[c.id]=mandatory.filter(f=>!paid.has(f.id)).length;
        });
        S.mandatoryUnpaid=unpaid;
      } catch(e) { S.allFixedItems=[]; S.mandatoryUnpaid={}; }
    } catch(e) { S.monthlyStats={}; S.mandatoryUnpaid={}; }
  }

  rebuildSelectors();
  // 로그인/갱신 시 회원가입 승인 대기 뱃지 갱신
  if (snapMap.users) Settings.updateSignupBadge();
}

// 부분 갱신 헬퍼 (CRUD 후 호출)
export const refetchUsers      = () => fetchBaseData({ only: ['users'] });
export const refetchClients    = () => fetchBaseData({ only: ['clients','accounts','monthlyStats'] }); // 입주자 변경 시 권한 필터 + 계좌 매핑 + 통계 재계산
export const refetchAccounts   = () => fetchBaseData({ only: ['accounts'] });
export const refetchCategories = () => fetchBaseData({ only: ['categories'] });
export const refetchReports    = () => fetchBaseData({ only: ['reports'] });

export function isConfirmedLocked(clientId, dateStr){
  // 잠금 우회는 전용 권한 키로 판정한다. 역할 문자열이나 isAdmin 플래그를 직접 보면
  // 설정 화면의 권한 등급표로 이 동작을 조정할 수 없다(등급표에 있는데 안 먹는 키가 된다).
  if(can('lock.bypass'))return false;
  const ym=(dateStr||'').substring(0,7);          // 'YYYY-MM'
  if(ym.length!==7)return false;
  // 키 형식은 lockKey 한 곳에서만 만든다 — 서버 트리거(functions/locked-months.cjs)와
  // 같은 형식이어야 하고, 손으로 조립한 곳이 늘면 반드시 어긋난다.
  return !!(S.confirmedMonths?.has(lockKey(clientId, ym.substring(0,4), ym.substring(5,7))));
}

/**
 * 특정 입주자의 거래내역 로드.
 * @param {string} clientId
 * @param {Object} [opts]
 * @param {'month'|'all'|{start:string,end:string}} [opts.range='month'] - 조회 범위
 */
/**
 * 마지막으로 시작된 거래 조회의 일련번호.
 * 재진입 가드가 없어서, 입주자를 빠르게 두 번 바꾸면 **늦게 끝난 응답이 이겼다.**
 * 화면에는 방금 고른 입주자가 표시되는데 표에는 이전 입주자의 거래가 남는다.
 */
let trxLoadSeq = 0;

export async function loadTransactions(clientId, opts) {
  if (!clientId) return;
  const mySeq = ++trxLoadSeq;
  showLoading(true);
  try {
    const { getDocs, collection, query, where } = fb();
    const range = (opts && opts.range) ? opts.range : 'month';
    const db = fdb();

    // 입력자는 본인이 작성한 거래만 볼 수 있다.
    // ⚠️ 이 조건은 **쿼리에** 걸어야 한다. 보안 규칙이 본인 작성분만 허용하므로,
    //    조건 없이 조회하면 규칙 엔진이 결과 전체의 충족을 증명할 수 없어
    //    쿼리가 통째로 거부된다(가져온 뒤 걸러내는 방식으로는 안 된다).
    //    필요한 복합 인덱스는 firestore.indexes.json에 등록되어 있다.
    const ownOnly = !can('trx.view.all');
    const scope = ownOnly
      ? [where('clientId','==',clientId), where('createdBy','==',String(S.user.userId))]
      : [where('clientId','==',clientId)];

    let q;
    if (range === 'all') {
      q = query(collection(db,COLS.TRANSACTIONS), ...scope);
    } else if (range && typeof range === 'object' && range.start && range.end) {
      q = query(collection(db,COLS.TRANSACTIONS), ...scope,
                where('date','>=',range.start),
                where('date','<=',range.end));
    } else {
      // 'month' (기본) — 당월
      const now = new Date();
      const ymStart = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
      const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      const ymEnd = ymStart.substring(0,8)+String(lastDay).padStart(2,'0');
      q = query(collection(db,COLS.TRANSACTIONS), ...scope,
                where('date','>=',ymStart),
                where('date','<=',ymEnd));
    }
    const snap = await getDocs(q);
    // 내가 시작한 조회가 더 이상 최신이 아니면 결과를 버린다
    if (mySeq !== trxLoadSeq) return;
    const allTrx = snap.docs.map(d=>({id:d.id,...d.data()}));
    S.transactions = allTrx.sort((a,b)=>{
      const oA=a.sortOrder!=null?a.sortOrder:99999;
      const oB=b.sortOrder!=null?b.sortOrder:99999;
      if(oA!==oB)return oA-oB;
      const dtA=(a.date||'')+(a.time?' '+a.time:'');
      const dtB=(b.date||'')+(b.time?' '+b.time:'');
      return dtA.localeCompare(dtB);
    });
    S.activeClient=clientId; S.trxRange=range; S.page=1; S.sortKey='date'; S.sortDir='asc';
    Trx.rebuildAccountFilter();
    Trx.applyFilters();
    // 거래가 다시 로드됐으니 보고서 전용 캐시는 낡았다
    Rpt.invalidateReportTrxCache(clientId);
    Rpt.syncReportTrxList();
  } catch(e) {
    if (mySeq === trxLoadSeq) toast('거래 로드 실패: '+e.message,'error');
  }
  // 뒤늦게 끝난 조회가 로딩 표시를 꺼서 진행 중인 조회를 가리지 않도록
  if (mySeq === trxLoadSeq) showLoading(false);
}

export function rebuildSelectors() {
  ['h-client','r-client','a-client'].forEach(id=>{
    const sel=document.getElementById(id); if(!sel)return;
    const prev=sel.value;
    sel.innerHTML='<option value="">입주자 선택...</option>';
    S.clients.forEach(c=>sel.add(new Option(c.name,c.id)));
    if (S.clients.some(c=>c.id===prev)) sel.value=prev;
  });
  Trx.rebuildAccountFilter();
}

/** 좁은 화면(휴대폰)인지 — CSS 미디어 쿼리와 같은 기준을 쓴다 */
export function isNarrowScreen() {
  return window.matchMedia('(max-width:768px)').matches;
}

/**
 * 화면이 좁아지면 PC 전용 화면에서 빠져나온다.
 * 태블릿을 세로로 돌리거나 창을 줄이면 보고서 화면이 조작 불가 상태로 남기 때문.
 */
export function watchViewportForDesktopOnlyViews() {
  const mq = window.matchMedia('(max-width:768px)');
  const onChange = (e) => {
    if (!e.matches) return;
    const current = ['report','settings'].find(v => {
      const el = document.getElementById('view-' + v);
      return el && el.style.display !== 'none';
    });
    if (current) changeView('dashboard');
  };
  // Safari 13 이하는 addEventListener를 지원하지 않는다
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/**
 * 좁은 화면에서 숨기는 화면들.
 * 보고서·결재는 표와 결재란이 많아 휴대폰에서 읽기 어렵다는 현장 판단에 따라
 * PC 전용으로 두고, 휴대폰에서는 조회와 수기입력만 노출한다.
 */
const DESKTOP_ONLY_VIEWS = { report: '보고서', settings: '설정' };

export function changeView(view) {
  if(view==='management') view='settings';
  if((view==='report'&&!can('nav.report'))||(view==='settings'&&!can('nav.settings'))){
    toast('접근 권한이 없습니다.','error'); return;
  }
  if(DESKTOP_ONLY_VIEWS[view] && isNarrowScreen()){
    toast(`${DESKTOP_ONLY_VIEWS[view]}는 PC에서 이용해 주세요.`,'info',4000);
    return;
  }
  if(view==='annual'){ changeView('report'); switchRptSubtab('annual'); return; }
  if(view!=='report'){
    const ra=document.getElementById('report-area');
    if(ra)ra.style.display='none';
    S.reportData=null;
  }
  ['dashboard','history','report','settings'].forEach(v=>{
    const el=document.getElementById('view-'+v); if(el)el.style.display=v===view?'block':'none';
  });
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.querySelector(`.nav-item[data-view="${view}"]`)?.classList.add('active');
  // 모바일 하단 네비게이션도 동기화
  document.querySelectorAll('.mobile-nav-item').forEach(b=>b.classList.remove('active'));
  document.querySelector(`.mobile-nav-item[data-view="${view}"]`)?.classList.add('active');
  const titles={
    dashboard: ['대시보드','관리 중인 입주자를 선택하세요'],
    history:   ['거래 내역','입주자별 거래 내역'],
    report:    ['보고서','월별 금전관리 보고서'],
    settings:  ['설정','입주자·계좌·카테고리·시스템 설정'],
  };
  const [t,s]=titles[view]||['',''];
  setText('view-title',t); setText('view-sub',s);
  if (view==='dashboard') { Dash.renderDashboard(); Rpt.refreshPendingApprovalBadge(); }
  if (view==='settings')  {
    // 캐시된 데이터로 즉시 렌더 (CRUD 시 부분 갱신으로 최신 상태 유지).
    // 어떤 패널을 그릴지는 initSettingsTabs가 세운 셸이 정한다 —
    // 여기서 renderManagement를 직접 부르면 열려 있지 않은 탭까지 그린다.
    Settings.loadSettings();
  }
  if (view==='report')    { Rpt.loadReportList(); switchRptSubtab('monthly'); }
}

export function switchRptSubtab(tab){
  ['monthly','annual'].forEach(t=>{
    const panel=document.getElementById('rpt-subtab-'+t);
    if(panel)panel.style.display=t===tab?'block':'none';
  });
  document.querySelectorAll('.rpt-subtab').forEach(btn=>{
    const isActive=btn.dataset.subtab===tab;
    btn.style.borderBottom=isActive?'2px solid var(--blue)':'none';
    btn.style.color=isActive?'var(--blue)':'var(--muted)';
    btn.style.marginBottom=isActive?'-2px':'0';
    btn.classList.toggle('active',isActive);
  });
  if(tab==='annual'){
    const cl=document.getElementById('a-client');
    if(cl&&!cl.options.length){S.clients.forEach(c=>cl.add(new Option(c.name,c.id)));}
    const yl=document.getElementById('a-year');
    if(yl&&!yl.options.length){const cy=new Date().getFullYear();for(let y=cy;y>=cy-5;y--)yl.add(new Option(y+'년',y));}
  }
}
