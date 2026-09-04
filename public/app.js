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
import { toast, showConfirm, closeConfirm, setText, showLoading, escAttr } from './utils/ui.js';
import { fb, fdb } from './services/firestore.js';
import { compressImage } from './services/image.js';
import { uploadToStorage } from './services/storage.js';

import * as Auth     from './modules/auth.js';
import { can } from './modules/permissions.js';
import * as Core     from './modules/core.js';
import * as Dash     from './modules/dashboard.js';
import * as Trx      from './modules/transactions.js';
import * as Rpt      from './modules/report.js';
import * as Settings from './modules/settings.js';
import * as Modals   from './modules/modals.js';

// ─────────────────────────────────────────────
// ExcelParser — 은행별 엑셀/CSV/SMS XML/HTML-XLS 파서
// parser-config.js의 window.BANK_CONFIGS와 병합됨
// ─────────────────────────────────────────────
const ExcelParser = {
  _defaultConfig: {
    KB_BANK:    { DATE:'거래일시',  DESC:'보낸분/받는분',  WITHDRAW:'출금액',     DEPOSIT:'입금액'    },
    KB_CARD:    { DATE:'이용일',    DESC:'이용하신곳',      AMT:'국내이용금액'                         },
    NH_BANK:    { DATE:'거래일시',  DESC:'거래기록사항',    WITHDRAW:'출금금액',   DEPOSIT:'입금금액'  },
    NH_CARD:    { DATE:'이용일자',  DESC:'가맹점명',        AMT:'이용금액'                             },
    NH_CARD_AP: { DATE:'거래일자',  DESC:'가맹점명',        AMT:'거래금액'                             },
    WOORI_BANK: { DATE:'거래일시',  DESC:'기재내용',        WITHDRAW:'찾으신금액', DEPOSIT:'맡기신금액'},
    SH_BANK:    { DATE:'거래일자',  DESC:'내용',            WITHDRAW:'출금(원)',   DEPOSIT:'입금(원)'  },
    MANUAL:     { DATE:'날짜',      DESC:'내용',            WITHDRAW:'지출금액',   DEPOSIT:'입금금액'  },
  },
  get CONFIG() {
    const extra = window.BANK_CONFIGS || {};
    return Object.assign({}, this._defaultConfig, extra);
  },
  get NOISE_WORDS() {
    return window.PARSER_NOISE_WORDS || [
      '체크카드','CD공동','전자금융','장기카드','단기카드','일시불','승인',
      '비씨','BC','NH체크','KB체크','예금인출','체크우리','우리체크',
      '타행CD','CD이체','모바일','신한체','현금IC','체크신한',
    ];
  },
  get SMS_APPROVAL_KEYWORD() { return window.SMS_CONFIG?.APPROVAL_KEYWORD || 'NH카드'; },
  get SMS_SKIP_KEYWORDS()    { return window.SMS_CONFIG?.SKIP_KEYWORDS    || ['승인거절','인증번호','재충전','카드사용알림','패스워드']; },

  parseFile(file, categories) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const isCsv = file.name.toLowerCase().endsWith('.csv');
      reader.onload = (e) => {
        try {
          const raw = e.target.result;
          if (file.name.toLowerCase().endsWith('.xml')) {
            resolve(this._parseSmsXml(new TextDecoder('utf-8').decode(raw), categories)); return;
          }
          if (isCsv) {
            let text;
            try {text=new TextDecoder('utf-8').decode(raw);}catch(e){text=new TextDecoder('euc-kr').decode(raw);}
            if(text.charCodeAt(0)===0xFEFF)text=text.substring(1);
            const wb=XLSX.read(text,{type:'string'});
            resolve(this.parse(wb,categories)); return;
          }
          const firstBytes = new Uint8Array(raw, 0, 10);
          if (this._isHtmlFile(firstBytes)) {
            resolve(this._parseHtmlXls(new TextDecoder('utf-8').decode(raw), categories)); return;
          }
          resolve(this.parse(XLSX.read(raw, {type:'array'}), categories));
        } catch(err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('파일을 읽는 중 오류가 발생했습니다.'));
      reader.readAsArrayBuffer(file);
    });
  },

  _parseSmsXml(xmlText, categories) {
    const doc     = new DOMParser().parseFromString(xmlText, 'application/xml');
    const smsList = Array.from(doc.querySelectorAll('sms'));
    const result  = [];
    smsList.forEach(sms => {
      const body = sms.getAttribute('body')||'';
      if (!body.includes(this.SMS_APPROVAL_KEYWORD)) return;
      if (this.SMS_SKIP_KEYWORDS.some(kw=>body.includes(kw))) return;
      const lines = body.replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(l=>l&&l!=='[Web발신]');
      const desc  = lines[lines.length-1]||''; if (!desc) return;
      const amtLine = lines.find(l=>/\d+[,\d]*원/.test(l)); if (!amtLine) return;
      const amtMatch = amtLine.match(/([\d,]+)원/); if (!amtMatch) return;
      const outVal = this.toNum(amtMatch[1]); if (!outVal) return;
      const dateStr = this._fixReadableDate(sms.getAttribute('readable_date')||''); if (!dateStr) return;
      const cleanedDesc = this._cleanDesc(desc); if (!cleanedDesc) return;
      const matched = categories.find(c=>c.keyword&&cleanedDesc.includes(c.keyword));
      result.push({date:dateStr,desc:cleanedDesc,in:0,out:outVal,cat:matched?matched.category:'확인필요',sub:matched?matched.subcategory||'':''});
    });
    return result;
  },

  _fixReadableDate(val) {
    if (!val) return null;
    const parts = val.match(/(\d+)\.\s*(\d+)\.\s*(\d+)/); if (!parts) return null;
    const y=parts[1].padStart(4,'0'), m=parts[2].padStart(2,'0'), d=parts[3].padStart(2,'0');
    return parseInt(y)<2000?null:`${y}-${m}-${d}`;
  },

  _isHtmlFile(bytes) {
    for (let i=0;i<bytes.length;i++) {
      const ch=bytes[i];
      if (ch===0x20||ch===0x09||ch===0x0A||ch===0x0D) continue;
      return ch===0x3C;
    }
    return false;
  },

  _parseHtmlXls(htmlText, categories) {
    const doc    = new DOMParser().parseFromString(htmlText,'text/html');
    const result = [];
    doc.querySelectorAll('table').forEach(table => {
      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length<2) return;
      let headerIdx=-1, colIdx={date:-1,desc:-1,out:-1,in:-1};
      for (let i=0;i<rows.length;i++) {
        const cells = Array.from(rows[i].querySelectorAll('td,th')).map(td=>td.textContent.trim());
        const joined = cells.join('|');
        if (joined.includes('거래일시')&&joined.includes('출금액')) {
          headerIdx=i;
          cells.forEach((v,idx)=>{
            if (v.includes('거래일시'))                    colIdx.date=idx;
            if (v.includes('보낸분')||v.includes('적요'))  colIdx.desc=idx;
            if (v.includes('출금액'))                      colIdx.out=idx;
            if (v.includes('입금액'))                      colIdx.in=idx;
          });
          break;
        }
      }
      if (headerIdx===-1||colIdx.date===-1) return;
      for (let i=headerIdx+1;i<rows.length;i++) {
        const cells=Array.from(rows[i].querySelectorAll('td,th')).map(td=>td.textContent.trim());
        if (cells.length<3) continue;
        const dateStr=this.fixDate(cells[colIdx.date]||''); if (!dateStr) continue;
        let desc=(colIdx.desc!==-1?cells[colIdx.desc]:'')||cells[1]||'';
        desc=this._cleanDesc(desc);
        if (!desc||['소계','합계','조회'].some(k=>desc.includes(k))) continue;
        const outVal=this.toNum(colIdx.out!==-1?cells[colIdx.out]:'');
        const inVal =this.toNum(colIdx.in !==-1?cells[colIdx.in] :'');
        if (!inVal&&!outVal) continue;
        const matched=categories.find(c=>c.keyword&&desc.includes(c.keyword));
        result.push({date:dateStr,desc,in:inVal,out:outVal,cat:matched?matched.category:'확인필요',sub:matched?matched.subcategory||'':''});
      }
    });
    return result;
  },

  parse(workbook, categories) {
    let all=[];
    workbook.SheetNames.forEach(name=>{
      const rows=XLSX.utils.sheet_to_json(workbook.Sheets[name],{header:1,defval:''});
      if (rows.length) all=all.concat(this.processSingleSheet(rows,categories));
    });
    return all;
  },

  processSingleSheet(rows, categories) {
    let result=[], mode='', colIdx={date:-1,desc:-1,in:-1,out:-1}, startRow=-1;
    const cfg = this.CONFIG;

    for (let i=0; i<Math.min(rows.length,100); i++) {
      const row=rows[i]; if (!row||row.length<2) continue;
      const rc = row.map(c=>String(c||'').replace(/\s/g,'')).join('|');

      let detected = '';
      if      (rc.includes('거래일시')&&rc.includes('보낸분/받는분'))                         detected='KB_BANK';
      else if (rc.includes('이용일')&&(rc.includes('이용한곳')||rc.includes('이용하신곳')))   detected='KB_CARD';
      else if (rc.includes('거래일시')&&rc.includes('거래기록사항'))                           detected='NH_BANK';
      else if (rc.includes('거래일자')&&rc.includes('가맹점명')&&rc.includes('거래금액'))     detected='NH_CARD_AP';
      else if (rc.includes('이용일자')&&(rc.includes('가맹점명')||rc.includes('이용금액')))   detected='NH_CARD';
      else if (rc.includes('찾으신금액')&&rc.includes('맡기신금액'))                           detected='WOORI_BANK';
      else if (rc.includes('거래일자')&&rc.includes('출금(원)'))                               detected='SH_BANK';
      else if (rc.includes('날짜')&&(rc.includes('지출금액')||rc.includes('입금금액')))         detected='MANUAL';
      else {
        for (const key of Object.keys(cfg)) {
          const c=cfg[key]; if (!c.DATE) continue;
          const hasDate = rc.includes(c.DATE.replace(/\s/g,''));
          const hasAmt  = c.AMT      ? rc.includes(c.AMT.replace(/\s/g,''))
                        : c.WITHDRAW ? rc.includes(c.WITHDRAW.replace(/\s/g,''))
                        : false;
          if (hasDate&&hasAmt) { detected=key; break; }
        }
      }

      if (!detected) continue;
      mode = detected;
      const c = cfg[mode]; if (!c) continue;

      row.forEach((cell, idx) => {
        const raw = String(cell||'').trim();
        const val = raw.replace(/\s/g,'');
        if (c.DATE && val.includes(c.DATE.replace(/\s/g,''))) {
          colIdx.date = idx;
        }
        if (c.DESC) {
          const descKey = c.DESC.replace(/\s/g,'');
          if (val===descKey || val.includes(descKey)) colIdx.desc = idx;
        }
        if (colIdx.desc===-1 && (val.includes('가맹점')||val.includes('적요')||val.includes('기재내용')||val.includes('내용'))) {
          colIdx.desc = idx;
        }
        if (c.AMT && val.includes(c.AMT.replace(/\s/g,''))) {
          colIdx.out = idx;
        }
        if (c.WITHDRAW && val.includes(c.WITHDRAW.replace(/\s/g,''))) {
          colIdx.out = idx;
        }
        if (c.DEPOSIT && val.includes(c.DEPOSIT.replace(/\s/g,''))) {
          colIdx.in = idx;
        }
      });

      if (colIdx.date!==-1 && (colIdx.out!==-1 || colIdx.in!==-1)) {
        startRow = i+1;
        break;
      }
      mode=''; colIdx={date:-1,desc:-1,in:-1,out:-1};
    }

    if (startRow===-1||colIdx.date===-1) return [];

    for (let i=startRow; i<rows.length; i++) {
      const row=rows[i]; if (!row||row.length<2) continue;

      const rawDate = colIdx.date>=0 ? String(row[colIdx.date]||'') : '';
      const dateStr = this.fixDate(rawDate);
      if (!dateStr) continue;

      let inVal=0, outVal=0;
      if (colIdx.in>=0) {
        const rawIn  = this.toNumSigned(row[colIdx.in]);
        const rawOut = this.toNumSigned(row[colIdx.out]);
        if (rawIn  > 0) inVal  = rawIn;
        if (rawIn  < 0) outVal = Math.abs(rawIn);
        if (rawOut > 0) outVal = rawOut;
        if (rawOut < 0) inVal  = Math.abs(rawOut);
      } else if (colIdx.out>=0) {
        const rawOut = this.toNumSigned(row[colIdx.out]);
        if (rawOut >= 0) outVal = rawOut;
        else             inVal  = Math.abs(rawOut);
      }

      if (mode==='NH_CARD_AP') {
        const ci=this._findColIdx(rows[startRow-1],'취소여부');
        if (ci!==-1 && String(row[ci]||'').trim()!=='') continue;
      }

      const rawDesc = colIdx.desc>=0 ? String(row[colIdx.desc]||'') : '';
      let desc = rawDesc.trim();
      if (!desc||desc==='0') continue;
      if (['소계','합계','조회','합 계'].some(k=>desc.includes(k))) continue;
      desc = this._cleanDesc(desc);
      if (!desc) continue;

      if (!inVal&&!outVal) continue;

      const matched = categories.find(c=>c.keyword && desc.includes(c.keyword));
      result.push({
        date:dateStr, desc,
        in:inVal, out:outVal,
        cat: matched ? matched.category   : '확인필요',
        sub: matched ? matched.subcategory||'' : ''
      });
    }
    return result;
  },

  _findColIdx(headerRow, keyword) {
    if (!headerRow) return -1;
    return headerRow.findIndex(c=>String(c||'').replace(/\s/g,'').includes(keyword));
  },
  _cleanDesc(desc) {
    let s=desc;
    this.NOISE_WORDS.forEach(n=>{ if (s.includes(n)&&s.length>n.length) s=s.replace(n,'').trim(); });
    return s;
  },
  fixDate(val) {
    if (!val) return null;
    let s=String(val).replace(/[\.\/]/g,'-').trim();
    if (s.includes(' ')) s=s.split(' ')[0];
    // Excel 날짜 일련번호 처리 (CSV/xlsx 파싱 시 '2026-07-10'이 46213 같은 숫자로 변환됨)
    const serialM=s.match(/^(\d{5})(\.\d+)?$/);
    if (serialM) {
      const dt=new Date(Date.UTC(1899,11,30)+parseInt(serialM[1],10)*86400000);
      if (!isNaN(dt.getTime())&&dt.getUTCFullYear()>=2000)
        return dt.getUTCFullYear()+'-'+String(dt.getUTCMonth()+1).padStart(2,'0')+'-'+String(dt.getUTCDate()).padStart(2,'0');
    }
    if (!isNaN(s)&&s.length===8) s=s.substring(0,4)+'-'+s.substring(4,6)+'-'+s.substring(6,8);
    const d=new Date(s);
    if (isNaN(d.getTime())||d.getFullYear()<2000) return null;
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  },
  toNum(v) {
    if (v===undefined||v===null||v==='') return 0;
    const n=Number(String(v).replace(/[^0-9.-]/g,''));
    return isNaN(n)?0:Math.abs(n);
  },
  toNumSigned(v) {
    if (v===undefined||v===null||v==='') return 0;
    const n=Number(String(v).replace(/[^0-9.-]/g,''));
    return isNaN(n)?0:n;
  }
};
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


