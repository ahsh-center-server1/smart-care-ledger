// test/report-narrative.test.mjs
//
// 보고서 「자동 분석」을 모델에게 맡길 때의 경계.
//
// 이 파일이 지키는 것 중 첫째는 기능이 아니라 **무엇을 내보내지 않는가**다.
//
// 이 앱의 장부 주인은 발달장애인 거주시설의 입주자다. 어디서 무엇을 샀는지는
// 그 사람의 하루가 그대로 드러나는 기록이고, 본인이 동의를 판단하기 어려운
// 자리에 있다. 그래서 이름·상호명·계좌번호는 외부 API 로 나가지 않는다.
// buildReportFacts() 가 그 경계이고, 순수 함수라 여기서 직접 확인할 수 있다.
//
// 둘째는 **규칙 기반이 사라지지 않는다**는 것이다. 키가 없든 한도를 다 썼든
// 망이 끊겼든, 버튼을 누르면 언제나 문장이 나와야 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildReportFacts, factsToPrompt, narrateReport, TOP_CATEGORIES,
} = require('../functions/ai/report-narrative.js');

/** 화면이 넘기는 것과 같은 모양 + 절대 나가면 안 되는 것들을 섞어 둔다. */
const PAYLOAD = {
  clientId: 'c1',
  clientName: '김입주',
  year: 2026, month: 3,
  totalIn: 500000, totalOut: 430000, balance: 70000, count: 88,
  catStats: {
    '식비': { total: 210000 },
    '의료비': { total: 120000 },
    '확인필요': { total: 30000 },
  },
  prevTotalIn: 500000, prevTotalOut: 380000,
  prevCatStats: { '식비': 200000, '의료비': 60000 },
  // 아래는 화면이 실수로 함께 보냈다고 가정한 것들
  trxList: [{ description: '○○약국', amountOut: 32000, accountId: 'a1' }],
  accountNumber: '123-456-789012',
  memo: '보호자 연락처 010-0000-0000',
};

test('이름·상호명·계좌번호가 사실 묶음에 들어가지 않는다', () => {
  const facts = buildReportFacts(PAYLOAD);
  const dumped = JSON.stringify(facts);
  for (const leaked of ['김입주', '○○약국', '123-456-789012', '010-0000-0000', 'c1']) {
    assert.ok(!dumped.includes(leaked), `사실 묶음에 「${leaked}」 가 들어 있습니다`);
  }
});

test('모델에게 보내는 문장에도 들어가지 않는다', () => {
  // 사실 묶음이 깨끗해도 프롬프트를 따로 만들면 거기서 샐 수 있다.
  const prompt = factsToPrompt(buildReportFacts(PAYLOAD));
  for (const leaked of ['김입주', '○○약국', '123-456-789012', '010-0000-0000']) {
    assert.ok(!prompt.includes(leaked), `프롬프트에 「${leaked}」 가 들어 있습니다`);
  }
});

test('보고서에 필요한 숫자는 다 들어간다', () => {
  const f = buildReportFacts(PAYLOAD);
  assert.equal(f.year, 2026);
  assert.equal(f.month, 3);
  assert.equal(f.totalIn, 500000);
  assert.equal(f.totalOut, 430000);
  assert.equal(f.balance, 70000);
  assert.equal(f.count, 88);
  assert.deepEqual(f.previous, { totalIn: 500000, totalOut: 380000 });
});

test('분류는 금액 큰 순으로, 전월과 짝지어 보낸다', () => {
  const f = buildReportFacts(PAYLOAD);
  assert.deepEqual(f.categories.map(c => c.분류), ['식비', '의료비', '확인필요']);
  assert.equal(f.categories[0].전월, 200000);
  assert.equal(f.categories[2].전월, 0, '전월에 없던 분류는 0이어야 합니다');
});

test('「확인필요」는 따로 받지 않고 분류표에서 읽는다', () => {
  // 같은 숫자를 두 군데로 받으면 언젠가 서로 달라진다.
  assert.equal(buildReportFacts(PAYLOAD).unclassified, 30000);
  assert.equal(buildReportFacts({ catStats: {} }).unclassified, 0);
});

test('분류가 너무 많으면 잘라 보낸다', () => {
  // 전부 보내면 모델이 문장 대신 목록을 옮겨 적는다.
  const catStats = {};
  for (let i = 0; i < 30; i += 1) catStats[`분류${i}`] = { total: (30 - i) * 1000 };
  assert.equal(buildReportFacts({ catStats }).categories.length, TOP_CATEGORIES);
});

