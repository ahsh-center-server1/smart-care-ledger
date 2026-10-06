// test/report-inline-edit.test.mjs
//
// 칸 하나만 고칠 때 **무엇을 보내는가.**
//
// 금액을 고치면 유형이 따라와야 한다. 이 규칙이 조용히 어긋나면 한 거래가
// 수입이면서 지출인 채로 남고, 합계와 잔액이 그때부터 서로 다른 말을 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldPatch, INLINE_FIELDS } from '../public/modules/report-inline-edit.js';

const TRX = {
  id: 't1', clientId: 'c1', accountId: 'a1', date: '2026-09-05',
  type: '지출', amountIn: 0, amountOut: 5000, description: '김밥천국',
  createdBy: 'staff-owner', sortOrder: 3, receiptUrl: 'x',
};

test('고치는 칸은 넷이다', () => {
  assert.deepEqual([...INLINE_FIELDS].sort(), ['amountIn', 'amountOut', 'date', 'description'].sort());
});

test('바뀐 칸과 판정에 필요한 것만 보낸다', () => {
  // sortOrder·receiptUrl 처럼 안 바뀐 것을 실어 보내면 규칙이 허용하는 필드
  // 목록을 넘길 위험만 늘고 얻는 것이 없다.
  const p = fieldPatch(TRX, 'description', '김밥천국 본점');
  assert.deepEqual(Object.keys(p).sort(),
    ['accountId', 'clientId', 'createdBy', 'date', 'description', 'id'].sort());
  assert.equal(p.description, '김밥천국 본점');
  assert.equal(p.date, TRX.date, '안 고친 날짜는 원래 값이어야 합니다');
});

test('날짜를 고치면 보내는 date 가 새 날짜다', () => {
  // saveTrx 는 이 date 로 잠금을 본다 — 옛 날짜를 보내면 잠긴 달로 옮길 수 있다.
  const p = fieldPatch(TRX, 'date', '2026-10-01');
  assert.equal(p.date, '2026-10-01');
});

test('수입을 넣으면 지출이 비고 유형이 따라온다', () => {
  const p = fieldPatch(TRX, 'amountIn', 7000);
  assert.equal(p.amountIn, 7000);
  assert.equal(p.amountOut, 0, '반대쪽이 남으면 수입이면서 지출인 거래가 됩니다');
  assert.equal(p.type, '수입');
});

test('지출을 고치면 수입이 비고 유형이 지출이다', () => {
  const p = fieldPatch({ ...TRX, type: '수입', amountIn: 3000, amountOut: 0 }, 'amountOut', 900);
  assert.equal(p.amountOut, 900);
  assert.equal(p.amountIn, 0);
  assert.equal(p.type, '지출');
});

test('구형 유형(자산이동·취소)은 유형을 건드리지 않는다', () => {
  // 그 이름이 말하는 뜻이 따로 있고(§6), 자산이동은 짝이 있는 거래다.
  for (const type of ['자산이동', '취소']) {
    const p = fieldPatch({ ...TRX, type }, 'amountOut', 1200);
    assert.equal(p.amountOut, 1200);
    assert.equal(p.type, undefined, `${type} 의 유형이 바뀝니다`);
    assert.equal(p.amountIn, undefined, `${type} 의 반대쪽을 건드립니다`);
  }
});

test('createdBy 가 없으면 넣지 않는다 — undefined 는 Firestore 가 거절한다', () => {
  const p = fieldPatch({ ...TRX, createdBy: '' }, 'description', 'x');
  assert.ok(!('createdBy' in p));
});

// ── 저장하는 것은 Enter 하나다 ──────────────────────────────────────────
//
// blur 로도 저장하면, 표를 정리하다 다음 칸을 누르는 것만으로 손대던 값이
// 들어간다. 사용자가 명시적으로 되돌려 달라고 한 규칙이라 (되돌릴 수도 있다고
// 했다) 소스에 못을 박아 둔다 — 조용히 옛 동작으로 돌아가면 아무도 모른다.
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../public/modules/report-inline-edit.js', import.meta.url), 'utf8');

test('칸을 벗어나면(blur) 취소한다 — 저장이 아니다', () => {
  assert.match(SRC, /addEventListener\('blur',\s*restore\)/,
    'blur 는 restore(취소)여야 합니다');
  assert.doesNotMatch(SRC, /addEventListener\('blur',\s*save\)/,
    'blur 로 저장하면 안 고치려던 값이 들어갑니다');
});

test('Enter 는 저장, Esc 는 취소', () => {
  assert.match(SRC, /e\.key === 'Enter'[^\n]*save\(\)/);
  assert.match(SRC, /e\.key === 'Escape'[^\n]*restore\(\)/);
});
