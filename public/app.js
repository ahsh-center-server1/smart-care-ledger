/**
 * Smart Care Ledger v2.x — Entry Point (모듈화 리팩토링)
 *
 * ES6 Native Modules 구조:
 *   state.js / constants.js / utils/ui.js
 *   services/firestore.js / services/image.js / services/storage.js
 *   modules/auth / dashboard / transactions / report / settings / modals
 *
 * 이 파일(app.js)은 다음만 담당한다:
 *   1) 모듈 import
 *   2) ExcelParser (파서 로직 · parser-config.js와 연동)
 *   3) Firebase 준비 / 세션 / 기본 데이터 로드
 *   4) Core 흐름 위임 (fetchBaseData / loadTransactions / changeView → modules/core.js)
 *   5) 모바일 뷰
 *   6) HTML onclick 호환을 위한 window 전역 노출
 *   7) 이벤트 바인딩
 */

'use strict';

// ─────────────────────────────────────────────
// 모듈 import
// ─────────────────────────────────────────────
import { S } from './state.js';
import {
  COLS, CAT_COLORS, cs,
  STATUS_LABELS, STATUS_CLASSES,
} from './constants.js';
import { toast, showConfirm, closeConfirm, setText, showLoading } from './utils/ui.js';
import { fb, fdb } from './services/firestore.js';
import { compressImage } from './services/image.js';
import { uploadToStorage } from './services/storage.js';

import * as Auth     from './modules/auth.js';
import * as Core     from './modules/core.js';
import * as Dash     from './modules/dashboard.js';
import * as Trx      from './modules/transactions.js';
import * as Rpt      from './modules/report.js';
import * as Settings from './modules/settings.js';
import * as SettingsDerived from './modules/settings-derived.js';
import * as Modals   from './modules/modals.js';
import * as Fixed    from './modules/fixed-items.js';
import * as Parser   from './services/excel-parser.js';
import { initFontScale, setFontScale } from './modules/font-scale.js';

// ─────────────────────────────────────────────
// ExcelParser — services/excel-parser.js로 옮겼다.
//
// 예전에는 파서 290줄이 여기 있었고, 설정 파일(parser-config.js)은 classic script라
// 모듈인 이 파일에 도달하지 못했다. 실제로 쓰이던 설정은 여기 있던 복제본이었고
// 두 벌이 따로 놀았다. 이제 설정은 parser-config.js 한 벌이고 파서가 그것을 import한다.
//
// 이 별칭은 window 전역과 기존 호출부 호환을 위해 남긴다.
// ─────────────────────────────────────────────
const ExcelParser = Parser;
window.ExcelParser = ExcelParser;

// ─────────────────────────────────────────────
// Firebase 준비 훅 (index.html에서 호출)
// ─────────────────────────────────────────────
window.onFirebaseReady = function() {
  // 세션 복원은 Firebase Auth가 담당한다.
  //
  // 예전 구현은 sessionStorage의 JSON을 검증 없이 신뢰하면서, 정작 쓰지도 않는
  // Firebase Auth 세션을 검사했다. signInWithCustomToken을 호출하는 곳이
  // 없었으므로 auth.currentUser는 항상 null이고 조건이 언제나 참이 되어
  // **새로고침하면 무조건 로그아웃**됐다.
  Auth.watchAuthState(async (loggedIn) => {
    if (loggedIn) {
      await Auth._enterApp();
    } else {
      document.getElementById('login-view').style.display='flex';
      document.getElementById('app-view').style.display='none';
    }
  });
};

// fetchBaseData, isConfirmedLocked, loadTransactions, rebuildSelectors, changeView, switchRptSubtab
// → modules/core.js로 이동됨


// 글자 크기 설정은 modules/font-scale.js로 옮겼다.
// 종전 2단계 토글(body.large-text + sessionStorage)은 요소별 px 오버라이드를
// 손으로 나열하는 구조라 새 UI를 만들 때마다 빠지는 곳이 생겼고, 탭을 닫으면
// 설정이 사라져 매번 다시 눌러야 했다. 3단계 + localStorage + 변수 기반으로 대체.


