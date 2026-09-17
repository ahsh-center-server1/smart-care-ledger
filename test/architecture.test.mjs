// test/architecture.test.mjs
//
// 구조 경계 — 이 파일이 막는 것은 "천천히 다시 커지는 것"이다.
//
// 왜 필요한가
//   이 앱의 문제는 흩어진 버그가 아니라 구조에서 나왔다. modals.js는 1,600줄이고
//   report.js는 1,400줄이며, 그 안에서 같은 계산이 여러 벌 살아 서로 다른 답을 냈다.
//   한 번 쪼개는 것은 어렵지 않다. 어려운 것은 **다시 붙지 않게 하는 것**이다.
//
//   그래서 상한을 코드로 박고, 지금 넘는 파일은 PENDING_SPLIT에 **현재 줄 수와
//   함께** 적어 둔다. 그 숫자는 줄어들 수만 있다. 늘리려면 이 파일을 고쳐야 하고,
//   그것은 리뷰에 보인다. 예외 목록이 남은 빚의 잔액이 된다.
//
// 왜 상한이 600인가
//   한 파일이 한 화면에서 안 보이면 그 안의 중복을 눈으로 못 잡는다. 이 앱에서
//   실제로 그렇게 됐다(잔액 공식 4벌, 결재 워크플로 2벌). 정확한 숫자에 의미가
//   있는 것은 아니고, "고쳐야 할 만큼 크다"의 선일 뿐이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const repoPath = (path) => path.replaceAll('\\', '/');

const MAX_LINES = 600;

/**
 * 상한을 넘는 파일과 **현재** 줄 수.
 *
 * 규칙: 이 숫자는 줄어들 수만 있다. 파일이 더 커지면 테스트가 실패한다.
 *       600 아래로 내려가면 목록에서 지운다(그것도 테스트가 알려준다).
 *
 * 남은 빚 — 어떻게 쪼갤 것인가:
 *   modals.js         거래 폼 / 엑셀 업로드 / 영수증·통장 / 고정항목 / 일괄등록
 *   report.js         view / approval / excel / annual
 *   functions/index.js auth / balance / triggers / ai
 *   settings.js       패널별 (settings-*.js가 이미 시작한 방향)
 *   transactions.js   표 렌더 / 필터·정렬 / 저장
 */
const PENDING_SPLIT = {
  'public/modules/modals.js':         1624,
  'public/modules/report.js':         1388,
  'public/modules/settings.js':       924,
  'public/modules/transactions.js':   691,
};

/** 우리가 쓰지 않은 코드는 대상이 아니다. */
const SKIP_DIRS = new Set(['vendor', 'node_modules', 'icons', '.git']);

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js') || name.endsWith('.cjs')) out.push(p);
  }
  return out;
}

const SOURCES = [...jsFiles(PUBLIC), ...jsFiles(join(ROOT, 'functions'))]
  .map((p) => repoPath(relative(ROOT, p)));

const lineCount = (rel) => readFileSync(join(ROOT, rel), 'utf8').split('\n').length;

// ─────────────────────────────────────────────────────────
// 파일 크기
// ─────────────────────────────────────────────────────────

test('예외 목록에 없는 파일은 600줄을 넘지 않는다', () => {
  const tooBig = SOURCES
    .filter((rel) => !(rel in PENDING_SPLIT))
    .map((rel) => [rel, lineCount(rel)])
    .filter(([, n]) => n > MAX_LINES)
    .map(([rel, n]) => `${rel} (${n}줄)`);

  assert.deepEqual(tooBig, [],
    `600줄을 넘는 새 파일이 생겼습니다:\n  ${tooBig.join('\n  ')}\n`
    + '쪼개거나, 정말 어쩔 수 없으면 PENDING_SPLIT에 현재 줄 수와 함께 추가하세요.');
});

test('예외로 둔 파일은 더 커지지 않는다', () => {
  const grown = [];
  for (const [rel, cap] of Object.entries(PENDING_SPLIT)) {
    const n = lineCount(rel);
    if (n > cap) grown.push(`${rel}: ${n}줄 (허용 ${cap}줄, +${n - cap})`);
  }
  assert.deepEqual(grown, [],
    `예외로 둔 파일이 더 커졌습니다:\n  ${grown.join('\n  ')}\n`
    + '이 목록의 숫자는 줄어들 수만 있습니다. 기능을 더할 곳이 아니라 쪼갤 곳입니다.');
});

