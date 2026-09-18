// test/firestore-indexes.test.mjs
//
// 복합 인덱스 — **에뮬레이터가 잡아 주지 않는 유일한 고장 부류.**
//
// 왜 필요한가
//   같음(==·in) 과 범위(>=·<=) 를 함께 거는 쿼리는 Firestore 에서 복합 인덱스를
//   요구한다. 없으면 쿼리가 통째로 실패하고 화면은 「... 로드 실패: The query
//   requires an index」를 띄운다.
//
//   그런데 **에뮬레이터는 인덱스를 자동으로 만든다.** 그래서 로컬 테스트도,
//   규칙 테스트도, CI 도 전부 통과한 채 배포되고, 실서비스에서 **그 쿼리를 타는
//   역할에게만** 터진다. 실제로 그렇게 났다 — 팀장은 `report.view.all` 이 없어
//   담당 범위로 좁힌 조회(clientId in + year >=)를 타는데, 그 인덱스가 없어서
//   보고서 탭이 열리지 않았다. 담당자·센터장에게는 멀쩡해 보였다.
//
// 그래서 소스에서 쿼리 모양을 읽어 필요한 인덱스를 계산하고 등록된 것과 대조한다.
//
// 한계 (알고 쓰는 것)
//   · 정적 분석이라 `where` 의 필드·연산자가 **문자열 리터럴**일 때만 본다.
//     `where(documentId(), ...)` 같은 것은 건너뛴다(문서 키 조회는 색인이 없어도 된다).
//   · 같음만 있는 쿼리는 요구하지 않는다 — Firestore 가 단일 필드 색인을 병합한다.
//   · 조건에 따라 절이 달라지는 곳(`...scope`)은 **분기마다 따로** 계산한다.
//     합쳐서 하나로만 보면 좁은 쪽 분기의 인덱스 누락을 놓친다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLS } from '../public/constants.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC = join(ROOT, 'public');

const EQ_OPS = new Set(['==', 'in', 'array-contains', 'array-contains-any']);
const RANGE_OPS = new Set(['<', '<=', '>', '>=', '!=', 'not-in']);

