// test/month-end-balance.test.mjs
//
// 계좌의 월말 잔액 색인.
//
// 왜 생겼나
//   보고서 「계좌 현황」은 전월 말 잔액과 당월 말 잔액을 보여준다. 잔액은
//   기준일부터의 누적이라, 그 두 숫자를 구하려고 **그 입주자의 전체 이력**을
//   읽고 있었다. 보고서를 한 번 열 때마다, 그리고 **해가 갈수록 더** —
//   1년치면 1,080건, 2년치면 2,160건. 쓰지도 않는데 비용만 자란다.
//
//   월말 잔액은 거래가 바뀔 때만 바뀌고, 그때 서버 트리거가 어차피 그 계좌의
//   거래를 전부 읽는다. 그 자리에서 함께 적으면 추가 읽기가 없다.
//
// 이 파일이 지키는 것
//   1. 색인의 값이 직접 계산과 **정확히 같다** — 결재 문서에 찍히는 숫자다
//   2. 모르면 **null 이라고 말한다** — 0으로 답하면 「잔액 0원」이 인쇄된다
//   3. 서버(CJS)와 브라우저(ESM) 두 벌이 같은 답을 낸다

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  buildMonthEndBalances, monthEndBalanceOf, calcAccountBalanceAsOf,
} from '../public/services/balance.js';

const server = createRequire(import.meta.url)('../functions/balance.cjs');

const acc = (o = {}) => ({ id: 'a1', initialBalance: 100000, initialBalanceDate: '2026-01-31', ...o });
const t = (date, o = {}) => ({ accountId: 'a1', date, amountIn: 0, amountOut: 0, ...o });

test('거래가 있는 달마다 말잔을 적는다', () => {
  const idx = buildMonthEndBalances(acc(), [
    t('2026-02-10', { amountOut: 20000 }),
    t('2026-02-20', { amountIn: 5000 }),
    t('2026-03-05', { amountOut: 1000 }),
  ]);
  assert.equal(idx['2026-01'], 100000, '기준일의 달은 기초잔액이어야 합니다');
  assert.equal(idx['2026-02'], 85000);
  assert.equal(idx['2026-03'], 84000);
});

test('거래가 없는 달도 빠짐없이 채운다', () => {
  // 빈칸이 「거래가 없었다」인지 「계산하지 않았다」인지 구분되지 않으면
  // 폴백 판정을 할 수 없다.
  const idx = buildMonthEndBalances(acc(), [
    t('2026-02-10', { amountOut: 20000 }),
    t('2026-06-01', { amountOut: 1000 }),
  ]);
  for (const ym of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
    assert.ok(ym in idx, `${ym} 이 비었습니다`);
  }
  assert.equal(idx['2026-04'], 80000, '거래 없는 달은 앞 달 잔액 그대로여야 합니다');
});

