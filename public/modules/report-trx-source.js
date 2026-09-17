// public/modules/report-trx-source.js
//
// 보고서가 거래를 **어디까지** 읽는가.
//
// 예전에는 언제나 그 입주자의 **전체 이력**이었다. 계좌 현황의 전월 말 잔액이
// 기준일부터의 누적이라 다 더해야 했기 때문이다. 그래서 보고서를 한 번 열 때마다
// 몇 년치를 읽었고, 그 비용은 **해가 갈수록 커졌다** — 쓰지도 않는데.
//
// 그 두 숫자(전월 말·당월 말 잔액)를 이제 계좌 문서의 월말 색인이 들고 있다
// (services/balance.js buildMonthEndBalances). 서버 트리거가 잔액을 다시 만들 때
// 같은 거래 목록에서 함께 적으므로 추가 읽기가 없고, 색인은 로그인할 때 계좌와
// 함께 이미 온다. 남은 것은 보여줄 달과 비교할 달뿐이다.
//
// 색인이 없거나(백필 전) 구멍이 있으면 전체를 읽는 예전 길로 떨어진다 —
// 읽기를 아끼려다 결재 문서에 틀린 잔액이 찍히면 안 된다.

'use strict';

import { S } from '../state.js';
import { COLS } from '../constants.js';
import { fb, fdb } from '../services/firestore.js';

/** 보고서가 읽는 창: 전월 1일 ~ 당월 말. 전월은 「전월 대비」 문장에 쓴다. */
export function reportWindow(year, month) {
  const cur = `${year}-${String(month).padStart(2, '0')}`;
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
  return { from: prev, to: cur };
}

/** 캐시가 요청한 창을 덮는가. from 이 null 이면 전체를 들고 있다는 뜻. */
function cacheCovers(cache, win) {
  if (!cache || !Array.isArray(cache.rows)) return false;
  if (cache.from == null) return true;
  if (!win) return false;                      // 전체가 필요한데 창만 갖고 있다
  return cache.from <= win.from && cache.to >= win.to;
}

/**
 * 보고서용 거래를 읽는다.
 *
 * @param {Object|null} win {from,to} 'YYYY-MM' — null 이면 전체 이력(폴백)
 *
 * 창이 있으면 그 두 달만 읽는다. 예전에는 **언제나 전체 이력**이었다 —
 * 계좌 현황의 전월 말 잔액이 기준일부터의 누적이라 다 더해야 했기 때문이다.
 * 그 숫자를 이제 계좌 문서의 월말 색인이 들고 있으므로(services/balance.js),
 * 읽을 것은 보여줄 달과 비교할 달뿐이다. 이력이 쌓여도 늘지 않는다.
 */
export async function getClientTrx(clientId, win) {
  // 거래내역 탭이 마침 같은 입주자의 전체 이력을 갖고 있으면 그대로 쓴다(읽기 절약)
  if (S.activeClient === clientId
      && S.trxRange === 'all'
      && Array.isArray(S.transactions)
      && S.transactions.length) {
    return S.transactions;
  }
  const cache = S.rptTrxCache;
  if (cache && cache.clientId === clientId && cacheCovers(cache, win)) return cache.rows;

  const { getDocs, collection, query, where } = fb();
  const scope = [where('clientId', '==', clientId)];
  const q = win
    ? query(collection(fdb(), COLS.TRANSACTIONS), ...scope,
            where('date', '>=', `${win.from}-01`), where('date', '<=', `${win.to}-31`))
    : query(collection(fdb(), COLS.TRANSACTIONS), ...scope);
  const snap = await getDocs(q);
  const trx = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.rptTrxCache = { clientId, rows: trx, from: win ? win.from : null, to: win ? win.to : null };
  return trx;
}
