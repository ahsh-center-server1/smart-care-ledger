// test/bank-parser.test.mjs
//
// 은행을 **배포 없이** 늘린다 — 그 판정이 화면과 서버에서 같은 답을 내는가.
//
// 지키는 것 셋:
//   ⑴ 저장분은 언제나 내장 설정 **뒤**에서 판정된다. 앞에 두면 사용자가 만든
//      느슨한 설정 하나가 이미 잘 되던 은행을 가로챈다.
//   ⑵ 화면과 서버가 **같은 문장**으로 거절한다. 화면만 막으면 콜러블을 직접
//      부르는 길이 남고, 서버만 막으면 사용자는 저장을 누른 뒤에야 안다.
//   ⑶ AI 추천에 **거래가 실려 나가지 않는다.** 보내는 것은 머리글 글자뿐이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  normalizeBankParser, normalizeBankParsers, bankParserProblem, bankParserKey,
  mergedBankConfigs, bankParserFromPicks, USER_KEY_PREFIX,
} from '../public/domain/bank-parser.js';
import { guessBankParser } from '../public/services/bank-parser-guess.js';
import { BANK_CONFIGS, detectConfig, parseSheetRows } from '../public/services/excel-parser.js';

const require = createRequire(import.meta.url);
const server = require('../functions/bank-parser.cjs');
const { buildHeaderFacts } = require('../functions/ai/bank-header.js');

const HANA = {
  label: '하나은행', DATE: '거래일시', DESC: '적요', WITHDRAW: '출금', DEPOSIT: '입금',
};

// ── 서버 사본과 대조 ────────────────────────────────────────────────
//
// 값이 갈리면 "화면은 통과시키고 서버가 거절한다"가 된다. 두 벌인 이유는
// 규칙·콜러블이 CommonJS 라 ES 모듈을 그대로 못 쓰기 때문이다.

const CASES = [
  HANA,
  { label: '카드사', DATE: '이용일자', DESC: '가맹점', AMT: '이용금액' },
  { label: '', DATE: '거래일', DESC: '내용', WITHDRAW: '출금' },          // 이름 없음
  { label: '이름만', DATE: '', DESC: '내용', WITHDRAW: '출금' },           // 날짜 없음
  { label: '금액없음', DATE: '거래일', DESC: '내용' },                     // 금액 열 없음
  { label: '겹침', DATE: '금액', DESC: '내용', WITHDRAW: '금액' },          // 한 열 두 자리
  { label: '내용없음', DATE: '거래일', DESC: '', WITHDRAW: '출금' },
];

test('화면과 서버가 같은 이유로 거절한다', () => {
  for (const c of CASES) {
    assert.equal(bankParserProblem(c), server.bankParserProblem(c),
      `${c.label || '(이름없음)'} 의 거절 사유가 갈립니다`);
  }
});

test('화면과 서버가 같은 항목을 만든다', () => {
  for (const c of CASES) {
    assert.deepEqual(normalizeBankParser(c), server.normalizeBankParser(c));
  }
  assert.deepEqual(normalizeBankParsers({ parsers: CASES }),
    server.normalizeBankParsers({ parsers: CASES }));
});

test('키는 접두어가 붙어 내장 키와 겹칠 수 없다', () => {
  for (const label of ['하나은행', 'Hana Bank', '기업', '']) {
    const k = bankParserKey(label);
    assert.ok(k.startsWith(USER_KEY_PREFIX), `${label} → ${k}`);
    assert.equal(k, server.bankParserKey(label));
    assert.ok(!(k in BANK_CONFIGS));
  }
});

// ── 순서 ───────────────────────────────────────────────────────────

test('저장분은 내장 설정 뒤에서 판정된다', () => {
  // 사용자가 국민은행 헤더에도 맞는 느슨한 설정을 만들어도 KB_BANK 가 이긴다.
  const loose = { label: '내가만든것', DATE: '거래일시', DESC: '보낸분/받는분', WITHDRAW: '출금액' };
  const merged = mergedBankConfigs(BANK_CONFIGS, [loose]);
  assert.equal(detectConfig('거래일시|보낸분/받는분|출금액|입금액|잔액', merged), 'KB_BANK');
  // 내장에 없는 헤더는 저장분이 받는다.
  const merged2 = mergedBankConfigs(BANK_CONFIGS, [HANA]);
  assert.equal(detectConfig('거래일시|적요|출금|입금|잔액', merged2), bankParserKey('하나은행'));
});

