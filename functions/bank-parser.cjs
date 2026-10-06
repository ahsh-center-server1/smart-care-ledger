'use strict';

/**
 * 은행 파서 설정 판정 — 브라우저 `public/domain/bank-parser.js` 의 **서버 사본**.
 *
 * 왜 사본인가
 *   콜러블은 CommonJS 라 브라우저의 ES 모듈을 그대로 쓸 수 없다. 값이 갈리면
 *   화면은 통과시키고 서버가 거절하는(또는 그 반대) 상태가 되므로
 *   `test/bank-parser.test.mjs` 가 같은 입력으로 둘을 대조한다.
 *
 * 화면만 막으면 콜러블을 직접 부르는 길이 남고, 서버만 막으면 사용자는 저장을
 * 누른 뒤에야 안다 — 그래서 **문장까지 같다.**
 */

const USER_KEY_PREFIX = 'USER_';
const MAX_SAVED_PARSERS = 30;

const text = (v) => String(v ?? '').trim();
const squash = (v) => text(v).replace(/\s/g, '');

function bankParserKey(label) {
  const base = text(label).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (base) return USER_KEY_PREFIX + base.slice(0, 32);
  let h = 0;
  for (const ch of text(label)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `${USER_KEY_PREFIX}B${h.toString(36).toUpperCase()}`;
}

function normalizeBankParser(raw) {
  const r = raw || {};
  const label = text(r.label) || text(r.name);
  const DATE = text(r.DATE);
  const DESC = text(r.DESC);
  const WITHDRAW = text(r.WITHDRAW);
  const DEPOSIT = text(r.DEPOSIT);
  const AMT = text(r.AMT);
  if (!label || !DATE) return null;
  if (!WITHDRAW && !DEPOSIT && !AMT) return null;

  const out = { key: text(r.key) || bankParserKey(label), label, DATE, DESC };
  if (WITHDRAW) out.WITHDRAW = WITHDRAW;
  if (DEPOSIT) out.DEPOSIT = DEPOSIT;
  if (AMT) out.AMT = AMT;
  const skip = text(r.SKIP_IF);
  if (skip) out.SKIP_IF = skip;
  if (!out.key.startsWith(USER_KEY_PREFIX)) out.key = USER_KEY_PREFIX + out.key;
  return out;
}

function normalizeBankParsers(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.parsers) ? raw.parsers : []);
  const byKey = new Map();
  for (const item of list) {
    const p = normalizeBankParser(item);
    if (p) byKey.set(p.key, p);
  }
  return [...byKey.values()].slice(0, MAX_SAVED_PARSERS);
}

function bankParserProblem(raw) {
  const r = raw || {};
  if (!text(r.label)) return '은행 이름을 적어 주세요.';
  if (!text(r.DATE)) return '날짜 열을 골라 주세요.';
  if (!text(r.WITHDRAW) && !text(r.DEPOSIT) && !text(r.AMT)) {
    return '출금·입금 중 최소 한 열은 골라야 합니다.';
  }
  if (!text(r.DESC)) return '내용(적요) 열을 골라 주세요.';
  const used = [r.DATE, r.DESC, r.WITHDRAW, r.DEPOSIT, r.AMT, r.SKIP_IF]
    .map(squash).filter(Boolean);
  if (new Set(used).size !== used.length) return '한 열을 두 자리에 고를 수 없습니다.';
  return '';
}

module.exports = {
  USER_KEY_PREFIX,
  MAX_SAVED_PARSERS,
  bankParserKey,
  normalizeBankParser,
  normalizeBankParsers,
  bankParserProblem,
};
