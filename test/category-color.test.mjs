// test/category-color.test.mjs
//
// 분류의 색.
//
// 원래 문제: 색을 **이름으로만** 찾았다. 그래서 「식비」를 「음식비」로 바꾸는
// 순간 기본 표에 없는 이름이 되어 회색으로 떨어졌다. 설정 화면에서 색을 골라
// 저장해도 마찬가지였고 — 저장된 색은 분류 명부(CATEGORY_FIELDS)에서 잘려
// 브라우저까지 오지도 않았다.
//
// 그래서 이 파일이 지키는 것은 둘이다.
//   1. 이름을 바꿔도 회색이 되지 않는다
//   2. 사용자가 고른 색이 이긴다 — 그리고 그 색이 실제로 브라우저까지 온다

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  cs, CAT_COLORS, shadesFromHex, autoColorFor, registerCategoryColors,
} from '../public/domain/category-color.js';
import { CATEGORY_FIELDS, DIRECTORY_SCHEMA_VERSION } from '../public/domain/directory.js';

const HEX = /^#[0-9a-f]{6}$/;
const isShades = (c) => c && HEX.test(c.bg) && HEX.test(c.text) && HEX.test(c.dot) && HEX.test(c.border);

test('기본 분류는 기본 색을 그대로 쓴다', () => {
  registerCategoryColors([]);
  assert.deepEqual(cs('식비'), CAT_COLORS['식비']);
  assert.deepEqual(cs('확인필요'), CAT_COLORS['확인필요']);
});

test('이름을 바꿔도 회색이 되지 않는다', () => {
  // 원래 증상. 표에 없는 이름이면 전부 같은 회색이었다.
  registerCategoryColors([]);
  const a = cs('음식비'), b = cs('간식비');
  assert.ok(isShades(a) && isShades(b));
  assert.notDeepEqual(a, b, '이름이 다른데 같은 색입니다 — 옆 줄과 구분되지 않습니다');
});

test('같은 이름은 언제나 같은 색이다', () => {
  // 매번 달라지면 새로고침할 때마다 표 색이 바뀐다.
  assert.equal(autoColorFor('음식비'), autoColorFor('음식비'));
  assert.notEqual(autoColorFor('음식비'), autoColorFor('교통'));
});

test('사용자가 고른 색이 기본 표를 이긴다', () => {
  registerCategoryColors([{ category: '식비', color: '#112233' }]);
  const c = cs('식비');
  assert.equal(c.text, '#112233');
  assert.notDeepEqual(c, CAT_COLORS['식비']);
  registerCategoryColors([]);
});

test('색 하나에서 칩에 필요한 네 가지를 만든다', () => {
  // 설정 화면은 색을 하나만 고르게 한다. 사람에게 네 개를 고르게 하면 안 쓴다.
  const c = shadesFromHex('#dc2626');
  assert.ok(isShades(c));
  assert.equal(c.text, '#dc2626');
  assert.equal(c.dot, '#dc2626');
  // 배경은 흰색에 가깝고 테두리는 그 사이 — 글자가 배경에 묻히면 안 된다.
  const lum = (hex) => [1, 3, 5].reduce((a, i) => a + parseInt(hex.slice(i, i + 2), 16), 0);
  assert.ok(lum(c.bg) > lum(c.border), `배경이 테두리보다 진합니다: ${c.bg} vs ${c.border}`);
  assert.ok(lum(c.border) > lum(c.text), `테두리가 글자보다 진합니다: ${c.border} vs ${c.text}`);
});

test('색 형식이 아니면 받지 않는다', () => {
  assert.equal(shadesFromHex('red'), null);
  assert.equal(shadesFromHex('#fff'), null);
  assert.equal(shadesFromHex(''), null);
  registerCategoryColors([{ category: 'X', color: 'red' }]);
  assert.ok(isShades(cs('X')), '형식이 틀린 값 때문에 색이 깨졌습니다');
  registerCategoryColors([]);
});

test('등록은 통째로 바뀐다 — 지워진 분류의 색이 남지 않는다', () => {
  registerCategoryColors([{ category: '옛분류', color: '#112233' }]);
  assert.equal(cs('옛분류').text, '#112233');
  registerCategoryColors([{ category: '새분류', color: '#445566' }]);
  assert.notEqual(cs('옛분류').text, '#112233',
    '지워진 분류의 색이 남았습니다 — 같은 이름을 다시 만들면 예전 색이 되살아납니다');
  registerCategoryColors([]);
});

test('자동분류 규칙은 색을 등록하지 않는다', () => {
  // keyword 가 있는 문서는 분류 정의가 아니라 규칙이다. 같은 컬렉션에 있다.
  registerCategoryColors([{ keyword: '이마트', category: '식비', color: '#000000' }]);
  assert.deepEqual(cs('식비'), CAT_COLORS['식비']);
  registerCategoryColors([]);
});

// ── 집행 지점 ───────────────────────────────────────────────

test('명부가 color 를 싣는다 — 안 실으면 브라우저까지 오지 않는다', () => {
  // 두 번째 원인이었다. 화면이 아무리 잘 읽어도 투영 단계에서 잘리면 끝이다.
  assert.ok(CATEGORY_FIELDS.includes('color'), '분류 명부에서 color 가 빠졌습니다');
  assert.ok(DIRECTORY_SCHEMA_VERSION >= 2,
    '필드를 늘렸으면 스키마 버전을 올려야 낡은 명부가 다시 만들어집니다');
  const server = createRequire(import.meta.url)('../functions/directories.cjs');
  assert.deepEqual(server.CATEGORY_FIELDS, CATEGORY_FIELDS, '서버 사본과 어긋납니다');
  assert.equal(server.DIRECTORY_SCHEMA_VERSION, DIRECTORY_SCHEMA_VERSION);
});

test('색을 찾는 곳이 한 벌뿐이다', () => {
  // 설정 화면은 자기 팔레트를 따로 갖고 있었다. 그래서 설정에서 본 색과
  // 표에서 본 색이 서로 달랐다.
  const settings = readFileSync(new URL('../public/modules/settings.js', import.meta.url), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/colors\[i\s*%\s*colors\.length\]/.test(settings),
    '설정 화면이 색을 따로 배정합니다. cs() 를 쓰세요');
});

test('분류를 불러올 때 색을 등록한다', () => {
  const core = readFileSync(new URL('../public/modules/core.js', import.meta.url), 'utf8');
  assert.ok(/registerCategoryColors\(/.test(core),
    '분류를 불러와도 색이 등록되지 않습니다 — cs() 가 저장된 색을 못 봅니다');
});
