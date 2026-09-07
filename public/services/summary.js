// public/services/summary.js
//
// 월별 요약 읽기 — 캐시 우선, 어긋나면 직접 계산.
//
// 읽기 비용
//   캐시가 맞으면 입주자 1명당 **문서 1건**이다(예전에는 당월 거래 전체).
//   캐시가 어긋나면 그 입주자의 당월 거래를 읽어 계산하고 캐시를 갱신한다 —
//   그 비용은 예전과 같고, 다음 조회부터 다시 1건이 된다.
//
// 정확성
//   캐시가 없거나 낡았으면 **직접 계산으로 떨어진다.** 서버 트리거가
//   배포되지 않았거나 실패해도 화면 값은 항상 맞는다. 캐시 도입이
//   "가끔 틀린 금액을 보여주는" 위험이 되지 않게 하는 것이 이 설계의 조건이다.

'use strict';

import { S } from '../state.js';
import { COLS } from '../constants.js';
import { fb, fdb } from './firestore.js';
import { chunkForInQuery } from './in-query.js';
import { can } from '../modules/permissions.js';
import {
  summaryKey, computeMonthlySummary, isSummaryFresh,
  toSummaryCacheDoc, fromSummaryCacheDoc,
} from '../domain/monthly-summary.js';

/** 이번 달 'YYYY-MM'. */
export function currentMonth(now = new Date()) {
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

/** 'YYYY-MM' → { start, end } */
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * 여러 입주자의 당월 요약을 가져온다.
 *
 * @param {string[]} clientIds
 * @param {string} ym 'YYYY-MM'
 * @returns {Promise<{summaries:Object, reads:number, recomputed:string[]}>}
 *   summaries: { [clientId]: {inc, exp, count, paidFixedIds} }
 *   reads·recomputed는 진단용 — 캐시가 실제로 듣는지 확인할 때 쓴다.
 */
export async function fetchMonthlySummaries(clientIds, ym) {
  const ids = (clientIds || []).filter(Boolean);
  const summaries = {};
  const recomputed = [];
  let reads = 0;

  if (!ids.length) return { summaries, reads, recomputed };

  // ── 1) 캐시 문서를 한 번에 읽는다 ──
  const caches = new Map();
  try {
    const { getDocs, collection, query, where, documentId } = fb();
    const db = fdb();
    // documentId() in [...] 은 색인이 필요 없다 — 문서 키 조회다.
    for (const chunk of chunkForInQuery(ids.map(id => summaryKey(id, ym)))) {
      const snap = await getDocs(query(
        collection(db, COLS.SUMMARY_CACHES),
        where(documentId(), 'in', chunk),
      ));
      reads += snap.size;
      snap.docs.forEach(d => caches.set(d.id, d.data()));
    }
  } catch (e) {
    // 캐시를 못 읽어도 계산은 된다. 조용히 직접 계산으로 넘어간다.
    console.warn('[summary] 캐시 조회 실패, 직접 계산합니다:', e);
  }

  // ── 2) 신선한 것은 그대로, 어긋난 것만 다시 계산 ──
  const stale = [];
  for (const id of ids) {
    const cache = caches.get(summaryKey(id, ym));
    if (isSummaryFresh(cache)) summaries[id] = fromSummaryCacheDoc(cache);
    else stale.push(id);
  }

  if (stale.length) {
    const fresh = await recomputeSummaries(stale, ym, caches);
    Object.assign(summaries, fresh.summaries);
    reads += fresh.reads;
    recomputed.push(...stale);
  }

  return { summaries, reads, recomputed };
}

/**
 * 캐시가 어긋난 입주자들의 요약을 직접 계산하고 캐시를 갱신한다.
 *
 * 입력자는 본인이 만든 거래만 읽을 수 있으므로 createdBy 필터를 함께 건다
 * (규칙이 그것을 요구한다 — 없으면 쿼리가 통째로 거부된다).
 * 그 경우 계산 결과가 "본인 것만"이므로 **캐시에 쓰지 않는다** —
 * 다른 사람이 그 캐시를 읽으면 금액이 빠진 값을 보게 된다.
 */
async function recomputeSummaries(clientIds, ym, caches) {
  const { getDocs, collection, query, where, setDoc, doc } = fb();
  const db = fdb();
  const { start, end } = monthRange(ym);
  const summaries = {};
  let reads = 0;

  const scoped = !can('trx.view.all');
  const extra = scoped ? [where('createdBy', '==', String(S.user?.userId || ''))] : [];

  // 입주자별 거래를 모은다. in 절 분할로 한 번에 여러 명을 조회한다.
  const byClient = {};
  clientIds.forEach(id => { byClient[id] = []; });

  for (const chunk of chunkForInQuery(clientIds)) {
    const snap = await getDocs(query(
      collection(db, COLS.TRANSACTIONS),
      where('clientId', 'in', chunk),
      where('date', '>=', start),
      where('date', '<=', end),
      ...extra,
    ));
    reads += snap.size;
    snap.docs.forEach(d => {
      const t = d.data();
      if (byClient[t.clientId]) byClient[t.clientId].push(t);
    });
  }

  for (const id of clientIds) {
    const summary = computeMonthlySummary(byClient[id]);
    // 입력자의 결과는 **본인 입력분만**이다. 그것을 "당월 지출"로 표시하면
    // 같은 카드가 캐시 유무에 따라 다른 금액을 보여준다. 화면이 구별할 수
    // 있게 표시해 둔다(dashboard.js가 라벨을 바꾼다).
    summaries[id] = scoped ? { ...summary, partial: true } : summary;

    // 부분 조회 결과는 캐시하지 않는다 (위 주석 참고).
    if (scoped) continue;

    const key = summaryKey(id, ym);
    const existing = caches.get(key);
    const sourceVersion = Number((existing || {}).sourceVersion) || 0;
    try {
      // merge로 쓴다 — 계산 중에 트리거가 올린 sourceVersion을 덮지 않게.
      // isNew일 때만 sourceVersion 0을 심는다(monthly-summary.js 주석 참고).
      await setDoc(
        doc(db, COLS.SUMMARY_CACHES, key),
        toSummaryCacheDoc({ clientId: id, ym, summary, sourceVersion, isNew: !existing }),
        { merge: true },
      );
    } catch (e) {
      // 캐시 갱신 실패는 화면을 틀리게 만들지 않는다 — 다음에 또 계산한다.
      console.warn('[summary] 캐시 갱신 실패:', key, e);
    }
  }

  return { summaries, reads };
}
