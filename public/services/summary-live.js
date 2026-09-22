// public/services/summary-live.js
//
// 방금 쓴 거래를 대시보드가 **바로** 보여주게 한다.
//
// 무엇이 문제였나
//   대시보드 카드의 당월 수입·지출·미분류·고정항목 미납은 `S.monthlyStats` 에서
//   나오고, 그것은 **로그인할 때 한 번** 만들어진다. 거래를 하나 넣고 대시보드로
//   돌아오면 카드는 넣기 전 숫자를 그대로 보여 준다 — 사용자는 저장이 안 된 줄
//   알고 한 번 더 저장한다.
//
//   새로고침을 해도 낫지 않는 경우가 있다. 요약 캐시의 신선도는
//   `computedVersion === sourceVersion` 인데, `sourceVersion` 을 올리는 것은
//   **서버 트리거**이고 비동기다. 방금 쓴 직후에는 아직 올라가지 않아 캐시가
//   신선해 **보이고**, 그 안에는 방금 쓴 것이 없다. 버전만으로는 이 순간을
//   가릴 수 없다 — 자기가 썼다는 것은 쓴 쪽만 안다.
//
// 어떻게 고치나 — 두 갈래
//   ⑴ 지금 보고 있는 입주자의 거래가 이미 브라우저에 다 있으면(`S.transactions`
//      가 당월을 통째로 들고 있다) **읽기 0회로** 다시 계산한다. 수기 입력·삭제
//      같은 흔한 경우가 전부 여기로 온다.
//   ⑵ 아닐 때만(다른 입주자, 좁은 기간) 그 입주자 하나를 표시해 두었다가
//      대시보드를 열 때 캐시를 건너뛰고 다시 읽는다. 쓸 때마다가 아니라
//      **볼 때 한 번**이라 §12-1 의 "수기 입력 한 건마다 월 전체 재조회"가
//      되지 않는다.
//
// 왜 신호를 여기서 듣나
//   `TRX_WRITE_EVENT` 는 **모든 거래 쓰기 경로가 지나는 자리**에서 나온다
//   (services/firestore.js). 저장하는 쪽마다 갱신을 꿰면 언젠가 한 곳을
//   빠뜨리고, 그 한 곳이 "가끔 반영이 안 된다"가 된다.

'use strict';

import { S } from '../state.js';
import { TRX_WRITE_EVENT } from './firestore.js';
import { fetchMonthlySummaries, currentMonth, monthRange } from './summary.js';
import { rangeBounds } from '../domain/trx-range.js';
import {
  computeMonthlySummary, monthKey, countUnenteredFixed,
} from '../domain/monthly-summary.js';

/** 로컬 계산으로 덮지 못해 다시 읽어야 하는 입주자들. */
const pending = new Set();

/** 카드가 쓰는 모양으로. `partial`(입력자의 본인 입력분)은 그대로 유지한다. */
function putStats(clientId, summary) {
  if (!S.monthlyStats) return;
  const prev = S.monthlyStats[clientId] || {};
  S.monthlyStats[clientId] = {
    inc: summary.inc,
    exp: summary.exp,
    partial: !!prev.partial,
    unclassified: Number(summary.unclassified || 0),
  };
  if (S.fixedGap && Array.isArray(S.allFixedItems)) {
    const mine = S.allFixedItems.filter(f => f && f.clientId === clientId);
    S.fixedGap[clientId] = countUnenteredFixed(mine, summary.paidFixedIds);
  }
}

/**
 * 브라우저가 이미 들고 있는 거래로 다시 계산한다.
 *
 * 조건은 둘이다: 지금 열려 있는 입주자여야 하고, 로드된 기간이 **당월을 통째로**
 * 덮어야 한다. 절반만 덮은 기간으로 계산하면 카드가 실제보다 작은 금액을 말하고,
 * 그것은 낡은 값보다 나쁘다 — 낡은 값은 언젠가 맞았지만 이것은 한 번도 맞은 적이
 * 없다.
 *
 * @returns {boolean} 덮었으면 true
 */
function recomputeFromLoaded(clientId, now = new Date()) {
  if (!clientId || clientId !== S.activeClient) return false;
  if (!Array.isArray(S.transactions)) return false;

  const ym = currentMonth(now);
  const month = monthRange(ym);
  const loaded = rangeBounds(S.trxRange, now);
  // null 은 'all' — 전부 들고 있다.
  if (loaded && (loaded.start > month.start || loaded.end < month.end)) return false;

  const mine = S.transactions.filter(
    t => t && t.clientId === clientId && monthKey(t.date) === ym,
  );
  putStats(clientId, computeMonthlySummary(mine));
  return true;
}

/** 거래 쓰기 신호를 받아 카드 숫자를 맞춘다. 화면 다시 그리기는 호출부가 한다. */
function onTrxWritten(detail) {
  // 당월 집계를 아예 읽지 않는 역할(팀장·센터장)은 건드리지 않는다 — §7.
  // `{}` 로 만들어 두면 카드가 「당월 거래 없음」이라고 적는다.
  if (!S.monthlyStats) return;

  const forced = !!(detail && detail.forceRefresh);
  const batchIds = Array.isArray(detail && detail.clientIds)
    ? [...new Set(detail.clientIds.map(v => String(v || '')).filter(Boolean))]
    : [];
  if (batchIds.length) {
    for (const id of batchIds) {
      recomputeFromLoaded(id);
      pending.add(id);
    }
    return;
  }

  const clientId = String((detail && detail.clientId) || '');
  if (clientId) {
    const local = recomputeFromLoaded(clientId);
    if (!local || forced) pending.add(clientId);
    return;
  }
  // 어느 입주자인지 모르는 쓰기(배치)다. 열려 있는 것부터 로컬로 맞추고,
  // 그것으로 안 되면 담당 전원을 다시 읽을 대상으로 둔다 — 안전한 쪽이다.
  recomputeFromLoaded(S.activeClient);
  (S.clients || []).forEach(c => c && c.id && pending.add(c.id));
}

/**
 * 로컬로 덮지 못한 것들을 실제로 다시 읽는다. 대시보드를 열 때 부른다.
 *
 * 캐시를 **건너뛴다**(force) — 트리거가 아직 안 돌았으면 캐시는 신선해 보이는데
 * 방금 쓴 것이 빠져 있다. 그것이 이 함수가 존재하는 이유다.
 *
 * @returns {Promise<boolean>} 숫자가 바뀌었으면 true (호출부가 다시 그린다)
 */
export async function flushPendingMonthlyStats() {
  if (!S.monthlyStats || !pending.size) return false;
  const ids = [...pending];
  pending.clear();
  try {
    const { summaries } = await fetchMonthlySummaries(ids, currentMonth(), { force: ids });
    ids.forEach(id => putStats(id, summaries[id] || { inc: 0, exp: 0, unclassified: 0, paidFixedIds: [] }));
    return true;
  } catch (e) {
    // 실패하면 다음 기회에 다시 시도한다. 낡은 숫자가 남는 것이지 틀린 숫자가
    // 생기는 것은 아니다.
    console.warn('[summary-live] 당월 집계 갱신 실패:', e);
    ids.forEach(id => pending.add(id));
    return false;
  }
}

/** 한 번만 건다. app.js 가 초기화할 때 부른다. */
export function watchTrxWrites(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc) return;
  doc.addEventListener(TRX_WRITE_EVENT, (e) => onTrxWritten(e && e.detail));
}

// 테스트에서 상태를 들여다보기 위한 것 — 화면 코드는 쓰지 않는다.
export const _internals = { pending, recomputeFromLoaded, onTrxWritten };
