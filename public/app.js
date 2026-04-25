/**
 * Smart Care Ledger v2.x — Entry Point (모듈화 리팩토링)
 *
 * ES6 Native Modules 구조:
 *   state.js / constants.js / utils/ui.js
 *   services/firestore.js / services/drive.js
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
  GOOGLE_OAUTH_CLIENT_ID, DRIVE_FOLDER_ID,
} from './constants.js';
import { toast, showConfirm, closeConfirm, setText, showLoading } from './utils/ui.js';
import { fb, fdb } from './services/firestore.js';
import { compressImage, getDriveToken, uploadToDrive } from './services/drive.js';

import * as Auth     from './modules/auth.js';
import { initPermissions } from './modules/permissions.js';
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
    let s=val.replace(/[\.\/]/g,'-').trim();
    if (s.includes(' ')) s=s.split(' ')[0];
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
window.onFirebaseReady = async function() {
  const saved = sessionStorage.getItem('scl_user');
  if (saved) {
    try {
      S.user=JSON.parse(saved);
      const { auth } = window._fbAuth || {};
      if (auth && !auth.currentUser) {
        // Firebase Auth 세션 없음 — 재로그인 필요
        sessionStorage.removeItem('scl_user');
        throw new Error('Firebase Auth session expired');
      }
      await initPermissions();
      await Auth._enterApp();
      return;
    }
    catch(e) { sessionStorage.removeItem('scl_user'); }
  }
  document.getElementById('login-view').style.display='flex';
};

// fetchBaseData, isConfirmedLocked, loadTransactions, rebuildSelectors, changeView, switchRptSubtab
// → modules/core.js로 이동됨

// ─────────────────────────────────────────────
// 모바일 뷰
// ─────────────────────────────────────────────
let M={clientId:null,clients:[],transactions:[],accounts:[]};

function isMobile(){return window.innerWidth<=768&&('ontouchstart' in window||navigator.maxTouchPoints>0);}

function initMobileApp(){
  document.getElementById('app-view').style.display='none';
  const mv=document.getElementById('mobile-view');
  if(mv)mv.style.display='flex';
  if(S.user?.role==='입력자'){
    document.getElementById('m-tab-report')?.style?.setProperty('display','none');
  }
  const avatarEl=document.getElementById('m-avatar');
  if(avatarEl)avatarEl.textContent=(S.user?.name||'?').charAt(0);
  mobileView('dashboard');
}

function mobileView(tab){
  ['dashboard','history','trx-form','report'].forEach(t=>{
    const el=document.getElementById('m-'+t);
    if(el)el.style.display=t===tab?'block':'none';
  });
  document.querySelectorAll('.m-tab').forEach(b=>{
    b.style.color='var(--muted)';
  });
  const tabMap={'dashboard':0,'history':1,'trx-form':2,'report':3};
  const tabs=document.querySelectorAll('.m-tab');
  if(tabs[tabMap[tab]])tabs[tabMap[tab]].style.color='var(--blue)';
  const titles={dashboard:'대시보드',history:'거래내역',report:'보고서','trx-form':'수기 입력'};
  const titleEl=document.getElementById('m-title');
  if(titleEl)titleEl.textContent=titles[tab]||tab;
  if(tab==='dashboard')renderMobileDashboard();
  else if(tab==='history')renderMobileHistoryView();
  else if(tab==='trx-form')renderMobileTrxForm();
  else if(tab==='report')renderMobileReportList();
}

async function renderMobileDashboard(){
  const grid=document.getElementById('m-client-grid');
  if(!grid)return;
  if(!S.clients.length){grid.innerHTML='<div style="font-size:13px;color:var(--muted);grid-column:span 2;">입주자가 없습니다.</div>';return;}
  grid.innerHTML=S.clients.map(c=>{
    const accs=S.accounts.filter(a=>a.clientId===c.id);
    const totalBal=accs.reduce((s,a)=>s+Number(a.currentBalance||a.initialBalance||0),0);
    return `<div onclick="mobileSelectClient('${c.id}')" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;cursor:pointer;transition:box-shadow .15s;" onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,.1)'" onmouseout="this.style.boxShadow='none'">
      <div style="width:36px;height:36px;border-radius:50%;background:var(--blue);color:#fff;font-weight:900;font-size:16px;display:flex;align-items:center;justify-content:center;margin-bottom:8px;">${(c.name||'?').charAt(0)}</div>
      <div style="font-size:14px;font-weight:700;color:var(--text);">${c.name}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px;">${accs.length}개 계좌</div>
      <div style="font-size:13px;font-weight:700;color:var(--blue);margin-top:6px;">${totalBal.toLocaleString()}원</div>
    </div>`;
  }).join('');
}

async function mobileSelectClient(clientId){
  M.clientId=clientId;
  const c=S.clients.find(x=>x.id===clientId);
  const nameEl=document.getElementById('m-client-name');
  if(nameEl)nameEl.textContent=c?.name||'';
  const accSel=document.getElementById('m-acc-filter');
  if(accSel){
    accSel.innerHTML='<option value="">전체 계좌</option>';
    S.accounts.filter(a=>a.clientId===clientId).forEach(a=>accSel.add(new Option(a.label,a.id)));
  }
  const typeSel=document.getElementById('m-type-filter');
  if(typeSel)typeSel.value='';
  const monthSel=document.getElementById('m-month-filter');
  if(monthSel)monthSel.value='';
  showLoading(true);
  try{
    const{getDocs,collection,query,where}=fb();
    const snap=await getDocs(query(collection(fdb(),COLS.TRANSACTIONS),where('clientId','==',clientId)));
    M.transactions=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    if(S.user?.role==='입력자')M.transactions=M.transactions.filter(t=>t.createdBy===S.user.userId);
  }catch(e){toast('로드 실패: '+e.message,'error');}
  showLoading(false);
  mobileView('history');
}

function renderMobileHistoryView(){
  renderMobileHistory();
}

function renderMobileHistory(){
  const accFilter=document.getElementById('m-acc-filter')?.value||'';
  const typeFilter=document.getElementById('m-type-filter')?.value||'';
  const monthFilter=document.getElementById('m-month-filter')?.value||'';
  let trx=M.transactions;
  if(accFilter)trx=trx.filter(t=>t.accountId===accFilter);
  if(typeFilter)trx=trx.filter(t=>t.type===typeFilter);
  if(monthFilter)trx=trx.filter(t=>(t.date||'').startsWith(monthFilter));
  const container=document.getElementById('m-trx-list');
  if(!container)return;
  if(!trx.length){container.innerHTML='<div style="font-size:13px;color:var(--muted);text-align:center;padding:24px;">거래내역이 없습니다.</div>';return;}
  container.innerHTML=trx.slice(0,200).map(t=>{
    const acc=S.accounts.find(a=>a.id===t.accountId)?.label||'';
    const isIn=t.amountIn>0;
    const amt=isIn?'+'+Number(t.amountIn).toLocaleString():'-'+Number(t.amountOut||0).toLocaleString();
    const amtColor=isIn?'#10b981':'#ef4444';
    const receiptBtn=t.receiptUrl?`<button onclick="event.stopPropagation();openReceiptModal('${t.receiptUrl}')" style="font-size:12px;color:#f59e0b;font-weight:700;background:none;border:none;cursor:pointer;padding:0 2px;" title="영수증 보기">📎</button>`:'';
    const cardId='mtrx-'+t.id;
    return `<div id="${cardId}" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;cursor:default;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.description||'-'} ${receiptBtn}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px;">${t.date||''} · ${acc} · ${t.category||''}</div>
        </div>
        <div style="font-size:14px;font-weight:800;color:${amtColor};white-space:nowrap;">${amt}원</div>
      </div>
    </div>`;
  }).join('');
}

function renderMobileTrxForm(){
  const body=document.getElementById('m-form-body');
  if(!body)return;
  if(!M.clientId){
    body.innerHTML='<div style="font-size:13px;color:var(--muted);">먼저 대시보드에서 입주자를 선택하세요.</div>';
    return;
  }
  const accs=S.accounts.filter(a=>a.clientId===M.clientId);
  const expCats=[...new Set(S.categories.filter(c=>c.type==='지출'&&c.keyword===''&&(!c.clientId||c.clientId===M.clientId)).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(c=>c.category))];
  const incCats=[...new Set(S.categories.filter(c=>c.type==='수입'&&c.keyword===''&&(!c.clientId||c.clientId===M.clientId)).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(c=>c.category))];
  body.innerHTML=`
    <div><label class="label">날짜</label><input type="date" id="mf-date" class="input" value="${new Date().toISOString().substring(0,10)}"></div>
    <div><label class="label">계좌</label><select id="mf-acc" class="input" style="padding:8px;">${accs.map(a=>`<option value="${a.id}">${a.label}</option>`).join('')}</select></div>
    <div><label class="label">구분</label><select id="mf-type" class="input" style="padding:8px;" onchange="updateMFormCats()"><option value="지출">지출</option><option value="수입">수입</option></select></div>
    <div><label class="label">카테고리</label><select id="mf-cat" class="input" style="padding:8px;">${expCats.map(c=>`<option value="${c}">${c}</option>`).join('')}</select></div>
    <div><label class="label">내용</label><input type="text" id="mf-desc" class="input" placeholder="내용을 입력하세요"></div>
    <div><label class="label">금액</label><input type="number" id="mf-amt" class="input" placeholder="0" min="0"></div>
    <div>
      <label class="label">영수증 첨부</label>
      <label style="display:flex;align-items:center;justify-content:center;gap:8px;border:2px dashed var(--border);border-radius:10px;padding:14px;cursor:pointer;color:var(--muted);font-size:13px;background:var(--bg);">
        📎 <span id="mf-receipt-name">사진 선택 (선택)</span>
        <input type="file" id="mf-receipt" accept="image/*" style="display:none;" onchange="const f=this.files[0];document.getElementById('mf-receipt-name').textContent=f?f.name:'사진 선택 (선택)';">
      </label>
    </div>
    <button onclick="submitMobileTrx()" class="btn" style="width:100%;padding:13px;font-size:15px;">💾 저장</button>`;
  window._mExpCats=expCats; window._mIncCats=incCats;
}

function updateMFormCats(){
  const type=document.getElementById('mf-type')?.value;
  const cats=type==='수입'?window._mIncCats:window._mExpCats;
  const sel=document.getElementById('mf-cat');
  if(sel){sel.innerHTML=cats.map(c=>`<option value="${c}">${c}</option>`).join('');}
}

async function submitMobileTrx(){
  const date=document.getElementById('mf-date')?.value;
  const accountId=document.getElementById('mf-acc')?.value;
  const type=document.getElementById('mf-type')?.value;
  const category=document.getElementById('mf-cat')?.value;
  const description=document.getElementById('mf-desc')?.value;
  const amount=Number(document.getElementById('mf-amt')?.value)||0;
  if(!date||!accountId||!amount){toast('날짜, 계좌, 금액을 입력하세요.','error');return;}
  let receiptUrl='';
  const receiptFile=document.getElementById('mf-receipt')?.files[0];
  if(receiptFile){
    try{
      showLoading(true);
      receiptUrl=await uploadToDrive(receiptFile);
    }catch(e){toast('영수증 업로드 실패: '+e.message,'error');}
    finally{showLoading(false);}
  }
  const data={
    clientId:M.clientId,accountId,date,type,category,description,
    amountIn:type==='수입'?amount:0,amountOut:type==='지출'?amount:0,
    receiptUrl,createdBy:S.user?.userId||'',sortOrder:Date.now()
  };
  await Trx.saveTrx(data);
  const{getDocs,collection,query,where}=fb();
  const snap=await getDocs(query(collection(fdb(),COLS.TRANSACTIONS),where('clientId','==',M.clientId)));
  M.transactions=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  if(S.user?.role==='입력자')M.transactions=M.transactions.filter(t=>t.createdBy===S.user.userId);
  document.getElementById('mf-desc').value='';
  document.getElementById('mf-amt').value='';
  document.getElementById('mf-receipt-name').textContent='사진 선택 (선택)';
  if(document.getElementById('mf-receipt'))document.getElementById('mf-receipt').value='';
  toast('저장됨','success');
}

async function renderMobileReportList(){
  if(S.user?.role==='입력자'){
    document.getElementById('m-report-list').innerHTML='<div style="font-size:13px;color:var(--muted);">접근 권한이 없습니다.</div>';
    return;
  }
  const container=document.getElementById('m-report-list');
  if(!container)return;
  container.innerHTML='<div style="font-size:13px;color:var(--muted);">로딩 중...</div>';
  const{getDocs,collection}=fb();
  const myClientIds=new Set(S.clients.map(c=>c.id));
  const snap=await getDocs(collection(fdb(),COLS.REPORTS));
  const list=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>myClientIds.has(r.clientId)).sort((a,b)=>`${b.year}-${b.month}`.localeCompare(`${a.year}-${a.month}`));
  if(!list.length){container.innerHTML='<div style="font-size:13px;color:var(--muted);">보고서가 없습니다.</div>';return;}
  const STATUS_COLORS={'draft':'#94a3b8','submitted':'#f59e0b','team_approved':'#3b82f6','confirmed':'#10b981','rejected':'#ef4444'};
  container.innerHTML='';
  list.slice(0,50).forEach(r=>{
    const c=S.clients.find(x=>x.id===r.clientId);
    const label=STATUS_LABELS[r.status]||r.status;
    const color=STATUS_COLORS[r.status]||'#94a3b8';
    const div=document.createElement('div');
    div.style.cssText='background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:background .15s;';
    div.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;">
      <div><div style="font-size:14px;font-weight:700;color:var(--text);">${c?.name||'-'}</div><div style="font-size:12px;color:var(--muted);">${r.year}년 ${r.month}월</div></div>
      <div style="display:flex;align-items:center;gap:8px;"><span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;background:${color}22;color:${color};">${label}</span><span style="color:var(--muted);font-size:16px;">›</span></div>
    </div>`;
    div.addEventListener('click',()=>renderMobileReportDetail(r));
    container.appendChild(div);
  });
}

async function updateReportDoc(reportId, fields){
  const{doc,updateDoc}=fb();
  await updateDoc(doc(fdb(),COLS.REPORTS,reportId),fields);
}

async function renderMobileReportDetail(report){
  const listArea=document.getElementById('m-report-list-area');
  const detailArea=document.getElementById('m-report-detail');
  const content=document.getElementById('m-report-content');
  const actionsEl=document.getElementById('m-report-actions');
  if(!listArea||!detailArea||!content||!actionsEl)return;
  listArea.style.display='none';
  detailArea.style.display='block';
  content.innerHTML='<div style="font-size:13px;color:var(--muted);">로딩 중...</div>';
  actionsEl.innerHTML='';
  const{getDocs,collection,query,where}=fb();
  const snap=await getDocs(query(collection(fdb(),COLS.TRANSACTIONS),where('clientId','==',report.clientId)));
  const allTrx=snap.docs.map(d=>({id:d.id,...d.data()}));
  const ym=`${report.year}-${String(report.month).padStart(2,'0')}`;
  const trxList=allTrx.filter(t=>(t.date||'').startsWith(ym)&&t.type!=='취소'&&t.type!=='자산이동').sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
  const totalIn=trxList.reduce((s,t)=>s+(t.amountIn||0),0);
  const totalOut=trxList.reduce((s,t)=>s+(t.amountOut||0),0);
  const client=S.clients.find(c=>c.id===report.clientId)||{name:'-'};
  const STATUS_COLORS={'draft':'#94a3b8','submitted':'#f59e0b','team_approved':'#3b82f6','confirmed':'#10b981','rejected':'#ef4444'};
  const color=STATUS_COLORS[report.status]||'#94a3b8';
  const label=STATUS_LABELS[report.status]||report.status;
  const catMap={};
  trxList.filter(t=>t.type==='지출').forEach(t=>{const k=t.category||'기타';catMap[k]=(catMap[k]||0)+(t.amountOut||0);});
  const catRows=Object.entries(catMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;"><span style="color:var(--text);">${k}</span><span style="font-weight:700;color:#b91c1c;">${v.toLocaleString()}원</span></div>`).join('');
  content.innerHTML=`
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-size:16px;font-weight:800;color:var(--text);">${client.name}</div>
        <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;background:${color}22;color:${color};">${label}</span>
      </div>
      <div style="font-size:13px;color:var(--muted);">${report.year}년 ${report.month}월</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px;text-align:center;"><div style="font-size:10px;font-weight:700;color:#16a34a;margin-bottom:3px;">총 수입</div><div style="font-size:15px;font-weight:900;color:#15803d;">${totalIn.toLocaleString()}원</div></div>
      <div style="background:#fff1f2;border:1px solid #fecaca;border-radius:10px;padding:12px;text-align:center;"><div style="font-size:10px;font-weight:700;color:#dc2626;margin-bottom:3px;">총 지출</div><div style="font-size:15px;font-weight:900;color:#b91c1c;">${totalOut.toLocaleString()}원</div></div>
    </div>
    ${catRows?`<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:10px;"><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px;">분류별 지출 (상위 5)</div>${catRows}</div>`:''}
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:10px;">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px;">거래 내역 (${trxList.length}건)</div>
      ${trxList.slice(0,30).map(t=>{const isIn=t.amountIn>0;const amt=isIn?'+'+t.amountIn.toLocaleString():'-'+(t.amountOut||0).toLocaleString();return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);"><div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.description||'-'}</div><div style="font-size:10px;color:var(--muted);">${t.date} · ${t.category||''}</div></div><div style="font-size:12px;font-weight:700;color:${isIn?'#10b981':'#ef4444'};white-space:nowrap;margin-left:8px;">${amt}원</div></div>`;}).join('')}
      ${trxList.length>30?`<div style="font-size:11px;color:var(--muted);text-align:center;padding:8px;">+${trxList.length-30}건 더 있음</div>`:''}
    </div>
    ${report.staffComment?`<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;margin-bottom:8px;font-size:12px;"><b style="color:#92400e;">담당자 의견:</b> <span style="color:#78350f;">${report.staffComment}</span></div>`:''}
    ${report.leaderComment?`<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px;margin-bottom:8px;font-size:12px;"><b style="color:#1e40af;">팀장 의견:</b> <span style="color:#1e3a8a;">${report.leaderComment}</span></div>`:''}
    ${report.centerComment?`<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px;margin-bottom:8px;font-size:12px;"><b style="color:#065f46;">센터장 의견:</b> <span style="color:#14532d;">${report.centerComment}</span></div>`:''}`;
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
  const rptClient=S.clients.find(c=>c.id===report.clientId);
  const tlId=String(rptClient?.teamLeader||'');
  const isMyClient=String(rptClient?.userIds||'').split(',').map(s=>s.trim()).includes(userId)||rptClient?.teamLeader===userId||false;
  const buttons=[];
  if(report.status==='draft'&&isMyClient){
    buttons.push({label:'📤 제출',color:'#3b82f6',action:async()=>{
      const comment=prompt('담당자 의견 (선택사항):','');
      await updateReportDoc(report.id,{status:'submitted',submittedAt:Date.now(),submittedBy:userId,submittedByName:S.user.name||userId,staffComment:comment||report.staffComment||''});
      toast('제출되었습니다.','success');
      report.status='submitted';report.staffComment=comment||report.staffComment||'';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
  }
  if(report.status==='rejected'&&isMyClient){
    buttons.push({label:'📤 재제출',color:'#3b82f6',action:async()=>{
      const comment=prompt('담당자 의견:','');
      await updateReportDoc(report.id,{status:'submitted',submittedAt:Date.now(),submittedBy:userId,submittedByName:S.user.name||userId,staffComment:comment||report.staffComment||''});
      toast('재제출되었습니다.','success');
      report.status='submitted';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
  }
  if(report.status==='submitted'&&(role==='팀장'||role==='센터장'||role==='관리자')&&(role!=='팀장'||userId===tlId)){
    buttons.push({label:'✅ 팀장 결재',color:'#10b981',action:async()=>{
      const comment=prompt('팀장 의견 (선택사항):','');
      await updateReportDoc(report.id,{status:'team_approved',teamApprovedAt:Date.now(),teamApprovedBy:userId,teamApprovedByName:S.user.name||userId,leaderComment:comment||report.leaderComment||''});
      toast('팀장 결재 완료','success');
      report.status='team_approved';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
    buttons.push({label:'↩ 반려',color:'#ef4444',action:async()=>{
      const comment=prompt('반려 사유:','');
      if(!comment)return;
      await updateReportDoc(report.id,{status:'rejected',rejectedAt:Date.now(),rejectedBy:userId,rejectedByName:S.user.name||userId,leaderComment:comment});
      toast('반려되었습니다.','success');
      report.status='rejected';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
  }
  if(report.status==='team_approved'&&(role==='센터장'||role==='관리자')){
    buttons.push({label:'✅ 최종 결재',color:'#10b981',action:async()=>{
      const comment=prompt('센터장 의견 (선택사항):','');
      await updateReportDoc(report.id,{status:'confirmed',centerApprovedAt:Date.now(),centerApprovedBy:userId,centerApprovedByName:S.user.name||userId,centerComment:comment||report.centerComment||''});
      toast('최종 결재 완료','success');
      report.status='confirmed';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
    buttons.push({label:'↩ 반려',color:'#ef4444',action:async()=>{
      const comment=prompt('반려 사유:','');
      if(!comment)return;
      await updateReportDoc(report.id,{status:'rejected',rejectedAt:Date.now(),rejectedBy:userId,rejectedByName:S.user.name||userId,centerComment:comment});
      toast('반려되었습니다.','success');
      report.status='rejected';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
  }
  buttons.forEach(b=>{
    const btn=document.createElement('button');
    btn.textContent=b.label;
    btn.style.cssText=`padding:13px;font-size:15px;font-weight:700;border:none;border-radius:10px;cursor:pointer;background:${b.color};color:#fff;`;
    btn.addEventListener('click',b.action);
    actionsEl.appendChild(btn);
  });
}

// ─────────────────────────────────────────────
// HTML onclick / 모듈간 호환용 window 전역 노출
// ─────────────────────────────────────────────
Object.assign(window, {
  // 상태 및 유틸
  S, COLS, CAT_COLORS, cs, STATUS_LABELS, STATUS_CLASSES,
  fb, fdb,
  toast, showConfirm, closeConfirm, setText, showLoading,
  compressImage, getDriveToken, uploadToDrive,
  // core.js 코어 (명시적 import)
  fetchBaseData: Core.fetchBaseData,
  loadTransactions: Core.loadTransactions,
  rebuildSelectors: Core.rebuildSelectors,
  changeView: Core.changeView,
  switchRptSubtab: Core.switchRptSubtab,
  isConfirmedLocked: Core.isConfirmedLocked,
  ExcelParser,
  // 모바일
  isMobile, initMobileApp, mobileView,
  renderMobileDashboard, mobileSelectClient, renderMobileHistoryView, renderMobileHistory,
  renderMobileTrxForm, updateMFormCats, submitMobileTrx,
  renderMobileReportList, renderMobileReportDetail, updateReport: updateReportDoc,
  M,
  // auth
  handleLogin: Auth.handleLogin, handleLogout: Auth.handleLogout,
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
  matchExcelToTrx: Rpt.matchExcelToTrx,
  renderRptExcelComparison: Rpt.renderRptExcelComparison,
  openBankStatementFromReport: Rpt.openBankStatementFromReport,
  renderComments: Rpt.renderComments,
  saveComment: Rpt.saveComment,
  renderTrendChart: Rpt.renderTrendChart,
  handleGenSummary: Rpt.handleGenSummary,
  renderApproval: Rpt.renderApproval,
  doApproval: Rpt.doApproval,
  doApprovalAsLeader: Rpt.doApprovalAsLeader,
  doReject: Rpt.doReject,
  doRevertToDraft: Rpt.doRevertToDraft,
  doDeleteReport: Rpt.doDeleteReport,
  recallReport: Rpt.recallReport,
  loadReportList: Rpt.loadReportList,
  exportReportExcel: Rpt.exportReportExcel,
  // settings
  renderManagement: Settings.renderManagement,
  renderUserManagement: Settings.renderUserManagement,
  renderClientManagement: Settings.renderClientManagement,
  renderAccountManagement: Settings.renderAccountManagement,
  toggleClientActive: Settings.toggleClientActive,
  toggleAccountActive: Settings.toggleAccountActive,
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
  // 로그인
  document.getElementById('login-id')?.addEventListener('keydown',e=>{if(e.key==='Enter')Auth.handleLogin();});
  document.getElementById('login-pw')?.addEventListener('keydown',e=>{if(e.key==='Enter')Auth.handleLogin();});
  document.getElementById('login-btn')?.addEventListener('click',Auth.handleLogin);

  // 네비게이션
  document.querySelectorAll('.nav-item[data-view]').forEach(btn=>btn.addEventListener('click',()=>Core.changeView(btn.dataset.view)));
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
