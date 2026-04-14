/**
 * Smart Care Ledger v2.2
 *
 * [수정] 버그 8가지 전체 수정
 *   1. 증빙 업로드 모달 완전 구현 (Google Drive OAuth + 업로드)
 *   2. 거래 수정 시 금액 필드 정확히 표시
 *   3. 카테고리 칩 텍스트 변경 로직 수정
 *   4. 일괄 삭제 후 체크박스 초기화
 *   5. 보고서 월별 추이 차트 추가
 *   6. 카테고리 중복 추가 방지
 *   7. 규칙 키워드 중복 방지
 *   8. 인쇄 시 AI 요약 포함/제외 정상 작동
 *
 * [추가] Google Drive 파일 업로드 → URL 자동 저장 (방법2)
 * [교체] AI 자동요약 → API 없는 규칙 기반 자동 분석
 * [분리] ExcelParser CONFIG → parser-config.js 별도 파일
 *
 * ★ 사전 설정 필요:
 *   GOOGLE_OAUTH_CLIENT_ID : Google Cloud Console에서 발급
 *   DRIVE_FOLDER_ID        : 영수증 저장할 Drive 폴더 ID
 */

'use strict';

// ─────────────────────────────────────────────
// ★ 설정값 — 본인 값으로 변경하세요
// ─────────────────────────────────────────────
const GOOGLE_OAUTH_CLIENT_ID = '731965168909-80uq0h2andcc0pnlk5knreuofq47ad9v.apps.googleusercontent.com';
const DRIVE_FOLDER_ID        = '1Qie2S1UvKhyYpgWmWfhpUaNFrqF1cT7c';

// ─────────────────────────────────────────────
// Firebase 헬퍼
// ─────────────────────────────────────────────
function fb()  { return window._fb; }
function fdb() { return window._fb.db; }

const COLS = {
  USERS:'users', CLIENTS:'clients', ACCOUNTS:'accounts',
  TRANSACTIONS:'transactions', CATEGORIES:'categories',
  REPORTS:'reports', CONFIG:'config',
  EXCEL_UPLOADS:'excelUploads',  // 엑셀 원본 Drive 저장 메타데이터
  BUDGETS:'budgets'              // 연간 예산
};

// ─────────────────────────────────────────────
// 전역 상태
// ─────────────────────────────────────────────
const S = {
  user: null,
  users: [], clients: [], accounts: [], categories: [],
  transactions: [], filteredTrx: [],
  activeClient: null,
  sortKey: 'date', sortDir: 'asc',   // ⑧ 기본 오름차순(과거→최신)
  rptSortKey: 'date', rptSortDir: 'asc', // 보고서 거래내역 정렬
  excelFile: null, excelMonth: '', excelRawRows: [], // 엑셀 원본 Drive 저장용
  page: 1, pageSize: 100,
  trxViewMode: 'list', // 'list' | 'calendar'
  calendarYM: '',      // 달력뷰 표시 연월 (YYYY-MM, 비면 filteredTrx 기준)
  excelTemp: [],
  settings: { expCats:[], incCats:[], rules:[] },
  rptChart: null, rptTrendChart: null,
  annualCharts: {},
  reportData: null,
  driveToken: null,
  driveTokenExpiry: null,
  fixedItems: [],          // ⑩ 고정항목
};

// ─────────────────────────────────────────────
// 카테고리 색상
// ─────────────────────────────────────────────
const CAT_COLORS = {
  '식비':    {bg:'#fef2f2',text:'#dc2626',dot:'#dc2626',border:'#fecaca'},
  '교통비':  {bg:'#eff6ff',text:'#2563eb',dot:'#2563eb',border:'#bfdbfe'},
  '의료비':  {bg:'#f0fdf4',text:'#16a34a',dot:'#16a34a',border:'#bbf7d0'},
  '생필품':  {bg:'#fff7ed',text:'#ea580c',dot:'#ea580c',border:'#fed7aa'},
  '여가비':  {bg:'#faf5ff',text:'#9333ea',dot:'#9333ea',border:'#e9d5ff'},
  '개인관리':{bg:'#fdf4ff',text:'#c026d3',dot:'#c026d3',border:'#f0abfc'},
  '의생활':  {bg:'#ecfdf5',text:'#059669',dot:'#059669',border:'#a7f3d0'},
  '세금공과':{bg:'#f8fafc',text:'#475569',dot:'#64748b',border:'#cbd5e1'},
  '교육비':  {bg:'#eff6ff',text:'#1d4ed8',dot:'#1d4ed8',border:'#bfdbfe'},
  '기타':    {bg:'#f8fafc',text:'#64748b',dot:'#94a3b8',border:'#e2e8f0'},
  '확인필요':{bg:'#fafaf9',text:'#78716c',dot:'#a8a29e',border:'#d6d3d1'},
  '수입':    {bg:'#f0fdf4',text:'#15803d',dot:'#15803d',border:'#bbf7d0'},
  '자산이동':{bg:'#f0f9ff',text:'#0369a1',dot:'#0ea5e9',border:'#bae6fd'},
  '취소':    {bg:'#fafafa',text:'#71717a',dot:'#a1a1aa',border:'#d4d4d8'},
};
function cs(cat) { return CAT_COLORS[cat]||{bg:'#f8fafc',text:'#475569',dot:'#94a3b8',border:'#e2e8f0'}; }

const STATUS_LABELS  = {'':'미저장','draft':'임시저장','submitted':'제출됨','team_approved':'팀장 결재완료','confirmed':'최종 결재완료','rejected':'반려됨'};
const STATUS_CLASSES = {'':'rs-draft','draft':'rs-draft','submitted':'rs-submitted','team_approved':'rs-team','confirmed':'rs-confirmed','rejected':'rs-rejected'};

// ─────────────────────────────────────────────
// ExcelParser — parser-config.js의 BANK_CONFIGS 사용
// ─────────────────────────────────────────────
const ExcelParser = {
  // ── 기본 은행 설정 (app.js 내장 — 로드 타이밍 문제 없음)
  // parser-config.js가 로드되면 window.BANK_CONFIGS로 자동 확장됨
  _defaultConfig: {
    KB_BANK:    { DATE:'거래일시',  DESC:'보낸분/받는분',  WITHDRAW:'출금액',     DEPOSIT:'입금액'    },
    KB_CARD:    { DATE:'이용일',    DESC:'이용하신곳',      AMT:'국내이용금액'                         },
    NH_BANK:    { DATE:'거래일시',  DESC:'거래기록사항',    WITHDRAW:'출금금액',   DEPOSIT:'입금금액'  },
    NH_CARD:    { DATE:'이용일자',  DESC:'가맹점명',        AMT:'이용금액'                             },
    NH_CARD_AP: { DATE:'거래일자',  DESC:'가맹점명',        AMT:'거래금액'                             },
    WOORI_BANK: { DATE:'거래일시',  DESC:'기재내용',        WITHDRAW:'찾으신금액', DEPOSIT:'맡기신금액'},
    SH_BANK:    { DATE:'거래일자',  DESC:'내용',            WITHDRAW:'출금(원)',   DEPOSIT:'입금(원)'  },
  },
  // parser-config.js의 BANK_CONFIGS와 내장 설정을 병합하여 반환
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
          // CSV: UTF-8 or EUC-KR 텍스트로 읽어서 XLSX로 파싱
          if (isCsv) {
            let text;
            try {text=new TextDecoder('utf-8').decode(raw);}catch(e){text=new TextDecoder('euc-kr').decode(raw);}
            // BOM 제거
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

    // ── 헤더 행 탐색 (최대 100행) ──
    for (let i=0; i<Math.min(rows.length,100); i++) {
      const row=rows[i]; if (!row||row.length<2) continue;
      // 공백 제거 후 셀 내용 합치기 (헤더 감지용)
      const rc = row.map(c=>String(c||'').replace(/\s/g,'')).join('|');

      // 1순위: 하드코딩된 은행별 헤더 패턴 감지
      let detected = '';
      if      (rc.includes('거래일시')&&rc.includes('보낸분/받는분'))                         detected='KB_BANK';
      else if (rc.includes('이용일')&&(rc.includes('이용한곳')||rc.includes('이용하신곳')))   detected='KB_CARD';
      else if (rc.includes('거래일시')&&rc.includes('거래기록사항'))                           detected='NH_BANK';
      else if (rc.includes('거래일자')&&rc.includes('가맹점명')&&rc.includes('거래금액'))     detected='NH_CARD_AP';
      else if (rc.includes('이용일자')&&(rc.includes('가맹점명')||rc.includes('이용금액')))   detected='NH_CARD';
      else if (rc.includes('찾으신금액')&&rc.includes('맡기신금액'))                           detected='WOORI_BANK';
      else if (rc.includes('거래일자')&&rc.includes('출금(원)'))                               detected='SH_BANK';
      else {
        // 2순위: parser-config.js에 추가된 새 은행 자동 감지
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

      // ── 컬럼 인덱스 매핑 ──
      // 버그수정: 원본 셀 값(공백 포함)과 공백제거 값 모두로 비교
      row.forEach((cell, idx) => {
        const raw = String(cell||'').trim();          // 원본(공백 trim만)
        const val = raw.replace(/\s/g,'');            // 공백 완전 제거

        // 날짜 컬럼
        if (c.DATE && val.includes(c.DATE.replace(/\s/g,''))) {
          colIdx.date = idx;
        }
        // 설명 컬럼: 정확히 일치하거나 부분 포함
        if (c.DESC) {
          const descKey = c.DESC.replace(/\s/g,'');
          if (val===descKey || val.includes(descKey)) colIdx.desc = idx;
        }
        // 설명 컬럼 폴백: 가맹점/적요/기재내용 포함
        if (colIdx.desc===-1 && (val.includes('가맹점')||val.includes('적요')||val.includes('기재내용')||val.includes('내용'))) {
          colIdx.desc = idx;
        }
        // 카드 이용금액 (AMT)
        if (c.AMT && val.includes(c.AMT.replace(/\s/g,''))) {
          colIdx.out = idx;
        }
        // 은행 출금 (WITHDRAW)
        if (c.WITHDRAW && val.includes(c.WITHDRAW.replace(/\s/g,''))) {
          colIdx.out = idx;
        }
        // 은행 입금 (DEPOSIT)
        if (c.DEPOSIT && val.includes(c.DEPOSIT.replace(/\s/g,''))) {
          colIdx.in = idx;
        }
      });

      // 날짜+금액 컬럼이 모두 확인된 경우에만 다음 행부터 데이터로 처리
      if (colIdx.date!==-1 && (colIdx.out!==-1 || colIdx.in!==-1)) {
        startRow = i+1;
        break;
      }
      // 이 행에서 감지 실패 → 초기화 후 계속 탐색
      mode=''; colIdx={date:-1,desc:-1,in:-1,out:-1};
    }

    if (startRow===-1||colIdx.date===-1) return [];

    // ── 데이터 행 추출 ──
    for (let i=startRow; i<rows.length; i++) {
      const row=rows[i]; if (!row||row.length<2) continue;

      // 날짜
      const rawDate = colIdx.date>=0 ? String(row[colIdx.date]||'') : '';
      const dateStr = this.fixDate(rawDate);
      if (!dateStr) continue;

      // 금액 — 부호 포함 읽기
      let inVal=0, outVal=0;
      if (colIdx.in>=0) {
        const rawIn  = this.toNumSigned(row[colIdx.in]);
        const rawOut = this.toNumSigned(row[colIdx.out]);
        if (rawIn  > 0) inVal  = rawIn;
        if (rawIn  < 0) outVal = Math.abs(rawIn);   // 입금란이 음수 = 취소
        if (rawOut > 0) outVal = rawOut;
        if (rawOut < 0) inVal  = Math.abs(rawOut);  // 출금란이 음수 = 취소(환불) → 수입
      } else if (colIdx.out>=0) {
        const rawOut = this.toNumSigned(row[colIdx.out]);
        if (rawOut >= 0) outVal = rawOut;
        else             inVal  = Math.abs(rawOut);  // 음수 출금 = 환불/취소 → 수입
      }

      // NH농협카드 취소 행 제외
      if (mode==='NH_CARD_AP') {
        const ci=this._findColIdx(rows[startRow-1],'취소여부');
        if (ci!==-1 && String(row[ci]||'').trim()!=='') continue;
      }

      // 설명
      const rawDesc = colIdx.desc>=0 ? String(row[colIdx.desc]||'') : '';
      let desc = rawDesc.trim();
      if (!desc||desc==='0') continue;
      if (['소계','합계','조회','합 계'].some(k=>desc.includes(k))) continue;
      desc = this._cleanDesc(desc);
      if (!desc) continue;

      // 금액이 둘 다 0이면 skip
      if (!inVal&&!outVal) continue;

      // 카테고리 매칭
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
  // 부호 포함 변환 (음수 = 취소/환불 감지용)
  toNumSigned(v) {
    if (v===undefined||v===null||v==='') return 0;
    const n=Number(String(v).replace(/[^0-9.-]/g,''));
    return isNaN(n)?0:n;
  }
};

// ─────────────────────────────────────────────
// Google Drive 업로드 (OAuth 2.0)
// ─────────────────────────────────────────────

/**
 * 이미지 파일을 Canvas로 압축
 * - 최대 너비/높이: 1200px (초과 시 비율 유지하며 축소)
 * - JPEG 품질: 0.78 (육안으로 거의 차이 없음, 용량 약 80~90% 감소)
 * - PDF, GIF 등 비이미지 파일은 그대로 반환
 */
function compressImage(file, maxPx=1200, quality=0.78) {
  return new Promise((resolve) => {
    // 이미지가 아니거나 GIF면 압축 없이 그대로 반환
    if (!file.type.startsWith('image/') || file.type === 'image/gif') {
      resolve(file); return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        // 원본 크기 확인
        let w = img.naturalWidth, h = img.naturalHeight;
        const origSize = file.size;

        // 최대 크기 초과 시 비율 유지하며 축소
        if (w > maxPx || h > maxPx) {
          if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else        { w = Math.round(w * maxPx / h); h = maxPx; }
        }

        // Canvas에 그려서 압축
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        // 흰 배경 (PNG 투명도 → JPEG 변환 시 검게 되는 문제 방지)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(blob => {
          if (!blob) { resolve(file); return; }
          // 압축 후가 더 크면 원본 반환 (매우 작은 파일의 경우)
          if (blob.size >= origSize) { resolve(file); return; }
          // 압축된 Blob을 File 객체로 변환 (확장자는 jpg로 통일)
          const baseName = file.name.replace(/\.[^.]+$/, '');
          const compressed = new File([blob], baseName + '_compressed.jpg', {
            type: 'image/jpeg', lastModified: Date.now()
          });
          const ratio = Math.round((1 - blob.size/origSize) * 100);
          console.log(`[압축] ${file.name}: ${(origSize/1024).toFixed(0)}KB → ${(blob.size/1024).toFixed(0)}KB (${ratio}% 감소)`);
          resolve(compressed);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file); // 이미지 로드 실패 시 원본 반환
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

/** Google OAuth 토큰 획득 (만료 시 자동 재발급) */
function getDriveToken() {
  return new Promise((resolve, reject) => {
    // 토큰이 있으면 재사용 (단, 만료 1분 전부터 재발급)
    if (S.driveToken && S.driveTokenExpiry && Date.now() < S.driveTokenExpiry - 60000) {
      resolve(S.driveToken); return;
    }
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google OAuth 라이브러리가 로드되지 않았습니다.')); return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope:     'https://www.googleapis.com/auth/drive.file',
      callback:  (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        S.driveToken       = resp.access_token;
        S.driveTokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        resolve(S.driveToken);
      }
    });
    client.requestAccessToken();
  });
}

/** Drive 지정 폴더에 파일 업로드 → 공개 URL 반환 */
async function uploadToDrive(file) {
  // 1. 이미지 압축 (이미지 파일만, PDF 등은 그대로)
  const uploadFile = await compressImage(file);

  const token = await getDriveToken();

  // 2. 파일 메타데이터 + 바이너리 멀티파트 업로드
  const metadata = { name: uploadFile.name, parents: [DRIVE_FOLDER_ID] };
  const form     = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], {type:'application/json'}));
  form.append('file',     uploadFile);

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body:form }
  );
  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(()=>({}));
    // 토큰 만료(401) 시 토큰 초기화 후 1회 재시도
    if (uploadRes.status === 401) {
      S.driveToken=null; S.driveTokenExpiry=null;
      throw new Error('인증이 만료되었습니다. 다시 시도해주세요.');
    }
    throw new Error('Drive 업로드 실패: ' + (err.error?.message||uploadRes.status));
  }
  const { id } = await uploadRes.json();

  // 3. 파일 공개 권한 설정 (링크 있는 사람 보기)
  await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
    method:  'POST',
    headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:    JSON.stringify({ role:'reader', type:'anyone' })
  });

  // 4. 공유 링크 반환
  return `https://drive.google.com/file/d/${id}/view?usp=sharing`;
}

// ─────────────────────────────────────────────
// 규칙 기반 자동 분석 (API 없음)
// ─────────────────────────────────────────────
function generateRuleBasedSummary(reportData) {
  const { year, month, trxList, summary } = reportData;
  const { totalIn, totalOut, balance } = summary;
  const catStats = summary.catStats || {};
  const fmt = n => Number(n).toLocaleString();

  // 전월 데이터 계산
  let prevMonth = month - 1, prevYear = year;
  if (prevMonth === 0) { prevMonth = 12; prevYear--; }
  const prevStr   = prevYear+'-'+String(prevMonth).padStart(2,'0');
  const prevTrxList = S.transactions.filter(t=>t.clientId===reportData.clientId&&(t.date||'').startsWith(prevStr)&&t.type!=='자산이동'&&t.type!=='취소');
  const prevOut   = prevTrxList.reduce((s,t)=>s+Number(t.amountOut||0),0);
  const prevCat   = {};
  prevTrxList.forEach(t=>{ if(t.type==='지출'){const k=t.category||'기타'; prevCat[k]=(prevCat[k]||0)+Number(t.amountOut||0);} });

  // 카테고리 순위
  const catKeys = Object.keys(catStats).sort((a,b)=>catStats[b].total-catStats[a].total);
  const top1    = catKeys[0], top2=catKeys[1], top3=catKeys[2];
  const top1Pct = totalOut>0?Math.round(catStats[top1]?.total/totalOut*100):0;

  // 문장 구성
  const lines = [];

  // ① 기본 요약
  if (totalOut > 0) {
    lines.push(`${year}년 ${month}월 총 지출은 ${fmt(totalOut)}원입니다.`);
  } else {
    lines.push(`${year}년 ${month}월 지출 내역이 없습니다.`);
  }

  // ② 주요 지출 카테고리
  if (top1) {
    let catSummary = `주요 지출 항목은 ${top1}(${fmt(catStats[top1].total)}원, ${top1Pct}%)`;
    if (top2) catSummary += `, ${top2}(${fmt(catStats[top2].total)}원)`;
    if (top3) catSummary += `, ${top3}(${fmt(catStats[top3].total)}원)`;
    catSummary += ' 순이었습니다.';
    lines.push(catSummary);
  }

  // ③ 전월 대비
  if (prevOut > 0 && totalOut > 0) {
    const diff = totalOut - prevOut;
    const pct  = Math.abs(Math.round(diff/prevOut*100));
    if (diff > 0)      lines.push(`전월 대비 지출이 ${fmt(diff)}원(${pct}%) 증가하였습니다.`);
    else if (diff < 0) lines.push(`전월 대비 지출이 ${fmt(Math.abs(diff))}원(${pct}%) 감소하였습니다.`);
    else               lines.push(`전월과 지출 규모가 동일합니다.`);

    // 카테고리별 전월 대비 특이사항
    const notable = catKeys.find(k => {
      const cur=catStats[k]?.total||0, prev=prevCat[k]||0;
      if (!prev) return cur>50000;
      return Math.abs(cur-prev)/prev > 0.3 && Math.abs(cur-prev) > 20000;
    });
    if (notable) {
      const cur=catStats[notable].total, prev=prevCat[notable]||0;
      const notablePct = prev>0?Math.abs(Math.round((cur-prev)/prev*100)):100;
      if (cur>prev) lines.push(`특히 ${notable} 항목이 전월 대비 ${notablePct}% 증가하였습니다.`);
      else          lines.push(`${notable} 항목은 전월 대비 ${notablePct}% 감소하였습니다.`);
    }
  }

  // ④ 잔액 상태
  if (balance >= 0) {
    lines.push(`이달 잔액은 ${fmt(balance)}원입니다.`);
  } else {
    lines.push(`이달 잔액이 ${fmt(Math.abs(balance))}원 부족합니다. 지출 관리가 필요합니다.`);
  }

  // ⑤ 확인필요 항목
  const uncat = catStats['확인필요']?.total||0;
  if (uncat > 0) {
    lines.push(`미분류(확인필요) 항목이 ${fmt(uncat)}원 있습니다. 카테고리 확인이 필요합니다.`);
  }

  // ⑥ 10만원 초과 단건 지출 상위 3건
  const bigTrx=(trxList||[])
    .filter(t=>t.type!=='자산이동'&&t.type!=='취소'&&Number(t.amountOut||0)>=100000)
    .sort((a,b)=>Number(b.amountOut||0)-Number(a.amountOut||0))
    .slice(0,3);
  if(bigTrx.length){
    const items=bigTrx.map(t=>`${t.description||'(내용없음)'}(${fmt(t.amountOut)}원)`).join(', ');
    lines.push(`10만원 이상 단건 지출 상위 ${bigTrx.length}건: ${items}.`);
  }

  return lines.join(' ');
}

// ─────────────────────────────────────────────
// Firebase 준비 후 앱 시작
// ─────────────────────────────────────────────
window.onFirebaseReady = function() {
  const saved = sessionStorage.getItem('scl_user');
  if (saved) {
    try { S.user=JSON.parse(saved); _enterApp(); return; }
    catch(e) { sessionStorage.removeItem('scl_user'); }
  }
  document.getElementById('login-view').style.display='flex';
};
if (window._fbReady) window.onFirebaseReady();

// ─────────────────────────────────────────────
// 로그인 / 로그아웃
// ─────────────────────────────────────────────
async function handleLogin() {
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

async function _enterApp() {
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
    if(isMobile()){
      initMobileApp();
    } else {
      document.getElementById('app-view').style.display='block';
      changeView('dashboard');
    }
  } catch(e) { toast('초기화 오류: '+e.message,'error'); }
  showLoading(false);
}

