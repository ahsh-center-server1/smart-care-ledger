// test/summary-live.test.mjs
//
// 「방금 넣었는데 대시보드에 안 보인다」 — 그 자리를 고정한다.
//
// 무엇이 잘못돼 있었나
//   카드의 당월 수입·지출·미분류·고정항목 미납은 `S.monthlyStats` 에서 나오고
//   그것은 **로그인할 때 한 번** 만들어졌다. 거래를 하나 넣고 대시보드로
//   돌아오면 넣기 전 숫자가 그대로 있었다 — 사용자는 저장이 안 된 줄 알고 한 번
//   더 저장한다(그래서 중복 거래가 생긴다).
//
//   새로고침으로도 낫지 않는 경우가 있었다. 요약 캐시의 신선도는
//   `computedVersion === sourceVersion` 인데 `sourceVersion` 을 올리는 것은 서버
//   트리거이고 **비동기**다. 방금 쓴 직후에는 캐시가 신선해 *보이고* 그 안에는
//   방금 쓴 것이 없다. 버전만으로는 이 순간을 가릴 수 없다 — 자기가 썼다는 것은
//   쓴 쪽만 안다. 그래서 다시 읽을 때 캐시를 **건너뛴다**(force).
//
// 여기서 지키는 선
//   ⑴ 흔한 경우(지금 보는 입주자, 당월을 다 들고 있음)는 **읽기 0회**로 맞는다
//   ⑵ 절반만 덮은 기간으로는 계산하지 않는다 — 낡은 값보다 나쁘다
//   ⑶ 당월 집계를 아예 읽지 않는 역할(팀장·센터장)의 null 을 {} 로 만들지 않는다

import test from 'node:test';
import assert from 'node:assert/strict';

// summary-live.js 는 모듈 평가 시점에 document 를 건드리지 않지만,
// import 사슬에 브라우저 전역을 보는 곳이 있어 최소한만 세워 둔다.
globalThis.document = { addEventListener() {}, dispatchEvent() {} };

const { S } = await import('../public/state.js');
const { _internals, flushPendingMonthlyStats } = await import('../public/services/summary-live.js');
const { onTrxWritten, pending } = _internals;

const ym = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
const day = (d) => `${ym}-${String(d).padStart(2, '0')}`;
const lastDay = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
const fullMonth = { start: day(1), end: day(lastDay) };

function reset(over = {}) {
  pending.clear();
  Object.assign(S, {
    activeClient: 'c1',
    trxRange: fullMonth,
    transactions: [],
    clients: [{ id: 'c1' }, { id: 'c2' }],
    monthlyStats: { c1: { inc: 0, exp: 0, unclassified: 0 }, c2: { inc: 0, exp: 0, unclassified: 0 } },
    fixedGap: null,
    allFixedItems: null,
    ...over,
  });
}

// ─────────────────────────────────────────────
// ⑴ 읽기 0회로 맞는 흔한 경우
// ─────────────────────────────────────────────

test('지금 보는 입주자의 거래를 쓰면 카드 숫자가 그 자리에서 맞는다', () => {
  reset({ transactions: [
    { clientId: 'c1', date: day(3), amountOut: 5000, category: '식비' },
    { clientId: 'c1', date: day(4), amountIn: 20000, category: '용돈' },
  ] });

  onTrxWritten({ clientId: 'c1' });

  assert.deepEqual(S.monthlyStats.c1, { inc: 20000, exp: 5000, partial: false, unclassified: 0 });
  assert.equal(pending.size, 0, '로컬로 맞았는데도 다시 읽으려 합니다');
});

test('미분류도 함께 센다 — 배지가 카드와 같은 숫자를 말해야 한다', () => {
  reset({ transactions: [
    { clientId: 'c1', date: day(3), amountOut: 1000, category: '확인필요' },
    { clientId: 'c1', date: day(5), amountOut: 2000, category: '' },
    { clientId: 'c1', date: day(6), amountOut: 3000, category: '식비' },
  ] });
  onTrxWritten({ clientId: 'c1' });
  assert.equal(S.monthlyStats.c1.unclassified, 2);
});

test('「합계 제외」는 카드 금액에서 빠진다 — 보고서와 같은 규칙이다', () => {
  reset({ transactions: [
    { clientId: 'c1', date: day(3), amountOut: 5000, category: '식비' },
    { clientId: 'c1', date: day(4), amountOut: 90000, category: '이체', excludeFromTotals: true },
  ] });
  onTrxWritten({ clientId: 'c1' });
  assert.equal(S.monthlyStats.c1.exp, 5000);
});

test('지난달 거래는 당월 카드에 들어가지 않는다', () => {
  reset({ trxRange: 'all', transactions: [
    { clientId: 'c1', date: '2000-01-05', amountOut: 7777, category: '식비' },
    { clientId: 'c1', date: day(2), amountOut: 100, category: '식비' },
  ] });
  onTrxWritten({ clientId: 'c1' });
  assert.equal(S.monthlyStats.c1.exp, 100);
});