test('연말을 넘어간다', () => {
  const idx = buildMonthEndBalances(acc({ initialBalanceDate: '2025-11-30' }), [
    t('2025-12-10', { amountOut: 1000 }),
    t('2026-02-10', { amountOut: 1000 }),
  ]);
  assert.deepEqual(Object.keys(idx).sort(),
    ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(idx['2026-01'], 99000);
});

test('기준일 당일 거래는 기초잔액에 이미 들어 있다', () => {
  // calcAccountBalance 와 같은 경계다. 어긋나면 그 계좌만 한 건 어긋난다.
  const idx = buildMonthEndBalances(acc(), [t('2026-01-31', { amountOut: 50000 })]);
  assert.equal(idx['2026-01'], 100000);
});

test('기준일도 거래도 없으면 빈 색인 — 지어내지 않는다', () => {
  assert.deepEqual(buildMonthEndBalances(acc({ initialBalanceDate: '' }), []), {});
  assert.deepEqual(buildMonthEndBalances(null, []), {});
});

test('다른 계좌의 거래는 섞이지 않는다', () => {
  const idx = buildMonthEndBalances(acc(), [
    t('2026-02-10', { amountOut: 20000 }),
    { accountId: 'a2', date: '2026-02-11', amountOut: 999999 },
  ]);
  assert.equal(idx['2026-02'], 80000);
});

test('색인의 값이 직접 계산과 정확히 같다', () => {
  // 이 둘이 갈라지면 보고서와 대시보드가 다른 잔액을 말한다.
  const a = acc();
  const trx = [
    t('2026-02-10', { amountOut: 20000 }),
    t('2026-02-15', { amountIn: 7000 }),
    t('2026-04-01', { amountOut: -3000 }),   // 환불 — 잔액이 는다
    t('2026-07-09', { amountOut: 1200 }),
  ];
  const idx = buildMonthEndBalances(a, trx);
  const lastDay = { '01': 31, '02': 28, '03': 31, '04': 30, '05': 31, '06': 30, '07': 31 };
  for (const ym of Object.keys(idx)) {
    const end = `${ym}-${lastDay[ym.slice(5)]}`;
    assert.equal(idx[ym], calcAccountBalanceAsOf(a, trx, end), `${ym} 이 어긋납니다`);
  }
});

// ── 모를 때는 모른다고 말한다 ───────────────────────────────

test('색인이 없으면 null — 0이 아니다', () => {
  // 0을 돌려주면 백필 전 계좌의 보고서에 「잔액 0원」이 그대로 인쇄된다.
  assert.equal(monthEndBalanceOf(acc(), '2026-03'), null);
  assert.equal(monthEndBalanceOf(acc({ monthEndBalances: {} }), '2026-03'), null);
  assert.equal(monthEndBalanceOf(null, '2026-03'), null);
  assert.equal(monthEndBalanceOf(acc(), ''), null);
});

test('색인 뒤의 달은 마지막 값이 이어진다', () => {
  // 마지막 거래 이후로는 잔액이 변할 수 없다. 여기서 null 을 주면
  // 거래가 뜸한 계좌마다 전체 이력을 다시 읽는다.
  const a = acc({ monthEndBalances: { '2026-01': 100000, '2026-02': 80000 } });
  assert.equal(monthEndBalanceOf(a, '2026-09'), 80000);
});

test('색인 앞의 달은 기초잔액이다', () => {
  const a = acc({ monthEndBalances: { '2026-01': 100000, '2026-02': 80000 } });
  assert.equal(monthEndBalanceOf(a, '2025-12'), 100000);
});

test('중간에 구멍이 있으면 null — 깨진 색인을 믿지 않는다', () => {
  const a = acc({ monthEndBalances: { '2026-01': 100000, '2026-05': 80000 } });
  assert.equal(monthEndBalanceOf(a, '2026-03'), null);
});

test('0원인 달을 「모른다」로 읽지 않는다', () => {
  // ?? 폴백을 쓰므로 0과 null 을 정확히 구분해야 한다.
  const a = acc({ monthEndBalances: { '2026-01': 0 } });
  assert.equal(monthEndBalanceOf(a, '2026-01'), 0);
});

// ── 서버 사본 ───────────────────────────────────────────────

test('서버(CJS)와 브라우저(ESM)가 같은 색인을 만든다', () => {
  const 계좌들 = [acc(), acc({ initialBalanceDate: '' }), acc({ initialBalance: 0 }),
    acc({ initialBalance: '250000' })];
  const 거래들 = [
    [],
    [t('2026-02-10', { amountOut: 20000 })],
    [t('2026-01-31', { amountOut: 1 }), t('2026-03-01', { amountIn: 2 }),
      t('2027-01-05', { amountOut: 3 })],
  ];
  for (const a of 계좌들) {
    for (const trx of 거래들) {
      assert.deepEqual(server.buildMonthEndBalances(a, trx), buildMonthEndBalances(a, trx),
        `어긋납니다: ${JSON.stringify(a)} / ${JSON.stringify(trx)}`);
      const withIdx = { ...a, monthEndBalances: buildMonthEndBalances(a, trx) };
      for (const ym of ['2025-12', '2026-02', '2026-04', '2028-01']) {
        assert.equal(server.monthEndBalanceOf(withIdx, ym), monthEndBalanceOf(withIdx, ym),
          `조회가 어긋납니다: ${ym}`);
      }
    }
  }
});

// ── 집행 지점 ───────────────────────────────────────────────

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('서버 트리거가 잔액과 함께 색인을 쓴다', () => {
  // 안 쓰면 색인이 영원히 비고, 보고서는 조용히 예전 비용으로 돌아간다 —
  // 느려지는 것이 아니라 비싸지는 것이라 아무도 눈치채지 못한다.
  const src = read('functions/ledger-triggers.js');
  const fn = src.slice(src.indexOf('async function recalcAccount'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /buildMonthEndBalances\(/, '트리거가 색인을 만들지 않습니다');
  assert.match(body, /monthEndBalances\s*\}\)/, '색인을 계좌 문서에 쓰지 않습니다');
  // 추가 읽기 없이 — 이미 읽은 목록에서 만들어야 한다.
  assert.ok(!/await .*\.get\(\)/.test(body.slice(body.indexOf('buildMonthEndBalances'))),
    '색인을 만들려고 또 읽습니다');
});

test('보고서가 색인을 먼저 보고, 모르면 계산한다', () => {
  const src = read('public/modules/report.js');
  const fn = src.slice(src.indexOf('function getReportAccountRows'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // **두 줄 다** 확인한다. 전월 말과 당월 말은 따로 계산되므로, 한쪽만
  // 폴백이 있으면 백필 전 보고서에서 한 칸만 0으로 찍힌다 — 표가 그럴듯해서
  // 더 알아채기 어렵다.
  const guarded = [...body.matchAll(
    /monthEndBalanceOf\([^)]*\)\s*\?\?\s*calcAccountBalanceAsOf/g)];
  assert.equal(guarded.length, 2,
    `색인이 없을 때 직접 계산으로 떨어지는 자리가 ${guarded.length}곳뿐입니다 `
    + '(전월 말·당월 말 둘 다여야 합니다) — 백필 전에 잔액이 0으로 찍힙니다');
});

test('색인이 다 있을 때만 읽는 창을 좁힌다', () => {
  // 하나라도 모르는 계좌가 있으면 전체를 읽어야 한다. 좁힌 채로 계산하면
  // 기준일부터의 누적이 끊겨 **틀린 잔액이 결재 문서에 찍힌다.**
  const src = read('public/modules/report.js');
  const fn = src.slice(src.indexOf('export async function loadReport'));
  const body = fn.slice(0, 2600);
  assert.match(body, /accs\.every\(/, '계좌 전부를 확인하지 않습니다');
  assert.match(body, /indexed\s*\?\s*reportWindow\([^)]*\)\s*:\s*null/,
    '색인을 모를 때 전체 이력으로 떨어지지 않습니다');
});

test('월말 색인은 서버만 쓴다 — 규칙이 막는다', () => {
  const rules = read('firestore.rules');
  const at = rules.indexOf('match /accounts/{id}');
  const block = rules.slice(at, rules.indexOf('\n    }', at));
  assert.match(block, /!\('monthEndBalances' in request\.resource\.data\)/,
    '새 계좌에 색인을 심을 수 있습니다');
  assert.match(block, /request\.resource\.data\.get\('monthEndBalances', \{\}\)[\s\S]{0,80}==[\s\S]{0,80}resource\.data\.get\('monthEndBalances', \{\}\)/,
    '색인을 수정으로 덮어쓸 수 있습니다 — 결재 문서에 지어낸 잔액이 찍힙니다');
});
