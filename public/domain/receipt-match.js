// public/domain/receipt-match.js
//
// 영수증 ↔ 기존 거래 매칭 — 순수 함수. **모델이 아니라 코드가 판정한다.**
//
// 왜 모델에게 맡기지 않는가
//   "이 영수증이 어느 거래의 증빙인가"는 금액과 날짜의 문제다. 모델에게
//   물으면 그럴듯한 답을 주지만 근거를 확인할 수 없고, 같은 입력에 다른 답이
//   나올 수 있다. 잘못 붙은 증빙은 **다른 사람의 지출에 남의 영수증이 달리는**
//   결과가 되고, 결재 서류가 되는 자료에서 그것은 용납되지 않는다.
//
//   그래서 규칙은 여기 있고, 근거(reasons)를 함께 돌려준다. 화면은 그 근거를
//   사람에게 보여준다.
//
// 자동 첨부 기준
//   strong 후보가 **정확히 하나**일 때만 자동으로 붙인다.
//   그 외에는 상위 후보를 제시해 사람이 한 번 누르게 한다.
//   애매한 것을 조용히 붙이는 것보다, 한 번 더 묻는 것이 싸다.

'use strict';

import { merchantTokens } from './receipt.js';

/** 날짜가 며칠까지 벌어져도 같은 거래로 볼지. 카드 승인일과 영수증 날짜가 어긋난다. */
export const DATE_TOLERANCE_DAYS = 3;

/** 이 점수 이상이면 strong. */
const STRONG_SCORE = 100;

/** 'YYYY-MM-DD' 두 개의 날짜 차이(일). 해석 실패면 null. */
export function dayDiff(a, b) {
  const ta = Date.parse(String(a || '') + 'T00:00:00Z');
  const tb = Date.parse(String(b || '') + 'T00:00:00Z');
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 86400000);
}

/** 거래가 영수증을 받을 수 있는 상태인가. */
function eligible(trx, draft) {
  // 이미 증빙이 붙어 있으면 후보가 아니다 — 덮어쓰면 원래 증빙이 사라진다.
  if (trx.receiptUrl) return false;
  // 취소 거래에는 영수증을 붙이지 않는다(잔액에도 무관하다).
  if (trx.type === '취소') return false;
  // 환불 영수증(음수)은 수입/환불 거래에, 일반 영수증은 지출에 붙는다.
  if (draft.isCancellation) return true;
  return true;
}

/** 거래의 "영수증에 찍힐 금액". 지출은 amountOut, 환불·수입은 amountIn. */
function trxAmount(trx) {
  const out = Number(trx.amountOut || 0);
  const inn = Number(trx.amountIn || 0);
  return out !== 0 ? Math.abs(out) : Math.abs(inn);
}

/**
 * 후보 하나를 점수화한다.
 * @returns {{score:number, reasons:string[]}}
 */
function scoreOne(draft, trx, noiseWords) {
  const reasons = [];
  let score = 0;

  const amountMatches = draft.amount != null
    && trxAmount(trx) === Math.abs(draft.amount);
  const diff = dayDiff(draft.date, trx.date);

  // ── 금액 ──
  // 금액이 다르면 후보가 아니다. 이것이 가장 강한 근거이고, 어긋나면 다른 거래다.
  if (!amountMatches) return { score: 0, reasons: [] };
  score += 60;
  reasons.push(`금액 일치 (${Math.abs(draft.amount).toLocaleString('ko-KR')}원)`);

  // ── 날짜 ──
  if (diff === null) {
    // 영수증 날짜를 못 읽었다 — 금액만으로는 weak이다.
    reasons.push('날짜 확인 불가');
  } else if (diff === 0) {
    score += 40;
    reasons.push('같은 날짜');
  } else if (diff <= DATE_TOLERANCE_DAYS) {
    score += 25;
    reasons.push(`날짜 ${diff}일 차이`);
  } else {
    // 금액은 같지만 날짜가 멀다 — 매달 같은 금액이 나가는 고정지출에서
    // 흔하다. 후보로 남기되 자동 첨부는 하지 않는다.
    reasons.push(`날짜 ${diff}일 차이 (먼 날짜)`);
  }

  // ── 상호명 ──
  // 영수증 상호명과 거래 내용이 겹치면 확신이 는다.
  const rTokens = merchantTokens(draft.merchant, noiseWords);
  const tTokens = merchantTokens(trx.description, noiseWords);
  if (rTokens.length && tTokens.length) {
    const overlap = rTokens.filter(t => tTokens.some(u => u.includes(t) || t.includes(u)));
    if (overlap.length) {
      score += 30;
      reasons.push(`상호명 일치 (${overlap.slice(0, 2).join(', ')})`);
    }
  }

  // ── 계좌 ──
  // 업로드할 때 계좌를 골랐으면 그 계좌의 거래를 우선한다.
  if (draft.accountId && trx.accountId === draft.accountId) {
    score += 10;
    reasons.push('선택한 계좌');
  }

  return { score, reasons };
}

