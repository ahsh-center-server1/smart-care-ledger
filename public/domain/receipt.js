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
 * 지원 형태 (한국 영수증·통장에서 실제로 나오는 것들)
 *   2026-09-07 / 2026.09.07 / 2026/09/07 / 20260907
 *   26.09.07 / 26-09-07
 *   **260907** (구분자 없는 6자리)  ← 국내 통장 인쇄가 이 꼴이다
 *   2026년 9월 7일 / 9월 7일
 *   09/07 · 09.07        (연도 없음)
 *   2026-09-07 14:32:11  (시각이 뒤에 붙은 경우)
 *   **240119체크 · 240119타CD** (뒤에 적요가 붙어 인쇄된 경우)
 *
 * 뒤의 둘이 실제 고장이었다. 통장 사진을 올리면 「날짜를 읽을 수 없음」으로 전부
 * 제외됐는데, 사진도 판독도 멀쩡했고 **여기서 못 읽었다.** 6자리는 규칙에 아예
 * 없었고, 통장은 거래일자 칸과 거래내용 칸이 붙어 인쇄돼서 `240119체크` 가 통째로
 * 넘어온다 — 뒤에 글자가 붙어 있다고 날짜가 없는 것은 아니다.
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
  // 앞머리의 날짜 꼴만 떼어 낸다 — 통장은 `240119체크` 처럼 적요가 붙어 나온다.
  const head = dateHead(datePart);

  // 1) 구분자 있는 3부분: 2026-09-07 / 26.9.7 / 2026/09/07
  let m = head.match(/^(\d{2,4})[.\-/](\d{1,2})[.\-/](\d{1,2})\.?$/);
  if (m) return assemble(expandYear(m[1]), m[2], m[3]);

  // 2) 구분자 없는 8자리: 20260907
  m = head.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return assemble(m[1], m[2], m[3]);

  // 2-1) 구분자 없는 6자리: 260907 (YYMMDD) — 국내 통장 인쇄
  //   `202609` 같은 YYYYMM 이 잘못 들어와도 달이 26이 되어 assemble 이 거른다.
  //   시각(`143022`)도 같은 이유로 걸린다 — 지어내는 것보다 빈 값이 낫다.
  m = head.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m) return assemble(expandYear(m[1]), m[2], m[3]);

  // 3) 한글: 2026년 9월 7일 / 9월 7일
  m = s.match(/(?:(\d{2,4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m) {
    if (m[1]) return assemble(expandYear(m[1]), m[2], m[3]);
    return withInferredYear(m[2], m[3], today);
  }

  // 4) 연도 없는 2부분: 09/07 · 09.07 · 9-7
  m = head.match(/^(\d{1,2})[.\-/](\d{1,2})\.?$/);
  if (m) return withInferredYear(m[1], m[2], today);

  return '';
}

/**
 * 문자열 앞머리의 「숫자와 날짜 구분자」만. 뒤에 붙은 글자는 버린다.
 *
 * 통장은 거래일자 칸과 거래내용 칸이 붙어 인쇄돼서 `240119체크` · `240119타CD` 가
 * 통째로 넘어온다. 예전에는 이런 줄이 전부 「날짜를 읽을 수 없음」이 됐다.
 */
function dateHead(value) {
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^\d+(?:[.\-/]\d+)*\.?/);
  return m ? m[0] : s;
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
 * 인쇄된 문자열에 **연도가 적혀 있나.** 있으면 그 연도(네 자리), 없으면 null.
 *
 * 통장 사진에는 `09-05` 처럼 연도 없는 줄이 흔한데, 같은 장의 다른 줄에는
 * `2026-09-05` 가 있는 경우가 많다. 그때는 오늘 날짜로 추측하는 것보다
 * **같은 사진의 이웃 줄**이 훨씬 나은 근거다 — bankbookRowsToParsed 참고.
 */
export function explicitYearOf(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  // 연도를 읽는 규칙은 날짜를 읽는 규칙과 **같아야 한다.** 갈라지면 「날짜는
  // 읽히는데 연도 기준에는 안 세어지는 줄」이 생겨 기준이 조용히 틀어진다.
  const head = dateHead(s.split(/[T\s]/)[0] || s);
  let m = head.match(/^(\d{2,4})[.\-/](\d{1,2})[.\-/](\d{1,2})\.?$/);
  if (m) { const y = expandYear(m[1]); return Number.isFinite(y) ? y : null; }
  m = head.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return Number(m[1]);
  m = head.match(/^(\d{2})(\d{2})(\d{2})$/);
  // 달·일이 말이 되는 6자리만 연도로 센다(시각 `143022` 를 2014년으로 읽지 않는다).
  if (m && assemble(expandYear(m[1]), m[2], m[3])) return expandYear(m[1]);
  m = s.match(/(\d{2,4})\s*년\s*\d{1,2}\s*월/);
  if (m) { const y = expandYear(m[1]); return Number.isFinite(y) ? y : null; }
  return null;
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
 * 통장의 **금액 칸 하나**를 「앞의 숫자」와 「나머지 글자」로 가른다.
 *
 * 왜 필요한가 — 은행마다 칸을 다르게 쓴다
 *   어떤 통장은 금액 칸에 **상호를 같이 찍는다.** 신한은행이 그렇다:
 *
 *     거래일 | 내용   | 찾으신금액          | 맡기신금액 | 잔액
 *     260201 | 신한체 | 2,400 GS25 뉴은평신 |           | 25,069
 *     260820 | 신한체 | 165,600             | 풀무원식품 | 5,663,741
 *     260102 | 유동CC | 김어진              | *400,000  | 434,329
 *
 *   내용 칸에는 **채널**(`신한체`·`현금IC`·`유동CC`)만 있고 상호는 금액 칸에,
 *   때로는 **반대쪽** 금액 칸에 있다.
 *
 * 그래서 무엇이 깨졌나
 *   `normalizeAmount` 는 숫자가 아닌 글자를 전부 지우고 남은 숫자를 이어 붙인다.
 *   `2,400 GS25 뉴은평신` → **240025원**. 상호에 숫자가 든 가맹점(GS25·이마트24·
 *   CGV)마다 금액이 조용히 백 배가 됐다. 거부가 아니라 값이라 미리보기에도
 *   그럴듯하게 찍힌다.
 *
 * 규칙: **금액은 칸의 맨 앞에만 있다.** 뒤에 붙은 것은 글자다.
 *   숫자로 시작하지 않으면 금액이 아니라 적요다(`김어진` · `현금IC캐시백`).
 *
 * @returns {{amount:number|null, text:string, raw:string, pure:boolean}}
 *   pure — 숫자만 있던 칸. 붙은 글자가 없으니 더 믿을 만하다(아래 tie-break).
 */
export function splitMoneyCell(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { amount: null, text: '', raw: '', pure: false };

  // 앞의 통화기호·별표를 건너뛰고, 맨 앞의 금액 토큰만 본다.
  const m = raw.match(/^[*₩￦\s]*(-?\d[\d,]*)(?![\d,])/);
  if (!m) return { amount: null, text: raw, raw, pure: false };

  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return { amount: null, text: raw, raw, pure: false };

  const text = raw.slice(m[0].length).trim();
  return { amount: n, text, raw, pure: text === '' };
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

  // 연도가 안 적힌 줄의 기준 — **같은 사진의 다른 줄**에서 빌린다.
  //
  // 예전에는 오늘의 연도를 쓰고, 그것이 미래가 되면 작년으로 봤다. 그래서
  // 작년 통장을 올리면 `09-05` 가 조용히 올해 9월 5일이 됐다(과거라 되돌리는
  // 규칙에도 안 걸린다). 통장 한 장에는 대개 연도가 적힌 줄이 섞여 있고,
  // 그 줄이 오늘보다 훨씬 나은 근거다.
  const anchor = anchorYearOf(src);
  const asOf = anchor == null ? today : new Date(anchor, 11, 31);

  // 잔액 사슬. **건너뛸 줄도 함께 센다** — 계좌번호 줄처럼 날짜가 없는 줄에도
  // 잔액이 찍혀 있고, 그것이 첫 거래의 기준이다.
  const balances = src.map(r => splitMoneyCell(r && r.balance).amount);

  const rows = [];
  const skipped = [];

  for (let i = 0; i < src.length; i++) {
    const r = src[i] || {};
    const raw = [r.dateRaw, r.description, r.withdraw, r.deposit]
      .filter(Boolean).join(' | ');

    const date = normalizeReceiptDate(r.dateRaw, asOf);
    if (!date) { skipped.push({ reason: '날짜를 읽을 수 없음', raw }); continue; }

    // **바로 앞 줄**의 잔액만 쓴다. 중간에 못 읽은 줄이 있으면 차이가 두 거래를
    // 합친 값이 되어, 맞히려다 더 크게 틀린다.
    const prev = i > 0 ? balances[i - 1] : null;
    const delta = (balances[i] != null && prev != null) ? balances[i] - prev : null;

    const { out, inn, merchant } = readMoneyCells(r, delta);
    // 출금도 입금도 못 읽었으면 금액 없는 줄이다 — 거래로 만들 수 없다.
    if ((out == null || out === 0) && (inn == null || inn === 0)) {
      skipped.push({ reason: '금액을 읽을 수 없음', raw });
      continue;
    }

    // 내용 칸이 늘 적요인 것은 아니다. 신한은행 통장은 여기에 **채널**
    // (`신한체`·`현금IC`·`유동CC`)만 찍고 상호는 금액 칸에 넣는다.
    // 그래서 보이는 내용은 상호를 쓰고, 채널은 원문에 남긴다 —
    // 결제수단 판정(domain/payment-method.js)이 그 원문에서 「신한체」를 읽어
    // 「카드」를 붙인다. 둘을 합쳐 버리면 상호가 채널에 묻힌다.
    const channel = String(r.description || '').trim();
    const desc = merchant || channel;
    rows.push({
      date,
      desc,
      descRaw: [channel, merchant].filter(Boolean).join(' ').trim() || desc,
      in: inn == null ? 0 : inn,
      out: out == null ? 0 : out,
    });
  }

  return { rows, skipped };
}

/**
 * 한 줄의 출금·입금 칸에서 **금액과 적요를 가른다.**
 *
 * 은행 줄은 출금과 입금이 동시에 차지 않는다. 그런데 통장은 빈 금액 칸에
 * 상호를 찍기도 해서(`신한체 | 165,600 | 풀무원식품`), 양쪽에서 숫자가
 * 읽히는 일이 생긴다 — `081.(사)한국자` 같은 적요는 앞이 숫자다.
 * 그때 어느 쪽이 진짜 금액인지 가른다.
 *
 *   ① 잔액이 말해 준다 — 앞 줄과의 차이가 음수면 출금, 양수면 입금.
 *   ② 잔액을 모르면 **숫자만 있던 칸**을 택한다. 글자가 붙은 칸은 적요일
 *      가능성이 그만큼 높다.
 *   ③ 가를 근거가 없으면 둘 다 둔다 — 지어내지 않는다. 미리보기에서 사람이 본다.
 *
 * 잔액 차이로 금액을 **덮어쓰지는 않는다.** 잔액도 모델이 읽은 숫자라
 * 똑같이 틀릴 수 있고, 맞는 금액을 틀린 잔액으로 고치면 되돌릴 근거가 없다.
 * 여기서 잔액이 하는 일은 **가르는 것**과 **빈 칸을 채우는 것**까지다.
 */
function readMoneyCells(r, delta) {
  const w = splitMoneyCell(r.withdraw);
  const d = splitMoneyCell(r.deposit);

  let useOut = w.amount != null;
  let useIn = d.amount != null;
  if (useOut && useIn) {
    if (delta != null && delta !== 0) { useOut = delta < 0; useIn = !useOut; }
    else if (w.pure !== d.pure) { useOut = w.pure; useIn = !useOut; }
  }

  // 금액으로 쓰지 않은 칸은 **통째로** 적요다(`081.(사)한국자` 의 `081.` 도
  // 이름의 일부다). 금액으로 쓴 칸은 숫자 뒤에 붙은 글자만 적요다.
  const merchant = [
    useOut ? w.text : w.raw,
    useIn ? d.text : d.raw,
  ].map(t => String(t || '').trim()).filter(Boolean).join(' ').trim();

  return {
    out: useOut ? w.amount : null,
    inn: useIn ? d.amount : null,
    merchant,
  };
}

/** 가장 많이 나온 연도. 연도가 적힌 줄이 하나도 없으면 null. */
function anchorYearOf(src) {
  const count = new Map();
  for (const r of src || []) {
    const y = explicitYearOf(r && r.dateRaw);
    if (y) count.set(y, (count.get(y) || 0) + 1);
  }
  let best = null, most = 0;
  for (const [y, n] of count) if (n > most) { most = n; best = y; }
  return best;
}
