// test/report-id.test.mjs
//
// 보고서 문서 ID 는 (입주자·연·월) 하나에 하나다.
//
// 이 성질이 깨지면 동시 첫 저장이 다시 문서 둘을 만든다 — 그리고 그 고장은
// **조용하다.** 화면은 쿼리 결과의 첫 문서만 쓰므로 나머지는 보이지 않고,
// 목록에만 같은 달이 여러 줄로 뜬다. 그래서 값 자체를 못 박는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const { reportDocId, isCanonicalReportId, REPORT_ID_PREFIX } = require('../functions/report-id.cjs');
const { reportDocId: browserReportDocId } = await import('../public/domain/report-id.js');

test('같은 기간 키는 언제나 같은 ID', () => {
  const a = reportDocId('cli_1', 2026, 3);
  const b = reportDocId('cli_1', 2026, 3);
  assert.equal(a, b);
  // 숫자를 문자열로 줘도 같아야 한다 — 콜러블이 Number() 로 바꾸기 전에
  // 부르는 길이 생기면 ID 가 갈린다.
  assert.equal(reportDocId('cli_1', '2026', '3'), a);
});

test('브라우저와 서버가 같은 canonical ID를 계산한다', async () => {
  for (const input of [
    ['cli_1', 2026, 3],
    ['입주자/1 <b>', 2026, 12],
  ]) {
    assert.equal(await browserReportDocId(...input, webcrypto), reportDocId(...input));
  }
});

test('기간이 다르면 ID 가 다르다', () => {
  const ids = new Set([
    reportDocId('cli_1', 2026, 3),
    reportDocId('cli_1', 2026, 4),
    reportDocId('cli_1', 2025, 3),
    reportDocId('cli_2', 2026, 3),
  ]);
  assert.equal(ids.size, 4);
});

test('구분자가 섞여도 뭉개지지 않는다', () => {
  // NUL 로 나누지 않으면 ('a_1',2026,1) 과 ('a',12026,1) 이 같은 문자열이 된다.
  // 두 입주자의 보고서가 한 문서를 공유하면 남의 장부를 덮어쓴다.
  assert.notEqual(reportDocId('a_1', 2026, 1), reportDocId('a', 12026, 1));
  assert.notEqual(reportDocId('a-2026', 1, 1), reportDocId('a', 2026, 11));
});

test('문서 ID 로 쓸 수 있는 글자만 나온다', () => {
  const id = reportDocId('입주자/1 <b>', 2026, 12);
  assert.ok(id.startsWith(REPORT_ID_PREFIX));
  // Firestore 문서 ID 는 `/` 를 쓸 수 없다. `.` 과 `..` 도 안 된다.
  assert.match(id, /^r_[A-Za-z0-9_-]{32}$/, id);
});

test('연월이 말이 안 되면 거절한다 — 조용히 이상한 ID 를 만들지 않는다', () => {
  for (const bad of [[null, 2026, 1], ['c', 2026, 0], ['c', 2026, 13], ['c', NaN, 1], ['', 2026, 1]]) {
    assert.throws(() => reportDocId(...bad), /reportDocId/, JSON.stringify(bad));
  }
});

test('isCanonicalReportId 는 잘못된 입력에 던지지 않는다', () => {
  // 진단 스크립트가 깨진 문서를 만나도 계속 돌아야 한다.
  assert.equal(isCanonicalReportId('r_x', '', 2026, 1), false);
  assert.equal(isCanonicalReportId('r_x', 'c', 2026, 99), false);
  assert.equal(isCanonicalReportId(reportDocId('c', 2026, 1), 'c', 2026, 1), true);
});

// ─────────────────────────────────────────────────────────
// 서버가 실제로 이것을 쓰는가
// ─────────────────────────────────────────────────────────

const FNS = readFileSync(fileURLToPath(new URL('../functions/report-fns.js', import.meta.url)), 'utf8');

test('보고서를 새로 만들 때 임의 ID 를 쓰지 않는다', () => {
  // `db.collection(REPORTS).doc()` — 인자 없는 doc() 이 임의 ID 다.
  const hits = FNS.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, l]) => /collection\(REPORTS\)\s*\.\s*doc\(\s*\)/.test(l));
  assert.deepEqual(hits.map(([n]) => n), [],
    '보고서에 임의 ID 를 쓰는 곳이 있습니다(canonicalRef 를 쓰세요):\n  '
    + hits.map(([n, l]) => `${n}: ${l.trim()}`).join('\n  '));
});

test('새로 만드는 경로도 트랜잭션 안에서 문서를 읽는다', () => {
  // 읽지 않으면 Firestore 가 충돌을 감지할 것이 없어 둘 다 성공한다 —
  // 결정적 ID 를 써도 tx.get 이 빠지면 같은 고장이 돌아온다.
  assert.match(FNS, /const reportRef = reportId[\s\S]{0,160}?canonicalRef\(clientId, year, month\);[\s\S]{0,120}?await tx\.get\(reportRef\)/,
    'applyReportTransition 이 새 문서를 트랜잭션 안에서 읽지 않습니다');
  assert.match(FNS, /const reportSnap = await tx\.get\(reportRef\)/,
    'saveReportComment 가 보고서를 트랜잭션 안에서 읽지 않습니다');
});

test('조회는 canonical 을 먼저 보고 예전 문서로 떨어진다', () => {
  // 예전 쿼리를 지우면 임의 ID 로 저장된 기존 보고서가 통째로 안 보인다.
  assert.match(FNS, /const canon = await canonicalRef\(clientId, year, month\)\.get\(\)/,
    'findReport 가 canonical 문서를 먼저 보지 않습니다');
  assert.match(FNS, /\.where\('clientId', '==', String\(clientId\)\)/,
    'findReport 에 예전 문서를 찾는 쿼리가 없습니다 — 기존 보고서가 사라집니다');
});

test('브라우저도 canonical 문서를 먼저 보고 예전 쿼리로 떨어진다', () => {
  const store = readFileSync(
    fileURLToPath(new URL('../public/services/report-store.js', import.meta.url)), 'utf8');
  const canonicalAt = store.indexOf('const canonical =');
  const legacyAt = store.indexOf('const legacy =');
  assert.ok(canonicalAt >= 0 && legacyAt > canonicalAt,
    '브라우저가 canonical 문서보다 legacy 쿼리를 먼저 선택합니다');
});
