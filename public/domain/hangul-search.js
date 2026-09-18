/**
 * domain/hangul-search.js — 초성으로도 찾게 한다
 *
 * 왜 필요한가
 *   한글은 한 글자를 치려면 자음·모음을 다 쳐야 한다. 「김밥천국」을 찾으려고
 *   ㄱ·ㅣ·ㅁ… 을 누르는 동안 목록은 「기」→「김」으로 두 번 흔들린다. 반면
 *   「ㄱㅂㅊㄱ」은 네 번에 끝난다. 이름·상호를 다루는 화면에서 사회복지사가
 *   실제로 쓰는 방식이다.
 *
 * 왜 도메인 한 곳인가
 *   검색은 거래내역·직원 고르기·변경 이력 세 곳에 따로 있었고, 판정도 각자
 *   `toLowerCase().includes()` 였다. 한 곳만 고치면 "여기서는 되는데 저기서는
 *   안 되는" 검색이 된다.
 *
 * 무엇을 하지 않는가
 *   자모를 완전히 분해해 맞추지 않는다(「ㄱㅣㅁ」 같은 입력). 키보드에서
 *   그렇게 치는 사람은 없고, 규칙이 늘면 뜻밖의 오검출이 생긴다.
 */

'use strict';

const HANGUL_BASE = 0xAC00;   // '가'
const HANGUL_LAST = 0xD7A3;   // '힣'
const JUNG_COUNT = 21;
const JONG_COUNT = 28;

/** 초성 19자 — 유니코드 호환 자모(ㄱ…ㅎ)와 같은 순서다. */
const CHOSUNG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];

/** 이 글자가 홀로 쓰인 자음(초성 후보)인가. 모음(ㅏ…)은 아니다. */
export function isChosungChar(ch) {
  return CHOSUNG.includes(ch);
}

/** 글자 하나의 초성. 한글 음절이 아니면 null. */
export function chosungOf(ch) {
  const code = typeof ch === 'string' && ch.length ? ch.charCodeAt(0) : -1;
  if (code < HANGUL_BASE || code > HANGUL_LAST) return null;
  return CHOSUNG[Math.floor((code - HANGUL_BASE) / (JUNG_COUNT * JONG_COUNT))];
}

/** 검색어에 초성 자음이 하나라도 있는가 — 없으면 평범한 부분일치로 족하다. */
export function hasChosung(query) {
  return String(query || '').split('').some(isChosungChar);
}

const norm = (v) => String(v ?? '').toLowerCase();

/**
 * text 의 index 자리에서 query 가 시작하는가.
 * 질의 글자가 초성 자음이면 그 자리 글자의 초성과 맞춰 본다.
 */
function matchAt(text, query, index) {
  for (let i = 0; i < query.length; i += 1) {
    const q = query[i];
    const t = text[index + i];
    if (t === undefined) return false;
    if (q === t) continue;
    if (isChosungChar(q) && chosungOf(t) === q) continue;
    return false;
  }
  return true;
}

/**
 * text 안에 query 가 있는가 — 초성 입력도 같은 자리로 친다.
 *
 * 빈 질의는 **참**이다. 검색어를 지우면 전부 보이는 것이 사용자의 기대다.
 */
export function searchMatches(text, query) {
  const q = norm(query).trim();
  if (!q) return true;
  const t = norm(text);
  if (!t) return false;
  if (t.includes(q)) return true;          // 평범한 부분일치가 먼저
  if (!hasChosung(q)) return false;        // 초성이 없으면 더 볼 것이 없다
  for (let i = 0; i <= t.length - q.length; i += 1) {
    if (matchAt(t, q, i)) return true;
  }
  return false;
}

/** 여러 칸 중 하나라도 맞으면 참(이름·아이디·팀처럼). */
export function searchMatchesAny(values, query) {
  const q = norm(query).trim();
  if (!q) return true;
  return (values || []).some(v => searchMatches(v, q));
}
