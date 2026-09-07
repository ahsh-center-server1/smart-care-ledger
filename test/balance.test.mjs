import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcAccountBalance, calcAccountBalanceAsOf, calcBalances, sumIncomeExpense,
  affectsBalance, BALANCE_FIELDS,
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

// ─────────────────────────────────────────────────────────────
// 브라우저(ESM)와 서버(CJS) 구현이 갈라지지 않는지 검증한다.
//
// 파일이 두 벌인 이유: 브라우저는 public/ 아래 ESM만 불러올 수 있고,
// Cloud Functions 배포 번들에는 functions/ 밖의 파일이 포함되지 않는다.
// 한쪽만 고치면 아래 테스트가 실패하므로 드리프트를 놓칠 수 없다.
// ─────────────────────────────────────────────────────────────
import { createRequire } from 'node:module';
const {
  calcAccountBalance: serverCalc,
  affectsBalance: serverAffects,
  BALANCE_FIELDS: serverFields,
} = createRequire(import.meta.url)('../functions/balance.cjs');

test('서버(CJS)와 브라우저(ESM) 잔액 계산이 모든 경우에 일치한다', () => {
  const 계좌들 = [
    acc(),
    acc({ initialBalanceDate: '' }),
    acc({ initialBalance: 0 }),
    acc({ initialBalance: '250000' }),
    acc({ id: 'other' }),
  ];
  const 거래들 = [
    [],
    [t({ type: '수입', amountIn: 50000 })],
    [t({ type: '지출', amountOut: 30000 })],
    [t({ type: '취소', amountOut: 70000 })],
    [t({ type: '자산이동', amountOut: 20000 })],
    [t({ type: '지출', amountOut: -5000 })],
    [t({ date: '2026-01-15', amountOut: 9999 })],
    [t({ date: '2026-01-31', amountOut: 5000 })],
    [t({ date: '2026-02-01', amountOut: 5000 })],
    [t({ accountId: 'acc2', amountOut: 999999 }), t({ amountOut: 10000 })],
    [t({ type: '수입', amountIn: '50000' }), t({ type: '지출', amountOut: '20000' })],
    [{ accountId: 'acc1', date: '2026-02-10', type: '지출' }],
    null,
  ];

  let 비교횟수 = 0;
  for (const a of 계좌들) {
    for (const trx of 거래들) {
      const mine = calcAccountBalance(a, trx);
      const theirs = serverCalc(a, trx);
      assert.equal(
        theirs, mine,
        `불일치: 계좌 ${JSON.stringify(a)} / 거래 ${JSON.stringify(trx)}`
      );
      비교횟수++;
    }
  }
  assert.ok(비교횟수 >= 60, `비교 조합이 너무 적습니다 (${비교횟수}건)`);
});

test('서버 구현도 계좌가 null이면 0을 반환한다', () => {
  assert.equal(serverCalc(null, []), 0);
});

// ─────────────────────────────────────────────────────────────
// affectsBalance — 잔액 재계산이 필요한 변경인지 판정
//
// 이 함수가 false를 잘못 돌려주면 잔액이 조용히 낡은 값으로 남는다.
// 그래서 「바뀌었는데 false」가 절대 없어야 한다(반대 방향은 낭비일 뿐 안전).
// 아래 테스트는 잔액식이 읽는 다섯 필드 각각을 실제로 감지하는지 확인한다.
// ─────────────────────────────────────────────────────────────
test('잔액과 무관한 필드만 바뀌면 재계산이 필요 없다', () => {
  const base = t({ type: '지출', amountOut: 5000 });
  // 영수증 첨부 · 카테고리 수정 · 드래그 순서 변경 · 내용 수정 — 가장 흔한 쓰기들
  assert.equal(affectsBalance(base, { ...base, receiptUrl: 'https://x/y.jpg' }), false);
  assert.equal(affectsBalance(base, { ...base, category: '식비' }), false);
  assert.equal(affectsBalance(base, { ...base, sortOrder: 42 }), false);
  assert.equal(affectsBalance(base, { ...base, description: '수정된 내용' }), false);
  assert.equal(affectsBalance(base, { ...base, receiptMissing: true }), false);
});

