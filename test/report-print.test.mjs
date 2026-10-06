// test/report-print.test.mjs
//
// 인쇄물은 **종이를 쓴다.** 화면에서는 티가 안 나는 규칙 하나가 50건짜리
// 보고서를 4쪽으로 만든다.
//
// 실제로 그랬다: 모든 섹션에 `page-break-inside:avoid` 가 걸려 있었는데,
// 거래 내역은 스무 줄만 넘어도 한 쪽에 들어가지 않는다. 브라우저는 먼저 통째로
// 다음 쪽으로 밀어 보고 거기서도 안 들어가니 결국 쪼갠다 — 밀기 전 쪽의 남은
// 절반이 빈 채로 인쇄된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const PRINT = (() => {
  const i = HTML.indexOf('@media print{');
  assert.ok(i > 0, '인쇄 블록을 찾지 못했습니다');
  // 중괄호 균형으로 블록 끝을 찾는다
  let depth = 0;
  for (let j = i + '@media print'.length; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (!depth) return HTML.slice(i, j + 1); }
  }
  throw new Error('인쇄 블록의 괄호가 맞지 않습니다');
})();

test('거래 내역 섹션은 쪽을 넘어 이어진다', () => {
  assert.ok(HTML.includes('id="rpt-trx-section"'),
    '거래 내역 섹션에 id 가 없으면 예외를 가리킬 수 없습니다');
  assert.match(PRINT, /#print-area>div:not\(#rpt-trx-section\)\{[^}]*page-break-inside:avoid/,
    '거래 내역까지 avoid 가 걸리면 앞 쪽의 남은 절반이 빈 채로 인쇄됩니다');
  assert.doesNotMatch(PRINT, /#print-area>div\{[^}]*page-break-inside:avoid/);
});

test('줄 하나는 쪽 경계에서 잘리지 않는다', () => {
  // 섹션은 쪼개도 되지만 **한 거래가 두 쪽에 걸치면** 금액과 내용이 갈린다.
  assert.match(PRINT, /#print-area table tbody tr\{[^}]*page-break-inside:avoid/);
});

test('둘째 쪽부터도 표 머리가 찍힌다', () => {
  assert.match(PRINT, /#print-area table thead\{[^}]*display:table-header-group/,
    '머리가 없으면 둘째 쪽에서 어느 칸이 수입인지 알 수 없습니다');
});

test('인쇄 글자는 화면보다 작다', () => {
  const td = PRINT.match(/#print-area table td,#print-area table th\{\s*font-size:(\d+(?:\.\d+)?)px/);
  assert.ok(td, '표 글자 크기 규칙을 찾지 못했습니다');
  assert.ok(Number(td[1]) <= 11, `표 글자가 ${td[1]}px 입니다 — 결재 문서는 11px 이하로`);
  const body = PRINT.match(/body\{[^}]*font-size:(\d+(?:\.\d+)?)px!important/);
  assert.ok(body && Number(body[1]) <= 12);
});
