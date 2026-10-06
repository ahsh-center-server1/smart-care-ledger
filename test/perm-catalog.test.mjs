// test/perm-catalog.test.mjs
//
// 권한 카탈로그 자체의 불변식.
//
// 이 파일은 **카탈로그 구조만** 본다. "Rules와 Functions가 실제로 이 표를
// 따르는가"는 test/contract/ 가 맡는다 — 그쪽은 마이그레이션이 끝나기 전에는
// 통과할 수 없으므로 npm test와 분리한다.
//
// 여기서 잡고 싶은 사고
//   · 하한을 기본값보다 높게 적어 아무도 못 쓰게 만드는 것
//   · 서버가 거부하는 키인데 caps 이름이 겹쳐 규칙이 다른 값을 읽는 것
//   · allowedFields와 immutableFields에 같은 필드를 넣는 것
//   · 마이그레이션 중 permissions.js와 카탈로그가 조용히 갈라지는 것

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PERM_CATALOG, PERM_KEYS, SERVER_ENFORCED_KEYS,
  SCOPE, ENFORCE, SERVER_ENFORCED, ADMIN_RANK, SELECTABLE_RANKS,
  CAP_SCHEMA_VERSION, capName, effectiveRank, scopeFor, computeCaps,
} from '../public/domain/perm-catalog.js';
import { DEFAULT_MIN_RANK } from '../public/modules/permissions.js';

const SCOPE_VALUES = Object.values(SCOPE);
const ENFORCE_VALUES = Object.values(ENFORCE);

// ─────────────────────────────────────────────
// 형태
// ─────────────────────────────────────────────

test('카탈로그가 비어 있지 않다', () => {
  assert.ok(PERM_KEYS.length > 0);
  assert.equal(typeof CAP_SCHEMA_VERSION, 'number');
});

test('모든 항목이 필수 필드를 갖는다', () => {
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    assert.ok(SELECTABLE_RANKS.includes(e.defaultRank), `${key}: defaultRank 이상`);
    assert.ok(SELECTABLE_RANKS.includes(e.securityFloor), `${key}: securityFloor 이상`);
    assert.equal(typeof e.configurable, 'boolean', `${key}: configurable`);
    assert.ok(Array.isArray(e.enforcement) && e.enforcement.length > 0, `${key}: enforcement`);
    for (const en of e.enforcement) {
      assert.ok(ENFORCE_VALUES.includes(en), `${key}: 알 수 없는 집행 지점 ${en}`);
    }
  }
});

test('보안 하한이 기본값을 넘지 않는다', () => {
  // 넘으면 기본 상태에서 이미 아무도 쓸 수 없다.
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    assert.ok(e.securityFloor <= e.defaultRank,
      `${key}: 하한 ${e.securityFloor} > 기본 ${e.defaultRank}`);
  }
});

test('조정 불가 키는 하한과 기본값이 같다', () => {
  // 다르면 "조정 불가"인데 조정 여지가 있다고 표시되어 읽는 사람을 속인다.
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    if (e.configurable) continue;
    assert.equal(e.securityFloor, e.defaultRank, `${key}: 조정 불가인데 하한≠기본`);
  }
});

test('범위 값이 정의된 것만 쓰인다', () => {
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    if (e.scope) assert.ok(SCOPE_VALUES.includes(e.scope), `${key}: 알 수 없는 scope`);
    if (e.scopeByRank) {
      for (const [rank, sc] of Object.entries(e.scopeByRank)) {
        assert.ok(SELECTABLE_RANKS.includes(Number(rank)), `${key}: scopeByRank 등급 ${rank}`);
        assert.ok(SCOPE_VALUES.includes(sc), `${key}: scopeByRank 값 ${sc}`);
      }
    }
    assert.ok(!(e.scope && e.scopeByRank), `${key}: scope와 scopeByRank를 함께 쓸 수 없다`);
  }
});

test('Firestore 집행 키는 대상 컬렉션을 밝힌다', () => {
  // 규칙이 어느 match 블록에 붙는지 알 수 없으면 계약 테스트가 대조할 수 없다.
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    if (!e.enforcement.includes(ENFORCE.FIRESTORE)) continue;
    assert.equal(typeof e.resource, 'string', `${key}: resource 없음`);
    assert.ok(e.resource.length > 0, `${key}: resource 빈 문자열`);
  }
});

test('상태 전이 집행 키는 전이 조건을 갖는다', () => {
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    if (!e.enforcement.includes(ENFORCE.TRANSITION)) continue;
    assert.ok(e.transition, `${key}: transition 없음`);
    assert.ok(Array.isArray(e.transition.from), `${key}: transition.from 배열 아님`);
    assert.equal(typeof e.transition.to, 'string', `${key}: transition.to 없음`);
  }
});

