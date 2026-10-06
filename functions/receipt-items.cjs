'use strict';

/**
 * 영수증 세부품목 — 저장할 수 있는 모양으로 깎는다. 순수 모듈.
 *
 * 왜 품목을 남기나
 *   결재 문서의 「지출이 늘었다」는 문장은 결재자가 표를 보면 이미 아는 말이다.
 *   무엇이 늘었는지를 말하려면 분류(식비·의료비)보다 한 칸 아래가 필요한데,
 *   그 칸이 품목이다. 영수증 판독은 이미 품목을 읽고 있었고(receipt-extract.js
 *   의 `items`) 그냥 버리고 있었다.
 *
 * 왜 여기서 깎아야 하나 — **품목명은 OCR 이 읽은 자유 텍스트다**
 *   영수증에는 품목만 인쇄돼 있지 않다. 상호명이 줄마다 반복되고, 주소·전화·
 *   사업자번호·카드번호 끝자리가 같은 표 안에 섞여 나온다. 모델이 그중 하나를
 *   품목으로 잘못 집으면 **저장되고, 나중에 AI 분석으로 실려 나간다.**
 *   저장 시점이 상호명을 아는 유일한 순간이므로(판독 결과에 함께 온다)
 *   여기서 걸러야 한다. 뒤에서는 무엇이 상호명이었는지 알 수 없다.
 *
 * 무엇을 떨어뜨리나
 *   · 숫자 네 자리 이상이 붙어 있는 것 — 카드·전화·사업자번호·우편번호
 *   · 상호명을 담고 있는 것 (그 영수증의 상호명을 알고 있을 때)
 *   · 너무 긴 것 — 주소 한 줄이 통째로 들어온 경우다
 *   · 금액이 읽히지 않는 것 — 집계에 못 쓰고, 이름만 남기면 그게 유출 통로다
 *
 * 남는 위험은 **정직하게 말해 둔다**: 품목명 자체가 상호명보다 더 드러낼 수
 * 있다(약품명이 그렇다). 이 경계는 "지어낸 것을 막는 것"이지 "품목은 안전하다"는
 * 주장이 아니다. 그래서 보고서 분석은 품목을 **집계해서** 보내고(무엇을 몇
 * 번·얼마), 어느 날 어느 가게에서 샀는지는 끝까지 보내지 않는다.
 */

/** 한 거래에 남길 품목 수. 장바구니 영수증도 상위 몇 줄이면 뜻이 통한다. */
const MAX_ITEMS = 12;

/**
 * 품목명 길이 상한.
 *
 * 실제 품목명은 짧다(「서울우유 1L」 9자, 「타이레놀정500mg」 12자). 반대로
 * 영수증 머리에 인쇄된 주소는 대개 이보다 길다. 길이 하나로 주소를 상당수
 * 걸러 낼 수 있고, 걸러 내지 못한 짧은 주소는 아래 `ADDRESSY` 가 받는다.
 */
const MAX_NAME = 16;

/** 네 자리 이상 숫자 — 카드 끝자리·전화·사업자번호·우편번호. */
const DIGIT_RUN = /\d{4,}/;

/**
 * 주소로 읽히는 꼴. 길이만으로는 짧은 주소(「은평구 통일로 12」)를 놓친다.
 *   · 「특별시」·「광역시」 — 품목명에 들어갈 일이 없다
 *   · 숫자 뒤의 「층·호·번지」 — 건물 안 위치
 * 지명 낱말(동·로·길) 자체는 보지 않는다 — 「동원참치」·「길동이네」가 함께
 * 지워진다. 못 거르는 쪽이 멀쩡한 품목을 지우는 쪽보다 낫다.
 */
const ADDRESSY = /(특별시|광역시)|(?:^|\s)[가-힣0-9]+(?:시|군|구)\s+[가-힣0-9]+(?:대로|로|길)\s*\d+|(?:^|\s)[가-힣]+(?:대로|로|길)\s*\d+|\d+\s*(층|호|번지)(\s|$)/;

/** 금액에서 숫자만 남긴다. `₩12,000` · `12,000원` 모두 같은 값이 된다. */
function toAmount(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^\d-]/g, '');
  if (!digits) return 0;
  const n = Number(digits);
  return Number.isFinite(n) ? Math.abs(Math.trunc(n)) : 0;
}

/** 이름을 한 줄로 펴고 양끝을 자른다. 줄바꿈이 들어오면 표가 깨진다. */
function tidy(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

/** 비교할 때 공백·문장부호 차이를 없앤다. */
function compact(raw) {
  return tidy(raw).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 복합 상호명의 각 낱말. 한 글자는 정상 품목을 과도하게 지우므로 제외한다. */
function merchantTokens(raw) {
  return tidy(raw).toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map(compact)
    .filter(token => token.length >= 2);
}

/**
 * 판독 결과의 품목 목록을 저장할 모양으로 깎는다.
 *
 * @param {Array} items       [{name, amount}] — 모델이 읽은 그대로
 * @param {Object} [opts]
 * @param {string} [opts.merchant]  그 영수증의 상호명. 이름에 들어 있으면 버린다
 * @returns {Array<{name:string, amount:number}>}
 */
function sanitizeReceiptItems(items, opts = {}) {
  const merchant = tidy(opts.merchant).toLowerCase();
  const merchantCompact = compact(merchant);
  const merchantParts = merchantTokens(merchant);
  const out = [];

  for (const raw of (Array.isArray(items) ? items : [])) {
    if (out.length >= MAX_ITEMS) break;
    const name = tidy(raw && raw.name);
    const amount = toAmount(raw && raw.amount);

    if (!name || !amount) continue;              // 이름만 남기면 그게 유출 통로다
    if (name.length > MAX_NAME) continue;        // 주소 한 줄
    if (ADDRESSY.test(name)) continue;           // 짧은 주소
    if (DIGIT_RUN.test(name)) continue;          // 카드·전화·사업자번호
    // 상호명이 품목 칸에 복사돼 오는 일이 흔하다. 두 글자 이상일 때만 본다 —
    // 한 글자 상호는 아무 품목에나 들어 있어 전부 지워 버린다.
    const nameCompact = compact(name);
    const matchesMerchant = merchantCompact.length >= 2 && nameCompact.length >= 2
      && (nameCompact.includes(merchantCompact)
        || merchantCompact.includes(nameCompact)
        || merchantParts.some(token => nameCompact.includes(token) || token.includes(nameCompact)));
    if (matchesMerchant) continue;

    out.push({ name, amount });
  }
  return out;
}

module.exports = {
  MAX_ITEMS,
  MAX_NAME,
  ADDRESSY,
  compact,
  merchantTokens,
  sanitizeReceiptItems,
  toAmount,
};