test('600줄 아래로 내려온 파일은 예외 목록에서 지운다', () => {
  const done = Object.keys(PENDING_SPLIT)
    .filter((rel) => lineCount(rel) <= MAX_LINES)
    .map((rel) => `${rel} (${lineCount(rel)}줄)`);

  assert.deepEqual(done, [],
    `축하합니다 — 아래 파일이 상한 아래로 내려왔습니다. PENDING_SPLIT에서 지우세요:\n  `
    + done.join('\n  ') + '\n남겨 두면 다시 커져도 아무도 모릅니다.');
});

test('예외 목록에 없는 파일 항목이 없다', () => {
  const ghosts = Object.keys(PENDING_SPLIT).filter((rel) => !SOURCES.includes(rel));
  assert.deepEqual(ghosts, [],
    `PENDING_SPLIT에 존재하지 않는 파일이 있습니다 (이름이 바뀌었거나 지워졌습니다):\n  ${ghosts.join('\n  ')}`);
});

// ─────────────────────────────────────────────────────────
// 계층
// ─────────────────────────────────────────────────────────

/** 파일이 import하는 상대 경로 목록. */
function importsOf(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const found = [];
  for (const m of src.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  return found;
}

/** 상대 import를 저장소 기준 경로로 바꾼다. 외부 모듈은 null. */
function resolveImport(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  return repoPath(relative(ROOT, resolve(dirname(join(ROOT, fromRel)), spec)));
}

test('domain/은 DOM·Firestore·화면 모듈을 모르는 순수 계층이다', () => {
  // domain/이 화면이나 SDK를 알면 단위 테스트가 불가능해지고, 그러면 계산 규칙이
  // 다시 화면 코드 안으로 흩어진다. 잔액 공식이 4곳에 생긴 경로가 그것이었다.
  const violations = [];
  for (const rel of SOURCES.filter((r) => r.startsWith('public/domain/'))) {
    const src = readFileSync(join(ROOT, rel), 'utf8');

    for (const spec of importsOf(rel)) {
      const target = resolveImport(rel, spec) || spec;
      if (/(^|\/)(modules|services)\//.test(target) || !spec.startsWith('.')) {
        violations.push(`${rel} → ${spec}`);
      }
    }
    // 주석·문자열이 아니라 실제 사용만 본다: 줄 앞이 * 로 시작하면 주석이다.
    for (const line of src.split('\n')) {
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      for (const banned of ['document.', 'window.', 'localStorage']) {
        if (line.includes(banned)) violations.push(`${rel}: ${banned} 사용 — ${line.trim().slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(violations, [],
    `domain/이 순수하지 않습니다:\n  ${violations.join('\n  ')}`);
});

test('services/는 화면 모듈(modules/)을 import하지 않는다', () => {
  // 방향이 한쪽이어야 한다. services → modules가 생기면 순환이 시작되고,
  // 그때부터 무엇을 먼저 로드해야 하는지 아무도 확신할 수 없게 된다.
  //
  // 예외: permissions.js는 등급표라 사실상 domain이지만 modules/에 있다.
  //       옮기는 것이 맞고, 옮길 때까지 여기 적어 둔다.
  const ALLOWED = new Set(['public/modules/permissions.js']);
  const violations = [];
  for (const rel of SOURCES.filter((r) => r.startsWith('public/services/'))) {
    for (const spec of importsOf(rel)) {
      const target = resolveImport(rel, spec);
      if (target && target.startsWith('public/modules/') && !ALLOWED.has(target)) {
        violations.push(`${rel} → ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [],
    `services/가 화면 모듈을 import합니다:\n  ${violations.join('\n  ')}`);
});

// ─────────────────────────────────────────────────────────
// 순환 import
// ─────────────────────────────────────────────────────────

/**
 * 이미 서로 얽혀 있는 모듈 무리. **새로 얽히는 것만 막는다.**
 *
 * 왜 SCC(강결합 요소)로 보는가
 *   "순환을 하나씩 세는" 방식은 탐색 순서에 따라 같은 얽힘이 다른 목록으로
 *   잡힌다 — import 한 줄 순서만 바꿔도 목록이 달라져 테스트가 헛돈다.
 *   SCC는 "서로 오갈 수 있는 파일들의 무리"라 탐색 순서와 무관하게 항상 같다.
 *
 * 왜 지금 못 없애는가
 *   core.js가 화면 모듈들을 부르고, 그 모듈들이 화면 전환·거래 재조회를 다시
 *   core.js로 부른다. 지금은 전부 **함수 바디 안에서만** 부르므로 모듈 초기화
 *   시점에 undefined가 되지는 않는다(core.js 파일 머리에 그 근거가 적혀 있다).
 *   하지만 최상위에서 한 번만 부르면 조용히 깨지고, 증상은 "가끔 함수가 없다"로만
 *   나타난다.
 *
 *   끊는 방법은 화면 전환을 이벤트로 뒤집는 것이다 — 모듈이 core를 부르는 대신
 *   core가 구독한다. modules/ 분해와 같이 해야 하므로 여기 적어 둔다.
 *
 * 규칙: 무리는 커질 수 없다. 파일이 하나라도 더 끼면 실패한다.
 */
const KNOWN_TANGLE = new Set([
  'public/modules/core.js',
  'public/modules/dashboard.js',
  'public/modules/modals.js',
  'public/modules/receipt-intake.js',
  'public/modules/report.js',
  'public/modules/settings.js',
  'public/modules/setup.js',
  'public/modules/transactions.js',
]);

/** import 그래프의 강결합 요소 중 크기 2 이상인 것 (= 순환 무리). */
function tangles() {
  const graph = new Map();
  for (const rel of SOURCES.filter((r) => r.startsWith('public/'))) {
    graph.set(rel, importsOf(rel)
      .map((spec) => resolveImport(rel, spec))
      .filter((t) => t && SOURCES.includes(t)));
  }

  // Tarjan. 재귀 대신 명시 스택 — 파일이 늘어도 스택이 넘치지 않는다.
  let idx = 0;
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const out = [];

  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [node, i] = frame;
      if (i === 0) {
        index.set(node, idx); low.set(node, idx); idx++;
        stack.push(node); onStack.add(node);
      }
      const kids = graph.get(node) || [];
      if (i < kids.length) {
        frame[1]++;
        const next = kids[i];
        if (!index.has(next)) work.push([next, 0]);
        else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
      } else {
        if (low.get(node) === index.get(node)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== node);
          if (comp.length > 1) out.push(comp.sort());
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(node)));
        }
      }
    }
  }
  return out;
}

