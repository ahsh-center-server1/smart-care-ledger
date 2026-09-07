// test/directories.test.mjs
//
// 파생 명부.
//
// 두 가지를 고정한다.
//
//  1. **비밀이 명부에 실리지 않는다.** 명부는 로그인한 전원이 읽는다. 예전에
//     users 컬렉션에는 평문 비밀번호가 들어 있었고 그것이 모든 브라우저로
//     전송됐다. 지금은 해시가 userSecrets로 분리됐지만, 언젠가 누가 편의를 위해
//     users에 필드를 하나 더 넣을 것이다. 그때 그 필드가 자동으로 명부에
//     따라 나가지 않게 하는 것이 STAFF_FIELDS 허용 목록이고, 이 테스트가 그
//     목록을 지킨다.
//
//  2. **서버(CJS)와 브라우저(ESM)의 형태가 같다.** 어긋나면 서버가 만든 명부를
//     브라우저가 못 알아보고 조용히 컬렉션 직접 조회로 떨어진다 — 화면은
//     정상이고 읽기만 안 준다. 즉 최적화가 아무 일도 안 하는 상태가 조용히
//     성립하고, 예외도 로그도 없다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  DIRECTORY_SCHEMA_VERSION, STAFF_FIELDS, CATEGORY_FIELDS, DIRECTORIES,
  isDirectoryUsable, directoryToArray,
} from '../public/domain/directory.js';

const require = createRequire(import.meta.url);
const server = require('../functions/directories.cjs');

// ─────────────────────────────────────────────────────────
// 1. 비밀이 새지 않는다
// ─────────────────────────────────────────────────────────

/** 명부에 들어가면 안 되는 필드 이름의 조각. */
const SECRET_ISH = ['password', 'passwd', 'pw', 'hash', 'salt', 'secret', 'token', 'key'];

test('직원 명부 허용 목록에 비밀스러운 이름이 없다', () => {
  const bad = STAFF_FIELDS.filter(
    (f) => SECRET_ISH.some((s) => f.toLowerCase().includes(s)));
  assert.deepEqual(bad, [],
    `명부는 로그인한 전원이 읽습니다. 이 필드를 빼세요: ${bad.join(', ')}`);
});

test('허용 목록에 없는 필드는 명부에 실리지 않는다', () => {
  // 미래에 users 문서에 무엇이 추가되든, 명부에는 STAFF_FIELDS만 나간다.
  const built = server.buildStaffDirectory([{
    id: 'staff1',
    data: {
      userId: 'staff1', name: '이담당', role: '담당자', team: '1팀',
      // ↓ 실수로 users에 들어온 값들
      password: '평문비밀번호', passwordHash: 'scrypt$...', salt: 'abc',
      apiKey: 'sk-ant-...', memo: '개인 메모', lastLoginIp: '1.2.3.4',
    },
  }]);

  const leaked = Object.keys(built.entries.staff1)
    .filter((k) => !STAFF_FIELDS.includes(k));
  assert.deepEqual(leaked, [],
    `허용 목록에 없는 필드가 명부에 실렸습니다: ${leaked.join(', ')}`);
  assert.deepEqual(Object.keys(built.entries.staff1).sort(),
    ['name', 'role', 'team', 'userId']);
});

test('규칙이 명부 쓰기를 막는다 — 이 설계의 전제', () => {
  // 클라이언트가 명부를 쓸 수 있으면 자기 역할을 바꿔 적을 수 있다.
  // 전제가 바뀌면 여기서 먼저 실패해 같이 정리하게 한다.
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const block = rules.split('match /directories/')[1] || '';
  assert.match(block, /allow write:\s*if false/,
    'firestore.rules의 directories 쓰기가 열려 있습니다');
});

// ─────────────────────────────────────────────────────────
// 2. 서버 ↔ 브라우저 대조
// ─────────────────────────────────────────────────────────

test('스키마 버전이 양쪽에서 같다', () => {
  assert.equal(server.DIRECTORY_SCHEMA_VERSION, DIRECTORY_SCHEMA_VERSION);
});

