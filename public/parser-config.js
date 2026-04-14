/**
 * Smart Care Ledger — 파서 설정 파일 v1.0
 *
 * 새 은행/카드사 추가 방법:
 * 1. 아래 BANK_CONFIGS 객체에 새 항목을 추가합니다.
 * 2. app.js는 건드릴 필요가 없습니다.
 *
 * 각 항목 설명:
 *   DATE     : 날짜 컬럼 헤더 텍스트 (필수)
 *   DESC     : 거래내용/가맹점명 컬럼 헤더 텍스트 (필수)
 *   WITHDRAW : 출금 컬럼 헤더 텍스트 (은행 계좌용)
 *   DEPOSIT  : 입금 컬럼 헤더 텍스트 (은행 계좌용)
 *   AMT      : 이용금액 컬럼 헤더 텍스트 (카드용, 출금만 있는 경우)
 *
 * 추가 예시:
 *   HANA_BANK: { DATE:'거래일시', DESC:'내용', WITHDRAW:'출금', DEPOSIT:'입금' },
 *   IBK_BANK:  { DATE:'거래일',   DESC:'적요', WITHDRAW:'출금금액', DEPOSIT:'입금금액' },
 */

const BANK_CONFIGS = {
  // ── KB국민은행 ──
  KB_BANK: {
    DATE:     '거래일시',
    DESC:     '보낸분/받는분',
    WITHDRAW: '출금액',
    DEPOSIT:  '입금액',
  },

  // ── KB국민카드 ──
  KB_CARD: {
    DATE: '이용일',
    DESC: '이용하신곳',
    AMT:  '국내이용금액',
  },

  // ── NH농협은행 ──
  NH_BANK: {
    DATE:     '거래일시',
    DESC:     '거래기록사항',
    WITHDRAW: '출금금액',
    DEPOSIT:  '입금금액',
  },

  // ── NH농협카드 (일반) ──
  NH_CARD: {
    DATE: '이용일자',
    DESC: '가맹점명',
    AMT:  '이용금액',
  },

  // ── NH농협카드 (국내승인내역) ──
  NH_CARD_AP: {
    DATE: '거래일자',
    DESC: '가맹점명',
    AMT:  '거래금액',
  },

  // ── 우리은행 ──
  WOORI_BANK: {
    DATE:     '거래일시',
    DESC:     '기재내용',
    WITHDRAW: '찾으신금액',
    DEPOSIT:  '맡기신금액',
  },

  // ── 신한은행 ──
  SH_BANK: {
    DATE:     '거래일자',
    DESC:     '내용',
    WITHDRAW: '출금(원)',
    DEPOSIT:  '입금(원)',
  },

  // ── 수기 입력 양식 (MANUAL) ──
  // 은행 파일 없을 때: 직접 작성한 CSV/Excel 업로드용
  // 컬럼: 날짜, 내용, 지출금액, 입금금액
  MANUAL: {
    DATE:     '날짜',
    DESC:     '내용',
    WITHDRAW: '지출금액',
    DEPOSIT:  '입금금액',
  },

  // ────────────────────────────────────────────────────────────
  // 새 은행/카드사 추가 시 아래에 계속 추가하세요
  // ────────────────────────────────────────────────────────────

  // 예시: 하나은행
  // HANA_BANK: {
  //   DATE:     '거래일시',
  //   DESC:     '내용',
  //   WITHDRAW: '출금',
  //   DEPOSIT:  '입금',
  // },

  // 예시: IBK기업은행
  // IBK_BANK: {
  //   DATE:     '거래일',
  //   DESC:     '적요',
  //   WITHDRAW: '출금금액',
  //   DEPOSIT:  '입금금액',
  // },

  // 예시: 케이뱅크
  // KBANK: {
  //   DATE:     '거래일시',
  //   DESC:     '거래메모',
  //   WITHDRAW: '출금',
  //   DEPOSIT:  '입금',
  // },
};

/**
 * 노이즈 단어 목록
 * 가맹점명/내용에서 제거할 의미없는 단어들
 * 새 단어 추가 시 배열에 문자열만 추가하면 됩니다.
 */
const PARSER_NOISE_WORDS = [
  '체크카드', 'CD공동', '전자금융', '장기카드', '단기카드', '일시불', '승인',
  '비씨', 'BC', 'NH체크', 'KB체크', '예금인출', '체크우리', '우리체크',
  '타행CD', 'CD이체', '모바일', '신한체', '현금IC', '체크신한',
];

/**
 * SMS 설정 (NH농협카드 SMS 백업 XML)
 * 다른 카드사 SMS 형식 추가 시 여기에 추가
 */
const SMS_CONFIG = {
  APPROVAL_KEYWORD: 'NH카드',
  SKIP_KEYWORDS:    ['승인거절', '인증번호', '재충전', '카드사용알림', '패스워드'],
};

// ─────────────────────────────────────────────
// 자동 병합 — app.js의 ExcelParser에 추가 설정 반영
// (이 파일이 app.js보다 먼저 로드되어도 나중에 로드되어도 모두 안전)
// ─────────────────────────────────────────────
(function applyParserConfig() {
  // ExcelParser가 이미 로드된 경우 즉시 적용
  if (window.ExcelParser && window.ExcelParser._defaultConfig) {
    Object.assign(window.ExcelParser._defaultConfig, BANK_CONFIGS);
  }
  // ExcelParser가 아직 로드 안 된 경우 window.BANK_CONFIGS에 저장해두면
  // ExcelParser.CONFIG getter가 자동으로 병합함 (이미 구현됨)
})();