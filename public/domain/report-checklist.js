// public/domain/report-checklist.js
//
// 「제출 전 확인」 판정 — 순수 함수. DOM·Firestore를 모른다.
//
// 왜 필요한가
//   지금은 담당자가 **제출하고 반려받아야** 무엇을 빠뜨렸는지 안다. 그 왕복이
//   이 앱에서 가장 비싼 낭비다. 결재자는 증빙이 빈 줄을 보고 반려하고,
//   담당자는 그제서야 영수증을 찾으러 간다.
//
//   필요한 것은 전부 이미 화면에 있다 — 보고서를 조회한 시점에 그 달 거래와
//   고정항목이 메모리에 들어와 있다. **추가 읽기가 없다.**
//
// 막지 않는다
//   경고를 차단으로 만들면 정당한 예외에서 제출이 불가능해진다. 현금 영수증이
//   없는 지출, 아직 분류를 정하지 못한 건, 이번 달만 건너뛰는 고정항목은
//   전부 실제로 일어난다. 이 함수는 **세어서 알려 줄 뿐**이고, 제출 여부는
//   사람이 정한다.

'use strict';

// 분류 미정 판정은 monthly-summary 에 하나만 둔다. 대시보드 배지와 이 점검표가
// 다른 숫자를 말하면 어느 쪽도 믿지 않게 된다.
import { isUnclassified } from './monthly-summary.js';

/**
 * 증빙이 필요한데 없는 지출인가.
 *
 * `receiptMissing` 은 **사용자가 「분실」로 표시한 것**이다. 이미 인지하고
 * 표시까지 한 건을 다시 지적하면, 목록이 영영 0이 되지 않아 아무도 안 본다.
 * 환불(음수 지출)도 뺀다 — 영수증이 없는 것이 정상이다.
 */
function needsReceipt(t) {
  return t.type === '지출'
    && Number(t.amountOut || 0) > 0
    && !t.receiptPath && !t.receiptUrl
    && !t.receiptMissing;
}

/**
 * 제출 전에 확인할 것들.
 *
 * @param {Object} input
 * @param {Array} input.transactions 보고서 월의 거래 (이미 그 달로 걸러진 것)
 * @param {Array} input.fixedItems   그 입주자의 고정항목 전체
 * @returns {{
 *   unclassified: Array, receiptless: Array, missingFixed: Array,
 *   total: number, clean: boolean
 * }}
 */
export function reportChecklist({ transactions, fixedItems } = {}) {
  const trx = Array.isArray(transactions) ? transactions : [];
  const items = Array.isArray(fixedItems) ? fixedItems : [];

  const unclassified = trx.filter(isUnclassified);
  const receiptless = trx.filter(needsReceipt);

  // 이번 달에 들어온 고정항목. 거래가 fixedItemId 로 자기 출처를 기록한다
  // (월별 중복 방지가 쓰는 것과 같은 표식이라 근거가 갈라지지 않는다).
  const entered = new Set(
    trx.filter(t => t.isFixed && t.fixedItemId).map(t => String(t.fixedItemId)),
  );
  const missingFixed = items.filter(f => f && f.id && !entered.has(String(f.id)));

  const total = unclassified.length + receiptless.length + missingFixed.length;
  return { unclassified, receiptless, missingFixed, total, clean: total === 0 };
}

/**
 * 점검 결과를 사람이 읽는 줄로 바꾼다.
 *
 * 숫자만 주면 "그래서 어느 것?"이 남는다. 각 줄에 **무엇을 해야 하는지**를
 * 함께 적는다 — 이 화면을 보는 사람은 결재 마감에 쫓기고 있다.
 *
 * @returns {Array<{key:string, count:number, label:string, hint:string}>}
 */
export function checklistLines(result) {
  const r = result || {};
  const lines = [];
  if (r.unclassified?.length) {
    lines.push({
      key: 'unclassified', count: r.unclassified.length,
      label: `분류가 정해지지 않은 거래 ${r.unclassified.length}건`,
      hint: '거래내역에서 분류를 고르면 보고서의 분류별 지출이 맞아집니다.',
    });
  }
  if (r.receiptless?.length) {
    lines.push({
      key: 'receiptless', count: r.receiptless.length,
      label: `증빙이 없는 지출 ${r.receiptless.length}건`,
      hint: '영수증을 붙이거나, 없으면 「분실」로 표시해 두세요.',
    });
  }
  if (r.missingFixed?.length) {
    lines.push({
      key: 'missingFixed', count: r.missingFixed.length,
      label: `이번 달에 입력되지 않은 고정항목 ${r.missingFixed.length}건`,
      hint: '거래내역의 「고정항목 입력」으로 한 번에 넣을 수 있습니다.',
    });
  }
  return lines;
}