test('필드 목록이 양쪽에서 같다', () => {
  assert.deepEqual(server.STAFF_FIELDS, STAFF_FIELDS);
  assert.deepEqual(server.CATEGORY_FIELDS, CATEGORY_FIELDS);
});

test('명부 이름이 양쪽에서 같다', () => {
  assert.deepEqual(server.DIRECTORIES, DIRECTORIES);
});

test('서버가 만든 명부를 브라우저가 그대로 읽는다', () => {
  const built = server.buildStaffDirectory([
    { id: 'a', data: { userId: 'a', name: '김센터', role: '센터장', isAdmin: true } },
    { id: 'b', data: { userId: 'b', name: '이담당', role: '담당자', team: '1팀' } },
  ]);
  assert.equal(isDirectoryUsable(built), true);

  const rows = directoryToArray(built);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r) => r.id === 'b'),
    { id: 'b', userId: 'b', name: '이담당', role: '담당자', team: '1팀' });
});

test('낡음 판정도 양쪽에서 같다', () => {
  const cases = [
    null, undefined, {},
    { entries: {}, schemaVersion: DIRECTORY_SCHEMA_VERSION },
    { entries: {}, schemaVersion: DIRECTORY_SCHEMA_VERSION + 1 },
    { entries: null, schemaVersion: DIRECTORY_SCHEMA_VERSION },
    { schemaVersion: DIRECTORY_SCHEMA_VERSION },
  ];
  for (const c of cases) {
    assert.equal(server.isDirectoryUsable(c), isDirectoryUsable(c),
      `불일치: ${JSON.stringify(c)}`);
  }
});

// ─────────────────────────────────────────────────────────
// 안전 장치 — 어긋나면 직접 조회로 떨어진다
// ─────────────────────────────────────────────────────────

test('형태가 어긋난 명부는 쓰지 않는다', () => {
  // 못 쓰겠다고 판단하면 호출부가 컬렉션을 직접 읽는다.
  // 여기서 true를 돌려주면 낡은 명부가 화면에 나간다.
  assert.equal(isDirectoryUsable(null), false);
  assert.equal(isDirectoryUsable({ entries: {} }), false, '버전이 없으면 못 쓴다');
  assert.equal(
    isDirectoryUsable({ entries: {}, schemaVersion: DIRECTORY_SCHEMA_VERSION + 1 }),
    false, '버전이 다르면 못 쓴다');
  assert.equal(
    isDirectoryUsable({ entries: 'nope', schemaVersion: DIRECTORY_SCHEMA_VERSION }),
    false, 'entries가 맵이 아니면 못 쓴다');
  assert.equal(directoryToArray({ entries: {} }), null);
});

test('빈 명부는 유효하다 (직원이 0명일 수 있다)', () => {
  const built = server.buildStaffDirectory([]);
  assert.equal(isDirectoryUsable(built), true);
  assert.deepEqual(directoryToArray(built), []);
  assert.equal(built.count, 0);
});

test('id 없는 항목은 건너뛴다', () => {
  const built = server.buildStaffDirectory([
    { id: 'a', data: { userId: 'a', name: '김' } },
    { data: { userId: 'b' } },
    null,
  ]);
  assert.equal(built.count, 1);
});

test('없는 필드는 넣지 않는다 (문서 크기 절약)', () => {
  const built = server.buildCategoryDirectory([
    { id: 'c1', data: { type: '지출', category: '식비' } },
  ]);
  // keyword·subcategory·clientId·sortOrder는 없으므로 키 자체가 없어야 한다.
  assert.deepEqual(Object.keys(built.entries.c1).sort(), ['category', 'type']);
});

test('false·0도 값으로 보존한다', () => {
  // `if (data[f])` 로 걸렀다면 active:false가 사라져 비활성 직원이
  // 활성으로 보인다. undefined만 걸러야 한다.
  const built = server.buildStaffDirectory([
    { id: 'a', data: { userId: 'a', active: false, approved: false, isAdmin: false } },
  ]);
  assert.deepEqual(built.entries.a,
    { userId: 'a', active: false, approved: false, isAdmin: false });

  const cats = server.buildCategoryDirectory([
    { id: 'c', data: { category: '식비', sortOrder: 0 } },
  ]);
  assert.equal(cats.entries.c.sortOrder, 0);
});