function handleLogout() {
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

document.getElementById('login-id').addEventListener('keydown', e=>{ if(e.key==='Enter')handleLogin(); });
document.getElementById('login-pw').addEventListener('keydown', e=>{ if(e.key==='Enter')handleLogin(); });
document.getElementById('login-btn').addEventListener('click', handleLogin);

// ─────────────────────────────────────────────
// 기본 데이터 로드
// ─────────────────────────────────────────────
async function fetchBaseData() {
  const { getDocs, collection } = fb();
  const db=fdb(), isAdmin=['관리자','센터장','팀장'].includes(S.user?.role);
  const [uSnap,cSnap,aSnap,catSnap,rSnap] = await Promise.all([
    getDocs(collection(db,COLS.USERS)),
    getDocs(collection(db,COLS.CLIENTS)),
    getDocs(collection(db,COLS.ACCOUNTS)),
    getDocs(collection(db,COLS.CATEGORIES)),
    getDocs(collection(db,COLS.REPORTS)),
  ]);
  // B004: team 필드 undefined 방지 — 빈문자열로 정규화
  S.users      = uSnap.docs.map(d=>{const u={id:d.id,...d.data()};u.team=u.team||'';return u;});
  S.categories = catSnap.docs.map(d=>({id:d.id,...d.data()}));
  const allClients  = cSnap.docs.map(d=>({id:d.id,...d.data()}));
  const allAccounts = aSnap.docs.map(d=>({id:d.id,...d.data()}));
  // active!==false 인 것만 — 비활성화된 대상자/계좌 제외 (설정탭에서 토글)
  const showInactive=S.settings?.showInactive||false;
  const activeClients=showInactive?allClients:allClients.filter(c=>c.active!==false);
  const activeAccounts=showInactive?allAccounts:allAccounts.filter(a=>a.active!==false);
  S.clients  = isAdmin ? activeClients : activeClients.filter(c=>String(c.userIds||'').split(',').map(s=>s.trim()).includes(String(S.user.userId)));
  S.accounts = activeAccounts.filter(a=>S.clients.some(c=>c.id===a.clientId));
  // 최종 결재 완료된 월 캐시 — confirmed 상태 거래 보호용
  S.confirmedMonths=new Set(rSnap.docs.map(d=>d.data()).filter(r=>r.status==='confirmed').map(r=>`${r.clientId}_${r.year}-${String(r.month).padStart(2,'0')}`));
  rebuildSelectors();
}

// confirmed 결재 완료 월 잠금 체크
function isConfirmedLocked(clientId, dateStr){
  const ym=(dateStr||'').substring(0,7);
  return !!(S.confirmedMonths?.has(`${clientId}_${ym}`));
}

async function loadTransactions(clientId) {
  if (!clientId) return;
  showLoading(true);
  try {
    const { getDocs, collection, query, where } = fb();
    const snap = await getDocs(query(collection(fdb(),COLS.TRANSACTIONS), where('clientId','==',clientId)));
    let allTrx = snap.docs.map(d=>({id:d.id,...d.data()}));
    // 입력자 role: 본인이 입력한 거래만 (createdBy 없는 기존 데이터는 제외)
    if(S.user?.role==='입력자') allTrx=allTrx.filter(t=>t.createdBy===S.user.userId);
    S.transactions = allTrx.sort((a,b)=>{
        // sortOrder 있으면 우선, 없으면 날짜 오름차순
        const oA=a.sortOrder!=null?a.sortOrder:99999;
        const oB=b.sortOrder!=null?b.sortOrder:99999;
        if(oA!==oB)return oA-oB;
        // F003: 날짜 같을 때 시간 필드로 2차 정렬
        const dtA=(a.date||'')+(a.time?' '+a.time:'');
        const dtB=(b.date||'')+(b.time?' '+b.time:'');
        return dtA.localeCompare(dtB);
      });
    S.activeClient=clientId; S.page=1; S.sortKey='date'; S.sortDir='asc';
    rebuildAccountFilter(); // ① 계좌 필터 업데이트
    applyFilters();
    syncReportTrxList(); // 보고서 거래내역 자동 동기화
  } catch(e) { toast('거래 로드 실패: '+e.message,'error'); }
  showLoading(false);
}

function rebuildSelectors() {
  ['h-client','r-client','a-client'].forEach(id=>{
    const sel=document.getElementById(id); if(!sel)return;
    const prev=sel.value;
    sel.innerHTML='<option value="">입주자 선택...</option>';
    S.clients.forEach(c=>sel.add(new Option(c.name,c.id)));
    if (S.clients.some(c=>c.id===prev)) sel.value=prev;
  });
  // ① 계좌 필터 셀렉터 업데이트 (현재 선택된 입주자 기준)
  rebuildAccountFilter();
}
function rebuildAccountFilter(){
  const sel=document.getElementById('h-account'); if(!sel)return;
  const prev=sel.value;
  sel.innerHTML='<option value="">전체 계좌</option>';
  const clientId=S.activeClient||'';
  const accs=clientId?S.accounts.filter(a=>a.clientId===clientId):[];
  accs.forEach(a=>sel.add(new Option(a.label,a.id)));
  if(accs.some(a=>a.id===prev))sel.value=prev; else sel.value='';
}

// ─────────────────────────────────────────────
// 뷰 전환
// ─────────────────────────────────────────────
function changeView(view) {
  // management → settings로 리다이렉트
  if(view==='management') view='settings';
  // 입력자 접근 제한
  if(S.user?.role==='입력자'&&(view==='report'||view==='settings')){
    toast('접근 권한이 없습니다.','error'); return;
  }
  // annual → 보고서 탭 내 연간 서브탭으로 리다이렉트
  if(view==='annual'){ changeView('report'); switchRptSubtab('annual'); return; }
  // 보고서 탭 벗어날 때 열린 보고서 닫기
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
  const titles={
    dashboard: ['대시보드','관리 중인 입주자를 선택하세요'],
    history:   ['거래 내역','입주자별 거래 내역'],
    report:    ['보고서','월별 금전관리 보고서'],
    settings:  ['설정','입주자·계좌·카테고리·시스템 설정'],
  };
  const [t,s]=titles[view]||['',''];
  setText('view-title',t); setText('view-sub',s);
  if (view==='dashboard') renderClientCards();
  if (view==='settings')  { renderManagement(); loadSettings(); }
  if (view==='report')    { loadReportList(); switchRptSubtab('monthly'); }
}

function switchRptSubtab(tab){
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
  // 연간 통계 탭 진입 시 입주자/연도 셀렉터 초기화
  if(tab==='annual'){
    const cl=document.getElementById('a-client');
    if(cl&&!cl.options.length){S.clients.forEach(c=>cl.add(new Option(c.name,c.id)));}
    const yl=document.getElementById('a-year');
    if(yl&&!yl.options.length){const cy=new Date().getFullYear();for(let y=cy;y>=cy-5;y--)yl.add(new Option(y+'년',y));}
  }
}

document.querySelectorAll('.nav-item[data-view]').forEach(btn=>btn.addEventListener('click',()=>changeView(btn.dataset.view)));
// 서브탭 클릭
document.addEventListener('click',e=>{
  if(e.target.classList.contains('rpt-subtab'))switchRptSubtab(e.target.dataset.subtab);
});
document.getElementById('btn-trx').addEventListener('click',  ()=>openModal('trx'));
document.getElementById('btn-excel').addEventListener('click', ()=>openModal('excel'));

// ─────────────────────────────────────────────
// 대시보드
// ─────────────────────────────────────────────
function renderClientCards() {
  const grid=document.getElementById('client-grid'); if(!grid)return;
  grid.innerHTML='';
  if (!S.clients.length) { grid.innerHTML='<div class="empty-state"><div class="icon">👤</div>등록된 입주자가 없습니다.</div>'; return; }
  S.clients.forEach(client=>{
    const card=document.createElement('div'); card.className='client-card';
    // F001: 입주자별 계좌 잔액 합산 미리보기
    const totalBal=S.accounts.filter(a=>a.clientId===client.id).reduce((s,a)=>s+Number(a.currentBalance||0),0);
    const balColor=totalBal>=0?'#10b981':'#ef4444';
    card.innerHTML=`<div class="client-avatar">${client.name.charAt(0)}</div><div class="client-name">${client.name}</div><div style="font-size:12px;font-weight:700;color:${balColor};margin-top:4px;">${totalBal.toLocaleString()}원</div>`;
    card.addEventListener('click',()=>{
      S.activeClient=client.id;
      const hc=document.getElementById('h-client'); if(hc)hc.value=client.id;
      changeView('history'); loadTransactions(client.id);
    });
    grid.appendChild(card);
  });
}

// ─────────────────────────────────────────────
// 거래 내역 — 필터 / 정렬 / 테이블
// ─────────────────────────────────────────────
function applyFilters() {
  const kw=(document.getElementById('h-search')?.value||'').toLowerCase();
  const sd=document.getElementById('h-start')?.value||'';
  const ed=document.getElementById('h-end')?.value||'';
  const tf=document.getElementById('h-type')?.value||'all';
  const rf=document.getElementById('h-receipt')?.value||'all';
  const af=document.getElementById('h-account')?.value||'';   // ① 계좌 필터
  S.filteredTrx=S.transactions.filter(t=>{
    const desc=String(t.description||'').toLowerCase();
    return desc.includes(kw)
      &&(!sd||t.date>=sd)&&(!ed||t.date<=ed)
      &&(tf==='all'||t.type===tf)
      &&(rf==='all'||(rf==='yes'?!!t.receiptUrl:!t.receiptUrl))
      &&(!af||t.accountId===af);   // ① 계좌 필터 조건
  });
  const key=S.sortKey, dir=S.sortDir;
  S.filteredTrx.sort((a,b)=>{
    let vA, vB;
    // 계좌명 기준 정렬
    if(key==='_accLabel'){
      vA=S.accounts.find(ac=>ac.id===a.accountId)?.label||'';
      vB=S.accounts.find(ac=>ac.id===b.accountId)?.label||'';
      if(vA<vB)return dir==='asc'?-1:1; if(vA>vB)return dir==='asc'?1:-1; return 0;
    }
    vA=a[key]; vB=b[key];
    // 숫자 필드는 숫자로 비교
    if(key==='amountIn'||key==='amountOut'){
      vA=Number(vA||0); vB=Number(vB||0);
      return dir==='asc'?vA-vB:vB-vA;
    }
    vA=String(vA||''); vB=String(vB||'');
    if(vA<vB)return dir==='asc'?-1:1; if(vA>vB)return dir==='asc'?1:-1; return 0;
  });
  renderHistoryTable(); renderPagination();
}

function renderHistoryTable() {
  if(S.trxViewMode==='calendar'){renderCalendarView();return;}
  // 달력 뷰 div 숨기고 테이블 복원
  const calDiv=document.getElementById('h-calendar-view');
  if(calDiv){calDiv.style.display='none';}
  const tbl=document.getElementById('h-body')?.closest('table')?.parentElement;
  if(tbl)tbl.style.display='';
  const tbody=document.getElementById('h-body'), ce=document.getElementById('h-count');
  const total=S.filteredTrx.length;
  if (!S.activeClient) {
    tbody.innerHTML='<tr><td colspan="9"><div class="empty-state"><div class="icon">👤</div>위에서 입주자를 선택하세요</div></td></tr>';
    if(ce)ce.textContent=''; return;
  }
  if (!total) {
    tbody.innerHTML='<tr><td colspan="9"><div class="empty-state"><div class="icon">📭</div>거래 내역이 없습니다</div></td></tr>';
    if(ce)ce.textContent=''; return;
  }
  const start=(S.page-1)*S.pageSize, end=Math.min(start+S.pageSize,total);
  if(ce)ce.textContent=`총 ${total}건 (${start+1}–${end})`;
  tbody.innerHTML='';
  const isInputOnly=S.user?.role==='입력자';
  S.filteredTrx.slice(start,end).forEach((t,idx)=>{
    const c=cs(t.category), tr=document.createElement('tr');
    tr.dataset.id=t.id; tr.dataset.idx=String(start+idx);
    tr.draggable=!isInputOnly;
    // 유형 뱃지 (자산이동/취소는 별도 표시)
    const typeTag=(t.type==='자산이동')?'<span style="font-size:10px;background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px;margin-left:4px;">↕이동</span>'
                 :(t.type==='취소')?'<span style="font-size:10px;background:#f4f4f5;color:#71717a;padding:1px 5px;border-radius:4px;margin-left:4px;">취소</span>':'';
    const accName=S.accounts.find(a=>a.id===t.accountId)?.label||'';
    tr.innerHTML=`
      <td style="text-align:center;width:28px;cursor:grab;color:#cbd5e1;font-size:16px;user-select:none;${isInputOnly?'display:none;':''}" class="drag-handle" title="드래그로 순서 변경">⠿</td>
      <td style="text-align:center;width:36px;${isInputOnly?'display:none;':''}"><input type="checkbox" class="row-check" value="${t.id}" data-acc="${t.accountId}" style="accent-color:var(--blue);width:14px;height:14px;cursor:pointer;"></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--sub);white-space:nowrap;">${t.date||''}</td>
      <td><div style="position:relative;display:inline-block;">
        <span class="cat-chip" data-id="${t.id}" style="background:${c.bg};color:${c.text};border-color:${c.border};">
          <span class="cat-dot" style="background:${c.dot};"></span><span class="cat-label">${t.category||'미분류'}</span>
        </span>
        <div class="cat-dd" id="dd-${t.id}"></div>
      </div></td>
      <td class="trx-edit" data-id="${t.id}" style="cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${t.description||''}">${t.description||''}${typeTag}</td>
      <td style="font-size:11px;color:var(--muted);white-space:nowrap;">${accName}</td>
      <td style="text-align:right;" class="col-in">${t.amountIn>0?'<span style="color:'+(t.type==='자산이동'?'#0ea5e9':'')+'">'+'+'+t.amountIn.toLocaleString()+'원</span>':''}</td>
      <td style="text-align:right;" class="col-out">${
        t.type==='자산이동'?'<span style="color:#0ea5e9;">'+Math.abs(t.amountOut).toLocaleString()+'원</span>':
        t.type==='취소'?'<span style="color:#a1a1aa;">취소</span>':
        t.amountOut<0?'<span style="color:#059669;font-size:12px;">-'+Math.abs(t.amountOut).toLocaleString()+'원</span>':
        (t.amountOut>0?t.amountOut.toLocaleString()+'원':'')
      }</td>
      <td style="text-align:center;">
        ${t.receiptUrl
          ?`<button class="icon-btn receipt-view" data-url="${t.receiptUrl}" title="증빙 보기">📎</button>`
          :`<button class="icon-btn receipt-add" data-id="${t.id}" title="증빙 추가" style="color:#94a3b8;">＋</button>`}
      </td>
      <td style="text-align:center;"><div style="display:flex;justify-content:center;gap:4px;">${(()=>{
        const canEdit=S.user?.role!=='입력자'||(t.createdBy===S.user?.userId);
        return canEdit
          ?`<button class="icon-btn trx-edit-btn" data-id="${t.id}" title="수정" style="color:#64748b;" onmouseover="this.style.background='#dbeafe';this.style.color='#2563eb';" onmouseout="this.style.background='transparent';this.style.color='#64748b';">✏️</button>
        <button class="icon-btn trx-del-btn"  data-id="${t.id}" data-acc="${t.accountId}" title="삭제" style="color:#94a3b8;" onmouseover="this.style.background='#fee2e2';this.style.color='#dc2626';" onmouseout="this.style.background='transparent';this.style.color='#94a3b8';">🗑️</button>`
          :'';
      })()}</div></td>`;
    tr.querySelector('.trx-edit')?.addEventListener('click',    ()=>editTrx(t.id));
    tr.querySelector('.trx-edit-btn')?.addEventListener('click', ()=>editTrx(t.id));
    tr.querySelector('.trx-del-btn')?.addEventListener('click',  ()=>delTrx(t.id,t.accountId));
    tr.querySelector('.cat-chip').addEventListener('click',     e=>{e.stopPropagation();openCatDropdown(t.id,tr.querySelector('.cat-chip'),t.type);});
    // ⑧ 드래그앤드롭 순서 변경
    tr.addEventListener('dragstart', e=>{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',t.id);tr.style.opacity='0.4';});
    tr.addEventListener('dragend',   ()=>tr.style.opacity='1');
    tr.addEventListener('dragover',  e=>{e.preventDefault();e.dataTransfer.dropEffect='move';tr.style.background='#eff6ff';});
    tr.addEventListener('dragleave', ()=>tr.style.background='');
    tr.addEventListener('drop', e=>{e.preventDefault();tr.style.background='';const fromId=e.dataTransfer.getData('text/plain');if(fromId!==t.id)reorderTrx(fromId,t.id);});
    const rvBtn=tr.querySelector('.receipt-view');
    if(rvBtn)rvBtn.addEventListener('click',()=>openReceiptModal(rvBtn.dataset.url,t.id));
    const raBtn=tr.querySelector('.receipt-add');
    if(raBtn)raBtn.addEventListener('click',()=>openReceiptUpload(t.id));  // ★ 버그1 수정
    tbody.appendChild(tr);
  });
  document.addEventListener('click',closeCatDropdowns,{once:true});
}

// ★ 버그3 수정 — cat-label span만 변경
function openCatDropdown(trxId, chipEl, type) {
  closeCatDropdowns();
  const dd=document.getElementById('dd-'+trxId); if(!dd)return;
  const _clientId=S.activeClient||'';
  // sortOrder 기준 정렬 (자주 쓰는 순서대로)
  const catsSorted=S.categories
    .filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===_clientId))
    .sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  const cats=[...new Set(catsSorted.map(c=>c.category))];
  if (!cats.includes('확인필요'))cats.push('확인필요');
  dd.innerHTML='';
  cats.forEach(cat=>{
    const c=cs(cat), item=document.createElement('div');
    item.className='cat-dd-item';
    item.innerHTML=`<span style="width:9px;height:9px;border-radius:50%;background:${c.dot};display:inline-block;flex-shrink:0;"></span>${cat}`;
    item.addEventListener('click',e=>{e.stopPropagation();saveCatChange(trxId,cat,chipEl);closeCatDropdowns();});
    dd.appendChild(item);
  });
  dd.classList.add('show');
}
function closeCatDropdowns(){document.querySelectorAll('.cat-dd.show').forEach(d=>d.classList.remove('show'));}

// 달력형 뷰
function renderCalendarView(){
  const tbody=document.getElementById('h-body'), ce=document.getElementById('h-count');
  // calendarYM 없으면 첫 거래 기준으로 초기화 (S.transactions 전체 기준)
  if(!S.calendarYM){
    const ref=((S.transactions[0]||S.filteredTrx[0])?.date||new Date().toISOString().substring(0,7)+'-01');
    S.calendarYM=ref.substring(0,7);
  }
  // S.transactions에서 해당 월 직접 필터 (UI 날짜 필터와 무관)
  const allTrx=S.transactions.length?S.transactions:S.filteredTrx;
  const trx=allTrx.filter(t=>(t.date||'').startsWith(S.calendarYM));
  const ym=S.calendarYM;
  const [y,m]=[parseInt(ym.split('-')[0]),parseInt(ym.split('-')[1])];
  const firstDay=new Date(y,m-1,1).getDay(); // 0=일
  const daysInMonth=new Date(y,m,0).getDate();
  // 날짜별 거래 그룹 (이미 해당 월 필터된 trx)
  const byDate={};
  trx.forEach(t=>{byDate[t.date]=(byDate[t.date]||[]).concat(t);});
  // 테이블을 달력으로 교체
  const wrap=document.getElementById('h-body')?.closest('table')?.parentElement;
  if(!wrap)return;
  const calId='h-calendar-view';
  let cal=document.getElementById(calId);
  if(!cal){cal=document.createElement('div');cal.id=calId;wrap.parentElement?.insertBefore(cal,wrap);}
  wrap.style.display='none';
  cal.style.cssText='display:block;';
  const DAY_LABELS=['일','월','화','수','목','금','토'];
  let html=`<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
    <button onclick="moveCalendar(-1)" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:16px;">&#8249;</button>
    <span style="font-weight:700;font-size:15px;color:var(--text);flex:1;text-align:center;">${y}년 ${m}월 달력</span>
    <button onclick="moveCalendar(1)" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:16px;">&#8250;</button>
  </div>`;
  html+=`<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;">`;
  DAY_LABELS.forEach((d,i)=>html+=`<div style="text-align:center;font-size:11px;font-weight:700;padding:4px 0;color:${i===0?'#ef4444':i===6?'#3b82f6':'var(--muted)'};">${d}</div>`);
  for(let i=0;i<firstDay;i++)html+=`<div></div>`;
  for(let d=1;d<=daysInMonth;d++){
    const dateStr=`${ym}-${String(d).padStart(2,'0')}`;
    const dayTrx=byDate[dateStr]||[];
    const totalIn=dayTrx.reduce((s,t)=>s+Number(t.amountIn||0),0);
    const totalOut=dayTrx.reduce((s,t)=>s+Number(t.amountOut||0),0);
    const isToday=dateStr===new Date().toISOString().substring(0,10);
    html+=`<div onclick="showCalendarDayDetail('${dateStr}')" style="min-height:60px;padding:4px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:${isToday?'#eff6ff':'#fff'};transition:background .15s;">
      <div style="font-size:11px;font-weight:700;color:${isToday?'var(--blue)':'var(--text)'};">${d}</div>
      ${dayTrx.length?`<div style="font-size:9px;color:#10b981;margin-top:2px;">+${totalIn?totalIn.toLocaleString():''}</div><div style="font-size:9px;color:#ef4444;">-${totalOut?totalOut.toLocaleString():''}</div><div style="font-size:9px;color:var(--muted);">${dayTrx.length}건</div>`:''}
    </div>`;
  }
  html+=`</div>`;
  // 날짜 클릭 상세
  html+=`<div id="cal-day-detail" style="margin-top:14px;display:none;"></div>`;
  cal.innerHTML=html;
  if(ce)ce.textContent=trx.length+'건';
}

function showCalendarDayDetail(dateStr){
  const detail=document.getElementById('cal-day-detail'); if(!detail)return;
  const allTrx=S.transactions.length?S.transactions:S.filteredTrx;
  const dayTrx=allTrx.filter(t=>t.date===dateStr);
  detail.style.display='block';
  const addBtn=`<button onclick="openModalWithDate('${dateStr}')" style="font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--green);color:var(--green);background:#fff;cursor:pointer;">✍️ 거래 추가</button>`;
  detail.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
    <div style="font-weight:700;font-size:13px;color:var(--text);">${dateStr} 거래 내역 (${dayTrx.length}건)</div>
    ${addBtn}
  </div>`
    +(dayTrx.length?dayTrx.map(t=>{const acc=S.accounts.find(a=>a.id===t.accountId)?.label||'';return`<div style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">${acc}</span><span style="font-size:11px;color:var(--muted);">${t.category||''}</span></div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;"><span>${t.description||'-'}</span><span style="font-weight:700;color:${t.amountIn?'#10b981':'#ef4444'};">${t.amountIn?'+'+Number(t.amountIn).toLocaleString():'-'+Number(t.amountOut||0).toLocaleString()}원</span></div>
    </div>`;}).join(''):'<div style="color:#9ca3af;font-size:13px;padding:8px 0;">이 날 거래 없음</div>');
}

function openModalWithDate(dateStr){
  openModal('trx');
  setTimeout(()=>{
    const d=document.getElementById('trx-date');
    if(d){d.value=dateStr;}
  },80);
}

function moveCalendar(dir){
  if(!S.calendarYM){
    const ref=(S.filteredTrx[0]?.date||new Date().toISOString().substring(0,7)+'-01');
    S.calendarYM=ref.substring(0,7);
  }
  const [y,m]=S.calendarYM.split('-').map(Number);
  const d=new Date(y,m-1+dir,1);
  S.calendarYM=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  renderCalendarView();
}

// 빈 공간 클릭 시 카테고리 드롭다운 닫기
document.addEventListener('click', function(e){
  if(!e.target.closest('.cat-chip')&&!e.target.closest('.cat-dd')){
    closeCatDropdowns();
  }
});

async function saveCatChange(trxId, newCat, chipEl) {
  const {doc,updateDoc}=fb();
  await updateDoc(doc(fdb(),COLS.TRANSACTIONS,trxId),{category:newCat});
  [S.transactions,S.filteredTrx].forEach(arr=>{const t=arr.find(x=>x.id===trxId);if(t)t.category=newCat;});
  if (chipEl) {
    const c=cs(newCat);
    chipEl.style.background=c.bg; chipEl.style.color=c.text; chipEl.style.borderColor=c.border;
    chipEl.querySelector('.cat-dot').style.background=c.dot;
    // ★ 버그3 수정 — cat-label span만 정확히 변경
    const labelEl=chipEl.querySelector('.cat-label');
    if (labelEl) labelEl.textContent=newCat;
  }
  toast('카테고리 변경됨','success',2000);
}

function renderPagination(){
  const el=document.getElementById('h-pages'); if(!el)return;
  const pages=Math.ceil(S.filteredTrx.length/S.pageSize);
  if(pages<=1){el.innerHTML='';return;} el.innerHTML='';
  for(let p=1;p<=pages;p++){
    const btn=document.createElement('button'); btn.textContent=p;
    btn.style.cssText=`padding:6px 12px;border-radius:7px;font-size:13px;font-weight:700;border:1px solid var(--bm);cursor:pointer;background:${p===S.page?'var(--blue)':'#fff'};color:${p===S.page?'#fff':'var(--sub)'};`;
    btn.addEventListener('click',()=>{S.page=p;renderHistoryTable();renderPagination();});
    el.appendChild(btn);
  }
}

['h-search','h-start','h-end'].forEach(id=>document.getElementById(id)?.addEventListener('input',applyFilters));
['h-type','h-receipt','h-start','h-end'].forEach(id=>document.getElementById(id)?.addEventListener('change',applyFilters));
document.getElementById('h-client')?.addEventListener('change',()=>{
  const v=document.getElementById('h-client').value;
  // ① 입주자 변경 시 계좌 필터 초기화
  const accSel=document.getElementById('h-account'); if(accSel)accSel.value='';
  if(v)loadTransactions(v);
  else{S.transactions=[];S.filteredTrx=[];S.activeClient=null;renderHistoryTable();rebuildAccountFilter();}
});
// ① 계좌 필터 change 이벤트
document.getElementById('h-account')?.addEventListener('change',applyFilters);
document.getElementById('check-all')?.addEventListener('click',e=>{
  document.querySelectorAll('.row-check').forEach(c=>c.checked=e.target.checked);
});
document.querySelectorAll('.period-btn').forEach(btn=>btn.addEventListener('click',()=>{
  applyPeriod(btn.dataset.p);
  document.querySelectorAll('.period-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
}));
document.querySelectorAll('[data-sort]').forEach(th=>th.addEventListener('click',()=>{
  const k=th.dataset.sort; S.sortDir=S.sortKey===k&&S.sortDir==='desc'?'asc':'desc'; S.sortKey=k; S.page=1; applyFilters();
}));
// 보고서 거래내역 컬럼 정렬
document.querySelectorAll('[data-rpt-sort]').forEach(th=>th.addEventListener('click',()=>{
  const k=th.dataset.rptSort;
  S.rptSortDir=S.rptSortKey===k&&S.rptSortDir==='desc'?'asc':'desc';
  S.rptSortKey=k;
  if(S.reportData?.trxList){
    renderRptTrxTable(applyRptSort(S.reportData.trxList));
    updateRptSortArrows();
  }
}));
document.getElementById('btn-h-trx')?.addEventListener('click',   ()=>openModal('trx'));
document.getElementById('btn-h-excel')?.addEventListener('click',  ()=>openModal('excel'));
document.getElementById('btn-bulk-del')?.addEventListener('click', confirmBulkDelete);
document.getElementById('btn-csv-export')?.addEventListener('click', exportFilteredCSV); // I002
document.getElementById('btn-h-fixed')?.addEventListener('click',  applyFixedItems);         // ⑩ 고정항목
document.getElementById('btn-h-receipt-print')?.addEventListener('click', printReceiptSheet); // ⑬ 증빙출력
document.getElementById('btn-trx-view-toggle')?.addEventListener('click',()=>{
  S.trxViewMode=S.trxViewMode==='list'?'calendar':'list';
  S.calendarYM=''; // 달력 전환 시 월 초기화
  const btn=document.getElementById('btn-trx-view-toggle');
  if(btn)btn.textContent=S.trxViewMode==='calendar'?'☰ 목록':'🗓️ 달력';
  renderHistoryTable();
});

function applyPeriod(p){
  const now=new Date(),y=now.getFullYear(),m=now.getMonth(),d=now.getDay();
  const fmt=dt=>dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
  let sd='',ed='';
  if(p==='this-month') {sd=fmt(new Date(y,m,1));ed=fmt(new Date(y,m+1,0));}
  if(p==='last-month') {sd=fmt(new Date(y,m-1,1));ed=fmt(new Date(y,m,0));}
  if(p==='this-week')  {const mon=new Date(now);mon.setDate(now.getDate()-(d===0?6:d-1));const sun=new Date(mon);sun.setDate(mon.getDate()+6);sd=fmt(mon);ed=fmt(sun);}
  if(p==='last-3month'){sd=fmt(new Date(y,m-2,1));ed=fmt(new Date(y,m+1,0));}
  if(p==='this-year')  {sd=y+'-01-01';ed=y+'-12-31';}
  const s=document.getElementById('h-start'),e=document.getElementById('h-end');
  if(s)s.value=sd; if(e)e.value=ed; applyFilters();
}

(()=>{
  const now=new Date(),y=now.getFullYear(),m=now.getMonth();
  const fmt=dt=>dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
  const s=document.getElementById('h-start'),e=document.getElementById('h-end');
  if(s)s.value=fmt(new Date(y,m,1)); if(e)e.value=fmt(new Date(y,m+1,0));
})();

// ─────────────────────────────────────────────
// 거래 CRUD
// ─────────────────────────────────────────────
async function saveTrx(data){
  if(isConfirmedLocked(data.clientId,data.date)){toast('최종 결재 완료된 월의 거래는 수정할 수 없습니다.','error');return;}
  const {doc,addDoc,collection,updateDoc}=fb();
  const isEdit=!!data.id;
  if(isEdit){
    const id=data.id; delete data.id;
    await updateDoc(doc(fdb(),COLS.TRANSACTIONS,id),data);
    data.id=id;
    // ⑨ 수정 후 정렬 유지 — 로컬 배열만 업데이트 후 re-render
    const idx=S.transactions.findIndex(x=>x.id===id);
    if(idx>=0)S.transactions[idx]={...S.transactions[idx],...data};
    await updateAccBalance(data.accountId);
    applyFilters();   // 전체 재로드 없이 필터/정렬 유지
  } else {
    // 입력자: createdBy 필드 추가
    if(!data.createdBy&&S.user?.userId)data.createdBy=S.user.userId;
    await addDoc(collection(fdb(),COLS.TRANSACTIONS),data);
    await updateAccBalance(data.accountId);
    if(S.activeClient===data.clientId)await loadTransactions(data.clientId);
  }
  toast('저장되었습니다.','success');
}

async function delTrx(id,accId){
  const trxCheck=S.transactions.find(x=>x.id===id);
  if(trxCheck&&isConfirmedLocked(trxCheck.clientId,trxCheck.date)){toast('최종 결재 완료된 월의 거래는 삭제할 수 없습니다.','error');return;}
  showConfirm('거래 삭제','이 거래 내역을 삭제하시겠습니까?',async()=>{
    const{doc,deleteDoc}=fb();
    const trx=S.transactions.find(x=>x.id===id);
    await deleteDoc(doc(fdb(),COLS.TRANSACTIONS,id));
    await updateAccBalance(accId);
    // B001: 자산이동 연결 거래 함께 삭제
    if(trx?.type==='자산이동'&&trx.linkedTrxId){
      await deleteDoc(doc(fdb(),COLS.TRANSACTIONS,trx.linkedTrxId));
      if(trx.linkedAccountId)await updateAccBalance(trx.linkedAccountId);
    }
    if(S.activeClient)await loadTransactions(S.activeClient);
    toast('삭제되었습니다.','success');
  });
}

// ★ 버그4 수정 — 일괄 삭제 후 check-all 체크박스 초기화
// I002: 거래내역 CSV 내보내기 (현재 필터 기준)
function exportFilteredCSV(){
  if(!S.filteredTrx||!S.filteredTrx.length){toast('내보낼 데이터가 없습니다.','info');return;}
  const client=S.clients.find(c=>c.id===S.activeClient)||{name:'전체'};
  const header=['날짜','시간','계좌','구분','분류','내용','수입','지출','증빙'];
  const rows=S.filteredTrx.map(t=>{
    const acc=S.accounts.find(a=>a.id===t.accountId)?.label||'';
    return [t.date||'',t.time||'',acc,t.type||'',t.category||'',t.description||'',t.amountIn||0,t.amountOut||0,t.receiptUrl?'O':''].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',');
  });
  const csv='\uFEFF'+[header.join(','),...rows].join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=client.name+'_거래내역_'+new Date().toISOString().split('T')[0]+'.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('CSV 다운로드 완료','success');
}

async function confirmBulkDelete(){
  const checked=Array.from(document.querySelectorAll('.row-check:checked'));
  if(!checked.length){toast('삭제할 항목을 선택하세요.','info');return;}
  // confirmed 월 거래 포함 여부 체크
  const lockedChecked=checked.filter(cb=>{const t=S.transactions.find(x=>x.id===cb.value);return t&&isConfirmedLocked(t.clientId,t.date);});
  if(lockedChecked.length){toast(`최종 결재 완료된 월의 거래 ${lockedChecked.length}건이 포함되어 있습니다. 해당 거래는 삭제할 수 없습니다.`,'error');return;}
  showConfirm('일괄 삭제',`선택한 ${checked.length}건을 삭제하시겠습니까?`,async()=>{
    const{doc,deleteDoc}=fb();
    const checkedIds=new Set(checked.map(c=>c.value));
    const linkedToDelete=[]; const linkedAccIds=new Set();
    for(const cb of checked){
      await deleteDoc(doc(fdb(),COLS.TRANSACTIONS,cb.value));
      // B001: 자산이동 연결 거래 수집
      const trx=S.transactions.find(x=>x.id===cb.value);
      if(trx?.type==='자산이동'&&trx.linkedTrxId&&!checkedIds.has(trx.linkedTrxId)){
        linkedToDelete.push(trx.linkedTrxId);
        if(trx.linkedAccountId)linkedAccIds.add(trx.linkedAccountId);
      }
    }
    // 연결 거래 삭제
    for(const lid of linkedToDelete)await deleteDoc(doc(fdb(),COLS.TRANSACTIONS,lid));
    const accIds=[...new Set([...checked.map(c=>c.dataset.acc),...linkedAccIds])];
    for(const a of accIds) await updateAccBalance(a);
    // ★ 체크박스 전체 초기화
    const checkAll=document.getElementById('check-all');
    if(checkAll)checkAll.checked=false;
    if(S.activeClient)await loadTransactions(S.activeClient);
    toast(`${checked.length}건 삭제.`,'success');
  });
}

function editTrx(id){const t=S.transactions.find(x=>x.id===id);if(!t)return;openModal('trx',t);}

async function updateAccBalance(accId){
  if(!accId)return;
  const{getDocs,collection,query,where,doc,getDoc,updateDoc}=fb();
  const accRef=doc(fdb(),COLS.ACCOUNTS,accId);
  const accSnap=await getDoc(accRef); if(!accSnap.exists())return;
  const acc=accSnap.data();
  const snap=await getDocs(query(collection(fdb(),COLS.TRANSACTIONS),where('accountId','==',accId)));
  let bal=Number(acc.initialBalance||0);
  // ⑫ initialBalanceDate 기준: 해당 날짜 이후 거래만 합산
  const baseDate=acc.initialBalanceDate||'';
  // 자산이동/취소는 수입/지출 합계에서 제외하지만 잔액에는 반영
  snap.docs.forEach(d=>{
    const t=d.data();
    if(baseDate&&(t.date||'')<baseDate)return; // 기준일 이전 거래 제외
    if(t.type==='취소')return; // 취소 거래는 잔액에 영향 없음
    // 2. 음수 amountOut(환불/취소성 지출)도 잔액에 정확히 반영
    bal+=(Number(t.amountIn||0)-Number(t.amountOut||0));
  });
  await updateDoc(accRef,{currentBalance:bal});
  const local=S.accounts.find(a=>a.id===accId); if(local)local.currentBalance=bal;
}

// ─────────────────────────────────────────────
// 연간 통계
// ─────────────────────────────────────────────
(()=>{
  const sel=document.getElementById('a-year'); if(!sel)return;
  const cy=new Date().getFullYear();
  for(let y=cy;y>=cy-6;y--)sel.add(new Option(y+'년',y)); sel.value=cy;
})();
document.getElementById('btn-annual-load')?.addEventListener('click',loadAnnual);

async function loadAnnual(){
  const clientId=document.getElementById('a-client')?.value;
  const year=Number(document.getElementById('a-year')?.value);
  if(!clientId){toast('입주자를 선택하세요.','error');return;}
  showLoading(true);
  const{getDocs,collection,query,where}=fb();
  const [snap,budgetSnap]=await Promise.all([
    getDocs(query(collection(fdb(),COLS.TRANSACTIONS),where('clientId','==',clientId))),
    getDocs(query(collection(fdb(),COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year))),
  ]);
  const budgetMap={};
  budgetSnap.docs.forEach(d=>{const b=d.data();budgetMap[b.category]=Number(b.amount||0);});
  const all=snap.docs.map(d=>({id:d.id,...d.data()})).filter(t=>t.date&&t.date.startsWith(String(year)));
  showLoading(false);
  let totalIn=0,totalOut=0;
  const monthly={},catMap={};
  for(let m=1;m<=12;m++)monthly[m]={in:0,out:0,count:0};
  all.forEach(t=>{
    const m=parseInt((t.date||'').split('-')[1])||0; if(!m)return;
    if(t.type==='자산이동'||t.type==='취소')return; // ④⑤ 집계 제외
    totalIn+=Number(t.amountIn||0); totalOut+=Number(t.amountOut||0);
    monthly[m].in+=Number(t.amountIn||0); monthly[m].out+=Number(t.amountOut||0); monthly[m].count++;
    if(t.type==='지출'){const k=t.category||'기타';catMap[k]=(catMap[k]||0)+Number(t.amountOut||0);}
  });
  setText('a-total-in',  totalIn.toLocaleString()+'원');
  setText('a-total-out', totalOut.toLocaleString()+'원');
  setText('a-balance',   (totalIn-totalOut).toLocaleString()+'원');
  setText('a-count',     all.length+'건');
  const mLabels=Array.from({length:12},(_,i)=>(i+1)+'월');
  Object.values(S.annualCharts).forEach(c=>c.destroy()); S.annualCharts={};
  S.annualCharts.monthly=new Chart(document.getElementById('a-monthly-chart').getContext('2d'),{type:'bar',data:{labels:mLabels,datasets:[{label:'수입',data:mLabels.map((_,i)=>monthly[i+1].in),backgroundColor:'rgba(16,185,129,.7)',borderRadius:4},{label:'지출',data:mLabels.map((_,i)=>monthly[i+1].out),backgroundColor:'rgba(244,63,94,.7)',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:11},color:'#64748b'}}},scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#94a3b8',font:{size:10},callback:v=>v>=10000?(v/10000).toFixed(0)+'만':''+v},grid:{color:'rgba(0,0,0,.04)'}}}}});
  const catKeys=Object.keys(catMap).sort((a,b)=>catMap[b]-catMap[a]);
  // 도넛 차트 삭제됨 (a-cat-chart 제거)
  let running=0;
  S.annualCharts.balance=new Chart(document.getElementById('a-balance-chart').getContext('2d'),{type:'line',data:{labels:mLabels,datasets:[{label:'잔액',data:mLabels.map((_,i)=>{running+=monthly[i+1].in-monthly[i+1].out;return running;}),borderColor:'var(--blue)',backgroundColor:'rgba(59,130,246,.08)',fill:true,tension:.4,pointRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#94a3b8',font:{size:10},callback:v=>v>=10000?(v/10000).toFixed(0)+'만':''+v},grid:{color:'rgba(0,0,0,.04)'}}}}});
  const tbody=document.getElementById('a-monthly-body'); tbody.innerHTML='';
  for(let m=1;m<=12;m++){const r=monthly[m];if(!r.count&&!r.in&&!r.out)continue;const tr=document.createElement('tr');tr.innerHTML=`<td style="font-weight:700;">${m}월</td><td style="text-align:right;" class="col-in">${r.in>0?'+'+r.in.toLocaleString()+'원':'-'}</td><td style="text-align:right;" class="col-out">${r.out>0?r.out.toLocaleString()+'원':'-'}</td><td style="text-align:right;font-weight:700;">${(r.in-r.out).toLocaleString()}원</td><td style="text-align:right;color:var(--muted);">${r.count}건</td>`;tbody.appendChild(tr);}
  const rankEl=document.getElementById('a-cat-rank'); rankEl.innerHTML='';
  const hasBudget=Object.keys(budgetMap).length>0;
  catKeys.slice(0,10).forEach((k,i)=>{
    const pct=totalOut>0?Math.round(catMap[k]/totalOut*100):0;
    const c=cs(k);
    const budget=budgetMap[k]||0;
    const achieve=budget>0?Math.round(catMap[k]/budget*100):null;
    const achieveColor=achieve===null?'var(--muted)':achieve>100?'#dc2626':achieve>80?'#f59e0b':'#10b981';
    const div=document.createElement('div');
    div.style.cssText='display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);';
    div.innerHTML=`<span style="width:22px;height:22px;border-radius:50%;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--sub);">${i+1}</span><span style="flex:1;font-size:14px;font-weight:600;">${k}</span><div style="flex:2;height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden;"><div style="height:100%;background:${c.dot};border-radius:99px;width:${pct}%;"></div></div><span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;width:90px;text-align:right;">${catMap[k].toLocaleString()}원</span><span style="font-size:12px;color:var(--muted);width:36px;text-align:right;">${pct}%</span>${hasBudget?`<span style="font-size:11px;width:80px;text-align:right;color:var(--muted);">예산 ${budget?budget.toLocaleString()+'원':'-'}</span><span style="font-size:11px;width:48px;text-align:right;font-weight:700;color:${achieveColor};">${achieve!==null?achieve+'%':'-'}</span>`:''}`;
    rankEl.appendChild(div);
  });
  document.getElementById('annual-content').style.display='block';
}

// ─────────────────────────────────────────────
// 보고서
// ─────────────────────────────────────────────
(()=>{
  const ySel=document.getElementById('r-year'),mSel=document.getElementById('r-month');
  if(!ySel||!mSel)return;
  const cy=new Date().getFullYear(),cm=new Date().getMonth()+1;
  for(let y=cy;y>=cy-5;y--)ySel.add(new Option(y+'년',y)); ySel.value=cy;
  for(let m=1;m<=12;m++)mSel.add(new Option(m+'월',m)); mSel.value=cm;
})();

document.getElementById('btn-rpt-load')?.addEventListener('click',loadReport);
document.getElementById('btn-rpt-list-refresh')?.addEventListener('click',loadReportList);
document.getElementById('btn-gen-summary')?.addEventListener('click',handleGenSummary);
// ★ 버그8 수정 — 인쇄 포함/제외 체크박스 → 즉시 display 변경
document.getElementById('rpt-summary-print')?.addEventListener('change',e=>{
  const area=document.getElementById('rpt-summary-print-area');
  if(area)area.style.display=e.target.checked?'block':'none';
});

