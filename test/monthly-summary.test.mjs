// test/monthly-summary.test.mjs
//
// 월별 요약 캐시.
//
// 왜 이 테스트가 있는가
//   캐시는 **틀린 값을 보여주는** 가장 흔한 원인이다. 이 앱에서 그 값은 금액이므로
//   "가끔 어긋난다"가 허용되지 않는다. 그래서 두 가지를 고정한다:
//
//     1. 낡음 판정이 보수적인가 — 의심스러우면 다시 계산하는 쪽으로 떨어지는가
//     2. 서버(CJS)와 브라우저(ESM)의 키·무효화 판단이 같은가
//
//   2번이 어긋나면 서버는 A를 무효화하고 브라우저는 B를 읽는다. 화면에는
//   영원히 낡은 값이 남고, 예외도 로그도 없다 — 눈으로는 절대 못 잡는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  SUMMARY_SCHEMA_VERSION, summaryKey, monthKey,
  computeMonthlySummary, isSummaryFresh,
  toSummaryCacheDoc, fromSummaryCacheDoc, countUnpaidMandatory,
} from '../public/domain/monthly-summary.js';

const require = createRequire(import.meta.url);
const server = require('../functions/summary-cache.cjs');

const trx = (over = {}) => ({
  clientId: 'c1', date: '2026-09-07', type: '지출',
  amountIn: 0, amountOut: 1000, ...over,
});

// ─────────────────────────────────────────────────────────
// 집계
// ─────────────────────────────────────────────────────────

test('수입은 amountIn, 지출은 amountOut으로 모은다', () => {
  const s = computeMonthlySummary([
    trx({ type: '수입', amountIn: 500000, amountOut: 0 }),
    trx({ type: '지출', amountOut: 12000 }),
    trx({ type: '지출', amountOut: 3000 }),
  ]);
  assert.equal(s.inc, 500000);
  assert.equal(s.exp, 15000);
  assert.equal(s.count, 3);
});

test('자산이동·취소는 집계에서 뺀다 (보고서·연간통계와 같은 규칙)', () => {
  // 계좌 간 이동은 수입도 지출도 아니고, 승인취소는 없던 거래다.
  // 이 규칙이 어긋나면 대시보드 카드와 보고서 합계가 서로 다른 값을 보여준다.
  const s = computeMonthlySummary([
    trx({ type: '자산이동', amountOut: 100000 }),
    trx({ type: '자산이동', amountIn: 100000, amountOut: 0 }),
    trx({ type: '취소', amountOut: 5000 }),
    trx({ type: '지출', amountOut: 7000 }),
  ]);
  assert.equal(s.inc, 0);
  assert.equal(s.exp, 7000);
  assert.equal(s.count, 4, 'count는 건수이므로 제외 대상도 센다');
});

test('음수 지출(환불)은 지출을 깎는다', () => {
  const s = computeMonthlySummary([
    trx({ amountOut: 30000 }),
    trx({ amountOut: -10000 }),
  ]);
  assert.equal(s.exp, 20000);
});

test('문자열 금액도 숫자로 더한다', () => {
  // 엑셀 파서를 거치면 문자열이 섞여 들어온다. 문자열 결합이 되면
  // "1000500000" 같은 값이 화면에 나간다.
  const s = computeMonthlySummary([
    trx({ amountOut: '1000' }),
    trx({ amountOut: '500' }),
  ]);
  assert.equal(s.exp, 1500);
});

test('빈 입력·null도 0으로 끝난다', () => {
  for (const input of [[], null, undefined]) {
    const s = computeMonthlySummary(input);
    assert.deepEqual(s, { inc: 0, exp: 0, count: 0, unclassified: 0, paidFixedIds: [] });
  }
});

test('고정항목 입력 이력은 중복 없이 모은다', () => {
  const s = computeMonthlySummary([
    trx({ isFixed: true, fixedItemId: 'f1' }),
    trx({ isFixed: true, fixedItemId: 'f1' }),   // 같은 항목 두 번
    trx({ isFixed: true, fixedItemId: 'f2' }),
    trx({ isFixed: true }),                      // id 없음 → 무시
    trx({ fixedItemId: 'f3' }),                  // isFixed 아님 → 무시
  ]);
  assert.deepEqual([...s.paidFixedIds].sort(), ['f1', 'f2']);
});

// ─────────────────────────────────────────────────────────
// 낡음 판정 — 의심스러우면 다시 계산한다
// ─────────────────────────────────────────────────────────

