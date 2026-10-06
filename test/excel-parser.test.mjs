import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANK_CONFIGS,
  toNum, toNumSigned, fixDate, fixReadableDate, cleanDesc,
  detectConfig, parseSheetRows, decodeCsvBytes, isHtmlBytes, parseSmsBody,
} from '../public/services/excel-parser.js';

// ─────────────────────────────────────────────
// 금액 — 조용히 사라지던 행들
// ─────────────────────────────────────────────
test('회계식 괄호는 음수다', () => {
  // Number("(5,000)".replace(/[^0-9.-]/g,'')) === 5000 이었다 — 환불이 지출로 들어갔다
  assert.equal(toNumSigned('(5,000)'), -5000);
  assert.equal(toNumSigned('(12345)'), -12345);
});

test('후행 마이너스는 음수다', () => {
  // Number("12,345-") === NaN → 0 → "금액 없음"으로 행이 통째로 사라졌다
  assert.equal(toNumSigned('12,345-'), -12345);
  assert.equal(toNumSigned('5000 -'), -5000);
});

test('△·▲ 표기도 음수로 읽는다', () => {
  assert.equal(toNumSigned('△5,000'), -5000);
  assert.equal(toNumSigned('▲1,200'), -1200);
});

test('통화기호·단위·공백을 떼고 읽는다', () => {
  assert.equal(toNumSigned('₩12,300'), 12300);
  assert.equal(toNumSigned('12,300원'), 12300);
  assert.equal(toNumSigned(' 1,234 '), 1234);
  assert.equal(toNumSigned('-1,234'), -1234);
  assert.equal(toNumSigned('1234.5'), 1234.5);
});

test('빈 값은 0, 해석 불가는 NaN이다 (둘을 구별해야 한다)', () => {
  // 예전에는 둘 다 0이라 "금액 없음"과 "인식 실패"가 섞였고,
  // 인식 실패한 행이 아무 표시 없이 사라졌다.
  for (const empty of ['', null, undefined, '   ']) assert.equal(toNumSigned(empty), 0);
  for (const bad of ['이월', 'N/A', '1-2-3', '금액없음', '1.2.3']) {
    assert.ok(Number.isNaN(toNumSigned(bad)), `${bad}가 NaN이 아닙니다`);
  }
});

test('toNum은 절댓값이고 실패해도 0이다', () => {
  assert.equal(toNum('(5,000)'), 5000);
  assert.equal(toNum('-3,000'), 3000);
  assert.equal(toNum('이월'), 0);
});

test('숫자 타입도 그대로 받는다', () => {
  assert.equal(toNumSigned(5000), 5000);
  assert.equal(toNumSigned(-5000), -5000);
  assert.equal(toNumSigned(0), 0);
  assert.ok(Number.isNaN(toNumSigned(Infinity)));
});

// ─────────────────────────────────────────────
// 날짜
// ─────────────────────────────────────────────
test('여러 날짜 표기를 YYYY-MM-DD로 읽는다', () => {
  assert.equal(fixDate('2026-07-10'), '2026-07-10');
  assert.equal(fixDate('2026.07.10'), '2026-07-10');
  assert.equal(fixDate('2026/7/10'), '2026-07-10');
  assert.equal(fixDate('20260710'), '2026-07-10');
  assert.equal(fixDate('2026-07-10 15:20:33'), '2026-07-10');
  assert.equal(fixDate('2026-7-1'), '2026-07-01');
});

test('엑셀 날짜 일련번호를 읽는다', () => {
  // CSV/xlsx 파싱에서 '2026-07-10'이 46213 같은 숫자가 된다
  assert.equal(fixDate(46213), '2026-07-10');
  assert.equal(fixDate('46213'), '2026-07-10');
});

test('말이 안 되는 날짜는 거부한다', () => {
  for (const bad of ['', null, undefined, '합계', '1999-01-01', '2026-13-01', '2026-02-30', 'abc']) {
    assert.equal(fixDate(bad), null, `${bad}가 통과했습니다`);
  }
});

test('SMS readable_date를 읽는다', () => {
  assert.equal(fixReadableDate('2026. 7. 10. 오후 3:20'), '2026-07-10');
  assert.equal(fixReadableDate('1999. 1. 1.'), null);
  assert.equal(fixReadableDate(''), null);
});