// ─────────────────────────────────────────────
// 큰 글씨 모드 (40~60대 가독성) — body.large-text 토글 + sessionStorage 기억
// ─────────────────────────────────────────────
function setLargeText(on){
  document.body.classList.toggle('large-text',on);
  const btn=document.getElementById('btn-large-text');
  if(btn){
    btn.classList.toggle('on',on);
    btn.setAttribute('aria-pressed',on?'true':'false');
    btn.innerHTML=on?'🔎 작은 글씨':'🔎 큰 글씨';
  }
  try{sessionStorage.setItem('scl_largeText',on?'1':'0');}catch(e){}
}
function toggleLargeText(){ setLargeText(!document.body.classList.contains('large-text')); }
function applyLargeTextPref(){
  let on=false;
  try{on=sessionStorage.getItem('scl_largeText')==='1';}catch(e){}
  if(on)setLargeText(true);
}


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
  // 큰 글씨 모드
  toggleLargeText,
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
  renderFixedItemForm: Modals.renderFixedItemForm,
  loadFixedItems: Modals.loadFixedItems,
  applyFixedItems: Modals.applyFixedItems,
  saveFixedItem: Modals.saveFixedItem,
  deleteFixedItem: Modals.deleteFixedItem,
  renderFixedItemsList: Modals.renderFixedItemsList,
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
  // 큰 글씨 모드 저장값 적용
  applyLargeTextPref();
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
  document.getElementById('btn-h-fixed')?.addEventListener('click',Modals.applyFixedItems);
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
  document.getElementById('h-account')?.addEventListener('change',Trx.applyFilters);
  ['h-search','h-start','h-end'].forEach(id=>document.getElementById(id)?.addEventListener('input',Trx.applyFilters));
  ['h-type','h-receipt','h-start','h-end'].forEach(id=>document.getElementById(id)?.addEventListener('change',Trx.applyFilters));
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
  document.getElementById('btn-rpt-list-refresh')?.addEventListener('click',Rpt.loadReportList);
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