const fresh = (over = {}) => ({
  schemaVersion: SUMMARY_SCHEMA_VERSION,
  sourceVersion: 7, computedVersion: 7,
  inc: 1, exp: 2, count: 3, ...over,
});

test('버전이 같으면 캐시를 그대로 쓴다', () => {
  assert.equal(isSummaryFresh(fresh()), true);
});

test('거래가 바뀐 뒤(sourceVersion 증가)에는 쓰지 않는다', () => {
  assert.equal(isSummaryFresh(fresh({ sourceVersion: 8 })), false);
});

test('요약 형태가 바뀌면 예전 캐시를 버린다', () => {
  // 필드를 추가한 뒤 낡은 캐시를 그대로 쓰면, 새 필드가 빈 채로 화면에 나간다.
  assert.equal(isSummaryFresh(fresh({ schemaVersion: SUMMARY_SCHEMA_VERSION - 1 })), false);
  assert.equal(isSummaryFresh(fresh({ schemaVersion: SUMMARY_SCHEMA_VERSION + 1 })), false);
  assert.equal(isSummaryFresh(fresh({ schemaVersion: undefined })), false);
});

test('버전이 없는 캐시는 신뢰하지 않는다', () => {
  // 손으로 만든 문서나 트리거가 아직 안 돈 문서. 값이 맞는지 알 방법이 없다.
  assert.equal(isSummaryFresh(fresh({ sourceVersion: undefined })), false);
  assert.equal(isSummaryFresh(fresh({ computedVersion: undefined })), false);
  assert.equal(isSummaryFresh(fresh({ sourceVersion: 'abc' })), false);
  assert.equal(isSummaryFresh(fresh({ computedVersion: null })), false);
});

test('캐시가 없으면 낡은 것으로 본다', () => {
  assert.equal(isSummaryFresh(null), false);
  assert.equal(isSummaryFresh(undefined), false);
});

test('버전 0끼리 맞으면 신선하다', () => {
  // 처음 만든 캐시. 0을 "없음"으로 취급하면 캐시가 영구히 안 듣는다.
  assert.equal(isSummaryFresh(fresh({ sourceVersion: 0, computedVersion: 0 })), true);
});

// ─────────────────────────────────────────────────────────
// 저장 형태
// ─────────────────────────────────────────────────────────

test('computedVersion에 읽은 시점의 sourceVersion을 넣는다', () => {
  // 계산 중에 거래가 바뀌면 트리거가 sourceVersion을 더 올리므로,
  // 다음 조회에서 어긋남이 감지되어 다시 계산된다.
  const d = toSummaryCacheDoc({
    clientId: 'c1', ym: '2026-09',
    summary: { inc: 10, exp: 20, count: 2, paidFixedIds: ['f1'] },
    sourceVersion: 5,
  });
  assert.equal(d.computedVersion, 5);
  assert.equal(d.schemaVersion, SUMMARY_SCHEMA_VERSION);
  assert.equal(d.clientId, 'c1');
  assert.equal(d.ym, '2026-09');
  assert.deepEqual(d.paidFixedIds, ['f1']);
});

test('처음 만들 때만 sourceVersion을 심는다', () => {
  // 이미 있는 문서에 다시 쓰면 계산 중 트리거가 올린 값을 되돌린다 —
  // 낡은 캐시가 신선한 것으로 위장되는 경로다. 규칙도 이것을 거부한다.
  const created = toSummaryCacheDoc({
    clientId: 'c1', ym: '2026-09', summary: { inc: 0, exp: 0, count: 0 },
    sourceVersion: 0, isNew: true,
  });
  assert.equal(created.sourceVersion, 0);
  assert.equal(created.computedVersion, 0);

  const updated = toSummaryCacheDoc({
    clientId: 'c1', ym: '2026-09', summary: { inc: 0, exp: 0, count: 0 },
    sourceVersion: 5, isNew: false,
  });
  assert.equal('sourceVersion' in updated, false);
});

test('저장 → 복원이 값을 보존하고, 그 결과가 신선하다고 판정된다', () => {
  const summary = { inc: 100, exp: 250, count: 4, unclassified: 1, paidFixedIds: ['f1', 'f2'] };
  const stored = { ...toSummaryCacheDoc({
    clientId: 'c1', ym: '2026-09', summary, sourceVersion: 3,
  }), sourceVersion: 3 };
  assert.equal(isSummaryFresh(stored), true);
  assert.deepEqual(fromSummaryCacheDoc(stored), summary);
});