// ─────────────────────────────────────────────
// 적요 정리 — 상호명 훼손
// ─────────────────────────────────────────────
test('노이즈 단어는 경계가 있을 때만 지운다', () => {
  // 예전에는 부분 문자열로 지워서 상호명이 훼손됐고 원본이 없어 복구 불가였다
  assert.equal(cleanDesc('승인마트'), '승인마트', '상호명이 잘렸습니다');
  assert.equal(cleanDesc('모바일세상'), '모바일세상', '상호명이 잘렸습니다');
  assert.equal(cleanDesc('체크카드 이마트'), '이마트');
  assert.equal(cleanDesc('일시불/GS25'), 'GS25');
});

test('전부 노이즈면 원본을 남긴다', () => {
  // 빈 적요가 되면 그 행이 "내용 없음"으로 사라진다
  assert.equal(cleanDesc('승인'), '승인');
  assert.equal(cleanDesc('체크카드'), '체크카드');
});

test('빈 적요는 빈 문자열', () => {
  assert.equal(cleanDesc(''), '');
  assert.equal(cleanDesc(null), '');
  assert.equal(cleanDesc('   '), '');
});

// ─────────────────────────────────────────────
// 은행 판정 — 설정에서 파생되어야 한다
// ─────────────────────────────────────────────
const HEADERS = {
  KB_BANK:    '거래일시|보낸분/받는분|출금액|입금액|잔액',
  KB_CARD:    '이용일|이용하신곳|국내이용금액',
  NH_BANK:    '거래일시|거래기록사항|출금금액|입금금액',
  NH_CARD_AP: '거래일자|가맹점명|거래금액|취소여부',
  NH_CARD:    '이용일자|가맹점명|이용금액',
  WOORI_BANK: '거래일시|기재내용|찾으신금액|맡기신금액',
  SH_BANK:    '거래일자|내용|출금(원)|입금(원)',
  MANUAL:     '날짜|내용|지출금액|입금금액',
};

test('설정에 있는 모든 은행이 자기 헤더로 판정된다', () => {
  for (const [key, header] of Object.entries(HEADERS)) {
    assert.equal(detectConfig(header), key, `${key} 판정 실패`);
  }
});

test('헤더 목록과 설정 목록이 일치한다', () => {
  // 설정에 은행을 추가하면 여기 헤더도 추가해야 판정이 검증된다
  assert.deepEqual(Object.keys(HEADERS).sort(), Object.keys(BANK_CONFIGS).sort());
});

test('알 수 없는 헤더는 판정하지 않는다', () => {
  assert.equal(detectConfig('이름|주소|전화번호'), '');
  assert.equal(detectConfig(''), '');
});

test('설정만 추가해도 새 은행이 인식된다 (파서 수정 불필요)', () => {
  // parser-config.js 상단의 "app.js는 건드릴 필요가 없습니다"가 거짓이었다.
  // 판정이 설정과 무관한 하드코딩 if/else 체인이라 설정에 추가해도 무시됐다.
  const custom = {
    ...BANK_CONFIGS,
    HANA_BANK: { DATE: '거래일시', DESC: '내용', WITHDRAW: '출금', DEPOSIT: '입금' },
  };
  assert.equal(detectConfig('거래일시|내용|출금|입금|잔액', custom), 'HANA_BANK');

  const rows = [
    ['거래일시', '내용', '출금', '입금', '잔액'],
    ['2026-07-10', '이마트', '12,000', '', '80,000'],
  ];
  const out = parseSheetRows(rows, [], { configs: custom });
  assert.equal(out.bank, 'HANA_BANK');
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].out, 12000);
});

// ─────────────────────────────────────────────
// 시트 파싱
// ─────────────────────────────────────────────
test('입출금 컬럼을 올바른 방향으로 읽는다', () => {
  const rows = [
    ['조회기간: 2026-07-01 ~ 2026-07-31'],
    ['거래일시', '보낸분/받는분', '출금액', '입금액', '잔액'],
    ['2026-07-01', '이마트', '12,000', '', '88,000'],
    ['2026-07-02', '생활비 입금', '', '300,000', '388,000'],
  ];
  const { rows: out, skipped } = parseSheetRows(rows);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].out, out[0].in], [12000, 0]);
  assert.deepEqual([out[1].out, out[1].in], [0, 300000]);
  assert.equal(skipped.length, 0);
});

test('음수 출금은 입금(환불)으로 뒤집는다', () => {
  const rows = [
    ['거래일시', '보낸분/받는분', '출금액', '입금액'],
    ['2026-07-03', '환불', '(5,000)', ''],
  ];
  const { rows: out } = parseSheetRows(rows);
  assert.equal(out.length, 1, '괄호 음수 행이 사라졌습니다');
  assert.equal(out[0].in, 5000);
  assert.equal(out[0].out, 0);
});

