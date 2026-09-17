// public/domain/trx-range.js
//
// 거래내역이 **어느 기간을 들고 있는가** — 순수 함수. DOM·Firestore를 모른다.
//
// 왜 한 곳에 모으나
//   같은 계산이 세 군데에 손으로 적혀 있었다: loadTransactions 가 당월 경계를
//   만들고, needsBroaderRange 가 그것을 다시 만들어 비교하고, 저장 경로는
//   아예 비교하지 않고 월 전체를 다시 읽었다. 경계가 갈라지면 "화면에 있는데
//   필터가 못 찾는" 거래가 생긴다.
//
// 월초에 기본 범위가 틀려 있던 것
//   기본이 **당월**이었다. 그런데 이 장부의 일은 월초에 몰린다 — 1~10일에
//   지난달을 정리해서 보고서를 올린다. 그래서 담당자는 거래내역을 열자마자
//   기간을 지난달로 바꿨고, 그때마다 **조회가 한 번 통째로 버려졌다.**
//   월초에는 처음부터 지난달을 포함해 읽는다.

'use strict';

/** 월초 며칠까지를 「지난달 정리 기간」으로 보는가. */
export const CLOSING_DAYS = 10;

const pad = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD' (로컬 기준 — 장부의 날짜는 사용자의 달력이다) */
export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 그 달의 첫날·마지막날. monthsBack=1 이면 지난달. */
export function monthBounds(now = new Date(), monthsBack = 0) {
  const y = now.getFullYear(), m = now.getMonth() - monthsBack;
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  return { start: isoDate(first), end: isoDate(last) };
}

/**
 * 로그인·입주자 전환 직후 무엇을 읽을 것인가.
 *
 * 월초(1~CLOSING_DAYS일)에는 **지난달 1일부터** 당월 말까지 한 번에 읽는다.
 * 읽는 문서 수는 어차피 같다 — 사용자가 곧바로 기간을 넓힐 것이기 때문이다.
 * 다른 것은 **조회 횟수**다: 한 번이면 되는 것을 두 번 하고 있었다.
 */
export function defaultTrxRange(now = new Date()) {
  const cur = monthBounds(now);
  if (now.getDate() > CLOSING_DAYS) return cur;
  return { start: monthBounds(now, 1).start, end: cur.end };
}

/**
 * range 를 {start,end} 로 편다.
 * 'all' 은 경계가 없으므로 null — 호출부가 "전부"로 읽는다.
 */
export function rangeBounds(range, now = new Date()) {
  if (range === 'all') return null;
  if (range && typeof range === 'object' && range.start && range.end) {
    return { start: String(range.start), end: String(range.end) };
  }
  // 'month' 또는 미지정 — 예전 기본값. 저장된 세션이 이 값을 들고 있을 수 있다.
  return monthBounds(now);
}

/**
 * 이 날짜의 거래가 지금 로드된 범위 안에 있는가.
 *
 * 저장 직후 화면에 끼워 넣어도 되는지를 이것으로 판단한다. 범위 밖인데
 * 끼워 넣으면 필터가 숨기지 못하는 유령 행이 남고, 범위 안인데 안 넣으면
 * 방금 저장한 것이 보이지 않아 사용자가 한 번 더 저장한다.
 */
export function inLoadedRange(date, range, now = new Date()) {
  const b = rangeBounds(range, now);
  if (!b) return true;                       // 'all' — 전부 들고 있다
  const d = String(date || '');
  return !!d && d >= b.start && d <= b.end;
}

/**
 * 사용자가 고른 필터 기간이 로드된 범위를 벗어나는가.
 * 벗어나면 더 넓게 다시 읽어야 한다.
 */
export function needsBroaderRange(filterStart, filterEnd, cachedRange, now = new Date()) {
  if (!filterStart && !filterEnd) return false;
  const b = rangeBounds(cachedRange, now);
  if (!b) return false;                      // 'all' — 더 넓힐 것이 없다
  if (filterStart && String(filterStart) < b.start) return true;
  if (filterEnd && String(filterEnd) > b.end) return true;
  return false;
}
