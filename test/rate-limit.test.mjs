// test/rate-limit.test.mjs
//
// 레이트리밋 창(window) 계산.
//
// 영수증 판독은 호출마다 실제 비용이 든다(사진 1장 약 $0.02). 클라이언트 쪽
// 버튼 잠금은 우회할 수 있으니 서버에서 센다. 이 파일은 그 계산이 새지 않는지
// 고정한다 — 새면 비용이 그대로 나간다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { consume } = require('../functions/rateLimit.js');

const OPTS = { maxAttempts: 3, windowMs: 60_000 };
const T0 = 1_700_000_000_000;

test('처음 호출은 새 창을 시작한다', () => {
  assert.deepEqual(consume(undefined, T0, OPTS), { count: 1, windowStart: T0 });
  assert.deepEqual(consume(null, T0, OPTS), { count: 1, windowStart: T0 });
  assert.deepEqual(consume({}, T0, OPTS), { count: 1, windowStart: T0 });
});

test('창 안에서는 누적한다', () => {
  let s = consume(undefined, T0, OPTS);
  s = consume(s, T0 + 1000, OPTS);
  assert.deepEqual(s, { count: 2, windowStart: T0 });
  s = consume(s, T0 + 2000, OPTS);
  assert.deepEqual(s, { count: 3, windowStart: T0 });
});

test('한도를 넘으면 던지고, 언제 풀리는지 알려준다', () => {
  let s = consume(undefined, T0, OPTS);
  s = consume(s, T0 + 1, OPTS);
  s = consume(s, T0 + 2, OPTS);
  assert.throws(() => consume(s, T0 + 3, OPTS), (e) => {
    assert.equal(e.message, 'rate-limit-exceeded');
    // 남은 시간을 알려줘야 화면이 "N초 후 다시" 라고 안내할 수 있다.
    assert.equal(e.retryAfterMs, 60_000 - 3);
    return true;
  });
});

test('창이 지나면 다시 시작한다', () => {
  const s = { count: 99, windowStart: T0 };
  assert.deepEqual(consume(s, T0 + 60_000, OPTS), { count: 1, windowStart: T0 + 60_000 });
  assert.deepEqual(consume(s, T0 + 120_000, OPTS), { count: 1, windowStart: T0 + 120_000 });
});

test('창 경계 — 정확히 windowMs가 지나면 새 창이다', () => {
  const s = { count: 3, windowStart: T0 };
  assert.throws(() => consume(s, T0 + 59_999, OPTS), /rate-limit-exceeded/);
  assert.doesNotThrow(() => consume(s, T0 + 60_000, OPTS));
});

test('시각이 손상된 문서는 새 창으로 본다 — 영구 잠금을 만들지 않는다', () => {
  // windowStart가 깨지면 영원히 막히거나 영원히 통과할 수 있다.
  // 통과하는 쪽(새 창)이 안전하다 — 비용은 다음 창에서 다시 제한된다.
  assert.deepEqual(
    consume({ count: 99, windowStart: 'x' }, T0, OPTS),
    { count: 1, windowStart: T0 },
  );
  assert.deepEqual(
    consume({ count: 99 }, T0, OPTS),
    { count: 1, windowStart: T0 },
  );
});

test('count가 손상돼도 창은 유지한다', () => {
  const s = consume({ count: 'abc', windowStart: T0 }, T0 + 1, OPTS);
  assert.deepEqual(s, { count: 1, windowStart: T0 });
});

test('잘못된 설정은 거부한다 — 한도 0은 기능을 막아 버린다', () => {
  assert.throws(() => consume(undefined, T0, { maxAttempts: 0, windowMs: 1000 }), /maxAttempts/);
  assert.throws(() => consume(undefined, T0, { maxAttempts: -1, windowMs: 1000 }), /maxAttempts/);
  assert.throws(() => consume(undefined, T0, { maxAttempts: 3, windowMs: 0 }), /windowMs/);
});