async function loadReport(){
  const clientId=document.getElementById('r-client')?.value;
  const year=Number(document.getElementById('r-year')?.value);
  const month=Number(document.getElementById('r-month')?.value);
  if(!clientId){toast('입주자를 선택하세요.','error');return;}
  showLoading(true);
  try{
    const{getDocs,collection,query,where}=fb();
    const mStr=year+'-'+String(month).padStart(2,'0');
    const tSnap=await getDocs(query(collection(fdb(),COLS.TRANSACTIONS),where('clientId','==',clientId)));
    // B002: 전체 거래 목록 보존 (계좌 현황 잔액 계산용)
    const allTrx=tSnap.docs.map(d=>({id:d.id,...d.data()}));
    const trxList=allTrx
      .filter(t=>t.date&&t.date.startsWith(mStr))
      .sort((a,b)=>{
        // ⑧ sortOrder 우선, 같으면 날짜+시간 오름차순
        const oA = a.sortOrder!=null ? a.sortOrder : 99999;
        const oB = b.sortOrder!=null ? b.sortOrder : 99999;
        if(oA!==oB) return oA-oB;
        const dtA=(a.date||'')+(a.time?' '+a.time:'');
        const dtB=(b.date||'')+(b.time?' '+b.time:'');
        return dtA.localeCompare(dtB);
      });
    const accs=S.accounts.filter(a=>a.clientId===clientId);
    const rSnap=await getDocs(query(collection(fdb(),COLS.REPORTS),where('clientId','==',clientId),where('year','==',year),where('month','==',month)));
    const report=rSnap.empty?null:{id:rSnap.docs[0].id,...rSnap.docs[0].data()};
    let totalIn=0,totalOut=0; const catStats={};
    trxList.forEach(t=>{
      // ④⑤ 자산이동·취소는 수입/지출 집계에서 제외
      if(t.type==='자산이동'||t.type==='취소')return;
      totalIn+=Number(t.amountIn||0);
      // 2. 음수 amountOut(환불): 지출에서 차감 (음수값 그대로 더함)
      totalOut+=Number(t.amountOut||0);
      if(t.type==='지출'){
        const k=t.category||'기타';
        if(!catStats[k])catStats[k]={total:0};
        catStats[k].total+=Number(t.amountOut||0); // 음수면 자동 차감
      }
    });
    S.reportData={clientId,year,month,trxList,allTrx,accs,report,summary:{totalIn,totalOut,balance:totalIn-totalOut,catStats}};
    renderReportView();
    document.getElementById('report-area').style.display='block';
    // 목록 테이블에서 현재 보고서 행 하이라이트
    const rptListEl=document.getElementById('rpt-list');
    if(rptListEl){
      rptListEl.querySelectorAll('tr').forEach(tr=>{tr.style.background='';});
      if(report?.id){
        const activeRow=rptListEl.querySelector(`tr[data-report-id="${report.id}"]`);
        if(activeRow)activeRow.style.background='#eff6ff';
      }
    }
    // report-area가 화면에 보이도록 스크롤
    document.getElementById('report-area')?.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){toast('보고서 로드 오류: '+e.message,'error');}
  showLoading(false);
}

function renderReportView(){
  const{clientId,year,month,trxList,accs,report,summary}=S.reportData;
  const client=S.clients.find(c=>c.id===clientId)||{name:'-'};
  const now=new Date(), curStatus=report?report.status:'';
  setText('rpt-period',`${year}년 ${month}월 거래 내역`);
  setText('rpt-created',`작성: ${now.toLocaleDateString('ko-KR')}`);
  setText('rpt-created-bottom',now.toLocaleDateString('ko-KR'));
  setText('rpt-client-name',client.name);
  setText('rpt-month-label',`${year}년 ${month}월`);
  setText('rpt-staff-name',report?.submittedByName||(S.user?.name||'-'));
  setText('rpt-total-in', summary.totalIn.toLocaleString()+'원');
  setText('rpt-total-out',summary.totalOut.toLocaleString()+'원');
  setText('rpt-balance',  summary.balance.toLocaleString()+'원');
  setText('rpt-foot-in',  summary.totalIn>0?summary.totalIn.toLocaleString()+'원':'');
  setText('rpt-foot-out', summary.totalOut>0?summary.totalOut.toLocaleString()+'원':'');
  const lbl=STATUS_LABELS[curStatus]||curStatus,cls=STATUS_CLASSES[curStatus]||'rs-draft';
  const sl=document.getElementById('rpt-status-label'),ub=document.getElementById('rpt-status-badge');
  if(sl){sl.textContent=lbl;sl.className=cls;} if(ub){ub.textContent=lbl;ub.className=cls;}
  // 계좌 현황 — 기초잔액 + 기준일 이후 거래 합산으로 직접 계산 (전월 잔액 포함)
  const accEl=document.getElementById('rpt-accounts'); accEl.innerHTML='';
  accs.forEach(a=>{
    const baseDate=a.initialBalanceDate||'';
    const baseAmt=Number(a.initialBalance||0);
    // B002: allTrx(loadReport에서 보존한 전체 거래)로 잔액 계산 — S.transactions 의존 제거
    const mStr=`${year}-${String(month).padStart(2,'0')}`;
    const endDate=mStr+'-31';
    const prevYM=month===1?`${year-1}-12`:`${year}-${String(month-1).padStart(2,'0')}`;
    const prevEnd=prevYM+'-31';
    const allAccTrx=(S.reportData.allTrx||[]).filter(t=>t.accountId===a.id&&t.type!=='취소');
    let bal=baseAmt, prevBal=baseAmt;
    allAccTrx.forEach(t=>{
      if(baseDate&&(t.date||'')<baseDate)return;
      const d=t.date||'';
      const diff=Number(t.amountIn||0)-Number(t.amountOut||0);
      if(d<=prevEnd)prevBal+=diff;
      if(d<=endDate)bal+=diff;
    });
    const row=document.createElement('div');
    row.style.cssText='display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;gap:8px;';
    row.innerHTML=`<span style="font-size:14px;color:#6b7280;flex:1;">${a.label}</span>`
      +`<span style="font-size:12px;color:#9ca3af;white-space:nowrap;">전월 ${prevBal.toLocaleString()}원</span>`
      +`<span style="font-size:14px;font-weight:700;color:${bal>=0?'#111827':'#dc2626'};white-space:nowrap;">${bal.toLocaleString()}원</span>`;
    accEl.appendChild(row);
  });
  // 분류별 지출
  const catKeys=Object.keys(summary.catStats);
  const catEl=document.getElementById('rpt-cat-table'); catEl.innerHTML='';
  if(S.rptChart){S.rptChart.destroy();S.rptChart=null;}
  if(catKeys.length){
    const sortedCatKeys=[...catKeys].sort((a,b)=>(summary.catStats[b]?.total||0)-(summary.catStats[a]?.total||0));
    let tbl='<table style="width:100%;border-collapse:collapse;table-layout:fixed;">'
      +'<colgroup><col style="width:100px"><col style="width:200px"><col style="width:46px"><col></colgroup>'
      +'<thead><tr style="border-bottom:1px solid #e5e7eb;">'
      +'<th style="padding:6px 4px;text-align:left;font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;">분류</th>'
      +'<th style="padding:6px 4px;text-align:right;font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;">금액</th>'
      +'<th style="padding:6px 4px;text-align:right;font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;">비율</th>'
      +'<th style="padding:6px 4px;font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;"></th>'
      +'</tr></thead><tbody>';
    sortedCatKeys.forEach((k,i)=>{
      const v=summary.catStats[k], pct=summary.totalOut>0?Math.round(v.total/summary.totalOut*100):0;
      const clr=cs(k);
      const color=clr.dot||'#64748b';
      tbl+='<tr style="border-bottom:1px solid #f3f4f6;">'
        +'<td style="padding:7px 4px;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
          +'<span style="display:inline-flex;align-items:center;gap:4px;background:'+clr.bg+';color:'+clr.text+';border:1px solid '+clr.border+';border-radius:12px;padding:2px 8px;font-size:12px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+k+'</span>'
        +'</td>'
        +'<td style="padding:7px 4px;text-align:right;font-family:monospace;font-size:13px;color:#111827;white-space:nowrap;">'+v.total.toLocaleString()+'원</td>'
        +'<td style="padding:7px 4px;text-align:right;font-size:13px;color:#6b7280;white-space:nowrap;">'+pct+'%</td>'
        +'<td style="padding:7px 8px;vertical-align:middle;">'
          +'<div style="height:10px;background:#f3f4f6;border-radius:99px;overflow:hidden;min-width:40px;">'
            +'<div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:99px;"></div>'
          +'</div></td>'
        +'</tr>';
    });
    catEl.innerHTML=tbl+'</tbody></table>';
  } else { catEl.innerHTML='<div style="color:#9ca3af;font-size:13px;padding:10px 0;">지출 내역 없음</div>'; }
  // F002: 거래내역 테이블 렌더링 + 드래그 순서 변경 (정렬 초기화 후 렌더)
  S.rptSortKey='date'; S.rptSortDir='asc';
  renderRptTrxTable(trxList);
  updateRptSortArrows();
  // 결재/의견/차트/통장사진 (정의된 함수 호출)
  renderApproval(report,curStatus);
  renderComments(report,curStatus);
  // renderTrendChart 제거 (월별 추이 차트 삭제)
  if(S.rptTrendChart){S.rptTrendChart.destroy();S.rptTrendChart=null;}
  renderRptBankStatements(clientId,year,month);
  renderRptExcelComparison(clientId,year,month);
}

// F002: 보고서 거래내역 테이블 렌더링 (드래그앤드롭 포함)
function renderRptTrxTable(trxList){
  const tbody=document.getElementById('rpt-trx-body'); if(!tbody)return;
  tbody.innerHTML='';
  if(!trxList||!trxList.length){
    const tr=document.createElement('tr');
    tr.innerHTML='<td colspan="6" style="text-align:center;color:#9ca3af;padding:16px;font-size:13px;">거래 내역이 없습니다.</td>';
    tbody.appendChild(tr); return;
  }
  const confirmedLocked=isConfirmedLocked(S.reportData?.clientId, S.reportData?.trxList?.[0]?.date||'');
  trxList.forEach(t=>{
    const tr=document.createElement('tr');
    tr.dataset.id=t.id;
    const locked=confirmedLocked; // 최종 결재 완료 보고서는 드래그 불가
    tr.draggable=!locked;
    tr.style.cssText=`border-bottom:1px solid #f3f4f6;cursor:${locked?'default':'grab'};`;
    const typeTag=(t.type==='자산이동')?'<span style="font-size:10px;background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px;margin-left:4px;">↕이동</span>'
                 :(t.type==='취소')?'<span style="font-size:10px;background:#f4f4f5;color:#71717a;padding:1px 5px;border-radius:4px;margin-left:4px;">취소</span>':'';
    const catClr=cs(t.category||'');
    tr.innerHTML=`<td style="padding:7px 4px;font-family:monospace;font-size:13px;color:#6b7280;white-space:nowrap;">${t.date||''}</td>`
      +`<td style="padding:4px 4px;overflow:hidden;white-space:nowrap;"><span style="display:inline-block;background:${catClr.bg};color:${catClr.text};border:1px solid ${catClr.border};border-radius:10px;padding:2px 6px;font-size:11px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.category||''}</span></td>`
      +`<td style="padding:7px 4px;font-size:13px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.description||''}${typeTag}</td>`
      +`<td style="padding:7px 4px;text-align:right;font-family:monospace;font-size:13px;color:#15803d;white-space:nowrap;">${Number(t.amountIn||0)>0?Number(t.amountIn).toLocaleString()+'원':''}</td>`
      +`<td style="padding:7px 4px;text-align:right;font-family:monospace;font-size:13px;color:#b91c1c;white-space:nowrap;">${Number(t.amountOut||0)>0?Number(t.amountOut).toLocaleString()+'원':''}</td>`
      +`<td style="padding:7px 4px;text-align:center;">${t.receiptUrl?'<button class="icon-btn rpt-rv" data-url="'+t.receiptUrl+'" title="증빙 보기">📎</button>':''}</td>`;
    if(!locked){
      tr.addEventListener('dragstart',e=>{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',t.id);tr.style.opacity='0.4';});
      tr.addEventListener('dragend',()=>tr.style.opacity='1');
      tr.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';tr.style.background='#eff6ff';});
      tr.addEventListener('dragleave',()=>tr.style.background='');
      tr.addEventListener('drop',e=>{e.preventDefault();tr.style.background='';const fid=e.dataTransfer.getData('text/plain');if(fid!==t.id)reorderRptTrx(fid,t.id);});
    }
    const rvBtn=tr.querySelector('.rpt-rv');
    if(rvBtn)rvBtn.addEventListener('click',()=>openReceiptModal(rvBtn.dataset.url,t.id));
    tbody.appendChild(tr);
  });
}

// ─── 보고서 거래내역 정렬 ───
function applyRptSort(list){
  const key=S.rptSortKey, dir=S.rptSortDir;
  return [...list].sort((a,b)=>{
    let vA, vB;
    if(key==='amountIn'||key==='amountOut'){
      vA=Number(a[key]||0); vB=Number(b[key]||0);
      return dir==='asc'?vA-vB:vB-vA;
    }
    if(key==='date'){
      // 날짜+시간 복합 정렬
      vA=(a.date||'')+(a.time?' '+a.time:'');
      vB=(b.date||'')+(b.time?' '+b.time:'');
    } else {
      vA=String(a[key]||''); vB=String(b[key]||'');
    }
    if(vA<vB)return dir==='asc'?-1:1;
    if(vA>vB)return dir==='asc'?1:-1;
    return 0;
  });
}

function updateRptSortArrows(){
  document.querySelectorAll('[data-rpt-sort]').forEach(th=>{
    const arrow=th.querySelector('.rpt-sort-arrow');
    if(!arrow)return;
    if(th.dataset.rptSort===S.rptSortKey){
      arrow.textContent=S.rptSortDir==='asc'?' ↑':' ↓';
    } else {
      arrow.textContent=' ⇅';
    }
  });
}

// 거래 추가/수정 후 보고서 거래내역 자동 동기화
function syncReportTrxList(){
  if(!S.reportData)return;
  const{clientId,year,month}=S.reportData;
  if(!clientId)return;
  const mStr=year+'-'+(String(month).padStart(2,'0'));
  // S.transactions(방금 재로드)에서 해당 월 거래 추출
  const newTrxList=S.transactions.filter(t=>t.clientId===clientId&&(t.date||'').startsWith(mStr));
  // sortOrder 기준 기본 정렬 후 현재 보고서 정렬키 적용
  const baseSort=newTrxList.sort((a,b)=>{
    const oA=a.sortOrder!=null?a.sortOrder:99999;
    const oB=b.sortOrder!=null?b.sortOrder:99999;
    if(oA!==oB)return oA-oB;
    const dtA=(a.date||'')+(a.time?' '+a.time:'');
    const dtB=(b.date||'')+(b.time?' '+b.time:'');
    return dtA.localeCompare(dtB);
  });
  S.reportData.trxList=baseSort;
  // 현재 보고서 정렬이 날짜 기본이 아니면 정렬 적용
  const sorted=(S.rptSortKey!=='date'||S.rptSortDir!=='asc')?applyRptSort(baseSort):baseSort;
  renderRptTrxTable(sorted);
  updateRptSortArrows();
}

async function reorderRptTrx(fromId,toId){
  if(!S.reportData)return;
  const arr=[...S.reportData.trxList];
  const fi=arr.findIndex(x=>x.id===fromId), ti=arr.findIndex(x=>x.id===toId);
  if(fi<0||ti<0)return;
  const[moved]=arr.splice(fi,1); arr.splice(ti,0,moved);
  const{doc,updateDoc}=fb();
  for(let i=0;i<arr.length;i++){
    const t=arr[i]; if(t.sortOrder!==i){t.sortOrder=i;await updateDoc(doc(fdb(),COLS.TRANSACTIONS,t.id),{sortOrder:i});}
  }
  S.reportData.trxList=arr;
  renderRptTrxTable(arr);
  toast('순서 저장됨','success',1500);
}

// ─────────────────────────────────────────────
// 보고서 통장 사진 (연월 기반)
// ─────────────────────────────────────────────
async function renderRptBankStatements(clientId,year,month){
  const section=document.getElementById('rpt-bank-stmt-section');
  const gallery=document.getElementById('rpt-bank-stmt-gallery');
  const uploadBtn=document.getElementById('btn-upload-bank-stmt');
  if(!section||!gallery)return;
  const mStr=String(year)+'-'+String(month).padStart(2,'0');
  const accs=S.accounts.filter(a=>a.clientId===clientId);
  let stmts=[];
  accs.forEach(a=>{
    (a.bankStatements||[]).forEach(s=>{
      const item=typeof s==='string'?{url:s,month:'',label:a.label}:{...s,label:a.label||''};
      if(!item.month||item.month===mStr)stmts.push(item);
    });
  });
  section.style.display=stmts.length>0?'block':'none';
  gallery.innerHTML='';
  stmts.forEach(s=>{
    const driveId=s.url.match(/\/d\/([^/?]+)/)?.[1];
    const thumb=driveId?'https://drive.google.com/thumbnail?id='+driveId+'&sz=w300':s.url;
    const cell=document.createElement('div');
    cell.style.cssText='border:1px solid var(--border);border-radius:8px;overflow:hidden;cursor:pointer;';
    cell.innerHTML='<div style="font-size:10px;color:var(--muted);padding:4px 6px;background:var(--bg);">'+s.label+(s.month?' · '+s.month:'')+'</div>'
      +'<img src="'+thumb+'" style="width:100%;height:120px;object-fit:cover;" onerror="this.src=\'\'">';
    cell.addEventListener('click',()=>openReceiptModal(s.url));
    gallery.appendChild(cell);
  });
  if(uploadBtn){
    uploadBtn.onclick=()=>openBankStatementFromReport(clientId,year,month);
  }
  const viewBtn=document.getElementById('btn-view-bank-stmts');
  if(viewBtn){
    viewBtn.onclick=()=>openBankStatementsForApproval();
    viewBtn.style.display=stmts.length?'':'none';
  }
}
// ─────────────────────────────────────────────
// 결재 시 통장사진 새창으로 열기
function openBankStatementsForApproval(){
  if(!S.reportData)return;
  const{year,month,accounts}=S.reportData;
  const mStr=`${year}-${String(month).padStart(2,'0')}`;
  const imgs=[];
  (accounts||[]).forEach(a=>{
    (a.bankStatements||[]).filter(b=>b.month===mStr&&b.url).forEach(b=>{
      imgs.push({url:b.url,label:a.label||''});
    });
  });
  if(!imgs.length){toast('해당 월 통장사진이 없습니다.','info');return;}
  // 기존 패널 제거
  document.getElementById('bank-float-panel')?.remove();
  let imgIdx=0;
  const panel=document.createElement('div');
  panel.id='bank-float-panel';
  panel.style.cssText='position:fixed;right:16px;top:60px;width:400px;min-height:200px;max-height:90vh;z-index:9998;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);display:flex;flex-direction:column;resize:both;overflow:hidden;border:1px solid var(--border);';
  const renderImg=()=>{
    const it=imgs[imgIdx];
    const src=it.url.includes('drive.google.com/file/d/')?it.url.replace(/\/file\/d\/([^/]+).*/,'https://drive.google.com/thumbnail?id=$1&sz=w800'):it.url;
    panel.querySelector('#bfp-img').src=src;
    panel.querySelector('#bfp-label').textContent=`${it.label} (${imgIdx+1}/${imgs.length})`;
  };
  panel.innerHTML=`
    <div id="bfp-header" style="padding:10px 14px;background:var(--surface);border-bottom:1px solid var(--border);cursor:move;display:flex;align-items:center;gap:8px;user-select:none;">
      <span style="font-size:13px;font-weight:700;color:var(--text);flex:1;">📷 통장사진</span>
      <span id="bfp-label" style="font-size:12px;color:var(--muted);"></span>
      <button onclick="document.getElementById('bank-float-panel').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--muted);line-height:1;">×</button>
    </div>
    <div style="flex:1;overflow:auto;display:flex;flex-direction:column;align-items:center;padding:10px;gap:8px;">
      <img id="bfp-img" style="max-width:100%;border-radius:6px;display:block;" alt="통장사진" />
      ${imgs.length>1?`<div style="display:flex;gap:8px;margin-top:4px;">
        <button onclick="if(window._bfpIdx>0){window._bfpIdx--;document.getElementById('bank-float-panel').__renderImg();}" style="padding:4px 14px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;">‹ 이전</button>
        <button onclick="if(window._bfpIdx<window._bfpImgs.length-1){window._bfpIdx++;document.getElementById('bank-float-panel').__renderImg();}" style="padding:4px 14px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;">다음 ›</button>
      </div>`:''}
    </div>`;
  document.body.appendChild(panel);
  window._bfpImgs=imgs; window._bfpIdx=0;
  panel.__renderImg=()=>{
    const it=window._bfpImgs[window._bfpIdx];
    let src=it.url;
    if(src.includes('drive.google.com'))src=src.replace(/.*\/d\/([^/?]+).*/,'https://drive.google.com/thumbnail?id=$1&sz=w800');
    panel.querySelector('#bfp-img').src=src;
    panel.querySelector('#bfp-label').textContent=`${it.label} (${window._bfpIdx+1}/${window._bfpImgs.length})`;
  };
  panel.__renderImg();
  // 드래그
  const hdr=panel.querySelector('#bfp-header');
  let ox=0,oy=0,dragging=false;
  hdr.addEventListener('mousedown',e=>{dragging=true;ox=e.clientX-panel.offsetLeft;oy=e.clientY-panel.offsetTop;});
  document.addEventListener('mousemove',e=>{if(!dragging)return;panel.style.left=(e.clientX-ox)+'px';panel.style.top=(e.clientY-oy)+'px';panel.style.right='auto';});
  document.addEventListener('mouseup',()=>{dragging=false;});
}

// 엑셀 원본 대조 뷰
// ─────────────────────────────────────────────

/** rawRows ↔ trxList 매칭. 순수 함수, 상태 변경 없음 */
function matchExcelToTrx(rawRows, trxList){
  // trxList → Map<"date_abs금액", trx[]> — pool 방식으로 동일 키 다중 매칭 지원
  const trxPool=new Map();
  trxList.forEach(t=>{
    const amt=Math.max(Number(t.amountIn||0),Number(t.amountOut||0));
    const key=`${t.date}_${amt}`;
    if(!trxPool.has(key))trxPool.set(key,[]);
    trxPool.get(key).push(t);
  });
  const matchedIds=new Set();
  const rows=rawRows.map(row=>{
    const amt=Math.max(row.amountIn||0,row.amountOut||0);
    const key=`${row.date}_${amt}`;
    const pool=trxPool.get(key)||[];
    const trx=pool.shift(); // 순서대로 소비 — 같은 날짜+금액 2건도 정확히 1:1 매칭
    let status='❌'; // 미입력
    if(trx){
      matchedIds.add(trx.id);
      // 내용 유사 여부: desc가 description에 포함되거나 그 반대
      const d1=(row.desc||'').toLowerCase(), d2=(trx.description||'').toLowerCase();
      status=(d1&&d2&&(d1.includes(d2)||d2.includes(d1)))?'✅':'⚠️';
    }
    return {type:'raw',date:row.date,desc:row.desc,amtRaw:Math.max(row.amountIn||0,row.amountOut||0),isIn:(row.amountIn||0)>0,trx,status};
  });
  // 수기 추가: trxList 중 매칭되지 않은 것 (자산이동·취소 제외)
  const manual=trxList
    .filter(t=>!matchedIds.has(t.id)&&t.type!=='자산이동'&&t.type!=='취소')
    .map(t=>({type:'manual',date:t.date,desc:t.description,amtRaw:Math.max(Number(t.amountIn||0),Number(t.amountOut||0)),isIn:Number(t.amountIn||0)>0,trx:t,status:'➕'}));
  return [...rows,...manual].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
}

async function renderRptExcelComparison(clientId,year,month){
  const section=document.getElementById('rpt-excel-cmp-section');
  if(!section)return;
  const mStr=String(year)+'-'+String(month).padStart(2,'0');
  const{getDocs,collection,query,where}=fb();
  // 해당 월 excelUploads 조회
  const snap=await getDocs(query(collection(fdb(),COLS.EXCEL_UPLOADS),where('clientId','==',clientId),where('month','==',mStr)));
  if(snap.empty){section.style.display='none';return;}
  const uploads=snap.docs.map(d=>({id:d.id,...d.data()}));
  const trxList=S.reportData?.trxList||[];
  // 접이식 섹션 렌더링
  const statusColor={'✅':'#dcfce7','⚠️':'#fef9c3','❌':'#fee2e2','➕':'#dbeafe'};
  const statusLabel={'✅':'일치','⚠️':'수정됨','❌':'미입력','➕':'수기추가'};
  let html=`<div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;" id="rpt-excel-cmp-toggle">
    <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;">📊 엑셀 원본 대조</div>
    <span id="rpt-excel-cmp-arrow" style="font-size:12px;color:#9ca3af;">▼ 펼치기</span>
  </div>
  <div id="rpt-excel-cmp-body" style="display:none;margin-top:10px;">`;
  uploads.forEach(upload=>{
    const rows=matchExcelToTrx(upload.rawRows||[],trxList);
    const cnt={};rows.forEach(r=>{cnt[r.status]=(cnt[r.status]||0)+1;});
    const summary=Object.entries(cnt).map(([s,n])=>`<span style="background:${statusColor[s]};padding:2px 7px;border-radius:5px;font-size:11px;font-weight:700;">${s} ${statusLabel[s]} ${n}</span>`).join(' ');
    html+=`<div style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px;">
        <div style="font-size:12px;font-weight:700;color:#374151;">📄 ${upload.filename||'업로드 파일'} <span style="font-weight:400;color:#9ca3af;">· ${upload.uploadedAt||''}</span></div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${summary}<a href="${upload.url}" target="_blank" rel="noopener" style="font-size:11px;font-weight:700;color:var(--blue);border:1px solid #bfdbfe;padding:2px 9px;border-radius:6px;text-decoration:none;background:#eff6ff;">🔗 파일 열기</a></div>
      </div>
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
          <th style="padding:6px 8px;text-align:left;font-weight:700;color:#6b7280;white-space:nowrap;">날짜</th>
          <th style="padding:6px 8px;text-align:left;font-weight:700;color:#6b7280;">원본 내용</th>
          <th style="padding:6px 8px;text-align:right;font-weight:700;color:#6b7280;white-space:nowrap;">원본 금액</th>
          <th style="padding:6px 8px;text-align:left;font-weight:700;color:#6b7280;">입력 분류 / 내용</th>
          <th style="padding:6px 8px;text-align:center;font-weight:700;color:#6b7280;">상태</th>
        </tr></thead>
        <tbody>`;
    rows.forEach(r=>{
      const bg=statusColor[r.status]||'';
      const amtStr=r.amtRaw>0?r.amtRaw.toLocaleString()+'원':'—';
      const amtColor=r.isIn?'#15803d':'#b91c1c';
      const trxInfo=r.trx?`<span style="color:#374151;">${r.trx.category||''}</span>${r.trx.description?` / <span style="color:#6b7280;">${r.trx.description}</span>`:''}`:
        (r.type==='manual'?`<span style="color:#374151;">${r.trx?.category||''}</span>`:
        '<span style="color:#9ca3af;font-style:italic;">미입력</span>');
      const originInfo=r.type==='manual'?'<span style="color:#9ca3af;font-style:italic;">수기입력</span>':r.desc||'';
      html+=`<tr style="border-bottom:1px solid #f3f4f6;background:${bg};">
        <td style="padding:5px 8px;white-space:nowrap;font-family:monospace;">${r.date||''}</td>
        <td style="padding:5px 8px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${originInfo}">${originInfo}</td>
        <td style="padding:5px 8px;text-align:right;font-family:monospace;color:${amtColor};white-space:nowrap;">${amtStr}</td>
        <td style="padding:5px 8px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${trxInfo}</td>
        <td style="padding:5px 8px;text-align:center;">${r.status}</td>
      </tr>`;
    });
    html+=`</tbody></table></div></div>`;
  });
  html+='</div>';
  section.innerHTML=html;
  section.style.display='block';
  // 접이식 토글
  document.getElementById('rpt-excel-cmp-toggle')?.addEventListener('click',()=>{
    const body=document.getElementById('rpt-excel-cmp-body');
    const arrow=document.getElementById('rpt-excel-cmp-arrow');
    const open=body.style.display==='none';
    body.style.display=open?'block':'none';
    if(arrow)arrow.textContent=open?'▲ 접기':'▼ 펼치기';
  });
}

async function openBankStatementFromReport(clientId,year,month){
  const accs=S.accounts.filter(a=>a.clientId===clientId);
  if(!accs.length){toast('계좌가 없습니다.','error');return;}
  if(accs.length===1){openBankStatementModal(accs[0].id,year,month);return;}
  document.getElementById('modal-wrap').classList.add('show');
  const body=document.getElementById('modal-body');
  body.innerHTML='<h3 style="font-size:16px;font-weight:800;margin-bottom:14px;">📸 통장 사진 업로드</h3>'
    +'<p style="font-size:13px;color:var(--muted);margin-bottom:12px;">사진을 업로드할 계좌를 선택하세요.</p>'
    +'<div style="display:flex;flex-direction:column;gap:8px;">'
    +accs.map(a=>'<button class="btn-sub" style="color:var(--blue);border-color:#bfdbfe;padding:10px;font-size:13px;" onclick="closeModal();openBankStatementModal(\''+a.id+'\','+year+','+month+');">['+a.label+'] 선택</button>').join('')
    +'</div>';
}

// ⑦ 의견란 렌더링
function renderComments(report,curStatus){
  const el=document.getElementById('rpt-comments-area'); if(!el)return;
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
  const client=S.clients.find(c=>c.id===S.reportData?.clientId);
  const teamLeaderId=String(client?.teamLeader||'');
  const isThisLeader=role==='팀장'&&userId===teamLeaderId;
  el.innerHTML='<div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;">의견</div>';
  const sections=[
    {key:'staffComment',  label:'담당자 의견', editable: role==='담당자'&&(!curStatus||curStatus==='draft'||curStatus==='rejected')},
    {key:'leaderComment', label:'팀장 의견',   editable: isThisLeader},
    {key:'centerComment', label:'센터장 의견', editable: role==='센터장'||role==='관리자'},
  ];
  sections.forEach(s=>{
    const val=report?.[s.key]||'';
    const div=document.createElement('div');
    div.style.cssText='margin-bottom:12px;';
    div.innerHTML='<div style="font-size:11px;font-weight:700;color:#9ca3af;margin-bottom:6px;">'+s.label+'</div>';
    if(s.editable){
      div.innerHTML+='<textarea id="comment-'+s.key+'" style="width:100%;min-height:60px;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;resize:vertical;" placeholder="'+s.label+'을 입력하세요...">'+val+'</textarea>'
        +'<button onclick="saveComment(\''+s.key+'\')" style="margin-top:4px;font-size:12px;font-weight:700;color:var(--blue);border:1px solid #bfdbfe;background:#eff6ff;padding:4px 12px;border-radius:6px;cursor:pointer;">저장</button>';
    } else {
      div.innerHTML+='<div style="font-size:14px;color:#374151;min-height:30px;padding:8px 10px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">'+(val||'(없음)')+'</div>';
    }
    el.appendChild(div);
  });
}
async function saveComment(key){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const val=document.getElementById('comment-'+key)?.value||'';
  const{doc,updateDoc,addDoc,collection}=fb();
  const{clientId,year,month,report}=S.reportData;
  const now=new Date().toISOString();
  if(report?.id){
    await updateDoc(doc(fdb(),COLS.REPORTS,report.id),{[key]:val});
    if(!S.reportData.report)S.reportData.report={};
    S.reportData.report[key]=val;
  } else {
    const data={clientId,year,month,status:'draft',createdAt:now,[key]:val};
    const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);
    S.reportData.report={id:ref.id,...data};
  }
  toast('의견이 저장되었습니다.','success',2000);
}

// ─────────────────────────────────────────────
// 보고서 월별 추이 차트
// ─────────────────────────────────────────────
function renderTrendChart(clientId,baseYear,baseMonth){
  const ctx=document.getElementById('rpt-trend-chart'); if(!ctx)return;
  if(S.rptTrendChart){S.rptTrendChart.destroy();S.rptTrendChart=null;}
  const months=[];
  for(let i=5;i>=0;i--){
    const d=new Date(baseYear,baseMonth-1-i,1);
    months.push(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'));
  }
  const inData=[],outData=[];
  months.forEach(m=>{
    let inS=0,outS=0;
    S.transactions.forEach(t=>{
      if(t.clientId!==clientId||(t.date||'').substring(0,7)!==m)return;
      if(t.type==='자산이동'||t.type==='취소')return;
      inS+=Number(t.amountIn||0); outS+=Number(t.amountOut||0);
    });
    inData.push(inS); outData.push(outS);
  });
  S.rptTrendChart=new Chart(ctx.getContext('2d'),{type:'bar',data:{labels:months.map(m=>{const p=m.split('-');return parseInt(p[1])+'월';}),datasets:[{label:'수입',data:inData,backgroundColor:'rgba(16,185,129,.7)',borderRadius:4},{label:'지출',data:outData,backgroundColor:'rgba(244,63,94,.7)',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:11},color:'#64748b'}}},scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#94a3b8',font:{size:10},callback:v=>v>=10000?(v/10000).toFixed(0)+'만':''+v},grid:{color:'rgba(0,0,0,.04)'}}}}});
}

// 규칙 기반 자동 분석
function handleGenSummary(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const text=generateRuleBasedSummary(S.reportData);
  setText('rpt-summary-text',text);
  const printText=document.getElementById('rpt-summary-print-text');
  const printArea=document.getElementById('rpt-summary-print-area');
  const printCheck=document.getElementById('rpt-summary-print');
  if(printText)printText.textContent=text;
  if(printCheck?.checked&&printArea)printArea.style.display='block';
  toast('분석 완료','success',2000);
}

// ─────────────────────────────────────────────
// 결재
// ─────────────────────────────────────────────

function renderApproval(report,curStatus){
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
  const client=S.clients.find(c=>c.id===S.reportData?.clientId);
  const teamLeaderId=String(client?.teamLeader||'');
  const isThisLeader=role==='팀장'&&userId===teamLeaderId;
  const staffIds=String(client?.userIds||'').split(',').map(s=>s.trim());
  const isDirectStaff=staffIds.includes(userId);
  const isLeaderDirectSubmit=isThisLeader&&isDirectStaff;

  // 결재란
  const grid=document.getElementById('rpt-approval-grid'); grid.innerHTML='';
  [{label:'담당',name:report?.submittedByName||'',date:report?.submittedAt||''},{label:'팀장',name:report?.teamApprovedByName||'',date:report?.teamApprovedAt||''},{label:'센터장',name:report?.centerApprovedByName||'',date:report?.centerApprovedAt||''}].forEach((s,i,arr)=>{
    const cell=document.createElement('div'); cell.style.cssText='width:88px;'+(i<arr.length-1?'border-right:1px solid #d1d5db;':'');
    const dStr=s.date?new Date(s.date).toLocaleDateString('ko-KR',{month:'2-digit',day:'2-digit'}):'';
    cell.innerHTML='<div style="background:#f9fafb;padding:6px 8px;text-align:center;font-size:11px;font-weight:700;color:#6b7280;border-bottom:1px solid #d1d5db;">'+s.label+'</div><div style="height:58px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:7px;">'+(s.name?'<div style="font-size:12px;font-weight:700;color:#374151;">'+s.name+'</div><div style="font-size:10px;color:#9ca3af;">'+dStr+'</div>':'')+'</div>';
    grid.appendChild(cell);
  });

  // 결재 트랙
  const track=document.getElementById('rpt-track-inner'); track.innerHTML='';
  const ORDER=['','draft','submitted','team_approved','confirmed'], curIdx=ORDER.indexOf(curStatus);
  [{key:'submitted',label:'제출',icon:'✍️',name:report?.submittedByName||'',date:report?.submittedAt||''},{key:'team_approved',label:'팀장 결재',icon:'✔️',name:report?.teamApprovedByName||'',date:report?.teamApprovedAt||''},{key:'confirmed',label:'센터장 최종',icon:'🏁',name:report?.centerApprovedByName||'',date:report?.centerApprovedAt||''}].forEach((s,i,arr)=>{
    const done=curIdx>=ORDER.indexOf(s.key), dStr=s.date?new Date(s.date).toLocaleDateString('ko-KR',{month:'2-digit',day:'2-digit'}):'';
    const el=document.createElement('div'); el.style.cssText='display:flex;align-items:center;';
    el.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;"><div style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;background:'+(done?'var(--blue)':'#f1f5f9')+';color:'+(done?'#fff':'#94a3b8')+';">'+(done?s.icon:i+1)+'</div><div style="font-size:11px;font-weight:700;margin-top:5px;color:'+(done?'var(--blue)':'#94a3b8')+';">'+s.label+'</div>'+(s.name&&done?'<div style="font-size:10px;color:#94a3b8;">'+s.name+'</div>':'')+'</div>';
    track.appendChild(el);
    if(i<arr.length-1){const line=document.createElement('div');line.style.cssText='flex:1;height:2px;margin:0 6px;background:'+(done&&curIdx>ORDER.indexOf(s.key)?'var(--blue)':'#e2e8f0')+';';track.appendChild(line);}
  });

  // 상단: 인쇄/엑셀 버튼
  const btns=document.getElementById('rpt-action-btns'); btns.innerHTML='';
  const mkBtnTo=(container,lbl,style,fn)=>{const b=document.createElement('button');b.className='btn-sub';b.style.cssText=style+'font-size:13px;';b.textContent=lbl;b.addEventListener('click',fn);container.appendChild(b);};
  mkBtnTo(btns,'🖨️ 인쇄/PDF','color:var(--blue);border-color:#bfdbfe;',()=>{if(!S.reportData){toast('먼저 조회하세요.','error');return;}window.print();});
  mkBtnTo(btns,'📊 엑셀 저장','color:#059669;border-color:#a7f3d0;',exportReportExcel);

  // 하단: 제출/결재/반려 버튼
  const sbEl=document.getElementById('rpt-submit-btns');
  if(sbEl){
    sbEl.innerHTML='';
    sbEl.style.display='none';
    const mkBtn=(lbl,style,fn)=>mkBtnTo(sbEl,lbl,style,fn);
    const showSb=()=>{sbEl.style.display='flex';};

    if(role==='담당자'&&(!curStatus||curStatus==='draft'||curStatus==='rejected')){
      showSb();
      mkBtn('💾 임시저장','color:#64748b;border-color:#cbd5e1;',()=>doApproval('draft'));
      mkBtn('📤 제출','color:var(--amber);border-color:#fde68a;',()=>showConfirm('보고서 제출','제출 후에는 담당자가 수정할 수 없습니다.\n계속하시겠습니까?',()=>doApproval('approve'),'제출'));
    }
    if(isLeaderDirectSubmit&&(!curStatus||curStatus==='draft')){
      showSb();
      mkBtn('💾 임시저장','color:#64748b;border-color:#cbd5e1;',()=>doApprovalAsLeader('draft'));
      mkBtn('📤 직접 제출','color:var(--amber);border-color:#fde68a;',()=>showConfirm('보고서 제출','담당 팀장으로서 직접 제출합니다.\n팀장 결재가 자동으로 완료됩니다.',()=>doApprovalAsLeader('submit_and_approve'),'제출'));
    }
    if(isThisLeader&&curStatus==='submitted'){
      showSb();
      const bApp=document.createElement('button');bApp.className='btn';bApp.style.cssText='background:var(--green);font-size:13px;padding:8px 14px;';
      bApp.textContent='✅ 팀장 결재';
      bApp.addEventListener('click',()=>showConfirm('팀장 결재','팀장 결재를 진행하시겠습니까?',()=>{openBankStatementsForApproval();doApproval('approve');},'결재'));
      sbEl.appendChild(bApp);
      mkBtn('↩️ 반려','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 반려','담당자에게 반려합니다.\n반려 사유를 팀장 의견란에 입력해 주세요.',()=>doReject(),'반려'));
      mkBtn('✏️ 수정(초안)','color:#64748b;border-color:#cbd5e1;',()=>doRevertToDraft('팀장'));
      mkBtn('🗑️ 삭제','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 삭제','이 보고서를 삭제하시겠습니까?',()=>doDeleteReport(),'삭제'));
    }
    if(isThisLeader&&curStatus==='team_approved'){
      showSb();
      mkBtn('↩️ 결재 취소','color:#64748b;border-color:#cbd5e1;',()=>showConfirm('결재 취소','팀장 결재를 취소하고 제출 상태로 되돌립니다.',()=>doRevertToDraft('팀장'),'취소'));
    }
    if((role==='센터장'||role==='관리자')&&curStatus==='team_approved'){
      showSb();
      const bFinal=document.createElement('button');bFinal.className='btn';bFinal.style.cssText='font-size:13px;padding:8px 14px;';
      bFinal.textContent='🏁 최종 결재';
      bFinal.addEventListener('click',()=>showConfirm('최종 결재','최종 결재를 완료하시겠습니까?',()=>{openBankStatementsForApproval();doApproval('approve');},'결재'));
      sbEl.appendChild(bFinal);
      mkBtn('↩️ 반려','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 반려','반려합니다.\n반려 사유를 센터장 의견란에 입력해 주세요.',()=>doReject(),'반려'));
      mkBtn('✏️ 수정(초안)','color:#64748b;border-color:#cbd5e1;',()=>doRevertToDraft('센터장'));
      mkBtn('🗑️ 삭제','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 삭제','이 보고서를 삭제하시겠습니까?',()=>doDeleteReport(),'삭제'));
    }
    if((role==='센터장'||role==='관리자')&&curStatus==='confirmed'){
      showSb();
      mkBtn('↩️ 결재 취소','color:#64748b;border-color:#cbd5e1;',()=>showConfirm('결재 취소','최종 결재를 취소하고 팀장결재 상태로 되돌립니다.',()=>doRevertToDraft('센터장'),'취소'));
      mkBtn('🗑️ 삭제','color:#dc2626;border-color:#fecaca;',()=>showConfirm('보고서 삭제','이 보고서를 삭제하시겠습니까?',()=>doDeleteReport(),'삭제'));
    }
  }
}

