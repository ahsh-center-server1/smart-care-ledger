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
import { fetchMonthlySummaries, currentMonth } from '../services/summary.js';
import { fetchStaffDirectory, fetchCategoryDirectory } from '../services/directory.js';
import { countUnenteredFixed } from '../domain/monthly-summary.js';
import { sortTrx } from '../domain/trx-order.js';
import { registerCategoryColors } from '../domain/category-color.js';
import { fetchInScope } from '../services/scoped-fetch.js';
import * as Dash     from './dashboard.js';
import * as Trx      from './transactions.js';
import * as Rpt      from './report.js';
import * as Settings from './settings.js';
import { can, hasLoadedIdentity } from './permissions.js';

/** 지금 로그인한 사람의 조회 범위. 규칙이 보는 것과 같은 근거(authz)를 쓴다. */
export function myScope(field) {
  const identity = hasLoadedIdentity() ? S.authz : null;
  const ids = identity?.role === '팀장' ? identity.leaderClientIds
    : identity?.role ? identity.accessibleClientIds : [];
  return { all: can('client.view.all'), ids: ids || [], field: field || null };
}

/**
 * 기본 데이터 로드.
 * @param {Object} [opts]
 * @param {string[]} [opts.only] - 갱신할 컬렉션만 명시 ('users'|'clients'|'accounts'|'categories'|'reports'|'monthlyStats')
 *                                  미지정 시 전체 로드 (로그인·새로고침용)
 */