test('UI 전용 키는 서버 자원을 주장하지 않는다', () => {
  // resource가 있는데 서버 집행이 없으면 "막힌다"고 오해하게 된다.
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    const serverEnforced = e.enforcement.some(en => SERVER_ENFORCED.includes(en));
    if (serverEnforced) continue;
    assert.equal(e.resource, undefined, `${key}: UI 전용인데 resource가 있다`);
  }
});

test('허용 필드와 불변 필드가 겹치지 않는다', () => {
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    if (!e.allowedFields || !e.immutableFields) continue;
    const overlap = e.allowedFields.filter(f => e.immutableFields.includes(f));
    assert.deepEqual(overlap, [], `${key}: 겹치는 필드 ${overlap.join(', ')}`);
  }
});

test('거래 수정은 보안 필드를 불변으로 둔다', () => {
  // clientId·createdBy가 바뀌면 자기 거래를 남의 입주자로 옮길 수 있다.
  const e = PERM_CATALOG['trx.edit'];
  for (const f of ['clientId', 'createdBy']) {
    assert.ok(e.immutableFields.includes(f), `trx.edit: ${f}가 불변이 아니다`);
  }
  assert.equal(e.authorizeAgainst, 'both');
});

test('계좌를 바꿀 수 있는 키는 입주자 소속을 검사한다', () => {
  for (const key of PERM_KEYS) {
    const e = PERM_CATALOG[key];
    const fields = e.allowedFields || [];
    for (const f of ['accountId', 'linkedAccountId']) {
      if (!fields.includes(f)) continue;
      const checks = e.relatedResourceChecks || [];
      assert.ok(checks.some(c => c.field === f && c.mustBelongTo === 'clientId'),
        `${key}: ${f}를 허용하는데 소속 검사가 없다`);
    }
  }
});

// ─────────────────────────────────────────────
// caps 스냅샷
// ─────────────────────────────────────────────

test('cap 이름이 겹치지 않는다', () => {
  // 겹치면 규칙이 다른 키의 판정을 읽는다.
  const seen = new Map();
  for (const key of SERVER_ENFORCED_KEYS) {
    const name = capName(key);
    assert.ok(!seen.has(name), `cap 충돌: ${key} vs ${seen.get(name)} → ${name}`);
    seen.set(name, key);
  }
});

test('cap 이름은 점을 캐멀케이스로 바꾼 것이다', () => {
  assert.equal(capName('trx.view.all'), 'trxViewAll');
  assert.equal(capName('settings.category.common'), 'settingsCategoryCommon');
  assert.equal(capName('audit.view'), 'auditView');
  // 식별자로 쓸 수 있어야 한다(규칙에서 필드명이 된다).
  for (const key of SERVER_ENFORCED_KEYS) {
    assert.match(capName(key), /^[a-z][A-Za-z0-9]*$/, `${key}: 식별자로 쓸 수 없다`);
  }
});

test('서버 집행 키 전부가 caps에 들어간다', () => {
  const caps = computeCaps(ADMIN_RANK, {});
  for (const key of SERVER_ENFORCED_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(caps, capName(key)),
      `${key}: caps에 없다`);
  }
  assert.equal(Object.keys(caps).length, SERVER_ENFORCED_KEYS.length);
});

test('UI 전용 키는 caps에 들어가지 않는다', () => {
  // 규칙이 읽지 않는 값을 심으면 문서만 커지고 오해를 만든다.
  const caps = computeCaps(ADMIN_RANK, {});
  assert.ok(!Object.prototype.hasOwnProperty.call(caps, capName('trx.csv')));
  assert.ok(!Object.prototype.hasOwnProperty.call(caps, capName('nav.report')));
});

test('등급이 높으면 caps가 줄어들지 않는다', () => {
  // 단조성이 깨지면 승진이 권한을 빼앗는다.
  const ranks = [1, 2, 3, 4, ADMIN_RANK];
  for (let i = 1; i < ranks.length; i++) {
    const lower = computeCaps(ranks[i - 1], {});
    const higher = computeCaps(ranks[i], {});
    for (const [name, allowed] of Object.entries(lower)) {
      if (allowed) assert.ok(higher[name], `등급 ${ranks[i]}에서 ${name}가 사라졌다`);
    }
  }
});

test('관리자는 모든 서버 집행 권한을 갖는다', () => {
  const caps = computeCaps(ADMIN_RANK, {});
  for (const [name, allowed] of Object.entries(caps)) {
    assert.ok(allowed, `관리자인데 ${name}가 false`);
  }
});

