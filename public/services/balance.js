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
export function buildMonthEndBalances(account, transactions) {
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
export function monthEndBalanceOf(account, ym) {
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