test('새로 얽히는 모듈이 없다', () => {
  // ES 모듈은 순환이 있어도 로드는 되지만, 초기화 시점에 상대편 export가
  // undefined가 된다. 그러면 "가끔 함수가 없다"는 형태로만 드러난다.
  const novel = [];
  for (const comp of tangles()) {
    const extra = comp.filter((f) => !KNOWN_TANGLE.has(f));
    if (extra.length) novel.push(`${extra.join(', ')} — 무리: ${comp.join(' ↔ ')}`);
  }
  assert.deepEqual(novel, [],
    `새로 순환에 끼어든 모듈이 있습니다:\n  ${novel.join('\n  ')}\n`
    + '한쪽 방향을 끊으세요(대개 화면 전환 호출을 이벤트로 뒤집으면 됩니다).');
});

test('얽힘에서 빠져나온 모듈은 목록에서 지운다', () => {
  const tangled = new Set(tangles().flat());
  const freed = [...KNOWN_TANGLE].filter((f) => !tangled.has(f));
  assert.deepEqual(freed, [],
    `아래 모듈이 순환에서 빠져나왔습니다. KNOWN_TANGLE에서 지우세요:\n  ${freed.join('\n  ')}\n`
    + '남겨 두면 다시 얽혀도 아무도 모릅니다.');
});

test('순환이 실제로 탐지되고 있다 — 검사기 자체의 확인', () => {
  // SCC 계산이 어긋나 빈 결과를 내면 위 두 테스트가 항상 통과한다.
  // 지금은 얽힘이 남아 있다는 것을 알고 있으므로, 0이면 검사기가 고장 난 것이다.
  assert.ok(tangles().length > 0, 'SCC 계산이 아무 순환도 못 찾았습니다 — 검사기를 확인하세요');
});

// ─────────────────────────────────────────────────────────
// 자기 확인
// ─────────────────────────────────────────────────────────

test('검사 대상 파일을 실제로 모으고 있다', () => {
  // 경로가 어긋나 목록이 비면 이 파일 전체가 항상 통과하는 빈 테스트가 된다.
  assert.ok(SOURCES.length >= 25, `검사 대상이 ${SOURCES.length}개뿐입니다`);
  assert.ok(SOURCES.some((r) => r.startsWith('public/domain/')), 'domain/을 못 찾았습니다');
  assert.ok(SOURCES.some((r) => r.startsWith('functions/')), 'functions/를 못 찾았습니다');
});