test('로그인하지 않은 등급 0은 아무 권한도 없다', () => {
  const caps = computeCaps(0, {});
  for (const [name, allowed] of Object.entries(caps)) {
    assert.equal(allowed, false, `등급 0인데 ${name}가 true`);
  }
});

// ─────────────────────────────────────────────
// 유효 등급
// ─────────────────────────────────────────────

test('모르는 키는 null — fail-closed', () => {
  assert.equal(effectiveRank('trx.nonexistent', {}), null);
  assert.equal(effectiveRank('trx.nonexistent', { 'trx.nonexistent': 1 }), null);
  assert.equal(scopeFor('trx.nonexistent', 4), null);
});

test('오버라이드가 없으면 기본값', () => {
  for (const key of PERM_KEYS) {
    assert.equal(effectiveRank(key, {}), PERM_CATALOG[key].defaultRank, key);
    assert.equal(effectiveRank(key, null), PERM_CATALOG[key].defaultRank, key);
  }
});

test('조정 가능 키는 오버라이드를 반영한다', () => {
  const key = 'trx.csv';   // 하한 1, 기본 2
  assert.equal(effectiveRank(key, { [key]: 4 }), 4);
  assert.equal(effectiveRank(key, { [key]: 1 }), 1);
});

test('보안 하한 아래로는 내려가지 않는다', () => {
  const key = 'audit.view';   // 하한 3
  assert.equal(effectiveRank(key, { [key]: 1 }), 3);
  assert.equal(effectiveRank(key, { [key]: 2 }), 3);
  assert.equal(effectiveRank(key, { [key]: 4 }), 4);
});

test('조정 불가 키는 오버라이드를 완전히 무시한다', () => {
  for (const key of PERM_KEYS) {
    if (PERM_CATALOG[key].configurable) continue;
    for (const r of SELECTABLE_RANKS) {
      assert.equal(effectiveRank(key, { [key]: r }), PERM_CATALOG[key].defaultRank,
        `${key}: 오버라이드 ${r}가 반영됐다`);
    }
  }
});

test('관리자 전용 권한은 어떤 오버라이드로도 내려가지 않는다', () => {
  for (const key of ['settings.permissions', 'settings.reset', 'lock.bypass']) {
    for (const r of [1, 2, 3, 4]) {
      assert.equal(effectiveRank(key, { [key]: r }), ADMIN_RANK, `${key} ← ${r}`);
    }
  }
});

test('결재 단계는 오버라이드로 낮출 수 없다', () => {
  // 낮추면 결재 순서 강제가 무의미해진다.
  assert.equal(effectiveRank('report.approve.center', { 'report.approve.center': 2 }), 4);
  assert.equal(effectiveRank('report.approve.team', { 'report.approve.team': 1 }), 3);
});

test('잘못된 오버라이드 값은 기본값으로 떨어진다', () => {
  const key = 'trx.csv';
  for (const bad of [0, 5, -1, 99.5, 'abc', null, undefined, {}, []]) {
    assert.equal(effectiveRank(key, { [key]: bad }), PERM_CATALOG[key].defaultRank,
      `잘못된 값 ${JSON.stringify(bad)}`);
  }
});

// ─────────────────────────────────────────────
// 범위
// ─────────────────────────────────────────────

test('거래 수정 범위가 등급에 따라 넓어진다', () => {
  assert.equal(scopeFor('trx.edit', 1), SCOPE.OWN);
  assert.equal(scopeFor('trx.edit', 2), SCOPE.ASSIGNED);
  assert.equal(scopeFor('trx.edit', 3), SCOPE.ALL);
  assert.equal(scopeFor('trx.edit', 4), SCOPE.ALL);
  assert.equal(scopeFor('trx.edit', ADMIN_RANK), SCOPE.ALL);
});

test('등급이 하한보다 낮으면 범위가 없다', () => {
  assert.equal(scopeFor('trx.edit', 0), null);
});

test('영수증 권한이 4단계로 나뉘어 있다', () => {
  // 하나의 광역 권한이면 입력자가 남의 거래 증빙까지 바꿀 수 있다.
  assert.equal(scopeFor('receipt.attachOwn', 1), SCOPE.OWN);
  assert.equal(scopeFor('receipt.attachAny', 2), SCOPE.ASSIGNED);
  assert.equal(PERM_CATALOG['receipt.attachAny'].securityFloor, 2);
  assert.equal(PERM_CATALOG['receipt.replace'].securityFloor, 2);
  // 교체는 기존 값과 대조해야 한다(재압축이 generation을 바꾸므로).
  assert.equal(PERM_CATALOG['receipt.replace'].authorizeAgainst, 'both');
});