/**
 * 영수증 초안에 맞는 거래를 찾는다.
 *
 * @param {Object} draft  toReceiptDraft() 결과 (+ 선택적으로 accountId)
 * @param {Array}  transactions 후보 거래 목록 (같은 입주자의 것만 넘길 것)
 * @param {Object} [opts]
 * @param {string[]} [opts.noiseWords] 상호명 정규화에서 뺄 단어
 * @param {number}   [opts.limit=3] 돌려줄 후보 수
 * @returns {{decision:'auto'|'choose'|'none', matches:Array, autoMatch:Object|null}}
 *   decision
 *     'auto'   — strong 후보가 정확히 하나. 자동으로 붙여도 된다.
 *     'choose' — 후보가 여럿이거나 확신이 낮다. 사람이 고른다.
 *     'none'   — 붙일 거래가 없다. 새 거래로 만든다.
 */
export function matchReceipt(draft, transactions, opts = {}) {
  const noiseWords = opts.noiseWords || [];
  const limit = opts.limit || 3;

  if (!draft || draft.amount == null) {
    return { decision: 'none', matches: [], autoMatch: null };
  }

  const scored = [];
  for (const trx of (transactions || [])) {
    if (!eligible(trx, draft)) continue;
    const { score, reasons } = scoreOne(draft, trx, noiseWords);
    if (score <= 0) continue;
    scored.push({ trx, score, reasons, strong: score >= STRONG_SCORE });
  }

  // 점수 높은 순. 같으면 날짜가 가까운 순.
  scored.sort((a, b) => b.score - a.score
    || (dayDiff(draft.date, a.trx.date) ?? 999) - (dayDiff(draft.date, b.trx.date) ?? 999));

  const strong = scored.filter(m => m.strong);
  const matches = scored.slice(0, limit);

  // strong이 정확히 하나일 때만 자동. 둘 이상이면 어느 것인지 알 수 없다
  // (같은 날 같은 금액 거래가 두 건 있는 경우 — 실제로 생긴다).
  if (strong.length === 1) {
    return { decision: 'auto', matches, autoMatch: strong[0] };
  }
  if (matches.length) {
    return { decision: 'choose', matches, autoMatch: null };
  }
  return { decision: 'none', matches: [], autoMatch: null };
}

/**
 * 추출된 상호명에 자동분류 규칙을 적용해 카테고리를 고른다.
 *
 * **모델에게 분류를 맡기지 않는다.** 사용자가 이미 관리하는 규칙
 * (categories 컬렉션의 keyword 항목)을 그대로 쓴다 — 그래야 자기 시설의
 * 분류 기준이 반영되고, 규칙을 고치면 즉시 반영된다.
 *
 * @param {string} merchant  추출된 상호명
 * @param {Array}  rules     keyword가 있는 categories 문서들
 * @param {string} [clientId] 입주자 전용 규칙을 우선하기 위해
 * @returns {{category:string, subcategory:string, matchedKeyword:string}|null}
 */
export function classifyMerchant(merchant, rules, clientId) {
  const hay = String(merchant || '');
  if (!hay.trim()) return null;

  const candidates = (rules || []).filter(r => r && r.keyword);
  // 입주자 전용 규칙이 공통 규칙을 이긴다(설정 화면의 동작과 같다).
  const ordered = [
    ...candidates.filter(r => clientId && r.clientId === clientId),
    ...candidates.filter(r => !r.clientId),
  ];

  for (const r of ordered) {
    if (hay.includes(r.keyword)) {
      return {
        category: r.category || '',
        subcategory: r.subcategory || '',
        matchedKeyword: r.keyword,
      };
    }
  }
  return null;
}
