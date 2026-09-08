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

test('[게이트 B] 담당 범위를 accessibleClientIds로 검사한다', () => {
  const src = stripComments(firestoreRules);
  assert.ok(src.includes('accessibleClientIds'),
    '담당 입주자 범위 검사가 없습니다. 지금은 clients를 전원이 읽습니다.');
  assert.ok(/authz/.test(src),
    'authz 문서를 참조하지 않습니다.');
});

test('[게이트 B] 비활성 계정을 enabled로 즉시 차단한다', () => {
  const src = stripComments(firestoreRules);
  assert.ok(/\benabled\b/.test(src),
    'authz.enabled 검사가 없습니다. 퇴사자의 기존 토큰이 계속 통과합니다.');
});

test('[게이트 B] 마감된 월의 거래 수정을 규칙이 막는다', () => {
  const src = stripComments(firestoreRules);
  assert.ok(
    /lockedMonths|lockBypass/.test(src),
    '마감 검사가 없습니다. 개발자도구로 마감 거래를 수정할 수 있습니다.',
  );
});

test('[게이트 B] createdBy를 불변으로 강제한다', () => {
  const src = stripComments(firestoreRules);
  // 수정 시 기존 값과 같아야 한다 — 없으면 남의 거래를 자기 것으로 바꿀 수 있다.
  assert.ok(
    /resource\.data\.createdBy|createdBy\s*==\s*resource/.test(src),
    'createdBy 불변 조건이 없습니다.',
  );
});

test('[게이트 B] reports 직접 쓰기가 막혀 있다', () => {
  const src = stripComments(firestoreRules);
  const m = src.match(/match\s+\/reports\/\{[^}]*\}\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(m, 'reports match 블록을 찾을 수 없습니다');
  assert.ok(
    !/allow\s+[^:]*write/.test(m[1]),
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
