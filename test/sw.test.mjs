// test/sw.test.mjs
//
// 서비스 워커의 앱 셸 목록이 실제 파일과 어긋나지 않는지 검증한다.
//
// 왜 필요한가
//   이 앱은 PWA(설치형)인데, sw.js의 APP_SHELL에서 빠진 모듈은 오프라인에서
//   로드에 실패한다. ES 모듈은 하나만 못 받아도 import 그래프 전체가 죽으므로
//   "일부 기능만 안 됨"이 아니라 **앱이 흰 화면이 된다**.
//
//   실제로 그런 상태였다: PR #7이 firebase-env.js · report-workflow.js · setup.js ·
//   balance.js · excel-parser.js · fn-errors.js 6개 모듈을 추가했는데 APP_SHELL에는
//   아무것도 추가되지 않았다. 파일을 늘릴 때마다 사람이 기억해야 하는 목록은
//   반드시 어긋나므로 테스트로 고정한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');

/** sw.js의 APP_SHELL 배열에서 경로 문자열을 뽑아낸다. */
function appShell() {
  const m = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(m, 'sw.js에서 APP_SHELL 배열을 찾을 수 없습니다');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * public/ 아래 앱이 실제로 로드하는 정적 자원을 '/경로' 형태로 모은다.
 * vendor/는 별도로 등록하므로 여기서 제외한다(파일이 크고 목록이 고정이다).
 */
function allAppAssets(dir = PUBLIC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'icons' || name === 'vendor') continue;
      allAppAssets(p, out);
    } else if (name.endsWith('.js') || name.endsWith('.css')) {
      out.push('/' + relative(PUBLIC, p).split(/[\\/]/).join('/'));
    }
  }
  return out;
}

test('APP_SHELL에 등록된 파일은 모두 실제로 존재한다', () => {
  const missing = appShell()
    .filter((p) => p !== '/')
    .filter((p) => !existsSync(join(PUBLIC, p)));
  assert.deepEqual(
    missing, [],
    `APP_SHELL에 있지만 파일이 없습니다 (설치 시 캐시 실패):\n  ${missing.join('\n  ')}`,
  );
});

test('앱이 쓰는 모든 JS·CSS가 APP_SHELL에 등록되어 있다', () => {
  const shell = new Set(appShell());
  // sw.js 자신은 캐시 대상이 아니다(항상 네트워크에서 받아야 갱신된다).
  const expected = allAppAssets().filter((p) => p !== '/sw.js');
  const missing = expected.filter((p) => !shell.has(p));
  assert.deepEqual(
    missing, [],
    '오프라인에서 로드 실패할 자원이 있습니다. sw.js의 APP_SHELL에 추가하세요:\n  '
      + missing.join('\n  '),
  );
});

test('index.html이 링크하는 스타일시트는 모두 APP_SHELL에 있다', () => {
  const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
  const shell = new Set(appShell());
  const hrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/g)]
    .map((m) => (m[0].match(/href=["']([^"']+)["']/) || [])[1])
    .filter(Boolean)
    .filter((h) => !/^https?:\/\//.test(h))          // 웹폰트는 외부 — 대체 폰트 스택이 있다
    .map((h) => h.replace(/^\./, ''));               // './styles/x.css' → '/styles/x.css'
  assert.ok(hrefs.length > 0, 'index.html에 로컬 스타일시트 링크가 없습니다');
  const missing = hrefs.filter((h) => !shell.has(h));
  assert.deepEqual(missing, [], 'APP_SHELL에 없는 스타일시트:\n  ' + missing.join('\n  '));
});

test('외부 CDN에서 스크립트를 받지 않는다 — 오프라인·폐쇄망에서도 떠야 한다', () => {
  const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
  // src=/import= 로 실제 로드하는 외부 출처만 본다(주석 안의 언급은 제외).
  const loaders = [
    ...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g),
    ...html.matchAll(/\bfrom\s+["'](https?:\/\/[^"']+)["']/g),
  ].map((m) => m[1]);

  const external = loaders.filter((u) => /^https?:\/\//.test(u));
  assert.deepEqual(
    external, [],
    'index.html이 외부에서 스크립트를 받습니다. tools/vendor.mjs로 로컬화하세요:\n  '
      + external.join('\n  '),
  );
});

test('vendor 결과물이 존재한다', () => {
  for (const f of ['firebase.js', 'chart.umd.js', 'xlsx.bundle.js', 'VERSIONS.json']) {
    assert.ok(
      existsSync(join(PUBLIC, 'vendor', f)),
      `public/vendor/${f} 가 없습니다 — npm run vendor 를 실행하세요`,
    );
  }
});

test('index.html이 vendor/firebase.js에서 가져오는 심볼은 모두 번들에 있다', () => {
  const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
  const m = html.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/vendor\/firebase\.js'/);
  assert.ok(m, "index.html이 './vendor/firebase.js'에서 import하지 않습니다");

  const wanted = m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  assert.ok(wanted.length > 20, `import 심볼이 너무 적습니다 (${wanted.length}개)`);

  // 번들은 minify되어 있으므로 export 구문에서 공개 이름만 확인한다.
  const bundle = readFileSync(join(PUBLIC, 'vendor', 'firebase.js'), 'utf8');
  const exportBlocks = [...bundle.matchAll(/export\s*\{([\s\S]*?)\}/g)]
    .map((x) => x[1]).join(',');
  const exported = new Set(
    exportBlocks.split(',')
      .map((s) => {
        const parts = s.split(/\s+as\s+/);
        return (parts[1] ?? parts[0]).trim();
      })
      .filter(Boolean),
  );

  const missing = wanted.filter((w) => !exported.has(w));
  assert.deepEqual(
    missing, [],
    'index.html이 쓰는데 vendor 번들에 없는 심볼입니다. '
      + 'tools/vendor.mjs의 FIREBASE_ENTRY에 추가하고 npm run vendor 를 실행하세요:\n  '
      + missing.join('\n  '),
  );
});
