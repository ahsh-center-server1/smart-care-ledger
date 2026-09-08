// test/perm-catalog-parity.test.mjs
//
// ESM 카탈로그(화면·생성기) ↔ CJS 카탈로그(서버)의 **동작 동등성.**
//
// 왜 이 파일이 필요한가
//   카탈로그는 public/domain/perm-catalog.js 하나가 출처다. 그런데 functions/ 는
//   별도 배포 단위라 런타임에 public/ 을 읽을 수 없다. 그래서 데이터는 생성기가
//   복사하고(functions/perm-catalog.data.json), **판정 로직만** 양쪽에 있다.
//
//   로직이 두 벌이면 갈라진다. 저장소의 기존 관용구(directories.cjs ↔
//   directory.js, summary-cache.cjs ↔ monthly-summary.js)는 필드 목록을
//   대조하는데, 그것으로는 계산이 달라진 것을 못 잡는다.
//
//   여기서는 **결과를 전수 대조한다.** 전 키 × 전 등급 × 오버라이드 조합에서
//   두 구현이 같은 답을 내야 한다. 한쪽만 고치면 그 조합에서 즉시 빨개진다.
//
// 이 테스트가 막는 사고
//   서버가 화면보다 넓게(또는 좁게) 판정하는 상태로 배포되는 것. 그것이
//   정확히 이 프로젝트가 지금 고치고 있는 원래 버그다 — 등급표가 두 벌이라
//   화면과 서버의 답이 달랐다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esm from '../public/domain/perm-catalog.js';