async function doApproval(action){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{clientId,year,month,report,summary}=S.reportData;
  const{doc,updateDoc,collection,addDoc}=fb();
  const now=new Date().toISOString(), summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  if(action==='draft'){
    const data={clientId,year,month,status:'draft',summary:summaryStr,createdAt:now};
    if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),data);
    else{const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
    toast('임시저장되었습니다.','success');
  }else{
    const role=S.user?.role;
    const rules={
      담당자:{next:'submitted',atKey:'submittedAt',byKey:'submittedBy',nameKey:'submittedByName'},
      팀장:{next:'team_approved',atKey:'teamApprovedAt',byKey:'teamApprovedBy',nameKey:'teamApprovedByName'},
      센터장:{next:'confirmed',atKey:'centerApprovedAt',byKey:'centerApprovedBy',nameKey:'centerApprovedByName'},
      관리자:{next:'confirmed',atKey:'centerApprovedAt',byKey:'centerApprovedBy',nameKey:'centerApprovedByName'},
    };
    const rule=rules[role]; if(!rule){toast('결재 권한 없음','error');return;}
    const update={status:rule.next,summary:summaryStr,[rule.atKey]:now,[rule.byKey]:String(S.user.userId),[rule.nameKey]:S.user.name||''};
    if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),update);
    else{const data={clientId,year,month,createdAt:now,...update};const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
    toast({submitted:'제출되었습니다.',team_approved:'팀장 결재 완료.',confirmed:'최종 결재 완료.'}[rule.next]||'완료','success');
  }
  await loadReport(); loadReportList();
}

async function doApprovalAsLeader(action){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{clientId,year,month,report,summary}=S.reportData;
  const{doc,updateDoc,collection,addDoc}=fb();
  const now=new Date().toISOString(), summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  if(action==='draft'){
    const data={clientId,year,month,status:'draft',summary:summaryStr,createdAt:now};
    if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),data);
    else{const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
    toast('임시저장되었습니다.','success');
  }else{
    const update={status:'team_approved',summary:summaryStr,submittedAt:now,submittedBy:String(S.user.userId),submittedByName:S.user.name||'',teamApprovedAt:now,teamApprovedBy:String(S.user.userId),teamApprovedByName:S.user.name||''};
    if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),update);
    else{const data={clientId,year,month,createdAt:now,...update};const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
    toast('팀장 직접 제출 완료! 센터장 결재 대기 중.','success');
  }
  await loadReport(); loadReportList();
}

async function doReject(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{clientId,year,month,report,summary}=S.reportData;
  const{doc,updateDoc,addDoc,collection}=fb();
  const now=new Date().toISOString();
  const summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  const update={status:'rejected',summary:summaryStr,rejectedAt:now,rejectedBy:String(S.user.userId),rejectedByName:S.user.name||''};
  if(report?.id)await updateDoc(doc(fdb(),COLS.REPORTS,report.id),update);
  else{const data={clientId,year,month,createdAt:now,...update};const ref=await addDoc(collection(fdb(),COLS.REPORTS),data);S.reportData.report={id:ref.id,...data};}
  toast('보고서가 반려되었습니다.','info',4000);
  await loadReport(); loadReportList();
}

async function doRevertToDraft(byRole){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{report,summary}=S.reportData;
  const{doc,updateDoc}=fb();
  const summaryStr=JSON.stringify({totalIn:summary.totalIn,totalOut:summary.totalOut,balance:summary.balance});
  let newStatus='draft';
  if(byRole==='팀장'&&S.reportData.report?.status==='team_approved')newStatus='submitted';
  if(byRole==='센터장'&&S.reportData.report?.status==='confirmed')newStatus='team_approved';
  if(!report?.id){toast('저장된 보고서가 없습니다.','error');return;}
  await updateDoc(doc(fdb(),COLS.REPORTS,report.id),{status:newStatus,summary:summaryStr});
  toast('상태가 변경되었습니다.','success');
  await loadReport(); loadReportList();
}

async function doDeleteReport(){
  if(!S.reportData?.report?.id){toast('저장된 보고서가 없습니다.','error');return;}
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),COLS.REPORTS,S.reportData.report.id));
  S.reportData.report=null;
  toast('보고서가 삭제되었습니다.','success');
  document.getElementById('report-area').style.display='none';
  loadReportList();
}

async function loadReportList(){
  const{getDocs,collection}=fb();
  const snap=await getDocs(collection(fdb(),COLS.REPORTS));
  const list=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.year*100+b.month)-(a.year*100+a.month));
  // confirmed 월 캐시 갱신 (결재 완료 즉시 반영)
  S.confirmedMonths=new Set(list.filter(r=>r.status==='confirmed').map(r=>`${r.clientId}_${r.year}-${String(r.month).padStart(2,'0')}`));
  const el=document.getElementById('rpt-list'); if(!el)return;
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
  const pendingEl=document.getElementById('rpt-pending-list');
  if(pendingEl){
    const pending=list.filter(r=>{
      const client=S.clients.find(c=>c.id===r.clientId);
      const tlId=String(client?.teamLeader||'');
      if(role==='팀장'&&userId===tlId&&r.status==='submitted')return true;
      if((role==='센터장'||role==='관리자')&&r.status==='team_approved')return true;
      return false;
    });
    const pendingCountEl=document.getElementById('rpt-pending-count');
    if(pendingCountEl)pendingCountEl.textContent=pending.length?pending.length+'건':'없음';
    pendingEl.innerHTML='';
    if(!pending.length){pendingEl.innerHTML='<div style="font-size:13px;color:var(--muted);padding:8px 0;">결재 대기 중인 보고서가 없습니다.</div>';}
    else pending.forEach(r=>{
      const client=S.clients.find(c=>c.id===r.clientId)||{name:r.clientId};
      const div=document.createElement('div');
      div.style.cssText='display:flex;justify-content:space-between;align-items:center;background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;margin-bottom:6px;cursor:pointer;';
      div.innerHTML='<div><div style="font-weight:700;color:#92400e;font-size:14px;">⏳ '+client.name+' — '+r.year+'년 '+r.month+'월</div><div style="font-size:12px;color:#b45309;margin-top:2px;">결재 대기 중</div></div><span class="'+(STATUS_CLASSES[r.status]||'rs-draft')+'">'+(STATUS_LABELS[r.status]||r.status)+'</span>';
      div.addEventListener('click',()=>{
        const rc=document.getElementById('r-client'),ry=document.getElementById('r-year'),rm=document.getElementById('r-month');
        if(rc)rc.value=r.clientId; if(ry)ry.value=r.year; if(rm)rm.value=r.month; loadReport();
      });
      pendingEl.appendChild(div);
    });
    const pendingWrap=document.getElementById('rpt-pending-wrap');
    if(pendingWrap)pendingWrap.style.display=(role==='팀장'||role==='센터장'||role==='관리자')?'block':'none';
    const badge=document.getElementById('nav-rpt-badge');
    if(badge){if(pending.length>0){badge.textContent=pending.length;badge.style.display='inline';}else badge.style.display='none';}
  }
  // 담당자 역할은 자신이 담당하는 대상자의 보고서만 표시 (S.clients는 이미 필터됨)
  const myClientIds=new Set(S.clients.map(c=>c.id));
  const visibleList=(role==='담당자')?list.filter(r=>myClientIds.has(r.clientId)):list;
  if(!visibleList.length){el.innerHTML='<div class="empty-state"><div class="icon">📑</div>저장된 보고서가 없습니다.</div>';return;}
  // 테이블 형식 렌더링
  const table=document.createElement('table');
  table.style.cssText='width:100%;border-collapse:collapse;font-size:13px;';
  table.innerHTML=`<thead><tr style="border-bottom:2px solid var(--border);">
    <th style="padding:8px 10px;text-align:left;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;white-space:nowrap;">입주자</th>
    <th style="padding:8px 10px;text-align:center;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">연도</th>
    <th style="padding:8px 10px;text-align:center;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">월</th>
    <th style="padding:8px 10px;text-align:center;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">상태</th>
    <th style="padding:8px 10px;text-align:left;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">제출자</th>
    <th style="padding:8px 10px;text-align:left;font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;">작성일</th>
  </tr></thead>`;
  const tbody=document.createElement('tbody');
  visibleList.forEach(r=>{
    const client=S.clients.find(c=>c.id===r.clientId)||{name:r.clientId};
    const tr=document.createElement('tr');
    tr.dataset.reportId=r.id;
    tr.style.cssText='border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s;';
    tr.innerHTML=`<td style="padding:9px 10px;font-weight:600;color:var(--text);">${client.name}</td>
      <td style="padding:9px 10px;text-align:center;color:var(--sub);">${r.year}년</td>
      <td style="padding:9px 10px;text-align:center;color:var(--sub);">${r.month}월</td>
      <td style="padding:9px 10px;text-align:center;"><span class="${STATUS_CLASSES[r.status]||'rs-draft'}">${STATUS_LABELS[r.status]||r.status}</span></td>
      <td style="padding:9px 10px;color:var(--muted);font-size:12px;">${r.submittedByName||'-'}</td>
      <td style="padding:9px 10px;color:var(--muted);font-size:12px;">${r.createdAt?new Date(r.createdAt).toLocaleDateString('ko-KR'):'-'}</td>`;
    tr.addEventListener('mouseenter',()=>{if(S.reportData?.report?.id!==r.id)tr.style.background='var(--bg)';});
    tr.addEventListener('mouseleave',()=>{if(S.reportData?.report?.id!==r.id)tr.style.background='';});
    tr.addEventListener('click',()=>{
      if(S.reportData?.report?.id===r.id){
        const ra=document.getElementById('report-area');
        if(ra)ra.style.display='none';
        S.reportData=null;
        tbody.querySelectorAll('tr').forEach(t=>{t.style.background='';t.style.fontWeight='';});
        return;
      }
      tbody.querySelectorAll('tr').forEach(t=>{t.style.background='';t.style.fontWeight='';});
      tr.style.background='#eff6ff';
      const rc=document.getElementById('r-client'),ry=document.getElementById('r-year'),rm=document.getElementById('r-month');
      if(rc)rc.value=r.clientId; if(ry)ry.value=r.year; if(rm)rm.value=r.month; loadReport();
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  el.appendChild(table);
}

async function exportReportExcel(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{clientId,year,month,trxList,summary}=S.reportData;
  const client=S.clients.find(c=>c.id===clientId)||{name:'-'};
  const XLSX=window.XLSX;
  if(!XLSX){toast('엑셀 라이브러리가 없습니다.','error');return;}
  const tData=[['날짜','분류','내용','수입','지출','영수증'],...trxList.map(t=>[t.date,t.category,t.description,t.amountIn||0,t.amountOut||0,t.receiptUrl||''])];
  const ws=XLSX.utils.aoa_to_sheet(tData);
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,year+'년'+month+'월');
  XLSX.writeFile(wb,client.name+'_'+year+'년'+month+'월_금전관리.xlsx');
}

// ─────────────────────────────────────────────
// 연간 통계
// ─────────────────────────────────────────────
(()=>{const sel=document.getElementById('a-year');if(!sel)return;const cy=new Date().getFullYear();for(let y=cy;y>=cy-6;y--)sel.add(new Option(y+'년',y));sel.value=cy;})();
document.getElementById('btn-annual-load')?.addEventListener('click',loadAnnual);
(()=>{const ySel=document.getElementById('r-year'),mSel=document.getElementById('r-month');if(!ySel||!mSel)return;const cy=new Date().getFullYear(),cm=new Date().getMonth()+1;for(let y=cy;y>=cy-5;y--)ySel.add(new Option(y+'년',y));ySel.value=cy;for(let m=1;m<=12;m++)mSel.add(new Option(m+'월',m));mSel.value=cm;})();
document.getElementById('btn-rpt-load')?.addEventListener('click',loadReport);
document.getElementById('btn-rpt-list-refresh')?.addEventListener('click',loadReportList);
document.getElementById('btn-gen-summary')?.addEventListener('click',handleGenSummary);
document.getElementById('rpt-summary-print')?.addEventListener('change',e=>{const area=document.getElementById('rpt-summary-print-area');if(area)area.style.display=e.target.checked?'block':'none';});

// ─────────────────────────────────────────────
// 관리 (입주자/계좌/직원)
// ─────────────────────────────────────────────
function renderManagement(){
  const isAdmin=['관리자','센터장','팀장'].includes(S.user?.role);
  const sl=document.getElementById('staff-list'); if(sl)sl.innerHTML='';
  const adminStaff=document.getElementById('admin-staff');
  if(adminStaff)adminStaff.style.display=isAdmin?'block':'none';
  if(isAdmin&&sl)S.users.forEach(u=>{
    const d=document.createElement('div');d.className='card';d.style.cssText='padding:12px 14px;display:flex;justify-content:space-between;align-items:center;';
    d.innerHTML='<div><div style="font-weight:700;font-size:14px;color:var(--text);">'+u.name+'</div><div style="font-size:12px;color:var(--muted);">'+(u.role||'')+(u.team?' · '+u.team:'')+'</div></div><div style="display:flex;gap:6px;"><button class="icon-btn" style="color:#64748b;" onclick="openModal(\'staff\',S.users.find(x=>x.id===\''+u.id+'\'))">✏️</button><button class="icon-btn" style="color:#94a3b8;" onclick="confirmDelete(\'staff\',\''+u.id+'\')">🗑️</button></div>';
    sl.appendChild(d);
  });
  const cl=document.getElementById('client-list'); if(cl)cl.innerHTML='';
  if(cl)S.clients.forEach(c=>{
    const d=document.createElement('div');d.className='card';d.style.cssText='padding:12px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
    const leader=S.users.find(u=>String(u.id)===String(c.teamLeader));
    d.innerHTML='<div><div style="font-weight:700;font-size:14px;color:var(--text);">'+c.name+'</div><div style="font-size:12px;color:var(--muted);">'+(leader?'팀장: '+leader.name:'담당팀장 미지정')+'</div></div><div style="display:flex;gap:6px;"><button class="icon-btn" style="color:#64748b;" onclick="openModal(\'client\',S.clients.find(x=>x.id===\''+c.id+'\'))">✏️</button><button class="icon-btn" style="color:#94a3b8;" onclick="confirmDelete(\'client\',\''+c.id+'\')">🗑️</button></div>';
    cl.appendChild(d);
  });
  const al=document.getElementById('account-list'); if(al)al.innerHTML='';
  if(al)S.accounts.forEach(a=>{
    const client=S.clients.find(c=>c.id===a.clientId)||{name:'-'};
    const d=document.createElement('div');d.className='card';d.style.cssText='padding:12px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
    d.innerHTML='<div><div style="font-weight:700;font-size:14px;color:var(--text);">'+a.label+'</div><div style="font-size:12px;color:var(--muted);">'+(client.name)+(a.accountNumber?' · '+a.accountNumber:'')+(a.initialBalanceDate?' · 기준일:'+a.initialBalanceDate:'')+'</div></div><div style="display:flex;gap:6px;"><button class="icon-btn" style="color:#64748b;" onclick="openModal(\'account\',S.accounts.find(x=>x.id===\''+a.id+'\'))">✏️</button><button class="icon-btn" style="color:#94a3b8;" onclick="confirmDelete(\'account\',\''+a.id+'\')">🗑️</button></div>';
    al.appendChild(d);
  });
}

function confirmDelete(type,id){
  const labels={client:'입주자',account:'계좌',staff:'직원'};
  showConfirm(labels[type]+' 삭제',labels[type]+'를 삭제하시겠습니까?',async()=>{
    const{doc,deleteDoc}=fb();
    const cols={client:COLS.CLIENTS,account:COLS.ACCOUNTS,staff:COLS.USERS};
    await deleteDoc(doc(fdb(),cols[type],id));
    await fetchBaseData(); renderManagement();
    toast('삭제됨','success');
  },'삭제');
}

document.getElementById('btn-add-client')?.addEventListener('click',()=>openModal('client'));
document.getElementById('btn-add-account')?.addEventListener('click',()=>openModal('account'));
document.getElementById('btn-add-staff')?.addEventListener('click',()=>openModal('staff'));

// ─────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────
async function loadSettings(){
  const isArchive=['관리자','센터장'].includes(S.user?.role);
  const archSec=document.getElementById('archive-section');
  if(archSec)archSec.style.display=isArchive?'block':'none';
  if(isArchive){
    const ySel=document.getElementById('archive-year');
    if(ySel&&!ySel.options.length){const cy=new Date().getFullYear();for(let y=cy-1;y>=cy-6;y--)ySel.add(new Option(y+'년',y));}
    loadArchiveHistory();
  }
  const cSel=document.getElementById('settings-client-sel');
  if(cSel){
    const prev=cSel.value;
    cSel.innerHTML='<option value="">공통 (전체 입주자)</option>';
    S.clients.forEach(c=>cSel.add(new Option(c.name,c.id)));
    if(S.clients.some(c=>c.id===prev))cSel.value=prev;
    if(!cSel.dataset.bound){cSel.dataset.bound='1';cSel.addEventListener('change',loadSettings);}
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
}

function renderCatTags(type){
  const id=type==='지출'?'exp-cat-tags':'inc-cat-tags';
  const el=document.getElementById(id); if(!el)return;
  const settingsClientId=S.settings.settingsClientId||'';
  const clientName=settingsClientId?S.clients.find(c=>c.id===settingsClientId)?.name||'':'';
  const allCats=S.categories.filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===settingsClientId)).sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  const colors=type==='지출'?['#dc2626','#ea580c','#d97706','#16a34a','#2563eb','#9333ea','#c026d3']:['#059669','#0891b2','#1d4ed8'];
  el.innerHTML='<p style="font-size:11px;color:var(--muted);margin-bottom:8px;">⠿ 드래그로 순서 변경</p>';
  let dragSrc=null;
  const seen=new Set();
  allCats.forEach((catDoc,i)=>{
    const cat=catDoc.category; if(seen.has(cat+(catDoc.clientId||'')))return; seen.add(cat+(catDoc.clientId||''));
    const color=colors[i%colors.length], tag=document.createElement('span');
    const isPersonal=!!catDoc.clientId;
    tag.className='cat-tag'; tag.style.borderColor=color+'44'; tag.style.backgroundColor=color+'15';
    tag.style.cursor='grab'; tag.draggable=true; tag.dataset.docId=catDoc.id;
    tag.innerHTML='<span style="font-size:11px;color:#94a3b8;margin-right:2px;">⠿</span>'
      +'<span style="width:8px;height:8px;border-radius:50%;background:'+color+';display:inline-block;"></span>'
      +'<span style="font-size:13px;font-weight:700;color:'+color+';">'+cat+'</span>'
      +(isPersonal?'<span style="font-size:10px;background:'+color+'22;color:'+color+';padding:1px 5px;border-radius:4px;margin-left:2px;">'+clientName+'</span>':'')
      +(cat==='확인필요'?'':`<button class="cat-del">×</button>`);
    tag.addEventListener('dragstart',e=>{dragSrc=tag;tag.style.opacity='0.5';e.dataTransfer.effectAllowed='move';});
    tag.addEventListener('dragend',()=>{tag.style.opacity='1';dragSrc=null;});
    tag.addEventListener('dragover',e=>{e.preventDefault();tag.style.outline='2px solid var(--blue)';});
    tag.addEventListener('dragleave',()=>tag.style.outline='');
    tag.addEventListener('drop',async e=>{
      e.preventDefault(); tag.style.outline='';
      if(!dragSrc||dragSrc===tag)return;
      const tags=[...el.querySelectorAll('.cat-tag')];
      const fromIdx=tags.indexOf(dragSrc),toIdx=tags.indexOf(tag);
      if(fromIdx<toIdx)el.insertBefore(dragSrc,tag.nextSibling); else el.insertBefore(dragSrc,tag);
      const{doc,updateDoc}=fb();
      const newTags=[...el.querySelectorAll('.cat-tag')];
      for(let k=0;k<newTags.length;k++){
        const docId=newTags[k].dataset.docId;
        if(docId){await updateDoc(doc(fdb(),COLS.CATEGORIES,docId),{sortOrder:k});const ct=S.categories.find(c=>c.id===docId);if(ct)ct.sortOrder=k;}
      }
      toast('순서 저장됨','success',1500);
    });
    if(cat!=='확인필요')tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제','"'+cat+'" 카테고리를 삭제하시겠습니까?',()=>deleteCategory(type,cat,catDoc.clientId||''),'삭제'));
    el.appendChild(tag);
  });
}

function renderRuleTags(){
  const el=document.getElementById('rule-tags'); if(!el)return;
  if(!S.settings.rules.length){el.innerHTML='<div class="empty-state" style="padding:20px;"><div class="icon">🏷️</div>등록된 규칙 없음</div>';return;}
  el.innerHTML='';
  const settingsClientName=S.settings.settingsClientId?S.clients.find(c=>c.id===S.settings.settingsClientId)?.name||'':'';
  S.settings.rules.forEach(r=>{
    const tc=r.type==='지출'?'#dc2626':'#16a34a', tag=document.createElement('span');
    const isPersonal=!!r.clientId;
    tag.className='rule-tag'; tag.style.borderColor=tc+'33';
    tag.innerHTML='<span style="font-size:13px;font-weight:700;color:var(--sub);">"'+r.keyword+'"</span><span style="font-size:11px;color:var(--muted);">→</span><span style="font-size:13px;font-weight:700;color:'+tc+';">'+r.category+'</span>'+(isPersonal?'<span style="font-size:10px;background:'+tc+'22;color:'+tc+';padding:1px 5px;border-radius:4px;">'+(settingsClientName||r.clientId)+'</span>':'')+'<button class="cat-del">×</button>';
    tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제','"'+r.keyword+'" 규칙을 삭제하시겠습니까?',()=>deleteRule(r.id||r.keyword),'삭제'));
    el.appendChild(tag);
  });
}

function updateRuleCatSel(){
  const type=document.getElementById('new-rule-type')?.value||'지출';
  const sel=document.getElementById('new-rule-cat'); if(!sel)return;
  sel.innerHTML='';
  const cats=[...new Set(S.categories.filter(c=>c.keyword===''&&c.type===type).map(c=>c.category))];
  cats.forEach(c=>sel.add(new Option(c,c)));
}

async function addCategory(type,clientId=''){
  const inputId=type==='지출'?'new-exp-cat':'new-inc-cat';
  const input=document.getElementById(inputId);
  const name=(input?.value||'').trim();
  if(!name){toast('카테고리 이름을 입력하세요.','error');return;}
  const exists=S.categories.some(c=>c.keyword===''&&c.type===type&&c.category===name&&(c.clientId||'')===(clientId||''));
  if(exists){toast('"'+name+'"은 이미 존재하는 카테고리입니다.','error');return;}
  const maxOrder=Math.max(0,...S.categories.filter(c=>c.keyword===''&&c.type===type).map(c=>c.sortOrder||0));
  const{addDoc,collection}=fb();
  const data={keyword:'',type,category:name,subcategory:'',sortOrder:maxOrder+1};
  if(clientId)data.clientId=clientId;
  await addDoc(collection(fdb(),COLS.CATEGORIES),data);
  if(input)input.value='';
  await fetchBaseData(); loadSettings();
  toast('"'+name+'" 추가됨','success');
}

async function deleteCategory(type,name,clientId=''){
  const{getDocs,collection,query,where,doc,deleteDoc}=fb();
  const snap=await getDocs(query(collection(fdb(),COLS.CATEGORIES),where('keyword','==',''),where('type','==',type),where('category','==',name)));
  for(const d of snap.docs){
    const data=d.data();
    if(clientId&&(data.clientId||'')!==clientId)continue;
    if(!clientId&&data.clientId)continue;
    await deleteDoc(doc(fdb(),COLS.CATEGORIES,d.id));
  }
  await fetchBaseData(); loadSettings(); toast('"'+name+'" 삭제됨','success');
}

async function addRule(){
  const kw=(document.getElementById('new-rule-kw')?.value||'').trim();
  const type=document.getElementById('new-rule-type')?.value||'지출';
  const cat=document.getElementById('new-rule-cat')?.value||'';
  const clientId=document.getElementById('settings-client-sel')?.value||'';
  if(!kw){toast('키워드를 입력하세요.','error');return;}
  if(!cat){toast('카테고리를 선택하세요.','error');return;}
  if(S.settings.rules.some(r=>r.keyword===kw&&(r.clientId||'')===(clientId||''))){toast('"'+kw+'"는 이미 등록된 키워드입니다.','error');return;}
  const{addDoc,collection}=fb();
  const data={keyword:kw,type,category:cat,subcategory:''};
  if(clientId)data.clientId=clientId;
  await addDoc(collection(fdb(),COLS.CATEGORIES),data);
  const kwInput=document.getElementById('new-rule-kw'); if(kwInput)kwInput.value='';
  await fetchBaseData(); loadSettings(); toast('"'+kw+'" 규칙 추가됨','success');
}

async function deleteRule(docId){
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),COLS.CATEGORIES,docId));
  await fetchBaseData(); loadSettings(); toast('규칙 삭제됨','success');
}

async function resetCategories(){
  showConfirm('기본값 초기화','모든 카테고리와 규칙을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.',async()=>{
    const{getDocs,collection,doc,deleteDoc}=fb();
    const snap=await getDocs(collection(fdb(),COLS.CATEGORIES));
    for(const d of snap.docs)await deleteDoc(doc(fdb(),COLS.CATEGORIES,d.id));
    await fetchBaseData(); loadSettings(); toast('초기화 완료','success');
  },'초기화');
}

document.getElementById('btn-add-exp-cat')?.addEventListener('click',()=>addCategory('지출',document.getElementById('settings-client-sel')?.value||''));
document.getElementById('btn-add-inc-cat')?.addEventListener('click',()=>addCategory('수입',document.getElementById('settings-client-sel')?.value||''));
document.getElementById('btn-add-rule')?.addEventListener('click',addRule);
document.getElementById('btn-reset-cats')?.addEventListener('click',resetCategories);
document.getElementById('new-rule-type')?.addEventListener('change',updateRuleCatSel);
['new-exp-cat','new-inc-cat','new-rule-kw'].forEach(id=>{
  document.getElementById(id)?.addEventListener('keydown',e=>{
    if(e.key==='Enter'){
      if(id==='new-exp-cat')addCategory('지출',document.getElementById('settings-client-sel')?.value||'');
      else if(id==='new-inc-cat')addCategory('수입',document.getElementById('settings-client-sel')?.value||'');
      else addRule();
    }
  });
});