// ─────────────────────────────────────────────
// HTML onclick / 모듈간 호환용 window 전역 노출
// ─────────────────────────────────────────────
Object.assign(window, {
  // 상태 및 유틸
  S, COLS, CAT_COLORS, cs, STATUS_LABELS, STATUS_CLASSES,
  fb, fdb,
  toast, showConfirm, closeConfirm, setText, showLoading,
  compressImage, uploadToStorage,
  // core.js 코어 (명시적 import)
  fetchBaseData: Core.fetchBaseData,
  loadTransactions: Core.loadTransactions,
  rebuildSelectors: Core.rebuildSelectors,
  changeView: Core.changeView,
  switchRptSubtab: Core.switchRptSubtab,
  isConfirmedLocked: Core.isConfirmedLocked,
  ExcelParser,
  // 글자 크기 3단계
  setFontScale,
  // auth
  handleLogin: Auth.handleLogin, handleLogout: Auth.handleLogout, handleSignup: Auth.handleSignup,
  // dashboard
  renderDashboard: Dash.renderDashboard, renderClientCards: Dash.renderDashboard,
  // transactions
  rebuildAccountFilter: Trx.rebuildAccountFilter,
  applyFilters: Trx.applyFilters,
  renderHistoryTable: Trx.renderHistoryTable,
  openCatDropdown: Trx.openCatDropdown,
  closeCatDropdowns: Trx.closeCatDropdowns,
  renderCalendarView: Trx.renderCalendarView,
  showCalendarDayDetail: Trx.showCalendarDayDetail,
  openModalWithDate: Trx.openModalWithDate,
  moveCalendar: Trx.moveCalendar,
  saveCatChange: Trx.saveCatChange,
  renderPagination: Trx.renderPagination,
  applyPeriod: Trx.applyPeriod,
  resetFilters: Trx.resetFilters,
  moveTrxRow: Trx.moveTrxRow,
  saveTrx: Trx.saveTrx,
  delTrx: Trx.delTrx,
  exportFilteredCSV: Trx.exportFilteredCSV,
  confirmBulkDelete: Trx.confirmBulkDelete,
  editTrx: Trx.editTrx,
  updateAccBalance: Trx.updateAccBalance,
  reorderTrx: Trx.reorderTrx,
  // report
  generateRuleBasedSummary: Rpt.generateRuleBasedSummary,
  loadAnnual: Rpt.loadAnnual,
  loadReport: Rpt.loadReport,
  renderReportView: Rpt.renderReportView,
  renderRptTrxTable: Rpt.renderRptTrxTable,
  applyRptSort: Rpt.applyRptSort,
  updateRptSortArrows: Rpt.updateRptSortArrows,
  syncReportTrxList: Rpt.syncReportTrxList,
  reorderRptTrx: Rpt.reorderRptTrx,
  renderRptBankStatements: Rpt.renderRptBankStatements,
  openBankStatementsForApproval: Rpt.openBankStatementsForApproval,
  openBankStatementFromReport: Rpt.openBankStatementFromReport,
  renderComments: Rpt.renderComments,
  saveComment: Rpt.saveComment,
  renderTrendChart: Rpt.renderTrendChart,
  handleGenSummary: Rpt.handleGenSummary,
  renderApproval: Rpt.renderApproval,
  doApproval: Rpt.doApproval,
  doApprovalAsLeader: Rpt.doApprovalAsLeader,
  doReject: Rpt.doReject,
  doTeamApproveProxy: Rpt.doTeamApproveProxy,
  doRevertToDraft: Rpt.doRevertToDraft,
  doDeleteReport: Rpt.doDeleteReport,
  recallReport: Rpt.recallReport,
  loadReportList: Rpt.loadReportList,
  refreshPendingApprovalBadge: Rpt.refreshPendingApprovalBadge,
  exportReportExcel: Rpt.exportReportExcel,
  // settings
  renderManagement: Settings.renderManagement,
  renderUserManagement: Settings.renderUserManagement,
  renderClientManagement: Settings.renderClientManagement,
  renderAccountManagement: Settings.renderAccountManagement,
  toggleClientActive: Settings.toggleClientActive,
  toggleAccountActive: Settings.toggleAccountActive,
  toggleStaffActive: Settings.toggleStaffActive,
  confirmDelete: Settings.confirmDelete,
  loadSettings: Settings.loadSettings,
  renderCatTags: Settings.renderCatTags,
  renderRuleTags: Settings.renderRuleTags,
  updateRuleCatSel: Settings.updateRuleCatSel,
  addCategory: Settings.addCategory,
  deleteCategory: Settings.deleteCategory,
  addRule: Settings.addRule,
  deleteRule: Settings.deleteRule,
  resetCategories: Settings.resetCategories,
  loadArchiveHistory: Settings.loadArchiveHistory,
  confirmArchive: Settings.confirmArchive,
  executeArchive: Settings.executeArchive,
  initBudgetSection: Settings.initBudgetSection,
  loadBudgetForm: Settings.loadBudgetForm,
  saveBudget: Settings.saveBudget,
  executeFirebaseReset: Settings.executeFirebaseReset,
  // modals
  openModal: Modals.openModal,
  closeModal: Modals.closeModal,
  renderTrxForm: Modals.renderTrxForm,
  updateTrxCatSel: Modals.updateTrxCatSel,
  renderExcelForm: Modals.renderExcelForm,
  downloadManualTemplate: Modals.downloadManualTemplate,
  onXlFileSelect: Modals.onXlFileSelect,
  analyzeXlFile: Modals.analyzeXlFile,
  renderXlPreview: Modals.renderXlPreview,
  removeXlItem: Modals.removeXlItem,
  saveExcelData: Modals.saveExcelData,
  renderReceiptUploadForm: Modals.renderReceiptUploadForm,
  onReceiptFileSelect: Modals.onReceiptFileSelect,
  doReceiptUpload: Modals.doReceiptUpload,
  openReceiptUpload: Modals.openReceiptUpload,
  openReceiptModal: Modals.openReceiptModal,
  closeReceiptModal: Modals.closeReceiptModal,
  renderFixedItemForm: Fixed.renderFixedItemForm,
  loadFixedItems: Fixed.loadFixedItems,
  applyFixedItems: Fixed.applyFixedItems,
  saveFixedItem: Fixed.saveFixedItem,
  deleteFixedItem: Fixed.deleteFixedItem,
  renderFixedItemsList: Fixed.renderFixedItemsList,
  printReceiptSheet: Modals.printReceiptSheet,
  openBankStatementModal: Modals.openBankStatementModal,
  renderBankStatementsList: Modals.renderBankStatementsList,
  uploadBankStatements: Modals.uploadBankStatements,
  renderClientForm: Modals.renderClientForm,
  renderAccountForm: Modals.renderAccountForm,
  renderStaffForm: Modals.renderStaffForm,
});

