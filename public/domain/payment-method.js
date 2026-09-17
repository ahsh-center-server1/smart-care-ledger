// public/domain/payment-method.js
//
// 결제수단 — 통장 적요에서 읽어 낸다. 순수 함수. DOM·Firestore를 모른다.
//
// 왜 분류(category)와 다른 축인가
//   「식비」와 「카드」 중 하나만 고르게 만들면 안 된다. 무엇에 썼는가와
//   어떻게 냈는가는 서로 독립이다. 분류 규칙에 섞으면 둘 중 하나를 포기해야
//   하고, 실제로 포기되는 쪽은 언제나 결제수단이다.
//
// 왜 원문에서 읽어야 하나
//   parser-config.js 의 NOISE_WORDS 가 `체크카드`·`일시불`·`승인`·`전자금융`·
//   `CD이체` 를 **지운다.** 상호명을 깨끗하게 만들려고 지우는 것인데, 그
//   지워지는 단어들이 정확히 결제수단의 단서다. 그래서 판정은 지우기 전의
//   원문(descRaw)에서 한다.
//
// 모르면 비워 둔다
//   틀린 구분이 붙는 것보다 빈 칸이 낫다. 빈 칸은 사람이 채우지만, 틀린 값은
//   맞는 줄 알고 넘어간다. 그래서 상호명에 섞여 나올 법한 짧은 토큰
//   (`BC`, `모바일`, `입금`)은 일부러 넣지 않았다 —
//   「모바일세상」을 계좌이체로 읽는 것이 못 읽는 것보다 나쁘다.

'use strict';

/** 화면이 고를 수 있는 값. 이 밖의 값은 저장하지 않는다. */
export const PAYMENT_METHODS = ['카드', '계좌이체', '자동이체', '현금'];

/**
 * 판정표. **순서가 곧 우선순위다.**
 *
 * 「자동이체」가 「이체」보다, 「CD이체」가 「이체」보다 먼저 와야 한다.
 * 뒤집히면 자동이체와 현금인출이 전부 계좌이체로 빨려 들어간다.
 */
const RULES = [
  // 기계가 정해진 날에 빼 가는 것. 「이체」를 품고 있으므로 가장 먼저 본다.
  ['자동이체', ['자동이체', '자동납부', '자동납입', '자동출금', '자동송금', '지로', 'CMS', 'GIRO', '펌뱅킹']],
  // 창구·ATM에서 실제 현금이 오간 것. 「CD이체」가 「이체」를 품는다.
  ['현금', ['예금인출', '현금인출', '현금지급', '현금IC', 'CD공동', '타행CD', 'CD이체', 'ATM']],
  // 카드 승인. 은행 적요에서 「승인」은 사실상 카드다.
  ['카드', ['체크카드', '신용카드', '장기카드', '단기카드', '일시불', '할부', '카드',
    'NH체크', 'KB체크', '체크우리', '우리체크', '신한체', '체크신한', '승인']],
  // 사람이 계좌에서 계좌로 보낸 것.
  ['계좌이체', ['전자금융', '인터넷뱅킹', '모바일뱅킹', '폰뱅킹', '타행이체', '이체', '송금', '대체']],
];

/**
 * 적요에서 결제수단을 읽는다.
 *
 * @param {string} description 지우기 **전의** 원문이어야 한다 (descRaw)
 * @returns {string} PAYMENT_METHODS 중 하나, 모르면 빈 문자열
 */
export function detectPaymentMethod(description) {
  const hay = String(description || '');
  if (!hay.trim()) return '';
  // 대소문자만 맞춘다. 공백은 지우지 않는다 — 「승 인」 같은 것은 없고,
  // 지우면 상호명 끝과 다음 단어가 붙어 없던 토큰이 생긴다.
  const upper = hay.toUpperCase();
  for (const [method, tokens] of RULES) {
    if (tokens.some(k => upper.includes(k.toUpperCase()))) return method;
  }
  return '';
}

/** 저장해도 되는 값인가. 화면이 보낸 것을 그대로 믿지 않는다. */
export function normalizePaymentMethod(value) {
  const v = String(value || '').trim();
  return PAYMENT_METHODS.includes(v) ? v : '';
}