const require = createRequire(import.meta.url);
const cjs = require('../functions/perm-catalog.cjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────
// 생성물이 낡지 않았는가
// ─────────────────────────────────────────────

test('생성된 데이터가 카탈로그와 일치한다', () => {
  // 카탈로그를 고치고 생성기를 돌리지 않은 채 커밋하는 것을 막는다.
  // 실패하면 `npm run perm-catalog:gen` 을 돌리고 결과를 커밋하면 된다.
  try {
    execFileSync(process.execPath, ['tools/gen-perm-catalog.mjs', '--check'], {
      cwd: ROOT, stdio: 'pipe',
    });
  } catch (err) {
    const out = String((err.stderr || '') + (err.stdout || ''));
    assert.fail(`functions/perm-catalog.data.json 이 낡았습니다.\n${out}`);
  }
});

test('생성물을 직접 고치지 말라는 표시가 있다', () => {
  const data = require('../functions/perm-catalog.data.json');
  assert.match(data._generated, /perm-catalog:gen|gen-perm-catalog/);
});

// ─────────────────────────────────────────────
// 상수가 같은가
// ─────────────────────────────────────────────

test('스키마 버전과 등급 상수가 같다', () => {
  assert.equal(cjs.CAP_SCHEMA_VERSION, esm.CAP_SCHEMA_VERSION);
  assert.equal(cjs.ADMIN_RANK, esm.ADMIN_RANK);
  assert.deepEqual(cjs.SELECTABLE_RANKS, esm.SELECTABLE_RANKS);
});

test('범위·집행 지점 값이 같다', () => {
  assert.deepEqual(cjs.SCOPE, esm.SCOPE);
  assert.deepEqual(cjs.ENFORCE, esm.ENFORCE);
  assert.deepEqual([...cjs.SERVER_ENFORCED].sort(), [...esm.SERVER_ENFORCED].sort());
});

test('권한 키 목록이 같다', () => {
  assert.deepEqual([...cjs.PERM_KEYS].sort(), [...esm.PERM_KEYS].sort());
});

test('서버 집행 키 목록이 같다', () => {
  assert.deepEqual(
    [...cjs.SERVER_ENFORCED_KEYS].sort(),
    [...esm.SERVER_ENFORCED_KEYS].sort(),
  );
});

// ─────────────────────────────────────────────
// 동작이 같은가 — 전수 대조
// ─────────────────────────────────────────────

/** 대조에 쓸 등급. 0(비로그인)과 경계값을 포함한다. */
const RANKS = [0, 1, 2, 3, 4, esm.ADMIN_RANK];

/**
 * 대조에 쓸 오버라이드.
 * 정상값·하한 아래·상한 위·타입 오류·모르는 키를 모두 섞는다.
 */
function overrideCases(keys) {
  const cases = [{}, null, undefined];
  for (const key of keys) {
    for (const v of [1, 2, 3, 4, esm.ADMIN_RANK, 0, 5, -1, 'abc', null]) {
      cases.push({ [key]: v });
    }
  }
  // 모르는 키가 섞여 있어도 결과가 흔들리면 안 된다.
  cases.push({ 'trx.nonexistent': 1, 'trx.csv': 4 });
  return cases;
}

test('capName이 모든 키에서 같은 값을 낸다', () => {
  for (const key of esm.PERM_KEYS) {
    assert.equal(cjs.capName(key), esm.capName(key), key);
  }
});

test('effectiveRank가 전 키 × 전 오버라이드에서 같다', () => {
  const keys = esm.PERM_KEYS;
  let compared = 0;
  for (const key of keys) {
    for (const override of overrideCases([key])) {
      const a = esm.effectiveRank(key, override);
      const b = cjs.effectiveRank(key, override);
      assert.equal(b, a, `${key} ← ${JSON.stringify(override)}`);
      compared += 1;
    }
  }
  assert.ok(compared > 500, `대조가 너무 적습니다 (${compared}건)`);
});

test('모르는 키는 양쪽 다 null이다', () => {
  for (const override of [{}, { 'x.y': 1 }, null]) {
    assert.equal(esm.effectiveRank('x.y', override), null);
    assert.equal(cjs.effectiveRank('x.y', override), null);
  }
});

test('scopeFor가 전 키 × 전 등급에서 같다', () => {
  for (const key of esm.PERM_KEYS) {
    for (const rank of RANKS) {
      assert.equal(cjs.scopeFor(key, rank), esm.scopeFor(key, rank), `${key} @ ${rank}`);
    }
  }
  assert.equal(cjs.scopeFor('x.y', 4), null);
  assert.equal(esm.scopeFor('x.y', 4), null);
});

test('computeCaps가 전 등급 × 전 오버라이드에서 같다', () => {
  // ★ 이것이 이 파일의 핵심이다. 규칙이 읽는 것이 바로 이 값이므로,
  //   여기서 갈라지면 서버가 화면과 다른 판정을 하게 된다.
  const keys = esm.CONFIGURABLE_KEYS;
  let compared = 0;
  for (const rank of RANKS) {
    for (const override of overrideCases(keys)) {
      assert.deepEqual(
        cjs.computeCaps(rank, override),
        esm.computeCaps(rank, override),
        `등급 ${rank} ← ${JSON.stringify(override)}`,
      );
      compared += 1;
    }
  }
  assert.ok(compared > 1000, `대조가 너무 적습니다 (${compared}건)`);
});

// ─────────────────────────────────────────────
// CJS 쪽에만 있는 것
// ─────────────────────────────────────────────

test('rankOf가 역할과 관리자 플래그를 옳게 읽는다', () => {
  assert.equal(cjs.rankOf({ role: '입력자' }), 1);
  assert.equal(cjs.rankOf({ role: '담당자' }), 2);
  assert.equal(cjs.rankOf({ role: '팀장' }), 3);
  assert.equal(cjs.rankOf({ role: '센터장' }), 4);
  // 관리자는 역할과 직교한다 — 가장 낮은 역할이어도 관리자면 최고 등급.
  assert.equal(cjs.rankOf({ role: '입력자', isAdmin: true }), cjs.ADMIN_RANK);
});

test('모르는 역할과 없는 사용자는 등급 0이다', () => {
  // fail-closed. 등급 0이면 computeCaps가 전부 false를 낸다.
  assert.equal(cjs.rankOf({ role: '알수없음' }), 0);
  assert.equal(cjs.rankOf({}), 0);
  assert.equal(cjs.rankOf(null), 0);
  assert.equal(cjs.rankOf(undefined), 0);

  const caps = cjs.computeCaps(0, {});
  assert.equal(Object.values(caps).some(Boolean), false);
});

test('오버라이드 정제가 카탈로그에 없는 키를 버린다', () => {
  // 버리지 않으면 config 문서에 아무 키나 넣어 권한을 만들어낼 수 있다.
  const out = cjs.sanitizeOverride({
    schema: 'minRank',
    minRank: { 'trx.csv': 4, 'made.up.key': 1, 'audit.view': 2 },
  });
  assert.deepEqual(out, { 'trx.csv': 4, 'audit.view': 2 });
});

test('오버라이드 정제가 선택 불가 등급을 버린다', () => {
  const out = cjs.sanitizeOverride({
    schema: 'minRank',
    minRank: { 'trx.csv': 0, 'audit.view': 5, 'trx.reorder': 'x', 'nav.report': 3 },
  });
  assert.deepEqual(out, { 'nav.report': 3 });
});

test('구 형식 문서는 통째로 무시한다', () => {
  // 예전 역할별 boolean 매트릭스. 형식이 다르고 이어받을 의미가 없다.
  assert.deepEqual(cjs.sanitizeOverride({ 입력자: { 'trx.create': true } }), {});
  assert.deepEqual(cjs.sanitizeOverride({ schema: 'other', minRank: { 'trx.csv': 4 } }), {});
  assert.deepEqual(cjs.sanitizeOverride(null), {});
  assert.deepEqual(cjs.sanitizeOverride(undefined), {});
});

test('정제된 오버라이드가 하한을 뚫지 못한다', () => {
  // 정제는 형식만 본다. 하한 강제는 effectiveRank가 한다 — 두 단계 모두 필요하다.
  const override = cjs.sanitizeOverride({
    schema: 'minRank', minRank: { 'settings.reset': 1, 'audit.view': 1 },
  });
  // settings.reset은 조정 불가라 기본값(관리자)이 그대로.
  assert.equal(cjs.effectiveRank('settings.reset', override), cjs.ADMIN_RANK);
  // audit.view는 조정 가능하지만 하한이 3.
  assert.equal(cjs.effectiveRank('audit.view', override), 3);
});