export async function fetchBaseData(opts) {
  const { getDoc, doc } = fb();
  // 담당 입주자만 볼지 전체를 볼지 — 네비게이션 메뉴 권한이 아니라 전용 키로 판정한다.
  // 예전에는 can('nav.staff')를 썼기 때문에 팀장의 메뉴 표시를 끄면
  // 팀장이 전 입주자를 못 보게 되는 숨은 부작용이 있었다.
  if (!hasLoadedIdentity()) throw new Error('권한 정보를 확인할 수 없습니다. 다시 로그인하세요.');
  const db=fdb();
  const only = opts && Array.isArray(opts.only) ? new Set(opts.only) : null;
  const need = key => !only || only.has(key);

  // 각 컬렉션을 필요한 경우에만 fetch (병렬)
  const tasks = [];
  // 직원·분류는 **파생 명부 문서 1건**으로 읽는다(services/directory.js).
  // 예전에는 컬렉션을 통째로 읽어 직원 25명 + 분류 60개 = 85 읽기였고,
  // 그것이 로그인마다 전 역할에 걸렸다. 명부가 없거나 낡으면 컬렉션 직접
  // 조회로 떨어지므로 트리거 미배포·실패가 화면을 깨뜨리지 않는다.
  if (need('users'))      tasks.push(['users',      fetchStaffDirectory()]);
  if (need('categories')) tasks.push(['categories', fetchCategoryDirectory()]);
  // 입주자·계좌는 명부로 만들지 않는다.
  //   · 앱이 이 두 컬렉션의 **모든 필드**를 쓴다(설정 화면이 연락처·메모·계좌번호·
  //     기초잔액을 편집한다). 부분 명부로는 그 화면이 깨진다.
  //   · accounts.bankStatements는 통장 사진 URL 배열이라 해마다 늘어난다.
  //     전 계좌를 한 문서에 담으면 1 MiB 한도에 부딪힐 수 있고, 그때 명부 쓰기가
  //     조용히 실패해 명부가 낡은 채로 남는다.
  //   좁히려면 로그인용 필드만 담고 설정 화면이 원본을 따로 읽게 해야 한다.
  if (need('clients'))    tasks.push(['clients',    fetchInScope(db, COLS.CLIENTS, myScope())]);
  if (need('accounts'))   tasks.push(['accounts',   fetchInScope(db, COLS.ACCOUNTS, myScope('clientId'))]);
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
    S.users = snapMap.users.rows.map(u=>({...u, team: u.team || ''}));
  }
  if (snapMap.categories) {
    S.categories = snapMap.categories.rows;
    // 색을 한 곳에 등록해 둔다. cs() 가 이름만 들고 불리는 자리가 열 곳
    // 남짓이라, 호출부마다 분류 문서를 찾아 넘기게 하면 한 곳만 빠뜨려도
    // 같은 분류가 화면마다 다른 색이 된다.
    registerCategoryColors(S.categories);
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
    const clientScope = myScope();
    S.clients = activeClients.filter(c => clientScope.all || clientScope.ids.includes(c.id));
    S.accounts = activeAccounts.filter(a=>S.clients.some(c=>c.id===a.clientId));
  }

  if (snapMap.lockedMonths) {
    // 문서가 없으면(최초 배포·백필 전) 빈 집합이 된다. 그 상태에서는 잠금이 걸리지
    // 않으므로, 관리자가 설정에서 「마감 색인 재생성」을 눌러 백필해야 한다.
    const data = snapMap.lockedMonths.exists() ? snapMap.lockedMonths.data() : null;
    const months = (data && data.months) || {};
    S.confirmedMonths = new Set(Object.keys(months).filter(k => months[k]));
    // 제출된 달 — 삭제만 막는다(수정은 회수하면 된다). 규칙이 보는 것과 같은
    // 색인이라, 여기서 버튼을 숨기면 서버 거부와 어긋나지 않는다.
    const submitted = (data && data.submittedMonths) || {};
    S.submittedMonths = new Set(Object.keys(submitted).filter(k => submitted[k]));
  }

  // 당월 수입/지출 집계 (대시보드 카드 표시용)
  // 본인 담당 입주자만 쿼리하여 read 절감 (Firestore 'in' 절은 최대 30개)
  //
  // **거래를 쓰는 사람만 읽는다.** 이 숫자는 장부를 쓰는 사람이 오늘 무엇을
  // 더 해야 하는지 보는 것(미분류 몇 건, 고정항목 몇 건 남았나)이다. 팀장·
  // 센터장은 거래를 입력하지 않으므로(작성자와 결재자의 분리 — CLAUDE.md §4)
  // 이 카드로 할 일이 생기지 않고, 결재할 숫자는 보고서에서 본다.
  //
  // 읽기로도 이것이 센터장 한 세션에서 가장 큰 항목이다 — 전 입주자의 요약
  // 캐시 + 낡은 것의 재계산이라, 입주자가 늘면 그대로 늘어난다.
  // tools/read-budget.mjs 로 확인할 수 있다.
  if (need('monthlyStats')) {
    if (!can('trx.create')) {
      // **읽지 않았다는 것을 null 로 남긴다.** {} 로 두면 대시보드 카드가
      // 「당월 거래 없음」이라고 적는다 — 읽지 않은 것을 0으로 보고하는 셈이고,
      // 결재자가 그것을 보고 "이 사람은 이번 달 거래가 없구나" 로 읽는다.
      S.monthlyStats = null; S.fixedGap = null; S.allFixedItems = [];
    } else { try {
      const ym = currentMonth();
      const myClientIds = S.clients.map(c => c.id);

      // 당월 요약은 **캐시 문서 1건**으로 읽는다.
      //
      // 예전에는 담당 입주자 전원의 당월 거래를 전부 읽어 합산했다. 관리자가
      // 입주자 30명을 보면 한 세션에 1,200건이고, 하루 두 번 접속하는 사람이
      // 25명이면 그것만으로 무료 한도의 절반을 썼다
      // (tools/read-budget.mjs 로 모델을 볼 수 있다).
      //
      // 캐시가 없거나 낡았으면 그 입주자만 직접 계산한다 —
      // 서버 트리거가 배포되지 않았어도 **값은 항상 맞는다.**
      const { summaries } = await fetchMonthlySummaries(myClientIds, ym);

      const mStats = {};
      S.clients.forEach(c => {
        const sm = summaries[c.id] || { inc: 0, exp: 0, unclassified: 0 };
        // partial: 입력자가 본인 입력분만 합산한 값. 카드가 라벨을 바꿔 표시한다.
        mStats[c.id] = {
          inc: sm.inc, exp: sm.exp, partial: !!sm.partial,
          unclassified: Number(sm.unclassified || 0),
        };
      });
      S.monthlyStats = mStats;

      // 필수 고정항목 미납 카운트
      try {
        const fSnap = await fetchInScope(db, COLS.FIXED_ITEMS, myScope('clientId'));
        S.allFixedItems = fSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const unpaid = {};
        S.clients.forEach(c => {
          const mine = S.allFixedItems.filter(f => f.clientId === c.id);
          unpaid[c.id] = countUnenteredFixed(mine, (summaries[c.id] || {}).paidFixedIds);
        });
        S.fixedGap = unpaid;
      } catch (e) { S.allFixedItems = []; S.fixedGap = {}; }
    } catch (e) {
      // 집계 실패가 로그인을 막지는 않는다 — 카드가 잔액만 보여주고 나머지는
      // 동작한다. 여기서도 {} 가 아니라 null 이다: 실패한 것과 0인 것은 다르다.
      console.warn('[core] 당월 집계 실패:', e);
      S.monthlyStats = null; S.fixedGap = null;
    } }
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
 * 제출된 달인가 — **삭제만** 막는다.
 *
 * isConfirmedLocked 와 달리 lock.bypass 로 우회하지 않는다. 그 권한은 아무도
 * 갖지 않고(FORBIDDEN_KEYS), 설령 생기더라도 "마감 월 편집"이지 "결재 중인
 * 달의 삭제"가 아니다.
 *
 * 근거는 서버 규칙이 읽는 바로 그 색인(config/lockedMonths.submittedMonths)이다.
 * 다른 근거를 쓰면 버튼은 보이는데 서버가 거부한다.
 */
export function isSubmittedLocked(clientId, dateStr){
  const ym=(dateStr||'').substring(0,7);
  if(ym.length!==7)return false;
  return !!(S.submittedMonths?.has(lockKey(clientId, ym.substring(0,4), ym.substring(5,7))));
}

/**
 * 이 거래를 지울 수 없는 이유. 지울 수 있으면 null.
 *
 * 단건 삭제와 일괄 삭제가 같은 질문을 따로 물으면 언젠가 한쪽만 고쳐진다.
 * 규칙도 같은 두 색인(마감·제출)을 보므로, 여기가 서버 거부와 어긋나지 않는
 * 유일한 자리다. 문구는 **어떻게 푸는지**까지 말한다 — 못 한다는 말만
 * 남기면 사용자가 다음에 할 일을 모른다.
 */
export function trxDeleteBlockReason(trx){
  if(!trx)return null;
  if(isConfirmedLocked(trx.clientId,trx.date))
    return '최종 결재 완료된 월의 거래는 삭제할 수 없습니다. (센터장이 결재를 취소하면 다시 편집할 수 있어요.)';
  if(isSubmittedLocked(trx.clientId,trx.date))
    return '결재 중인 월의 거래는 삭제할 수 없습니다. 보고서를 회수한 뒤 삭제하세요.';
  return null;
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
  const clientScope = myScope();
  if (!hasLoadedIdentity() || (!clientScope.all && !clientScope.ids.includes(clientId))) {
    toast('담당 범위 밖의 거래는 조회할 수 없습니다.', 'error'); return;
  }
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
    // 장부 순서는 domain/trx-order.js 하나다 — 세 벌로 흩어져 있었고,
    // 한 곳만 고치면 같은 거래가 화면마다 다른 자리에 나타났다.
    S.transactions = sortTrx(allTrx);
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
    const current = ['report'].find(v => {
      const el = document.getElementById('view-' + v);
      return el && el.style.display !== 'none';
    });
    if (current) changeView('dashboard');
    const settings = document.getElementById('view-settings');
    if (settings && settings.style.display !== 'none') changeView('settings');
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
const DESKTOP_ONLY_VIEWS = { report: '보고서' };

export function changeView(view) {
  if(view==='management') view='settings';
  if((view==='report'&&!can('nav.report'))||(view==='settings'&&!hasLoadedIdentity())){
    toast('접근 권한이 없습니다.','error'); return;
  }
  if(DESKTOP_ONLY_VIEWS[view] && isNarrowScreen()){
    toast(`${DESKTOP_ONLY_VIEWS[view]}는 PC에서 이용해 주세요.`,'info',4000);
    return;
  }
  if(view==='annual'){ changeView('report'); switchRptSubtab('annual'); return; }
  if(view!=='report'){
    // 화면만 감춘다. **버리지 않는다** — 예전에는 여기서 S.reportData=null 이라
    // 대시보드에서 숫자 하나 보고 돌아오면 입주자·연·월을 다시 고르고 조회를
    // 다시 눌러야 했다. 돌아올 때 무엇을 보고 있었는지로 다시 조회한다
    // (낡은 숫자를 그대로 보여주지 않으려고 계산 결과는 다시 만든다).
    const ra=document.getElementById('report-area');
    if(ra)ra.style.display='none';
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
    S.settingsGuideOnly = isNarrowScreen() || !can('nav.settings');
    if (S.settingsGuideOnly) {
      Settings.initSettingsTabs();
      Settings.switchSettingsTab('permissions');
    } else {
      Settings.loadSettings();
    }
  }
  if (view==='report')    { Rpt.loadReportList(); switchRptSubtab('monthly'); Rpt.restoreOpenReport(); }
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
