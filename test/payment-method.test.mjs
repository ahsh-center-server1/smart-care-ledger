// test/payment-method.test.mjs
//
// 통장 적요에서 결제수단 읽기.
//
// 두 가지를 지킨다.
//   1. **순서가 곧 우선순위다.** 「자동이체」와 「CD이체」가 「이체」보다 먼저
//      와야 한다. 뒤집히면 자동이체와 현금인출이 전부 계좌이체로 빨려 든다.
//   2. **모르면 비워 둔다.** 틀린 구분이 붙는 것보다 빈 칸이 낫다. 빈 칸은
//      사람이 채우지만 틀린 값은 맞는 줄 알고 넘어간다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PAYMENT_METHODS, detectPaymentMethod, normalizePaymentMethod,
} from '../public/domain/payment-method.js';

const each = (rows) => {
  for (const [desc, want] of rows) {
    assert.equal(detectPaymentMethod(desc), want, `「${desc}」 → ${want} 이어야 합니다`);
  }
};

test('카드 승인을 읽는다', () => {
  each([
    ['체크카드 GS25강남점', '카드'],
    ['NH체크 이마트', '카드'],
    ['KB체크 스타벅스', '카드'],
    ['일시불 홈플러스', '카드'],
    ['할부3 하이마트', '카드'],
    ['체크신한 올리브영', '카드'],
    ['승인 CU편의점', '카드'],
  ]);
});

test('계좌이체를 읽는다', () => {
  each([
    ['전자금융 홍길동', '계좌이체'],
    ['타행이체 김철수', '계좌이체'],
    ['인터넷뱅킹 이영희', '계좌이체'],
    ['송금 박민수', '계좌이체'],
    ['대체 관리비', '계좌이체'],
  ]);
});

test('자동이체를 읽는다', () => {
  each([
    ['자동이체 한국전력', '자동이체'],
    ['자동납부 도시가스', '자동이체'],
    ['지로 건강보험', '자동이체'],
    ['CMS 통신비', '자동이체'],
    ['펌뱅킹 급여', '자동이체'],
  ]);
});

test('현금 인출을 읽는다', () => {
  each([
    ['예금인출', '현금'],
    ['CD공동 타행', '현금'],
    ['타행CD 출금', '현금'],
    ['현금IC 인출', '현금'],
    ['ATM 출금', '현금'],
  ]);
});

// ── 순서 ────────────────────────────────────────────────────

test('자동이체가 이체보다 먼저다', () => {
  // 「자동이체」는 「이체」를 품는다. 표의 순서가 뒤집히면 정기 납부가 전부
  // 계좌이체로 읽히고, 그러면 이 기능이 있으나 마나 해진다.
  assert.equal(detectPaymentMethod('자동이체 한국전력'), '자동이체');
  assert.equal(detectPaymentMethod('자동이체 카드대금'), '자동이체',
    '카드라는 글자가 있어도 빼 가는 방식은 자동이체다');
});

test('CD이체가 이체보다 먼저다', () => {
  assert.equal(detectPaymentMethod('CD이체 출금'), '현금');
});

test('ATM 인출이 체크카드보다 먼저다', () => {
  // 「CD공동망 체크카드」 는 카드로 물건을 산 것이 아니라 현금을 뽑은 것이다.
  assert.equal(detectPaymentMethod('CD공동 체크카드'), '현금');
});

// ── 모르면 비워 둔다 ────────────────────────────────────────

test('단서가 없으면 빈 칸이다', () => {
  each([
    ['GS25 강남점', ''],
    ['', ''],
    ['   ', ''],
    ['월세', ''],
  ]);
  assert.equal(detectPaymentMethod(null), '');
  assert.equal(detectPaymentMethod(undefined), '');
});

test('상호명에 섞일 법한 짧은 토큰은 쓰지 않는다', () => {
  // 「모바일세상」을 계좌이체로 읽는 것이 못 읽는 것보다 나쁘다.
  // 예전에 NOISE_WORDS 가 부분 문자열로 지워서 상호명을 훼손한 적이 있다 —
  // 같은 함정을 판정에서 되풀이하지 않는다.
  each([
    ['모바일세상', ''],
    ['BC마트', ''],
    ['입금 이자', ''],
  ]);
});

test('대소문자는 가리지 않는다', () => {
  assert.equal(detectPaymentMethod('cms 통신비'), '자동이체');
  assert.equal(detectPaymentMethod('atm 출금'), '현금');
});

// ── 저장 전 검사 ────────────────────────────────────────────

test('화면이 보낸 값을 그대로 믿지 않는다', () => {
  for (const m of PAYMENT_METHODS) assert.equal(normalizePaymentMethod(m), m);
  assert.equal(normalizePaymentMethod('아무거나'), '');
  assert.equal(normalizePaymentMethod(''), '');
  assert.equal(normalizePaymentMethod(null), '');
  assert.equal(normalizePaymentMethod(' 카드 '), '카드');
});

// ── 집행 지점 ───────────────────────────────────────────────

test('판정은 지우기 전의 원문에서 한다', () => {
  // NOISE_WORDS 가 `체크카드`·`일시불`·`승인`·`전자금융`·`CD이체` 를 지운다.
  // 상호명을 다듬으려고 지우는 것인데, 그 단어들이 정확히 결제수단의 단서다.
  // 다듬은 뒤(description)에서 읽으면 거의 아무것도 못 읽는다.
  const src = readFileSync(new URL('../public/modules/modals.js', import.meta.url), 'utf8');
  const m = src.match(/method:\s*detectPaymentMethod\(([^)]*)\)/);
  assert.ok(m, '판독 결과에 결제수단을 붙이지 않습니다');
  assert.ok(/descRaw/.test(m[1]),
    `원문이 아니라 다듬은 내용에서 읽습니다: ${m[1]}`);
});

test('NOISE_WORDS 가 지우는 단어가 판정표에 남아 있다', () => {
  // 이 둘이 어긋나면 조용히 아무것도 판정되지 않는다. 기능이 꺼진 것을
  // 아무도 모르는 종류의 고장이다.
  const parser = readFileSync(new URL('../public/parser-config.js', import.meta.url), 'utf8');
  const noise = [...parser.matchAll(/'([^']+)'/g)].map(x => x[1]);
  const rules = readFileSync(new URL('../public/domain/payment-method.js', import.meta.url), 'utf8');
  const overlap = ['체크카드', '일시불', '승인', '전자금융', 'CD이체'];
  for (const w of overlap) {
    assert.ok(noise.includes(w), `${w} 가 NOISE_WORDS 에서 사라졌습니다 — 전제를 다시 보세요`);
    assert.ok(rules.includes(`'${w}'`), `${w} 가 판정표에서 빠졌습니다`);
  }
});

test('저장·수정 경로가 method 를 허용한다', () => {
  // 규칙이 막으면 화면에서는 고를 수 있는데 서버가 거부한다.
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const create = rules.slice(rules.indexOf('function transactionCreateFieldsOk'));
  assert.ok(/'method'/.test(create.slice(0, 500)), '생성에서 method 가 막힙니다');
  const update = rules.slice(rules.indexOf('function transactionUpdateFieldsOk'));
  assert.ok(/'method'/.test(update.slice(0, 600)), '수정에서 method 가 막힙니다');
});
