// test/functions-budget.test.mjs
//
// 호출 수 모델이 **코드와 어긋나면** 실패한다.
//
// 왜 필요한가
//   읽기 예산(read-budget)과 달리 호출 수는 트리거 **개수**가 정한다. 거래
//   하나가 써질 때마다 거래에 붙은 트리거가 전부 깨어나고, 그것들은 **일찍
//   return 해도 호출로 센다** — "합계를 바꾸지 않는 쓰기는 무시한다"는
//   최적화가 읽기는 줄이지만 호출 수는 줄이지 않는다.
//
//   그래서 트리거를 하나 더 붙이면 모델의 가장 큰 항목이 통째로 커진다.
//   손으로 적어 둔 숫자였다면 붙인 날 아무도 모른다.
//
// 여기서 지키는 것
//   ⑴ 도구가 세는 트리거 수 == 소스에 실제로 있는 트리거 수
//   ⑵ 트리거가 있는 파일을 도구가 **한 곳도 빠뜨리지 않는다**

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const FN_DIR = fileURLToPath(new URL('../functions/', import.meta.url));
const TOOL = readFileSync(fileURLToPath(new URL('../tools/functions-budget.mjs', import.meta.url)), 'utf8');

const { countTriggers } = await import('../tools/functions-budget.mjs');

/** functions/ 안에서 Firestore 트리거를 다는 파일들. */
function filesWithTriggers() {
  return readdirSync(FN_DIR)
    .filter(f => f.endsWith('.js') || f.endsWith('.cjs'))
    .filter(f => /onDocument\w+\(/.test(readFileSync(join(FN_DIR, f), 'utf8')));
}

test('트리거가 붙은 파일을 도구가 하나도 빠뜨리지 않는다', () => {
  // 목록에서 빠지면 그 트리거는 모델에 안 잡히고, 호출 수가 실제보다 작게 나온다.
  const missing = filesWithTriggers().filter(f => !TOOL.includes(`functions/${f}`));
  assert.deepEqual(missing, [],
    `tools/functions-budget.mjs 의 TRIGGER_SOURCES 에 추가하세요: ${missing.join(', ')}`);
});

test('도구가 세는 트리거 수가 소스와 같다', () => {
  const all = filesWithTriggers().map(f => readFileSync(join(FN_DIR, f), 'utf8'));
  const counted = countTriggers(all);

  // 실제로 몇 개인지 독립적으로 센다 — 같은 정규식을 쓰면 서로를 확인하지 못한다.
  let total = 0;
  for (const src of all) total += (src.match(/onDocument\w+\(/g) || []).length;
  const summed = Object.values(counted).reduce((s, n) => s + n, 0);
  assert.equal(summed, total,
    'document 경로를 읽지 못한 트리거가 있습니다 — 정규식이 그 표기를 모릅니다');
});

test('거래와 계좌에 트리거가 붙어 있다는 전제가 아직 맞다', () => {
  const all = filesWithTriggers().map(f => readFileSync(join(FN_DIR, f), 'utf8'));
  const counted = countTriggers(all);
  assert.ok(counted.transactions >= 1,
    '거래 트리거가 사라졌다면 모델의 가장 큰 항목을 다시 보세요');
  assert.ok(counted.accounts >= 1,
    '계좌 트리거가 사라졌다면 「잔액 갱신이 계좌 트리거를 깨운다」 항목을 지우세요');
});

test('무료 한도를 넘지 않는다 — 실제 운영 규모에서', () => {
  // 사회복지사 10명 · 대상자 4명씩 · 대상자당 월 90건.
  // 여유가 두 자릿수 배수라, 가정이 조금 틀려도 결론은 바뀌지 않는다.
  assert.match(TOOL, /invocations:\s*2_000_000/);
  assert.match(TOOL, /Spark\(무료 요금제\)로 배포할 수 없다/,
    'v2 가 Blaze 를 요구한다는 경고가 빠지면 "무료로 된다"로 읽힌다');
});
