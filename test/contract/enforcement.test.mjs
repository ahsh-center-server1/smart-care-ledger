// test/contract/enforcement.test.mjs
//
// 집행 계약 — **4개 집행 지점이 권한 카탈로그를 실제로 따르는가.**
//
// 이 파일은 npm test 에 들어가지 않는다(`npm run test:contract`). 마이그레이션이
// 끝나기 전에는 통과할 수 없기 때문이다. 카탈로그만 추가해도 Rules와 Functions는
// 여전히 토큰 역할과 하드코딩 등급을 쓰므로, 여기를 npm test 에 넣으면 초록불
// 기준선(484개)이 깨지고 CI가 아무것도 뜻하지 않게 된다.
//
// 각 검사는 **한 마이그레이션 단계의 게이트**다. 단계가 끝나면 해당 검사가
// 통과로 바뀌고, 다시 빨개지면 그 단계가 되돌아갔다는 뜻이다.
//
//   게이트 A  Functions 전환 — 토큰 역할 참조 제거
//   게이트 B  Firestore Rules 전환 — 등급 리터럴 제거, caps 참조
//   게이트 C  Storage Rules 전환 — 같은 것 + 담당 범위 검사
//   게이트 D  브라우저 직접 쓰기 차단 — 서버 함수로 이전
//
// 판정 근거를 좁게 잡는 이유
//   "규칙에 숫자 0건"은 너무 넓다. 파일 크기 상한(15 * 1024 * 1024), 스키마
//   버전, 문자열 길이 같은 정당한 숫자가 있다. 그래서 **authorization 판정에
//   쓰이는 등급 숫자만** 검사한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PERM_CATALOG, PERM_KEYS, SERVER_ENFORCED_KEYS,
  ENFORCE, capName,
} from '../../public/domain/perm-catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const firestoreRules = read('firestore.rules');
const storageRules = read('storage.rules');

