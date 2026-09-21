// test/portability.test.mjs
//
// 깨끗한 Windows 체크아웃에서도 설치되고 검사가 돈다.
//
// 왜 이것을 고정하는가
//   이 저장소를 쓰는 사람은 사회복지사이고, 시설 PC 는 대개 Windows 다.
//   그런데 검사 도구가 Windows 에서만 깨지면 **CI 는 초록인 채로** 그 사람의
//   화면에서만 실패한다 — 원인이 코드처럼 보이므로 개발자를 부르게 된다.
//
//   실제로 세 가지가 있었다.
//     · `new URL(...).pathname` 을 경로로 썼다 → Windows 에서 `/C:/…` 가 나오고
//       join 이 `C:\C:\…` 를 만든다. 해결은 fileURLToPath 다.
//     · join 이 만든 `\` 경로를 POSIX `/` 문자열과 직접 비교했다.
//     · postinstall 이 **설치 안에서 다시 설치**를 불렀다 → Windows npm 11 에서
//       멈춘 뒤 "Exit handler never called" 로 끝났다.
//
//   셋 다 Linux CI 에서는 드러나지 않는다. 그래서 소스 규칙으로 못 박는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const repoPath = (f) => f.replace(ROOT, '').split(sep).join('/');

const SKIP = new Set(['node_modules', 'vendor', '.git', 'icons', '.emu', 'qa-artifacts']);

function sourceFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(mjs|js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

test('URL.pathname 을 파일 경로로 쓰지 않는다', () => {
  // `new URL('..', import.meta.url).pathname` 은 Windows 에서 `/C:/…` 다.
  // POSIX 에서는 우연히 맞아서, 이 실수는 Linux 에서 절대 드러나지 않는다.
  const hits = [];
  for (const file of sourceFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
      if (/import\.meta\.url\s*\)\s*\.pathname/.test(line)) {
        hits.push(`${repoPath(file)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(hits, [],
    'URL.pathname 을 경로로 쓰고 있습니다(fileURLToPath 를 쓰세요):\n  ' + hits.join('\n  '));
});

test('설치 스크립트가 설치를 다시 부르지 않는다', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};

  // npm 의 라이프사이클 훅 안에서 npm install/ci 를 부르면 중첩 설치가 된다.
  const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];
  // `npm --prefix functions ci` 처럼 플래그와 인자가 사이에 끼는 꼴까지 잡는다.
  const nested = LIFECYCLE
    .filter((k) => scripts[k] && /\bnpm\b[^&|;]*\b(ci|install)\b/.test(scripts[k]))
    .map((k) => `${k}: ${scripts[k]}`);

  assert.deepEqual(nested, [],
    '설치 라이프사이클 안에서 다시 설치합니다 — Windows npm 11 에서 멈춥니다.\n'
    + '명시적인 setup/deps 스크립트로 옮기세요:\n  ' + nested.join('\n  '));

  // 정상 경로가 남아 있어야 한다. 훅만 지우면 새 클론이 조용히 반만 설치된다.
  assert.ok(scripts.setup, 'npm run setup 이 없습니다 — 새 클론의 정상 경로가 사라집니다');
  assert.ok(scripts.deps, 'npm run deps 가 없습니다');
  assert.match(scripts.check, /deps:check/,
    'check 가 deps:check 로 시작하지 않으면, 설치가 덜 된 상태가 코드 실패처럼 보입니다');
});

test('경로를 문자열로 비교하는 검사는 구분자를 맞춘다', () => {
  // `file.replace(PUBLIC, 'public/')` 만 하면 Windows 에서
  // `public/services\firestore.js` 가 되어 POSIX 비교가 전부 어긋난다.
  const hits = [];
  for (const file of sourceFiles(join(ROOT, 'test'))) {
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
      // PUBLIC/ROOT 를 떼어 내는 자리에서 split(sep) 이나 replaceAll('\\') 이 없으면 잡는다.
      if (/\.replace\((PUBLIC|ROOT)\s*,/.test(line)
        && !/split\(sep\)|replaceAll\('\\\\\\\\'/.test(line)) {
        hits.push(`${repoPath(file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(hits, [],
    '경로 구분자를 맞추지 않고 문자열로 비교합니다(repoPath 헬퍼를 쓰세요):\n  ' + hits.join('\n  '));
});
