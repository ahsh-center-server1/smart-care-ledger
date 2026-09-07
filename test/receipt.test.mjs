// test/receipt.test.mjs
//
// 영수증 판독 결과의 정규화.
//
// 이 파일이 고정하는 계약은 「모델은 인쇄된 그대로 읽고, 해석은 코드가 한다」다.
// 특히 **날짜**가 중요하다: 한국 영수증에는 연도가 없는 경우가 흔하고,
// 모델이 연도를 추측하면 1년 틀린 거래가 조용히 장부에 들어간다.
// 잔액과 마감이 그것 때문에 어긋나면 원인을 찾기 매우 어렵다.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReceiptDate, normalizeAmount, normalizeMerchant,
  merchantTokens, toReceiptDraft,
} from '../public/domain/receipt.js';

const TODAY = new Date(2026, 8, 7);   // 2026-09-07 (로컬)

test('연도가 있는 날짜 — 구분자 종류와 무관하게 읽는다', () => {
  for (const s of ['2026-09-07', '2026.09.07', '2026/09/07', '20260907', '2026-9-7']) {
    assert.equal(normalizeReceiptDate(s, TODAY), '2026-09-07', s);
  }
});

test('두 자리 연도는 20xx로 본다', () => {
  assert.equal(normalizeReceiptDate('26.09.07', TODAY), '2026-09-07');
  assert.equal(normalizeReceiptDate('26-09-07', TODAY), '2026-09-07');
});

test('한글 날짜', () => {
  assert.equal(normalizeReceiptDate('2026년 9월 7일', TODAY), '2026-09-07');
  assert.equal(normalizeReceiptDate('2026년 09월 07일', TODAY), '2026-09-07');
  assert.equal(normalizeReceiptDate('9월 7일', TODAY), '2026-09-07');
});

test('시각이 붙어 있어도 날짜만 읽는다', () => {
  assert.equal(normalizeReceiptDate('2026-09-07 14:32:11', TODAY), '2026-09-07');
  assert.equal(normalizeReceiptDate('2026-09-07T14:32', TODAY), '2026-09-07');
});

test('연도 없는 날짜는 올해로 채운다', () => {
  assert.equal(normalizeReceiptDate('09/07', TODAY), '2026-09-07');
  assert.equal(normalizeReceiptDate('09.07', TODAY), '2026-09-07');
  assert.equal(normalizeReceiptDate('8/15', TODAY), '2026-08-15');
});

test('연도를 채우면 미래가 되는 경우 작년으로 본다', () => {
  // 12월 영수증을 1월에 올리는 일이 흔하다. 미래 날짜 거래는 잔액 계산과
  // 마감을 어긋나게 하므로 과거로 해석하는 것이 안전하다.
  const jan = new Date(2027, 0, 5);      // 2027-01-05
  assert.equal(normalizeReceiptDate('12/28', jan), '2026-12-28');
  assert.equal(normalizeReceiptDate('12월 28일', jan), '2026-12-28');
  // 오늘까지는 올해로 둔다
  assert.equal(normalizeReceiptDate('01/05', jan), '2027-01-05');
  assert.equal(normalizeReceiptDate('01/04', jan), '2027-01-04');
});

test('존재하지 않는 날짜는 거부한다 — 오독을 통과시키지 않는다', () => {
  assert.equal(normalizeReceiptDate('2026-02-30', TODAY), '');
  assert.equal(normalizeReceiptDate('2026-13-01', TODAY), '');
  assert.equal(normalizeReceiptDate('2026-00-10', TODAY), '');
  assert.equal(normalizeReceiptDate('2026-09-32', TODAY), '');
});

test('읽을 수 없으면 빈 문자열 — 추측해서 채우지 않는다', () => {
  // 틀린 날짜를 채워 두면 사람이 검토할 때 그럴듯해서 그냥 넘어간다.
  // 빈 칸은 눈에 띈다.
  for (const s of ['', '   ', null, undefined, '영수증', 'ABCD', '2026']) {
    assert.equal(normalizeReceiptDate(s, TODAY), '', String(s));
  }
});

test('금액 — 통화 기호·쉼표·공백을 걷어낸다', () => {
  assert.equal(normalizeAmount('12,000'), 12000);
  assert.equal(normalizeAmount('12,000원'), 12000);
  assert.equal(normalizeAmount('₩12,000'), 12000);
  assert.equal(normalizeAmount('12 000'), 12000);
  assert.equal(normalizeAmount('12000'), 12000);
  assert.equal(normalizeAmount(12000), 12000);
  assert.equal(normalizeAmount('  1,234,567 원 '), 1234567);
});

test('금액 — 환불·취소는 음수로', () => {
  assert.equal(normalizeAmount('-5,000'), -5000);
  assert.equal(normalizeAmount('환불 5,000원'), -5000);
  assert.equal(normalizeAmount('취소 12,000'), -12000);
});

