import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcAccountBalance, calcAccountBalanceAsOf, calcBalances, sumIncomeExpense,
} from '../public/services/balance.js';

const acc = (over = {}) => ({
  id: 'acc1', initialBalance: 100000, initialBalanceDate: '2026-01-31', ...over,
});
const t = (over = {}) => ({
  accountId: 'acc1', date: '2026-02-10', type: '지출', amountIn: 0, amountOut: 0, ...over,
});

test('기초잔액만 있고 거래가 없으면 기초잔액 그대로', () => {
  assert.equal(calcAccountBalance(acc(), []), 100000);
});

test('수입은 더하고 지출은 뺀다', () => {
  const trx = [
    t({ type: '수입', amountIn: 50000 }),
    t({ type: '지출', amountOut: 30000 }),
  ];
  assert.equal(calcAccountBalance(acc(), trx), 120000);
});

test('기준일 이전 거래는 제외한다', () => {
  const trx = [t({ date: '2026-01-15', type: '지출', amountOut: 99999 })];
  assert.equal(calcAccountBalance(acc(), trx), 100000);
});

test('기준일 당일 거래는 기초잔액에 이미 포함된 것으로 보고 제외한다', () => {
  const trx = [t({ date: '2026-01-31', type: '지출', amountOut: 5000 })];
  assert.equal(calcAccountBalance(acc(), trx), 100000);
});

test('기준일 다음 날 거래는 포함한다', () => {
  const trx = [t({ date: '2026-02-01', type: '지출', amountOut: 5000 })];
  assert.equal(calcAccountBalance(acc(), trx), 95000);
});

test('기준일이 없으면 전 기간을 합산한다', () => {
  const trx = [t({ date: '2020-01-01', type: '지출', amountOut: 5000 })];
  assert.equal(calcAccountBalance(acc({ initialBalanceDate: '' }), trx), 95000);
});

test('취소 거래는 잔액에 영향이 없다', () => {
  const trx = [t({ type: '취소', amountOut: 70000 })];
  assert.equal(calcAccountBalance(acc(), trx), 100000);
});

test('자산이동은 잔액에 반영된다', () => {
  const trx = [t({ type: '자산이동', amountOut: 20000 })];
  assert.equal(calcAccountBalance(acc(), trx), 80000);
});

test('음수 amountOut(환불)은 잔액을 늘린다', () => {
  const trx = [t({ type: '지출', amountOut: -5000 })];
  assert.equal(calcAccountBalance(acc(), trx), 105000);
});

test('다른 계좌의 거래는 무시한다 — 전체 거래를 넘겨도 안전', () => {
  const trx = [
    t({ accountId: 'acc2', type: '지출', amountOut: 999999 }),
    t({ type: '지출', amountOut: 10000 }),
  ];
  assert.equal(calcAccountBalance(acc(), trx), 90000);
});

test('문자열로 저장된 금액도 숫자로 합산한다', () => {
  const trx = [
    t({ type: '수입', amountIn: '50000' }),
    t({ type: '지출', amountOut: '20000' }),
  ];
  assert.equal(calcAccountBalance(acc({ initialBalance: '100000' }), trx), 130000);
});

test('금액 필드가 없어도 깨지지 않는다', () => {
  const trx = [{ accountId: 'acc1', date: '2026-02-10', type: '지출' }];
  assert.equal(calcAccountBalance(acc(), trx), 100000);
});

test('계좌가 null이면 0', () => {
  assert.equal(calcAccountBalance(null, []), 0);
});

test('거래가 null/undefined여도 기초잔액을 반환한다', () => {
  assert.equal(calcAccountBalance(acc(), null), 100000);
  assert.equal(calcAccountBalance(acc(), undefined), 100000);
});

test('calcAccountBalanceAsOf — 지정일 이후 거래는 제외', () => {
  const trx = [
    t({ date: '2026-02-05', type: '지출', amountOut: 10000 }),
    t({ date: '2026-03-05', type: '지출', amountOut: 50000 }),
  ];
  assert.equal(calcAccountBalanceAsOf(acc(), trx, '2026-02-28'), 90000);
});

test('calcAccountBalanceAsOf — 지정일 당일은 포함', () => {
  const trx = [t({ date: '2026-02-28', type: '지출', amountOut: 10000 })];
  assert.equal(calcAccountBalanceAsOf(acc(), trx, '2026-02-28'), 90000);
});

test('calcBalances — 계좌별로 나눠 계산', () => {
  const accounts = [
    acc({ id: 'a', initialBalance: 1000 }),
    acc({ id: 'b', initialBalance: 2000 }),
  ];
  const trx = [
    t({ accountId: 'a', type: '지출', amountOut: 100 }),
    t({ accountId: 'b', type: '수입', amountIn: 500 }),
  ];
  assert.deepEqual(calcBalances(accounts, trx), { a: 900, b: 2500 });
});

test('sumIncomeExpense — 자산이동과 취소는 집계에서 뺀다', () => {
  const trx = [
    t({ type: '수입', amountIn: 10000 }),
    t({ type: '지출', amountOut: 3000 }),
    t({ type: '자산이동', amountOut: 50000 }),
    t({ type: '자산이동', amountIn: 50000 }),
    t({ type: '취소', amountOut: 7000 }),
  ];
  assert.deepEqual(sumIncomeExpense(trx), { totalIn: 10000, totalOut: 3000 });
});

test('회귀: 부분 로드된 목록을 넘기면 잔액이 틀린다 — 전체를 넘겨야 한다', () => {
  const 전체 = [
    t({ date: '2026-01-05', type: '지출', amountOut: 10000 }),
    t({ date: '2026-02-05', type: '지출', amountOut: 20000 }),
  ];
  const 당월만 = 전체.filter((x) => x.date.startsWith('2026-02'));
  const a = acc({ initialBalanceDate: '2025-12-31' });
  assert.equal(calcAccountBalance(a, 전체), 70000);
  assert.equal(calcAccountBalance(a, 당월만), 80000);  // 이것이 기존 버그의 정체
});
