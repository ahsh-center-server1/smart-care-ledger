// test/report-session.test.mjs
//
// 「보고서를 보다 다른 탭에 갔다 돌아온다」
//
// 이 파일이 지키는 것은 둘이다.
//   1. 돌아오면 보던 보고서가 다시 열린다 (매번 입주자부터 다시 고르지 않는다)
//   2. 다시 여는 것은 **화면이 아니라 조회다** — 낡은 숫자를 되살리지 않는다
//
// 2번이 이 모듈의 존재 이유다. 계산 결과를 그대로 남겨 두면 코드가 더 짧지만,
// 그 사이 거래를 고쳤거나 동료가 결재했을 때 결재 문서에 낡은 숫자가 보인다.
// 그래서 기억하는 것은 (입주자, 연, 월) 세 개뿐이어야 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rememberOpenReport, restorableReport } from '../public/domain/report-session.js';

const CLIENTS = [{ id: 'c1', name: '김입주' }, { id: 'c2', name: '이입주' }];

test('보던 보고서를 그대로 기억한다', () => {
  assert.deepEqual(
    rememberOpenReport({ clientId: 'c1', year: 2026, month: 3 }),
    { clientId: 'c1', year: 2026, month: 3 });
});

test('연·월 선택칸이 비어 있으면 기억하지 않는다', () => {
  // 빈 select 를 Number() 로 읽으면 0이다. 0년 0월로 복원하면 빈 보고서가 열리고,
  // 사용자는 자기 보고서가 사라진 줄 안다.
  assert.equal(rememberOpenReport({ clientId: 'c1', year: 0, month: 0 }), null);
  assert.equal(rememberOpenReport({ clientId: 'c1', year: 2026, month: 0 }), null);
  assert.equal(rememberOpenReport({ clientId: '', year: 2026, month: 3 }), null);
  assert.equal(rememberOpenReport({}), null);
  assert.equal(rememberOpenReport(), null);
});

test('있을 수 없는 달은 기억하지 않는다', () => {
  assert.equal(rememberOpenReport({ clientId: 'c1', year: 2026, month: 13 }), null);
  assert.equal(rememberOpenReport({ clientId: 'c1', year: 26, month: 3 }), null);
  assert.equal(rememberOpenReport({ clientId: 'c1', year: 2026, month: 3.5 }), null);
});

test('돌아오면 보던 보고서를 다시 연다', () => {
  const open = { clientId: 'c1', year: 2026, month: 3 };
  assert.deepEqual(restorableReport(open, CLIENTS), open);
});

test('담당에서 빠진 입주자는 복원하지 않는다', () => {
  // 그대로 조회하면 규칙이 거절하고 화면에는 오류만 뜬다 — 사용자는 자기가
  // 무엇을 잘못했는지 알 수 없다. 조용히 선택 화면으로 남는 편이 낫다.
  assert.equal(restorableReport({ clientId: 'c9', year: 2026, month: 3 }, CLIENTS), null);
  assert.equal(restorableReport({ clientId: 'c1', year: 2026, month: 3 }, []), null);
});

test('본 적이 없으면 복원할 것도 없다', () => {
  assert.equal(restorableReport(null, CLIENTS), null);
  assert.equal(restorableReport(undefined, undefined), null);
});

// ── 집행 지점 ───────────────────────────────────────────────

test('탭을 떠날 때 보고서를 버리지 않는다', () => {
  // 원래 문제가 여기 한 줄이었다. changeView 가 보고서 탭을 떠나면서
  // S.reportData=null 을 했고, 그래서 돌아오면 입주자부터 다시 골라야 했다.
  const core = readFileSync(new URL('../public/modules/core.js', import.meta.url), 'utf8');
  const block = core.slice(core.indexOf("if(view!=='report')"), core.indexOf("['dashboard','history'"));
  assert.ok(block.length > 0, 'changeView 의 보고서 탭 이탈 구간을 찾지 못했습니다');
  // 주석에 옛 코드가 인용돼 있다. 검사 대상은 코드다 — 주석을 세면 설명을
  // 지워야 통과하는 테스트가 되고, 그러면 왜 이렇게 됐는지가 사라진다.
  const leaving = block.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/reportData\s*=\s*null/.test(leaving),
    '탭을 떠나며 S.reportData 를 버립니다 — 돌아오면 처음부터 다시 골라야 합니다');
  assert.ok(/restoreOpenReport/.test(core),
    '보고서 탭으로 돌아올 때 복원을 부르지 않습니다');
});

test('직접 닫으면 기억도 지운다', () => {
  // 탭 이동은 "잠깐 다른 걸 본다", 닫기는 "그만 본다"다. 구분하지 않으면
  // 닫은 보고서가 탭을 옮길 때마다 되살아난다.
  const report = readFileSync(new URL('../public/modules/report.js', import.meta.url), 'utf8');
  const fn = report.slice(report.indexOf('export function closeReportView'));
  assert.ok(fn.startsWith('export function closeReportView'), 'closeReportView 가 없습니다');
  assert.ok(/reportOpen\s*=\s*null/.test(fn.slice(0, 600)),
    '닫을 때 S.reportOpen 을 지우지 않습니다');
});
