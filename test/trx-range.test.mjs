// test/trx-range.test.mjs
//
// 거래내역이 어느 기간을 들고 있는가.
//
// 이 앱의 일은 **월초에 몰린다.** 1~10일에 지난달을 정리해서 보고서를 올린다.
// 그런데 기본 조회 범위가 **당월**이었다. 그래서 담당자는 거래내역을 열자마자
// 기간을 지난달로 바꿨고, 처음 조회는 통째로 버려졌다 — 하루 수백 번.
//
// 그리고 경계 계산이 두 군데에 손으로 적혀 있었다(loadTransactions 와
// needsBroaderRange). 어긋나면 화면에 있는 거래를 필터가 못 찾는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLOSING_DAYS, isoDate, monthBounds, defaultTrxRange,
  rangeBounds, inLoadedRange, needsBroaderRange,
} from '../public/domain/trx-range.js';

const at = (y, m, d) => new Date(y, m - 1, d);

test('당월 경계를 만든다 — 말일이 달마다 다르다', () => {
  assert.deepEqual(monthBounds(at(2026, 2, 15)), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(monthBounds(at(2024, 2, 15)), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(monthBounds(at(2026, 4, 30)), { start: '2026-04-01', end: '2026-04-30' });
});

test('지난달은 연말을 넘어간다', () => {
  assert.deepEqual(monthBounds(at(2026, 1, 5), 1), { start: '2025-12-01', end: '2025-12-31' });
});

test('월초에는 지난달부터 읽는다', () => {
  // 원래 증상. 10월 3일에 열면 10월만 읽어 놓고, 사용자가 9월을 보려 하면
  // 같은 조회를 한 번 더 했다.
  const r = defaultTrxRange(at(2026, 10, 3));
  assert.deepEqual(r, { start: '2026-09-01', end: '2026-10-31' });
});

test('월초가 지나면 당월만 읽는다', () => {
  // 한 달 내내 두 달치를 읽으면 절약이 아니라 낭비다.
  assert.deepEqual(defaultTrxRange(at(2026, 10, CLOSING_DAYS + 1)),
    { start: '2026-10-01', end: '2026-10-31' });
});

test('마감 기간의 경계 날짜가 포함된다', () => {
  assert.equal(defaultTrxRange(at(2026, 10, CLOSING_DAYS)).start, '2026-09-01');
  assert.equal(defaultTrxRange(at(2026, 10, 1)).start, '2026-09-01');
});

test('날짜는 로컬 달력으로 만든다', () => {
  // toISOString() 을 쓰면 UTC 로 밀려 한국에서 새벽에 하루 전이 된다 —
  // 1일 0시에 열면 지난달이 두 달 전이 되는 식으로 조용히 틀린다.
  assert.equal(isoDate(new Date(2026, 9, 1, 0, 30)), '2026-10-01');
  assert.equal(isoDate(new Date(2026, 9, 31, 23, 30)), '2026-10-31');
});

test("'all' 은 경계가 없다", () => {
  assert.equal(rangeBounds('all'), null);
  assert.equal(inLoadedRange('1999-01-01', 'all'), true);
  assert.equal(needsBroaderRange('1999-01-01', null, 'all'), false);
});

test("낡은 'month' 값도 읽을 수 있다", () => {
  // 세션에 예전 기본값이 남아 있을 수 있다.
  assert.deepEqual(rangeBounds('month', at(2026, 10, 3)), { start: '2026-10-01', end: '2026-10-31' });
});

test('로드된 범위 안인지 판단한다', () => {
  const r = { start: '2026-09-01', end: '2026-10-31' };
  assert.equal(inLoadedRange('2026-09-01', r), true, '시작일이 포함되어야 합니다');
  assert.equal(inLoadedRange('2026-10-31', r), true, '종료일이 포함되어야 합니다');
  assert.equal(inLoadedRange('2026-08-31', r), false);
  assert.equal(inLoadedRange('2026-11-01', r), false);
  assert.equal(inLoadedRange('', r), false, '날짜 없는 거래를 끼워 넣으면 안 됩니다');
});

test('필터가 로드 범위를 벗어나면 더 읽는다', () => {
  const r = { start: '2026-09-01', end: '2026-10-31' };
  assert.equal(needsBroaderRange('2026-09-01', '2026-10-31', r), false, '안쪽인데 다시 읽습니다');
  assert.equal(needsBroaderRange('2026-08-01', null, r), true);
  assert.equal(needsBroaderRange(null, '2026-12-31', r), true);
  assert.equal(needsBroaderRange(null, null, r), false, '필터가 비었는데 다시 읽습니다');
});

// ── 집행 지점 ───────────────────────────────────────────────

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('경계를 만드는 곳이 한 곳뿐이다', () => {
  // 원래 문제. loadTransactions 와 needsBroaderRange 가 각자 당월을 만들었다.
  for (const f of ['public/modules/core.js', 'public/modules/transactions.js']) {
    const src = read(f).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/new Date\([^)]*getMonth\(\)\s*\+\s*1,\s*0\)/.test(src),
      `${f} 가 말일을 직접 계산합니다. domain/trx-range.js 를 쓰세요`);
  }
});

test('기본 조회 범위를 달력이 정한다', () => {
  const core = read('public/modules/core.js');
  const fn = core.slice(core.indexOf('export async function loadTransactions'));
  assert.match(fn.slice(0, 1600), /defaultTrxRange\(\)/,
    '기본 범위가 고정되어 있습니다 — 월초에 지난달을 못 읽습니다');
  assert.ok(!/opts\.range\s*:\s*'month'/.test(fn.slice(0, 1600)),
    "기본값이 아직 'month' 입니다");
});