test('필드가 빠진 캐시를 읽어도 화면이 깨지지 않는다', () => {
  const EMPTY = { inc: 0, exp: 0, count: 0, unclassified: 0, paidFixedIds: [] };
  assert.deepEqual(fromSummaryCacheDoc({}), EMPTY);
  assert.deepEqual(fromSummaryCacheDoc(null), EMPTY);
  assert.deepEqual(
    fromSummaryCacheDoc({ inc: '5', paidFixedIds: 'not-an-array' }),
    { ...EMPTY, inc: 5 },
  );
});

// ─────────────────────────────────────────────────────────
// 필수 고정항목 미납
// ─────────────────────────────────────────────────────────

test('필수 항목만 세고, 입력된 것은 뺀다', () => {
  const items = [
    { id: 'f1', isMandatory: true },
    { id: 'f2', isMandatory: true },
    { id: 'f3', isMandatory: true },
    { id: 'f4' },                       // 필수 아님
  ];
  assert.equal(countUnpaidMandatory(items, ['f1']), 2);
  assert.equal(countUnpaidMandatory(items, ['f1', 'f2', 'f3']), 0);
  assert.equal(countUnpaidMandatory(items, []), 3);
  assert.equal(countUnpaidMandatory(items, null), 3);
  assert.equal(countUnpaidMandatory([], ['f1']), 0);
  assert.equal(countUnpaidMandatory(null, null), 0);
});

// ─────────────────────────────────────────────────────────
// 서버(CJS) ↔ 브라우저(ESM) 대조
//
// 이것이 이 파일의 핵심이다. 한쪽만 고치면 여기서 실패한다.
// ─────────────────────────────────────────────────────────

test('캐시 문서 키가 양쪽에서 같다', () => {
  const 경우 = [
    ['c1', '2026-09'], ['c1', '2026-01'], ['c1', '2026-12'],
    ['입주자-한글', '2025-07'], ['c_2', '2030-11'], ['a-b-c', '2026-02'],
  ];
  for (const [c, ym] of 경우) {
    assert.equal(server.summaryKey(c, ym), summaryKey(c, ym), `불일치: ${c}/${ym}`);
  }
});

test('월 추출이 양쪽에서 같다', () => {
  for (const d of ['2026-09-07', '2026-09', '2026-12-31', '', null, undefined, '26.09.07']) {
    assert.equal(server.monthKey(d), monthKey(d), `불일치: ${d}`);
  }
});

// ─────────────────────────────────────────────────────────
// 무효화 대상 (서버)
// ─────────────────────────────────────────────────────────

test('생성·삭제는 그 (입주자, 월) 하나를 무효화한다', () => {
  assert.deepEqual(server.affectedSummaryKeys(null, trx()), ['c1_2026-09']);
  assert.deepEqual(server.affectedSummaryKeys(trx(), null), ['c1_2026-09']);
});

test('달을 옮긴 수정은 **양쪽 달**을 무효화한다', () => {
  // 8월 거래를 9월로 옮기면 두 달의 합계가 다 바뀐다. 한쪽만 올리면
  // 다른 달이 낡은 값을 계속 보여주고, 그것은 눈에 띄지 않는다.
  const keys = server.affectedSummaryKeys(
    trx({ date: '2026-08-30' }),
    trx({ date: '2026-09-01' }),
  );
  assert.deepEqual(keys.sort(), ['c1_2026-08', 'c1_2026-09']);
});

test('입주자를 옮긴 수정도 양쪽을 무효화한다', () => {
  const keys = server.affectedSummaryKeys(trx(), trx({ clientId: 'c2' }));
  assert.deepEqual(keys.sort(), ['c1_2026-09', 'c2_2026-09']);
});

test('바뀌지 않은 (입주자, 월)은 한 번만 나온다', () => {
  assert.deepEqual(
    server.affectedSummaryKeys(trx(), trx({ amountOut: 2000 })),
    ['c1_2026-09'],
  );
});

test('날짜·입주자가 없는 문서는 무효화 대상이 아니다', () => {
  assert.deepEqual(server.affectedSummaryKeys(null, { clientId: 'c1' }), []);
  assert.deepEqual(server.affectedSummaryKeys(null, { date: '2026-09-07' }), []);
  assert.deepEqual(server.affectedSummaryKeys(null, { clientId: 'c1', date: '2026' }), []);
  assert.deepEqual(server.affectedSummaryKeys(null, null), []);
});