/** COLS 상수 이름 → 실제 컬렉션 이름 */
const COL_BY_KEY = COLS;

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'vendor' || name === 'icons') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** `open` 위치(여는 괄호)의 짝을 찾아 안쪽 문자열을 돌려준다. */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** 문자열 리터럴 필드·연산자를 가진 where 절만 뽑는다. */
function whereClauses(text) {
  return [...text.matchAll(/where\(\s*'([^']+)'\s*,\s*'([^']+)'/g)]
    .map(m => ({ field: m[1], op: m[2] }));
}

/**
 * `...ident` 로 펼쳐지는 절 묶음들.
 *
 * 삼항으로 분기하는 곳이 있다(입력자만 createdBy 를 더 건다). 분기마다 인덱스가
 * 다르므로 **배열 리터럴 하나가 묶음 하나**다. push 로 더하는 절은 모든 묶음에
 * 붙는다(조건부 push 는 "있을 수도 있다"이므로 더 넓은 쪽을 본다).
 */
function spreadGroups(src, ident) {
  const assign = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=([\\s\\S]*?);\\n`);
  const m = src.match(assign);
  const groups = [];
  if (m) {
    for (const lit of m[1].matchAll(/\[([\s\S]*?)\]/g)) groups.push(whereClauses(lit[1]));
  }
  if (!groups.length) groups.push([]);
  const pushed = [...src.matchAll(new RegExp(`${ident}\\.push\\(([^;]*?)\\)`, 'g'))]
    .flatMap(p => whereClauses(p[1]));
  return groups.map(g => [...g, ...pushed]);
}

/** 한 파일이 요구하는 인덱스들. */
function requirementsOf(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const out = [];
  for (const m of src.matchAll(/\bquery\(/g)) {
    const args = balanced(src, m.index + 'query'.length);
    // 컬렉션은 언제나 첫 인자다. `collection(fdb(), COLS.X)` 처럼 안쪽에 괄호가
    // 있는 형태가 많아서 괄호로 자르지 않고 **첫 COLS.** 를 집는다
    // (그렇게 자르다 파일 여섯 개를 통째로 건너뛰고도 검사는 초록이었다).
    const col = args.match(/COLS\.(\w+)/);
    if (!col) continue;
    const collection = COL_BY_KEY[col[1]];
    if (!collection) continue;

    const tail = args.slice(col.index);
    const inline = whereClauses(tail);
    const spreads = [...tail.matchAll(/\.\.\.(\w+)/g)].map(s => s[1]);

    const groups = spreads.length
      ? spreads.flatMap(id => spreadGroups(src, id)).map(g => [...g, ...inline])
      : [inline];

    for (const clauses of groups) {
      const eq = [...new Set(clauses.filter(c => EQ_OPS.has(c.op)).map(c => c.field))];
      const range = [...new Set(clauses.filter(c => RANGE_OPS.has(c.op)).map(c => c.field))];
      // 같음만 있는 쿼리는 단일 필드 색인 병합으로 된다. 한 필드짜리도 마찬가지.
      if (!range.length || eq.length + range.length < 2) continue;
      out.push({ rel, collection, eq: eq.sort(), range: range.sort() });
    }
  }
  return out;
}

const REQUIRED = jsFiles(PUBLIC)
  .map(p => relative(ROOT, p).replaceAll('\\', '/'))
  .flatMap(requirementsOf);

const INDEXES = JSON.parse(readFileSync(join(ROOT, 'firestore.indexes.json'), 'utf8')).indexes;

/** 그 요구를 충족하는 인덱스가 있는가. 같음 필드 전부 + 범위 필드가 마지막. */
function satisfied(req) {
  return INDEXES.some((idx) => {
    if (idx.collectionGroup !== req.collection) return false;
    const fields = idx.fields.map(f => f.fieldPath);
    const last = fields.slice(-req.range.length);
    const head = fields.slice(0, fields.length - req.range.length);
    return [...head].sort().join(',') === req.eq.join(',')
      && [...last].sort().join(',') === req.range.join(',');
  });
}

const describe = (r) => `${r.collection}(${[...r.eq, ...r.range].join(',')})  ← ${r.rel}`;

test('같음+범위 쿼리에 필요한 복합 인덱스가 모두 등록돼 있다', () => {
  const missing = [...new Set(REQUIRED.filter(r => !satisfied(r)).map(describe))];
  assert.deepEqual(missing, [],
    '인덱스가 없는 쿼리가 있습니다. 에뮬레이터는 인덱스를 자동으로 만들어 주므로 '
    + '여기서 잡지 못하면 **실서비스에서 그 쿼리를 타는 역할에게만** 터집니다:\n  '
    + missing.join('\n  ')
    + '\n\nfirestore.indexes.json 에 추가하세요(같음 필드 먼저, 범위 필드 마지막).');
});

test('분석기가 실제 쿼리를 읽고 있다 — 아무것도 못 찾으면 그 자체가 고장이다', () => {
  // 선택자가 바뀌어 0건이 되면 위 검사는 언제나 통과한다. 그게 가장 위험하다.
  assert.ok(REQUIRED.length >= 5, `요구 인덱스를 ${REQUIRED.length}건만 찾았습니다`);
  const shapes = new Set(REQUIRED.map(r => `${r.collection}:${[...r.eq, ...r.range].join(',')}`));
  // 알고 있는 것 셋이 잡히는지 — 하나는 조건 분기 안에 있고 하나는 배열 펼침이다.
  assert.ok(shapes.has('transactions:clientId,date'), '기본 거래 조회를 못 찾았습니다');
  assert.ok(shapes.has('transactions:clientId,createdBy,date'), '입력자 분기를 못 찾았습니다');
  assert.ok(shapes.has('reports:clientId,year'), '보고서 목록 조회를 못 찾았습니다');
});

test('등록된 인덱스는 전부 오름차순이다', () => {
  // 이 앱의 쿼리는 orderBy 를 쓰지 않는다(정렬은 domain/trx-order.js 가 메모리에서
  // 한다). 내림차순 인덱스는 쓰이지 않으면서 쓰기 비용만 늘린다.
  const bad = INDEXES.flatMap(i => i.fields
    .filter(f => f.order && f.order !== 'ASCENDING')
    .map(f => `${i.collectionGroup}.${f.fieldPath}: ${f.order}`));
  assert.deepEqual(bad, []);
});

// ─────────────────────────────────────────────────────────
// 그래도 새면 화면이 사람 말을 해야 한다
// ─────────────────────────────────────────────────────────

test('색인 누락은 영문 원문이 아니라 사람 말로 보여 준다', async () => {
  // 실제로 사용자가 본 것: 「보고서 목록 로드 실패: The query requires an index.
  // You can create it here: https://console.firebase.google.com/...」 — 사회복지사가
  // 읽을 것이 못 되고, 링크가 필요한 사람은 그 화면을 보지 않는다.
  const { missingIndexMessage } = await import('../public/services/fn-errors.js');
  const err = new Error('The query requires an index. You can create it here: '
    + 'https://console.firebase.google.com/v1/r/project/p/firestore/indexes?create_composite=A');
  const msg = missingIndexMessage(err, '보고서 목록');
  assert.match(msg, /보고서 목록.*색인/);
  assert.doesNotMatch(msg, /https:|requires an index/, '영문 원문·링크가 화면에 남습니다');
  // 다른 오류를 삼키면 진짜 원인이 가려진다.
  assert.equal(missingIndexMessage(new Error('permission-denied'), '보고서 목록'), null);
});

test('색인 오류를 쓰는 화면이 그 해석기를 실제로 부른다', () => {
  for (const rel of ['public/modules/report.js', 'public/modules/core.js']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /missingIndexMessage\(/, `${rel} 가 색인 오류를 그대로 띄웁니다`);
  }
});