test('금액을 못 읽으면 null — 0과 구분해야 한다', () => {
  // 0으로 두면 "0원 거래"가 되어 매칭이 엉키고, 사람이 검토할 때도
  // 판독 실패인지 실제 0원인지 알 수 없다.
  assert.equal(normalizeAmount(''), null);
  assert.equal(normalizeAmount(null), null);
  assert.equal(normalizeAmount(undefined), null);
  assert.equal(normalizeAmount('   '), null);
  assert.equal(normalizeAmount('금액'), null);
  assert.equal(normalizeAmount(NaN), null);
  // 실제 0은 0으로
  assert.equal(normalizeAmount('0'), 0);
  assert.equal(normalizeAmount(0), 0);
});

test('상호명 — 법인 표기와 기호를 걷어낸다', () => {
  assert.equal(normalizeMerchant('(주)이마트 성수점'), '이마트 성수점');
  assert.equal(normalizeMerchant('㈜농협하나로마트'), '농협하나로마트');
  assert.equal(normalizeMerchant('주식회사 카카오'), '카카오');
  assert.equal(normalizeMerchant('GS25 성수역점'), 'GS25 성수역점');
  assert.equal(normalizeMerchant('스타벅스*성수'), '스타벅스 성수');
  assert.equal(normalizeMerchant(''), '');
  assert.equal(normalizeMerchant(null), '');
});

test('상호명 — 노이즈 단어를 제거한다', () => {
  // parser-config.js의 PARSER_NOISE_WORDS를 그대로 쓴다.
  const noise = ['체크카드', '일시불', '승인'];
  assert.equal(normalizeMerchant('이마트 체크카드 일시불', noise), '이마트');
});

test('비교 토큰 — 한 글자는 버린다', () => {
  // "점", "김" 같은 조각이 우연히 겹쳐 잘못된 매칭을 만든다.
  const t = merchantTokens('(주)이마트 성수점 A');
  assert.ok(t.includes('이마트'));
  assert.ok(t.includes('성수점'));
  assert.ok(!t.includes('A'));
  assert.deepEqual(merchantTokens(''), []);
  assert.deepEqual(merchantTokens(null), []);
});

test('비교 토큰은 중복을 접는다', () => {
  const t = merchantTokens('이마트 이마트 성수');
  assert.equal(t.filter(x => x === '이마트').length, 1);
});

test('초안 변환 — 모델 출력을 앱 형태로', () => {
  const draft = toReceiptDraft({
    merchant: '(주)이마트 성수점',
    dateRaw: '26.09.07',
    totalAmount: '12,000원',
    isCancellation: false,
    cardLast4: '1234',
    items: [{ name: '우유', amount: '3,000' }],
    confidence: 0.92,
  }, { today: TODAY });

  assert.equal(draft.date, '2026-09-07');
  assert.equal(draft.merchant, '(주)이마트 성수점');   // 원문 보존(화면에 보여준다)
  assert.equal(draft.amount, 12000);
  assert.equal(draft.isCancellation, false);
  assert.equal(draft.cardLast4, '1234');
  assert.equal(draft.confidence, 0.92);
  assert.equal(draft.items.length, 1);
});

test('초안 변환 — 신뢰도를 0~1로 가둔다', () => {
  const mk = c => toReceiptDraft({ confidence: c }, { today: TODAY }).confidence;
  assert.equal(mk(1.5), 1);
  assert.equal(mk(-0.2), 0);
  assert.equal(mk('0.5'), 0.5);
  // 값이 없으면 0 — 낮은 쪽으로 안전하게(사람이 확인하게 된다)
  assert.equal(mk(undefined), 0);
  assert.equal(mk(null), 0);
  assert.equal(mk('높음'), 0);
});

test('초안 변환 — 잘못된 카드번호는 버린다', () => {
  const mk = v => toReceiptDraft({ cardLast4: v }, { today: TODAY }).cardLast4;
  assert.equal(mk('1234'), '1234');
  assert.equal(mk('12'), '');
  assert.equal(mk('12345'), '');
  assert.equal(mk('abcd'), '');
  assert.equal(mk(''), '');
});

test('초안 변환 — 빈 입력에도 깨지지 않는다', () => {
  const d = toReceiptDraft(null);
  assert.equal(d.date, '');
  assert.equal(d.amount, null);
  assert.equal(d.merchant, '');
  assert.equal(d.confidence, 0);
  assert.deepEqual(d.items, []);
  assert.doesNotThrow(() => toReceiptDraft(undefined));
  assert.doesNotThrow(() => toReceiptDraft({}));
});

test('초안 변환 — 품목이 지나치게 많으면 자른다', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ name: 'x' + i, amount: '1' }));
  assert.equal(toReceiptDraft({ items: many }, { today: TODAY }).items.length, 30);
});

