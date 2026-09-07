// public/domain/receipt.js
//
// 영수증에서 추출한 값의 정규화 — 순수 함수. DOM·네트워크를 모른다.
//
// 왜 모델에게 맡기지 않는가
//   모델은 **인쇄된 그대로** 읽어서 돌려주고, 「그것이 몇 년 몇 월 며칠인가」는
//   코드가 정한다. 이유는 셋이다:
//
//   1. 영수증에는 연도가 없는 경우가 흔하다("09/07", "9월 7일"). 어느 해인지는
//      **오늘 날짜와 업로드 맥락**이 정하는 문제이고, 모델이 추측하면 1년 틀린
//      거래가 조용히 들어간다.
//   2. 날짜 계산은 결정적이어야 재현되고 테스트할 수 있다. 같은 사진을 두 번
//      올렸을 때 다른 날짜가 나오면 장부로 쓸 수 없다.
//   3. 금액도 같다. "12,000원", "₩12000", "12 000" 은 모두 12000이어야 한다.
//
//   그래서 이 파일에 규칙을 몰아넣고, 모델의 출력은 문자열로만 받는다.

'use strict';

/** 두 자리 연도를 네 자리로. 20xx로 본다(영수증에 19xx는 없다). */
function expandYear(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return NaN;
  if (String(y).length <= 2) return 2000 + n;
  return n;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** YYYY-MM-DD 로 조립. 달·일 범위를 검사한다. */
function assemble(y, m, d) {
  const yy = Number(y), mm = Number(m), dd = Number(d);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return '';
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  // 실제로 존재하는 날짜인지 확인한다 (2월 30일 같은 오독을 걸러낸다).
  const probe = new Date(Date.UTC(yy, mm - 1, dd));
  if (probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) return '';
  return `${yy}-${pad2(mm)}-${pad2(dd)}`;
}

/**
 * 영수증에 인쇄된 날짜 문자열을 YYYY-MM-DD로 정규화한다.
 *
 * 지원 형태 (한국 영수증에서 실제로 나오는 것들)
 *   2026-09-07 / 2026.09.07 / 2026/09/07 / 20260907
 *   26.09.07 / 26-09-07
 *   2026년 9월 7일 / 9월 7일
 *   09/07 · 09.07        (연도 없음)
 *   2026-09-07 14:32:11  (시각이 뒤에 붙은 경우)
 *
 * 연도가 없으면 `today`의 연도를 쓴다. 다만 그 결과가 **미래**가 되면
 * 작년으로 본다 — 12월 영수증을 1월에 올리는 일이 흔하고, 미래 날짜 거래는
 * 잔액 계산과 마감을 어긋나게 한다.
 *
 * @param {string} raw   모델이 읽어 온 문자열 (인쇄된 그대로)
 * @param {Date}   [today]
 * @returns {string} 'YYYY-MM-DD' 또는 '' (해석 실패)
 */
export function normalizeReceiptDate(raw, today = new Date()) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';

  // 시각 부분을 떼어낸다 (' 14:32', 'T14:32' 등)
  const datePart = s.split(/[T\s]/)[0] || s;

  // 1) 구분자 있는 3부분: 2026-09-07 / 26.9.7 / 2026/09/07
  let m = datePart.match(/^(\d{2,4})[.\-/](\d{1,2})[.\-/](\d{1,2})\.?$/);
  if (m) return assemble(expandYear(m[1]), m[2], m[3]);

  // 2) 구분자 없는 8자리: 20260907
  m = datePart.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return assemble(m[1], m[2], m[3]);

  // 3) 한글: 2026년 9월 7일 / 9월 7일
  m = s.match(/(?:(\d{2,4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m) {
    if (m[1]) return assemble(expandYear(m[1]), m[2], m[3]);
    return withInferredYear(m[2], m[3], today);
  }

  // 4) 연도 없는 2부분: 09/07 · 09.07 · 9-7
  m = datePart.match(/^(\d{1,2})[.\-/](\d{1,2})\.?$/);
  if (m) return withInferredYear(m[1], m[2], today);

  return '';
}

/**
 * 연도가 없는 날짜에 연도를 채운다.
 * 올해로 두면 미래가 되는 경우 작년으로 본다.
 */
function withInferredYear(month, day, today) {
  const thisYear = today.getFullYear();
  const candidate = assemble(thisYear, month, day);
  if (!candidate) return '';
  const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  if (candidate <= todayStr) return candidate;
  // 미래 → 작년 영수증으로 본다 (12월 영수증을 1월에 올리는 경우)
  return assemble(thisYear - 1, month, day);
}

/**
 * 금액 문자열을 숫자로. 실패하면 null(0과 구분해야 한다).
 *
 * "12,000원" "₩12,000" "12 000" "-5,000" "12,000 원" → 12000 / -5000
 * 소수점은 버린다 — 원화에 소수점은 없고, OCR이 점을 잘못 읽은 경우가 많다.
 */
export function normalizeAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  const s = String(raw == null ? '' : raw);
  if (!s.trim()) return null;

  const negative = /^\s*-/.test(s) || /환불|취소/.test(s);
  // 숫자와 구분 기호만 남긴다
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * 상호명을 비교용으로 정규화한다.
 *
 * 영수증의 상호명과 카드 명세서의 가맹점명은 표기가 다르다:
 *   영수증 "(주)이마트 성수점"  ↔  명세서 "이마트성수"
 * 그래서 괄호·법인 표기·공백·기호를 걷어내고 비교한다.
 *
 * @param {string} raw
 * @param {string[]} [noiseWords] 제거할 단어 (parser-config.js의 PARSER_NOISE_WORDS)
 */
export function normalizeMerchant(raw, noiseWords = []) {
  let s = String(raw == null ? '' : raw);
  // 법인 표기
  s = s.replace(/\(\s*주\s*\)|\(\s*유\s*\)|주식회사|㈜/g, ' ');
  // 괄호와 그 안의 지점명은 남긴다(성수점 → 성수) — 지점이 매칭에 도움이 된다
  s = s.replace(/[()[\]{}]/g, ' ');
  for (const w of noiseWords) {
    if (w) s = s.split(w).join(' ');
  }
  // 기호 제거, 공백 정리
  s = s.replace(/[^0-9A-Za-z가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * 비교용 토큰. 한 글자 토큰은 버린다 — "점", "김" 같은 조각이 우연히
 * 겹쳐 잘못된 매칭을 만든다.
 */
export function merchantTokens(raw, noiseWords = []) {
  const norm = normalizeMerchant(raw, noiseWords);
  if (!norm) return [];
  return [...new Set(
    norm.split(' ')
      .map(t => t.trim())
      .filter(t => t.length >= 2),
  )];
}

/**
 * 모델이 돌려준 초안을 앱이 쓰는 형태로 바꾼다.
 *
 * **모델의 출력을 그대로 신뢰하지 않는다.** 날짜·금액은 여기서 정규화하고,
 * 해석할 수 없으면 빈 값으로 둔다 — 틀린 값을 채워 두면 사람이 검토할 때
 * 그럴듯해서 그냥 넘어간다. 빈 칸은 눈에 띈다.
 *
 * @param {Object} extracted analyzeReceipt가 돌려준 객체
 * @param {Object} [opts]
 * @param {Date}   [opts.today]
 * @returns {{date:string, merchant:string, amount:number|null,
 *            isCancellation:boolean, confidence:number, items:Array}}
 */
export function toReceiptDraft(extracted, opts = {}) {
  const e = extracted || {};
  const today = opts.today || new Date();

  const amount = normalizeAmount(e.totalAmount);
  const conf = Number(e.confidence);

  return {
    date: normalizeReceiptDate(e.dateRaw, today),
    merchant: String(e.merchant || '').trim(),
    amount,
    isCancellation: e.isCancellation === true,
    // 신뢰도는 0~1로 가둔다. 값이 없으면 0으로 본다(낮은 쪽으로 안전하게).
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
    items: Array.isArray(e.items) ? e.items.slice(0, 30) : [],
    cardLast4: /^\d{4}$/.test(String(e.cardLast4 || '')) ? String(e.cardLast4) : '',
  };
}

/**
 * 통장 사진에서 읽은 줄들을 **엑셀 파서의 행 형태로** 바꾼다.
 *
 * 왜 이 형태인가
 *   통장 사진과 은행 엑셀 파일은 같은 것을 담고 있다. 그래서 사진 전용 저장
 *   경로를 새로 만들지 않고, 이미 검증된 엑셀 경로
 *   (중복검사 → 미리보기 → 배치 저장)에 그대로 투입한다.
 *   저장 로직이 두 벌이 되면 반드시 갈라진다 — 실제로 이 앱의 모바일 포크가
 *   그렇게 갈라져 있었다.
 *
 * 읽을 수 없는 줄은 버리지 않고 `skipped`에 이유와 함께 담는다.
 * 조용히 사라지면 사용자는 몇 줄이 누락됐는지 알 수 없다.
 *
 * @param {Object} extracted analyzeBankbook 결과 { rows: [...] }
 * @param {Object} [opts]
 * @param {Date}   [opts.today]
 * @returns {{rows:Array, skipped:Array}}
 *   rows: [{date, desc, descRaw, in, out}] — ExcelParser.parseFile와 같은 형태
 */
export function bankbookRowsToParsed(extracted, opts = {}) {
  const today = opts.today || new Date();
  const src = (extracted && Array.isArray(extracted.rows)) ? extracted.rows : [];

  const rows = [];
  const skipped = [];

  for (const r of src) {
    const raw = [r && r.dateRaw, r && r.description, r && r.withdraw, r && r.deposit]
      .filter(Boolean).join(' | ');

    const date = normalizeReceiptDate(r && r.dateRaw, today);
    if (!date) { skipped.push({ reason: '날짜를 읽을 수 없음', raw }); continue; }

    const out = normalizeAmount(r && r.withdraw);
    const inn = normalizeAmount(r && r.deposit);
    // 출금도 입금도 못 읽었으면 금액 없는 줄이다 — 거래로 만들 수 없다.
    if ((out == null || out === 0) && (inn == null || inn === 0)) {
      skipped.push({ reason: '금액을 읽을 수 없음', raw });
      continue;
    }

    const desc = String((r && r.description) || '').trim();
    rows.push({
      date,
      desc,
      descRaw: desc,
      in: inn == null ? 0 : inn,
      out: out == null ? 0 : out,
    });
  }

  return { rows, skipped };
}