// window 전역 노출이 완료된 후 Firebase 준비 여부 확인
// (Object.assign 이전에 호출하면 window.fetchBaseData 등이 미설정 상태)
if (window._fbReady) window.onFirebaseReady();

// ─────────────────────────────────────────────
// 이벤트 바인딩
// ─────────────────────────────────────────────
function bindEvents(){
  // 글자 크기 설정 — 저장값을 DOM과 맞추고 세그먼트 컨트롤을 그린다.
  // (페인트 전 적용은 index.html의 인라인 스크립트가 이미 했다)
  initFontScale();
  // 화면이 좁아지면 PC 전용 화면(보고서·설정)에서 빠져나온다
  Core.watchViewportForDesktopOnlyViews();
  // 로그인
  document.getElementById('login-id')?.addEventListener('keydown',e=>{if(e.key==='Enter')Auth.handleLogin();});
  document.getElementById('login-pw')?.addEventListener('keydown',e=>{if(e.key==='Enter')Auth.handleLogin();});
  document.getElementById('login-btn')?.addEventListener('click',Auth.handleLogin);
  // 회원가입 폼 전환
  document.getElementById('goto-signup')?.addEventListener('click',e=>{
    e.preventDefault();
    document.getElementById('login-form').style.display='none';
    document.getElementById('signup-form').style.display='flex';
    document.getElementById('login-err').style.display='none';
    document.getElementById('login-err').style.color='var(--red)';
  });
  document.getElementById('goto-login')?.addEventListener('click',e=>{
    e.preventDefault();
    document.getElementById('signup-form').style.display='none';
    document.getElementById('login-form').style.display='flex';
    document.getElementById('login-err').style.display='none';
    document.getElementById('login-err').style.color='var(--red)';
  });
  document.getElementById('signup-id')?.addEventListener('keydown',e=>{if(e.key==='Enter')Auth.handleSignup();});
  document.getElementById('signup-pw')?.addEventListener('keydown',e=>{if(e.key==='Enter')Auth.handleSignup();});

  // 네비게이션 (사이드바)
  document.querySelectorAll('.nav-item[data-view]').forEach(btn=>btn.addEventListener('click',()=>Core.changeView(btn.dataset.view)));
  
  // 모바일 하단 네비게이션
  document.querySelectorAll('.mobile-nav-item[data-view]').forEach(btn=>btn.addEventListener('click',()=>{
    Core.changeView(btn.dataset.view);
    // 모바일 네비 active 상태 업데이트
    document.querySelectorAll('.mobile-nav-item').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
  }));
  
  document.addEventListener('click',e=>{
    if(e.target.classList.contains('rpt-subtab'))Core.switchRptSubtab(e.target.dataset.subtab);
  });

  // 거래 모달 열기
  document.getElementById('btn-trx')?.addEventListener('click',()=>Modals.openModal('trx'));
  document.getElementById('btn-excel')?.addEventListener('click',()=>Modals.openModal('excel'));
  document.getElementById('btn-h-trx')?.addEventListener('click',()=>Modals.openModal('trx'));
  document.getElementById('btn-h-excel')?.addEventListener('click',()=>Modals.openModal('excel'));
  document.getElementById('btn-h-receipt-intake')?.addEventListener('click',()=>Modals.openModal('receipt-intake'));

  // 모달 닫기
  document.getElementById('modal-close-btn')?.addEventListener('click',Modals.closeModal);

  // 거래내역 도구
  document.getElementById('btn-csv-export')?.addEventListener('click',Trx.exportFilteredCSV);
  document.getElementById('btn-trx-view-toggle')?.addEventListener('click',()=>{
    S.trxViewMode=S.trxViewMode==='list'?'calendar':'list';
    S.calendarYM='';
    const btn=document.getElementById('btn-trx-view-toggle');
    if(btn)btn.textContent=S.trxViewMode==='calendar'?'☰ 목록':'🗓️ 달력';
    Trx.renderHistoryTable();
  });
  document.getElementById('btn-bulk-del')?.addEventListener('click',Trx.confirmBulkDelete);
  document.getElementById('btn-filter-reset')?.addEventListener('click',Trx.resetFilters);
  document.getElementById('btn-h-fixed')?.addEventListener('click',Fixed.applyFixedItems);
  document.getElementById('btn-h-receipt-print')?.addEventListener('click',Modals.printReceiptSheet);

  // 정렬 헤더
  document.querySelectorAll('[data-sort]').forEach(th=>th.addEventListener('click',()=>{
    const k=th.dataset.sort;
    S.sortDir=S.sortKey===k&&S.sortDir==='desc'?'asc':'desc';
    S.sortKey=k; S.page=1;
    Trx.applyFilters();
  }));
  document.querySelectorAll('[data-rpt-sort]').forEach(th=>th.addEventListener('click',()=>{
    const k=th.dataset.rptSort;
    S.rptSortDir=S.rptSortKey===k&&S.rptSortDir==='desc'?'asc':'desc';
    S.rptSortKey=k;
    if(S.reportData?.trxList){
      Rpt.renderRptTrxTable(Rpt.applyRptSort(S.reportData.trxList));
      Rpt.updateRptSortArrows();
    }
  }));

  // 기간/필터
  document.querySelectorAll('.period-btn').forEach(btn=>btn.addEventListener('click',()=>{
    Trx.applyPeriod(btn.dataset.p);
    document.querySelectorAll('.period-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
  }));
  document.getElementById('h-client')?.addEventListener('change',()=>{
    const v=document.getElementById('h-client').value;
    const accSel=document.getElementById('h-account');
    if(accSel)accSel.value='';
    if(v)Core.loadTransactions(v);
    else{
      S.transactions=[]; S.filteredTrx=[]; S.activeClient=null;
      Trx.renderHistoryTable(); Trx.rebuildAccountFilter();
    }
  });
  // 필터가 바뀌면 1페이지로 — 그러지 않으면 5페이지에서 결과를 좁혔을 때 빈 표가 뜬다.
  // 날짜 칸은 change에만 건다. input에도 걸면 연도를 타이핑하는 중간값(0002-01-01)이
  // 범위 확장 조건을 만족해 **키 입력마다 전체 이력 조회가 발사되고**,
  // change와 겹쳐 필터가 두 번 실행된다.
  const onFilter=()=>Trx.applyFilters({resetPage:true});
  ['h-search'].forEach(id=>document.getElementById(id)?.addEventListener('input',onFilter));
  ['h-account','h-type','h-receipt','h-start','h-end']
    .forEach(id=>document.getElementById(id)?.addEventListener('change',onFilter));
  document.getElementById('check-all')?.addEventListener('click',e=>{
    document.querySelectorAll('.row-check').forEach(c=>c.checked=e.target.checked);
  });
  document.addEventListener('click',function(e){
    if(!e.target.closest('.cat-chip')&&!e.target.closest('.cat-dd')){Trx.closeCatDropdowns();}
  });

  // 기본 기간(이번 달)
  (()=>{
    const now=new Date(),y=now.getFullYear(),m=now.getMonth();
    const fmt=dt=>dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
    const s=document.getElementById('h-start'),e=document.getElementById('h-end');
    if(s)s.value=fmt(new Date(y,m,1));
    if(e)e.value=fmt(new Date(y,m+1,0));
  })();

  // 보고서 — r-year/r-month 초기화 (옵션이 없으면 loadReport에서 year=0/month=0으로 읽힘)
  (()=>{
    const ySel=document.getElementById('r-year'),mSel=document.getElementById('r-month');
    if(!ySel||!mSel)return;
    const cy=new Date().getFullYear(),cm=new Date().getMonth()+1;
    for(let y=cy;y>=cy-5;y--)ySel.add(new Option(y+'년',y)); ySel.value=cy;
    for(let m=1;m<=12;m++)mSel.add(new Option(m+'월',m)); mSel.value=cm;
  })();
  document.getElementById('btn-annual-load')?.addEventListener('click',Rpt.loadAnnual);
  document.getElementById('btn-rpt-load')?.addEventListener('click',Rpt.loadReport);
  document.getElementById('btn-rpt-list-refresh')?.addEventListener('click',()=>Rpt.loadReportList({force:true}));
  // 목록은 기본적으로 올해·작년만 읽는다(읽기 비용). 그 이전을 보려면 켠다.
  document.getElementById('rpt-list-all-years')?.addEventListener('change',e=>{
    S.rptListAllYears=e.target.checked;
    Rpt.loadReportList({force:true});
  });
  // 저장된 보고서 토글 (기본: 숨김)
  document.getElementById('btn-rpt-list-toggle')?.addEventListener('click',()=>{
    const list=document.getElementById('rpt-list');
    const arrow=document.getElementById('rpt-list-arrow');
    const refresh=document.getElementById('btn-rpt-list-refresh');
    if(!list)return;
    const isHidden=list.style.display==='none'||list.style.display==='';
    if(isHidden){
      list.style.display='flex';
      if(arrow)arrow.textContent='▼';
      if(refresh)refresh.style.display='';
    } else {
      list.style.display='none';
      if(arrow)arrow.textContent='▶';
      if(refresh)refresh.style.display='none';
    }
  });
  document.getElementById('btn-gen-summary')?.addEventListener('click',Rpt.handleGenSummary);
  document.getElementById('rpt-summary-print')?.addEventListener('change',e=>{
    const area=document.getElementById('rpt-summary-print-area');
    if(area)area.style.display=e.target.checked?'block':'none';
  });

  // 설정 탭
  document.getElementById('btn-add-staff')?.addEventListener('click',()=>Modals.openModal('staff'));
  document.getElementById('btn-add-client')?.addEventListener('click',()=>Modals.openModal('client'));
  document.getElementById('btn-add-account')?.addEventListener('click',()=>Modals.openModal('account'));
  document.getElementById('btn-add-exp-cat')?.addEventListener('click',()=>Settings.addCategory('지출',document.getElementById('settings-client-sel')?.value||''));
  document.getElementById('btn-add-inc-cat')?.addEventListener('click',()=>Settings.addCategory('수입',document.getElementById('settings-client-sel')?.value||''));
  document.getElementById('btn-add-rule')?.addEventListener('click',Settings.addRule);
  document.getElementById('btn-reset-cats')?.addEventListener('click',Settings.resetCategories);
  document.getElementById('btn-archive')?.addEventListener('click',Settings.confirmArchive);
  document.getElementById('btn-archive-refresh')?.addEventListener('click',Settings.loadArchiveHistory);
  document.getElementById('btn-rebuild-derived')?.addEventListener('click',SettingsDerived.rebuildDerivedDocs);
  document.getElementById('new-rule-type')?.addEventListener('change',Settings.updateRuleCatSel);
  ['new-exp-cat','new-inc-cat','new-rule-kw'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{
      if(e.key==='Enter'){
        if(id==='new-exp-cat')Settings.addCategory('지출',document.getElementById('settings-client-sel')?.value||'');
        else if(id==='new-inc-cat')Settings.addCategory('수입',document.getElementById('settings-client-sel')?.value||'');
        else Settings.addRule();
      }
    });
  });
}

// ─────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindEvents);
} else {
  bindEvents();
}
