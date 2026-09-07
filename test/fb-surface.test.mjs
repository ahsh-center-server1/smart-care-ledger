// test/fb-surface.test.mjs
//
// `fb()`로 꺼내 쓰는 Firebase SDK 심볼이 실제로 노출돼 있는지 검증한다.
//
// 왜 필요한가
//   이 앱은 Firebase SDK를 index.html에서 `window._fb` 객체에 담아 전달하고
//   각 모듈이 `const { getDocs, query } = fb()` 로 꺼내 쓴다. 그 객체에 없는
//   이름을 꺼내면 **undefined가 되고 호출 시점에 터진다** — 그런데 그 호출이
//   try/catch 안이거나 폴백이 있는 곳이면 **조용히 아무 일도 일어나지 않는다.**
//
//   실제로 그랬다: `limit`과 `serverTimestamp`가 목록에 없어서
//   · 변경 이력 조회가 `limit is not a function`으로 실패했고
//   · 변경 이력 쓰기는 auditOp의 try/catch에 걸려 **기록이 그냥 안 남았다**
//     (batchMixedOps의 `serverTimestamp ? ... : Date.now()` 폴백까지 겹쳐
//      더 조용했다).
//   브라우저에서 그 기능을 눌러봐야만 드러나는 종류의 고장이라 테스트로 고정한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'public');
const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');

/** window._fb 에 담기는 이름들. */
function exposedNames() {
  const m = html.match(/window\._fb\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, 'index.html에서 window._fb 대입을 찾을 수 없습니다');
  return new Set(
    m[1].split(',')
      .map(s => s.split(':')[0].trim())
      .filter(Boolean),
  );
}

/** vendor 번들에서 import하는 이름들. */
function importedNames() {
  const m = html.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/vendor\/firebase\.js'/);
  assert.ok(m, "index.html이 './vendor/firebase.js'에서 import하지 않습니다");
  return new Set(
    m[1].split(',')
      .map(s => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean),
  );
}

/** `const { a, b } = fb()` 형태로 꺼내 쓰는 이름을 모은다. */
function destructuredFromFb() {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'vendor' || name === 'icons') continue;
        walk(p);
      } else if (name.endsWith('.js')) files.push(p);
    }
  })(PUBLIC);

  const out = new Map();   // 이름 → 쓰는 파일들
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*fb\(\)/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(':')[0].trim();
        if (!name) continue;
        if (!out.has(name)) out.set(name, []);
        out.get(name).push(relative(ROOT, f));
      }
    }
  }
  return out;
}

test('fb()에서 꺼내 쓰는 모든 심볼이 window._fb에 노출돼 있다', () => {
  const exposed = exposedNames();
  const used = destructuredFromFb();
  assert.ok(used.size > 5, `fb() 구조분해를 찾지 못했습니다 (${used.size}개)`);

  const missing = [...used.entries()]
    .filter(([name]) => !exposed.has(name))
    .map(([name, files]) => `${name}  ← ${[...new Set(files)].join(', ')}`);

  assert.deepEqual(
    missing, [],
    'fb()에서 꺼내 쓰는데 window._fb에 없는 심볼입니다.\n'
      + '호출 시 undefined가 되어 조용히 실패합니다. index.html에 추가하세요:\n  '
      + missing.join('\n  '),
  );
});

test('window._fb에 담는 심볼은 모두 vendor 번들에서 import돼 있다', () => {
  // import를 빼먹으면 그 항목이 undefined로 담긴다 — 위 테스트는 통과하는데
  // 런타임에는 여전히 undefined인 상태가 된다.
  const imported = importedNames();
  const exposed = exposedNames();
  // db·storage는 이 파일에서 만든 인스턴스라 import 대상이 아니다.
  const instances = new Set(['db', 'storage']);

  const missing = [...exposed]
    .filter(n => !instances.has(n) && !imported.has(n));
  assert.deepEqual(
    missing, [],
    'window._fb에 담지만 import하지 않은 심볼 (undefined가 담깁니다):\n  '
      + missing.join('\n  '),
  );
});

test('감사 로그가 쓰는 두 심볼이 특히 노출돼 있다', () => {
  // 이 둘이 빠져 변경 이력이 조용히 기록되지 않았다. 회귀를 이름으로 고정한다.
  const exposed = exposedNames();
  assert.ok(exposed.has('serverTimestamp'),
    'serverTimestamp가 없으면 변경 이력 쓰기가 조용히 실패한다');
  assert.ok(exposed.has('limit'),
    'limit이 없으면 변경 이력 조회가 실패한다');
});