// 데이터 마감
async function loadArchiveHistory(){
  const{getDocs,collection,query,where}=fb();
  const snap=await getDocs(query(collection(fdb(),COLS.CONFIG),where('type','==','archive')));
  const el=document.getElementById('archive-history'); if(!el)return;
  const list=snap.docs.map(d=>d.data()).sort((a,b)=>b.year-a.year);
  el.innerHTML=list.length?list.map(r=>'<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>'+r.year+'년 마감</span><span style="color:var(--muted);">'+r.count+'건 · '+(r.archivedAt?new Date(r.archivedAt).toLocaleDateString('ko-KR'):'')+'</span></div>').join(''):'<div style="font-size:13px;color:var(--muted);">마감 이력 없음</div>';
}

async function confirmArchive(){
  const year=Number(document.getElementById('archive-year')?.value);
  if(!year){toast('연도를 선택하세요.','error');return;}
  showConfirm('데이터 마감','⚠️ '+year+'년 데이터를 마감합니다.\n되돌릴 수 없습니다.',()=>executeArchive(year),'마감 실행');
}

async function executeArchive(year){
  showLoading(true);
  const{getDocs,addDoc,deleteDoc,updateDoc,collection,query,where,doc}=fb();
  const db=fdb();
  const snap=await getDocs(query(collection(db,COLS.TRANSACTIONS),where('date','>=',year+'-01-01'),where('date','<=',year+'-12-31')));
  const trxList=snap.docs.map(d=>({id:d.id,...d.data()}));
  if(!trxList.length){showLoading(false);toast(year+'년 거래 데이터가 없습니다.','error');return;}
  for(const t of trxList)await addDoc(collection(db,'archive_'+year),t);
  for(const acc of S.accounts){
    const net=trxList.filter(t=>t.accountId===acc.id&&t.type!=='취소').reduce((s,t)=>s+(Number(t.amountIn||0)-Number(t.amountOut||0)),0);
    const newBal=(Number(acc.initialBalance||0)+net);
    await updateDoc(doc(db,COLS.ACCOUNTS,acc.id),{initialBalance:newBal,currentBalance:newBal,initialBalanceDate:year+'-12-31'});
  }
  for(const t of trxList)await deleteDoc(doc(db,COLS.TRANSACTIONS,t.id));
  await addDoc(collection(db,COLS.CONFIG),{type:'archive',year,archivedAt:new Date().toISOString(),count:trxList.length});
  showLoading(false);
  toast(year+'년 마감 완료! '+trxList.length+'건 보관.','success',5000);
  await fetchBaseData(); loadArchiveHistory();
}

document.getElementById('btn-archive')?.addEventListener('click',confirmArchive);
document.getElementById('btn-archive-refresh')?.addEventListener('click',loadArchiveHistory);

// ─────────────────────────────────────────────
// 모달
// ─────────────────────────────────────────────
function openModal(type,data){
  document.getElementById('modal-wrap').classList.add('show');
  if(type==='trx')            renderTrxForm(data);
  if(type==='excel')          renderExcelForm();
  if(type==='receipt-upload') renderReceiptUploadForm(data?.id);
  if(type==='client')         renderClientForm(data);
  if(type==='account')        renderAccountForm(data);
  if(type==='staff')          renderStaffForm(data);
  if(type==='fixed-item')     renderFixedItemForm(data);
}
function closeModal(){document.getElementById('modal-wrap').classList.remove('show');document.getElementById('modal-body').innerHTML='';}
document.getElementById('modal-close-btn')?.addEventListener('click',closeModal);

// 수기 입력 폼
function renderTrxForm(t){
  const isEdit=!!t;
  const editAmount=isEdit?(t.type==='수입'?t.amountIn:t.type==='자산이동'?t.amountOut:t.amountOut):'';
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:20px;">${isEdit?'내역 수정':'수기 입력'}</h3>
    <input type="hidden" id="f-trx-id" value="${isEdit?t.id:''}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">날짜</label><input type="date" id="f-date" class="input" value="${isEdit?t.date:new Date().toISOString().split('T')[0]}"></div>
        <div><label class="label">출금 계좌</label><select id="f-acc" class="input" style="padding:8px 12px;"></select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">구분</label><select id="f-type" class="input" style="padding:8px 12px;">
          <option value="지출"${isEdit&&t.type==='지출'?' selected':''}>지출</option>
          <option value="수입"${isEdit&&t.type==='수입'?' selected':''}>수입</option>
          <option value="자산이동"${isEdit&&t.type==='자산이동'?' selected':''}>자산이동 (계좌간 이체)</option>
          <option value="취소"${isEdit&&t.type==='취소'?' selected':''}>취소 (카드승인취소)</option>
        </select></div>
        <div><label class="label">금액</label><input type="number" id="f-amount" class="input" value="${editAmount}" placeholder="0" min="0" style="text-align:right;"></div>
      </div>
      <div id="f-to-acc-row" style="display:none;">
        <label class="label">입금 계좌 (자산이동 시)</label>
        <select id="f-to-acc" class="input" style="padding:8px 12px;width:100%;"></select>
      </div>
      <div id="f-cat-row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">분류</label><select id="f-cat" class="input" style="padding:8px 12px;"></select></div>
        <div><label class="label">내용</label><input type="text" id="f-desc" class="input" value="${isEdit?t.description||'':''}" placeholder="거래 내용"></div>
      </div>
      <button id="f-save-btn" class="btn" style="width:100%;padding:11px;">💾 저장하기</button>
    </div>`;
  const accSel=document.getElementById('f-acc');
  const toAccSel=document.getElementById('f-to-acc');
  const allAccs=S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts;
  allAccs.forEach(a=>{const cn=S.clients.find(c=>c.id===a.clientId)?.name||'';const opt='['+cn+'] '+a.label;accSel.add(new Option(opt,a.id));toAccSel.add(new Option(opt,a.id));});
  if(isEdit)accSel.value=t.accountId;
  if(isEdit&&t.linkedAccountId)toAccSel.value=t.linkedAccountId;
  const toAccRow=document.getElementById('f-to-acc-row');
  const showToAcc=()=>{const type=document.getElementById('f-type').value;if(toAccRow)toAccRow.style.display=type==='자산이동'?'block':'none';};
  showToAcc(); updateTrxCatSel();
  if(isEdit&&t.category)document.getElementById('f-cat').value=t.category;
  document.getElementById('f-type').addEventListener('change',()=>{updateTrxCatSel();showToAcc();});
  document.getElementById('f-save-btn').addEventListener('click',async()=>{
    const accId=document.getElementById('f-acc').value;
    const amount=Number(document.getElementById('f-amount').value);
    if(!accId){toast('계좌를 선택하세요.','error');return;}
    if(!amount){toast('금액을 입력하세요.','error');return;}
    const acc=S.accounts.find(a=>a.id===accId);
    const type=document.getElementById('f-type').value;
    const date=document.getElementById('f-date').value;
    const cat=document.getElementById('f-cat').value;
    const desc=document.getElementById('f-desc').value;
    const existId=document.getElementById('f-trx-id').value;
    if(type==='자산이동'){
      const toAccId=document.getElementById('f-to-acc').value;
      if(!toAccId){toast('입금 계좌를 선택하세요.','error');return;}
      if(toAccId===accId){toast('출금 계좌와 입금 계좌가 같습니다.','error');return;}
      const toAcc=S.accounts.find(a=>a.id===toAccId);
      closeModal();
      if(existId){
        const outData={clientId:acc.clientId,accountId:accId,date,type:'자산이동',category:'자산이동',description:desc,amountIn:0,amountOut:amount,receiptUrl:t.receiptUrl||'',linkedAccountId:toAccId};
        outData.id=existId; await saveTrx(outData);
        // B003: 연결 입금 거래 동기화
        if(t.linkedTrxId){
          const toAcc2=S.accounts.find(a=>a.id===toAccId);
          const{doc:d2,updateDoc:ud2}=fb();
          await ud2(d2(fdb(),COLS.TRANSACTIONS,t.linkedTrxId),{clientId:toAcc2?.clientId||acc.clientId,accountId:toAccId,date,description:desc,amountIn:amount,amountOut:0,linkedAccountId:accId});
          await updateAccBalance(toAccId);
          if(S.activeClient)await loadTransactions(S.activeClient);
        }
      } else {
        const{addDoc,collection,updateDoc,doc}=fb();
        const outRef=await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:acc.clientId,accountId:accId,date,type:'자산이동',category:'자산이동',description:desc,amountIn:0,amountOut:amount,receiptUrl:'',linkedAccountId:toAccId});
        const inRef=await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:toAcc.clientId,accountId:toAccId,date,type:'자산이동',category:'자산이동',description:desc,amountIn:amount,amountOut:0,receiptUrl:'',linkedAccountId:accId,linkedTrxId:outRef.id});
        await updateDoc(doc(fdb(),COLS.TRANSACTIONS,outRef.id),{linkedTrxId:inRef.id});
        await updateAccBalance(accId); await updateAccBalance(toAccId);
        if(S.activeClient===acc.clientId||S.activeClient===toAcc.clientId)await loadTransactions(S.activeClient);
        toast('자산이동 저장됨','success');
      }
    } else {
      const trxData={clientId:acc.clientId,accountId:accId,date,type,category:cat,description:desc,amountIn:type==='수입'?amount:0,amountOut:(type==='지출'||type==='취소')?amount:0,receiptUrl:isEdit?t.receiptUrl||'':''};
      if(existId)trxData.id=existId;
      closeModal(); await saveTrx(trxData);
    }
  });
}

function updateTrxCatSel(){
  const type=document.getElementById('f-type')?.value||'지출';
  const sel=document.getElementById('f-cat');
  const catRow=document.getElementById('f-cat-row');
  if(!sel)return;
  if(type==='자산이동'||type==='취소'){if(catRow)catRow.style.display='none';sel.innerHTML='<option value="">-</option>';return;}
  if(catRow)catRow.style.display='';
  sel.innerHTML='';
  const clientId=S.activeClient||'';
  const cats=[...new Set(S.categories.filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===clientId)).sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999)).map(c=>c.category))];
  if(!cats.includes('확인필요'))cats.push('확인필요');
  cats.forEach(c=>sel.add(new Option(c,c)));
}

// 엑셀 업로드 폼
function renderExcelForm(){
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">📂 엑셀 파일 업로드</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">계좌 선택</label><select id="xl-acc" class="input" style="padding:8px 12px;"></select></div>
      <div class="dropzone" id="xl-drop"><input type="file" id="xl-file" accept=".xlsx,.xls,.xml,.html,.htm,.csv" style="display:none;"><div style="font-size:20px;margin-bottom:8px;">📊</div><div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요</div><div style="font-size:11px;color:var(--muted);margin-top:4px;">xlsx · xls · xml · html · csv</div><div id="xl-fname" style="font-size:12px;color:var(--blue);margin-top:6px;display:none;"></div></div>
      <button id="xl-btn" class="btn" style="opacity:.5;cursor:not-allowed;" disabled>파일 분석 시작</button>
      <div id="xl-preview" style="display:none;"></div>
    </div>`;
  const accSel=document.getElementById('xl-acc');
  (S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts).forEach(a=>{const cn=S.clients.find(c=>c.id===a.clientId)?.name||'';accSel.add(new Option('['+cn+'] '+a.label,a.id));});
  S.excelTemp=[];
  const zone=document.getElementById('xl-drop'),fi=document.getElementById('xl-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
  zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');if(e.dataTransfer.files.length)onXlFileSelect(e.dataTransfer.files[0]);});
  fi.addEventListener('change',()=>{if(fi.files.length)onXlFileSelect(fi.files[0]);});
}

function onXlFileSelect(file){
  S.excelFile=file; // 원본 파일 참조 보존
  const fn=document.getElementById('xl-fname');
  if(fn){fn.textContent='📄 '+file.name;fn.style.display='block';}
  const btn=document.getElementById('xl-btn');
  if(btn){btn.disabled=false;btn.style.opacity='1';btn.style.cursor='pointer';btn.addEventListener('click',analyzeXlFile);}
}

function analyzeXlFile(){
  const fi=document.getElementById('xl-file'); if(!fi?.files?.length){toast('파일을 선택하세요.','error');return;}
  const btn=document.getElementById('xl-btn'); btn.disabled=true; btn.textContent='분석 중...';
  const clientId=S.activeClient||'';
  // C002: 입주자별 규칙 우선, 공통 규칙 후순위로 정렬
  const parserCats=S.categories.filter(c=>c.keyword&&c.keyword!==''&&(!c.clientId||c.clientId===clientId)).sort((a,b)=>(a.clientId===clientId?0:1)-(b.clientId===clientId?0:1)).map(c=>({keyword:c.keyword,category:c.category,subcategory:c.subcategory||''}));
  ExcelParser.parseFile(fi.files[0],parserCats)
    .then(parsed=>{
      if(!parsed.length){toast('인식된 거래 데이터가 없습니다.','error');btn.disabled=false;btn.textContent='파일 분석 시작';return;}
      const existSet=new Set(S.transactions.map(t=>t.date+'_'+Math.abs(t.amountIn||0)+'_'+Math.abs(t.amountOut||0)));
      const existingMaxOrder=S.transactions.length>0?Math.max(...S.transactions.map(t=>t.sortOrder!=null?t.sortOrder:0)):0;
      S.excelTemp=parsed.map((p,i)=>{
        const rawIn=p.in||0,rawOut=p.out||0;
        let amIn=0,amOut=0,type='지출';
        if(rawIn>0){amIn=rawIn;type='수입';}
        else if(rawOut>0){amOut=rawOut;type='지출';}
        else if(rawOut<0){amOut=rawOut;type='지출';}
        else if(rawIn<0){amOut=Math.abs(rawIn);type='취소';}
        const isDup=existSet.has(p.date+'_'+Math.abs(amIn)+'_'+Math.abs(amOut));
        return {date:p.date,description:p.desc,amountIn:amIn,amountOut:amOut,type,category:p.cat||'확인필요',subcategory:p.sub||'',receiptUrl:'',_dup:isDup,sortOrder:existingMaxOrder+i+1};
      });
      // 원본 행 보존 (Drive 저장 + 대조용)
      S.excelRawRows=parsed.map(p=>({date:p.date,desc:p.desc,amountIn:p.in>0?p.in:0,amountOut:p.out>0?p.out:0}));
      const mCount={};parsed.forEach(p=>{const m=(p.date||'').substring(0,7);if(m)mCount[m]=(mCount[m]||0)+1;});
      S.excelMonth=Object.entries(mCount).sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
      const dupCount=S.excelTemp.filter(x=>x._dup).length;
      btn.disabled=false; btn.textContent='분석 완료 ('+S.excelTemp.length+'건)';
      if(dupCount>0)toast('⚠️ '+dupCount+'건이 기존 거래와 중복됩니다. 저장 시 자동 제외됩니다.','info',5000);
      renderXlPreview();
    })
    .catch(err=>{btn.disabled=false;btn.textContent='파일 분석 시작';toast('파싱 오류: '+err.message,'error');});
}

function renderXlPreview(){
  const el=document.getElementById('xl-preview'); if(!el)return;
  if(!S.excelTemp.length){el.style.display='none';return;}
  el.style.display='block';
  el.innerHTML='<div style="font-size:13px;font-weight:700;color:var(--sub);margin-bottom:8px;">총 '+S.excelTemp.length+'건 분석됨</div><div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:9px;background:#f8fafc;margin-bottom:10px;"><table style="width:100%;border-collapse:collapse;"><thead style="background:#fff;position:sticky;top:0;"><tr><th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">날짜</th><th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">내용</th><th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">분류</th><th style="padding:7px 10px;text-align:right;font-size:11px;color:var(--muted);">금액</th><th></th></tr></thead><tbody id="xl-tbody"></tbody></table></div><button id="xl-save-btn" class="btn" style="width:100%;padding:11px;background:#10b981;">✅ 최종 저장</button>';
  const tbody=document.getElementById('xl-tbody');
  S.excelTemp.forEach((t,i)=>{
    const isIn=t.amountIn>0,amt=isIn?t.amountIn:Math.abs(t.amountOut),c=cs(t.category);
    const tr=document.createElement('tr');tr.style.cssText='border-top:1px solid var(--border);';
    const dupBadge=t._dup?'<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:4px;margin-left:4px;">중복의심</span>':'';
    tr.style.background=t._dup?'#fffbeb':'';
    tr.innerHTML='<td style="padding:6px 10px;font-size:12px;color:var(--sub);white-space:nowrap;">'+t.date+'</td><td style="padding:6px 10px;font-size:13px;color:var(--text);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+t.description+dupBadge+'</td><td style="padding:6px 10px;"><span style="background:'+c.bg+';color:'+c.text+';padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700;">'+t.category+'</span></td><td style="padding:6px 10px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-size:12px;font-weight:700;color:'+(isIn?'#059669':t.type==='취소'?'#71717a':t.amountOut<0?'#059669':'#dc2626')+';white-space:nowrap;">'+(isIn?'+':'')+(t.amountOut<0?'-':'')+amt.toLocaleString()+'원'+(t.type==='취소'?' <span style="font-size:10px;color:#71717a;">(취소)</span>':'')+'</td><td style="padding:6px 10px;text-align:center;"><button style="font-size:12px;color:#94a3b8;background:none;border:none;cursor:pointer;">✕</button></td>';
    tr.querySelector('button').addEventListener('click',()=>removeXlItem(i));
    tbody.appendChild(tr);
  });
  document.getElementById('xl-save-btn').addEventListener('click',saveExcelData);
}

function removeXlItem(idx){S.excelTemp.splice(idx,1);if(!S.excelTemp.length){document.getElementById('xl-preview').style.display='none';toast('모든 항목이 제거되었습니다.','info');return;}renderXlPreview();}

async function saveExcelData(){
  const accId=document.getElementById('xl-acc')?.value;
  if(!accId){toast('계좌를 선택하세요.','error');return;}
  if(!S.excelTemp.length){toast('데이터가 없습니다.','error');return;}
  const acc=S.accounts.find(a=>a.id===accId); if(!acc)return;
  const btn=document.getElementById('xl-save-btn'); if(btn){btn.disabled=true;btn.textContent='저장 중...';}
  // 중복(_dup) 행 제외하고 저장
  const toSave=S.excelTemp.filter(item=>!item._dup);
  const dupCount=S.excelTemp.length-toSave.length;
  const{addDoc,collection}=fb();
  for(const item of toSave){
    await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:acc.clientId,accountId:accId,date:item.date,type:item.type,category:item.category,subcategory:item.subcategory||'',description:item.description,amountIn:item.amountIn||0,amountOut:item.amountOut||0,receiptUrl:'',sortOrder:item.sortOrder??null});
  }
  await updateAccBalance(accId);
  const msg=dupCount>0?`${toSave.length}건 저장됨 (중복 ${dupCount}건 제외)`:toSave.length+'건 저장됨';
  toast(msg,'success'); closeModal();
  if(S.activeClient===acc.clientId)await loadTransactions(acc.clientId);
}

// 입주자/계좌/직원 폼
function renderClientForm(c){
  const isEdit=!!c,isAdmin=['관리자','센터장','팀장'].includes(S.user?.role);
  const teamLeaders=S.users.filter(u=>u.role==='팀장');
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'입주자 수정':'입주자 등록'}</h3>
    <input type="hidden" id="fc-id" value="${isEdit?c.id:'cli_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">성명</label><input type="text" id="fc-name" class="input" value="${isEdit?c.name:''}"></div>
      ${isAdmin?'<div><label class="label">담당 팀장</label><select id="fc-leader" class="input" style="padding:8px 12px;"><option value="">없음</option>'+teamLeaders.map(u=>'<option value="'+u.id+'"'+(isEdit&&String(c.teamLeader)===String(u.id)?' selected':'')+'>'+u.name+(u.team?' ('+u.team+')':'')+'</option>').join('')+'</select></div><div><label class="label">담당 직원</label><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;max-height:140px;overflow-y:auto;padding:4px;">'+S.users.map(u=>{const ex=isEdit?String(c.userIds||'').split(',').map(s=>s.trim()):[];const ch=ex.includes(String(u.id));return '<label style="display:flex;align-items:center;gap:7px;padding:7px 10px;background:'+(ch?'#eff6ff':'#f8fafc')+';border:1px solid '+(ch?'#bfdbfe':'var(--border)')+';border-radius:8px;cursor:pointer;font-size:13px;"><input type="checkbox" name="fc-staff" value="'+u.id+'" '+(ch?'checked':'')+' style="accent-color:var(--blue);"> '+u.name+'</label>';}).join('')+'</div></div>':''}
      <div><label class="label">연락처</label><input type="text" id="fc-contact" class="input" value="${isEdit?c.contact||'':''}"></div>
      <div><label class="label">메모</label><textarea id="fc-memo" class="input" style="height:64px;resize:none;">${isEdit?c.memo||'':''}</textarea></div>
      <button id="fc-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
    </div>`;
  document.getElementById('fc-save').addEventListener('click',async()=>{
    const isAdm=['관리자','센터장','팀장'].includes(S.user?.role);
    const staffIds=isAdm?Array.from(document.querySelectorAll('input[name="fc-staff"]:checked')).map(c=>c.value).join(','):String(S.user.userId);
    const leader=isAdm?(document.getElementById('fc-leader')?.value||''):'';
    const data={name:document.getElementById('fc-name').value,contact:document.getElementById('fc-contact').value,memo:document.getElementById('fc-memo').value,userIds:staffIds,teamLeader:leader};
    const id=document.getElementById('fc-id').value;
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.CLIENTS,id),data);
    toast('저장됨','success'); closeModal(); await fetchBaseData(); renderManagement();
  });
}

function renderAccountForm(a){
  const isEdit=!!a;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'계좌 수정':'계좌 등록'}</h3>
    <input type="hidden" id="fa-id" value="${isEdit?a.id:'acc_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">입주자</label><select id="fa-client" class="input" style="padding:8px 12px;"></select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">계좌 별칭</label><input type="text" id="fa-label" class="input" value="${isEdit?a.label||'':''}"></div>
        <div><label class="label">계좌번호</label><input type="text" id="fa-num" class="input" value="${isEdit?a.accountNumber||'':''}" placeholder="선택사항"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">기초 잔액 기준일</label><input type="date" id="fa-init-date" class="input" value="${isEdit?a.initialBalanceDate||'':''}"></div>
        <div><label class="label">기초 잔액 (기준일 잔액)</label><input type="number" id="fa-init" class="input" value="${isEdit?a.initialBalance||0:0}" style="text-align:right;"></div>
      </div>
      <p style="font-size:11px;color:var(--muted);background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:8px 12px;">💡 기준일 이후의 거래내역을 기초 잔액에 합산하여 현재 잔액을 계산합니다.</p>
      <button id="fa-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
      ${isEdit?'<button id="fa-stmt-btn" class="btn-sub" style="width:100%;padding:9px;color:#0369a1;border-color:#bae6fd;margin-top:4px;">📸 통장 사진 관리 ('+(a.bankStatements||[]).length+'장)</button>':''}
    </div>`;
  const sel=document.getElementById('fa-client');
  S.clients.forEach(c=>sel.add(new Option(c.name,c.id))); if(isEdit)sel.value=a.clientId;
  if(isEdit){const stmtBtn=document.getElementById('fa-stmt-btn');if(stmtBtn)stmtBtn.addEventListener('click',()=>{closeModal();openBankStatementModal(a.id);});}
  document.getElementById('fa-save').addEventListener('click',async()=>{
    const id=document.getElementById('fa-id').value, init=Number(document.getElementById('fa-init').value||0);
    const initDate=document.getElementById('fa-init-date')?.value||'';
    const data={clientId:document.getElementById('fa-client').value,label:document.getElementById('fa-label').value,accountNumber:document.getElementById('fa-num').value||'',initialBalance:init,initialBalanceDate:initDate,currentBalance:init};
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.ACCOUNTS,id),data);
    toast('저장됨','success'); closeModal(); await fetchBaseData(); renderManagement();
    await updateAccBalance(id);
  });
}

function renderStaffForm(u){
  const isEdit=!!u;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'직원 수정':'직원 등록'}</h3>
    <input type="hidden" id="fs-id" value="${isEdit?u.id:'staff_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">이름</label><input type="text" id="fs-name" class="input" value="${isEdit?u.name||'':''}"></div>
      <div><label class="label">아이디</label><input type="text" id="fs-uid" class="input" value="${isEdit?u.userId||'':''}" ${isEdit?'readonly':''}></div>
      <div><label class="label">비밀번호</label><input type="password" id="fs-pw" class="input" value="${isEdit?u.password||'':''}" placeholder="${isEdit?'변경 시에만 입력':''}"></div>
      <div><label class="label">역할</label><select id="fs-role" class="input" style="padding:8px 12px;"><option value="입력자"${isEdit&&u.role==='입력자'?' selected':''}>입력자 (수기입력 전용)</option><option value="담당자"${isEdit&&u.role==='담당자'?' selected':''}>담당자</option><option value="팀장"${isEdit&&u.role==='팀장'?' selected':''}>팀장</option><option value="센터장"${isEdit&&u.role==='센터장'?' selected':''}>센터장</option><option value="관리자"${isEdit&&u.role==='관리자'?' selected':''}>관리자</option></select></div>
      <div><label class="label">소속 팀</label><input type="text" id="fs-team" class="input" value="${isEdit?u.team||'':''}" placeholder="예: 1팀"></div>
      <button id="fs-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
    </div>`;
  document.getElementById('fs-save').addEventListener('click',async()=>{
    const id=document.getElementById('fs-id').value;
    const pw=document.getElementById('fs-pw').value;
    const data={name:document.getElementById('fs-name').value,userId:document.getElementById('fs-uid').value,role:document.getElementById('fs-role').value,team:document.getElementById('fs-team').value};
    if(pw)data.password=pw;
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.USERS,id),data);
    toast('저장됨','success'); closeModal(); await fetchBaseData(); renderManagement();
  });
}

// ─────────────────────────────────────────────
// 고정항목
// ─────────────────────────────────────────────
async function loadFixedItems(clientId){
  if(!clientId)return;
  const{getDocs,collection,query,where}=fb();
  const snap=await getDocs(query(collection(fdb(),'fixedItems'),where('clientId','==',clientId)));
  S.fixedItems=snap.docs.map(d=>({id:d.id,...d.data()}));
}

async function applyFixedItems(){
  const clientId=S.activeClient;
  if(!clientId){toast('입주자를 먼저 선택하세요.','error');return;}
  await loadFixedItems(clientId);
  if(!S.fixedItems.length){toast('등록된 고정항목이 없습니다. 설정에서 추가하세요.','info');return;}
  const now=new Date(), yearMonth=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  const existing=S.transactions.filter(t=>(t.date||'').startsWith(yearMonth)&&t.isFixed);
  const existKeys=new Set(existing.map(t=>t.fixedItemId));
  const toAdd=S.fixedItems.filter(f=>!existKeys.has(f.id));
  if(!toAdd.length){toast('이번 달 고정항목이 이미 입력되었습니다.','info');return;}
  showConfirm('고정항목 입력',yearMonth+' 기준 고정항목 '+toAdd.length+'건을 입력하시겠습니까?',async()=>{
    const{addDoc,collection}=fb();
    const today=yearMonth+'-01';
    for(const f of toAdd){
      await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId,accountId:f.accountId,date:f.day?yearMonth+'-'+String(f.day).padStart(2,'0'):today,type:f.type,category:f.category,description:f.description,amountIn:f.type==='수입'?Number(f.amount):0,amountOut:f.type==='지출'?Number(f.amount):0,receiptUrl:'',isFixed:true,fixedItemId:f.id});
    }
    toast(toAdd.length+'건 입력 완료','success');
    await loadTransactions(clientId);
  },'입력');
}

async function saveFixedItem(data){
  const{addDoc,setDoc,doc,collection}=fb();
  if(data.id){const id=data.id;delete data.id;await setDoc(doc(fdb(),'fixedItems',id),data);}
  else await addDoc(collection(fdb(),'fixedItems'),data);
  toast('고정항목 저장됨','success');
}

async function deleteFixedItem(id){
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),'fixedItems',id));
  toast('삭제됨','success');
}

function renderFixedItemForm(item){
  const isEdit=!!item;
  const accs=S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">⚙️ 고정항목 ${isEdit?'수정':'등록'}</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">계좌</label><select id="fi-acc" class="input" style="padding:8px 12px;"></select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">구분</label><select id="fi-type" class="input" style="padding:8px 12px;"><option value="지출">지출</option><option value="수입">수입</option></select></div>
        <div><label class="label">매월 몇 일</label><input type="number" id="fi-day" class="input" min="1" max="31" value="${isEdit?item.day||1:1}"></div>
      </div>
      <div><label class="label">카테고리</label><select id="fi-cat" class="input" style="padding:8px 12px;"></select></div>
      <div><label class="label">내용</label><input type="text" id="fi-desc" class="input" value="${isEdit?item.description||'':''}" placeholder="예: 국민연금, 복지관 이용료"></div>
      <div><label class="label">금액</label><input type="number" id="fi-amt" class="input" value="${isEdit?item.amount||0:0}" style="text-align:right;"></div>
      <button id="fi-save" class="btn" style="width:100%;padding:11px;">💾 저장</button>
    </div>`;
  const accSel=document.getElementById('fi-acc');
  accs.forEach(a=>accSel.add(new Option(a.label,a.id)));
  if(isEdit&&item.accountId)accSel.value=item.accountId;
  const catSel=document.getElementById('fi-cat');
  const fillCats=()=>{const type=document.getElementById('fi-type').value;catSel.innerHTML='';const cats=[...new Map(S.categories.filter(c=>c.keyword===''&&c.type===type).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(c=>[c.category,c.category])).keys()];cats.forEach(c=>catSel.add(new Option(c,c)));if(isEdit&&item.category)catSel.value=item.category;};
  fillCats();
  document.getElementById('fi-type').addEventListener('change',fillCats);
  document.getElementById('fi-save').addEventListener('click',async()=>{
    const data={clientId:S.activeClient,accountId:document.getElementById('fi-acc').value,type:document.getElementById('fi-type').value,day:Number(document.getElementById('fi-day').value)||1,category:document.getElementById('fi-cat').value,description:document.getElementById('fi-desc').value,amount:Number(document.getElementById('fi-amt').value)||0};
    if(isEdit)data.id=item.id;
    await saveFixedItem(data); closeModal();
  });
}

async function renderFixedItemsList(clientId){
  if(!clientId)return;
  await loadFixedItems(clientId);
  const el=document.getElementById('fixed-items-list'); if(!el)return;
  el.innerHTML='';
  if(!S.fixedItems.length){el.innerHTML='<div style="font-size:13px;color:var(--muted);padding:8px 0;">등록된 고정항목이 없습니다.</div>';return;}
  S.fixedItems.forEach(f=>{
    const acc=S.accounts.find(a=>a.id===f.accountId)?.label||'-';
    const div=document.createElement('div');
    div.style.cssText='display:flex;justify-content:space-between;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px 14px;';
    div.innerHTML='<div><div style="font-size:14px;font-weight:700;color:var(--text);">'+(f.description||'(이름없음)')+' <span style="font-size:12px;font-weight:400;color:var(--muted);">매월 '+(f.day||1)+'일</span></div><div style="font-size:12px;color:var(--muted);margin-top:2px;">'+acc+' · '+f.type+' · '+f.category+' · '+Number(f.amount||0).toLocaleString()+'원</div></div><div style="display:flex;gap:6px;"><button class="fi-edit-btn icon-btn" style="color:#64748b;">✏️</button><button class="fi-del-btn icon-btn" style="color:#94a3b8;">🗑️</button></div>';
    div.querySelector('.fi-edit-btn').addEventListener('click',()=>{S.activeClient=clientId;openModal('fixed-item',f);});
    div.querySelector('.fi-del-btn').addEventListener('click',()=>showConfirm('삭제','"'+f.description+'" 고정항목을 삭제하시겠습니까?',async()=>{await deleteFixedItem(f.id);renderFixedItemsList(clientId);}));
    el.appendChild(div);
  });
}

// ─────────────────────────────────────────────
// 증빙 출력 A4
// ─────────────────────────────────────────────
async function printReceiptSheet(){
  const clientId=S.activeClient;
  if(!clientId){toast('입주자를 선택하세요.','error');return;}
  const trxWithReceipt=S.filteredTrx.filter(t=>t.receiptUrl);
  if(!trxWithReceipt.length){toast('증빙이 있는 거래가 없습니다.','info');return;}
  const client=S.clients.find(c=>c.id===clientId)||{name:''};
  const win=window.open('','_blank');
  const driveIdOf=url=>{const m=url.match(/\/d\/([^/?]+)/);return m?m[1]:null;};
  let cells='';
  trxWithReceipt.forEach((t,i)=>{
    const id=driveIdOf(t.receiptUrl);
    const imgSrc=id?'https://drive.google.com/thumbnail?id='+id+'&sz=w400':t.receiptUrl;
    cells+='<div class="cell"><div class="cell-info">'+t.date+' · '+(t.description||'')+' · '+(t.amountOut>0?t.amountOut.toLocaleString()+'원':t.amountIn.toLocaleString()+'원')+'</div><div class="cell-img"><img src="'+imgSrc+'" onerror="this.src=\'\';this.parentElement.innerHTML=\'<div style=\\\"display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:#9ca3af;\\\">이미지 없음</div>\'"></div></div>';
  });
  win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>증빙 출력 — '+client.name+'</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:\'Noto Sans KR\',sans-serif;background:#fff;padding:8mm;}h2{font-size:12px;font-weight:700;color:#374151;margin-bottom:4mm;}.grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm;}.cell{border:1px solid #d1d5db;border-radius:3px;padding:2px;break-inside:avoid;page-break-inside:avoid;height:62mm;display:flex;flex-direction:column;overflow:hidden;}.cell-info{font-size:7.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;padding-bottom:2px;border-bottom:1px solid #f3f4f6;margin-bottom:2px;}.cell-img{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;min-height:0;}.cell-img img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;}@page{size:A4 portrait;margin:8mm;}@media print{body{padding:0;}.grid{height:calc(297mm - 16mm - 10mm);grid-template-rows:repeat(4,1fr);}}</style></head><body><h2>📎 증빙 출력 — '+client.name+' ('+trxWithReceipt.length+'건)</h2><div class="grid">'+cells+'</div><script>window.onload=()=>{window.print();};<\/script></body></html>');
  win.document.close();
}