test('잔액식이 읽는 다섯 필드는 모두 감지한다', () => {
  const base = t({ type: '지출', amountOut: 5000 });
  const 변경 = {
    accountId: 'acc-other',
    date: '2026-03-01',
    type: '취소',
    amountIn: 1234,
    amountOut: 9999,
  };
  for (const f of BALANCE_FIELDS) {
    assert.equal(
      affectsBalance(base, { ...base, [f]: 변경[f] }), true,
      `${f} 변경을 감지하지 못했다 — 잔액이 낡은 값으로 남는다`,
    );
  }
});

test('생성과 삭제는 항상 재계산이 필요하다', () => {
  const trx = t({ type: '지출', amountOut: 5000 });
  assert.equal(affectsBalance(null, trx), true);   // 생성
  assert.equal(affectsBalance(trx, null), true);   // 삭제
  assert.equal(affectsBalance(null, null), true);
});

test('문자열 금액과 숫자 금액은 같은 값으로 본다', () => {
  // 엑셀 파서는 '50000'(문자열), 수기 입력은 50000(숫자)을 넣는다.
  // 잔액식이 Number()로 강제하므로 값이 같으면 재계산은 낭비다.
  const a = t({ type: '수입', amountIn: 50000, amountOut: 0 });
  const b = t({ type: '수입', amountIn: '50000', amountOut: '0' });
  assert.equal(affectsBalance(a, b), false);
});

test('0과 필드 없음은 같은 값으로 본다', () => {
  const a = t({ type: '지출', amountOut: 5000, amountIn: 0 });
  const b = { accountId: 'acc1', date: '2026-02-10', type: '지출', amountOut: 5000 };
  assert.equal(affectsBalance(a, b), false);
});

test('affectsBalance가 놓친 변경은 없다 — 잔액이 바뀌면 반드시 true', () => {
  // 무작위 조합으로 「잔액은 달라졌는데 affectsBalance가 false」인 경우를 찾는다.
  const a = acc();
  const 값들 = {
    accountId: ['acc1', 'acc2'],
    date: ['2026-01-15', '2026-01-31', '2026-02-01', '2026-03-09'],
    type: ['수입', '지출', '자산이동', '취소'],
    amountIn: [0, 1000, '1000', 7777],
    amountOut: [0, 500, '500', -5000],
  };
  let 검사 = 0;
  for (const accountId of 값들.accountId)
    for (const date of 값들.date)
      for (const type of 값들.type)
        for (const amountIn of 값들.amountIn)
          for (const amountOut of 값들.amountOut) {
            const before = t({ type: '지출', amountOut: 5000 });
            const after = { ...before, accountId, date, type, amountIn, amountOut };
            const 잔액변화 =
              calcAccountBalance(a, [before]) !== calcAccountBalance(a, [after]);
            if (잔액변화) {
              assert.equal(
                affectsBalance(before, after), true,
                `잔액이 바뀌었는데 감지 실패: ${JSON.stringify(after)}`,
              );
            }
            검사++;
          }
  assert.ok(검사 >= 500, `조합이 너무 적습니다 (${검사}건)`);
});

test('서버(CJS)와 브라우저(ESM)의 affectsBalance가 일치한다', () => {
  assert.deepEqual(serverFields, BALANCE_FIELDS);
  const 후보 = [
    null,
    t({ type: '지출', amountOut: 5000 }),
    t({ type: '지출', amountOut: '5000' }),
    t({ type: '수입', amountIn: 5000, amountOut: 0 }),
    t({ type: '취소', amountOut: 5000 }),
    t({ date: '2026-03-01', amountOut: 5000 }),
    t({ accountId: 'acc2', amountOut: 5000 }),
    { ...t({ amountOut: 5000 }), receiptUrl: 'x' },
    { accountId: 'acc1', date: '2026-02-10', type: '지출' },
  ];
  let 비교 = 0;
  for (const b of 후보) {
    for (const a2 of 후보) {
      assert.equal(
        serverAffects(b, a2), affectsBalance(b, a2),
        `불일치: before=${JSON.stringify(b)} after=${JSON.stringify(a2)}`,
      );
      비교++;
    }
  }
  assert.ok(비교 >= 60, `비교 조합이 너무 적습니다 (${비교}건)`);
});
