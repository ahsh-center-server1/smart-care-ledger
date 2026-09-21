// test/summary-cache-shape.test.mjs
//
// 트리거가 만드는 요약 캐시 문서는 **브라우저가 다룰 수 있는 모양**이어야 한다.
//
// 무엇이 잘못돼 있었나
//   `syncSummaryVersion` 은 sourceVersion 만 올렸다.
//
//     db.collection('summaryCaches').doc(key)
//       .set({ sourceVersion: increment(1) }, { merge: true });
//
//   그 (입주자, 월)을 아직 아무도 보지 않은 상태에서 거래가 먼저 써지면 —
//   담당자가 엑셀을 올리는 **가장 흔한 순서**다 — 이 set 이 문서를 새로 만든다.
//   그런데 그 문서에는 `clientId` 가 없고, 규칙은 두 곳에서 그것을 요구한다.
//
//     읽기: seesClient(resource.data.get('clientId', ''))  → '' 라서 거부
//     쓰기: request.resource.data.clientId == resource.data.clientId
//           → 없는 필드를 비교하다 평가 오류로 거부
//
//   그래서 브라우저는 그 캐시를 **읽지도 고치지도 못한다.** 담당자는 아예 읽지
//   못해 「캐시 없음」으로 보고 sourceVersion 0 으로 만들려다 거부되고,
//   팀장·센터장은 읽기는 되지만 갱신이 거부된다. 어느 쪽이든 computedVersion 이
//   영영 채워지지 않아 **그 달의 대시보드가 매번 당월 거래를 다시 읽는다.**
//
//   화면 값은 맞으므로(캐시가 어긋나면 직접 계산으로 떨어진다) 아무도 눈치채지
//   못한다 — 읽기 비용 최적화(§12-1)만 조용히 꺼져 있다. 브라우저 검증이
//   「두 번째 조회는 재계산 없이 캐시로 끝난다」로 처음 잡았다.
//
// 왜 단위 테스트로도 고정하는가
//   저 고장은 **트리거가 도는 환경에서만** 드러난다. 폐쇄망에서는 Functions
//   에뮬레이터를 띄울 수 없어 트리거가 돌지 않고, 그러면 캐시 문서를 만드는
//   것은 언제나 브라우저라서 clientId 가 들어 있다. 즉 로컬에서는 영영 초록이다.
//   소스에서 직접 확인해 두면 거기서도 잡힌다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  summaryKey, affectedSummaryKeys, affectedSummaryTargets,
} = require('../functions/summary-cache.cjs');

const INDEX = readFileSync(fileURLToPath(new URL('../functions/index.js', import.meta.url)), 'utf8');

// ─────────────────────────────────────────────────────────
// 대상 계산
// ─────────────────────────────────────────────────────────

test('영향받는 (입주자, 월)을 clientId 와 함께 돌려준다', () => {
  const targets = affectedSummaryTargets(null, { clientId: 'c1', date: '2026-09-25' });
  assert.deepEqual(targets, [{ key: 'c1_2026-09', clientId: 'c1', ym: '2026-09' }]);
});

test('달이나 입주자가 바뀐 수정은 양쪽을 다 돌려준다', () => {
  const targets = affectedSummaryTargets(
    { clientId: 'c1', date: '2026-08-31' },
    { clientId: 'c2', date: '2026-09-01' },
  );
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.key).sort(), ['c1_2026-08', 'c2_2026-09']);
  // clientId 가 키에서 되짚은 것이 아니라 **문서에서 온 것**이어야 한다.
  assert.deepEqual(targets.map((t) => t.clientId).sort(), ['c1', 'c2']);
});

test('clientId 에 밑줄이 있어도 되짚을 수 있다 — 키를 가르지 않는다', () => {
  // `${clientId}_${ym}` 를 도로 가르는 방식이었다면 여기서 틀린다.
  const id = 'cli_seed_1';
  const [t] = affectedSummaryTargets(null, { clientId: id, date: '2026-09-02' });
  assert.equal(t.clientId, id);
  assert.equal(t.ym, '2026-09');
  assert.equal(t.key, summaryKey(id, '2026-09'));
});

test('날짜가 없는 문서는 집계 대상이 아니다', () => {
  assert.deepEqual(affectedSummaryTargets(null, { clientId: 'c1' }), []);
  assert.deepEqual(affectedSummaryTargets(null, { date: '2026-09-01' }), []);
});

test('키만 쓰던 쪽은 그대로 동작한다', () => {
  const before = { clientId: 'c1', date: '2026-08-31' };
  const after = { clientId: 'c2', date: '2026-09-01' };
  assert.deepEqual(
    affectedSummaryKeys(before, after).sort(),
    affectedSummaryTargets(before, after).map((t) => t.key).sort(),
  );
});

// ─────────────────────────────────────────────────────────
// 트리거가 실제로 그 모양을 쓰는가
// ─────────────────────────────────────────────────────────

test('트리거는 캐시 문서에 clientId 를 함께 심는다', () => {
  // 이 한 줄이 빠지면 규칙이 읽기·쓰기를 모두 막아 캐시가 영영 채워지지 않는다.
  const block = INDEX.slice(INDEX.indexOf('exports.syncSummaryVersion'));
  const setCall = block.slice(block.indexOf('SUMMARY_CACHES'), block.indexOf('{ merge: true }'));
  assert.match(setCall, /clientId/,
    'syncSummaryVersion 이 clientId 없이 캐시 문서를 만듭니다 — 규칙이 그 문서를 막습니다');
  assert.match(setCall, /\bym\b/,
    'syncSummaryVersion 이 ym 을 심지 않습니다');
  assert.match(setCall, /sourceVersion: FieldValue\.increment\(1\)/,
    'sourceVersion 을 올리지 않습니다');
});

test('트리거는 키만 주는 헬퍼를 쓰지 않는다', () => {
  // affectedSummaryKeys 는 clientId 를 돌려주지 않으므로, 그것을 쓰면
  // clientId 를 심을 방법이 없어 같은 고장으로 돌아간다.
  const block = INDEX.slice(INDEX.indexOf('exports.syncSummaryVersion'));
  const body = block.slice(0, block.indexOf('\n);'));
  assert.ok(!/affectedSummaryKeys\s*\(/.test(body),
    'syncSummaryVersion 이 affectedSummaryKeys 를 씁니다 — affectedSummaryTargets 를 쓰세요');
});
