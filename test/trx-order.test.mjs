// test/trx-order.test.mjs
//
// 장부에 거래를 늘어놓는 순서.
//
// 사용자가 보고한 것은 셋인데 원인은 하나였다 — **비교기가 sortOrder를 먼저
// 봤다.** 장부에서 1순위는 언제나 날짜다. 그것을 뒤집었더니
//   · 수기 입력이 목록 맨 아래로 몰리던 것,
//   · 엑셀이 화면에 로드된 것만 보고 번호를 매기던 것,
//   · 필터를 켠 채 드래그하면 필터 밖 번호와 충돌하던 것
// 이 한꺼번에 무해해졌다. 번호가 **그 날 안에서만** 뜻을 갖기 때문이다.
//
// 그래서 이 파일은 "날짜가 언제나 먼저"를 지킨다. 그것이 깨지면 나머지
// 세 가지가 다시 살아난다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compareTrx, sortTrx, orderOf, nextOrderInDay } from '../public/domain/trx-order.js';

const t = (date, sortOrder, extra = {}) => ({ date, sortOrder, ...extra });
const dates = (list) => sortTrx(list).map(x => x.id);

test('날짜가 언제나 먼저다', () => {
  // 나중에 입력한 과거 거래(번호 큼)가 앞선 날짜이므로 위에 온다.
  const later = { id: '늦게입력', date: '2026-03-02', sortOrder: 900 };
  const earlier = { id: '먼저입력', date: '2026-03-10', sortOrder: 1 };
  assert.deepEqual(dates([earlier, later]), ['늦게입력', '먼저입력']);
});

test('같은 날 안에서는 통장 순서를 따른다', () => {
  const rows = [
    { id: 'c', date: '2026-03-05', sortOrder: 2 },
    { id: 'a', date: '2026-03-05', sortOrder: 0 },
    { id: 'b', date: '2026-03-05', sortOrder: 1 },
  ];
  assert.deepEqual(dates(rows), ['a', 'b', 'c']);
});

test('번호가 없는 거래는 그 날의 맨 뒤다', () => {
  // 통장에서 옮겨 적은 줄보다 나중에 손으로 적은 줄이 위로 올라가면 안 된다.
  const rows = [
    { id: '수기', date: '2026-03-05' },
    { id: '통장2', date: '2026-03-05', sortOrder: 1 },
    { id: '통장1', date: '2026-03-05', sortOrder: 0 },
  ];
  assert.deepEqual(dates(rows), ['통장1', '통장2', '수기']);
  assert.equal(orderOf({ sortOrder: 0 }), 0, '0은 없는 값이 아니다');
  assert.ok(orderOf({}) > 1e6);
  assert.ok(orderOf({ sortOrder: null }) > 1e6);
});

test('번호가 같으면 시각이 가른다', () => {
  const rows = [
    { id: '오후', date: '2026-03-05', sortOrder: 0, time: '15:00' },
    { id: '오전', date: '2026-03-05', sortOrder: 0, time: '09:00' },
  ];
  assert.deepEqual(dates(rows), ['오전', '오후']);
});

test('날짜가 다르면 번호가 겹쳐도 상관없다', () => {
  // 이것이 요점이다. 겹침이 무해해야 엑셀·드래그가 부분 데이터만 보고
  // 번호를 매겨도 장부가 어긋나지 않는다.
  const rows = [
    { id: '3월2일', date: '2026-03-02', sortOrder: 0 },
    { id: '3월1일', date: '2026-03-01', sortOrder: 0 },
    { id: '3월3일', date: '2026-03-03', sortOrder: 0 },
  ];
  assert.deepEqual(dates(rows), ['3월1일', '3월2일', '3월3일']);
});

test('정렬이 원본 배열을 건드리지 않는다', () => {
  const rows = [t('2026-03-09', 0, { id: 'b' }), t('2026-03-01', 0, { id: 'a' })];
  sortTrx(rows);
  assert.equal(rows[0].id, 'b', '원본이 뒤바뀌었습니다');
});

// ── 새 거래의 자리 ──────────────────────────────────────────

test('새 거래는 그 날의 맨 뒤를 받는다', () => {
  const trx = [
    { clientId: 'c1', date: '2026-03-05', sortOrder: 0 },
    { clientId: 'c1', date: '2026-03-05', sortOrder: 1 },
    { clientId: 'c1', date: '2026-03-06', sortOrder: 7 },
  ];
  assert.equal(nextOrderInDay('2026-03-05', trx, 'c1'), 2);
  assert.equal(nextOrderInDay('2026-03-06', trx, 'c1'), 8);
});

test('그 날 첫 거래면 0을 받는다', () => {
  assert.equal(nextOrderInDay('2026-03-07', [], 'c1'), 0);
  assert.equal(nextOrderInDay('2026-03-07', [{ clientId: 'c1', date: '2026-03-06', sortOrder: 5 }], 'c1'), 0);
});

test('다른 입주자의 번호는 세지 않는다', () => {
  // 목록에는 여러 입주자가 섞여 있을 수 있다. 남의 번호를 이어받으면
  // 그 날의 맨 뒤가 아니라 한참 뒤가 된다.
  const trx = [
    { clientId: 'c2', date: '2026-03-05', sortOrder: 40 },
    { clientId: 'c1', date: '2026-03-05', sortOrder: 1 },
  ];
  assert.equal(nextOrderInDay('2026-03-05', trx, 'c1'), 2);
});

test('번호 없는 거래는 세지 않는다', () => {
  // 그것들이야말로 자리를 못 받은 것들이다. 세면 맨 뒤가 계속 0이 된다.
  const trx = [
    { clientId: 'c1', date: '2026-03-05' },
    { clientId: 'c1', date: '2026-03-05', sortOrder: 3 },
  ];
  assert.equal(nextOrderInDay('2026-03-05', trx, 'c1'), 4);
});

// ── 집행 지점 ───────────────────────────────────────────────

test('장부 순서 비교기가 한 벌뿐이다', () => {
  // 세 벌로 흩어져 있었다(core.js · report.js 두 곳). 한 곳만 고치면 같은
  // 거래가 화면마다 다른 자리에 나타나고, 그 화면 중 하나는 인쇄해서
  // 결재에 올리는 보고서다.
  const files = [];
  for (const dir of ['modules', 'services', 'domain', 'utils']) {
    for (const f of readdirSync(new URL(`../public/${dir}/`, import.meta.url))) {
      if (f.endsWith('.js')) files.push([`public/${dir}/${f}`, new URL(`../public/${dir}/${f}`, import.meta.url)]);
    }
  }
  const offenders = [];
  for (const [name, url] of files) {
    if (name === 'public/domain/trx-order.js') continue;
    const code = readFileSync(url, 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    if (/sortOrder\s*!=\s*null\s*\?/.test(code)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    '장부 순서 비교기를 따로 쓰는 파일이 있습니다. domain/trx-order.js 의 compareTrx 를 쓰세요');
});

test('수기 입력이 자리를 받는다', () => {
  // 원래 문제. trxData 에 sortOrder 가 아예 없어서 전부 목록 맨 아래로 몰렸다.
  const code = readFileSync(new URL('../public/modules/transactions.js', import.meta.url), 'utf8');
  const create = code.slice(code.indexOf('export async function saveTrx'));
  assert.ok(/nextOrderInDay\(/.test(create.slice(0, 2500)),
    '새 거래에 그 날의 순서를 주지 않습니다 — 목록 맨 아래로 몰립니다');
});