test('저장한 설정만으로 파일이 읽힌다 — 소스를 고치지 않는다', () => {
  const rows = [
    ['거래일시', '적요', '출금', '입금', '잔액'],
    ['2026-07-10', '이마트', '12,000', '', '80,000'],
    ['2026-07-11', '용돈', '', '30,000', '110,000'],
  ];
  const out = parseSheetRows(rows, [], { configs: mergedBankConfigs(BANK_CONFIGS, [HANA]) });
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].out, 12000);
  assert.equal(out.rows[1].in, 30000);
  // 내장 설정만으로는 못 읽는다 — 이 테스트가 실제로 저장분을 쓰고 있다는 증거다.
  assert.equal(parseSheetRows(rows, []).rows.length, 0);
});

// ── 열 추천 ────────────────────────────────────────────────────────

test('머리글 낱말로 출금·입금을 가른다', () => {
  const g = guessBankParser([
    ['입출금 거래내역'], [],
    ['거래일시', '기재내용', '찾으신금액', '맡기신금액', '거래후잔액'],
    ['2026-07-01', '이마트', '12,000', '', '88,000'],
    ['2026-07-03', '용돈', '', '30,000', '118,000'],
  ]);
  assert.equal(g.headerRow, 2);
  assert.equal(g.picks.DATE, 0);
  assert.equal(g.picks.DESC, 1);
  assert.equal(g.picks.WITHDRAW, 2);
  assert.equal(g.picks.DEPOSIT, 3);
  assert.equal(g.picks.AMT, -1, '잔액을 금액으로 잡으면 안 됩니다');
});

test('금액 열이 하나뿐이면 카드 명세서로 본다', () => {
  const g = guessBankParser([
    ['이용일자', '가맹점명', '이용금액'],
    ['2026-07-01', '김밥천국', '7,000'],
    ['2026-07-02', 'GS25', '3,500'],
  ]);
  assert.equal(g.picks.AMT, 2);
  assert.equal(g.picks.WITHDRAW, -1);
});

test('머리글이 없으면 추천하지 않는다 — 지어내지 않는다', () => {
  assert.equal(guessBankParser([['2026-07-01', '이마트', '12,000']]), null);
  assert.equal(guessBankParser([]), null);
});

test('고른 열은 번호가 아니라 **머리글 글자**로 저장된다', () => {
  // 번호로 담으면 은행이 열 하나를 끼워 넣는 순간 전부 어긋난다.
  const header = ['거래일시', '적요', '출금', '입금', '잔액'];
  const draft = bankParserFromPicks('하나은행', header,
    { DATE: 0, DESC: 1, WITHDRAW: 2, DEPOSIT: 3 });
  assert.deepEqual(draft, { label: '하나은행', DATE: '거래일시', DESC: '적요', WITHDRAW: '출금', DEPOSIT: '입금' });
  assert.equal(bankParserProblem(draft), '');
});

// ── AI 추천에 무엇이 실려 나가는가 ──────────────────────────────────

test('모델에게 가는 것은 머리글 글자와 열의 꼴뿐이다', () => {
  const facts = buildHeaderFacts({
    columns: [
      { index: 0, label: '거래일시', kind: 'date', sample: '2026-07-01' },
      { index: 1, label: '기재내용', kind: 'text', values: ['이마트 성수점', '김밥천국'] },
      { index: 2, label: '찾으신금액', kind: 'number', values: [12000] },
    ],
    clientName: '홍길동',
    accountNumber: '123-456-7890',
    rows: [['2026-07-01', '이마트 성수점', '12,000']],
  });
  const json = JSON.stringify(facts);
  for (const leak of ['홍길동', '123-456', '이마트', '김밥천국', '12000', '12,000', '2026-07-01']) {
    assert.ok(!json.includes(leak), `${leak} 이(가) 모델에게 나갑니다: ${json}`);
  }
  assert.deepEqual(facts, {
    columns: [
      { index: 0, label: '거래일시', kind: 'date' },
      { index: 1, label: '기재내용', kind: 'text' },
      { index: 2, label: '찾으신금액', kind: 'number' },
    ],
  });
});

test('모르는 꼴은 text 로 떨어진다 — 모델에게 새 낱말을 보내지 않는다', () => {
  const facts = buildHeaderFacts({ columns: [{ index: 0, label: 'x', kind: '홍길동의 계좌' }] });
  assert.equal(facts.columns[0].kind, 'text');
});
