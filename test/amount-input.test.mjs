// test/amount-input.test.mjs
//
// 금액 입력칸의 파싱·서식.
//
// 이 파일이 지키는 것은 하나다 — **금액이 조용히 잘리지 않는 것.**
// 값을 읽는 자리마다 각자 콤마를 지우면 한 곳을 빠뜨렸을 때 1,250,000 이
// 1 이 된다. 그런 버그는 장부에서 가장 늦게 발견된다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAmount, formatAmount } from '../public/utils/amount-input.js';

test('콤마가 있어도 온전한 금액을 돌려준다', () => {
  assert.equal(parseAmount('1,250,000'), 1250000);
  assert.equal(parseAmount('1250000'), 1250000);
  assert.equal(parseAmount('12,000'), 12000);
});

test('원 표시나 공백이 섞여도 읽는다', () => {
  // 붙여넣기로 들어오는 형태들이다.
  assert.equal(parseAmount(' 12,000원 '), 12000);
  assert.equal(parseAmount('₩12,000'), 12000);
});

test('숫자가 없으면 0이다 — NaN 이 나가면 안 된다', () => {
  // NaN 이면 호출부의 `!amount` 검사와 Number() 변환이 자리마다 다르게 반응한다.
  for (const v of ['', '   ', 'abc', null, undefined, '원']) {
    assert.equal(parseAmount(v), 0, `${JSON.stringify(v)} 가 0이 아닙니다`);
  }
});

test('음수를 유지한다 — 환불이 양수가 되면 잔액이 두 배로 틀린다', () => {
  assert.equal(parseAmount('-5,000'), -5000);
  assert.equal(parseAmount('-5000'), -5000);
});

test('숫자를 직접 줘도 읽는다', () => {
  assert.equal(parseAmount(12000), 12000);
  assert.equal(parseAmount(0), 0);
});

test('서식은 천 단위로 끊는다', () => {
  assert.equal(formatAmount('1250000'), '1,250,000');
  assert.equal(formatAmount('1,250,000'), '1,250,000');
  assert.equal(formatAmount('-5000'), '-5,000');
});

test('아무것도 안 친 것과 0을 친 것은 다르다', () => {
  // 빈 값이면 placeholder 가 보여야 한다.
  assert.equal(formatAmount(''), '');
  assert.equal(formatAmount(null), '');
  assert.equal(formatAmount('abc'), '');
  assert.equal(formatAmount('0'), '0');
});

test('서식을 다시 먹여도 값이 변하지 않는다', () => {
  // 입력할 때마다 다시 서식이 걸리므로, 반복 적용이 안전해야 한다.
  let v = '1250000';
  for (let i = 0; i < 5; i++) v = formatAmount(v);
  assert.equal(v, '1,250,000');
  assert.equal(parseAmount(v), 1250000);
});
