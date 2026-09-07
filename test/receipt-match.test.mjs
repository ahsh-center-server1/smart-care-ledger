// test/receipt-match.test.mjs
//
// 영수증 ↔ 거래 매칭.
//
// 여기서 고정하는 것은 「**애매하면 자동으로 붙이지 않는다**」다.
// 잘못 붙은 증빙은 다른 사람의 지출에 남의 영수증이 달리는 결과가 되고,
// 결재 서류가 되는 자료에서 그것은 용납되지 않는다. 그래서 거짓 자동첨부
// (false auto)가 이 모듈의 유일한 치명적 오류다 — 아래 테스트 절반이
// 「자동으로 붙지 않아야 하는 경우」다.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchReceipt, classifyMerchant, dayDiff, DATE_TOLERANCE_DAYS,
} from '../public/domain/receipt-match.js';

const trx = (over = {}) => ({
  id: 't1', clientId: 'c1', accountId: 'a1', date: '2026-09-07',
  type: '지출', amountIn: 0, amountOut: 12000, description: '이마트 성수점',
  ...over,
});

const draft = (over = {}) => ({
  date: '2026-09-07', merchant: '(주)이마트 성수점', amount: 12000,
  isCancellation: false, confidence: 0.9, items: [], cardLast4: '',
  ...over,
});

test('날짜 차이 계산', () => {
  assert.equal(dayDiff('2026-09-07', '2026-09-07'), 0);
  assert.equal(dayDiff('2026-09-07', '2026-09-10'), 3);
  assert.equal(dayDiff('2026-09-10', '2026-09-07'), 3);
  assert.equal(dayDiff('2026-09-01', '2026-08-31'), 1);   // 월 경계
  assert.equal(dayDiff('2027-01-01', '2026-12-31'), 1);   // 연 경계
  assert.equal(dayDiff('', '2026-09-07'), null);
  assert.equal(dayDiff(null, null), null);
});

// ── 자동 첨부가 되어야 하는 경우 ───────────────────────────────
test('금액·날짜·상호명이 모두 맞으면 자동으로 붙인다', () => {
  const r = matchReceipt(draft(), [trx()]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.autoMatch.trx.id, 't1');
  assert.ok(r.autoMatch.reasons.some(x => x.includes('금액 일치')));
  assert.ok(r.autoMatch.reasons.some(x => x.includes('같은 날짜')));
});

test('날짜가 허용 범위 안이면 자동으로 붙일 수 있다', () => {
  const r = matchReceipt(draft({ date: '2026-09-09' }), [trx()]);
  assert.equal(r.decision, 'auto');
  assert.ok(r.autoMatch.reasons.some(x => x.includes('2일 차이')));
});

// ── 자동으로 붙어서는 안 되는 경우 (핵심) ──────────────────────
test('같은 날 같은 금액 거래가 둘이면 자동으로 붙이지 않는다', () => {
  // 실제로 생긴다 — 같은 가게에서 두 번 사거나, 같은 금액의 다른 지출.
  // 어느 쪽인지 알 수 없으므로 사람이 골라야 한다.
  const r = matchReceipt(draft(), [
    trx({ id: 't1' }),
    trx({ id: 't2', description: '이마트 성수점' }),
  ]);
  assert.equal(r.decision, 'choose');
  assert.equal(r.autoMatch, null);
  assert.equal(r.matches.length, 2);
});

test('금액이 다르면 후보가 아니다', () => {
  const r = matchReceipt(draft({ amount: 12000 }), [trx({ amountOut: 15000 })]);
  assert.equal(r.decision, 'none');
  assert.equal(r.matches.length, 0);
});

test('금액만 같고 날짜가 멀면 자동으로 붙이지 않는다', () => {
  // 매달 같은 금액이 나가는 고정지출에서 흔하다.
  const r = matchReceipt(draft({ date: '2026-08-07' }), [trx()]);
  assert.equal(r.decision, 'choose');
  assert.equal(r.autoMatch, null);
  assert.ok(r.matches[0].reasons.some(x => x.includes('먼 날짜')));
});

test('영수증 날짜를 못 읽었으면 자동으로 붙이지 않는다', () => {
  const r = matchReceipt(draft({ date: '' }), [trx()]);
  assert.equal(r.decision, 'choose');
  assert.ok(r.matches[0].reasons.some(x => x.includes('날짜 확인 불가')));
});

test('금액을 못 읽었으면 매칭을 시도하지 않는다', () => {
  const r = matchReceipt(draft({ amount: null }), [trx()]);
  assert.equal(r.decision, 'none');
  assert.equal(r.matches.length, 0);
});

test('이미 증빙이 붙은 거래는 후보가 아니다 — 덮어쓰면 원본이 사라진다', () => {
  const r = matchReceipt(draft(), [trx({ receiptUrl: 'https://x/y.jpg' })]);
  assert.equal(r.decision, 'none');
});

