/**
 * services/excel-parser.js — Smart Care Ledger 은행 명세서 파서
 *
 * 왜 옮겼는가
 *   파서는 `app.js` 안에 290줄로 들어 있었고, 설정 파일(`parser-config.js`)은
 *   classic script라 모듈인 `app.js`에 도달하지 못했습니다. 실제로 쓰이던 설정은
 *   `app.js` 안의 복제본이었고 두 벌이 따로 놀았습니다. 파일 상단의
 *   "app.js는 건드릴 필요가 없습니다"는 사실이 아니었습니다.
 *
 *   여기로 옮기면서 설정을 한 벌로 만들고, 은행 판정도 설정에서 파생시켰습니다.
 *   예전에는 판정이 설정과 무관한 하드코딩 if/else 체인이라, 설정에 은행을
 *   추가해도 그 체인이 먼저 돌아 인식되지 않았습니다.
 *
 * 조용한 실패를 없앴다
 *   날짜 파싱 실패, 금액 파싱 실패, 빈 적요, 합계 행이 전부 말없이 `continue`됐고
 *   화면에는 성공 건수만 표시됐습니다. 절반이 사라져도 성공처럼 보였습니다.
 *   이제 `parseSheetRows`가 제외된 행과 그 이유를 함께 돌려줍니다.
 *
 * DOM·XLSX 의존은 함수 안에서만 참조하므로 Node에서 import해 테스트할 수 있습니다.
 */

'use strict';

import { BANK_CONFIGS, NOISE_WORDS, SMS_CONFIG } from '../parser-config.js';

export { BANK_CONFIGS, NOISE_WORDS, SMS_CONFIG };

/** 헤더 비교용 정규화 — 공백을 모두 없앤다 */
const squash = (v) => String(v ?? '').replace(/\s/g, '');

// ─────────────────────────────────────────────
// 금액
// ─────────────────────────────────────────────

/**
 * 부호 있는 금액. **파싱할 수 없으면 NaN**을 돌려준다(0이 아니다).
 *
 * 예전에는 실패해도 0이었고, 0은 "금액 없음"과 구별되지 않아
 * `if(!inVal&&!outVal) continue`로 행이 통째로 사라졌습니다.
 *
 * 인식하는 음수 표기
 *   -5,000 / 5,000- / (5,000) / △5,000 / ▲5,000   ← 국내 명세서에서 실제로 쓰인다
 */
export function toNumSigned(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;

  let s = String(v).trim();
  if (s === '') return 0;

  let negative = false;
  // 회계식 괄호 음수 — 이걸 놓쳐서 환불이 +로 들어갔다
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/^[-△▲]/.test(s))   { negative = true; s = s.replace(/^[-△▲]\s*/, ''); }
  if (/-$/.test(s))        { negative = true; s = s.replace(/-\s*$/, ''); }   // 후행 마이너스

  // 통화기호·천단위 쉼표·단위(원, KRW)를 떼고 숫자만 남긴다
  const digits = s.replace(/[₩$￦,\s]/g, '').replace(/원$/, '').replace(/KRW/gi, '');
  if (digits === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(digits)) return NaN;   // 남은 글자가 숫자가 아니면 실패

  const n = Number(digits);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
}

/** 절댓값 금액. 파싱 실패는 0 (SMS처럼 이미 숫자만 뽑아낸 값에 쓴다). */
export function toNum(v) {
  const n = toNumSigned(v);
  return Number.isNaN(n) ? 0 : Math.abs(n);
}

// ─────────────────────────────────────────────
// 날짜
// ─────────────────────────────────────────────

/**
 * 여러 표기를 YYYY-MM-DD로. 인식 못 하면 null.
 *
 * ⚠️ 마지막 `new Date(s)` 폴백은 **조용한 오답을 만든 자리**다. 국내 통장·명세서에
 * 흔한 6자리 `240119` 를 넣으면 `240119-01-01` (연도 24만년)이 나왔고, null 이
 * 아니라 값이므로 그대로 저장됐다. 6자리를 규칙으로 받고, 폴백에도 연도 상한을
 * 뒀다 — 못 읽는 것보다 틀리게 읽는 것이 나쁘다.
 */
