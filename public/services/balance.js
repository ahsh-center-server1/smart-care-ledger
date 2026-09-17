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

import { countsInTotals } from '../domain/trx-totals.js';

/**
 * 기준일 이후 거래만 합산한 계좌 잔액.
 *
 * 기준일(initialBalanceDate) 경계
 *   initialBalance는 "기준일 시점의 잔액"이므로 그날 거래는 이미 반영되어 있다.
 *   따라서 date > baseDate 인 거래만 더한다. (기준일 당일을 포함하면 이중 계상)
 *
 * 거래 유형은 보지 않는다
 *   **모든 거래가 잔액에 들어간다.** 예전에는 취소를 건너뛰었는데(카드 승인이
 *   취소되면 돈이 안 나갔다는 뜻으로), 실제로는 이미 빠져나간 돈이 돌아오는
 *   경우가 더 흔했다. 그때는 통장 잔액과 장부가 그 금액만큼 어긋났다.
 *   음수 amountOut(환불)은 부호 그대로 반영되어 잔액이 늘어난다.
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
    bal += Number(t.amountIn || 0) - Number(t.amountOut || 0);
  }
  return bal;
}

/**
 * 잔액에 영향을 주는 거래 필드 목록.
 * calcAccountBalance가 실제로 읽는 필드와 정확히 일치해야 한다 —
 * 여기에 빠진 필드가 잔액식에 쓰이면 갱신이 누락된다.
 */
// type 은 없다 — 잔액식이 더 이상 유형을 보지 않는다(모든 거래가 들어간다).
// 남겨 두면 분류만 고쳐도 계좌 전체 재계산이 돌아 읽기가 낭비된다.
export const BALANCE_FIELDS = ['accountId', 'date', 'amountIn', 'amountOut'];

/**
 * 거래 문서의 변경이 계좌 잔액을 바꿀 수 있는가.
 *
 * 왜 필요한가
 *   거래 쓰기마다 계좌 전체 거래를 다시 읽어 합산하면(서버 트리거) 읽기가 폭증한다.
 *   그런데 실제로 가장 흔한 쓰기는 **잔액과 무관하다** — 영수증 첨부(receiptUrl),
 *   카테고리 인라인 수정, 드래그 순서 변경(sortOrder), 내용 수정. 이런 변경에까지
 *   전체 스캔을 돌리면 엑셀 100행 업로드가 수만 건 읽기가 된다.
 *
 *   잔액식이 읽는 필드가 하나도 안 바뀌었다면 잔액은 바뀔 수 없다. 그때는
 *   계좌 문서조차 읽지 않고 즉시 중단할 수 있다(읽기 0).
 *
 * @param {Object|null} before 변경 전 거래 (생성이면 null)
 * @param {Object|null} after  변경 후 거래 (삭제면 null)
 * @returns {boolean} true면 잔액 재계산이 필요할 수 있다
 */
export function affectsBalance(before, after) {
  if (!before || !after) return true;          // 생성·삭제는 항상 영향
  // 금액은 잔액식과 똑같이 Number로, 나머지는 문자열로 비교한다.
  // 엑셀 파서가 '50000'(문자열)을, 수기 입력이 50000(숫자)을 넣으므로
  // 문자열 비교만 하면 값이 같은데도 재계산이 돌고,
  // 0과 undefined도 잔액식에서는 같은 값(0)이다.
  return (
    Number(before.amountIn  || 0) !== Number(after.amountIn  || 0) ||
    Number(before.amountOut || 0) !== Number(after.amountOut || 0) ||
    String(before.accountId || '') !== String(after.accountId || '') ||
    String(before.date      || '') !== String(after.date      || '')
  );
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
 * 수입/지출 집계. 「합계 제외」로 표시된 거래는 빠진다
 * (계좌 간 이동은 수입도 지출도 아니다 — domain/trx-totals.js).
 * @returns {{totalIn:number, totalOut:number}}
 */
export function sumIncomeExpense(transactions) {
  let totalIn = 0, totalOut = 0;
  for (const t of (transactions || [])) {
    if (!countsInTotals(t)) continue;
    totalIn  += Number(t.amountIn  || 0);
    totalOut += Number(t.amountOut || 0);
  }
  return { totalIn, totalOut };
}
