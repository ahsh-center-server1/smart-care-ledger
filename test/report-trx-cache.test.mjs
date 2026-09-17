// test/report-trx-cache.test.mjs
//
// 보고서 전용 거래 캐시는 **언제** 버려지는가.
//
// 이유가 뒤집혀 있었다. loadTransactions 가 끝날 때마다 캐시를 버렸는데,
// 거래를 **다시 읽었다고** 보고서가 낡는 것이 아니라 거래가 **바뀌었을 때**
// 낡는다. 그래서 기간 필터만 바꿔도, 입주자를 전환했다 돌아와도 캐시가
// 날아갔다 — 그리고 그 캐시가 담고 있는 것은 **그 입주자의 전체 이력**이라,
// 월초에 보고서를 네 번 열면 네 번 다 몇 년치를 다시 읽었다.
//
// 뒤집을 때 조심할 것: 덜 버리면 **결재 문서에 낡은 숫자가 보인다.** 읽기를
// 아끼려다 그러면 안 된다. 그래서 이 파일은 양쪽을 다 지킨다.
//   1. 읽기는 버리지 않는다
//   2. 쓰기는 **빠짐없이** 버린다

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function jsFiles(dir = PUBLIC, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'vendor' || name === 'icons') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('읽기 경로는 캐시를 버리지 않는다', () => {
  const core = read('public/modules/core.js');
  const fn = core.slice(core.indexOf('export async function loadTransactions'));
  const body = fn.slice(0, fn.indexOf('\n}'))
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/invalidateReportTrxCache/.test(body),
    'loadTransactions 가 아직 캐시를 버립니다 — 조회할 때마다 전체 이력을 다시 읽습니다');
});

test('구현이 한 벌뿐이다', () => {
  // 두 벌이면 한쪽만 고쳐져 "어떤 경로로 저장했느냐"에 따라 보고서가 달라진다.
  const owners = jsFiles()
    .filter(f => /export function invalidateReportTrxCache/.test(readFileSync(f, 'utf8')))
    .map(f => f.replace(PUBLIC, 'public/'));
  assert.deepEqual(owners, ['public/services/firestore.js'], owners.join(', '));
});

test('배치 헬퍼가 거래 쓰기를 스스로 알아챈다', () => {
  // 엑셀·일괄삭제·순서변경·고정항목이 전부 이 헬퍼들을 지난다. 여기서
  // 버리지 않으면 그 네 경로를 각자 기억해야 하고, 언젠가 하나를 빠뜨린다.
  const src = read('public/services/firestore.js');
  for (const fn of ['batchUpdateDocs', 'batchDeleteDocs', 'batchAddDocs',
    'batchSetDocs', 'batchMixedOps']) {
    const at = src.indexOf(`export async function ${fn}(`);
    assert.ok(at > 0, `${fn} 이 없습니다`);
    assert.match(src.slice(at, at + 400), /noteBatch\(/, `${fn} 이 캐시를 버리지 않습니다`);
  }
});

test('거래를 직접 쓰는 파일은 스스로 버린다', () => {
  // 배치 헬퍼를 타지 않는 쓰기 — updateDoc·addDoc 직접 호출. 여기서 빠지면
  // 저장한 값이 보고서에 안 비치고, 사용자는 저장이 안 된 줄 알고 또 저장한다.
  const DIRECT = /\b(addDoc|updateDoc|setDoc|deleteDoc)\(/;
  const offenders = [];
  for (const file of jsFiles()) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n').filter(l => !l.trim().startsWith('//'));
    const writesTrx = lines.some(l => DIRECT.test(l) && /COLS\.TRANSACTIONS/.test(l));
    if (writesTrx && !/invalidateReportTrxCache/.test(src)) {
      offenders.push(file.replace(PUBLIC, 'public/'));
    }
  }
  assert.deepEqual(offenders, [],
    '거래를 직접 쓰는데 보고서 캐시를 버리지 않습니다: ' + offenders.join(', '));
});

test('서버가 거래를 쓰는 경로도 버린다', () => {
  // 콜러블은 브라우저의 배치 헬퍼를 지나지 않는다. 자산이동(saveTransfer)과
  // 영수증(finalizeReceipts·removeReceipt)이 그렇다 — 서버가 거래를 만들고 붙인다.
  // 영수증은 입구가 services/receipt-upload.js 하나라 거기서 버린다.
  for (const [f, fn] of [
    ['public/modules/modals.js', 'saveTransfer'],
    ['public/services/receipt-upload.js', 'finalizeReceipts'],
    ['public/services/receipt-upload.js', 'removeReceipt'],
  ]) {
    const src = read(f);
    assert.ok(src.includes(`'${fn}'`), `${f} 에서 ${fn} 호출을 찾지 못했습니다`);
    assert.match(src, /invalidateReportTrxCache\(/, `${f} 가 캐시를 버리지 않습니다`);
  }
});

test('보고서가 여전히 캐시를 쓴다 — 버리기만 하면 의미가 없다', () => {
  const rpt = read('public/modules/report-trx-source.js');
  const fn = rpt.slice(rpt.indexOf('async function getClientTrx('));
  assert.match(fn.slice(0, 900), /S\.rptTrxCache/, '보고서가 캐시를 읽지 않습니다');
});
