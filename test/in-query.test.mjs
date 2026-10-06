// test/in-query.test.mjs
//
// Firestore `in` 절 분할.
//
// 배경 — 예전 코드는 담당 입주자가 30명을 넘으면 필터를 빼고 전체를 스캔하는
// 폴백으로 넘어갔다. 그 순간 (1) 읽기량이 급증하고 (2) 보안 규칙 아래에서는
// 범위 밖 문서가 섞여 쿼리 전체가 거부된다. 그래서 폴백을 없애고 나눠 조회한다.
// **빈 입력이 빈 배열이라는 성질이 그 안전장치의 핵심이다** — 호출자가
// "조회할 것 없음"을 "전체 조회"로 착각할 수 없어야 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkForInQuery, IN_QUERY_CHUNK_SIZE } from '../public/services/in-query.js';

test('Firestore in 절 상한은 30이다', () => {
  assert.equal(IN_QUERY_CHUNK_SIZE, 30);
});

test('한도 이하면 한 덩어리', () => {
  const ids = Array.from({ length: 30 }, (_, i) => 'c' + i);
  assert.deepEqual(chunkForInQuery(ids), [ids]);
});

test('한도를 넘으면 나눈다 — 어떤 덩어리도 상한을 넘지 않는다', () => {
  const ids = Array.from({ length: 71 }, (_, i) => 'c' + i);
  const chunks = chunkForInQuery(ids);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.length), [30, 30, 11]);
  for (const c of chunks) assert.ok(c.length <= IN_QUERY_CHUNK_SIZE);
  // 값이 유실되거나 중복되지 않는다
  assert.deepEqual(chunks.flat(), ids);
});

test('빈 입력은 빈 배열 — 조회를 아예 하지 않는다는 뜻', () => {
  // 여기서 [[]]를 돌려주면 호출자가 where('in',[])로 빈 결과를 받거나,
  // 최악의 경우 필터 없는 쿼리를 만들 수 있다.
  assert.deepEqual(chunkForInQuery([]), []);
  assert.deepEqual(chunkForInQuery(null), []);
  assert.deepEqual(chunkForInQuery(undefined), []);
});

test('null·빈 문자열은 걸러낸다 — 쓸 수 없는 값이 쿼리에 들어가지 않게', () => {
  assert.deepEqual(chunkForInQuery(['a', null, '', 'b', undefined]), [['a', 'b']]);
  // 걸러낸 뒤 아무것도 없으면 빈 배열이어야 한다
  assert.deepEqual(chunkForInQuery([null, '', undefined]), []);
});

test('0은 유효한 값으로 남긴다', () => {
  assert.deepEqual(chunkForInQuery([0, 1]), [[0, 1]]);
});

test('크기를 직접 줄 수 있고, 0 이하는 거부한다', () => {
  assert.deepEqual(chunkForInQuery(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
  assert.throws(() => chunkForInQuery(['a'], 0), RangeError);
  assert.throws(() => chunkForInQuery(['a'], -1), RangeError);
});

test('원본 배열을 변경하지 않는다', () => {
  const ids = ['a', 'b', 'c'];
  chunkForInQuery(ids, 2);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});