// ─────────────────────────────────────────────────────────
// 무효화 여부 (서버)
// ─────────────────────────────────────────────────────────

test('금액·유형·날짜·입주자가 바뀌면 무효화한다', () => {
  const cases = [
    { amountOut: 2000 }, { amountIn: 5 }, { type: '취소' },
    { date: '2026-09-08' }, { clientId: 'c2' },
  ];
  for (const over of cases) {
    assert.equal(server.affectsSummary(trx(), trx(over)), true, JSON.stringify(over));
  }
});

test('고정항목 표시가 바뀌면 무효화한다 (미납 건수가 바뀐다)', () => {
  assert.equal(server.affectsSummary(trx(), trx({ isFixed: true, fixedItemId: 'f1' })), true);
  assert.equal(
    server.affectsSummary(trx({ isFixed: true, fixedItemId: 'f1' }), trx({ isFixed: true, fixedItemId: 'f2' })),
    true,
  );
});

test('영수증 첨부·순서 변경·내용 수정은 무효화하지 않는다', () => {
  // 이런 쓰기까지 버전을 올리면 캐시가 계속 무효화되어 캐시가 없는 것과 같아진다.
  // 영수증 첨부는 이 앱에서 가장 잦은 쓰기다.
  const cases = [
    { receiptUrl: 'https://x/y.jpg' },
    { sortOrder: 12 },
    { description: '편의점' },
    { category: '식비' },
    { subcategory: '간식' },
    { receiptMissing: false },
  ];
  for (const over of cases) {
    assert.equal(server.affectsSummary(trx(), trx(over)), false, JSON.stringify(over));
  }
});

test('생성·삭제는 항상 무효화한다', () => {
  assert.equal(server.affectsSummary(null, trx()), true);
  assert.equal(server.affectsSummary(trx(), null), true);
});

test('0과 없음을 구별한다', () => {
  // `before.amountOut || 0` 비교이므로 0 ↔ 없음은 같은 값으로 본다(둘 다 0원).
  // 반대로 0 → 1000은 반드시 무효화되어야 한다.
  assert.equal(server.affectsSummary(trx({ amountOut: 0 }), trx({ amountOut: undefined })), false);
  assert.equal(server.affectsSummary(trx({ amountOut: 0 }), trx({ amountOut: 1000 })), true);
});

// ─────────────────────────────────────────────────────────
// 미분류 건수 — 대시보드 배지의 근거
//
// 카드마다 당월 거래를 다시 읽으면 캐시를 둔 이유가 사라진다. 그래서 요약이
// 세어 둔다. 판정 기준은 domain/report-checklist.js 와 **같은 함수**다 —
// 대시보드 배지와 제출 전 점검표가 다른 숫자를 말하면 어느 쪽도 믿지 않는다.
// ─────────────────────────────────────────────────────────

test('분류가 정해지지 않은 거래를 센다', () => {
  const s = computeMonthlySummary([
    trx({ category: '확인필요' }),
    trx({ category: '미분류' }),
    trx({ category: '' }),
    trx({ category: '  ' }),
    trx({ category: '식비' }),
  ]);
  assert.equal(s.unclassified, 4);
});

test('미분류 판정이 제출 전 점검표와 같다', async () => {
  // 두 곳이 각자 목록을 들고 있으면 언젠가 갈라진다. 같은 함수를 쓰는지
  // 결과로 대조한다.
  const { reportChecklist } = await import('../public/domain/report-checklist.js');
  const rows = [
    trx({ category: '확인필요' }), trx({ category: '' }),
    trx({ category: '미분류' }), trx({ category: '식비' }),
  ];
  assert.equal(
    computeMonthlySummary(rows).unclassified,
    reportChecklist({ transactions: rows }).unclassified.length,
  );
});

test('캐시에 미분류가 없으면 0으로 읽는다 — 낡은 캐시가 화면을 깨뜨리지 않는다', () => {
  // 스키마 1로 저장된 캐시에는 이 필드가 없다. 버전이 달라 신선하지 않다고
  // 판정되지만, 그 사이 화면이 undefined 를 그리면 안 된다.
  assert.equal(fromSummaryCacheDoc({ inc: 1, exp: 2, count: 3 }).unclassified, 0);
});
