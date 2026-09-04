/**
 * services/balance.js — Smart Care Ledger
 * 계좌 잔액 계산 — **이 파일이 유일한 정답이다.**
 *
 * 배경
 *   이전에는 잔액 계산식이 4벌이었고 서로 다른 값을 냈다:
 *     - transactions.js updateAccBalance : 기초잔액 + '현재 로드된 범위'(기본 당월) → Firestore에 저장
 *     - report.js                        : 기초잔액 + 기준일~보고월말 전체 (정확)
 *     - dashboard.js                     : 저장된 currentBalance (= 위에서 손상된 값)
 *     - app.js 모바일                     : currentBalance || initialBalance
 *   그 결과 거래를 하나만 저장해도 currentBalance가 '기초잔액 + 당월'로 덮어써졌다.
 *
 * 규칙
 *   1. 잔액을 계산하려면 **해당 계좌의 전체 거래**를 넘겨야 한다.
 *      부분 로드된 S.transactions를 그대로 넘기면 안 된다.
 *   2. currentBalance는 표시용 캐시일 뿐, 판단 근거로 삼지 않는다.
 */

'use strict';

/**
 * 기준일 이후 거래만 합산한 계좌 잔액.
 *
 * 기준일(initialBalanceDate) 경계
 *   initialBalance는 "기준일 시점의 잔액"이므로 그날 거래는 이미 반영되어 있다.
 *   따라서 date > baseDate 인 거래만 더한다. (기준일 당일을 포함하면 이중 계상)
 *
 * 거래 유형
 *   수입·지출·자산이동 → 잔액에 반영
 *   취소               → 카드 승인취소이므로 잔액에 영향 없음
 *   음수 amountOut     → 환불. 부호 그대로 반영되어 잔액이 늘어난다.
 *
 * @param {Object} account      accounts 문서 ({id, initialBalance, initialBalanceDate})
 * @param {Array}  transactions 해당 계좌를 포함한 거래 목록 (다른 계좌가 섞여 있어도 됨)
 * @returns {number}
 */
export function calcAccountBalance(account, transactions) {
  if (!account) return 0;
  const base = account.initialBalanceDate || '';
  const accId = account.id;
  let bal = Number(account.initialBalance || 0);

  for (const t of (transactions || [])) {
    if (t.accountId !== accId) continue;
    if (base && (t.date || '') <= base) continue;   // 기준일 당일까지는 기초잔액에 포함됨
    if (t.type === '취소') continue;                 // 승인취소는 잔액 무관
    bal += Number(t.amountIn || 0) - Number(t.amountOut || 0);
  }
  return bal;
}

/**
 * 특정 시점까지의 잔액 (보고서 계좌 현황용).
 * @param {string} endDate 'YYYY-MM-DD' — 이 날짜까지 포함
 */
export function calcAccountBalanceAsOf(account, transactions, endDate) {
  if (!endDate) return calcAccountBalance(account, transactions);
  const upTo = (transactions || []).filter(t => (t.date || '') <= endDate);
  return calcAccountBalance(account, upTo);
}

/**
 * 여러 계좌의 잔액을 한 번에 계산한다.
 * @returns {Object} { [accountId]: balance }
 */
export function calcBalances(accounts, transactions) {
  const out = {};
  for (const a of (accounts || [])) out[a.id] = calcAccountBalance(a, transactions);
  return out;
}

/**
 * 수입/지출 집계. 자산이동과 취소는 제외한다(계좌 간 이동은 수입도 지출도 아니다).
 * @returns {{totalIn:number, totalOut:number}}
 */
export function sumIncomeExpense(transactions) {
  let totalIn = 0, totalOut = 0;
  for (const t of (transactions || [])) {
    if (t.type === '수입')      totalIn  += Number(t.amountIn  || 0);
    else if (t.type === '지출') totalOut += Number(t.amountOut || 0);
    // 자산이동 · 취소 → 집계 제외
  }
  return { totalIn, totalOut };
}
