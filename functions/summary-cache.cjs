'use strict';

/**
 * 월별 요약 캐시의 무효화 — 서버(Cloud Functions)용 CommonJS 구현.
 *
 * ⚠️ `public/domain/monthly-summary.js`의 summaryKey와 **같은 형식**이어야 한다.
 *    test/monthly-summary.test.mjs가 양쪽을 대조하므로 한쪽만 고치면 실패한다.
 *
 * 왜 캐시가 있는가
 *   대시보드는 입주자 카드마다 당월 수입·지출을 보여주는데, 그 값을 만들려고
 *   **당월 거래 전체를 읽었다.** 관리자가 입주자 30명을 보면 한 세션에
 *   1,200건이고, 하루 두 번 접속하는 사람이 25명이면 그것만으로 무료 한도의
 *   절반을 쓴다. 그 값은 거래가 바뀌지 않으면 바뀌지 않는다.
 *
 * 이 파일은 키와 "어느 (입주자, 월)을 무효화해야 하는가"만 정한다.
 * 실제 계산은 클라이언트가 한다 — 서버가 계산하면 입력자 권한으로는 읽을 수
 * 없는 거래까지 합산해야 하고, 그 값을 누구에게 보여줄지 다시 판단해야 한다.
 * 서버는 "낡았다"고 표시만 하고, 볼 수 있는 사람이 계산한다.
 *
 * 클라이언트는 버전이 어긋나면 직접 계산으로 떨어진다. 따라서 트리거가
 * 배포되지 않았거나 실패해도 **화면 값은 항상 맞는다** — 읽기만 줄지 않는다.
 */

/** (입주자, 월) 캐시 문서 id. */
function summaryKey(clientId, ym) {
  return `${clientId}_${ym}`;
}

/** 'YYYY-MM' */
function monthKey(date) {
  return String(date || '').substring(0, 7);
}

/**
 * 거래 변경이 무효화해야 하는 (입주자, 월) 키 목록.
 *
 * 날짜나 입주자가 바뀐 수정이면 **양쪽 모두** 무효화해야 한다 —
 * 8월 거래를 9월로 옮기면 두 달의 합계가 다 바뀐다. 한쪽만 올리면
 * 다른 달이 낡은 값을 계속 보여주고, 그것은 눈에 띄지 않는다.
 *
 * @param {Object|null} before
 * @param {Object|null} after
 * @returns {string[]} 중복 없는 키 목록
 */
function affectedSummaryTargets(before, after) {
  const out = new Map();
  for (const doc of [before, after]) {
    if (!doc || !doc.clientId) continue;
    const ym = monthKey(doc.date);
    if (ym.length !== 7) continue;        // 날짜 없는 문서는 집계 대상이 아니다
    const clientId = String(doc.clientId);
    out.set(summaryKey(clientId, ym), { key: summaryKey(clientId, ym), clientId, ym });
  }
  return [...out.values()];
}

/**
 * 키만 필요한 곳을 위한 얇은 껍데기.
 *
 * ⚠️ 트리거는 이것을 쓰면 **안 된다.** 키에서 clientId 를 되짚을 수 없기
 *   때문이다 — clientId 에 `_` 가 들어가면 `${clientId}_${ym}` 를 도로 가를
 *   방법이 없다. 트리거는 affectedSummaryTargets 를 쓴다.
 */
function affectedSummaryKeys(before, after) {
  return affectedSummaryTargets(before, after).map((t) => t.key);
}

/**
 * 요약에 영향을 주는 필드가 바뀌었는가.
 *
 * 영수증 첨부·순서 변경·내용 수정은 합계를 바꾸지 않는다. 그런 쓰기까지
 * 버전을 올리면 캐시가 계속 무효화되어 캐시가 없는 것과 같아진다
 * (잔액 트리거의 affectsBalance와 같은 이유다).
 */
function affectsSummary(before, after) {
  if (!before || !after) return true;      // 생성·삭제는 항상 영향
  return (
    Number(before.amountIn  || 0) !== Number(after.amountIn  || 0) ||
    Number(before.amountOut || 0) !== Number(after.amountOut || 0) ||
    String(before.type      || '') !== String(after.type      || '') ||
    String(before.date      || '') !== String(after.date      || '') ||
    String(before.clientId  || '') !== String(after.clientId  || '') ||
    // 고정항목 표시가 바뀌면 미납 건수가 바뀐다
    String(before.fixedItemId || '') !== String(after.fixedItemId || '') ||
    (before.isFixed === true) !== (after.isFixed === true)
  );
}

module.exports = {
  summaryKey, monthKey, affectedSummaryKeys, affectedSummaryTargets, affectsSummary,
};
