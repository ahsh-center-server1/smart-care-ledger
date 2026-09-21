// test/read-budget.test.mjs
//
// 「읽지 않는다」를 지키는 시험.
//
// Firestore 무료 한도는 하루 읽기 5만이고, 이 앱에서 그것을 결정하는 것은
// 한 동작의 읽기 수가 아니라 **그것 × 인원 × 세션 수**다. 가장 큰 항목은
// 로그인할 때의 당월 집계였다 — 보는 입주자 1명당 요약 캐시 1건에, 캐시가
// 낡았으면 그 달 거래 전부를 다시 읽는다.
//
// 그런데 그 숫자는 **장부를 쓰는 사람**의 것이다. 카드의 「당월 수입/지출·
// 미분류 n건·고정항목 n건 미납」은 오늘 무엇을 더 해야 하는지 보는 값이고,
// 팀장·센터장은 거래를 입력하지 않는다(작성자와 결재자의 분리). 결재할
// 숫자는 보고서에서 본다. 그래서 읽지 않는다.
//
// 읽지 않기로 했으면 **읽지 않았다고 말해야 한다.** 빈 객체로 떨어뜨리면
// 카드가 「당월 거래 없음」이라고 적고, 결재자는 그것을 이번 달 거래가
// 없다는 뜻으로 읽는다 — 절약이 거짓말이 된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixedCan } from '../public/domain/fixed-role-policy.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('결재 역할은 거래를 입력하지 않는다 — 게이트의 전제', () => {
  // can('trx.create') 로 막는 것이 옳으려면, 그 권한이 정확히 장부를 쓰는
  // 사람에게만 있어야 한다. 정책이 바뀌면 이 시험이 먼저 깨진다.
  const has = (role) => fixedCan({ role, enabled: true }, 'trx.create');
  assert.ok(has('입력자'), '입력자가 거래를 입력하지 못합니다');
  assert.ok(has('담당자'), '담당자가 거래를 입력하지 못합니다');
  assert.ok(!has('팀장'), '팀장이 trx.create 를 갖습니다 — 게이트가 결재자를 막지 못합니다');
  assert.ok(!has('센터장'), '센터장이 trx.create 를 갖습니다');
});

test('당월 집계를 거래 쓰는 역할만 읽는다', () => {
  const core = read('public/modules/core.js');
  const at = core.indexOf("if (need('monthlyStats'))");
  assert.ok(at > 0, "core.js 에서 당월 집계 블록을 찾지 못했습니다");
  const block = core.slice(at, at + 600);
  assert.match(block, /if \(!can\('trx\.create'\)\)/,
    '당월 집계가 결재 역할에게도 그대로 나갑니다');
  // 요약 캐시 조회가 그 게이트 **뒤에** 있어야 한다. 앞에 있으면 막아도 읽는다.
  assert.ok(core.indexOf('fetchMonthlySummaries(', at) > core.indexOf("!can('trx.create')", at),
    '게이트보다 먼저 요약 캐시를 읽습니다');
});

test('읽지 않았을 때 0이 아니라 null 로 남긴다', () => {
  // 이것이 절약과 거짓말을 가른다. {} 면 카드가 「당월 거래 없음」이라고 적는다.
  const core = read('public/modules/core.js');
  const at = core.indexOf("if (!can('trx.create'))");
  const block = core.slice(at, at + 500);
  assert.match(block, /S\.monthlyStats = null/, '읽지 않은 것을 빈 값으로 둡니다');
  assert.match(block, /S\.fixedGap = null/, '고정항목 미납도 빈 값으로 둡니다');
});

test('카드가 읽지 않은 집계를 「당월 거래 없음」으로 적지 않는다', () => {
  const dash = read('public/modules/dashboard.js');
  assert.ok(!/S\.monthlyStats\?\.\[client\.id\]\s*\|\|/.test(dash),
    '옵셔널 체이닝으로 0에 떨어집니다 — 읽지 않은 것과 0을 구분하지 못합니다');
  assert.match(dash, /const tracked\s*=\s*!!S\.monthlyStats/,
    '집계를 읽었는지 확인하지 않습니다');
  // 그 줄을 그릴지 말지가 tracked 에 달려 있어야 한다.
  assert.match(dash, /statsHTML\s*=\s*tracked/,
    '읽지 않았을 때도 당월 합계 줄을 그립니다');
});

test('null 을 그대로 넘겨 다른 화면이 깨지지 않는다', () => {
  // 기본값(= {})은 undefined 일 때만 먹는다. null 을 넘기면
  // Object.entries(null) 에서 설정 「개요」 패널이 통째로 죽는다.
  const ov = read('public/modules/settings-overview.js');
  assert.match(ov, /fixedGap: S\.fixedGap \|\| \{\}/,
    '설정 개요가 null 을 그대로 넘깁니다');
});

test('예산 모델이 코드와 어긋나면 알린다', () => {
  // 모델은 "팀장·센터장은 그 항목을 0으로 계산한다"고 가정한다. 게이트가
  // 사라지면 모델이 조용히 거짓이 되므로, 스크립트가 소스를 직접 확인한다.
  const out = execFileSync(process.execPath,
    [fileURLToPath(new URL('../tools/read-budget.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.ok(!/모델과 코드가 어긋납니다/.test(out), out);
  assert.match(out, /✔ 여유 있음/, out);
});