test('제외된 행을 이유와 함께 돌려준다', () => {
  // 예전에는 전부 조용히 continue돼서 절반이 사라져도 성공처럼 보였다
  const rows = [
    ['거래일시', '보낸분/받는분', '출금액', '입금액'],
    ['2026-07-01', '이마트', '12,000', ''],
    ['이월', '전월이월', '', ''],              // 날짜 인식 불가
    ['2026-07-02', '오류행', '금액없음', ''],   // 금액 인식 불가
    ['2026-07-03', '', '5,000', ''],           // 내용 없음
    ['2026-07-04', '소계', '99,000', ''],      // 요약 행
    ['2026-07-05', '잔액조회', '', ''],        // 금액 없음
  ];
  const { rows: out, skipped } = parseSheetRows(rows);
  assert.equal(out.length, 1);
  assert.equal(skipped.length, 5, '제외 행이 보고되지 않습니다');
  const reasons = skipped.map(s => s.reason);
  assert.ok(reasons.includes('날짜를 인식할 수 없음'));
  assert.ok(reasons.includes('금액을 인식할 수 없음'));
  assert.ok(reasons.includes('거래 내용이 비어 있음'));
  assert.ok(reasons.includes('요약 행(합계/소계)'));
  // 사용자가 어떤 행인지 찾을 수 있어야 한다
  for (const s of skipped) {
    assert.ok(s.row > 0, '행 번호가 없습니다');
    assert.ok(s.text.length > 0, '원문이 없습니다');
  }
});

test('완전히 빈 행은 제외 목록을 어지럽히지 않는다', () => {
  const rows = [
    ['거래일시', '보낸분/받는분', '출금액', '입금액'],
    ['2026-07-01', '이마트', '12,000', ''],
    ['', '', '', ''],
    ['', '', '', ''],
  ];
  const { rows: out, skipped } = parseSheetRows(rows);
  assert.equal(out.length, 1);
  assert.equal(skipped.length, 0);
});

test('SKIP_IF 컬럼에 값이 있으면 취소 건으로 제외한다', () => {
  const rows = [
    ['거래일자', '가맹점명', '거래금액', '취소여부'],
    ['2026-07-01', '이마트', '12,000', ''],
    ['2026-07-02', '편의점', '3,000', 'Y'],
  ];
  const { rows: out, skipped } = parseSheetRows(rows);
  assert.equal(out.length, 1);
  assert.equal(skipped[0].reason, '취소된 승인 건');
});

test('자동분류 규칙이 적용된다', () => {
  const cats = [{ keyword: '이마트', category: '식비', subcategory: '장보기' }];
  const rows = [
    ['거래일시', '보낸분/받는분', '출금액', '입금액'],
    ['2026-07-01', '체크카드 이마트', '12,000', ''],
    ['2026-07-02', '알수없는곳', '3,000', ''],
  ];
  const { rows: out } = parseSheetRows(rows, cats);
  assert.equal(out[0].cat, '식비');
  assert.equal(out[0].sub, '장보기');
  assert.equal(out[1].cat, '확인필요');
});

test('원문 적요를 함께 보관한다', () => {
  const rows = [
    ['거래일시', '보낸분/받는분', '출금액', '입금액'],
    ['2026-07-01', '체크카드 이마트', '12,000', ''],
  ];
  const { rows: out } = parseSheetRows(rows);
  assert.equal(out[0].desc, '이마트');
  assert.equal(out[0].descRaw, '체크카드 이마트', '원문이 없으면 훼손 여부를 확인할 수 없습니다');
});

test('헤더를 못 찾으면 빈 결과를 돌려준다 (예외를 던지지 않는다)', () => {
  const out = parseSheetRows([['이름', '주소'], ['홍길동', '서울']]);
  assert.deepEqual(out, { bank: '', rows: [], skipped: [] });
  assert.deepEqual(parseSheetRows([]), { bank: '', rows: [], skipped: [] });
  assert.deepEqual(parseSheetRows(null), { bank: '', rows: [], skipped: [] });
});

// ─────────────────────────────────────────────
// CSV 인코딩
// ─────────────────────────────────────────────
const eucKr = (bytes) => new Uint8Array(bytes);