// ─────────────────────────────────────────────
// 통장 사진 다중 업로드
// ─────────────────────────────────────────────
async function openBankStatementModal(accountId,yearParam,monthParam){
  if(!accountId){toast('계좌를 선택하세요.','error');return;}
  const acc=S.accounts.find(a=>a.id===accountId)||{label:'계좌'};
  const now=new Date();
  const year=yearParam||now.getFullYear();
  const month=monthParam||now.getMonth()+1;
  const mStr=String(year)+'-'+String(month).padStart(2,'0');
  document.getElementById('modal-wrap').classList.add('show');
  const body=document.getElementById('modal-body');
  const{getDoc,doc,updateDoc}=fb();
  const accRef=doc(fdb(),COLS.ACCOUNTS,accountId);
  const accSnap=await getDoc(accRef);
  const rawStmts=(accSnap.exists()?accSnap.data().bankStatements:[])||[];
  const existing=rawStmts.map(s=>typeof s==='string'?{url:s,month:''}:s);
  body.innerHTML='<h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:6px;">🏦 통장 사진 관리</h3><p style="font-size:13px;color:var(--muted);margin-bottom:10px;">'+acc.label+' — 여러 장 업로드 가능</p><div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;"><label class="label" style="margin:0;white-space:nowrap;">📅 해당 연월:</label><input type="month" id="bs-month" class="input" value="'+mStr+'" style="width:140px;padding:6px 10px;"></div><div id="bs-drop" style="border:2px dashed var(--bm);border-radius:12px;background:#f8fafc;padding:20px;text-align:center;cursor:pointer;margin-bottom:12px;"><input type="file" id="bs-file" accept="image/*,.pdf" multiple style="display:none;"><div style="font-size:24px;margin-bottom:6px;">📸</div><div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요</div><div id="bs-status" style="font-size:12px;color:var(--blue);margin-top:6px;"></div></div><div id="bs-gallery" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px;"></div><div style="font-size:12px;color:var(--muted);margin-bottom:8px;">등록된 사진: <span id="bs-count">'+existing.length+'</span>장</div>';
  const gallery=document.getElementById('bs-gallery');
  const renderGallery=(items)=>{
    gallery.innerHTML='';
    items.forEach((item,i)=>{
      const url=typeof item==='string'?item:item.url;
      const mo=typeof item==='string'?'':item.month||'';
      const driveId=url.match(/\/d\/([^/?]+)/)?.[1];
      const thumb=driveId?'https://drive.google.com/thumbnail?id='+driveId+'&sz=w200':url;
      const cell=document.createElement('div');
      cell.style.cssText='position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;';
      cell.innerHTML='<div style="font-size:10px;color:var(--muted);padding:3px 6px;background:var(--bg);text-align:center;">'+(mo||'날짜없음')+'</div><div style="aspect-ratio:3/4;"><img src="'+thumb+'" style="width:100%;height:100%;object-fit:cover;" onerror="this.src=\'\'"></div><button style="position:absolute;top:24px;right:4px;background:rgba(220,38,38,.85);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;" data-idx="'+i+'">✕</button>';
      cell.querySelector('button').addEventListener('click',async()=>{items.splice(i,1);await updateDoc(accRef,{bankStatements:items});document.getElementById('bs-count').textContent=items.length;renderGallery(items);});
      cell.querySelector('img').addEventListener('click',()=>openReceiptModal(url));
      gallery.appendChild(cell);
    });
  };
  renderGallery([...existing]);
  const zone=document.getElementById('bs-drop'),fi=document.getElementById('bs-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.style.borderColor='var(--blue)';});
  zone.addEventListener('dragleave',()=>zone.style.borderColor='var(--bm)');
  zone.addEventListener('drop',e=>{e.preventDefault();zone.style.borderColor='var(--bm)';if(e.dataTransfer.files.length)uploadBankStatements(e.dataTransfer.files,accRef,existing,renderGallery);});
  fi.addEventListener('change',()=>{if(fi.files.length)uploadBankStatements(fi.files,accRef,existing,renderGallery);});
}

async function uploadBankStatements(files,accRef,existing,renderGallery){
  const status=document.getElementById('bs-status');
  const total=files.length;
  const monthVal=document.getElementById('bs-month')?.value||'';
  for(let i=0;i<total;i++){
    if(status)status.textContent='업로드 중... '+(i+1)+'/'+total;
    try{
      const compressed=await compressImage(files[i]);
      const url=await uploadToDrive(compressed);
      existing.push({url,month:monthVal});
      const{updateDoc}=fb();
      await updateDoc(accRef,{bankStatements:[...existing]});
      document.getElementById('bs-count').textContent=existing.length;
      renderGallery([...existing]);
    }catch(e){toast(files[i].name+' 업로드 실패: '+e.message,'error');}
  }
  if(status)status.textContent=total+'장 업로드 완료!';
  toast(total+'장 업로드 완료!','success');
}

// ─────────────────────────────────────────────
// 증빙 업로드 모달
// ─────────────────────────────────────────────
let _receiptSelectedFile=null;
function renderReceiptUploadForm(trxId){
  _receiptSelectedFile=null;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">📎 증빙 업로드</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px;">클릭하거나 파일을 끌어다 놓으면 Google Drive에 자동 업로드됩니다.</p>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div id="ru-drop" style="border:2px dashed var(--bm);border-radius:12px;background:#f8fafc;padding:24px 20px;text-align:center;cursor:pointer;transition:all .15s;">
        <input type="file" id="ru-file" accept="image/*,.pdf" style="display:none;">
        <div id="ru-drop-inner"><div style="font-size:28px;margin-bottom:8px;">🖼️</div><div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요</div><div style="font-size:11px;color:var(--muted);margin-top:4px;">jpg · png · gif · webp · pdf</div></div>
      </div>
      <div id="ru-preview" style="display:none;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#f8fafc;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);">
          <span id="ru-fname" style="font-size:12px;font-weight:700;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;"></span>
          <span id="ru-fsize" style="font-size:11px;color:var(--muted);flex-shrink:0;margin-left:8px;"></span>
        </div>
        <div style="text-align:center;padding:10px;"><img id="ru-img" style="max-width:100%;max-height:220px;border-radius:6px;display:none;" alt="미리보기"><div id="ru-pdf-icon" style="display:none;font-size:40px;padding:16px;">📄</div></div>
      </div>
      <button id="ru-btn" class="btn" style="width:100%;padding:11px;opacity:.5;cursor:not-allowed;" disabled>파일을 먼저 선택하세요</button>
      <div id="ru-status" style="font-size:12px;color:var(--muted);text-align:center;display:none;"></div>
    </div>`;
  const zone=document.getElementById('ru-drop'),fi=document.getElementById('ru-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragenter',e=>{e.preventDefault();e.stopPropagation();});
  zone.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();zone.style.borderColor='var(--blue)';zone.style.background='#eff6ff';});
  zone.addEventListener('dragleave',e=>{e.stopPropagation();zone.style.borderColor='var(--bm)';zone.style.background='#f8fafc';});
  zone.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();zone.style.borderColor='var(--bm)';zone.style.background='#f8fafc';const file=e.dataTransfer?.files?.[0];if(file)onReceiptFileSelect(file);});
  fi.addEventListener('change',()=>{const file=fi.files?.[0];if(file)onReceiptFileSelect(file);});
  document.getElementById('ru-btn').addEventListener('click',()=>doReceiptUpload(trxId));
}

function onReceiptFileSelect(file){
  _receiptSelectedFile=file;
  const fn=document.getElementById('ru-fname'),fs=document.getElementById('ru-fsize'),prev=document.getElementById('ru-preview'),img=document.getElementById('ru-img'),pdf=document.getElementById('ru-pdf-icon'),drop=document.getElementById('ru-drop'),btn=document.getElementById('ru-btn');
  if(fn)fn.textContent='📄 '+file.name;
  if(fs)fs.textContent=(file.size/1024).toFixed(0)+' KB';
  if(prev)prev.style.display='block';
  if(drop)drop.style.padding='12px 20px';
  const inner=document.getElementById('ru-drop-inner');
  if(inner)inner.innerHTML='<div style="font-size:12px;color:var(--muted);">다른 파일로 변경하려면 클릭하세요</div>';
  if(file.type.startsWith('image/')){if(pdf)pdf.style.display='none';if(img)img.style.display='block';const reader=new FileReader();reader.onload=e=>{if(img)img.src=e.target.result;};reader.readAsDataURL(file);}
  else{if(img)img.style.display='none';if(pdf)pdf.style.display='block';}
  if(btn){btn.disabled=false;btn.style.opacity='1';btn.style.cursor='pointer';btn.textContent='📤 Drive에 업로드';}
}

async function doReceiptUpload(trxId){
  if(!_receiptSelectedFile){toast('파일을 선택하세요.','error');return;}
  const btn=document.getElementById('ru-btn'),status=document.getElementById('ru-status');
  btn.disabled=true; btn.textContent='압축 중...';
  if(status){status.textContent='이미지 압축 중...';status.style.display='block';}
  try{
    btn.textContent='업로드 중...';
    if(status)status.textContent='Google Drive에 업로드 중입니다...';
    const url=await uploadToDrive(_receiptSelectedFile);
    const{doc,updateDoc}=fb();
    await updateDoc(doc(fdb(),COLS.TRANSACTIONS,trxId),{receiptUrl:url});
    [S.transactions,S.filteredTrx].forEach(arr=>{const t=arr.find(x=>x.id===trxId);if(t)t.receiptUrl=url;});
    toast('업로드 완료! 증빙이 저장되었습니다.','success');
    _receiptSelectedFile=null; closeModal(); renderHistoryTable();
  }catch(e){btn.disabled=false;btn.textContent='📤 Drive에 업로드';if(status)status.style.display='none';toast('업로드 실패: '+e.message,'error');}
}

function openReceiptUpload(trxId){openModal('receipt-upload',{id:trxId});}

// ─────────────────────────────────────────────
// 영수증 미리보기 모달
// ─────────────────────────────────────────────
function openReceiptModal(url){
  if(!url)return;
  const body=document.getElementById('receipt-body');
  const driveMatch=url.match(/\/d\/([^/?]+)/);
  const isDrive=!!driveMatch;
  const isLocalImg=/\.(jpg|jpeg|png|gif|webp|bmp)/i.test(url)&&!isDrive;
  const header='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;"><span style="font-size:15px;font-weight:700;color:var(--text);">📎 영수증 미리보기</span><a href="'+url+'" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:var(--blue);border:1px solid #bfdbfe;padding:5px 12px;border-radius:8px;text-decoration:none;background:#eff6ff;">🔗 새 탭에서 열기</a></div>';
  if(isDrive){
    const fileId=driveMatch[1];
    const thumbUrl='https://drive.google.com/thumbnail?id='+fileId+'&sz=w800';
    body.innerHTML=header+'<div id="ru-modal-loading" style="text-align:center;padding:40px 0;"><div class="spinner" style="margin:0 auto 12px;"></div><p style="font-size:13px;color:var(--muted);">이미지를 불러오는 중...</p></div><img id="ru-modal-img" src="'+thumbUrl+'" alt="영수증" style="display:none;max-width:100%;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.08);"><div id="ru-modal-error" style="display:none;text-align:center;padding:30px 0;"><div style="font-size:32px;margin-bottom:10px;">⚠️</div><p style="font-size:14px;color:var(--sub);margin-bottom:16px;">이미지를 불러올 수 없습니다.<br>새 탭에서 확인하세요.</p><a href="'+url+'" target="_blank" rel="noopener" class="btn" style="display:inline-flex;gap:6px;">🔗 새 탭에서 열기</a></div>';
    const img=document.getElementById('ru-modal-img'),loading=document.getElementById('ru-modal-loading'),error=document.getElementById('ru-modal-error');
    img.onload=()=>{loading.style.display='none';img.style.display='block';};
    img.onerror=()=>{loading.style.display='none';error.style.display='block';};
  }else if(isLocalImg){
    body.innerHTML=header+'<div id="ru-modal-loading" style="text-align:center;padding:40px 0;"><div class="spinner" style="margin:0 auto 12px;"></div></div><img id="ru-modal-img" src="'+url+'" alt="영수증" style="display:none;max-width:100%;border-radius:10px;"><div id="ru-modal-error" style="display:none;text-align:center;padding:30px 0;"><a href="'+url+'" target="_blank" rel="noopener" class="btn">🔗 새 탭에서 열기</a></div>';
    const img=document.getElementById('ru-modal-img'),loading=document.getElementById('ru-modal-loading'),error=document.getElementById('ru-modal-error');
    img.onload=()=>{loading.style.display='none';img.style.display='block';};
    img.onerror=()=>{loading.style.display='none';error.style.display='block';};
  }else{
    body.innerHTML=header+'<div style="text-align:center;padding:30px 0;"><div style="font-size:48px;margin-bottom:14px;">📄</div><p style="font-size:14px;color:var(--sub);margin-bottom:20px;">이미지 형식이 아닌 파일입니다.</p><a href="'+url+'" target="_blank" rel="noopener" class="btn" style="display:inline-flex;gap:6px;">🔗 새 탭에서 열기</a></div>';
  }
  document.getElementById('receipt-modal').classList.add('show');
}
function closeReceiptModal(){document.getElementById('receipt-modal').classList.remove('show');const body=document.getElementById('receipt-body');if(body)body.innerHTML='';}

// ─────────────────────────────────────────────
// 드래그 순서변경
// ─────────────────────────────────────────────
async function reorderTrx(fromId,toId){
  if(fromId===toId)return;
  const fromIdx=S.filteredTrx.findIndex(x=>x.id===fromId);
  const toIdx=S.filteredTrx.findIndex(x=>x.id===toId);
  if(fromIdx<0||toIdx<0)return;
  const arr=[...S.filteredTrx];
  const[moved]=arr.splice(fromIdx,1);
  arr.splice(toIdx,0,moved);
  const{doc,updateDoc}=fb();
  const base=(S.page-1)*S.pageSize;
  const pageItems=arr.slice(base,base+S.pageSize);
  for(let i=0;i<pageItems.length;i++){
    const t=pageItems[i];const newOrder=base+i;
    if(t.sortOrder!==newOrder){t.sortOrder=newOrder;await updateDoc(doc(fdb(),COLS.TRANSACTIONS,t.id),{sortOrder:newOrder});const orig=S.transactions.find(x=>x.id===t.id);if(orig)orig.sortOrder=newOrder;}
  }
  S.filteredTrx=arr;renderHistoryTable();renderPagination();
  toast('순서가 저장되었습니다.','success',1500);
}

// ─────────────────────────────────────────────
// 공통 유틸
// ─────────────────────────────────────────────
function showConfirm(title,msg,onOk,okLabel='확인',okStyle='btn'){
  setText('c-title',title);setText('c-msg',msg);
  const btn=document.getElementById('c-ok');
  btn.textContent=okLabel;btn.className=okStyle||'btn';
  btn.onclick=()=>{closeConfirm();onOk();};
  document.getElementById('confirm-dialog').classList.add('show');
}
function closeConfirm(){document.getElementById('confirm-dialog').classList.remove('show');}
function setText(id,val){const el=document.getElementById(id);if(el)el.textContent=val;}
function showLoading(on){const el=document.getElementById('loading');if(!el)return;if(on)el.classList.add('show');else el.classList.remove('show');}
function toast(msg,type='info',duration=3000){
  const c=document.getElementById('toast-wrap');if(!c)return;
  const icons={success:'✅',error:'❌',info:'ℹ️'};
  const el=document.createElement('div');el.className='toast '+type;
  el.innerHTML='<span>'+(icons[type]||'ℹ️')+'</span><span>'+msg+'</span>';
  c.appendChild(el);
  setTimeout(()=>{el.style.animation='toastOut .25s ease forwards';setTimeout(()=>el.remove(),260);},duration);
}

// ─────────────────────────────────────────────
// 이벤트 초기화
// ─────────────────────────────────────────────
document.getElementById('login-id')?.addEventListener('keydown',e=>{if(e.key==='Enter')handleLogin();});
document.getElementById('login-pw')?.addEventListener('keydown',e=>{if(e.key==='Enter')handleLogin();});
document.getElementById('btn-trx')?.addEventListener('click',()=>openModal('trx'));
document.getElementById('btn-excel')?.addEventListener('click',()=>openModal('excel'));
document.getElementById('btn-h-trx')?.addEventListener('click',()=>openModal('trx'));
document.getElementById('btn-h-excel')?.addEventListener('click',()=>openModal('excel'));
document.getElementById('btn-bulk-del')?.addEventListener('click',confirmBulkDelete);
document.getElementById('btn-h-fixed')?.addEventListener('click',applyFixedItems);
document.getElementById('btn-h-receipt-print')?.addEventListener('click',printReceiptSheet);
document.querySelectorAll('[data-sort]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.sort;S.sortDir=S.sortKey===k&&S.sortDir==='desc'?'asc':'desc';S.sortKey=k;S.page=1;applyFilters();}));
document.querySelectorAll('[data-rpt-sort]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.rptSort;S.rptSortDir=S.rptSortKey===k&&S.rptSortDir==='desc'?'asc':'desc';S.rptSortKey=k;if(S.reportData?.trxList){renderRptTrxTable(applyRptSort(S.reportData.trxList));updateRptSortArrows();}}));
document.querySelectorAll('.period-btn').forEach(btn=>btn.addEventListener('click',()=>{applyPeriod(btn.dataset.p);document.querySelectorAll('.period-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');}));
document.getElementById('h-client')?.addEventListener('change',()=>{const v=document.getElementById('h-client').value;const accSel=document.getElementById('h-account');if(accSel)accSel.value='';if(v)loadTransactions(v);else{S.transactions=[];S.filteredTrx=[];S.activeClient=null;renderHistoryTable();rebuildAccountFilter();}});
document.getElementById('h-account')?.addEventListener('change',applyFilters);
['h-search','h-start','h-end'].forEach(id=>document.getElementById(id)?.addEventListener('input',applyFilters));
['h-type','h-receipt','h-start','h-end'].forEach(id=>document.getElementById(id)?.addEventListener('change',applyFilters));
document.getElementById('check-all')?.addEventListener('click',e=>{document.querySelectorAll('.row-check').forEach(c=>c.checked=e.target.checked);});
document.querySelectorAll('.nav-item[data-view]').forEach(btn=>btn.addEventListener('click',()=>changeView(btn.dataset.view)));
document.addEventListener('click',function(e){if(!e.target.closest('.cat-chip')&&!e.target.closest('.cat-dd')){closeCatDropdowns();}});
(()=>{const now=new Date(),y=now.getFullYear(),m=now.getMonth();const fmt=dt=>dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');const s=document.getElementById('h-start'),e=document.getElementById('h-end');if(s)s.value=fmt(new Date(y,m,1));if(e)e.value=fmt(new Date(y,m+1,0));})();

// ─────────────────────────────────────────────
// 거래내역 정렬/순서
// ─────────────────────────────────────────────
async function reorderTrx(fromId,toId){
  if(fromId===toId)return;
  const fromIdx=S.filteredTrx.findIndex(x=>x.id===fromId);
  const toIdx  =S.filteredTrx.findIndex(x=>x.id===toId);
  if(fromIdx<0||toIdx<0)return;
  const arr=[...S.filteredTrx];
  const [moved]=arr.splice(fromIdx,1);
  arr.splice(toIdx,0,moved);
  const{doc,updateDoc}=fb();
  const base=(S.page-1)*S.pageSize;
  const pageItems=arr.slice(base,base+S.pageSize);
  for(let i=0;i<pageItems.length;i++){
    const t=pageItems[i];
    const newOrder=base+i;
    if(t.sortOrder!==newOrder){
      t.sortOrder=newOrder;
      await updateDoc(doc(fdb(),COLS.TRANSACTIONS,t.id),{sortOrder:newOrder});
      const orig=S.transactions.find(x=>x.id===t.id);
      if(orig)orig.sortOrder=newOrder;
    }
  }
  S.filteredTrx=arr;
  renderHistoryTable(); renderPagination();
  toast('순서가 저장되었습니다.','success',1500);
}

// ─────────────────────────────────────────────
// 고정항목
// ─────────────────────────────────────────────
async function loadFixedItems(clientId){
  if(!clientId)return;
  const{getDocs,collection,query,where}=fb();
  const snap=await getDocs(query(collection(fdb(),'fixedItems'),where('clientId','==',clientId)));
  S.fixedItems=snap.docs.map(d=>({id:d.id,...d.data()}));
}
async function applyFixedItems(){
  const clientId=S.activeClient;
  if(!clientId){toast('입주자를 먼저 선택하세요.','error');return;}
  await loadFixedItems(clientId);
  if(!S.fixedItems.length){toast('등록된 고정항목이 없습니다. 설정에서 추가하세요.','info');return;}
  const now=new Date(), yearMonth=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  const existing=S.transactions.filter(t=>(t.date||'').startsWith(yearMonth)&&t.isFixed);
  const existKeys=new Set(existing.map(t=>t.fixedItemId));
  const toAdd=S.fixedItems.filter(f=>!existKeys.has(f.id));
  if(!toAdd.length){toast('이번 달 고정항목이 이미 입력되었습니다.','info');return;}
  showConfirm('고정항목 입력',`${yearMonth} 기준 고정항목 ${toAdd.length}건을 입력하시겠습니까?`,async()=>{
    const{addDoc,collection}=fb();
    const today=yearMonth+'-01';
    for(const f of toAdd){
      await addDoc(collection(fdb(),COLS.TRANSACTIONS),{
        clientId,accountId:f.accountId,
        date:f.day?yearMonth+'-'+String(f.day).padStart(2,'0'):today,
        type:f.type,category:f.category,description:f.description,
        amountIn:f.type==='수입'?Number(f.amount):0,
        amountOut:f.type==='지출'?Number(f.amount):0,
        receiptUrl:'',isFixed:true,fixedItemId:f.id
      });
    }
    toast(`${toAdd.length}건 입력 완료`,'success');
    await loadTransactions(clientId);
  },'입력');
}
async function saveFixedItem(data){
  const{addDoc,setDoc,doc,collection}=fb();
  if(data.id){const id=data.id;delete data.id;await setDoc(doc(fdb(),'fixedItems',id),data);}
  else await addDoc(collection(fdb(),'fixedItems'),data);
  toast('고정항목 저장됨','success');
}
async function deleteFixedItem(id){
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),'fixedItems',id));
  toast('삭제됨','success');
}

// ─────────────────────────────────────────────
// 증빙 A4 출력
// ─────────────────────────────────────────────
async function printReceiptSheet(){
  const clientId=S.activeClient;
  if(!clientId){toast('입주자를 선택하세요.','error');return;}
  const trxWithReceipt=S.filteredTrx.filter(t=>t.receiptUrl);
  if(!trxWithReceipt.length){toast('증빙이 있는 거래가 없습니다.','info');return;}
  const client=S.clients.find(c=>c.id===clientId)||{name:''};
  const win=window.open('','_blank');
  const driveIdOf=url=>{const m=url.match(/\/d\/([^/?]+)/);return m?m[1]:null;};
  let cells='';
  trxWithReceipt.forEach((t,i)=>{
    const id=driveIdOf(t.receiptUrl);
    const imgSrc=id?'https://drive.google.com/thumbnail?id='+id+'&sz=w400':t.receiptUrl;
    cells+='<div class="cell"><div class="cell-info">'+t.date+' · '+(t.description||'')+' · '+(t.amountOut>0?t.amountOut.toLocaleString()+'원':t.amountIn.toLocaleString()+'원')+'</div><div class="cell-img"><img src="'+imgSrc+'" onerror="this.src=\'\';this.parentElement.innerHTML=\'이미지 없음\'"></div></div>';
    if((i+1)%8===0&&i+1<trxWithReceipt.length)cells+='<div style="page-break-after:always;"></div>';
  });
  // A4(210×297mm) - 여백16mm - 제목8mm → 유효높이 약273mm, 4행이므로 행높이 약66mm, 이미지영역 약58mm
  win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>증빙 출력 — '+client.name+'</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:"Noto Sans KR",sans-serif;background:#fff;padding:8mm;}h2{font-size:12px;font-weight:700;color:#374151;margin-bottom:4mm;}.grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm;}.cell{border:1px solid #d1d5db;border-radius:3px;padding:2px;break-inside:avoid;page-break-inside:avoid;height:62mm;display:flex;flex-direction:column;overflow:hidden;}.cell-info{font-size:7.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;padding-bottom:2px;border-bottom:1px solid #f3f4f6;margin-bottom:2px;}.cell-img{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;min-height:0;}.cell-img img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;}@page{size:A4 portrait;margin:8mm;}@media print{body{padding:0;}.grid{height:calc(297mm - 16mm - 10mm);grid-template-rows:repeat(4,1fr);}}</style></head><body><h2>📎 증빙 출력 — '+client.name+' ('+trxWithReceipt.length+'건)</h2><div class="grid">'+cells+'</div><script>window.onload=()=>{window.print();};<\/script></body></html>');
  win.document.close();
}

// ─────────────────────────────────────────────
// 모달
// ─────────────────────────────────────────────
function openModal(type,data){
  document.getElementById('modal-wrap').classList.add('show');
  if(type==='trx')           renderTrxForm(data);
  if(type==='excel')         renderExcelForm();
  if(type==='receipt-upload')renderReceiptUploadForm(data?.id);
  if(type==='client')        renderClientForm(data);
  if(type==='account')       renderAccountForm(data);
  if(type==='staff')         renderStaffForm(data);
  if(type==='fixed-item')    renderFixedItemForm(data);
}
function closeModal(){
  document.getElementById('modal-wrap').classList.remove('show');
  document.getElementById('modal-body').innerHTML='';
}

// ─────────────────────────────────────────────
// 수기 입력 폼
// ─────────────────────────────────────────────
function renderTrxForm(t){
  const isEdit=!!t;
  const editAmount=isEdit?(t.type==='수입'?t.amountIn:t.type==='자산이동'?t.amountOut:t.amountOut):'';
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:20px;">${isEdit?'내역 수정':'수기 입력'}</h3>
    <input type="hidden" id="f-trx-id" value="${isEdit?t.id:''}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;">
        <div><label class="label">날짜</label><input type="date" id="f-date" class="input" value="${isEdit?t.date:new Date().toISOString().split('T')[0]}"></div>
        <div><label class="label">시간 <span style="font-size:10px;color:var(--muted);">(선택)</span></label><input type="time" id="f-time" class="input" value="${isEdit?t.time||'':''}" style="width:110px;"></div>
        <div><label class="label">출금 계좌</label><select id="f-acc" class="input" style="padding:8px 12px;"></select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">구분</label><select id="f-type" class="input" style="padding:8px 12px;">
          <option value="지출"${isEdit&&t.type==='지출'?' selected':''}>지출</option>
          <option value="수입"${isEdit&&t.type==='수입'?' selected':''}>수입</option>
          <option value="자산이동"${isEdit&&t.type==='자산이동'?' selected':''}>자산이동 (계좌간 이체)</option>
          <option value="취소"${isEdit&&t.type==='취소'?' selected':''}>취소 (카드승인취소)</option>
        </select></div>
        <div><label class="label">금액</label><input type="number" id="f-amount" class="input" value="${editAmount}" placeholder="0" min="0" style="text-align:right;"></div>
      </div>
      <div id="f-to-acc-row" style="display:none;">
        <label class="label">입금 계좌 (자산이동 시)</label>
        <select id="f-to-acc" class="input" style="padding:8px 12px;width:100%;"></select>
      </div>
      <div id="f-cat-row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">분류</label><select id="f-cat" class="input" style="padding:8px 12px;"></select></div>
        <div><label class="label">내용</label><input type="text" id="f-desc" class="input" value="${isEdit?t.description||'':''}" placeholder="거래 내용"></div>
      </div>
      <div>
        <label class="label">영수증 첨부 <span style="font-size:10px;color:var(--muted);">(선택)</span></label>
        ${isEdit&&t.receiptUrl?`<div id="trx-receipt-current" style="margin-bottom:6px;"><a href="${t.receiptUrl}" target="_blank" style="font-size:12px;color:var(--blue);">📎 현재 첨부파일 보기</a> <button onclick="document.getElementById('trx-receipt-current').innerHTML='<span style=\\'font-size:12px;color:#dc2626;\\'>삭제됨</span>';window._trxReceiptClear=true;" style="font-size:11px;color:#dc2626;background:none;border:none;cursor:pointer;">× 삭제</button></div>`:''}
        <div id="trx-receipt-drop" style="border:2px dashed var(--border);border-radius:8px;background:var(--bg);padding:12px;text-align:center;cursor:pointer;font-size:13px;color:var(--muted);" onclick="document.getElementById('trx-receipt-file').click()">
          📎 영수증 클릭 또는 드래그
          <input type="file" id="trx-receipt-file" accept="image/*" style="display:none;">
        </div>
        <div id="trx-receipt-preview" style="display:none;margin-top:6px;font-size:12px;color:var(--green);"></div>
      </div>
      <button id="f-save-btn" class="btn" style="width:100%;padding:11px;">💾 저장하기</button>
    </div>`;
  window._trxReceiptClear=false;
  const accSel=document.getElementById('f-acc');
  const toAccSel=document.getElementById('f-to-acc');
  const allAccs=S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts;
  allAccs.forEach(a=>{
    const cn=S.clients.find(c=>c.id===a.clientId)?.name||'';
    const opt=`[${cn}] ${a.label}`;
    accSel.add(new Option(opt,a.id));
    toAccSel.add(new Option(opt,a.id));
  });
  if(isEdit)accSel.value=t.accountId;
  if(isEdit&&t.linkedAccountId)toAccSel.value=t.linkedAccountId;
  const toAccRow=document.getElementById('f-to-acc-row');
  const showToAcc=()=>{const type=document.getElementById('f-type').value;if(toAccRow)toAccRow.style.display=type==='자산이동'?'block':'none';};
  showToAcc();
  updateTrxCatSel();
  if(isEdit&&t.category)document.getElementById('f-cat').value=t.category;
  document.getElementById('f-type').addEventListener('change',()=>{updateTrxCatSel();showToAcc();});
  document.getElementById('f-save-btn').addEventListener('click',async()=>{
    const accId=document.getElementById('f-acc').value;
    const amount=Number(document.getElementById('f-amount').value);
    if(!accId){toast('계좌를 선택하세요.','error');return;}
    if(!amount){toast('금액을 입력하세요.','error');return;}
    const acc=S.accounts.find(a=>a.id===accId);
    const type=document.getElementById('f-type').value;
    const date=document.getElementById('f-date').value;
    const time=document.getElementById('f-time')?.value||''; // F003
    const cat=document.getElementById('f-cat').value;
    const desc=document.getElementById('f-desc').value;
    const existId=document.getElementById('f-trx-id').value;
    if(type==='자산이동'){
      const toAccId=document.getElementById('f-to-acc').value;
      if(!toAccId){toast('입금 계좌를 선택하세요.','error');return;}
      if(toAccId===accId){toast('출금 계좌와 입금 계좌가 같습니다.','error');return;}
      const toAcc=S.accounts.find(a=>a.id===toAccId);
      closeModal();
      if(existId){
        const outData={clientId:acc.clientId,accountId:accId,date,time,type:'자산이동',category:'자산이동',description:desc,amountIn:0,amountOut:amount,receiptUrl:t.receiptUrl||'',linkedAccountId:toAccId};
        outData.id=existId; await saveTrx(outData);
        // B003: 연결 입금 거래 동기화
        if(t.linkedTrxId){
          const toAcc2=S.accounts.find(a=>a.id===toAccId);
          const{doc:d2,updateDoc:ud2}=fb();
          await ud2(d2(fdb(),COLS.TRANSACTIONS,t.linkedTrxId),{clientId:toAcc2?.clientId||acc.clientId,accountId:toAccId,date,time,description:desc,amountIn:amount,amountOut:0,linkedAccountId:accId});
          await updateAccBalance(toAccId);
          if(S.activeClient)await loadTransactions(S.activeClient);
        }
      } else {
        const{addDoc,collection,updateDoc,doc}=fb();
        const outRef=await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:acc.clientId,accountId:accId,date,time,type:'자산이동',category:'자산이동',description:desc,amountIn:0,amountOut:amount,receiptUrl:'',linkedAccountId:toAccId});
        const inRef=await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:toAcc.clientId,accountId:toAccId,date,time,type:'자산이동',category:'자산이동',description:desc,amountIn:amount,amountOut:0,receiptUrl:'',linkedAccountId:accId,linkedTrxId:outRef.id});
        await updateDoc(doc(fdb(),COLS.TRANSACTIONS,outRef.id),{linkedTrxId:inRef.id});
        await updateAccBalance(accId); await updateAccBalance(toAccId);
        if(S.activeClient===acc.clientId||S.activeClient===toAcc?.clientId)await loadTransactions(S.activeClient);
        toast('자산이동 저장됨','success');
      }
    } else {
      // 영수증 업로드 처리
      let receiptUrl=isEdit?t.receiptUrl||'':'';
      if(window._trxReceiptClear)receiptUrl='';
      const receiptFile=document.getElementById('trx-receipt-file')?.files[0];
      if(receiptFile){
        try{
          const url=await uploadToDrive(receiptFile);
          if(url)receiptUrl=url;
        }catch(e){toast('영수증 업로드 실패: '+e.message,'error');}
      }
      const trxData={clientId:acc.clientId,accountId:accId,date,time,type,category:cat,description:desc,
        amountIn:type==='수입'?amount:0,
        amountOut:(type==='지출'||type==='취소')?amount:0,
        receiptUrl};
      if(existId)trxData.id=existId;
      closeModal(); await saveTrx(trxData);
    }
  });
  // 파일 선택 미리보기
  document.getElementById('trx-receipt-file')?.addEventListener('change',function(){
    const f=this.files[0]; if(!f)return;
    const preview=document.getElementById('trx-receipt-preview');
    if(preview){preview.style.display='block';preview.textContent='📎 '+f.name+' ('+Math.round(f.size/1024)+'KB)';}
    const drop=document.getElementById('trx-receipt-drop');
    if(drop)drop.style.borderColor='var(--green)';
  });
  // 드래그앤드롭
  const dropEl=document.getElementById('trx-receipt-drop');
  if(dropEl){
    dropEl.addEventListener('dragover',e=>{e.preventDefault();dropEl.style.background='#f0fdf4';});
    dropEl.addEventListener('dragleave',()=>{dropEl.style.background='var(--bg)';});
    dropEl.addEventListener('drop',e=>{
      e.preventDefault();dropEl.style.background='var(--bg)';
      const f=e.dataTransfer.files[0]; if(!f||!f.type.startsWith('image/'))return;
      const fi=document.getElementById('trx-receipt-file');
      if(fi){
        const dt=new DataTransfer(); dt.items.add(f); fi.files=dt.files;
        fi.dispatchEvent(new Event('change'));
      }
    });
  }
}
function updateTrxCatSel(){
  const type=document.getElementById('f-type')?.value||'지출';
  const sel=document.getElementById('f-cat');
  const catRow=document.getElementById('f-cat-row');
  if(!sel)return;
  if(type==='자산이동'||type==='취소'){
    if(catRow)catRow.style.display='none';
    sel.innerHTML='<option value="">-</option>';
    return;
  }
  if(catRow)catRow.style.display='';
  sel.innerHTML='';
  const clientId=S.activeClient||'';
  const cats=[...new Set(
    S.categories
      .filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===clientId))
      .sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999))
      .map(c=>c.category)
  )];
  if(!cats.includes('확인필요'))cats.push('확인필요');
  cats.forEach(c=>sel.add(new Option(c,c)));
}