test('입력자의 「본인 입력분만」 표시는 그대로 남는다', () => {
  reset({ transactions: [{ clientId: 'c1', date: day(2), amountOut: 300, category: '식비' }] });
  S.monthlyStats.c1.partial = true;
  onTrxWritten({ clientId: 'c1' });
  assert.equal(S.monthlyStats.c1.partial, true,
    'partial 이 떨어지면 부분 합계가 전체 합계처럼 보입니다');
});

// ─────────────────────────────────────────────
// ⑵ 로컬로 맞출 수 없으면 손대지 않고 표시만 한다
// ─────────────────────────────────────────────

test('다른 입주자의 거래는 로컬로 고치지 않는다 — 그 거래가 여기 없다', () => {
  reset({ transactions: [{ clientId: 'c1', date: day(2), amountOut: 300, category: '식비' }] });
  onTrxWritten({ clientId: 'c2' });
  assert.deepEqual(S.monthlyStats.c2, { inc: 0, exp: 0, unclassified: 0 }, '건드리면 안 됩니다');
  assert.deepEqual([...pending], ['c2']);
});

test('당월을 절반만 들고 있으면 계산하지 않는다 — 낡은 값보다 나쁘다', () => {
  reset({
    trxRange: { start: day(1), end: day(Math.max(1, lastDay - 5)) },
    transactions: [{ clientId: 'c1', date: day(2), amountOut: 300, category: '식비' }],
  });
  onTrxWritten({ clientId: 'c1' });
  assert.equal(S.monthlyStats.c1.exp, 0, '덜 읽은 기간으로 카드를 덮었습니다');
  assert.deepEqual([...pending], ['c1']);
});

test('어느 입주자인지 모르는 쓰기는 담당 전원을 다시 읽을 대상으로 둔다', () => {
  reset({ transactions: [{ clientId: 'c1', date: day(2), amountOut: 300, category: '식비' }] });
  onTrxWritten({ clientId: '' });
  assert.deepEqual([...pending].sort(), ['c1', 'c2']);
});

test('배치 쓰기는 로컬 계산이 되어도 커밋 뒤 강제 재조회 대상으로 남긴다', () => {
  reset({ transactions: [] });
  onTrxWritten({ clientId: '', clientIds: ['c1'], forceRefresh: true });
  assert.equal(S.monthlyStats.c1.exp, 0);
  assert.deepEqual([...pending], ['c1']);

  // 호출부가 나중에 거래 배열을 갱신해도 pending 이 남아 있어야 한다.
  S.transactions.push({ clientId: 'c1', date: day(2), amountOut: 5000, category: '식비' });
  assert.deepEqual([...pending], ['c1']);
});

// ─────────────────────────────────────────────
// ⑶ 읽지 않은 것을 0으로 보고하지 않는다
// ─────────────────────────────────────────────

test('당월 집계를 읽지 않는 역할(null)은 건드리지 않는다', async () => {
  reset({ monthlyStats: null });
  onTrxWritten({ clientId: 'c1' });
  assert.equal(S.monthlyStats, null, 'null 이 {} 가 되면 카드가 「당월 거래 없음」이라고 적습니다');
  assert.equal(pending.size, 0);
  assert.equal(await flushPendingMonthlyStats(), false);
});

test('다시 읽을 것이 없으면 서버를 부르지 않는다', async () => {
  reset();
  assert.equal(await flushPendingMonthlyStats(), false);
});

// ─────────────────────────────────────────────
// 계약 — 신호를 듣는 자리와 캐시를 건너뛰는 자리
// ─────────────────────────────────────────────

test('모든 거래 쓰기가 지나는 신호 하나만 듣는다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/services/summary-live.js', import.meta.url), 'utf8');
  assert.match(src, /TRX_WRITE_EVENT/,
    '저장하는 쪽마다 갱신을 꿰면 언젠가 한 곳을 빠뜨립니다');
  // 다시 읽을 때 캐시를 믿으면 안 된다 — 트리거가 아직 안 돌았을 수 있다.
  assert.match(src, /force:\s*ids/,
    '캐시를 건너뛰지 않으면 신선해 보이는 낡은 값을 그대로 읽습니다');
});

test('대시보드를 열 때 밀린 갱신을 흘려보낸다', async () => {
  const { readFileSync } = await import('node:fs');
  const core = readFileSync(new URL('../public/modules/core.js', import.meta.url), 'utf8');
  const block = core.slice(core.indexOf("if (view==='dashboard')"));
  assert.match(block.slice(0, 500), /flushPendingMonthlyStats\(\)/,
    '대시보드를 열어도 밀린 갱신이 흘러가지 않습니다');
  assert.match(block.slice(0, 500), /renderDashboard\(\)/,
    '갱신한 뒤 다시 그리지 않으면 값만 바뀌고 화면은 그대로입니다');
});
