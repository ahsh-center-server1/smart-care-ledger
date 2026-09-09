import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

/**
 * app.js가 window에 올려놓는 이름들.
 *
 * 이 앱은 HTML의 onclick이 함수 이름을 **문자열로** 참조한다. 이름이 하나만
 * 어긋나도 컴파일러도 ESLint도 잡지 못하고, 사용자가 버튼을 눌렀을 때 조용히
 * 아무 일도 일어나지 않는다. 그래서 여기서 이름을 대조한다.
 */
function globalNames() {
  const app = read('public/app.js');
  const start = app.indexOf('Object.assign(window, {');
  assert.ok(start > 0, 'app.js에서 전역 등록 블록을 찾지 못했습니다');
  // 블록의 짝 맞는 닫는 괄호까지
  let depth = 0, end = -1;
  for (let i = app.indexOf('{', start); i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start, '전역 등록 블록이 닫히지 않았습니다');
  const block = app.slice(start, end);

  const names = new Set();
  // `name: X` 와 축약형 `name,`
  for (const m of block.matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*[:,]/g)) names.add(m[1]);
  // 별도로 붙이는 전역들
  for (const m of app.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  return names;
}

/** 템플릿 보간(${...})을 걷어낸다 — 그 안은 클릭 시점이 아니라 렌더 시점에 실행된다 */
function stripInterpolations(code) {
  let out = '', i = 0;
  while (i < code.length) {
    if (code[i] === '$' && code[i + 1] === '{') {
      let depth = 1; i += 2;
      while (i < code.length && depth > 0) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') depth--;
        i++;
      }
      out += "''";   // 자리만 채운다
    } else out += code[i++];
  }
  return out;
}

