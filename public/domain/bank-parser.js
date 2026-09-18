// public/domain/bank-parser.js
//
// 은행 파서를 **데이터로** 다룬다 — 소스 파일이 아니라.
//
// 왜
//   은행 하나를 늘리는 일은 실제로 `parser-config.js` 에 항목 한 줄을 넣는
//   것이다. 그런데 그 파일은 **배포되는 소스**라, 거래처 은행이 하나 바뀔
//   때마다 사회복지사가 개발자를 불러야 한다. 이 시스템을 쓰는 사람에게
//   "배포"는 부를 사람이 있어야 되는 일이다 — 결국 아무도 안 부르고, 그 은행의
//   거래는 손으로 옮겨 적힌다.
//
//   그래서 설정을 `config/bankParsers` 문서 하나에 둔다. 팀 목록과 같은
//   방식이다(문서 1건, 서버 콜러블만 쓰기).
//
// 왜 깃허브에서 코드를 불러와 고치지 않는가
//   ⑴ 화면에서 저장소에 쓰려면 쓰기 토큰이 브라우저에 있어야 하고, 그것은 앱
//      전체를 고칠 수 있는 열쇠다. ⑵ 고쳐도 배포해야 반영되니 "바로 되는"
//      기능이 아니다. ⑶ 사용자가 JS 문법을 직접 만지면 `parser-config.js` 하나가
//      깨졌을 때 **앱 전체가 안 열린다.** 설정을 데이터로 두는 쪽이 모든 면에서
//      낫다.
//
// 저장분은 **언제나 내장 설정 뒤**다
//   `detectConfig` 는 위에서부터 먼저 맞는 것을 택한다. 저장분을 앞에 두면
//   사용자가 만든 느슨한 설정 하나가 이미 잘 되던 은행을 가로챌 수 있다.
//   뒤에 두면 최악의 경우가 "아직 안 되던 파일이 여전히 안 됨"이다.
//   키에 `USER_` 접두어를 붙여 내장 키와 겹칠 수 없게도 해 둔다.
//
// 순수 계층이다 — DOM·Firestore 도, 다른 계층도 import 하지 않는다. 값의 생김새를
// 보고 열을 추측하는 일(`guessBankParser`)은 날짜·금액 파서가 필요해서
// `services/bank-parser-guess.js` 에 있다. 서버 사본은 `functions/bank-parser.cjs`
// 이고 test/bank-parser.test.mjs 가 둘을 대조한다.

'use strict';

/** 저장된 설정 키의 접두어. 내장 키와 겹치지 않게 하는 유일한 장치다. */
export const USER_KEY_PREFIX = 'USER_';

/** 한 문서에 담는다 — 너무 많으면 판정이 느려지고, 실제로 그렇게 많을 수 없다. */
export const MAX_SAVED_PARSERS = 30;

const text = (v) => String(v ?? '').trim();
const squash = (v) => text(v).replace(/\s/g, '');

/** 헤더 글자에서 만든 키. 한글은 코드포인트로 바꾼다(키는 ASCII 여야 읽기 쉽다). */
export function bankParserKey(label) {
  const base = text(label).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (base) return USER_KEY_PREFIX + base.slice(0, 32);
  // 한글만 있는 이름 — 글자에서 만든 짧은 해시. 충돌해도 이름이 같으면 같은 것이다.
  let h = 0;
  for (const ch of text(label)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `${USER_KEY_PREFIX}B${h.toString(36).toUpperCase()}`;
}

/**
 * 저장된 항목 하나를 정리한다. 모양이 깨져 있어도 화면은 떠야 한다.
 * @returns {Object|null} 쓸 수 없는 항목이면 null
 */
export function normalizeBankParser(raw) {
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

/** 저장 문서 → 항목 배열. 같은 키는 뒤엣것이 이긴다(마지막 저장이 최신이다). */
export function normalizeBankParsers(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.parsers) ? raw.parsers : []);
  const byKey = new Map();
  for (const item of list) {
    const p = normalizeBankParser(item);
    if (p) byKey.set(p.key, p);
  }
  return [...byKey.values()].slice(0, MAX_SAVED_PARSERS);
}