// ─────────────────────────────────────────────
// permissions.js 와의 대조 (마이그레이션 중 드리프트 방지)
// ─────────────────────────────────────────────

/**
 * 마이그레이션이 끝났다 — 등급표는 이제 한 벌이다.
 *
 * 이 자리에는 "카탈로그가 permissions.js 의 옛 표와 일치하는가"를 묻는
 * 검사 세 개가 있었다. 그 표를 없애고 permissions.js 가 카탈로그에서
 * 파생하게 했으므로, 그 비교는 자기 자신과의 비교가 되어 절대 실패하지
 * 않는다. 절대 실패하지 않는 검사는 안전하다는 착각만 만든다.
 *
 * 대신 지금 실제로 깨질 수 있는 것을 확인한다 —
 * permissions.js 가 다시 자기 등급표를 갖는 것.
 *
 * 마이그레이션 당시의 의도적 차이(기록으로 남긴다):
 *   receipt.upload  2 → 1   스테이징 업로드와 최종 첨부를 분리했으므로
 *                           업로드 자체는 입력자에게 열 수 있다.
 *   신규: receipt.attachOwn · receipt.attachAny · receipt.replace
 */

test('permissions.js 의 기본 등급표가 카탈로그에서 파생된다', () => {
  const derived = Object.fromEntries(PERM_KEYS.map(k => [k, PERM_CATALOG[k].defaultRank]));
  assert.deepEqual(
    DEFAULT_MIN_RANK, derived,
    'permissions.js 가 카탈로그와 다른 등급표를 갖고 있습니다 — 두 벌이 되면 갈라집니다',
  );
});

test('permissions.js 에 손으로 적은 등급 리터럴이 없다', () => {
  // 위 검사는 값만 본다. 값을 똑같이 적어 둔 표도 통과하므로, 표 자체가
  // 다시 생기지 않았는지는 원문을 봐야 안다.
  const src = readFileSync(new URL('../public/modules/permissions.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const literals = [...src.matchAll(/'([a-z][\w]*(?:\.[\w]+)+)'\s*:\s*(\d+|ADMIN_RANK)/g)]
    .map(m => m[0]);
  assert.deepEqual(
    literals, [],
    `permissions.js 에 등급 리터럴이 생겼습니다: ${literals.join(', ')}`,
  );
});

// ─────────────────────────────────────────────
// 등급 계산은 프로덕션에서 죽어 있어야 한다
//
// 권한 판정의 출처는 fixed-role-policy 하나다. perm-catalog 의 등급·오버라이드
// 계산은 표시·검증용 메타데이터로만 남아 있고, 규칙은 caps 를 읽지도 않는다.
//
// 그런데 computeCaps·effectiveRank 는 여전히 export 돼 있어서 "쓰면 되는 것"
// 처럼 보인다. 하나라도 프로덕션 경로로 돌아오면 판정 근거가 다시 두 벌이 되고,
// 이 프로젝트는 그때 화면과 서버가 갈라지는 것을 이미 겪었다.
// ─────────────────────────────────────────────
test('등급 기반 판정이 프로덕션에 없다', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // URL.pathname 을 경로로 쓰면 Windows 에서 `/C:/…` 가 나오고, join 이
  // `C:\C:\…` 를 만든다. fileURLToPath 가 플랫폼에 맞는 경로를 준다.
  const ROOT = fileURLToPath(new URL('..', import.meta.url));

  // 프로덕션 = 브라우저에 가는 코드 + 배포되는 Functions. 테스트·도구는 제외
  // (테스트는 낡은 caps 픽스처를 만들 때 아직 computeCaps 를 쓴다).
  const roots = ['public', 'functions'];
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      // 카탈로그 자신은 당연히 제 함수를 정의한다.
      else if (/\.(js|cjs|mjs)$/.test(name) && !p.includes('perm-catalog')) files.push(p);
    }
  };
  for (const r of roots) walk(join(ROOT, r));

  const banned = /\b(computeCaps|effectiveRank)\s*\(/;
  const hits = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    src.split('\n').forEach((line, i) => {
      if (banned.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim()}`);
    });
  }

  assert.deepEqual(
    hits, [],
    '등급 기반 권한 계산이 프로덕션 코드로 돌아왔습니다:\n  ' + hits.join('\n  ')
      + '\n판정은 fixed-role-policy.js 의 fixedCan/computeFixedCaps 로 합니다.',
  );
});
