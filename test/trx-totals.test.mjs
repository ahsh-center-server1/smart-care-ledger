// test/trx-totals.test.mjs
//
// 「합계 제외」 — 자산이동·취소 유형을 대신하는 표시 한 칸.
//
// 이 파일이 지키는 것은 셋이다.
//   1. 표시된 거래는 수입/지출 합계에서 빠지고, **잔액에는 들어간다.**
//      그 둘이 다르다는 것이 이 표시의 존재 이유다.
//   2. 이미 저장된 자산이동·취소는 같은 뜻으로 읽힌다. 결재가 끝난 달의
//      숫자가 배포 때문에 달라지면 안 된다.
//   3. 집계하는 자리가 **하나도 빠짐없이** 같은 함수를 쓴다. 열한 곳에 같은
//      조건이 손으로 적혀 있었고, 한 곳만 빠뜨리면 보고서 합계와 대시보드
//      카드가 달라진다 — 결재가 올라간 뒤에야 눈에 띄는 차이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { countsInTotals, isExcludedFromTotals } from '../public/domain/trx-totals.js';
import { sumIncomeExpense, calcAccountBalance } from '../public/services/balance.js';
import { computeMonthlySummary } from '../public/domain/monthly-summary.js';

test('평범한 수입·지출은 합계에 들어간다', () => {
  assert.equal(countsInTotals({ type: '수입', amountIn: 100 }), true);
  assert.equal(countsInTotals({ type: '지출', amountOut: 100 }), true);
  assert.equal(countsInTotals({ type: '지출' }), true);
});

test('표시된 거래는 합계에서 빠진다', () => {
  assert.equal(countsInTotals({ type: '지출', excludeFromTotals: true }), false);
  assert.equal(isExcludedFromTotals({ type: '지출', excludeFromTotals: true }), true);
});

test('구형 자산이동·취소는 같은 뜻으로 읽는다', () => {
  // 과거 장부를 고쳐 쓰지 않고도 같은 답이 나와야 한다.
  assert.equal(countsInTotals({ type: '자산이동' }), false);
  assert.equal(countsInTotals({ type: '취소' }), false);
});

test('거짓 같은 값으로 제외되지 않는다', () => {
  // 없는 필드, false, 빈 문자열은 전부 "제외 아님"이다. `'false'` 문자열이
  // 제외로 읽히면 저장 경로 한 곳만 문자열을 보내도 합계가 조용히 어긋난다.
  for (const v of [undefined, null, false, 0, '', 'false', 'true', 1]) {
    assert.equal(countsInTotals({ type: '지출', excludeFromTotals: v }), true,
      `excludeFromTotals=${JSON.stringify(v)} 가 제외로 읽혔습니다`);
  }
});

test('없는 거래는 합계에 넣지 않는다', () => {
  assert.equal(countsInTotals(null), false);
  assert.equal(isExcludedFromTotals(null), false);
});

// ── 합계와 잔액이 다르게 움직인다 ───────────────────────────

const acc = { id: 'a1', initialBalance: 100000, initialBalanceDate: '2026-01-31' };
const t = (o) => ({ accountId: 'a1', date: '2026-02-10', ...o });

test('제외된 거래도 잔액에는 들어간다', () => {
  // 계좌 간 이동은 수입도 지출도 아니지만 통장에서는 돈이 실제로 움직인다.
  const trx = [t({ type: '지출', amountOut: 20000, excludeFromTotals: true })];
  assert.deepEqual(sumIncomeExpense(trx), { totalIn: 0, totalOut: 0 });
  assert.equal(calcAccountBalance(acc, trx), 80000);
});

test('취소도 이제 잔액에 반영된다', () => {
  // 사용자의 말: "취소 처리하면 환불되는 금액이 있으니 잔액에 반영해줘."
  // 예전에는 건너뛰었고, 그래서 통장 잔액과 장부가 그 금액만큼 어긋났다.
  const trx = [t({ type: '취소', amountOut: 7000 })];
  assert.equal(calcAccountBalance(acc, trx), 93000);
  assert.deepEqual(sumIncomeExpense(trx), { totalIn: 0, totalOut: 0 });
});

