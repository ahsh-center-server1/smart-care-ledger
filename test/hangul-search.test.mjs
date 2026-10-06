// test/hangul-search.test.mjs
//
// 초성 검색 — 「ㄱㅂ」로 김밥천국을 찾는다.
//
// 왜 테스트가 필요한가
//   초성 판정은 한 글자 안에서 유니코드 산술을 한다. 틀리면 결과가 비는 것이
//   아니라 **엉뚱한 줄이 걸린다** — 검색은 원래 몇 건만 보여 주는 화면이라
//   틀린 줄이 섞여도 눈에 띄지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chosungOf, isChosungChar, hasChosung, searchMatches, searchMatchesAny,
} from '../public/domain/hangul-search.js';

test('초성을 뽑는다 — 받침이 있든 없든', () => {
  assert.equal(chosungOf('김'), 'ㄱ');
  assert.equal(chosungOf('가'), 'ㄱ');
  assert.equal(chosungOf('밥'), 'ㅂ');
  assert.equal(chosungOf('힣'), 'ㅎ');
  assert.equal(chosungOf('짜'), 'ㅉ');
});

test('한글 음절이 아니면 초성이 없다', () => {
  for (const ch of ['A', '1', ' ', 'ㄱ', 'ㅏ', '漢', '']) {
    assert.equal(chosungOf(ch), null, `${ch} 에서 초성이 나왔습니다`);
  }
});

test('모음은 초성 글자가 아니다', () => {
  assert.equal(isChosungChar('ㄱ'), true);
  assert.equal(isChosungChar('ㅃ'), true);
  assert.equal(isChosungChar('ㅏ'), false);
  assert.equal(hasChosung('ㄱㅂ'), true);
  assert.equal(hasChosung('김밥'), false);
});

test('초성으로 찾는다', () => {
  assert.equal(searchMatches('김밥천국', 'ㄱㅂ'), true);
  assert.equal(searchMatches('김밥천국', 'ㅊㄱ'), true, '중간에서 시작해도 걸려야 합니다');
  assert.equal(searchMatches('김밥천국', 'ㄱㅂㅊㄱ'), true);
});

test('순서가 다르면 걸리지 않는다 — 초성이 "아무 자음이나"가 되면 안 된다', () => {
  assert.equal(searchMatches('김밥천국', 'ㅂㄱ'), false);
  assert.equal(searchMatches('김밥천국', 'ㅎㅎ'), false);
});

test('평범한 부분일치는 그대로 된다', () => {
  assert.equal(searchMatches('김밥천국', '밥천'), true);
  assert.equal(searchMatches('GS25 강남점', 'gs25'), true, '대소문자를 가리지 않아야 합니다');
  assert.equal(searchMatches('GS25 강남점', 'ㄱㄴ'), true, '한글 부분만 초성으로 걸려야 합니다');
});

test('빈 검색어는 전부 통과 — 지우면 다 보이는 것이 기대다', () => {
  for (const q of ['', '   ', null, undefined]) {
    assert.equal(searchMatches('아무개', q), true);
    assert.equal(searchMatchesAny(['아무개'], q), true);
  }
});

test('빈 대상은 검색어가 있으면 걸리지 않는다', () => {
  assert.equal(searchMatches('', 'ㄱ'), false);
  assert.equal(searchMatches(null, '김'), false);
});

test('여러 칸 중 하나만 맞아도 된다 — 이름·아이디·팀', () => {
  assert.equal(searchMatchesAny(['홍길동', 'hong', '1팀'], 'ㅎㄱㄷ'), true);
  assert.equal(searchMatchesAny(['홍길동', 'hong', '1팀'], 'hon'), true);
  assert.equal(searchMatchesAny(['홍길동', 'hong', '1팀'], 'ㅁㅁ'), false);
});

test('칸마다 따로 맞춘다 — 이어 붙인 한 문자열이 아니다', () => {
  // 예전 변경 이력 검색은 칸을 한 문자열로 이어 붙여 걸렀다. 붙이면 띄어쓰기를
  // 포함한 질의가 칸 경계를 넘어 걸릴 수 있다 — 아무 칸에도 없는 말이다.
  assert.equal(searchMatchesAny(['홍길동', '담당자'], '동 담'), false);
  assert.equal(searchMatches('홍길동 담당자', '동 담'), true);
});