// ─────────────────────────────────────────────
// 엑셀 파일 업로드 폼
// ─────────────────────────────────────────────
function renderExcelForm(){
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">📂 엑셀 파일 업로드</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">계좌 선택</label><select id="xl-acc" class="input" style="padding:8px 12px;"></select></div>
      <div id="xl-drop" class="dropzone" style="cursor:pointer;">
        <input type="file" id="xl-file" accept=".xlsx,.xls,.html,.htm,.xml,.csv" style="display:none;">
        <div style="font-size:28px;margin-bottom:8px;">📊</div>
        <div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">xlsx · xls · html · xml · csv</div>
      </div>
      <div style="background:#f0fdf4;border:1px solid #a7f3d0;border-radius:8px;padding:10px 14px;font-size:12px;color:#065f46;">
        💡 은행 파일이 없으신가요? <strong>수기 입력 양식</strong>을 다운로드하여 직접 작성 후 업로드하세요.
        <button onclick="downloadManualTemplate()" style="margin-left:8px;padding:3px 10px;border-radius:6px;border:1px solid #059669;color:#059669;background:#fff;cursor:pointer;font-size:12px;">📥 양식 다운로드</button>
      </div>
      <button id="xl-btn" class="btn" style="width:100%;padding:10px;">📊 파일 분석 시작</button>
      <div id="xl-preview" style="display:none;"></div>
    </div>`;
  const accSel=document.getElementById('xl-acc');
  (S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts).forEach(a=>{
    const cn=S.clients.find(c=>c.id===a.clientId)?.name||'';
    accSel.add(new Option(`[${cn}] ${a.label}`,a.id));
  });
  const zone=document.getElementById('xl-drop'), fi=document.getElementById('xl-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
  zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');if(e.dataTransfer.files.length){fi.files=e.dataTransfer.files;onXlFileSelect();}});
  fi.addEventListener('change',onXlFileSelect);
  document.getElementById('xl-btn').addEventListener('click',analyzeXlFile);
}
function downloadManualTemplate(){
  // CSV 형식 수기 입력 양식 생성 후 다운로드
  const today=new Date().toISOString().split('T')[0];
  const rows=[
    ['날짜','내용','지출금액','입금금액'],
    [today,'점심 식비','5000',''],
    [today,'용돈 입금','','30000'],
  ];
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const bom='\uFEFF'; // Excel 한글 깨짐 방지 BOM
  const blob=new Blob([bom+csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='수기입력_양식.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('양식 다운로드 완료. 내용 작성 후 업로드하세요.','success');
}
function onXlFileSelect(){
  const fi=document.getElementById('xl-file'), btn=document.getElementById('xl-btn');
  if(fi.files.length){
    S.excelFile=fi.files[0]; // 원본 파일 참조 보존
    if(btn)btn.textContent=`📊 분석 시작 (${fi.files[0].name})`;
  }
}
function analyzeXlFile(){
  const fi=document.getElementById('xl-file'); if(!fi?.files?.length){toast('파일을 선택하세요.','error');return;}
  const btn=document.getElementById('xl-btn'); btn.disabled=true; btn.textContent='분석 중...';
  const clientId=S.activeClient||'';
  // C002: 입주자별 규칙 우선, 공통 규칙 후순위로 정렬
  const parserCats=S.categories.filter(c=>c.keyword&&c.keyword!==''&&(!c.clientId||c.clientId===clientId)).sort((a,b)=>(a.clientId===clientId?0:1)-(b.clientId===clientId?0:1)).map(c=>({keyword:c.keyword,category:c.category,subcategory:c.subcategory||''}));
  ExcelParser.parseFile(fi.files[0],parserCats)
    .then(parsed=>{
      if(!parsed.length){toast('인식된 거래 데이터가 없습니다.','error');btn.disabled=false;btn.textContent='파일 분석 시작';return;}
      const existSet=new Set(S.transactions.map(t=>`${t.date}_${Math.abs(t.amountIn||0)}_${Math.abs(t.amountOut||0)}`));
      const existingMaxOrder=S.transactions.length>0?Math.max(...S.transactions.map(t=>t.sortOrder??0)):0;
      S.excelTemp=parsed.map((p,i)=>{
        const rawIn=p.in||0, rawOut=p.out||0;
        let amIn=0, amOut=0, type='지출';
        if(rawIn>0){amIn=rawIn;type='수입';}
        else if(rawOut>0){amOut=rawOut;type='지출';}
        else if(rawOut<0){amOut=rawOut;type='지출';}
        else if(rawIn<0){amOut=Math.abs(rawIn);type='취소';}
        const isDup=existSet.has(`${p.date}_${Math.abs(amIn)}_${Math.abs(amOut)}`);
        return {date:p.date,description:p.desc,amountIn:amIn,amountOut:amOut,type,category:p.cat||'확인필요',subcategory:p.sub||'',receiptUrl:'',_dup:isDup,sortOrder:existingMaxOrder+i+1};
      });
      // 원본 행 보존 (Drive 저장 + 대조용)
      S.excelRawRows=parsed.map(p=>({date:p.date,desc:p.desc,amountIn:p.in>0?p.in:0,amountOut:p.out>0?p.out:0}));
      // 가장 빈번한 연월 자동 감지
      const mCount={};parsed.forEach(p=>{const m=(p.date||'').substring(0,7);if(m)mCount[m]=(mCount[m]||0)+1;});
      S.excelMonth=Object.entries(mCount).sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
      const dupCount=S.excelTemp.filter(x=>x._dup).length;
      btn.disabled=false; btn.textContent=`분석 완료 (${S.excelTemp.length}건)`;
      if(dupCount>0)toast(`⚠️ ${dupCount}건이 기존 거래와 중복됩니다. 저장 시 자동 제외됩니다.`,'info',5000);
      renderXlPreview();
    })
    .catch(err=>{btn.disabled=false;btn.textContent='파일 분석 시작';toast('파싱 오류: '+err.message,'error');});
}
function renderXlPreview(){
  const el=document.getElementById('xl-preview'); if(!el)return;
  if(!S.excelTemp.length){el.style.display='none';return;}
  const dupCount=S.excelTemp.filter(x=>x._dup).length;
  el.style.display='block';
  el.innerHTML=`
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
      <div style="font-size:13px;font-weight:700;color:var(--sub);">총 ${S.excelTemp.length}건 분석됨${dupCount>0?' <span style="color:#92400e;background:#fef3c7;padding:1px 7px;border-radius:5px;font-size:11px;">중복 '+dupCount+'건 저장 제외</span>':''}</div>
      <label style="font-size:12px;color:var(--muted);margin-left:auto;display:flex;align-items:center;gap:6px;">📅 업로드 연월
        <input type="month" id="xl-month-label" class="input" value="${S.excelMonth}" style="padding:4px 8px;font-size:12px;width:130px;">
      </label>
    </div>
    <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:9px;background:#f8fafc;margin-bottom:10px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead style="background:#fff;position:sticky;top:0;"><tr>
          <th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">날짜</th>
          <th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">내용</th>
          <th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">분류</th>
          <th style="padding:7px 10px;text-align:right;font-size:11px;color:var(--muted);">금액</th>
          <th style="padding:7px 10px;"></th>
        </tr></thead>
        <tbody id="xl-tbody"></tbody>
      </table>
    </div>
    <button id="xl-save-btn" class="btn" style="width:100%;padding:11px;background:#10b981;">✅ 최종 저장 (Drive 자동 백업 포함)</button>`;
  const tbody=document.getElementById('xl-tbody');
  S.excelTemp.forEach((t,i)=>{
    const isIn=t.amountIn>0, amt=isIn?t.amountIn:Math.abs(t.amountOut), c=cs(t.category);
    const tr=document.createElement('tr'); tr.style.cssText='border-top:1px solid var(--border);';
    const dupBadge=t._dup?'<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:4px;margin-left:4px;">중복의심</span>':'';
    tr.style.background=t._dup?'#fffbeb':'';
    tr.innerHTML=`<td style="padding:6px 10px;font-size:12px;color:var(--sub);white-space:nowrap;">${t.date}</td><td style="padding:6px 10px;font-size:13px;color:var(--text);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${t.description}">${t.description}${dupBadge}</td><td style="padding:6px 10px;"><span style="background:${c.bg};color:${c.text};padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700;">${t.category}</span></td><td style="padding:6px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:${isIn?'#059669':t.type==='취소'?'#71717a':'#dc2626'};">${isIn?'+':''}${amt.toLocaleString()}원${t.type==='취소'?' (취소)':''}</td><td style="padding:6px 10px;text-align:center;"><button style="font-size:12px;color:#94a3b8;background:none;border:none;cursor:pointer;">✕</button></td>`;
    tr.querySelector('button').addEventListener('click',()=>removeXlItem(i));
    tbody.appendChild(tr);
  });
  document.getElementById('xl-save-btn').addEventListener('click',saveExcelData);
}
function removeXlItem(idx){
  S.excelTemp.splice(idx,1);
  if(!S.excelTemp.length){document.getElementById('xl-preview').style.display='none';toast('모든 항목이 제거되었습니다.','info');return;}
  renderXlPreview();
}
async function saveExcelData(){
  const accId=document.getElementById('xl-acc')?.value;
  if(!accId){toast('계좌를 선택하세요.','error');return;}
  if(!S.excelTemp.length){toast('데이터가 없습니다.','error');return;}
  const acc=S.accounts.find(a=>a.id===accId); if(!acc)return;
  const btn=document.getElementById('xl-save-btn'); if(btn){btn.disabled=true;btn.textContent='저장 중...';}
  // 중복(_dup) 행 제외하고 저장
  const toSave=S.excelTemp.filter(item=>!item._dup);
  const dupCount=S.excelTemp.length-toSave.length;
  const{addDoc,collection}=fb();
  for(const item of toSave){
    await addDoc(collection(fdb(),COLS.TRANSACTIONS),{
      clientId:acc.clientId,accountId:accId,date:item.date,type:item.type,
      category:item.category,subcategory:item.subcategory||'',
      description:item.description,amountIn:item.amountIn||0,amountOut:item.amountOut||0,
      receiptUrl:'',sortOrder:item.sortOrder??null
    });
  }
  await updateAccBalance(accId);
  const msg=dupCount>0?`${toSave.length}건 저장됨 (중복 ${dupCount}건 제외)`:toSave.length+'건 저장됨';
  toast(msg,'success'); closeModal();
  if(S.activeClient===acc.clientId)await loadTransactions(acc.clientId);
  // 엑셀 원본 Drive 업로드 + excelUploads 저장 (거래 저장 후 비동기)
  if(S.excelFile){
    const uploadFile=S.excelFile, uploadRawRows=[...S.excelRawRows];
    const uploadMonth=document.getElementById('xl-month-label')?.value||S.excelMonth;
    S.excelFile=null; S.excelRawRows=[]; S.excelMonth='';
    try{
      toast('원본 파일 Drive 업로드 중...','info',3000);
      const url=await uploadToDrive(uploadFile);
      const{addDoc:aDoc,collection:col}=fb();
      await aDoc(col(fdb(),COLS.EXCEL_UPLOADS),{
        accId,clientId:acc.clientId,filename:uploadFile.name,
        month:uploadMonth,url,uploadedAt:new Date().toISOString().split('T')[0],
        rawRows:uploadRawRows
      });
      toast('원본 파일 Drive 저장 완료','success',2000);
    }catch(e){toast('Drive 저장 실패 (거래는 정상 저장됨): '+e.message,'error',5000);}
  }
}

// ─────────────────────────────────────────────
// 증빙 업로드 모달
// ─────────────────────────────────────────────
_receiptSelectedFile=null;
function renderReceiptUploadForm(trxId){
  _receiptSelectedFile=null;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">📎 증빙 업로드</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px;">클릭하거나 파일을 끌어다 놓으면 Google Drive에 자동 업로드됩니다.</p>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div id="ru-drop" style="border:2px dashed var(--bm);border-radius:12px;background:#f8fafc;padding:24px 20px;text-align:center;cursor:pointer;transition:all .15s;">
        <input type="file" id="ru-file" accept="image/*,.pdf" style="display:none;">
        <div id="ru-drop-inner"><div style="font-size:28px;margin-bottom:8px;">🖼️</div><div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요</div><div style="font-size:11px;color:var(--muted);margin-top:4px;">jpg · png · gif · webp · pdf</div></div>
      </div>
      <div id="ru-preview" style="display:none;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#f8fafc;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);">
          <span id="ru-fname" style="font-size:12px;font-weight:700;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;"></span>
          <span id="ru-fsize" style="font-size:11px;color:var(--muted);flex-shrink:0;margin-left:8px;"></span>
        </div>
        <div style="text-align:center;padding:10px;">
          <img id="ru-img" style="max-width:100%;max-height:220px;border-radius:6px;display:none;" alt="미리보기">
          <div id="ru-pdf-icon" style="display:none;font-size:40px;padding:16px;">📄</div>
        </div>
      </div>
      <button id="ru-btn" class="btn" style="width:100%;padding:11px;opacity:.5;cursor:not-allowed;" disabled>파일을 먼저 선택하세요</button>
      <div id="ru-status" style="font-size:12px;color:var(--muted);text-align:center;display:none;"></div>
    </div>`;
  const zone=document.getElementById('ru-drop'), fi=document.getElementById('ru-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragenter',e=>{e.preventDefault();e.stopPropagation();});
  zone.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();zone.style.borderColor='var(--blue)';zone.style.background='#eff6ff';});
  zone.addEventListener('dragleave',e=>{e.stopPropagation();zone.style.borderColor='var(--bm)';zone.style.background='#f8fafc';});
  zone.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();zone.style.borderColor='var(--bm)';zone.style.background='#f8fafc';const file=e.dataTransfer?.files?.[0];if(file)onReceiptFileSelect(file);});
  fi.addEventListener('change',()=>{const file=fi.files?.[0];if(file)onReceiptFileSelect(file);});
  document.getElementById('ru-btn').addEventListener('click',()=>doReceiptUpload(trxId));
}
function onReceiptFileSelect(file){
  _receiptSelectedFile=file;
  const fn=document.getElementById('ru-fname'), fs=document.getElementById('ru-fsize');
  const prev=document.getElementById('ru-preview'), img=document.getElementById('ru-img');
  const pdf=document.getElementById('ru-pdf-icon'), drop=document.getElementById('ru-drop'), btn=document.getElementById('ru-btn');
  if(fn)fn.textContent='📄 '+file.name;
  if(fs)fs.textContent=(file.size/1024).toFixed(0)+' KB';
  if(prev)prev.style.display='block';
  if(drop)drop.style.padding='12px 20px';
  const inner=document.getElementById('ru-drop-inner');
  if(inner)inner.innerHTML='<div style="font-size:12px;color:var(--muted);">다른 파일로 변경하려면 클릭하세요</div>';
  if(file.type.startsWith('image/')){
    if(pdf)pdf.style.display='none'; if(img)img.style.display='block';
    const reader=new FileReader(); reader.onload=e=>{if(img)img.src=e.target.result;}; reader.readAsDataURL(file);
  } else {if(img)img.style.display='none'; if(pdf)pdf.style.display='block';}
  if(btn){btn.disabled=false;btn.style.opacity='1';btn.style.cursor='pointer';btn.textContent='📤 Drive에 업로드';}
}
async function doReceiptUpload(trxId){
  if(!_receiptSelectedFile){toast('파일을 선택하세요.','error');return;}
  const btn=document.getElementById('ru-btn'), status=document.getElementById('ru-status');
  btn.disabled=true; btn.textContent='압축 중...';
  if(status){status.textContent='이미지 압축 중...';status.style.display='block';}
  try{
    btn.textContent='업로드 중...';
    if(status)status.textContent='Google Drive에 업로드 중입니다...';
    const url=await uploadToDrive(_receiptSelectedFile);
    const{doc,updateDoc}=fb();
    await updateDoc(doc(fdb(),COLS.TRANSACTIONS,trxId),{receiptUrl:url});
    [S.transactions,S.filteredTrx].forEach(arr=>{const t=arr.find(x=>x.id===trxId);if(t)t.receiptUrl=url;});
    toast('업로드 완료!','success'); _receiptSelectedFile=null; closeModal(); renderHistoryTable();
  }catch(e){btn.disabled=false;btn.textContent='📤 Drive에 업로드';if(status)status.style.display='none';toast('업로드 실패: '+e.message,'error');}
}
function openReceiptUpload(trxId){openModal('receipt-upload',{id:trxId});}

// ─────────────────────────────────────────────
// 영수증 미리보기 모달
// ─────────────────────────────────────────────
// 영수증 미리보기 — 드래그 가능 플로팅 패널 (거래정보 함께 표시)
function openReceiptModal(url, trxId){
  if(!url)return;
  const trx=trxId?[...S.transactions,...(S.reportData?.trxList||[])].find(x=>x.id===trxId):null;
  const driveMatch=url.match(/\/d\/([^/?]+)/);
  const isDrive=!!driveMatch;
  const isLocalImg=/\.(jpg|jpeg|png|gif|webp|bmp)/i.test(url)&&!isDrive;
  // 기존 플로팅 패널 제거
  const existing=document.getElementById('receipt-float-panel');
  if(existing)existing.remove();
  const acc=trx?S.accounts.find(a=>a.id===trx.accountId):null;
  const trxInfoHtml=trx?`<div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px;">
    <div style="font-size:12px;font-weight:700;color:var(--sub);margin-bottom:8px;">📋 거래 정보</div>
    <div style="display:flex;flex-direction:column;gap:5px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">날짜</span><span>${trx.date||''}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">계좌</span><span>${acc?.label||'-'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">분류</span><span>${trx.category||'-'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">내용</span><span style="max-width:140px;text-align:right;word-break:break-all;">${trx.description||'-'}</span></div>
      ${trx.amountIn?`<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">수입</span><span style="color:#10b981;font-weight:700;">${Number(trx.amountIn).toLocaleString()}원</span></div>`:''}
      ${trx.amountOut?`<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">지출</span><span style="color:#ef4444;font-weight:700;">${Number(trx.amountOut).toLocaleString()}원</span></div>`:''}
    </div>
  </div>`:'';
  const panel=document.createElement('div');
  panel.id='receipt-float-panel';
  panel.style.cssText='position:fixed;right:16px;top:60px;width:300px;max-height:90vh;overflow-y:auto;background:#fff;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.18);z-index:9999;padding:16px;';
  let imgHtml='';
  if(isDrive){
    const fileId=driveMatch[1];
    imgHtml=`<div id="rfp-loading" style="text-align:center;padding:30px 0;"><div class="spinner" style="margin:0 auto 8px;"></div><p style="font-size:12px;color:var(--muted);">불러오는 중...</p></div><img id="rfp-img" src="https://drive.google.com/thumbnail?id=${fileId}&sz=w600" alt="영수증" style="display:none;max-width:100%;border-radius:8px;">`;
  } else if(isLocalImg){
    imgHtml=`<img src="${url}" alt="영수증" style="max-width:100%;border-radius:8px;">`;
  } else {
    imgHtml=`<div style="text-align:center;padding:20px 0;font-size:32px;">📄</div>`;
  }
  panel.innerHTML=`<div id="rfp-drag-handle" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;cursor:grab;">
    <span style="font-size:14px;font-weight:700;color:var(--text);">📎 영수증 미리보기</span>
    <div style="display:flex;gap:6px;align-items:center;">
      <a href="${url}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);border:1px solid #bfdbfe;padding:3px 8px;border-radius:6px;text-decoration:none;">🔗 새탭</a>
      <button onclick="closeReceiptModal()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--muted);line-height:1;">×</button>
    </div>
  </div>${imgHtml}${trxInfoHtml}`;
  document.body.appendChild(panel);
  // 이미지 로드 이벤트
  if(isDrive){
    const img=panel.querySelector('#rfp-img'), loading=panel.querySelector('#rfp-loading');
    if(img&&loading){img.onload=()=>{loading.style.display='none';img.style.display='block';};img.onerror=()=>{loading.style.display='none';};}
  }
  // 드래그 이동
  const handle=panel.querySelector('#rfp-drag-handle');
  let ox=0,oy=0,dragging=false;
  handle.addEventListener('mousedown',e=>{dragging=true;ox=e.clientX-panel.offsetLeft;oy=e.clientY-panel.offsetTop;handle.style.cursor='grabbing';e.preventDefault();});
  document.addEventListener('mousemove',e=>{if(!dragging)return;panel.style.left=(e.clientX-ox)+'px';panel.style.top=(e.clientY-oy)+'px';panel.style.right='auto';});
  document.addEventListener('mouseup',()=>{dragging=false;handle.style.cursor='grab';});
}
function closeReceiptModal(){
  const p=document.getElementById('receipt-float-panel');
  if(p)p.remove();
  // 기존 모달도 닫기 (하위 호환)
  document.getElementById('receipt-modal')?.classList.remove('show');
  const body=document.getElementById('receipt-body');if(body)body.innerHTML='';
}

// ─────────────────────────────────────────────
// 고정항목 폼
// ─────────────────────────────────────────────
function renderFixedItemForm(item){
  const isEdit=!!item;
  const accs=S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">⚙️ 고정항목 ${isEdit?'수정':'등록'}</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">계좌</label><select id="fi-acc" class="input" style="padding:8px 12px;"></select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">구분</label><select id="fi-type" class="input" style="padding:8px 12px;"><option value="지출">지출</option><option value="수입">수입</option></select></div>
        <div><label class="label">매월 몇 일</label><input type="number" id="fi-day" class="input" min="1" max="31" value="${isEdit?item.day||1:1}"></div>
      </div>
      <div><label class="label">카테고리</label><select id="fi-cat" class="input" style="padding:8px 12px;"></select></div>
      <div><label class="label">내용</label><input type="text" id="fi-desc" class="input" value="${isEdit?item.description||'':''}" placeholder="예: 국민연금, 복지관 이용료"></div>
      <div><label class="label">금액</label><input type="number" id="fi-amt" class="input" value="${isEdit?item.amount||0:0}" style="text-align:right;"></div>
      <button id="fi-save" class="btn" style="width:100%;padding:11px;">💾 저장</button>
    </div>`;
  const accSel=document.getElementById('fi-acc');
  accs.forEach(a=>accSel.add(new Option(a.label,a.id)));
  if(isEdit&&item.accountId)accSel.value=item.accountId;
  const catSel=document.getElementById('fi-cat');
  const fillCats=()=>{const type=document.getElementById('fi-type').value;catSel.innerHTML='';const cats=[...new Map(S.categories.filter(c=>c.keyword===''&&c.type===type).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(c=>[c.category,c.category])).keys()];cats.forEach(c=>catSel.add(new Option(c,c)));if(isEdit&&item.category)catSel.value=item.category;};
  fillCats();
  document.getElementById('fi-type').addEventListener('change',fillCats);
  document.getElementById('fi-save').addEventListener('click',async()=>{
    const data={clientId:S.activeClient,accountId:document.getElementById('fi-acc').value,type:document.getElementById('fi-type').value,day:Number(document.getElementById('fi-day').value)||1,category:document.getElementById('fi-cat').value,description:document.getElementById('fi-desc').value,amount:Number(document.getElementById('fi-amt').value)||0};
    if(isEdit)data.id=item.id;
    await saveFixedItem(data); closeModal();
  });
}

// ─────────────────────────────────────────────
// 입주자 폼
// ─────────────────────────────────────────────
function renderClientForm(c){
  const isEdit=!!c, isAdmin=['관리자','센터장','팀장'].includes(S.user?.role);
  const teamLeaders=S.users.filter(u=>u.role==='팀장');
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'입주자 수정':'입주자 등록'}</h3>
    <input type="hidden" id="fc-id" value="${isEdit?c.id:'cli_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">성명</label><input type="text" id="fc-name" class="input" value="${isEdit?c.name:''}"></div>
      ${isAdmin?`<div><label class="label">담당 팀장</label><select id="fc-leader" class="input" style="padding:8px 12px;"><option value="">없음</option>${teamLeaders.map(u=>`<option value="${u.id}"${isEdit&&String(c.teamLeader)===String(u.id)?' selected':''}>${u.name}${u.team?' ('+u.team+')':''}</option>`).join('')}</select></div><div><label class="label">담당 직원</label><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;max-height:140px;overflow-y:auto;padding:4px;">${S.users.map(u=>{const ex=isEdit?String(c.userIds||'').split(',').map(s=>s.trim()):[];const ch=ex.includes(String(u.id));return`<label style="display:flex;align-items:center;gap:7px;padding:7px 10px;background:${ch?'#eff6ff':'#f8fafc'};border:1px solid ${ch?'#bfdbfe':'var(--border)'};border-radius:8px;cursor:pointer;font-size:13px;"><input type="checkbox" name="fc-staff" value="${u.id}" ${ch?'checked':''} style="accent-color:var(--blue);"> ${u.name}</label>`;}).join('')}</div></div>`:''}
      <div><label class="label">메모</label><textarea id="fc-memo" class="input" style="height:64px;resize:none;">${isEdit?c.memo||'':''}</textarea></div>
      <button id="fc-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
    </div>`;
  document.getElementById('fc-save').addEventListener('click',async()=>{
    const isAdm=['관리자','센터장','팀장'].includes(S.user?.role);
    const staffIds=isAdm?Array.from(document.querySelectorAll('input[name="fc-staff"]:checked')).map(c=>c.value).join(','):String(S.user.userId);
    const leaderId=isAdm?document.getElementById('fc-leader')?.value||'':'';
    const data={id:document.getElementById('fc-id').value,name:document.getElementById('fc-name').value,contact:isEdit?c.contact||'':'',memo:document.getElementById('fc-memo').value,userIds:staffIds,teamLeader:leaderId};
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.CLIENTS,data.id),data);
    toast('저장됨','success'); closeModal(); await fetchBaseData(); renderManagement();
  });
}

// ─────────────────────────────────────────────
// 계좌 폼
// ─────────────────────────────────────────────
function renderAccountForm(a){
  const isEdit=!!a;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'계좌 수정':'계좌 등록'}</h3>
    <input type="hidden" id="fa-id" value="${isEdit?a.id:'acc_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">입주자</label><select id="fa-client" class="input" style="padding:8px 12px;"></select></div>
      <div><label class="label">계좌명 (별칭)</label><input type="text" id="fa-label" class="input" value="${isEdit?a.label||'':''}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">기초 잔액 기준일</label><input type="date" id="fa-init-date" class="input" value="${isEdit?a.initialBalanceDate||'':''}" placeholder="YYYY-MM-DD"></div>
        <div><label class="label">기초 잔액 (기준일 잔액)</label><input type="number" id="fa-init" class="input" value="${isEdit?a.initialBalance||0:0}" style="text-align:right;"></div>
      </div>
      <p style="font-size:11px;color:var(--muted);background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:8px 12px;">💡 기준일 이후의 거래내역을 기초 잔액에 합산하여 현재 잔액을 계산합니다.</p>
      <button id="fa-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
      ${isEdit?`<button id="fa-stmt-btn" class="btn-sub" style="width:100%;padding:9px;color:#0369a1;border-color:#bae6fd;margin-top:4px;">📸 통장 사진 관리 (${(a.bankStatements||[]).length}장)</button>`:''}
    </div>`;
  const sel=document.getElementById('fa-client');
  S.clients.forEach(c=>sel.add(new Option(c.name,c.id))); if(isEdit)sel.value=a.clientId;
  if(isEdit){const stmtBtn=document.getElementById('fa-stmt-btn');if(stmtBtn)stmtBtn.addEventListener('click',()=>{closeModal();openBankStatementModal(a.id);});}
  document.getElementById('fa-save').addEventListener('click',async()=>{
    const id=document.getElementById('fa-id').value, init=Number(document.getElementById('fa-init').value||0);
    const initDate=document.getElementById('fa-init-date')?.value||'';
    const data={clientId:document.getElementById('fa-client').value,label:document.getElementById('fa-label').value,accountNumber:isEdit?a.accountNumber||'':'',initialBalance:init,initialBalanceDate:initDate,currentBalance:init};
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.ACCOUNTS,id),data);
    await updateAccBalance(id);
    toast('저장됨','success'); closeModal(); await fetchBaseData(); renderManagement();
  });
}

