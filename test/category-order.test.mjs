// test/category-order.test.mjs
//
// 분류 목록의 순서. 핵심 계약은 하나다 —
// **드래그로 정한 순서(sortOrder)를 덮어쓰지 않는다.**
// 그 순서는 사용자가 "자주 쓰는 것을 앞으로" 옮겨 만든 것이라, 자동 정렬이
// 그 위에 덮이면 애써 맞춘 것이 매번 흐트러진다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  baseCategories, recentCategories, orderedCategories,
} from '../public/domain/category-order.js';

const cat = (category, sortOrder, over = {}) =>
  ({ keyword: '', type: '지출', category, sortOrder, ...over });
const trx = (category, date, over = {}) => ({ type: '지출', category, date, ...over });

const CATS = [
  cat('식비', 1), cat('교통비', 2), cat('의료비', 3), cat('생활용품', 4),
];

// ── 기존 순서 ────────────────────────────────────────────────

test('sortOrder 순서를 그대로 쓴다', () => {
  assert.deepEqual(
    baseCategories([cat('나중', 9), cat('먼저', 1)], '지출', ''),
    ['먼저', '나중', '확인필요'],
  );
});

test('공통 분류와 그 입주자 전용 분류를 함께 본다', () => {
  const list = baseCategories(
    [cat('공통것', 1), cat('내것', 2, { clientId: 'c1' }), cat('남의것', 3, { clientId: 'c9' })],
    '지출', 'c1');
  assert.deepEqual(list, ['공통것', '내것', '확인필요']);
});

test('유형이 다른 분류는 섞이지 않는다', () => {
  const list = baseCategories([cat('지출것', 1), cat('수입것', 2, { type: '수입' })], '지출', '');
  assert.deepEqual(list, ['지출것', '확인필요']);
});

test('확인필요는 없으면 맨 뒤에 붙는다 — 분류를 못 정했을 때의 자리다', () => {
  assert.ok(baseCategories([cat('식비', 1)], '지출', '').includes('확인필요'));
  // 이미 있으면 두 번 넣지 않는다.
  const twice = baseCategories([cat('확인필요', 1), cat('식비', 2)], '지출', '');
  assert.equal(twice.filter(c => c === '확인필요').length, 1);
});

// ── 최근 ────────────────────────────────────────────────────

test('빈도가 아니라 최근순이다', () => {
  // 교통비가 훨씬 많이 쓰였지만, 지금 입력하고 있는 것은 의료비다.
  const rows = [
    trx('교통비', '2026-08-01'), trx('교통비', '2026-08-02'), trx('교통비', '2026-08-03'),
    trx('의료비', '2026-09-10'),
  ];
  assert.deepEqual(recentCategories(rows, '지출', ['교통비', '의료비']), ['의료비', '교통비']);
});

test('같은 날은 나중에 입력한 것이 먼저다', () => {
  const rows = [
    trx('식비', '2026-09-10', { sortOrder: 1 }),
    trx('교통비', '2026-09-10', { sortOrder: 9 }),
  ];
  assert.deepEqual(recentCategories(rows, '지출', ['식비', '교통비']), ['교통비', '식비']);
});

test('확인필요는 최근으로 올리지 않는다', () => {
  // 분류를 못 정한 자리다. 그것을 위로 올리면 미분류가 늘어난다.
  const rows = [trx('확인필요', '2026-09-10'), trx('식비', '2026-09-09')];
  assert.deepEqual(recentCategories(rows, '지출', ['확인필요', '식비']), ['식비']);
});

test('지금 목록에 없는 분류는 최근에 올리지 않는다', () => {
  // 지운 분류나 다른 입주자 전용 분류를 쓰는 옛 거래가 있을 수 있다.
  const rows = [trx('사라진분류', '2026-09-10'), trx('식비', '2026-09-09')];
  assert.deepEqual(recentCategories(rows, '지출', ['식비']), ['식비']);
});

test('최근은 세 개까지 — 넘치면 「최근」이 목록이 되어 버린다', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((c, i) => trx(c, `2026-09-1${9 - i}`));
  assert.equal(recentCategories(rows, '지출', ['a', 'b', 'c', 'd', 'e']).length, 3);
});

// ── 합친 결과 ───────────────────────────────────────────────

test('최근을 얹어도 전체 목록에서 빼지 않는다', () => {
  // 익숙한 자리가 그대로 있어야 한다. 같은 분류가 두 번 보이는 것은 의도다.
  const { recent, all } = orderedCategories({
    categories: CATS, transactions: [trx('의료비', '2026-09-10')], type: '지출', clientId: '',
  });
  assert.deepEqual(recent, ['의료비']);
  assert.deepEqual(all, ['식비', '교통비', '의료비', '생활용품', '확인필요']);
});

test('전부가 최근이면 묶음을 만들지 않는다', () => {
  // 같은 목록이 두 번 보일 뿐이다.
  const cats = [cat('식비', 1)];
  const { recent } = orderedCategories({
    categories: cats, transactions: [trx('식비', '2026-09-10')], type: '지출', clientId: '',
    limit: 5,
  });
  assert.deepEqual(recent, []);
});

test('거래가 없으면 최근 묶음이 없다 — 기존 순서 그대로다', () => {
  const { recent, all } = orderedCategories({
    categories: CATS, transactions: [], type: '지출', clientId: '',
  });
  assert.deepEqual(recent, []);
  assert.deepEqual(all, ['식비', '교통비', '의료비', '생활용품', '확인필요']);
});

test('빈 입력에도 깨지지 않는다', () => {
  for (const input of [undefined, {}, { categories: null, transactions: null }]) {
    const r = orderedCategories(input);
    assert.deepEqual(r.recent, []);
    assert.deepEqual(r.all, ['확인필요']);
  }
});
