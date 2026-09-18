// test/timestamps.test.mjs
//
// 「작성일: Invalid Date」 — 결재 문서에 그대로 인쇄돼 나갔다.
//
// 원인은 시각이 **두 가지 모양**으로 저장된다는 것이다. 결재 도장(submittedAt …)은
// 전이표가 만든 ISO 문자열이고, createdAt 은 서버가 찍은 Firestore Timestamp 다.
// `new Date(값)` 은 앞의 것만 처리한다 — 뒤의 것을 넣으면 예외도 경고도 없이
// Invalid Date 가 되고, 그 글자가 인쇄물에 그대로 남는다.
//
// 그래서 (1) 변환을 한 곳으로 모으고 (2) 화면이 타임스탬프를 직접 `new Date()` 로
// 감싸지 못하게 막는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toDate, formatDate, formatDateTime, reportDateLine,
} from '../public/domain/timestamps.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 서버가 찍는 그 모양 — SDK 객체와 직렬화된 것 둘 다 온다. */
const sdkTimestamp = (iso) => ({ toDate: () => new Date(iso) });
const rawTimestamp = (iso) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 });

test('Firestore 타임스탬프 · ISO 문자열 · Date 를 모두 읽는다', () => {
  const iso = '2026-09-05T02:30:00.000Z';
  const want = new Date(iso).getTime();
  for (const [name, value] of [
    ['SDK Timestamp', sdkTimestamp(iso)],
    ['직렬화된 Timestamp', rawTimestamp(iso)],
    ['admin SDK 모양(_seconds)', { _seconds: Math.floor(want / 1000) }],
    ['ISO 문자열', iso],
    ['숫자', want],
    ['Date', new Date(iso)],
  ]) {
    const d = toDate(value);
    assert.ok(d instanceof Date, `${name}: Date 가 아닙니다`);
    assert.equal(Math.floor(d.getTime() / 1000), Math.floor(want / 1000), name);
  }
});

test('모르면 null 이다 — 1970년을 인쇄하지 않는다', () => {
  // 0을 돌려주면 결재 문서에 1970-01-01 이 찍힌다. 빈칸보다 나쁘다.
  for (const bad of [null, undefined, '', 'not a date', {}, NaN, new Date('x')]) {
    assert.equal(toDate(bad), null, `${String(bad)} 를 날짜로 읽었습니다`);
  }
});

test('형식 두 가지 — 인쇄물은 그대로, 목록은 줄이 맞게', () => {
  const ts = sdkTimestamp('2026-09-05T02:30:00.000Z');
  assert.match(formatDate(ts), /2026/);
  assert.match(formatDateTime(ts), /^2026-09-05 \d{2}:\d{2}$/);
  // 모르는 값에는 부르는 쪽이 정한 문구가 나간다.
  assert.equal(formatDate(null, '미제출'), '미제출');
  assert.equal(formatDateTime(null), '');
});

// ─────────────────────────────────────────────────────────
// 무엇을 보여 줄 것인가
// ─────────────────────────────────────────────────────────

test('제출된 보고서는 제출일을 보여 준다', () => {
  // 작성일은 임시저장을 처음 누른 시점이라, 며칠 손보다 올린 보고서에서는
  // 결재자가 본 날짜와 어긋난다.
  const line = reportDateLine({
    createdAt: rawTimestamp('2026-09-01T00:00:00.000Z'),
    submittedAt: '2026-09-05T02:30:00.000Z',
  });
  assert.equal(line.label, '제출일');
  assert.equal(line.date.toISOString(), '2026-09-05T02:30:00.000Z');
});

test('제출 전에는 작성일이고, 이름표도 같이 바뀐다', () => {
  // 같은 자리에 다른 뜻이 들어가는데 이름이 그대로면 읽는 사람이 속는다.
  const line = reportDateLine({ createdAt: rawTimestamp('2026-09-01T00:00:00.000Z') });
  assert.equal(line.label, '작성일');
  assert.equal(line.date.getUTCFullYear(), 2026);

  const empty = reportDateLine(null);
  assert.equal(empty.label, '작성일');
  assert.equal(empty.date, null);
});

test('반려된 보고서는 제출 도장이 지워져 작성일로 돌아간다', () => {
  // 전이표가 도착 상태보다 뒤 단계의 도장을 지운다(반려에 제출 서명이 남으면 안 된다).
  // 그 상태에서 「제출일」이라고 적으면 거짓말이 된다.
  const line = reportDateLine({ createdAt: rawTimestamp('2026-09-01T00:00:00.000Z'), status: 'rejected' });
  assert.equal(line.label, '작성일');
});

// ─────────────────────────────────────────────────────────
// 다시 새지 않게
// ─────────────────────────────────────────────────────────

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'vendor' || name === 'icons') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('화면이 저장된 시각을 new Date() 로 직접 감싸지 않는다', () => {
  // 이것이 정확히 Invalid Date 를 만든 코드 모양이다. 예외도 경고도 없어서
  // 인쇄물을 눈으로 보기 전까지 아무도 모른다.
  const bad = [];
  for (const abs of jsFiles(join(ROOT, 'public'))) {
    const rel = relative(ROOT, abs).replaceAll('\\', '/');
    if (rel === 'public/domain/timestamps.js') continue;   // 변환을 맡은 곳
    for (const m of read(rel).matchAll(/new Date\(([^)]*)\)/g)) {
      const arg = m[1];
      if (/\b\w*(At|Time|timestamp|Timestamp)\b/.test(arg)) bad.push(`${rel}: new Date(${arg})`);
    }
  }
  assert.deepEqual(bad, [],
    '저장된 시각은 domain/timestamps.js 의 toDate/formatDate 로 읽으세요:\n  '
    + bad.join('\n  '));
});

test('보고서 화면과 목록이 같은 변환을 쓴다', () => {
  const src = read('public/modules/report.js');
  assert.match(src, /reportDateLine\(report\)/, '보고서 화면이 제출일 규칙을 쓰지 않습니다');
  assert.match(src, /formatDate\(r\.submittedAt/, '목록이 제출일을 보여 주지 않습니다');
  assert.match(read('public/index.html'), /id="rpt-date-label"/, '이름표 자리가 없습니다');
});