test('취소 거래에는 붙이지 않는다', () => {
  const r = matchReceipt(draft(), [trx({ type: '취소' })]);
  assert.equal(r.decision, 'none');
});

test('후보가 없으면 새 거래로 만들라고 한다', () => {
  assert.equal(matchReceipt(draft(), []).decision, 'none');
  assert.equal(matchReceipt(draft(), null).decision, 'none');
});

test('초안이 없으면 깨지지 않는다', () => {
  assert.equal(matchReceipt(null, [trx()]).decision, 'none');
  assert.equal(matchReceipt(undefined, [trx()]).decision, 'none');
  assert.equal(matchReceipt({}, [trx()]).decision, 'none');
});

// ── 점수·정렬 ──────────────────────────────────────────────────
test('상호명이 겹치면 점수가 높다', () => {
  const r = matchReceipt(draft({ date: '2026-09-09' }), [
    trx({ id: 'noname', description: '현금 인출' }),
    trx({ id: 'named', description: '이마트 성수점' }),
  ]);
  // 둘 다 금액·날짜가 같으니 상호명이 결정한다.
  assert.equal(r.matches[0].trx.id, 'named');
});

test('선택한 계좌의 거래를 우선한다', () => {
  const r = matchReceipt(draft({ accountId: 'a2', date: '2026-09-09' }), [
    trx({ id: 'other', accountId: 'a1', description: '현금' }),
    trx({ id: 'picked', accountId: 'a2', description: '현금' }),
  ]);
  assert.equal(r.matches[0].trx.id, 'picked');
  assert.ok(r.matches[0].reasons.some(x => x.includes('선택한 계좌')));
});

test('후보 수를 제한한다', () => {
  const many = Array.from({ length: 10 }, (_, i) => trx({ id: 't' + i, description: '현금' }));
  assert.equal(matchReceipt(draft(), many).matches.length, 3);
  assert.equal(matchReceipt(draft(), many, { limit: 5 }).matches.length, 5);
});

test('환불 영수증은 입금 거래에 붙을 수 있다', () => {
  const r = matchReceipt(
    draft({ isCancellation: true, amount: -5000 }),
    [trx({ type: '수입', amountOut: 0, amountIn: 5000, description: '이마트 환불' })],
  );
  assert.equal(r.decision, 'auto');
});

test('음수 지출(환불 처리된 거래)도 금액으로 맞춘다', () => {
  const r = matchReceipt(draft({ amount: -5000 }), [trx({ amountOut: -5000 })]);
  assert.equal(r.decision, 'auto');
});

test('허용 날짜 범위 상수가 3일이다', () => {
  // 카드 승인일과 영수증 날짜가 어긋나는 폭을 반영한 값이다.
  assert.equal(DATE_TOLERANCE_DAYS, 3);
  // 경계: 3일은 자동, 4일은 아니다
  assert.equal(matchReceipt(draft({ date: '2026-09-10' }), [trx()]).decision, 'auto');
  assert.equal(matchReceipt(draft({ date: '2026-09-11' }), [trx()]).decision, 'choose');
});

// ── 카테고리 추정 (모델이 아니라 사용자 규칙) ──────────────────
test('자동분류 규칙으로 카테고리를 고른다', () => {
  const rules = [
    { keyword: '이마트', category: '생필품', subcategory: '' },
    { keyword: '버스', category: '교통비', subcategory: '' },
  ];
  const hit = classifyMerchant('(주)이마트 성수점', rules);
  assert.equal(hit.category, '생필품');
  assert.equal(hit.matchedKeyword, '이마트');
});

test('입주자 전용 규칙이 공통 규칙을 이긴다', () => {
  // 설정 화면의 동작과 같아야 한다 — 두 곳이 다르게 판정하면 혼란스럽다.
  const rules = [
    { keyword: '이마트', category: '생필품' },
    { keyword: '이마트', category: '식비', clientId: 'c1' },
  ];
  assert.equal(classifyMerchant('이마트', rules, 'c1').category, '식비');
  assert.equal(classifyMerchant('이마트', rules, 'c2').category, '생필품');
  assert.equal(classifyMerchant('이마트', rules).category, '생필품');
});

test('맞는 규칙이 없으면 null — 임의로 분류하지 않는다', () => {
  const rules = [{ keyword: '이마트', category: '생필품' }];
  assert.equal(classifyMerchant('처음보는가게', rules), null);
  assert.equal(classifyMerchant('', rules), null);
  assert.equal(classifyMerchant(null, rules), null);
  assert.equal(classifyMerchant('이마트', []), null);
  assert.equal(classifyMerchant('이마트', null), null);
});

test('keyword가 없는 규칙은 무시한다', () => {
  // categories 컬렉션에는 분류 정의(keyword 없음)와 규칙(keyword 있음)이
  // 함께 들어 있다. 분류 정의를 규칙으로 쓰면 아무 상호명에나 걸린다.
  const rules = [{ keyword: '', category: '식비' }, { category: '기타' }];
  assert.equal(classifyMerchant('아무거나', rules), null);
});