/** 주석을 걷어낸다 — 주석 속 예시 코드가 실제 핸들러로 잡히지 않도록 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 인라인 핸들러 문자열에서 **클릭 시점에** 호출되는 식별자를 뽑는다 */
function calledInInlineHandlers(source) {
  const found = new Set();
  const src = stripComments(source);
  const handler = /\bon(?:click|change|input|submit|keyup|keydown|load|error)\s*=\s*(["'])([\s\S]*?)\1/g;
  for (const m of src.matchAll(handler)) {
    const code = stripInterpolations(m[2]);
    for (const c of code.matchAll(/(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) found.add(c[1]);
  }
  // emptyState(icon, text, ctaText, ctaAction) — 마지막 인자가 그대로 onclick이 된다
  for (const m of src.matchAll(/emptyState\([^)]*?,\s*(["'])((?:(?!\1)[\s\S])*)\1\s*\)/g)) {
    for (const c of m[2].matchAll(/(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) found.add(c[1]);
  }
  return found;
}

/** 브라우저가 이미 주는 것들 — 전역 목록에 없어도 정상 */
const BUILTIN = new Set([
  'alert', 'confirm', 'prompt', 'print', 'open', 'close', 'focus', 'blur',
  'setTimeout', 'setInterval', 'clearTimeout', 'requestAnimationFrame',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'Math', 'JSON',
  'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'getElementById', 'querySelector', 'querySelectorAll', 'remove', 'stopPropagation',
  'preventDefault', 'reload', 'if', 'for', 'while', 'return', 'function', 'catch',
]);

test('app.js가 전역을 등록한다', () => {
  const names = globalNames();
  assert.ok(names.size > 50, `전역이 너무 적습니다 (${names.size}) — 파싱이 잘못됐을 수 있습니다`);
});

test('index.html의 onclick이 부르는 함수가 모두 전역에 있다', () => {
  const names = globalNames();
  const used = calledInInlineHandlers(read('public/index.html'));
  assert.ok(used.size > 0, 'index.html에서 인라인 핸들러를 찾지 못했습니다');
  const missing = [...used].filter(n => !names.has(n) && !BUILTIN.has(n));
  assert.deepEqual(missing, [],
    `onclick이 부르는데 전역에 없는 이름: ${missing.join(', ')} — 누르면 조용히 아무 일도 안 일어납니다`);
});

test('모듈이 만들어내는 HTML의 onclick도 모두 전역에 있다', () => {
  // 템플릿 문자열 안의 onclick="fn(...)"도 같은 위험을 갖는다.
  // 실제로 이 방식으로 호출되는 함수가 리팩터링 중에 이름이 바뀌면 조용히 죽는다.
  const names = globalNames();
  const missing = new Set();
  for (const dir of ['public/modules', 'public/services', 'public/utils']) {
    for (const f of readdirSync(new URL('../' + dir + '/', import.meta.url))) {
      if (!f.endsWith('.js')) continue;
      for (const n of calledInInlineHandlers(read(`${dir}/${f}`))) {
        if (!names.has(n) && !BUILTIN.has(n)) missing.add(`${f}: ${n}`);
      }
    }
  }
  assert.deepEqual([...missing], [],
    `모듈이 만든 onclick이 부르는데 전역에 없는 이름: ${[...missing].join(', ')}`);
});

test('전역에 등록만 하고 아무도 부르지 않는 이름이 쌓이지 않는다', () => {
  // 전역은 죽은 코드가 숨기 가장 좋은 곳이다. 어디서도 참조되지 않는 전역이
  // 늘어나면 여기서 걸린다. (허용치를 넘으면 목록을 보고 정리한다)
  const names = globalNames();
  const sources = [];
  for (const dir of ['public/modules', 'public/services', 'public/utils']) {
    for (const f of readdirSync(new URL('../' + dir + '/', import.meta.url))) {
      if (f.endsWith('.js')) sources.push(read(`${dir}/${f}`));
    }
  }
  sources.push(read('public/index.html'));
  const blob = sources.join('\n');
  const unused = [...names].filter(n => {
    if (n.length < 3) return false;
    return !new RegExp(`\\b${n}\\b`).test(blob);
  });
  assert.ok(unused.length <= 30,
    `아무도 부르지 않는 전역이 ${unused.length}개입니다: ${unused.slice(0, 40).join(', ')}`);
});

// ─────────────────────────────────────────────
// 페이지네이션 · 재정렬 (7단계에서 고친 것)
// ─────────────────────────────────────────────
const { clampPage, canReorderNow } = await import('../public/modules/transactions.js');
const { S } = await import('../public/state.js');

test('페이지가 결과 범위를 벗어나면 마지막 페이지로 당겨진다', () => {
  // 5페이지에서 결과를 3건으로 좁히면 slice(400,3) → 빈 표.
  // 페이지 버튼도 사라져서 1페이지로 돌아갈 방법이 없었다.
  assert.equal(clampPage(5, 3, 100), 1);
  assert.equal(clampPage(5, 450, 100), 5);
  assert.equal(clampPage(9, 450, 100), 5);
  assert.equal(clampPage(1, 0, 100), 1);
});

test('페이지 번호가 이상해도 1 이상이다', () => {
  for (const bad of [0, -3, NaN, undefined, null, 'x']) {
    assert.equal(clampPage(bad, 500, 100), 1, `${bad}가 1로 보정되지 않습니다`);
  }
});

test('순서 변경은 날짜순으로 볼 때만 허용된다', () => {
  // 금액순으로 보다가 한 행을 옮기면 그 페이지 전체가 금액순으로 영구 저장됐다
  S.sortKey = 'amountOut';
  assert.equal(canReorderNow(), false, '금액순에서 순서 변경이 열려 있습니다');
  S.sortKey = 'category';
  assert.equal(canReorderNow(), false);
  S.sortKey = 'date';
  assert.equal(canReorderNow(), true);
  S.sortKey = 'sortOrder';
  assert.equal(canReorderNow(), true);
  S.sortKey = 'date';
});

// ─────────────────────────────────────────────
// 값이 실제로 있는가
//
// 위 검사들은 **이름**만 대조한다. app.js가 `foo: Settings.foo`로 등록하는데
// settings.js가 foo를 내보내지 않으면, 이름은 양쪽에 다 있으므로 통과한다.
// 그리고 window.foo === undefined 가 되어 버튼이 조용히 죽는다.
//
// 실제로 그런 일이 있었다: 변경 함수들을 settings-crud.js로 옮기면서
// toggleStaffActive를 재export 목록에 빠뜨렸고, 이름 검사는 전부 통과했다.
// ─────────────────────────────────────────────

/**
 * `이름: 모듈.export` 쌍을 뽑는다.
 *
 * app.js를 직접 import하지 않는 이유: 최상위에서 window를 건드리므로 Node에서
 * 죽는다. 그래서 등록 블록을 파싱하고 각 모듈만 따로 import해 확인한다.
 */
function registeredFromModules() {
  const app = read('public/app.js');

  // import * as Alias from './path.js'
  const alias = new Map();
  for (const m of app.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*'([^']+)'/g)) {
    alias.set(m[1], m[2]);
  }

  const start = app.indexOf('Object.assign(window, {');
  let depth = 0, end = -1;
  for (let i = app.indexOf('{', start); i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = app.slice(start, end);

  const pairs = [];
  for (const m of block.matchAll(/(\w+)\s*:\s*(\w+)\.(\w+)\s*[,}]/g)) {
    const [, globalName, mod, exportName] = m;
    if (alias.has(mod)) pairs.push({ globalName, path: alias.get(mod), exportName });
  }
  return pairs;
}

test('전역으로 등록한 값이 실제로 존재한다', async () => {
  const pairs = registeredFromModules();
  assert.ok(pairs.length >= 30, `등록 쌍이 너무 적습니다 (${pairs.length}) — 파싱이 깨졌을 수 있습니다`);

  const cache = new Map();
  const missing = [];
  for (const { globalName, path, exportName } of pairs) {
    if (!cache.has(path)) {
      cache.set(path, await import(new URL('../public/' + path.replace(/^\.\//, ''), import.meta.url)));
    }
    const mod = cache.get(path);
    if (typeof mod[exportName] !== 'function') {
      missing.push(`window.${globalName} ← ${path} 의 ${exportName} (${typeof mod[exportName]})`);
    }
  }

  assert.deepEqual(
    missing, [],
    'app.js가 등록하는 값이 모듈에 없습니다 — 버튼이 조용히 죽습니다:\n  '
    + missing.join('\n  '),
  );
});
