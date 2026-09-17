'use strict';

/**
 * 잔액 계산 — 서버(Cloud Functions)용 CommonJS 구현.
 *
 * ⚠️ `public/services/balance.js`(브라우저용 ESM)와 **동일한 계산**이어야 한다.
 *    test/balance.test.mjs가 모든 픽스처를 양쪽에 통과시켜 값이 같은지 검증하므로,
 *    한쪽만 고치면 테스트가 실패한다. 반드시 둘을 함께 수정할 것.
 *
 * 파일이 두 벌인 이유: 브라우저는 public/ 아래 ESM만 불러올 수 있고,
 * Cloud Functions 배포 번들에는 functions/ 밖의 파일이 포함되지 않는다.
 */

/** 기준일 이후 거래만 합산한 계좌 잔액. */
function calcAccountBalance(account, transactions) {
  if (!account) return 0;
  const base = account.initialBalanceDate || '';
  const accId = account.id;
  let bal = Number(account.initialBalance || 0);

  for (const t of (transactions || [])) {
    if (t.accountId !== accId) continue;
    if (base && (t.date || '') <= base) continue;   // 기준일 당일까지는 기초잔액에 포함됨
    bal += Number(t.amountIn || 0) - Number(t.amountOut || 0);
  }
  return bal;
}

/**
 * 잔액에 영향을 주는 거래 필드 목록.
 * calcAccountBalance가 실제로 읽는 필드와 정확히 일치해야 한다.
 */
const BALANCE_FIELDS = ['accountId', 'date', 'amountIn', 'amountOut'];

/**
 * 거래 문서의 변경이 계좌 잔액을 바꿀 수 있는가.
 *
 * 왜 필요한가
 *   syncAccountBalance 트리거는 거래 쓰기마다 계좌 전체 거래를 다시 읽어 합산한다.
 *   그런데 실제로 가장 흔한 쓰기는 **잔액과 무관하다** — 영수증 첨부(receiptUrl),
 *   카테고리 인라인 수정, 드래그 순서 변경(sortOrder), 내용 수정.
 *   이런 변경까지 전체 스캔을 돌리면 엑셀 100행 업로드가 수만 건 읽기가 된다.
 *
 *   잔액식이 읽는 필드가 하나도 안 바뀌었으면 잔액은 바뀔 수 없다.
 *   그때는 계좌 문서조차 읽지 않고 즉시 중단한다(읽기 0).
 *
 *   전체 재계산 방식은 유지한다 — 트리거는 at-least-once로 중복 발동할 수 있어
 *   FieldValue.increment 같은 증분 갱신은 중복 시 금액이 어긋난다. 전체 합산은 멱등하다.
 */
function affectsBalance(before, after) {
  if (!before || !after) return true;          // 생성·삭제는 항상 영향
  return (
    Number(before.amountIn  || 0) !== Number(after.amountIn  || 0) ||
    Number(before.amountOut || 0) !== Number(after.amountOut || 0) ||
    String(before.accountId || '') !== String(after.accountId || '') ||
    String(before.date      || '') !== String(after.date      || '')
  );
}

/**
 * 계좌의 **월말 잔액 색인** — { 'YYYY-MM': 잔액 }.
 *
 * 왜 필요한가
 *   보고서 「계좌 현황」은 전월 말 잔액과 당월 말 잔액을 보여준다. 그런데
 *   잔액은 기준일부터 누적이라, 그 두 숫자를 구하려고 **그 입주자의 전체
 *   이력을 읽고 있었다.** 보고서를 한 번 열 때마다, 그리고 해가 갈수록 더.
 *
 *   월말 잔액은 거래가 바뀔 때만 바뀌고, 그때 서버 트리거가 어차피 그 계좌의
 *   거래를 전부 읽어 currentBalance 를 다시 만든다(ledger-triggers.js). 그
 *   자리에서 이 색인을 함께 만들면 **추가 읽기가 없다.** 색인은 accounts
 *   문서에 실려 로그인할 때 이미 오므로, 보고서는 그 달 거래만 읽으면 된다.
 *
 * 채우는 범위
 *   기준일(없으면 첫 거래)의 달부터 **마지막 거래의 달까지 빠짐없이** 적는다.
 *   거래가 없는 달도 앞 달의 잔액으로 채운다 — 빈칸이 "거래가 없었다"인지
 *   "계산하지 않았다"인지 구분되지 않으면 폴백 판정을 할 수 없다.
 *
 * @param {Object} account      accounts 문서
 * @param {Array}  transactions 그 계좌를 포함한 거래 목록 (다른 계좌가 섞여 있어도 됨)
 * @returns {Object} { 'YYYY-MM': number }
 */
function buildMonthEndBalances(account, transactions) {
  if (!account) return {};
  const accId = account.id;
  const base = account.initialBalanceDate || '';
  const rows = (transactions || [])
    .filter(t => t && t.accountId === accId && String(t.date || '')
      && (!base || String(t.date) > base))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // 시작 달: 기준일의 달. 기준일이 없으면 첫 거래의 달.
  let cur = String(base || (rows[0] && rows[0].date) || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(cur)) return {};   // 기준일도 거래도 없다 — 적을 것이 없다

  const out = {};
  let bal = Number(account.initialBalance || 0);
  for (const t of rows) {
    const ym = String(t.date).slice(0, 7);
    // 거래가 없는 달도 앞 달의 잔액으로 채운다.
    while (cur < ym) { out[cur] = bal; cur = nextMonth(cur); }
    bal += Number(t.amountIn || 0) - Number(t.amountOut || 0);
  }
  out[cur] = bal;
  return out;
}

/** 'YYYY-MM' 다음 달. */
function nextMonth(ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * 색인에서 그 달의 말잔을 읽는다. **모르면 null** — 호출부가 직접 계산으로 떨어진다.
 *
 * null 을 0으로 바꾸지 않는 것이 요점이다. 색인이 없는 계좌(백필 전)나
 * 깨진 색인에서 0을 돌려주면 보고서에 **잔액 0원이 그대로 인쇄된다.**
 * 모른다고 말해야 호출부가 예전 방식으로 계산할 수 있다.
 */
function monthEndBalanceOf(account, ym) {
  if (!account || !/^\d{4}-\d{2}$/.test(String(ym || ''))) return null;
  const idx = account.monthEndBalances;
  if (!idx || typeof idx !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(idx, ym)) return Number(idx[ym]) || 0;

  const keys = Object.keys(idx).filter(k => /^\d{4}-\d{2}$/.test(k)).sort();
  if (!keys.length) return null;
  // 색인보다 앞선 달 — 기준일 전이므로 기초잔액 그대로.
  if (ym < keys[0]) return Number(account.initialBalance || 0);
  // 색인보다 뒤 — 그 뒤로 거래가 없으니 마지막 값이 그대로 이어진다.
  if (ym > keys[keys.length - 1]) return Number(idx[keys[keys.length - 1]]) || 0;
  // 중간에 구멍 — 색인이 깨졌다. 모른다고 답한다.
  return null;
}

module.exports = {
  calcAccountBalance, affectsBalance, BALANCE_FIELDS,
  buildMonthEndBalances, monthEndBalanceOf,
};