/** functions/ 의 우리 소스만 (node_modules 제외). */
function functionSources(dir = join(ROOT, 'functions'), out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) functionSources(p, out);
    else if (/\.(js|cjs|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** 줄 단위로 패턴을 찾아 "파일:줄" 목록을 준다 — 실패 메시지가 바로 쓸 수 있게. */
function findLines(files, re) {
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim()}`);
    });
  }
  return hits;
}

/** 규칙 파일 안의 주석을 지운다 — 주석에 남은 설명이 위반으로 잡히지 않게. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ─────────────────────────────────────────────
// 게이트 A — Functions 가 토큰 역할을 보지 않는다
// ─────────────────────────────────────────────

test('[게이트 A] Functions가 토큰의 role·isAdmin을 권한 근거로 쓰지 않는다', () => {
  // 근거는 authz/{uid} 문서다. 토큰 클레임은 제거 대상이고, 남아 있으면
  // 역할 변경이 재로그인 전까지 서버에 반영되지 않는다.
  const hits = findLines(
    functionSources(),
    /auth\.token[\s\S]*?\.(get\(\s*['"])?(role|isAdmin)\b/,
  );
  assert.deepEqual(
    hits, [],
    '토큰 역할 참조가 남아 있습니다 (authz 문서로 옮기세요):\n  ' + hits.join('\n  '),
  );
});

test('[게이트 A] 로그인이 커스텀 토큰에 role·isAdmin을 싣지 않는다', () => {
  const src = read('functions/index.js');
  const m = src.match(/createCustomToken\([^)]*\)/s);
  assert.ok(m, 'createCustomToken 호출을 찾을 수 없습니다');
  assert.ok(
    !/\brole\b|\bisAdmin\b/.test(m[0]),
    '커스텀 토큰에 역할이 실려 있습니다. 근거가 두 벌이 됩니다:\n  ' + m[0],
  );
});

// ─────────────────────────────────────────────
// 게이트 B — Firestore Rules
// ─────────────────────────────────────────────

test('[게이트 B] firestore.rules에 역할 등급 표가 없다', () => {
  const src = stripComments(firestoreRules);
  assert.ok(
    !/['"]입력자['"]\s*:\s*1/.test(src),
    '역할 등급 표가 하드코딩돼 있습니다. authz.caps 불리언으로 바꾸세요.',
  );
});

test('[게이트 B] firestore.rules에 atLeast(등급) 리터럴이 없다', () => {
  const src = stripComments(firestoreRules);
  const hits = [...src.matchAll(/atLeast\(\s*(\d+)\s*\)/g)].map(m => m[0]);
  assert.deepEqual(
    hits, [],
    '등급 리터럴이 남아 있습니다 (관리자 오버라이드가 무시됩니다):\n  ' + hits.join('\n  '),
  );
});

test('[게이트 B] Firestore 집행 키의 caps를 규칙이 실제로 읽는다', () => {
  const src = stripComments(firestoreRules);
  const missing = PERM_KEYS
    .filter(k => PERM_CATALOG[k].enforcement.includes(ENFORCE.FIRESTORE))
    .filter(k => !src.includes(capName(k)));
  assert.deepEqual(
    missing.map(k => `${k} → caps.${capName(k)}`), [],
    'firestore.rules가 읽지 않는 권한이 있습니다:\n  '
      + missing.map(k => `${k} → caps.${capName(k)}`).join('\n  '),
  );
});

/**
 * match 블록을 경로 → 본문으로 쪼갠다.
 *
 * 왜 문자열 포함 검사로는 안 되나
 *   처음에는 `src.includes('accessibleClientIds')` 로 봤다. 그런데 그 문자열이
 *   **한 블록에만** 있어도 통과한다. 실제로 신규 3개 컬렉션에만 넣은 상태에서
 *   게이트가 초록으로 바뀌었다 — transactions·clients 는 여전히 등급만 보는데도.
 *   래칫이 가짜 진전을 기록하면 없는 것보다 나쁘다.
 */
function matchBlocks(src) {
  const out = [];
  // 경로에 {wildcard} 세그먼트가 들어간다. `[^\s{]+` 로 잡으면 `match /users/{`
  // 까지만 먹고 본문이 `uid` 한 단어가 된다 — 그러면 **모든 블록이 빈 것처럼**
  // 보이고 게이트가 무엇을 검사하든 항상 실패한다. 실제로 그랬다.
  const re = /match\s+((?:\/(?:\{[^}]*\}|[^\s{/]+))+)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ path: m[1], body: src.slice(start, i - 1) });
  }
  return out;
}

/**
 * 규칙 파일의 함수 정의 — 이름 → 본문.
 *
 * 왜 필요한가
 *   처음에는 블록 본문에 'accessibleClientIds' 나 'enabled' 가 **문자열로**
 *   있는지만 봤다. 그런데 규칙을 제대로 쓰면 그것은 헬퍼 안에 들어간다
 *   (`seesClient(id)` · `cap('trxEdit')`). 그러면 올바른 구현이 게이트를
 *   통과하지 못하고, 통과시키려고 검사를 느슨하게 하면 이번엔 아무 데나
 *   그 단어만 적어도 통과한다.
 *
 *   그래서 **호출을 따라간다.** 블록이 부르는 함수의 본문까지 재귀로 펼쳐
 *   그 안에 근거가 실제로 있는지 본다. 이름만 흉내낸 헬퍼는 통과하지 못한다.
 */
function ruleFunctions(src) {
  const out = new Map();
  const re = /function\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    out.set(m[1], src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** 본문 + 그 본문이 부르는 함수들의 본문(재귀). */
function expand(body, fns, seen = new Set()) {
  let text = body;
  for (const [name, fnBody] of fns) {
    if (seen.has(name)) continue;
    if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;
    seen.add(name);
    text += '\n' + expand(fnBody, fns, seen);
  }
  return text;
}

/** 전면 차단 블록 — 지킬 것이 없으므로 가드 검사에서 제외한다. */
function isDenyAll(body) {
  const allows = [...body.matchAll(/allow[^:]*:\s*if\s+([^;]+);/g)].map(a => a[1].trim());
  return allows.length > 0 && allows.every(cond => cond === 'false');
}

/** 재직 검사를 위임할 수 있는 이름. 규칙이 헬퍼로 감싸도 통과해야 한다. */
const ENABLED_GUARD = /\benabled\b|\bactiveUser\s*\(/;

test('[게이트 B] 담당 범위가 필요한 컬렉션마다 accessibleClientIds를 본다', () => {
  const blocks = matchBlocks(stripComments(firestoreRules));
  // 카탈로그가 "담당 입주자 범위"라고 말한 컬렉션들.
  const needScope = [...new Set(PERM_KEYS
    .filter(k => PERM_CATALOG[k].enforcement.includes(ENFORCE.FIRESTORE))
    .filter(k => {
      const e = PERM_CATALOG[k];
      const scopes = e.scope ? [e.scope] : Object.values(e.scopeByRank || {});
      return scopes.includes('assignedClient');
    })
    .map(k => PERM_CATALOG[k].resource))];

  const fns = ruleFunctions(stripComments(firestoreRules));
  const missing = needScope.filter((res) => {
    const b = blocks.filter(x => x.path.startsWith(`/${res}/`));
    if (b.length === 0) return true;
    // 헬퍼를 거쳐도 통과한다. 다만 그 헬퍼가 **실제로** 담당 목록을 읽어야 한다.
    return !b.some(x => expand(x.body, fns).includes('accessibleClientIds'));
  });

  assert.deepEqual(
    missing, [],
    '담당 범위 검사가 없는 컬렉션 (등급만 보고 있습니다):\n  ' + missing.join('\n  '),
  );
});

test('[게이트 B] 모든 블록이 재직 여부를 검사한다', () => {
  // 퇴사자의 기존 토큰은 refresh token 으로 계속 갱신된다. 자연 만료를
  // 기다리는 것은 차단 정책이 아니다 — 블록마다 authz.enabled 를 봐야 한다.
  const src = stripComments(firestoreRules);
  const blocks = matchBlocks(src);
  const fns = ruleFunctions(src);
  const missing = blocks
    // authz 본인 문서 읽기는 예외다 — 비활성 사용자가 자기 상태를 확인해
    // 로그아웃할 수 있어야 한다. 이 예외로 열리는 것은 없다.
    .filter(b => !b.path.startsWith('/authz/'))
    // users 본인 문서 읽기도 같은 예외다. 세션 복원이 이 문서를 먼저 읽고
    // 비활성 안내를 띄운다. 다만 **남의 문서**를 읽을 때는 검사가 있어야 하므로
    // 블록 전체를 면제하지 않고, 그 블록이 재직 검사를 갖고 있는지는 그대로 본다.
    .filter(b => !isDenyAll(b.body))
    .filter(b => !ENABLED_GUARD.test(expand(b.body, fns)))
    .map(b => b.path);

  assert.deepEqual(
    missing, [],
    '재직 검사가 없는 블록:\n  ' + missing.join('\n  '),
  );
});

test('[게이트 B] 마감된 월의 거래 수정을 규칙이 막는다', () => {
  const src = stripComments(firestoreRules);
  assert.ok(
    /lockedMonths|lockBypass/.test(src),
    '마감 검사가 없습니다. 개발자도구로 마감 거래를 수정할 수 있습니다.',
  );
});

test('[게이트 B] createdBy를 불변으로 강제한다', () => {
  // 수정 시 기존 값과 같아야 한다 — 없으면 남의 거래를 자기 것으로 바꿀 수 있다.
  // 조건이 **transactions 블록의 update 안**에 있어야 한다. 파일 어딘가에
  // 그 문자열이 있는 것만으로는 아무것도 보장하지 않는다.
  const blocks = matchBlocks(stripComments(firestoreRules));
  const trx = blocks.find(b => b.path.startsWith('/transactions/'));
  assert.ok(trx, 'transactions match 블록을 찾을 수 없습니다');

  const update = trx.body.match(/allow[^:]*\bupdate\b[^:]*:\s*if([\s\S]*?);/);
  assert.ok(update, 'transactions 에 update 규칙이 없습니다');

  // request 쪽과 resource 쪽의 createdBy 를 비교하는가 (접근자 형태는 자유)
  const cond = update[1].replace(/\s+/g, '');
  assert.ok(
    /request\.resource\.data[^=]*createdBy[^=]*==resource\.data[^&]*createdBy/.test(cond)
    || /resource\.data[^=]*createdBy[^=]*==request\.resource\.data[^&]*createdBy/.test(cond),
    'createdBy 불변 조건이 update 규칙에 없습니다:\n' + update[1].trim(),
  );

  // clientId 도 같이 묶어 둔다 — 바꿀 수 있으면 담당 밖 입주자에게 거래를 민다.
  assert.ok(
    /request\.resource\.data[^=]*clientId[^=]*==resource\.data[^&]*clientId/.test(cond),
    'clientId 불변 조건이 update 규칙에 없습니다.',
  );
});

test('[게이트 B] reports 직접 쓰기가 막혀 있다', () => {
  const src = stripComments(firestoreRules);
  const m = src.match(/match\s+\/reports\/\{[^}]*\}\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(m, 'reports match 블록을 찾을 수 없습니다');
  // `allow write` 만 찾으면 `allow create` · `allow update, delete` 를 놓친다.
  // 실제로 그랬다 — 규칙을 create/update/delete 로 쪼개자 게이트가 초록으로
  // 바뀌었다. 쓰기는 쓰기다.
  const writes = [...m[1].matchAll(/allow\s+([^:]+):/g)]
    .map(a => a[1])
    .filter(a => /\b(write|create|update|delete)\b/.test(a));
  assert.deepEqual(
    writes, [],
    '보고서를 브라우저가 직접 씁니다. 상태 전이가 강제되지 않습니다:\n' + m[1].trim(),
  );
});

// ─────────────────────────────────────────────
// 게이트 C — Storage Rules
// ─────────────────────────────────────────────

test('[게이트 C] storage.rules에 역할 등급 표가 없다', () => {
  const src = stripComments(storageRules);
  assert.ok(!/['"]입력자['"]\s*:\s*1/.test(src), '역할 등급 표가 하드코딩돼 있습니다.');
  const hits = [...src.matchAll(/atLeast\(\s*(\d+)\s*\)/g)].map(m => m[0]);
  assert.deepEqual(hits, [], '등급 리터럴:\n  ' + hits.join('\n  '));
});

test('[게이트 C] 파일 경로가 담당 입주자 범위를 검사한다', () => {
  const src = stripComments(storageRules);
  assert.ok(src.includes('accessibleClientIds'),
    '범위 검사가 없습니다. 지금은 로그인만 하면 전 입주자의 영수증을 읽습니다.');
});

test('[게이트 C] 통장 신규 경로에 clientId가 들어 있다', () => {
  const src = stripComments(storageRules);
  assert.ok(
    /bankbooks\/\{clientId\}/.test(src),
    '통장 경로에 clientId가 없습니다. 계좌 조회가 필요해져 2회 한도를 넘습니다.',
  );
});

test('[게이트 C] 목록 조회가 막혀 있다', () => {
  const src = stripComments(storageRules);
  assert.ok(
    /allow\s+list\s*:\s*if\s+false/.test(src),
    'list가 명시적으로 막혀 있지 않습니다. 경로를 몰라도 파일 목록을 얻습니다.',
  );
});

test('[게이트 C] 최종 영수증 경로를 브라우저가 쓰지 못한다', () => {
  const src = stripComments(storageRules);
  const m = src.match(/match\s+\/receipts\/[\s\S]*?\n\s{4}\}/);
  assert.ok(m, 'receipts match 블록을 찾을 수 없습니다');
  assert.ok(
    /allow\s+write\s*:\s*if\s+false/.test(m[0]),
    '최종 영수증을 브라우저가 씁니다. 서버 최종화 함수만 써야 합니다:\n' + m[0].trim(),
  );
});

// ─────────────────────────────────────────────
// 게이트 D — 브라우저 직접 쓰기 차단
//
// 전수 조사(첫 커밋 메시지 참고)에서 확인한 경로들이다. 규칙만 잠그면
// 이 호출들이 조용히 실패한다 — showConfirm의 onOk()는 await도 catch도
// 없이 불리므로 거부가 삼켜진다.
// ─────────────────────────────────────────────

const APP_SOURCES = (() => {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === 'vendor' || name === 'icons') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) out.push(p);
    }
  })(join(ROOT, 'public'));
  return out;
})();

/**
 * 브라우저의 Firestore 쓰기 호출을 모으고, 각 호출의 **대상 컬렉션을 정적으로
 * 해석**한다.
 *
 * 왜 이렇게까지 하나
 *   처음에는 `/(setDoc|deleteDoc)\([^)]*COLS\.CLIENTS/` 로 잡으려 했는데
 *   두 가지 이유로 조용히 통과했다:
 *     · `setDoc(doc(fdb(),COLS.CLIENTS,id)` — [^)]* 가 fdb() 의 닫는 괄호를
 *       넘지 못해 매칭에 실패한다
 *     · settings.js 는 `cols[type]` 처럼 변수로 컬렉션을 고른다 — 리터럴
 *       매칭으로는 아예 보이지 않는다
 *   거짓 통과는 실패보다 나쁘다. 고쳐지지 않은 채로 마이그레이션이 끝난다.
 *
 *   그래서 (1) 줄 전체에서 찾고 (2) 정적으로 해석되지 않는 대상은 별도로
 *   보고해 사람이 판단하게 한다.
 */
const WRITE_CALL = /\b(setDoc|updateDoc|addDoc|deleteDoc)\s*\(/;

/**
 * `const accRef = doc(fdb(), COLS.ACCOUNTS, id)` 처럼 앞 줄에서 만든 참조를
 * 컬렉션으로 해석한다. 이것을 하지 않으면 정상적인 두 줄 패턴이 모두 위반으로
 * 잡혀 테스트가 시끄러워지고, 시끄러운 테스트는 곧 무시된다.
 */
function refMap(src) {
  // 1단계: `const SYSTEM_OPS = COLS.SYSTEM_OPS` 같은 지역 별칭.
  //   이것을 풀지 않으면 별칭을 쓰는 파일 전체가 위반으로 잡힌다.
  const alias = new Map();
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*COLS\.([A-Z_]+)\s*;/g)) {
    alias.set(m[1], m[2]);
  }
  const aliasNames = [...alias.keys()];

  // 2단계: `const accRef = doc(fdb(), COLS.ACCOUNTS, id)` — 참조 → 컬렉션.
  const map = new Map();
  // 인자를 줄 끝까지 잡는다. `([^;]*?)\)` 로 괄호를 닫으려 하면
  // `doc(fdb(),COLS.X,id)` 의 fdb() 괄호에서 멈춰 컬렉션을 놓친다.
  const re = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:doc|collection)\(([^;\n]*)/g;
  for (const m of src.matchAll(re)) {
    const args = m[2];
    const direct = args.match(/COLS\.([A-Z_]+)/);
    if (direct) { map.set(m[1], direct[1]); continue; }
    const viaAlias = aliasNames.find(n => new RegExp(`\\b${n}\\b`).test(args));
    if (viaAlias) map.set(m[1], alias.get(viaAlias));
  }
  return map;
}

/**
 * 대상 컬렉션이 정적으로 해석되지 않아도 되는 곳.
 *
 * 여기 있는 것은 **설계상 동적인 공용 헬퍼**다. 호출부가 컬렉션을 넘기므로
 * 헬퍼 자신은 알 수 없고, 알 필요도 없다. 대신 호출부가 위 검사에 걸린다.
 */
const DYNAMIC_BY_DESIGN = [
  'public/services/firestore.js',   // batchMixedOps — {col, docId, data}를 받는다
  'public/services/audit.js',       // auditOp — 감사 기록을 어느 배치에든 끼운다
];

function browserWrites() {
  const sites = [];
  for (const f of APP_SOURCES) {
    const rel = relative(ROOT, f).split(/[\\/]/).join('/');
    if (DYNAMIC_BY_DESIGN.includes(rel)) continue;
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n');
    const refs = refMap(src);

    lines.forEach((line, i) => {
      // 주석 줄은 건너뛴다. 코드를 설명하려고 예전 호출을 인용한 주석까지
      // 위반으로 잡으면, 무엇을 왜 바꿨는지 적을 수 없게 된다.
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (!WRITE_CALL.test(line)) return;
      // 여러 줄로 쓰인 호출이 있으므로 다음 두 줄까지 함께 본다.
      const window = lines.slice(i, i + 3).join('\n');
      const cols = [...window.matchAll(/COLS\.([A-Z_]+)/g)].map(m => m[1]);
      // 첫 인자가 앞에서 만든 참조라면 그것으로 해석한다.
      const argRef = (line.match(WRITE_CALL) && line.slice(line.search(WRITE_CALL))
        .match(/\(\s*(\w+)\s*[,)]/) || [])[1];
      if (argRef && refs.has(argRef)) cols.push(refs.get(argRef));

      sites.push({
        where: `${rel}:${i + 1}`, line: line.trim(),
        cols: [...new Set(cols)], resolved: cols.length > 0,
      });
    });
  }
  return sites;
}

/** 브라우저가 더 이상 직접 쓰면 안 되는 컬렉션 → 대신 쓸 서버 함수. */
const SERVER_ONLY_COLLECTIONS = {
  CLIENTS: 'updateClientAssignments — clients·authz·clientAccess를 원자적으로 갱신해야 한다',
  USERS: '직원 관리 콜러블 — 규칙이 이미 막고 있고, 지금은 거부가 삼켜진다',
  REPORTS: '결재 전이 콜러블 — 상태 전이를 서버가 강제해야 한다',
};

test('[게이트 D] 브라우저가 서버 전용 컬렉션을 직접 쓰지 않는다', () => {
  const bad = browserWrites()
    .flatMap(s => s.cols
      .filter(c => c in SERVER_ONLY_COLLECTIONS)
      .map(c => `${s.where}  COLS.${c}\n      → ${SERVER_ONLY_COLLECTIONS[c]}\n      ${s.line}`));
  assert.deepEqual(
    bad, [],
    '서버 함수로 옮겨야 하는 쓰기가 남아 있습니다:\n    ' + bad.join('\n    '),
  );
});

test('[게이트 D] 모든 브라우저 쓰기의 대상 컬렉션을 정적으로 알 수 있다', () => {
  // 변수로 컬렉션을 고르면(`cols[type]`) 어느 규칙이 걸리는지 읽을 수 없고,
  // 이 계약 테스트도 대조할 수 없다. COLS 상수를 직접 쓰도록 풀어야 한다.
  const opaque = browserWrites().filter(s => !s.resolved)
    .map(s => `${s.where}  ${s.line}`);
  assert.deepEqual(
    opaque, [],
    '대상 컬렉션이 정적으로 해석되지 않는 쓰기:\n    ' + opaque.join('\n    '),
  );
});

test('[게이트 D] 브라우저가 config/permissions를 직접 쓰지 않는다', () => {
  // 오버라이드 저장은 전 사용자 caps 재계산과 한 트랜잭션이어야 한다.
  const hits = findLines(APP_SOURCES, /setDoc[\s\S]{0,80}['"]permissions['"]/);
  assert.deepEqual(
    hits, [],
    'savePermissions를 콜러블로 옮기세요:\n  ' + hits.join('\n  '),
  );
});

test('[게이트 D] 브라우저가 Storage 객체를 덮어쓰지 않는다', () => {
  // 연도 마감 재압축이 최종 객체를 덮어쓴다. Web SDK의 uploadBytes에는
  // generation 사전조건 인자가 없어 동시 교체가 조용히 뭉개진다.
  const hits = findLines(APP_SOURCES, /uploadBytes\(\s*objRef/);
  assert.deepEqual(
    hits, [],
    '재압축을 서버 archive job으로 옮기세요 (ifGenerationMatch 필요):\n  ' + hits.join('\n  '),
  );
});

// ─────────────────────────────────────────────
// 카탈로그 ↔ 규칙 커버리지
// ─────────────────────────────────────────────

test('카탈로그가 지목한 컬렉션에 규칙 블록이 있다', () => {
  const src = stripComments(firestoreRules);
  const resources = [...new Set(
    PERM_KEYS
      .filter(k => PERM_CATALOG[k].enforcement.includes(ENFORCE.FIRESTORE))
      .map(k => PERM_CATALOG[k].resource),
  )];
  const missing = resources.filter(r => !new RegExp(`match\\s+/${r}/`).test(src));
  assert.deepEqual(
    missing, [],
    '규칙에 match 블록이 없는 컬렉션:\n  ' + missing.join('\n  '),
  );
});

test('서버 집행 키가 하나도 빠지지 않았다', () => {
  // 카탈로그에 있지만 어느 집행 지점에서도 언급되지 않는 키를 찾는다.
  const all = stripComments(firestoreRules) + stripComments(storageRules)
    + functionSources().map(f => readFileSync(f, 'utf8')).join('\n');
  const unreferenced = SERVER_ENFORCED_KEYS.filter(
    k => !all.includes(capName(k)) && !all.includes(k),
  );
  assert.deepEqual(
    unreferenced, [],
    '서버 어디에서도 검사하지 않는 권한:\n  ' + unreferenced.join('\n  '),
  );
});
