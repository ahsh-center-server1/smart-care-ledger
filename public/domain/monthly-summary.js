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

import { countsInTotals } from './trx-totals.js';

/**
 * 요약 형태가 바뀌면 이 값을 올린다. 예전 형태로 저장된 캐시는
 * 버전이 같아도 무시하고 다시 계산한다 — 필드가 늘어났을 때
 * 낡은 캐시가 그 필드를 비운 채로 화면에 나가는 것을 막는다.
 */
// 2 — 미분류 건수(unclassified)를 추가했다. 1로 저장된 캐시는 그 필드가 없어
//     배지가 항상 0으로 보인다. 버전을 올려 다시 계산하게 한다.
// 3 — 합계에서 빼는 기준이 유형(자산이동·취소)에서 「합계 제외」 표시로 바뀌었다.
//     값 자체는 구형 데이터에서 같지만, 표시를 새로 켠 거래가 있으면 2로 저장된
//     캐시가 그것을 모른 채 남는다.
export const SUMMARY_SCHEMA_VERSION = 3;

/**
 * 분류가 정해지지 않은 상태. 판독·업로드가 정하지 못하면 여기로 들어온다.
 *
 * **여기 하나뿐이다.** 대시보드 배지와 제출 전 점검표가 다른 숫자를 말하면
 * 어느 쪽도 믿지 않게 되므로, report-checklist.js 도 이것을 가져다 쓴다.
 */
const UNSET_CATEGORIES = new Set(['확인필요', '미분류', '']);

/** 분류가 정해지지 않은 거래인가. */
export function isUnclassified(trx) {
  return UNSET_CATEGORIES.has(String((trx || {}).category || '').trim());
}

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
 *   「합계 제외」로 표시된 거래는 빠진다(domain/trx-totals.js).
 * (계좌 간 이동은 수입도 지출도 아니고, 승인취소는 없던 거래다)
 *
 * @param {Array} transactions 해당 입주자의 해당 월 거래
 * @returns {{inc:number, exp:number, count:number, unclassified:number, paidFixedIds:string[]}}
 */
export function computeMonthlySummary(transactions) {
  let inc = 0, exp = 0, count = 0, unclassified = 0;
  const paidFixedIds = new Set();

  for (const t of (transactions || [])) {
    count++;
    // 「합계 제외」 표시가 붙은 것과 구형 자산이동·취소는 빠진다.
    if (countsInTotals(t)) {
      inc += Number(t.amountIn || 0);
      exp += Number(t.amountOut || 0);
    }

    // 분류가 정해지지 않은 건. 대시보드가 이 수를 배지로 띄운다 — 여기서
    // 세지 않으면 카드마다 당월 거래를 다시 읽어야 하고, 그러면 캐시를 둔
    // 이유가 사라진다.
    if (isUnclassified(t)) unclassified++;

    // 필수 고정항목 미납 판정에 쓴다
    if (t.isFixed && t.fixedItemId) paidFixedIds.add(t.fixedItemId);
  }

  return { inc, exp, count, unclassified, paidFixedIds: [...paidFixedIds] };
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
    unclassified: Number(summary.unclassified || 0),
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
    unclassified: Number((cache && cache.unclassified) || 0),
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
  return countUnenteredFixed(fixedItems, paidFixedIds).mandatory;
}

/**
 * 이번 달에 들어오지 않은 고정항목.
 *
 * 필수(`isMandatory`)와 그 밖의 것을 나눠 센다 — 할 일의 무게가 다르다.
 * 필수는 빠지면 안 되는 것이고, 나머지는 이번 달만 건너뛸 수도 있다.
 * 한 숫자로 합치면 급한 것이 안 급한 것에 묻힌다.
 *
 * 판정 근거는 거래의 `fixedItemId` 다 — 월별 중복 방지와 제출 전 점검표가
 * 쓰는 것과 같은 표식이라 세 화면이 갈라지지 않는다.
 *
 * @param {Array} fixedItems  해당 입주자의 고정항목
 * @param {string[]} paidFixedIds 당월에 입력된 fixedItemId 목록
 * @returns {{mandatory:number, optional:number, total:number}}
 */
export function countUnenteredFixed(fixedItems, paidFixedIds) {
  const paid = new Set(paidFixedIds || []);
  let mandatory = 0, optional = 0;
  for (const f of (fixedItems || [])) {
    if (!f || !f.id || paid.has(f.id)) continue;
    if (f.isMandatory) mandatory += 1; else optional += 1;
  }
  return { mandatory, optional, total: mandatory + optional };
}
