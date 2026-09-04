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

module.exports = { calcAccountBalance };