export function fixDate(val) {
  if (val === undefined || val === null || val === '') return null;

  // 엑셀 날짜 일련번호 (CSV/xlsx에서 '2026-07-10'이 46213 같은 숫자가 된다)
  const serial = typeof val === 'number' ? val : Number(String(val).trim());
  if (Number.isFinite(serial) && serial >= 10000 && serial <= 100000) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    if (!isNaN(dt.getTime()) && dt.getUTCFullYear() >= 2000) {
      return dt.getUTCFullYear() + '-'
        + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-'
        + String(dt.getUTCDate()).padStart(2, '0');
    }
  }

  let s = String(val).replace(/[.\/]/g, '-').trim();
  if (s.includes(' ')) s = s.split(' ')[0];
  if (/^\d{8}$/.test(s)) s = s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  // 구분자 없는 6자리 YYMMDD — 통장·명세서에서 가장 흔한 꼴이다.
  // 20xx 로 읽는다(이 장부에 19xx 거래는 없다).
  else if (/^\d{6}$/.test(s)) s = '20' + s.slice(0, 2) + '-' + s.slice(2, 4) + '-' + s.slice(4, 6);

  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    // 2월 30일 같은 값을 걸러낸다
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const d = new Date(s);
  // 연도 상한이 없으면 `240119` 가 240119년으로 통과한다(실제로 그랬다).
  if (isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2100) return null;
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/** SMS의 readable_date ("2026. 7. 10. 오후 3:20") → YYYY-MM-DD */
export function fixReadableDate(val) {
  if (!val) return null;
  const parts = String(val).match(/(\d+)\.\s*(\d+)\.\s*(\d+)/);
  if (!parts) return null;
  const y = parts[1].padStart(4, '0');
  return Number(y) < 2000 ? null
    : `${y}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
}

// ─────────────────────────────────────────────
// 적요 정리
// ─────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '\\s\\-_/|,.()\\[\\]*#';

/**
 * 노이즈 단어 제거. **단어 경계가 있을 때만** 지운다.
 *
 * 예전에는 부분 문자열로 지워서 `승인마트` → `마트`,
 * `모바일세상` → `세상`으로 상호명이 훼손됐습니다. 원본을 저장하지 않으므로
 * 복구할 수 없었습니다. 지금은 앞뒤가 구분자이거나 문자열 끝일 때만 지웁니다.
 */
export function cleanDesc(desc, noiseWords = NOISE_WORDS) {
  let s = String(desc ?? '').trim();
  if (!s) return '';
  const original = s;
  for (const n of noiseWords) {
    if (!n || !s.includes(n)) continue;
    const re = new RegExp(`(^|[${SEP}])${escapeRe(n)}(?=$|[${SEP}])`, 'g');
    s = s.replace(re, '$1');
  }
  s = s.replace(/\s{2,}/g, ' ').replace(new RegExp(`^[${SEP}]+|[${SEP}]+$`, 'g'), '').trim();
  return s || original;   // 전부 지워지면 원본을 남긴다 (빈 적요로 행이 사라지지 않도록)
}

// ─────────────────────────────────────────────
// 은행 판정 — 설정에서 파생된다
// ─────────────────────────────────────────────

/**
 * 헤더 행 텍스트에서 은행을 판정한다.
 * MATCH가 있으면 그 조건(바깥 AND, 안쪽 OR), 없으면 DATE + (AMT|WITHDRAW).
 * @returns {string} 설정 키. 못 찾으면 ''
 */
export function detectConfig(headerText, configs = BANK_CONFIGS) {
  const rc = squash(headerText);
  if (!rc) return '';
  for (const [key, c] of Object.entries(configs)) {
    if (!c || !c.DATE) continue;
    if (Array.isArray(c.MATCH) && c.MATCH.length) {
      if (c.MATCH.every(group => group.some(kw => rc.includes(squash(kw))))) return key;
      continue;
    }
    const hasDate = rc.includes(squash(c.DATE));
    const amtKey = c.AMT || c.WITHDRAW || c.DEPOSIT;
    if (hasDate && amtKey && rc.includes(squash(amtKey))) return key;
  }
  return '';
}

/** 헤더 행에서 컬럼 위치를 찾는다 */
function locateColumns(headerRow, cfg) {
  const col = { date: -1, desc: -1, in: -1, out: -1, skip: -1 };
  headerRow.forEach((cell, idx) => {
    const val = squash(cell);
    if (!val) return;
    if (cfg.DATE     && col.date === -1 && val.includes(squash(cfg.DATE)))     col.date = idx;
    if (cfg.DESC     && col.desc === -1 && val.includes(squash(cfg.DESC)))     col.desc = idx;
    if (cfg.AMT      && col.out  === -1 && val.includes(squash(cfg.AMT)))      col.out  = idx;
    if (cfg.WITHDRAW && col.out  === -1 && val.includes(squash(cfg.WITHDRAW))) col.out  = idx;
    if (cfg.DEPOSIT  && col.in   === -1 && val.includes(squash(cfg.DEPOSIT)))  col.in   = idx;
    if (cfg.SKIP_IF  && col.skip === -1 && val.includes(squash(cfg.SKIP_IF)))  col.skip = idx;
  });
  // DESC를 못 찾으면 흔한 이름으로 한 번 더 (은행마다 표기가 조금씩 다르다)
  if (col.desc === -1) {
    headerRow.forEach((cell, idx) => {
      if (col.desc !== -1) return;
      const val = squash(cell);
      if (['가맹점', '적요', '기재내용', '내용', '보낸분'].some(k => val.includes(k))) col.desc = idx;
    });
  }
  return col;
}

const SUMMARY_WORDS = ['소계', '합계', '총계', '조회', '누계'];

/**
 * 시트 한 장(배열의 배열)을 거래 목록으로.
 *
 * @returns {{bank:string, rows:Array, skipped:Array<{row:number,reason:string,text:string}>}}
 *   skipped — 제외된 행과 이유. 화면에 그대로 보여주기 위한 것이다.
 *   예전에는 이 정보가 없어서 절반이 사라져도 사용자가 알 수 없었다.
 */
export function parseSheetRows(rows, categories = [], opts = {}) {
  const configs = opts.configs || BANK_CONFIGS;
  const noiseWords = opts.noiseWords || NOISE_WORDS;
  const out = { bank: '', rows: [], skipped: [] };
  if (!Array.isArray(rows) || !rows.length) return out;

  // 1) 헤더 찾기
  let bank = '', col = null, startRow = -1;
  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 2) continue;
    const detected = detectConfig(row.map(c => squash(c)).join('|'), configs);
    if (!detected) continue;
    const c = locateColumns(row, configs[detected]);
    if (c.date !== -1 && (c.out !== -1 || c.in !== -1)) {
      bank = detected; col = c; startRow = i + 1; break;
    }
  }
  if (startRow === -1) return out;
  out.bank = bank;

  // 2) 데이터 행
  const note = (i, reason, row) => {
    const text = (row || []).map(c => String(c ?? '').trim()).filter(Boolean).join(' | ').slice(0, 80);
    if (!text) return;   // 완전히 빈 행은 알릴 것이 없다
    out.skipped.push({ row: i + 1, reason, text });
  };

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 2) continue;
    if (row.every(c => String(c ?? '').trim() === '')) continue;

    // 취소된 승인 건 (NH_CARD_AP 등)
    if (col.skip !== -1 && String(row[col.skip] ?? '').trim() !== '') {
      note(i, '취소된 승인 건', row); continue;
    }

    const rawDesc = col.desc >= 0 ? String(row[col.desc] ?? '').trim() : '';
    if (SUMMARY_WORDS.some(k => rawDesc.includes(k))) { note(i, '요약 행(합계/소계)', row); continue; }

    const rawDate = col.date >= 0 ? row[col.date] : '';
    const date = fixDate(rawDate);
    if (!date) { note(i, '날짜를 인식할 수 없음', row); continue; }

    // 금액 — NaN은 "인식 실패", 0은 "값 없음". 둘을 구별해야 조용한 삭제가 사라진다.
    let amountIn = 0, amountOut = 0, bad = false;
    if (col.in >= 0) {
      const vIn = toNumSigned(col.in >= 0 ? row[col.in] : '');
      const vOut = col.out >= 0 ? toNumSigned(row[col.out]) : 0;
      if (Number.isNaN(vIn) || Number.isNaN(vOut)) bad = true;
      else {
        if (vIn  > 0) amountIn  = vIn;
        if (vIn  < 0) amountOut = Math.abs(vIn);
        if (vOut > 0) amountOut = vOut;
        if (vOut < 0) amountIn  = Math.abs(vOut);
      }
    } else if (col.out >= 0) {
      const vOut = toNumSigned(row[col.out]);
      if (Number.isNaN(vOut)) bad = true;
      else if (vOut >= 0) amountOut = vOut;
      else amountIn = Math.abs(vOut);
    }
    if (bad) { note(i, '금액을 인식할 수 없음', row); continue; }
    if (!amountIn && !amountOut) { note(i, '금액이 비어 있음', row); continue; }

    const desc = cleanDesc(rawDesc, noiseWords);
    if (!desc || desc === '0') { note(i, '거래 내용이 비어 있음', row); continue; }

    const matched = categories.find(c => c.keyword && desc.includes(c.keyword));
    out.rows.push({
      date, desc, descRaw: rawDesc,
      in: amountIn, out: amountOut,
      cat: matched ? matched.category : '확인필요',
      sub: matched ? (matched.subcategory || '') : '',
      bank, sheetRow: i + 1,
    });
  }
  return out;
}

// ─────────────────────────────────────────────
// 중복 판정
// ─────────────────────────────────────────────

/**
 * 거래 하나를 식별하는 키. 엑셀 업로드 중복 판정에 쓴다.
 *
 * 예전 키는 `날짜_|입금|_|출금|`이었고 네 가지가 동시에 잘못돼 있었다.
 *   - `accountId`가 없어 같은 입주자의 **다른 계좌** 동일 금액이 중복 처리됐다
 *   - `description`이 없어 같은 날 5,000원짜리 서로 다른 지출 중
 *     **두 번째가 삭제**됐다 (밥값과 간식값이 우연히 같으면 하나가 사라진다)
 *   - `Math.abs`라 환불(-5,000)이 원거래(5,000)의 중복으로 삭제됐다
 *   - 그리고 비교 대상이 화면 캐시(당월)뿐이라 **같은 파일을 두 번 올리면
 *     두 벌 들어갔다** — 키가 아무리 정확해도 대조할 데이터가 없었다
 */
export function transactionKey(t) {
  // 구분자로 이어붙이면 내용에 그 구분자가 들어갈 때 다른 거래와 같은 키가 될 수 있다.
  // JSON 배열은 그럴 여지가 없다.
  return JSON.stringify([
    t.date || '',
    t.accountId || '',
    String(t.description ?? '').trim(),
    Number(t.amountIn || 0),
    Number(t.amountOut || 0),
  ]);
}

// ─────────────────────────────────────────────
// CSV 인코딩
// ─────────────────────────────────────────────

/**
 * CSV 바이트를 문자열로. UTF-8 → 실패하면 EUC-KR(CP949).
 *
 * 예전 코드는 이랬습니다.
 *   try { text = new TextDecoder('utf-8').decode(raw); }
 *   catch(e) { text = new TextDecoder('euc-kr').decode(raw); }
 *
 * `TextDecoder`는 `{fatal:true}` 없이는 **예외를 던지지 않고** U+FFFD로 치환하므로
 * catch가 도달 불가능한 죽은 코드였습니다. 국내 은행 CSV 상당수가 EUC-KR인데
 * 사용자는 "인식된 거래 데이터가 없습니다"만 보고 인코딩 문제라는 힌트가 없었습니다.
 *
 * @returns {{text:string, encoding:string}}
 */
export function decodeCsvBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // UTF-8 BOM이면 확정
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8' };
  } catch {
    // UTF-8이 아니다 → 국내 CSV는 사실상 EUC-KR/CP949
    try {
      return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr' };
    } catch {
      // 그 환경이 euc-kr을 모르면 손실을 감수하고라도 읽어준다
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8(손실)' };
    }
  }
}

/** 파일 앞부분을 보고 HTML인지 판단 (HTML로 위장한 .xls) */
export function isHtmlBytes(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D) continue;
    return ch === 0x3C;   // '<'
  }
  return false;
}

// ─────────────────────────────────────────────
// SMS 백업 XML
// ─────────────────────────────────────────────

/** SMS 본문 한 건 → 거래 하나. 조건에 맞지 않으면 null. */
export function parseSmsBody(body, readableDate, categories = [], cfg = SMS_CONFIG) {
  if (!body || !body.includes(cfg.APPROVAL_KEYWORD)) return null;
  if (cfg.SKIP_KEYWORDS.some(kw => body.includes(kw))) return null;

  const lines = body.replace(/\r/g, '').split('\n').map(l => l.trim())
    .filter(l => l && l !== '[Web발신]');
  const desc = lines[lines.length - 1] || '';
  if (!desc) return null;

  const amtLine = lines.find(l => /\d+[,\d]*원/.test(l));
  const amtMatch = amtLine && amtLine.match(/([\d,]+)원/);
  if (!amtMatch) return null;
  const outVal = toNum(amtMatch[1]);
  if (!outVal) return null;

  const date = fixReadableDate(readableDate);
  if (!date) return null;

  const cleaned = cleanDesc(desc);
  if (!cleaned) return null;
  const matched = categories.find(c => c.keyword && cleaned.includes(c.keyword));
  return {
    date, desc: cleaned, descRaw: desc, in: 0, out: outVal,
    cat: matched ? matched.category : '확인필요',
    sub: matched ? (matched.subcategory || '') : '',
    bank: 'SMS',
  };
}

// ─────────────────────────────────────────────
// 브라우저 진입점 (DOM·XLSX 사용)
// ─────────────────────────────────────────────

const merge = (a, b) => ({
  bank: a.bank || b.bank,
  rows: a.rows.concat(b.rows),
  skipped: a.skipped.concat(b.skipped),
});

/** XLSX 워크북 → 시트별 배열의 배열. 파서와 「열 고르기」가 같은 것을 본다. */
export function workbookSheets(workbook) {
  const XLSX = globalThis.XLSX;
  return workbook.SheetNames
    .map(name => ({ name, rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }) }))
    .filter(s => s.rows.length);
}

/** XLSX 워크북 전체 */
export function parseWorkbook(workbook, categories, opts = {}) {
  let acc = { bank: '', rows: [], skipped: [] };
  for (const sheet of workbookSheets(workbook)) {
    acc = merge(acc, parseSheetRows(sheet.rows, categories, opts));
  }
  return acc;
}

/** SMS 백업 XML */
export function parseSmsXml(xmlText, categories) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const out = { bank: 'SMS', rows: [], skipped: [] };
  Array.from(doc.querySelectorAll('sms')).forEach((sms, i) => {
    const body = sms.getAttribute('body') || '';
    const row = parseSmsBody(body, sms.getAttribute('readable_date') || '', categories);
    if (row) out.rows.push(row);
    else if (body.includes(SMS_CONFIG.APPROVAL_KEYWORD)
             && !SMS_CONFIG.SKIP_KEYWORDS.some(kw => body.includes(kw))) {
      // 승인 문자인데 못 읽은 것만 알린다 (일반 문자까지 알리면 소음이 된다)
      out.skipped.push({ row: i + 1, reason: '승인 문자를 해석할 수 없음', text: body.slice(0, 80) });
    }
  });
  return out;
}

/**
 * HTML로 위장한 .xls.
 * 표를 배열의 배열로 바꿔 시트와 똑같이 처리한다 — 예전에는 KB 전용 하드코딩이라
 * 다른 은행 파일은 0건이 나왔다.
 */
export function htmlXlsSheets(htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  return Array.from(doc.querySelectorAll('table'))
    .map((table, i) => ({
      name: `표 ${i + 1}`,
      rows: Array.from(table.querySelectorAll('tr'))
        .map(tr => Array.from(tr.querySelectorAll('td,th')).map(td => td.textContent.trim())),
    }))
    .filter(s => s.rows.length >= 2);
}

export function parseHtmlXls(htmlText, categories, opts = {}) {
  let acc = { bank: '', rows: [], skipped: [] };
  for (const sheet of htmlXlsSheets(htmlText)) acc = merge(acc, parseSheetRows(sheet.rows, categories, opts));
  return acc;
}

/** 파일 바이트를 읽는다. 파싱과 「열 고르기」가 같은 길로 들어오게 하는 자리다. */
function readBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('파일을 읽는 중 오류가 발생했습니다.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 업로드된 파일 하나를 **시트 목록**으로. 파싱하지 않는다.
 *
 * 「이 파일로 은행 추가」가 쓰는 길이다. 인식에 실패한 파일에서도 열을
 * 보여 줘야 하는데, 인식 결과에는 남은 것이 없다(헤더를 못 찾았으니까).
 *
 * @returns {Promise<{sheets:Array<{name:string,rows:Array}>, encoding?:string}>}
 */
export async function readFileSheets(file) {
  const raw = await readBytes(file);
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.xml')) return { sheets: [] };   // SMS 백업은 표가 아니다
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const { text, encoding } = decodeCsvBytes(raw);
    return { sheets: workbookSheets(globalThis.XLSX.read(text, { type: 'string' })), encoding };
  }
  if (isHtmlBytes(new Uint8Array(raw, 0, Math.min(10, raw.byteLength)))) {
    return { sheets: htmlXlsSheets(decodeCsvBytes(raw).text) };
  }
  return { sheets: workbookSheets(globalThis.XLSX.read(raw, { type: 'array' })) };
}

/**
 * 업로드된 파일 하나를 파싱한다.
 *
 * @param {Object} [opts]  opts.configs — 내장 + 저장된 은행 설정
 *   (domain/bank-parser.js 의 mergedBankConfigs). 넘기지 않으면 내장만 쓴다.
 * @returns {Promise<{bank:string, rows:Array, skipped:Array, encoding?:string}>}
 */
export async function parseFile(file, categories, opts = {}) {
  const raw = await readBytes(file);
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.xml')) return parseSmsXml(decodeCsvBytes(raw).text, categories);
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const { text, encoding } = decodeCsvBytes(raw);
    const wb = globalThis.XLSX.read(text, { type: 'string' });
    return { ...parseWorkbook(wb, categories, opts), encoding };
  }
  if (isHtmlBytes(new Uint8Array(raw, 0, Math.min(10, raw.byteLength)))) {
    return parseHtmlXls(decodeCsvBytes(raw).text, categories, opts);
  }
  return parseWorkbook(globalThis.XLSX.read(raw, { type: 'array' }), categories, opts);
}
