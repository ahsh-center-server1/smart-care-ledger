'use strict';

/**
 * 잔액 계산 — 서버(Cloud Functions)용 CommonJS 구현.
 *
 * ⚠️ `public/services/balance.js`(브라우저용 ESM)와 **동일한 계산**이어야 한다.
 *    test/balance.test.mjs가 모든 픽스처를 양쪽에 통과시켜 값이 같은지 검증하므로,
 *    한쪽만 고치면 테스트가 실패한다. 반드시 둘을 함께 수정할 것.
 *
 * 파일이 두 벌인 이유: 브라우저는 public/ 아래 ESM만 불러올 수 있고,
 * Cloud Functions 배포 번들에는 functions/ 밖의 파일이 포함되지 않는다.
 */

/** 기준일 이후 거래만 합산한 계좌 잔액. */
function calcAccountBalance(account, transactions) {
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
 * 잔액에 영향을 주는 거래 필드 목록.
 * calcAccountBalance가 실제로 읽는 필드와 정확히 일치해야 한다.
 */
const BALANCE_FIELDS = ['accountId', 'date', 'type', 'amountIn', 'amountOut'];

/**
 * 거래 문서의 변경이 계좌 잔액을 바꿀 수 있는가.
 *
 * 왜 필요한가
 *   syncAccountBalance 트리거는 거래 쓰기마다 계좌 전체 거래를 다시 읽어 합산한다.
 *   그런데 실제로 가장 흔한 쓰기는 **잔액과 무관하다** — 영수증 첨부(receiptUrl),
 *   카테고리 인라인 수정, 드래그 순서 변경(sortOrder), 내용 수정.
 *   이런 변경까지 전체 스캔을 돌리면 엑셀 100행 업로드가 수만 건 읽기가 된다.
 *
 *   잔액식이 읽는 필드가 하나도 안 바뀌었으면 잔액은 바뀔 수 없다.
 *   그때는 계좌 문서조차 읽지 않고 즉시 중단한다(읽기 0).
 *
 *   전체 재계산 방식은 유지한다 — 트리거는 at-least-once로 중복 발동할 수 있어
 *   FieldValue.increment 같은 증분 갱신은 중복 시 금액이 어긋난다. 전체 합산은 멱등하다.
 */
function affectsBalance(before, after) {
  if (!before || !after) return true;          // 생성·삭제는 항상 영향
  return (
    Number(before.amountIn  || 0) !== Number(after.amountIn  || 0) ||
    Number(before.amountOut || 0) !== Number(after.amountOut || 0) ||
    String(before.accountId || '') !== String(after.accountId || '') ||
    String(before.date      || '') !== String(after.date      || '') ||
    String(before.type      || '') !== String(after.type      || '')
  );
}

module.exports = { calcAccountBalance, affectsBalance, BALANCE_FIELDS };