test('초안 변환 — isCancellation은 엄격히 true만 인정한다', () => {
  const mk = v => toReceiptDraft({ isCancellation: v }, { today: TODAY }).isCancellation;
  assert.equal(mk(true), true);
  assert.equal(mk('true'), false);      // 문자열은 인정하지 않는다
  assert.equal(mk(1), false);
  assert.equal(mk(undefined), false);
});

// ─────────────────────────────────────────────────────────────
// 통장 사진 → 엑셀 파서 행
//
// 사진 전용 저장 경로를 만들지 않고 이미 검증된 엑셀 경로에 투입하기 위한
// 변환이다. 그래서 **파서 행과 형태가 같아야** 한다 — 어긋나면 사진과 파일이
// 다르게 저장된다(이 앱의 모바일 포크가 정확히 그렇게 갈라져 있었다).
//
// 그리고 읽지 못한 줄을 **조용히 버리지 않는다.** 통장 20줄 중 3줄이 사라지면
// 사용자는 알 수 없고, 잔액이 맞지 않는 이유도 찾을 수 없다.
// ─────────────────────────────────────────────────────────────
import { bankbookRowsToParsed } from '../public/domain/receipt.js';

test('통장 줄을 파서 행 형태로 바꾼다', () => {
  const { rows, skipped } = bankbookRowsToParsed({
    rows: [
      { dateRaw: '26.09.01', description: '급여', withdraw: '', deposit: '400,000', balance: '1,400,000' },
      { dateRaw: '26.09.03', description: '이마트', withdraw: '12,000', deposit: '', balance: '1,388,000' },
    ],
  }, { today: TODAY });

  assert.equal(skipped.length, 0);
  assert.deepEqual(rows, [
    { date: '2026-09-01', desc: '급여',   descRaw: '급여',   in: 400000, out: 0 },
    { date: '2026-09-03', desc: '이마트', descRaw: '이마트', in: 0, out: 12000 },
  ]);
});

test('행 형태가 엑셀 파서와 같다 — 키 이름이 어긋나면 저장이 갈라진다', () => {
  const { rows } = bankbookRowsToParsed({
    rows: [{ dateRaw: '2026-09-01', description: 'x', withdraw: '1,000', deposit: '', balance: '' }],
  }, { today: TODAY });
  // analyzeXlFile이 p.date · p.desc · p.descRaw · p.in · p.out 을 읽는다.
  assert.deepEqual(Object.keys(rows[0]).sort(), ['date', 'desc', 'descRaw', 'in', 'out']);
});

test('날짜를 못 읽은 줄은 이유와 함께 제외한다 — 조용히 사라지지 않는다', () => {
  const { rows, skipped } = bankbookRowsToParsed({
    rows: [
      { dateRaw: '', description: '알수없음', withdraw: '1,000', deposit: '', balance: '' },
      { dateRaw: '2026-09-01', description: 'ok', withdraw: '1,000', deposit: '', balance: '' },
    ],
  }, { today: TODAY });
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /날짜/);
  // 원문을 함께 담아 사용자가 무엇이 빠졌는지 알 수 있게 한다.
  assert.match(skipped[0].raw, /알수없음/);
});

test('금액이 없는 줄도 이유와 함께 제외한다', () => {
  const { rows, skipped } = bankbookRowsToParsed({
    rows: [
      { dateRaw: '2026-09-01', description: '이월', withdraw: '', deposit: '', balance: '1,000,000' },
      { dateRaw: '2026-09-02', description: 'ok', withdraw: '500', deposit: '', balance: '' },
    ],
  }, { today: TODAY });
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /금액/);
});

test('입금·출금 양쪽이 0이면 제외하지만 음수는 유효하다', () => {
  const { rows } = bankbookRowsToParsed({
    rows: [{ dateRaw: '2026-09-01', description: '환불', withdraw: '-5,000', deposit: '', balance: '' }],
  }, { today: TODAY });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].out, -5000);
});

test('빈 입력·잘못된 입력에도 깨지지 않는다', () => {
  for (const bad of [null, undefined, {}, { rows: null }, { rows: 'x' }, { rows: [] }]) {
    const r = bankbookRowsToParsed(bad, { today: TODAY });
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.skipped, []);
  }
  // 줄 자체가 null이어도
  const r2 = bankbookRowsToParsed({ rows: [null, undefined] }, { today: TODAY });
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.skipped.length, 2);
});

test('연도 없는 통장 날짜도 추론한다', () => {
  const { rows } = bankbookRowsToParsed({
    rows: [{ dateRaw: '09/01', description: 'x', withdraw: '1,000', deposit: '', balance: '' }],
  }, { today: TODAY });
  assert.equal(rows[0].date, '2026-09-01');
});