test('EUC-KR CSV를 읽는다', () => {
  // 예전 코드는 TextDecoder가 fatal 없이는 예외를 안 던져서 catch가 죽은 코드였다.
  // 국내 은행 CSV 상당수가 EUC-KR인데 사용자는 "인식된 거래 데이터가 없습니다"만 봤다.
  const bytes = eucKr([0xC7, 0xD1, 0xB1, 0xB9, 0x2C, 0x31, 0x30, 0x30]);  // '한국,100'
  const { text, encoding } = decodeCsvBytes(bytes);
  assert.equal(encoding, 'euc-kr');
  assert.equal(text, '한국,100');
});

test('UTF-8 CSV를 읽는다', () => {
  const bytes = new TextEncoder().encode('한국,100');
  const { text, encoding } = decodeCsvBytes(bytes);
  assert.equal(encoding, 'utf-8');
  assert.equal(text, '한국,100');
});

test('UTF-8 BOM을 떼어낸다', () => {
  const body = new TextEncoder().encode('날짜,내용');
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...body]);
  const { text } = decodeCsvBytes(bytes);
  assert.equal(text, '날짜,내용', 'BOM이 남아 첫 헤더가 깨집니다');
});

test('ASCII는 어느 쪽으로 읽어도 같다', () => {
  const bytes = new TextEncoder().encode('date,amount\n2026-07-01,100');
  assert.equal(decodeCsvBytes(bytes).text, 'date,amount\n2026-07-01,100');
});

test('EUC-KR 파일이 실제로 파싱까지 이어진다', () => {
  // '날짜,내용,지출금액,입금금액\n2026-07-01,이마트,12000,'
  const src = '날짜,내용,지출금액,입금금액\n2026-07-01,이마트,12000,';
  // EUC-KR로 인코딩할 수단이 Node에 없으므로 알려진 바이트열로 직접 만든다
  const euckrBytes = [
    0xB3, 0xAF, 0xC2, 0xA5, 0x2C,                            // 날짜,
    0xB3, 0xBB, 0xBF, 0xEB, 0x2C,                            // 내용,
    0xC1, 0xF6, 0xC3, 0xE2, 0xB1, 0xDD, 0xBE, 0xD7, 0x2C,    // 지출금액,
    0xC0, 0xD4, 0xB1, 0xDD, 0xB1, 0xDD, 0xBE, 0xD7, 0x0A,    // 입금금액\n
    0x32, 0x30, 0x32, 0x36, 0x2D, 0x30, 0x37, 0x2D, 0x30, 0x31, 0x2C,   // 2026-07-01,
    0xC0, 0xCC, 0xB8, 0xB6, 0xC6, 0xAE, 0x2C,                // 이마트,
    0x31, 0x32, 0x30, 0x30, 0x30, 0x2C,                      // 12000,
  ];
  const { text, encoding } = decodeCsvBytes(eucKr(euckrBytes));
  assert.equal(encoding, 'euc-kr');
  assert.equal(text, src);

  const rows = text.split('\n').map(l => l.split(','));
  const out = parseSheetRows(rows);
  assert.equal(out.bank, 'MANUAL');
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].out, 12000);
});

test('HTML로 위장한 .xls를 알아본다', () => {
  assert.equal(isHtmlBytes(new Uint8Array([0x20, 0x0A, 0x3C, 0x68])), true);
  assert.equal(isHtmlBytes(new Uint8Array([0x50, 0x4B, 0x03, 0x04])), false);   // xlsx(zip)
  assert.equal(isHtmlBytes(new Uint8Array([])), false);
});

// ─────────────────────────────────────────────
// SMS
// ─────────────────────────────────────────────
test('NH카드 승인 문자를 읽는다', () => {
  const body = '[Web발신]\nNH카드승인\n홍길동님\n12,000원 일시불\n이마트';
  const r = parseSmsBody(body, '2026. 7. 10. 오후 3:20');
  assert.equal(r.date, '2026-07-10');
  assert.equal(r.out, 12000);
  assert.equal(r.desc, '이마트');
});

test('승인 문자가 아니거나 제외 키워드가 있으면 건너뛴다', () => {
  assert.equal(parseSmsBody('일반 문자입니다', '2026. 7. 10.'), null);
  assert.equal(parseSmsBody('NH카드 승인거절 12,000원\n이마트', '2026. 7. 10.'), null);
  assert.equal(parseSmsBody('NH카드\n금액없음\n이마트', '2026. 7. 10.'), null);
});