test('전월 자료가 없으면 비교하지 말라고 적는다', () => {
  // 없는 것을 0으로 주면 "전월 대비 100% 증가" 같은 문장이 나온다.
  const f = buildReportFacts({ year: 2026, month: 1, totalOut: 1000, catStats: {} });
  assert.equal(f.previous, null);
  assert.match(factsToPrompt(f), /전월 자료는 없습니다/);
});

test('빈 입력에도 깨지지 않는다', () => {
  for (const input of [undefined, null, {}, { catStats: null }]) {
    const f = buildReportFacts(input);
    assert.equal(typeof f.totalOut, 'number');
    assert.ok(Array.isArray(f.categories));
    assert.equal(typeof factsToPrompt(f), 'string');
  }
});

// ── 모델 호출 ───────────────────────────────────────────────

const fakeClient = (reply) => ({
  models: {
    generateContent: async (req) => {
      fakeClient.last = req;
      return reply;
    },
  },
});

test('모델이 돌려준 문장을 그대로 쓴다', async () => {
  const out = await narrateReport(PAYLOAD, {
    model: 'm', client: fakeClient({ text: '  3월 지출은 430,000원입니다.  ' }),
  });
  assert.equal(out.text, '3월 지출은 430,000원입니다.');
});

test('응답 모양이 달라도 문장을 찾아낸다', async () => {
  // SDK 버전에 따라 text 가 없고 candidates 만 올 때가 있다.
  const out = await narrateReport(PAYLOAD, {
    model: 'm',
    client: fakeClient({ candidates: [{ content: { parts: [{ text: 'ㄱ' }, { text: 'ㄴ' }] } }] }),
  });
  assert.equal(out.text, 'ㄱㄴ');
});

test('빈 응답은 빈 문자열로 — 호출부가 규칙 기반으로 떨어진다', async () => {
  const out = await narrateReport(PAYLOAD, { model: 'm', client: fakeClient({}) });
  assert.equal(out.text, '');
});

// ── 집행 지점 ───────────────────────────────────────────────

test('실패해도 규칙 기반 문장이 나온다', () => {
  // AI 는 더 나은 문장이지 없으면 안 되는 기능이 아니다. 화면이 예외를
  // 삼키고 규칙 기반으로 떨어지지 않으면, 키 하나 때문에 보고서를 못 쓴다.
  const panel = readFileSync(
    new URL('../public/modules/report-summary-panel.js', import.meta.url), 'utf8');
  const fn = panel.slice(panel.indexOf('export async function handleGenSummary')).replace(/\s/g, '');
  assert.ok(/catch/.test(fn), 'AI 호출 실패를 잡지 않습니다');
  assert.ok(/if\(!text\)text=generateRuleBasedSummary\(/.test(fn),
    '실패했을 때 규칙 기반으로 떨어지지 않습니다');
});

test('늦게 온 응답이 다른 보고서에 앉지 않는다', () => {
  // AI 호출은 몇 초가 걸린다. 그 사이 다른 입주자를 열면, 응답이 돌아왔을 때
  // 남의 보고서에 그 문장이 찍힌다 — 규칙 기반일 때는 동기라서 없던 위험이다.
  const panel = readFileSync(
    new URL('../public/modules/report-summary-panel.js', import.meta.url), 'utf8');
  const fn = panel.slice(panel.indexOf('export async function handleGenSummary')).replace(/\s/g, '');
  assert.ok(/mine!==summaryKey\(\)/.test(fn),
    '응답을 쓰기 전에 아직 같은 보고서인지 확인하지 않습니다');
});

test('보고서를 새로 그릴 때 분석 칸을 비운다', () => {
  // 원래 보고된 증상. 다른 입주자를 열어도 앞사람의 분석이 남았고,
  // 인쇄 영역까지 남아 남의 분석이 찍힌 보고서가 결재에 올라갈 수 있었다.
  const report = readFileSync(new URL('../public/modules/report.js', import.meta.url), 'utf8');
  const view = report.slice(report.indexOf('export function renderReportView'));
  assert.ok(/resetSummaryPanel\(\)/.test(view.slice(0, 1200)),
    'renderReportView 가 분석 칸을 비우지 않습니다');
  const panel = readFileSync(
    new URL('../public/modules/report-summary-panel.js', import.meta.url), 'utf8');
  const reset = panel.slice(panel.indexOf('function resetSummaryPanel'));
  assert.ok(/rpt-summary-print-area/.test(reset.slice(0, 500)),
    '인쇄 영역을 감추지 않습니다 — 화면은 비었는데 인쇄물에는 남습니다');
});