/**
 * 저장할 수 없는 이유. 없으면 ''.
 *
 * 화면과 서버가 **같은 문장**을 쓴다 — 화면만 막으면 콜러블을 직접 부르는
 * 길이 남고, 서버만 막으면 사용자는 저장을 누른 뒤에야 안다.
 */
export function bankParserProblem(raw) {
  const r = raw || {};
  if (!text(r.label)) return '은행 이름을 적어 주세요.';
  if (!text(r.DATE)) return '날짜 열을 골라 주세요.';
  if (!text(r.WITHDRAW) && !text(r.DEPOSIT) && !text(r.AMT)) {
    return '출금·입금 중 최소 한 열은 골라야 합니다.';
  }
  if (!text(r.DESC)) return '내용(적요) 열을 골라 주세요.';
  // 같은 열을 두 자리에 넣으면 금액이 날짜로 읽히거나 그 반대가 된다.
  const used = [r.DATE, r.DESC, r.WITHDRAW, r.DEPOSIT, r.AMT, r.SKIP_IF]
    .map(squash).filter(Boolean);
  if (new Set(used).size !== used.length) return '한 열을 두 자리에 고를 수 없습니다.';
  return '';
}

/**
 * 파서가 실제로 쓸 설정 — 내장 + 저장분. **저장분이 뒤다**(머리말 참고).
 * @param {Object} builtIn  BANK_CONFIGS
 * @param {Array|Object} saved  config/bankParsers 문서 또는 항목 배열
 */
export function mergedBankConfigs(builtIn, saved) {
  const out = { ...(builtIn || {}) };
  for (const p of normalizeBankParsers(saved)) {
    const cfg = { DATE: p.DATE, DESC: p.DESC };
    if (p.WITHDRAW) cfg.WITHDRAW = p.WITHDRAW;
    if (p.DEPOSIT) cfg.DEPOSIT = p.DEPOSIT;
    if (p.AMT) cfg.AMT = p.AMT;
    if (p.SKIP_IF) cfg.SKIP_IF = p.SKIP_IF;
    // 판정 조건은 **고른 열 그대로**다. 날짜가 있고, 금액 열 중 하나가 있으면
    // 이 은행이다. 저장분끼리는 먼저 저장한 것이 앞이다.
    cfg.MATCH = [[p.DATE], [p.WITHDRAW, p.DEPOSIT, p.AMT].filter(Boolean)];
    cfg.LABEL = p.label;
    out[p.key] = cfg;
  }
  return out;
}

/**
 * 고른 열 번호 → 저장할 설정. 헤더 **글자**를 담는다(열 번호가 아니라).
 *
 * 열 번호로 담으면 은행이 열 하나를 끼워 넣는 순간 전부 어긋나고, 그때
 * 사용자는 "어제까지 되던 것"이 왜 안 되는지 알 수 없다. 글자로 담으면
 * 순서가 바뀌어도 따라간다 — 기존 설정이 전부 그렇게 돼 있다.
 */
export function bankParserFromPicks(label, header, picks) {
  const at = (i) => (Number.isInteger(i) && i >= 0 ? text(header[i]) : '');
  const draft = {
    label: text(label),
    DATE: at(picks && picks.DATE),
    DESC: at(picks && picks.DESC),
    WITHDRAW: at(picks && picks.WITHDRAW),
    DEPOSIT: at(picks && picks.DEPOSIT),
    AMT: at(picks && picks.AMT),
    SKIP_IF: at(picks && picks.SKIP_IF),
  };
  for (const k of Object.keys(draft)) if (!draft[k]) delete draft[k];
  draft.label = text(label);
  return draft;
}