test('당월 요약도 같은 기준을 쓴다', () => {
  // 대시보드 카드와 보고서 합계가 갈라지면 아무도 어느 쪽을 믿을지 모른다.
  const rows = [
    t({ type: '수입', amountIn: 10000 }),
    t({ type: '지출', amountOut: 3000 }),
    t({ type: '지출', amountOut: 50000, excludeFromTotals: true }),
    t({ type: '자산이동', amountOut: 70000 }),
  ];
  const s = computeMonthlySummary(rows);
  assert.equal(s.inc, 10000);
  assert.equal(s.exp, 3000);
  assert.equal(s.count, 4, '제외된 거래도 건수에는 들어간다');
});

// ── 집행 지점 ───────────────────────────────────────────────

test('집계하는 자리가 조건을 손으로 적지 않는다', () => {
  // 원래 문제. `type==='자산이동'||type==='취소'` 가 열한 곳에 흩어져 있었다.
  const offenders = [];
  for (const dir of ['modules', 'services', 'domain', 'utils']) {
    for (const f of readdirSync(new URL(`../public/${dir}/`, import.meta.url))) {
      if (!f.endsWith('.js')) continue;
      const rel = `public/${dir}/${f}`;
      if (rel === 'public/domain/trx-totals.js') continue;
      const lines = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
        .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
      // 한 줄에서 **두 유형을 모두 같음/다름으로 비교하는 것**이 집계 조건이다.
      // 유형 하나만 보는 것(뱃지를 그릴 때)이나 startsWith 는 집계가 아니다.
      const compares = (l, v) => new RegExp(`(===|!==)\\s*'${v}'`).test(l);
      if (lines.some(l => compares(l, '자산이동') && compares(l, '취소'))) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [],
    '집계 조건을 손으로 적은 파일이 있습니다. domain/trx-totals.js 의 countsInTotals 를 쓰세요');
});

test('잔액식은 이제 유형을 보지 않는다', () => {
  // 모든 거래가 잔액에 들어가므로 유형은 잔액에 무관하다. 그래서
  // BALANCE_FIELDS 에서도 빠졌다 — 남겨 두면 유형만 고쳐도 계좌 전체
  // 재계산이 돌아 읽기가 낭비된다.
  for (const f of ['public/services/balance.js', 'functions/balance.cjs']) {
    const code = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const fn = code.slice(code.indexOf('calcAccountBalance(account, transactions)'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(!/t\.type/.test(body), `${f} 의 잔액식이 아직 유형을 봅니다`);
    assert.ok(!/'type'/.test(code.slice(code.indexOf('BALANCE_FIELDS'), code.indexOf('BALANCE_FIELDS') + 120)),
      `${f} 의 BALANCE_FIELDS 에 type 이 남아 있습니다`);
  }
});

test('저장·수정 경로가 excludeFromTotals 를 허용한다', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const create = rules.slice(rules.indexOf('function transactionCreateFieldsOk'));
  assert.ok(/'excludeFromTotals'/.test(create.slice(0, 500)), '생성에서 막힙니다');
  const update = rules.slice(rules.indexOf('function transactionUpdateFieldsOk'));
  assert.ok(/'excludeFromTotals'/.test(update.slice(0, 600)), '수정에서 막힙니다');
});

test('새 거래에서 자산이동·취소를 고를 수 없다', () => {
  // 고를 수 있으면 유형이 넷인 채로 남고, 자산이동은 링크된 짝까지 새로 만든다.
  const src = readFileSync(new URL('../public/modules/modals.js', import.meta.url), 'utf8');
  const form = src.slice(src.indexOf('export function renderTrxForm'));
  const at = form.indexOf('id="f-type"');
  const select = form.slice(at, form.indexOf('</select>', at));
  assert.ok(!/value="자산이동"/.test(select), '새 입력에 자산이동이 남아 있습니다');
  assert.ok(!/value="취소-/.test(select), '새 입력에 취소가 남아 있습니다');
  // 다만 그렇게 저장된 거래를 열었을 때는 보여야 한다 — 목록에 없으면
  // select 가 「지출」로 떨어지고 저장을 누르는 순간 짝이 어긋난다.
  assert.ok(/legacyTypeOption\(/.test(select), '구형 거래를 열면 유형이 「지출」로 바뀝니다');
});
