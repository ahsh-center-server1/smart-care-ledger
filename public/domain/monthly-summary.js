// public/domain/monthly-summary.js
//
// 월별 요약 계산과 캐시 판정 — 순수 함수. DOM·Firestore를 모른다.
//
// 왜 필요한가
//   대시보드는 입주자 카드마다 당월 수입·지출을 보여준다. 그 값을 만들려고
//   **당월 거래 전체를 읽는다.** 관리자가 입주자 30명을 보면 한 세션에
//   1,200건이고, 하루 두 번 접속하는 사람이 25명이면 그것만으로 무료 한도의
//   절반을 쓴다(tools/read-budget.mjs로 실측 모델을 볼 수 있다).
//
//   그런데 그 값은 **거래가 바뀌지 않으면 바뀌지 않는다.** 그래서 계산 결과를
//   문서 하나에 담아 두고, 거래가 바뀔 때만 다시 계산한다.
//   입주자 1명의 당월 요약이 40 읽기에서 **1 읽기**가 된다.
//
// 무효화 방식 — 버전 카운터
//   서버 트리거가 거래를 쓸 때마다 그 (입주자, 월)의 `sourceVersion`을
//   1 올린다. 클라이언트는 캐시에 적힌 `computedVersion`과 비교해서
//   같으면 그대로 쓰고, 다르면 다시 계산해서 덮어쓴다.
//
//   **무효화 입도가 (입주자, 월)이라는 점이 핵심이다.** 조직 단위 키로 두면
//   한 사람이 한 건 저장할 때 전원의 캐시가 무효가 되고, 그러면 캐시가 없는
//   것과 같아진다.
//
// 안전 장치
//   캐시가 없거나 버전이 어긋나면 **직접 계산으로 떨어진다.** 즉 트리거가
//   배포되지 않았거나 실패해도 화면 값은 항상 맞는다 — 읽기만 줄지 않는다.
//   이 성질이 없으면 캐시 도입은 곧 잘못된 금액을 보여주는 위험이 된다.

'use strict';

/**
 * 요약 형태가 바뀌면 이 값을 올린다. 예전 형태로 저장된 캐시는
 * 버전이 같아도 무시하고 다시 계산한다 — 필드가 늘어났을 때
 * 낡은 캐시가 그 필드를 비운 채로 화면에 나가는 것을 막는다.
 */
export const SUMMARY_SCHEMA_VERSION = 1;

/** (입주자, 월) 캐시 문서 id. 서버(functions/summary-cache.cjs)와 같아야 한다. */
export function summaryKey(clientId, ym) {
  return `${clientId}_${ym}`;
}

/** 'YYYY-MM' */
export function monthKey(date) {
  return String(date || '').substring(0, 7);
}

/**
 * 거래 목록에서 한 입주자의 당월 요약을 만든다.
 *
 * 집계 규칙은 보고서·연간 통계와 **같아야** 한다:
 *   수입 → totalIn, 지출 → totalOut, 자산이동·취소는 집계 제외.
 * (계좌 간 이동은 수입도 지출도 아니고, 승인취소는 없던 거래다)
 *
 * @param {Array} transactions 해당 입주자의 해당 월 거래
 * @returns {{inc:number, exp:number, count:number, paidFixedIds:string[]}}
 */
export function computeMonthlySummary(transactions) {
  let inc = 0, exp = 0, count = 0;
  const paidFixedIds = new Set();

  for (const t of (transactions || [])) {
    count++;
    if (t.type === '수입')      inc += Number(t.amountIn || 0);
    else if (t.type === '지출') exp += Number(t.amountOut || 0);
    // 자산이동 · 취소 → 집계 제외

    // 필수 고정항목 미납 판정에 쓴다
    if (t.isFixed && t.fixedItemId) paidFixedIds.add(t.fixedItemId);
  }

  return { inc, exp, count, paidFixedIds: [...paidFixedIds] };
}

/**
 * 캐시를 그대로 써도 되는가.
 *
 * 세 가지가 모두 맞아야 한다:
 *   1. 캐시가 존재한다
 *   2. 요약 형태 버전이 같다 (필드가 늘어난 뒤의 낡은 캐시를 배제)
 *   3. 계산 시점 버전이 현재 소스 버전과 같다 (그 뒤 거래가 안 바뀌었다)
 *
 * 하나라도 어긋나면 false — 직접 계산으로 떨어진다.
 */
export function isSummaryFresh(cache) {
  if (!cache) return false;
  if (Number(cache.schemaVersion) !== SUMMARY_SCHEMA_VERSION) return false;
  // 버전이 없는 캐시(수동으로 만든 것 등)는 신뢰하지 않는다.
  if (!Number.isFinite(Number(cache.sourceVersion))) return false;
  if (!Number.isFinite(Number(cache.computedVersion))) return false;
  return Number(cache.computedVersion) === Number(cache.sourceVersion);
}

/**
 * 캐시 문서로 저장할 형태를 만든다.
 *
 * `computedVersion`에 **읽은 시점의 sourceVersion**을 넣는다. 계산 중에
 * 거래가 바뀌면 트리거가 sourceVersion을 더 올리므로, 다음 조회에서
 * 어긋남이 감지되어 다시 계산된다 — 오래된 값이 굳지 않는다.
 *
 * `isNew`일 때만 `sourceVersion: 0`을 함께 심는다. 이유가 두 가지다:
 *   · 없으면 isSummaryFresh가 항상 false다 — sourceVersion이 없는 캐시는
 *     신뢰하지 않기 때문. 즉 트리거가 한 번도 안 돈 (입주자, 월)의 캐시가
 *     영구히 무용지물이 된다.
 *   · 이미 있는 문서에 다시 쓰면 계산 중에 트리거가 올린 값을 **되돌린다.**
 *     낡은 캐시가 신선한 것으로 위장되는 경로이므로 보안 규칙도 이것을
 *     거부한다(갱신 시 sourceVersion 변경 불가).
 */
export function toSummaryCacheDoc({
  clientId, ym, summary, sourceVersion, isNew = false, now = Date.now(),
}) {
  const docData = {
    clientId: String(clientId),
    ym: String(ym),
    inc: Number(summary.inc || 0),
    exp: Number(summary.exp || 0),
    count: Number(summary.count || 0),
    paidFixedIds: Array.isArray(summary.paidFixedIds) ? summary.paidFixedIds : [],
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    computedVersion: Number(sourceVersion) || 0,
    updatedAt: new Date(now).toISOString(),
  };
  if (isNew) docData.sourceVersion = 0;
  return docData;
}

/**
 * 캐시 문서에서 화면이 쓰는 형태를 뽑는다.
 * 필드가 없으면 0으로 — 낡은 캐시가 화면을 깨뜨리지 않게.
 */
export function fromSummaryCacheDoc(cache) {
  return {
    inc: Number((cache && cache.inc) || 0),
    exp: Number((cache && cache.exp) || 0),
    count: Number((cache && cache.count) || 0),
    paidFixedIds: Array.isArray(cache && cache.paidFixedIds) ? cache.paidFixedIds : [],
  };
}

/**
 * 필수 고정항목 미납 건수.
 *
 * @param {Array} fixedItems  해당 입주자의 고정항목
 * @param {string[]} paidFixedIds 당월에 입력된 fixedItemId 목록
 */
export function countUnpaidMandatory(fixedItems, paidFixedIds) {
  const paid = new Set(paidFixedIds || []);
  return (fixedItems || [])
    .filter(f => f && f.isMandatory && !paid.has(f.id))
    .length;
}
