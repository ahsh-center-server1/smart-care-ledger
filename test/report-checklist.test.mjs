// test/report-checklist.test.mjs
//
// 제출 전 점검표. **막지 않고 알려만 준다** — 그래서 세는 기준이 전부다.
// 잘못 세면 목록이 영영 0이 되지 않고, 그러면 아무도 보지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { reportChecklist, checklistLines } from '../public/domain/report-checklist.js';

const 지출 = (over = {}) => ({ type: '지출', amountOut: 1000, category: '식비', ...over });

test('아무 문제가 없으면 clean 이다', () => {
  const r = reportChecklist({
    transactions: [지출({ receiptPath: 'receipts/c1/a' })],
    fixedItems: [],
  });
  assert.equal(r.total, 0);
  assert.equal(r.clean, true);
  assert.deepEqual(checklistLines(r), []);
});

test('빈 입력에도 깨지지 않는다', () => {
  // 보고서를 아직 조회하지 않은 상태에서도 불릴 수 있다.
  for (const input of [undefined, {}, { transactions: null, fixedItems: null }]) {
    const r = reportChecklist(input);
    assert.equal(r.total, 0);
    assert.equal(r.clean, true);
  }
});

// ── 분류 ────────────────────────────────────────────────────

test('분류가 정해지지 않은 거래를 센다', () => {
  const r = reportChecklist({
    transactions: [
      지출({ category: '확인필요' }),
      지출({ category: '미분류' }),
      지출({ category: '' }),
      지출({ category: '  ' }),        // 공백만 있는 것도 정해지지 않은 것이다
      지출({ category: '식비' }),
    ],
  });
  assert.equal(r.unclassified.length, 4);
});

// ── 증빙 ────────────────────────────────────────────────────

test('증빙이 없는 지출을 센다', () => {
  const r = reportChecklist({ transactions: [지출(), 지출({ receiptPath: 'x' })] });
  assert.equal(r.receiptless.length, 1);
});

test('구형 receiptUrl 도 증빙으로 본다', () => {
  // 거래에 URL 이 직접 박혀 있던 시절 데이터. 있는데 없다고 하면 안 된다.
  const r = reportChecklist({ transactions: [지출({ receiptUrl: 'https://x/y.jpg' })] });
  assert.equal(r.receiptless.length, 0);
});

test('「분실」로 표시한 건은 다시 지적하지 않는다', () => {
  // 이미 인지하고 표시까지 한 것을 계속 세면 목록이 영영 0이 되지 않고,
  // 그러면 아무도 이 화면을 보지 않게 된다.
  const r = reportChecklist({ transactions: [지출({ receiptMissing: true })] });
  assert.equal(r.receiptless.length, 0);
});

test('수입·자산이동·취소는 증빙 대상이 아니다', () => {
  const r = reportChecklist({
    transactions: [
      { type: '수입', amountIn: 1000, category: '용돈' },
      { type: '자산이동', amountOut: 1000, category: '이체' },
      { type: '취소', amountOut: 1000, category: '취소' },
    ],
  });
  assert.equal(r.receiptless.length, 0);
});

test('환불(음수 지출)은 증빙을 요구하지 않는다', () => {
  const r = reportChecklist({ transactions: [지출({ amountOut: -5000 })] });
  assert.equal(r.receiptless.length, 0);
});

// ── 고정항목 ────────────────────────────────────────────────

test('이번 달에 들어오지 않은 고정항목을 센다', () => {
  const r = reportChecklist({
    transactions: [지출({ isFixed: true, fixedItemId: 'f1', receiptMissing: true })],
    fixedItems: [{ id: 'f1', description: '통신비' }, { id: 'f2', description: '월세' }],
  });
  assert.equal(r.missingFixed.length, 1);
  assert.equal(r.missingFixed[0].id, 'f2');
});

test('fixedItemId 가 없는 거래는 고정항목 입력으로 세지 않는다', () => {
  // isFixed 만 있고 출처가 없으면 어느 항목이 들어왔는지 알 수 없다.
  const r = reportChecklist({
    transactions: [지출({ isFixed: true, receiptMissing: true })],
    fixedItems: [{ id: 'f1', description: '통신비' }],
  });
  assert.equal(r.missingFixed.length, 1);
});

test('id 가 없는 고정항목은 판정 대상이 아니다', () => {
  const r = reportChecklist({ transactions: [], fixedItems: [{ description: '이상한 것' }, null] });
  assert.equal(r.missingFixed.length, 0);
});

// ── 합계와 문구 ─────────────────────────────────────────────

test('세 가지를 합쳐 세고, 각 줄에 할 일을 적는다', () => {
  const r = reportChecklist({
    transactions: [
      지출({ category: '확인필요', receiptMissing: true }),
      지출(),
    ],
    fixedItems: [{ id: 'f1', description: '통신비' }],
  });
  assert.equal(r.total, 3);
  assert.equal(r.clean, false);

  const lines = checklistLines(r);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(line.count > 0, `${line.key} 의 건수가 0입니다`);
    // 숫자만 주면 "그래서 어느 것?"이 남는다.
    assert.ok(line.hint && line.hint.length > 5, `${line.key} 에 할 일이 없습니다`);
  }
});

test('한 거래가 두 가지에 동시에 걸릴 수 있다', () => {
  // 분류도 없고 증빙도 없는 거래는 둘 다 고쳐야 한다 — 하나로 뭉치면
  // 하나를 고친 뒤 목록이 사라져 나머지를 놓친다.
  const r = reportChecklist({ transactions: [지출({ category: '확인필요' })] });
  assert.equal(r.unclassified.length, 1);
  assert.equal(r.receiptless.length, 1);
  assert.equal(r.total, 2);
});
