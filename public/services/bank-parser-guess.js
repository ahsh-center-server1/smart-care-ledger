// public/services/bank-parser-guess.js
//
// 파일을 열어 보고 **어느 열이 무엇인지 추측한다.**
//
// 왜 도메인이 아니라 여기인가
//   값의 생김새(날짜꼴·금액꼴)를 보려면 `excel-parser.js` 의 `fixDate` ·
//   `toNumSigned` 가 필요하다. domain/ 은 services/ 를 import 하지 않으므로
//   (구조 규칙) 판정을 여기 두고, 설정 자체를 다루는 규칙만 domain 에 남긴다.
//
// 왜 AI 가 아니라 규칙인가
//   날짜꼴·금액꼴은 값만 보면 알 수 있고, 규칙은 재현되고 테스트된다. 무엇보다
//   **사람이 고르는 화면이 앞에 있다** — 추천은 첫 선택을 채워 주는 것까지이고,
//   틀려도 사용자가 고쳐서 저장한다. AI 추천은 이 위에 얹는 선택지다
//   (`suggestBankParser`, 보내는 것은 헤더 글자뿐).

'use strict';

import { fixDate, toNumSigned } from './excel-parser.js';

const text = (v) => String(v ?? '').trim();
const squash = (v) => text(v).replace(/\s/g, '');

const DATE_WORDS = ['거래일', '이용일', '날짜', '일자', '거래일시', '승인일'];
const OUT_WORDS = ['출금', '찾으신', '지급', '인출', '이용금액', '결제금액', '사용금액'];
const IN_WORDS = ['입금', '맡기신', '예입', '수입'];
const BAL_WORDS = ['잔액', '잔고', '남은'];
const DESC_WORDS = ['내용', '적요', '가맹점', '기재', '보낸분', '받는분', '거래기록', '비고', '이용하신곳', '상호'];

const hasWord = (label, words) => {
  const s = squash(label);
  return !!s && words.some(w => s.includes(w));
};

/** 이 열의 값들이 무엇처럼 생겼나. 빈 칸은 세지 않는다. */
function columnShape(rows, idx) {
  let seen = 0, dates = 0, nums = 0, texts = 0;
  for (const row of rows) {
    const v = row && row[idx];
    const s = text(v);
    if (!s) continue;
    seen++;
    if (fixDate(v)) { dates++; continue; }
    const n = toNumSigned(v);
    if (!Number.isNaN(n) && s.replace(/[^0-9]/g, '') !== '') { nums++; continue; }
    texts++;
  }
  if (!seen) return { seen: 0, kind: 'empty' };
  const share = (n) => n / seen;
  if (share(dates) >= 0.6) return { seen, kind: 'date' };
  if (share(nums) >= 0.6) return { seen, kind: 'number' };
  if (share(texts) >= 0.5) return { seen, kind: 'text' };
  return { seen, kind: 'mixed' };
}

/**
 * 시트에서 헤더 행과 각 열의 뜻을 추측한다.
 *
 * @param {Array<Array>} rows  sheet_to_json({header:1}) 결과
 * @returns {{headerRow:number, header:string[], picks:Object, shapes:Array}|null}
 *   picks — {DATE, DESC, WITHDRAW, DEPOSIT, AMT} 각각 **열 번호**(없으면 -1)
 *   헤더 행을 못 찾으면 null (헤더 없는 파일은 이 방식으로 설정을 만들 수 없다)
 */
export function guessBankParser(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;

  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i++) {
    const header = Array.isArray(rows[i]) ? rows[i].map(text) : [];
    if (header.filter(Boolean).length < 3) continue;
    // 헤더 칸 자체가 날짜·금액이면 그건 데이터 행이다.
    if (header.some(h => fixDate(h))) continue;

    const body = rows.slice(i + 1, i + 1 + 20).filter(r => Array.isArray(r));
    if (body.length < 1) continue;

    const width = Math.max(header.length, ...body.map(r => r.length));
    const shapes = [];
    for (let c = 0; c < width; c++) shapes.push({ idx: c, label: header[c] || '', ...columnShape(body, c) });

    const dateCols = shapes.filter(s => s.kind === 'date');
    const numCols = shapes.filter(s => s.kind === 'number');
    if (!dateCols.length || !numCols.length) continue;

    // 날짜 — 헤더 낱말이 맞는 것 우선, 아니면 가장 왼쪽
    const date = dateCols.find(s => hasWord(s.label, DATE_WORDS)) || dateCols[0];

    // 금액 — 잔액처럼 보이는 열은 뺀다. 헤더가 「잔액」이라고 말하거나,
    // 금액 열이 셋 이상이면 맨 오른쪽은 대개 잔액이다.
    let money = numCols.filter(s => !hasWord(s.label, BAL_WORDS));
    if (money.length >= 3) money = money.slice(0, money.length - 1);

    const out = money.find(s => hasWord(s.label, OUT_WORDS));
    const inn = money.find(s => hasWord(s.label, IN_WORDS) && s !== out);
    const picks = { DATE: date.idx, DESC: -1, WITHDRAW: -1, DEPOSIT: -1, AMT: -1 };

    if (money.length === 1) {
      // 짝지을 반대쪽이 없다 — 카드 명세서다(이용금액 하나). 낱말이 「출금」이라
      // 해도 마찬가지다: 열이 하나뿐이면 출금/입금을 가른다는 말 자체가 성립하지
      // 않는다. AMT 와 WITHDRAW 는 파서에서 같은 자리로 들어가므로 뜻이 분명한
      // 쪽을 쓴다.
      picks.AMT = money[0].idx;
    } else if (out || inn) {
      if (out) picks.WITHDRAW = out.idx;
      if (inn) picks.DEPOSIT = inn.idx;
      // 낱말로 하나만 찾았고 금액 열이 둘이면 남은 하나가 반대쪽이다.
      if (money.length === 2 && (!out || !inn)) {
        const other = money.find(s => s.idx !== (out || inn).idx);
        if (other) { if (out) picks.DEPOSIT = other.idx; else picks.WITHDRAW = other.idx; }
      }
    } else {
      // 낱말이 없으면 자리로 본다 — 국내 통장은 출금이 먼저 온다.
      picks.WITHDRAW = money[0].idx;
      picks.DEPOSIT = money[1].idx;
    }

    // 내용 — 헤더 낱말 우선, 아니면 글자가 가장 많이 든 열
    const taken = new Set([picks.DATE, picks.WITHDRAW, picks.DEPOSIT, picks.AMT]);
    const textCols = shapes.filter(s => !taken.has(s.idx) && (s.kind === 'text' || s.kind === 'mixed'));
    const desc = textCols.find(s => hasWord(s.label, DESC_WORDS))
      || textCols.slice().sort((a, b) => b.seen - a.seen)[0];
    if (desc) picks.DESC = desc.idx;

    return { headerRow: i, header, picks, shapes };
  }
  return null;
}