// ─────────────────────────────────────────────
// 직원 폼
// ─────────────────────────────────────────────
function renderStaffForm(u){
  const isEdit=!!u;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'직원 수정':'직원 등록'}</h3>
    <input type="hidden" id="fs-id" value="${isEdit?u.id:'usr_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">이름</label><input type="text" id="fs-name" class="input" value="${isEdit?u.name||'':''}"></div>
      <div><label class="label">아이디</label><input type="text" id="fs-uid" class="input" value="${isEdit?u.userId||'':''}" ${isEdit?'readonly':''}></div>
      <div><label class="label">비밀번호</label><input type="password" id="fs-pw" class="input" placeholder="${isEdit?'변경 시만 입력':''}"></div>
      <div><label class="label">역할</label><select id="fs-role" class="input" style="padding:8px 12px;"><option value="입력자"${isEdit&&u.role==='입력자'?' selected':''}>입력자 (수기입력 전용)</option><option value="담당자"${isEdit&&u.role==='담당자'?' selected':''}>담당자</option><option value="팀장"${isEdit&&u.role==='팀장'?' selected':''}>팀장</option><option value="센터장"${isEdit&&u.role==='센터장'?' selected':''}>센터장</option><option value="관리자"${isEdit&&u.role==='관리자'?' selected':''}>관리자</option></select></div>
      <div><label class="label">팀</label><input type="text" id="fs-team" class="input" value="${isEdit?u.team||'':''}"></div>
      <button id="fs-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
    </div>`;
  document.getElementById('fs-save').addEventListener('click',async()=>{
    const id=document.getElementById('fs-id').value;
    const pw=document.getElementById('fs-pw').value;
    const data={userId:document.getElementById('fs-uid').value,name:document.getElementById('fs-name').value,role:document.getElementById('fs-role').value,team:document.getElementById('fs-team').value};
    if(pw)data.password=pw;
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.USERS,id),data);
    toast('저장됨','success'); closeModal(); await fetchBaseData(); renderManagement();
  });
}

// ─────────────────────────────────────────────
// 통장 사진 다중 업로드
// ─────────────────────────────────────────────
async function openBankStatementModal(accountId,yearParam,monthParam){
  if(!accountId){toast('계좌를 선택하세요.','error');return;}
  const acc=S.accounts.find(a=>a.id===accountId)||{label:'계좌'};
  const now=new Date(); const year=yearParam||now.getFullYear(); const month=monthParam||now.getMonth()+1;
  const mStr=String(year)+'-'+String(month).padStart(2,'0');
  document.getElementById('modal-wrap').classList.add('show');
  const body=document.getElementById('modal-body');
  const{getDoc,doc,updateDoc}=fb();
  const accRef=doc(fdb(),COLS.ACCOUNTS,accountId);
  const accSnap=await getDoc(accRef);
  const rawStmts=(accSnap.exists()?accSnap.data().bankStatements:[])||[];
  const existing=rawStmts.map(s=>typeof s==='string'?{url:s,month:''}:s);
  // C004: 연월 내림차순 정렬
  existing.sort((a,b)=>(b.month||'').localeCompare(a.month||''));
  // C005: 연월 필터 옵션 생성
  const months=[...new Set(existing.map(s=>s.month||'').filter(Boolean))].sort((a,b)=>b.localeCompare(a));
  const monthOpts='<option value="">전체</option>'+months.map(m=>'<option value="'+m+'">'+m+'</option>').join('');
  body.innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:6px;">🏦 통장 사진 관리</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:10px;">${acc.label} — 여러 장 업로드 가능</p>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
      <label class="label" style="margin:0;white-space:nowrap;">📅 업로드 연월:</label>
      <input type="month" id="bs-month" class="input" value="${mStr}" style="width:140px;padding:6px 10px;">
      <label class="label" style="margin:0;white-space:nowrap;">🔍 조회 필터:</label>
      <select id="bs-month-filter" class="input" style="width:130px;padding:6px 10px;">${monthOpts}</select>
    </div>
    <div id="bs-drop" style="border:2px dashed var(--bm);border-radius:12px;background:#f8fafc;padding:20px;text-align:center;cursor:pointer;margin-bottom:12px;">
      <input type="file" id="bs-file" accept="image/*,.pdf" multiple style="display:none;">
      <div style="font-size:24px;margin-bottom:6px;">📸</div>
      <div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요 (다중 선택 가능)</div>
      <div id="bs-status" style="font-size:12px;color:var(--blue);margin-top:6px;"></div>
    </div>
    <div id="bs-gallery" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px;"></div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">등록된 사진: <span id="bs-count">${existing.length}</span>장</div>`;
  const gallery=document.getElementById('bs-gallery');
  const renderGallery=(items)=>{
    // C004: 연월 내림차순 정렬 후 렌더링
    const sorted=[...items].sort((a,b)=>(b.month||'').localeCompare(a.month||''));
    // C005: 연월 필터 적용
    const filterVal=document.getElementById('bs-month-filter')?.value||'';
    const filtered=filterVal?sorted.filter(s=>s.month===filterVal):sorted;
    gallery.innerHTML='';
    filtered.forEach((item,i)=>{
      const url=typeof item==='string'?item:item.url;
      const mon=typeof item==='string'?'':item.month||'';
      const driveId=url.match(/\/d\/([^/?]+)/)?.[1];
      const thumb=driveId?'https://drive.google.com/thumbnail?id='+driveId+'&sz=w200':url;
      const cell=document.createElement('div');
      cell.style.cssText='position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;';
      cell.innerHTML='<div style="font-size:10px;color:var(--muted);padding:3px 6px;background:var(--bg);text-align:center;">'+(mon||'날짜없음')+'</div><div style="aspect-ratio:3/4;"><img src="'+thumb+'" style="width:100%;height:100%;object-fit:cover;" onerror="this.src=\'\'"></div><button style="position:absolute;top:24px;right:4px;background:rgba(220,38,38,.85);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;" data-idx="'+i+'">✕</button>';
      const origIdx=existing.indexOf(item);
      cell.querySelector('button').addEventListener('click',async()=>{if(origIdx>-1)existing.splice(origIdx,1);await updateDoc(accRef,{bankStatements:[...existing]});document.getElementById('bs-count').textContent=existing.length;renderGallery(existing);});
      cell.querySelector('img').addEventListener('click',()=>openReceiptModal(url));
      gallery.appendChild(cell);
    });
  };
  document.getElementById('bs-month-filter')?.addEventListener('change',()=>renderGallery(existing));
  renderGallery([...existing]);
  const zone=document.getElementById('bs-drop'), fi=document.getElementById('bs-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.style.borderColor='var(--blue)';});
  zone.addEventListener('dragleave',()=>zone.style.borderColor='var(--bm)');
  zone.addEventListener('drop',e=>{e.preventDefault();zone.style.borderColor='var(--bm)';if(e.dataTransfer.files.length)uploadBankStatements(e.dataTransfer.files,accRef,existing,renderGallery);});
  fi.addEventListener('change',()=>{if(fi.files.length)uploadBankStatements(fi.files,accRef,existing,renderGallery);});
}
async function uploadBankStatements(files,accRef,existing,renderGallery){
  const status=document.getElementById('bs-status');
  const total=files.length;
  const monthVal=document.getElementById('bs-month')?.value||'';
  for(let i=0;i<total;i++){
    if(status)status.textContent=`업로드 중... ${i+1}/${total}`;
    try{
      const compressed=await compressImage(files[i]);
      const url=await uploadToDrive(compressed);
      existing.push({url,month:monthVal});
      const{updateDoc}=fb();
      await updateDoc(accRef,{bankStatements:[...existing]});
      document.getElementById('bs-count').textContent=existing.length;
      renderGallery([...existing]);
    }catch(e){toast(`${files[i].name} 업로드 실패: `+e.message,'error');}
  }
  if(status)status.textContent=`${total}장 업로드 완료!`;
  toast(`${total}장 업로드 완료!`,'success');
}

// ─────────────────────────────────────────────
// 관리 화면 렌더링
// ─────────────────────────────────────────────
function renderManagement(){
  const isAdmin=['관리자','센터장','팀장'].includes(S.user?.role);
  // B005: admin-staff 섹션 및 등록 버튼 역할별 표시/숨김
  const adminStaff=document.getElementById('admin-staff');
  if(adminStaff)adminStaff.style.display=isAdmin?'block':'none';
  const btnAddClient=document.getElementById('btn-add-client');
  const btnAddAccount=document.getElementById('btn-add-account');
  if(btnAddClient)btnAddClient.style.display=isAdmin?'':'none';
  if(btnAddAccount)btnAddAccount.style.display=isAdmin?'':'none';
  const sl=document.getElementById('staff-list'); if(sl)sl.innerHTML='';
  if(isAdmin&&sl)S.users.forEach(u=>{
    const d=document.createElement('div'); d.className='card'; d.style.cssText='padding:12px 14px;display:flex;justify-content:space-between;align-items:center;';
    d.innerHTML=`<div><div style="font-weight:700;color:var(--text);">${u.name||u.userId}</div><div style="font-size:12px;color:var(--muted);">${u.role||''} ${u.team?'· '+u.team:''}</div></div><div style="display:flex;gap:6px;"><button class="icon-btn" onclick="openModal('staff',S.users.find(x=>x.id==='${u.id}'))" style="color:#64748b;">✏️</button></div>`;
    sl.appendChild(d);
  });
  const cl=document.getElementById('client-list'); if(cl)cl.innerHTML='';
  if(cl)S.clients.forEach(c=>{
    const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:10px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;${c.active===false?'opacity:0.55;':''}`;
    const leader=S.users.find(u=>String(u.id)===String(c.teamLeader));
    const inactiveBtn=isAdmin?`<button class="icon-btn" title="${c.active===false?'활성화':'비활성화'}" onclick="toggleClientActive('${c.id}',${c.active===false})" style="color:${c.active===false?'#10b981':'#94a3b8'};">${c.active===false?'🔓':'🔒'}</button>`:'';
    d.innerHTML=`<div><div style="font-weight:700;color:var(--text);">${c.name}${c.active===false?' <span style="font-size:11px;color:#ef4444;">[비활성]</span>':''}</div><div style="font-size:11px;color:var(--muted);">${leader?'팀장: '+leader.name:''}</div></div><div style="display:flex;gap:4px;">${inactiveBtn}<button class="icon-btn" onclick="openModal('client',S.clients.find(x=>x.id==='${c.id}'))" style="color:#64748b;">✏️</button></div>`;
    cl.appendChild(d);
  });
  const al=document.getElementById('account-list'); if(al)al.innerHTML='';
  if(al)S.accounts.forEach(a=>{
    const client=S.clients.find(c=>c.id===a.clientId);
    const d=document.createElement('div'); d.className='card'; d.style.cssText=`padding:10px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;${a.active===false?'opacity:0.55;':''}`;
    const inactiveBtn=isAdmin?`<button class="icon-btn" title="${a.active===false?'활성화':'비활성화'}" onclick="toggleAccountActive('${a.id}',${a.active===false})" style="color:${a.active===false?'#10b981':'#94a3b8'};">${a.active===false?'🔓':'🔒'}</button>`:'';
    d.innerHTML=`<div><div style="font-weight:700;color:var(--text);">${a.label}${a.active===false?' <span style="font-size:11px;color:#ef4444;">[비활성]</span>':''}</div><div style="font-size:11px;color:var(--muted);">${client?.name||''}</div><div style="font-size:12px;font-weight:700;color:var(--blue);">${Number(a.currentBalance||0).toLocaleString()}원</div></div><div style="display:flex;gap:4px;">${inactiveBtn}<button class="icon-btn" onclick="openModal('account',S.accounts.find(x=>x.id==='${a.id}'))" style="color:#64748b;">✏️</button></div>`;
    al.appendChild(d);
  });
}

async function toggleClientActive(id,makeActive){
  const{doc,updateDoc}=fb();
  await updateDoc(doc(fdb(),COLS.CLIENTS,id),{active:makeActive});
  toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
  await fetchBaseData(); renderManagement();
}
async function toggleAccountActive(id,makeActive){
  const{doc,updateDoc}=fb();
  await updateDoc(doc(fdb(),COLS.ACCOUNTS,id),{active:makeActive});
  toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
  await fetchBaseData(); renderManagement();
}

// ─────────────────────────────────────────────
// 설정 화면
// ─────────────────────────────────────────────
async function loadSettings(){
  const isArchive=['관리자','센터장'].includes(S.user?.role);
  const isResetAdmin=S.user?.role==='관리자';
  const archSec=document.getElementById('archive-section');
  if(archSec)archSec.style.display=isArchive?'block':'none';
  const resetSec=document.getElementById('reset-section');
  if(resetSec)resetSec.style.display=isResetAdmin?'block':'none';
  if(isArchive){
    const ySel=document.getElementById('archive-year');
    if(ySel&&!ySel.options.length){const cy=new Date().getFullYear();for(let y=cy-1;y>=cy-6;y--)ySel.add(new Option(y+'년',y));}
    loadArchiveHistory();
  }
  if(isResetAdmin&&!document.getElementById('btn-firebase-reset')?.dataset.bound){
    const btn=document.getElementById('btn-firebase-reset');
    if(btn){btn.dataset.bound='1';btn.addEventListener('click',executeFirebaseReset);}
  }
  const cSel=document.getElementById('settings-client-sel');
  if(cSel){
    const prev=cSel.value;
    cSel.innerHTML='<option value="">공통 (전체 입주자)</option>';
    S.clients.forEach(c=>cSel.add(new Option(c.name,c.id)));
    if(S.clients.some(c=>c.id===prev))cSel.value=prev;
    if(!cSel.dataset.bound){cSel.dataset.bound='1';cSel.addEventListener('change',loadSettings);}
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
  initBudgetSection();
}
async function renderFixedItemsList(clientId){
  if(!clientId)return;
  await loadFixedItems(clientId);
  const el=document.getElementById('fixed-items-list'); if(!el)return;
  el.innerHTML='';
  if(!S.fixedItems.length){el.innerHTML='<div style="font-size:13px;color:var(--muted);padding:8px 0;">등록된 고정항목이 없습니다.</div>';return;}
  S.fixedItems.forEach(f=>{
    const acc=S.accounts.find(a=>a.id===f.accountId)?.label||'-';
    const div=document.createElement('div');
    div.style.cssText='display:flex;justify-content:space-between;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px 14px;margin-bottom:6px;';
    div.innerHTML=`<div><div style="font-size:14px;font-weight:700;color:var(--text);">${f.description||'(이름없음)'} <span style="font-size:12px;font-weight:400;color:var(--muted);">매월 ${f.day||1}일</span></div><div style="font-size:12px;color:var(--muted);margin-top:2px;">${acc} · ${f.type} · ${f.category} · ${Number(f.amount||0).toLocaleString()}원</div></div><div style="display:flex;gap:6px;"><button class="fi-edit-btn icon-btn" style="color:#64748b;">✏️</button><button class="fi-del-btn icon-btn" style="color:#94a3b8;">🗑️</button></div>`;
    div.querySelector('.fi-edit-btn').addEventListener('click',()=>{S.activeClient=clientId;openModal('fixed-item',f);});
    div.querySelector('.fi-del-btn').addEventListener('click',()=>showConfirm('삭제',`"${f.description}" 고정항목을 삭제하시겠습니까?`,async()=>{await deleteFixedItem(f.id);renderFixedItemsList(clientId);}));
    el.appendChild(div);
  });
}

// ─────────────────────────────────────────────
// 카테고리 관리
// ─────────────────────────────────────────────
function renderCatTags(type){
  const id=type==='지출'?'exp-cat-tags':'inc-cat-tags';
  const el=document.getElementById(id); if(!el)return;
  const settingsClientId=S.settings.settingsClientId||'';
  const clientName=settingsClientId?S.clients.find(c=>c.id===settingsClientId)?.name||'':'';
  const allCats=S.categories
    .filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===settingsClientId))
    .sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  const colors=type==='지출'?['#dc2626','#ea580c','#d97706','#16a34a','#2563eb','#9333ea','#c026d3']:['#059669','#0891b2','#1d4ed8'];
  el.innerHTML='<p style="font-size:11px;color:var(--muted);margin-bottom:8px;">⠿ 드래그로 순서 변경 | 자주 쓰는 카테고리를 앞으로</p>';
  let dragSrc=null;
  const seen=new Set();
  allCats.forEach((catDoc,i)=>{
    const cat=catDoc.category; if(seen.has(cat+(catDoc.clientId||'')))return; seen.add(cat+(catDoc.clientId||''));
    const color=colors[i%colors.length], tag=document.createElement('span');
    const isPersonal=!!catDoc.clientId;
    tag.className='cat-tag'; tag.style.borderColor=color+'44'; tag.style.backgroundColor=color+'15';
    tag.style.cursor='grab'; tag.draggable=true; tag.dataset.docId=catDoc.id; tag.dataset.order=String(catDoc.sortOrder??i);
    tag.innerHTML=`<span style="font-size:11px;color:#94a3b8;margin-right:2px;">⠿</span><span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span><span style="font-size:13px;font-weight:700;color:${color};">${cat}</span>`
      +(isPersonal?`<span style="font-size:10px;background:${color}22;color:${color};padding:1px 5px;border-radius:4px;margin-left:2px;">${clientName}</span>`:'')
      +(cat==='확인필요'?'':`<button class="cat-del">×</button>`);
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
      const{doc,updateDoc}=fb();
      const newTags=[...el.querySelectorAll('.cat-tag')];
      for(let k=0;k<newTags.length;k++){
        const docId=newTags[k].dataset.docId;
        if(docId){await updateDoc(doc(fdb(),COLS.CATEGORIES,docId),{sortOrder:k});const cat=S.categories.find(c=>c.id===docId);if(cat)cat.sortOrder=k;}
      }
      toast('순서 저장됨','success',1500);
    });
    if(cat!=='확인필요')tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제',`"${cat}" 카테고리를 삭제하시겠습니까?`,()=>deleteCategory(type,cat,catDoc.clientId||''),'삭제'));
    el.appendChild(tag);
  });
}
function renderRuleTags(){
  const el=document.getElementById('rule-tags'); if(!el)return;
  if(!S.settings.rules.length){el.innerHTML='<div class="empty-state" style="padding:20px;"><div class="icon">🏷️</div>등록된 규칙 없음</div>';return;}
  el.innerHTML='';
  const settingsClientName=S.settings.settingsClientId?S.clients.find(c=>c.id===S.settings.settingsClientId)?.name||'':'';
  S.settings.rules.forEach(r=>{
    const tc=r.type==='지출'?'#dc2626':'#16a34a', tag=document.createElement('span');
    const isPersonal=!!r.clientId;
    tag.className='rule-tag'; tag.style.borderColor=tc+'33';
    tag.innerHTML=`<span style="font-size:13px;font-weight:700;color:var(--sub);">"${r.keyword}"</span><span style="font-size:11px;color:var(--muted);">→</span><span style="font-size:13px;font-weight:700;color:${tc};">${r.category}</span>`
      +(isPersonal?`<span style="font-size:10px;background:${tc}22;color:${tc};padding:1px 5px;border-radius:4px;">${settingsClientName||r.clientId}</span>`:'')
      +`<button class="cat-del">×</button>`;
    tag.querySelector('.cat-del').addEventListener('click',()=>showConfirm('삭제',`"${r.keyword}" 규칙을 삭제하시겠습니까?`,()=>deleteRule(r.id||r.keyword),'삭제'));
    el.appendChild(tag);
  });
}
function updateRuleCatSel(){
  const type=document.getElementById('new-rule-type')?.value||'지출';
  const sel=document.getElementById('new-rule-cat'); if(!sel)return;
  sel.innerHTML='';
  const cats=[...new Set(S.categories.filter(c=>c.keyword===''&&c.type===type).map(c=>c.category))];
  cats.forEach(c=>sel.add(new Option(c,c)));
}
async function addCategory(type,clientId=''){
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
  await fetchBaseData(); loadSettings();
  toast(`"${name}" 추가됨`,'success');
}
async function deleteCategory(type,name,clientId=''){
  const{getDocs,collection,query,where,doc,deleteDoc}=fb();
  const snap=await getDocs(query(collection(fdb(),COLS.CATEGORIES),where('keyword','==',''),where('type','==',type),where('category','==',name)));
  for(const d of snap.docs){
    const data=d.data();
    if(clientId&&(data.clientId||'')!==clientId)continue;
    if(!clientId&&data.clientId)continue;
    await deleteDoc(doc(fdb(),COLS.CATEGORIES,d.id));
  }
  await fetchBaseData(); loadSettings(); toast(`"${name}" 삭제됨`,'success');
}
async function addRule(){
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
  await fetchBaseData(); loadSettings(); toast(`"${kw}" 규칙 추가됨`,'success');
}
async function deleteRule(docId){
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),COLS.CATEGORIES,docId));
  await fetchBaseData(); loadSettings(); toast('규칙 삭제됨','success');
}
async function resetCategories(){
  showConfirm('기본값 초기화','기존 카테고리와 규칙을 모두 삭제하고 기본값으로 초기화합니다.',async()=>{
    const{getDocs,collection,doc,deleteDoc,addDoc}=fb();
    const snap=await getDocs(collection(fdb(),COLS.CATEGORIES));
    for(const d of snap.docs)await deleteDoc(doc(fdb(),COLS.CATEGORIES,d.id));
    const defaults=[
      {keyword:'',type:'지출',category:'식비',subcategory:'',sortOrder:0},
      {keyword:'',type:'지출',category:'교통비',subcategory:'',sortOrder:1},
      {keyword:'',type:'지출',category:'의료비',subcategory:'',sortOrder:2},
      {keyword:'',type:'지출',category:'생필품',subcategory:'',sortOrder:3},
      {keyword:'',type:'지출',category:'여가비',subcategory:'',sortOrder:4},
      {keyword:'',type:'지출',category:'기타',subcategory:'',sortOrder:5},
      {keyword:'',type:'지출',category:'확인필요',subcategory:'',sortOrder:6},
      {keyword:'',type:'수입',category:'수입',subcategory:'',sortOrder:0},
      {keyword:'',type:'수입',category:'확인필요',subcategory:'',sortOrder:1},
    ];
    for(const d of defaults)await addDoc(collection(fdb(),COLS.CATEGORIES),d);
    await fetchBaseData(); loadSettings(); toast('기본값으로 초기화됨','success');
  },'초기화');
}

// ─────────────────────────────────────────────
// 마감
// ─────────────────────────────────────────────
async function loadArchiveHistory(){
  const{getDocs,collection,query,where,orderBy}=fb();
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
async function confirmArchive(){
  const year=Number(document.getElementById('archive-year')?.value);
  if(!year){toast('연도를 선택하세요.','error');return;}
  showConfirm(`${year}년 데이터 마감`,`${year}년 거래 데이터를 보관하고 계좌 기초잔액을 업데이트합니다.\n이 작업은 되돌릴 수 없습니다.`,()=>executeArchive(year),'마감 실행');
}
async function executeArchive(year){
  showLoading(true);
  try{
    const{getDocs,collection,query,where,addDoc,doc,updateDoc,deleteDoc}=fb();
    const db=fdb();
    const snap=await getDocs(query(collection(db,COLS.TRANSACTIONS),where('date','>=',year+'-01-01'),where('date','<=',year+'-12-31')));
    const trxList=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!trxList.length){showLoading(false);toast(`${year}년 거래 데이터가 없습니다.`,'error');return;}
    for(const t of trxList)await addDoc(collection(db,'archive_'+year),t);
    for(const acc of S.accounts){
      const net=trxList.filter(t=>t.accountId===acc.id&&t.type!=='취소').reduce((s,t)=>s+(Number(t.amountIn||0)-Number(t.amountOut||0)),0);
      const newBal=(Number(acc.initialBalance||0))+net;
      await updateDoc(doc(db,COLS.ACCOUNTS,acc.id),{initialBalance:newBal,initialBalanceDate:(year+1)+'-01-01',currentBalance:newBal});
    }
    for(const t of trxList)await deleteDoc(doc(db,COLS.TRANSACTIONS,t.id));
    await addDoc(collection(db,COLS.CONFIG),{type:'archive',year,archivedAt:new Date().toISOString(),count:trxList.length});
    await fetchBaseData(); loadSettings();
    toast(`${year}년 마감 완료! ${trxList.length}건 보관.`,'success',5000);
  }catch(e){toast('마감 오류: '+e.message,'error');}
  showLoading(false);
}

// ─────────────────────────────────────────────
// 예산 관리
// ─────────────────────────────────────────────
function initBudgetSection(){
  const cSel=document.getElementById('budget-client-sel');
  const ySel=document.getElementById('budget-year-sel');
  if(!cSel||!ySel)return;
  // 입주자 목록
  cSel.innerHTML='<option value="">입주자 선택</option>';
  S.clients.forEach(c=>cSel.add(new Option(c.name,c.id)));
  // 연도 목록
  if(!ySel.options.length){
    const cy=new Date().getFullYear();
    for(let y=cy+1;y>=cy-3;y--)ySel.add(new Option(y+'년',y));
    ySel.value=cy; // 기본값: 현재 연도
  }
  if(!cSel.dataset.budgetBound){
    cSel.dataset.budgetBound='1';
    document.getElementById('btn-budget-load')?.addEventListener('click',loadBudgetForm);
    document.getElementById('btn-budget-save')?.addEventListener('click',saveBudget);
  }
}

async function loadBudgetForm(){
  const clientId=document.getElementById('budget-client-sel')?.value;
  const year=Number(document.getElementById('budget-year-sel')?.value);
  if(!clientId||!year){toast('입주자와 연도를 선택하세요.','error');return;}
  const{getDocs,collection,query,where}=fb();
  const db=fdb();
  // 현재 연도 + 전년도 예산 동시 로드
  const [snap,prevSnap]=await Promise.all([
    getDocs(query(collection(db,COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year))),
    getDocs(query(collection(db,COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year-1))),
  ]);
  const existing={};
  snap.docs.forEach(d=>{const b=d.data();existing[b.category]=b.amount||0;});
  const prevBudget={};
  prevSnap.docs.forEach(d=>{const b=d.data();prevBudget[b.category]=b.amount||0;});
  // 지출 카테고리 목록 (공통 + 입주자별, 전년도에만 있는 카테고리도 포함)
  const expCats=[...new Set([
    ...[...new Map(
      S.categories.filter(c=>c.type==='지출'&&c.keyword==='').sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(c=>[c.category,c.category])
    ).keys()],
    ...Object.keys(prevBudget),
  ])];
  const rows=document.getElementById('budget-cat-rows');
  if(!rows)return;
  const hasPrev=Object.keys(prevBudget).length>0;
  // 헤더
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

async function saveBudget(){
  const clientId=document.getElementById('budget-client-sel')?.value;
  const year=Number(document.getElementById('budget-year-sel')?.value);
  if(!clientId||!year)return;
  showLoading(true);
  try{
    const{getDocs,collection,query,where,doc,deleteDoc,addDoc}=fb();
    const db=fdb();
    // 기존 예산 삭제
    const snap=await getDocs(query(collection(db,COLS.BUDGETS),where('clientId','==',clientId),where('year','==',year)));
    for(const d of snap.docs)await deleteDoc(doc(db,COLS.BUDGETS,d.id));
    // 새 예산 저장
    const inputs=document.querySelectorAll('.budget-amt');
    for(const inp of inputs){
      const amount=Number(inp.value)||0;
      if(amount>0)await addDoc(collection(db,COLS.BUDGETS),{clientId,year,category:inp.dataset.cat,amount});
    }
    toast('예산이 저장되었습니다.','success');
  }catch(e){toast('저장 오류: '+e.message,'error');}
  showLoading(false);
}

async function executeFirebaseReset(){
  if(S.user?.role!=='관리자'){toast('관리자만 초기화할 수 있습니다.','error');return;}
  showConfirm('Firebase 전체 초기화','모든 거래/계좌/입주자/보고서 데이터를 삭제합니다. 정말로 진행하시겠습니까?',async()=>{
    const code=prompt('확인을 위해 "초기화"를 입력하세요:');
    if(code!=='초기화'){toast('취소되었습니다.','info');return;}
    showLoading(true);
    try{
      const{getDocs,collection,deleteDoc,doc}=fb();
      const db=fdb();
      const cols=[COLS.TRANSACTIONS,COLS.CLIENTS,COLS.ACCOUNTS,COLS.CATEGORIES,COLS.REPORTS,COLS.CONFIG,COLS.EXCEL_UPLOADS,'fixedItems'];
      for(const col of cols){
        const snap=await getDocs(collection(db,col));
        for(const d of snap.docs)await deleteDoc(doc(db,col,d.id));
      }
      await fetchBaseData();
      loadSettings();
      toast('초기화 완료. 모든 데이터가 삭제되었습니다.','success',5000);
    }catch(e){toast('초기화 오류: '+e.message,'error');}
    showLoading(false);
  },'초기화 실행');
}

// ─────────────────────────────────────────────
// 모바일 뷰
// ─────────────────────────────────────────────
let M={clientId:null,clients:[],transactions:[],accounts:[]};

function isMobile(){return window.innerWidth<=768&&('ontouchstart' in window||navigator.maxTouchPoints>0);}

function initMobileApp(){
  document.getElementById('app-view').style.display='none';
  const mv=document.getElementById('mobile-view');
  if(mv)mv.style.display='flex';
  // 입력자는 보고서 탭 숨김
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
  // 계좌 필터 갱신 및 월 필터 초기화
  const accSel=document.getElementById('m-acc-filter');
  if(accSel){
    accSel.innerHTML='<option value="">전체 계좌</option>';
    S.accounts.filter(a=>a.clientId===clientId).forEach(a=>accSel.add(new Option(a.label,a.id)));
  }
  const typeSel=document.getElementById('m-type-filter');
  if(typeSel)typeSel.value='';
  const monthSel=document.getElementById('m-month-filter');
  if(monthSel)monthSel.value='';
  // 거래 로드
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
  const monthFilter=document.getElementById('m-month-filter')?.value||''; // YYYY-MM
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
  // 영수증 업로드
  let receiptUrl='';
  const receiptFile=document.getElementById('mf-receipt')?.files[0];
  if(receiptFile){
    try{
      showLoading('영수증 업로드 중...');
      receiptUrl=await uploadToDrive(receiptFile);
    }catch(e){toast('영수증 업로드 실패: '+e.message,'error');}
    finally{hideLoading();}
  }
  const data={
    clientId:M.clientId,accountId,date,type,category,description,
    amountIn:type==='수입'?amount:0,amountOut:type==='지출'?amount:0,
    receiptUrl,createdBy:S.user?.userId||'',sortOrder:Date.now()
  };
  await saveTrx(data);
  // 거래목록 갱신
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

async function updateReport(reportId, fields){
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
  // 거래내역 로드
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
  // 분류별 지출
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
  // 결재 버튼 구성
  const role=S.user?.role||'';
  const userId=String(S.user?.userId||'');
  const rptClient=S.clients.find(c=>c.id===report.clientId);
  const tlId=String(rptClient?.teamLeader||'');
  const isMyClient=String(rptClient?.userIds||'').split(',').map(s=>s.trim()).includes(userId)||rptClient?.teamLeader===userId||false;
  const buttons=[];
  // 제출 버튼
  if(report.status==='draft'&&isMyClient){
    buttons.push({label:'📤 제출',color:'#3b82f6',action:async()=>{
      const comment=prompt('담당자 의견 (선택사항):','');
      await updateReport(report.id,{status:'submitted',submittedAt:Date.now(),submittedBy:userId,submittedByName:S.user.name||userId,staffComment:comment||report.staffComment||''});
      toast('제출되었습니다.','success');
      report.status='submitted';report.staffComment=comment||report.staffComment||'';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
  }
  // 반려된 보고서 재제출
  if(report.status==='rejected'&&isMyClient){
    buttons.push({label:'📤 재제출',color:'#3b82f6',action:async()=>{
      const comment=prompt('담당자 의견:','');
      await updateReport(report.id,{status:'submitted',submittedAt:Date.now(),submittedBy:userId,submittedByName:S.user.name||userId,staffComment:comment||report.staffComment||''});
      toast('재제출되었습니다.','success');
      report.status='submitted';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
  }
  // 팀장 결재
  if(report.status==='submitted'&&(role==='팀장'||role==='센터장'||role==='관리자')&&(role!=='팀장'||userId===tlId)){
    buttons.push({label:'✅ 팀장 결재',color:'#10b981',action:async()=>{
      const comment=prompt('팀장 의견 (선택사항):','');
      await updateReport(report.id,{status:'team_approved',teamApprovedAt:Date.now(),teamApprovedBy:userId,teamApprovedByName:S.user.name||userId,leaderComment:comment||report.leaderComment||''});
      toast('팀장 결재 완료','success');
      report.status='team_approved';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
    buttons.push({label:'↩ 반려',color:'#ef4444',action:async()=>{
      const comment=prompt('반려 사유:','');
      if(!comment)return;
      await updateReport(report.id,{status:'rejected',rejectedAt:Date.now(),rejectedBy:userId,rejectedByName:S.user.name||userId,leaderComment:comment});
      toast('반려되었습니다.','success');
      report.status='rejected';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
  }
  // 센터장 최종 결재
  if(report.status==='team_approved'&&(role==='센터장'||role==='관리자')){
    buttons.push({label:'✅ 최종 결재',color:'#10b981',action:async()=>{
      const comment=prompt('센터장 의견 (선택사항):','');
      await updateReport(report.id,{status:'confirmed',centerApprovedAt:Date.now(),centerApprovedBy:userId,centerApprovedByName:S.user.name||userId,centerComment:comment||report.centerComment||''});
      toast('최종 결재 완료','success');
      report.status='confirmed';
      renderMobileReportDetail(report);
      renderMobileReportList();
    }});
    buttons.push({label:'↩ 반려',color:'#ef4444',action:async()=>{
      const comment=prompt('반려 사유:','');
      if(!comment)return;
      await updateReport(report.id,{status:'rejected',rejectedAt:Date.now(),rejectedBy:userId,rejectedByName:S.user.name||userId,centerComment:comment});
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
// 이벤트 바인딩
// ─────────────────────────────────────────────
document.getElementById('btn-add-staff')?.addEventListener('click',()=>openModal('staff'));
document.getElementById('btn-add-client')?.addEventListener('click',()=>openModal('client'));
document.getElementById('btn-add-account')?.addEventListener('click',()=>openModal('account'));
document.getElementById('btn-add-exp-cat')?.addEventListener('click',()=>addCategory('지출',document.getElementById('settings-client-sel')?.value||''));
document.getElementById('btn-add-inc-cat')?.addEventListener('click',()=>addCategory('수입',document.getElementById('settings-client-sel')?.value||''));
document.getElementById('btn-add-rule')?.addEventListener('click',addRule);
document.getElementById('btn-reset-cats')?.addEventListener('click',resetCategories);
document.getElementById('btn-archive')?.addEventListener('click',confirmArchive);
document.getElementById('btn-archive-refresh')?.addEventListener('click',loadArchiveHistory);
document.getElementById('new-rule-type')?.addEventListener('change',updateRuleCatSel);
['new-exp-cat','new-inc-cat','new-rule-kw'].forEach(id=>{
  document.getElementById(id)?.addEventListener('keydown',e=>{
    if(e.key==='Enter'){
      if(id==='new-exp-cat')addCategory('지출',document.getElementById('settings-client-sel')?.value||'');
      else if(id==='new-inc-cat')addCategory('수입',document.getElementById('settings-client-sel')?.value||'');
      else addRule();
    }
  });
});
document.getElementById('btn-h-fixed')?.addEventListener('click',applyFixedItems);
document.getElementById('btn-h-receipt-print')?.addEventListener('click',printReceiptSheet);

// ─────────────────────────────────────────────
// 공통 유틸
// ─────────────────────────────────────────────
function showConfirm(title,msg,onOk,okLabel='확인',okStyle='btn'){
  setText('c-title',title); setText('c-msg',msg);
  const btn=document.getElementById('c-ok');
  btn.textContent=okLabel; btn.className=okStyle||'btn';
  btn.onclick=()=>{closeConfirm();onOk();};
  document.getElementById('confirm-dialog').classList.add('show');
}
function closeConfirm(){document.getElementById('confirm-dialog').classList.remove('show');}
function setText(id,val){const el=document.getElementById(id);if(el)el.textContent=val;}
function showLoading(on){const el=document.getElementById('loading');if(!el)return;if(on)el.classList.add('show');else el.classList.remove('show');}
function toast(msg,type='info',duration=3000){
  const c=document.getElementById('toast-wrap'); if(!c)return;
  const icons={success:'✅',error:'❌',info:'ℹ️'};
  const el=document.createElement('div'); el.className=`toast ${type}`;
  el.innerHTML=`<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(()=>{el.style.animation='toastOut .25s ease forwards';setTimeout(()=>el.remove(),260);},duration);
}