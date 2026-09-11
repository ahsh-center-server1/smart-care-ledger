import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transactionKey } from '../public/services/excel-parser.js';

const src = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
/** 함수 본문만 잘라낸다 (다음 최상위 선언 전까지) */
function bodyOf(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start > 0, `${signature} 를 찾을 수 없습니다`);
  const rest = text.slice(start + signature.length);
  const nextTop = rest.search(/\n(export |function |const [A-Za-z_$]+\s*=\s*(async\s*)?\()/);
  return rest.slice(0, nextTop === -1 ? rest.length : nextTop);
}

// ─────────────────────────────────────────────
// 중복 판정 키
// ─────────────────────────────────────────────
test('같은 거래는 같은 키다', () => {
  const t = { date: '2026-07-01', accountId: 'a1', description: '이마트', amountIn: 0, amountOut: 5000 };
  assert.equal(transactionKey(t), transactionKey({ ...t }));
});

test('계좌가 다르면 다른 거래다', () => {
  // 예전 키에는 accountId가 없어 같은 입주자의 다른 계좌 동일 금액이 중복 처리됐다
  const base = { date: '2026-07-01', description: '이마트', amountIn: 0, amountOut: 5000 };
  assert.notEqual(transactionKey({ ...base, accountId: 'a1' }),
                  transactionKey({ ...base, accountId: 'a2' }));
});

test('내용이 다르면 다른 거래다', () => {
  // 같은 날 5,000원짜리 밥값과 간식값 중 두 번째가 삭제되던 문제
  const base = { date: '2026-07-01', accountId: 'a1', amountIn: 0, amountOut: 5000 };
  assert.notEqual(transactionKey({ ...base, description: '점심' }),
                  transactionKey({ ...base, description: '간식' }));
});

test('환불은 원거래의 중복이 아니다', () => {
  // Math.abs 때문에 환불(-5,000)이 원거래(5,000)의 중복으로 삭제됐다
  const base = { date: '2026-07-01', accountId: 'a1', description: '이마트' };
  assert.notEqual(transactionKey({ ...base, amountIn: 0, amountOut: 5000 }),
                  transactionKey({ ...base, amountIn: 5000, amountOut: 0 }));
  assert.notEqual(transactionKey({ ...base, amountIn: 0, amountOut: 5000 }),
                  transactionKey({ ...base, amountIn: 0, amountOut: -5000 }));
});

test('공백·누락 필드에도 키가 안정적이다', () => {
  assert.equal(transactionKey({ date: '2026-07-01', accountId: 'a1', description: ' 이마트 ', amountOut: 5000 }),
               transactionKey({ date: '2026-07-01', accountId: 'a1', description: '이마트', amountIn: 0, amountOut: 5000 }));
  assert.equal(typeof transactionKey({}), 'string');
});

test('구분자가 섞인 내용이 다른 거래와 충돌하지 않는다', () => {
  const a = { date: '2026-07-01', accountId: 'a1', description: 'A|~|b', amountOut: 1 };
  const b = { date: '2026-07-01', accountId: 'a1|~|A', description: 'b', amountOut: 1 };
  assert.notEqual(transactionKey(a), transactionKey(b));
});

// ─────────────────────────────────────────────
// 엑셀 업로드 — 중복 대조 대상
// ─────────────────────────────────────────────
test('중복 대조는 화면 캐시가 아니라 Firestore를 본다', () => {
  // S.transactions는 당월·활성 입주자뿐이라, 2월 명세서를 9월에 올리면
  // 중복 0건 → 같은 파일을 두 번 올려도 두 벌 들어갔다.
  const body = bodyOf(src('public/modules/modals.js'), 'async function fetchExistingForDup(');
  assert.ok(body.includes('getDocs'), '기존 거래를 Firestore에서 읽지 않습니다');
  assert.ok(/where\('accountId','==',accId\)/.test(body), '계좌로 좁히지 않습니다');
  assert.ok(!body.includes('S.transactions'), '아직 화면 캐시를 보고 있습니다');
});

test('저장 직전에 중복을 다시 확인한다', () => {
  // 분석 이후 계좌를 바꾸거나 동료가 같은 파일을 먼저 올릴 수 있다
  const body = bodyOf(src('public/modules/modals.js'), 'export async function saveExcelData(');
  assert.ok(body.includes('fetchExistingForDup'), '저장 시점 재확인이 없습니다');
  assert.ok(body.includes('batchAddDocs'), '한 건씩 addDoc하면 중간에 끊겼을 때 절반만 들어갑니다');
});

// ─────────────────────────────────────────────
// 자산이동 — 한쪽만 남는 상태 금지
// ─────────────────────────────────────────────
/**
 * 자산이동의 불변식은 **동작 테스트**로 옮겼다 — test/transfer.test.mjs.
 *
 * 저장이 서버로 갔기 때문이다(functions/transfer-fns.js). 브라우저 원문에서
 * `writeBatch` 나 `candidates.length>1` 을 찾던 검사들은 검사할 원문이 없다.
 *
 * 그리고 서버로 옮기면서 마지막 구멍도 닫혔다: 상대편을 찾는 조회가 배치
 * **밖에** 있어서, 두 사람이 같은 순간 각자의 거래를 자산이동으로 바꾸면
 * 둘 다 같은 상대편을 발견해 서로를 덮어썼다.
 */

test('자산이동을 다른 유형으로 바꾸는 것을 막는다', () => {
  // linkedTrxId가 남아 한쪽은 지출, 다른 쪽은 여전히 자산이동인 짝이 생겼다
  const text = src('public/modules/modals.js');
  assert.ok(/isEdit&&t\.type==='자산이동'&&t\.linkedTrxId/.test(text),
    '유형 변경 차단이 없습니다');
});

test('자산이동 연결 필드는 브라우저 일반 거래 저장 경로에서 쓰지 않는다', () => {
  const text = src('public/modules/modals.js');
  assert.ok(!/linkedAccountId:'',linkedTrxId:''/.test(text),
    '서버 전용 연결 필드를 브라우저 일반 거래 저장이 쓰고 있습니다');
});

test('연결 때문에 딸려오는 상대편도 결재 잠금을 확인한다', () => {
  // 예전에는 체크한 항목만 확인하고 뒤에 추가되는 linkedTrxId는 재확인하지 않아
  // 최종 결재 완료된 월의 거래가 삭제됐다.
  const body = bodyOf(src('public/modules/transactions.js'), 'function scheduleTrxDeletion(');
  assert.ok(body.includes('linkedOnly'), '딸려오는 상대편을 따로 모으지 않습니다');
  assert.ok(body.includes('isConfirmedLocked'), '상대편의 결재 잠금을 확인하지 않습니다');
});

// ─────────────────────────────────────────────
// 연도 마감 — 중단되어도 안전해야 한다
// ─────────────────────────────────────────────
/**
 * 마감의 불변식은 **동작 테스트**로 옮겼다 — test/archive.test.mjs.
 *
 * 마감이 서버로 갔기 때문이다(functions/archive-fns.js). 브라우저 원문에서
 * `batchSetDocs` 나 `S.allAccounts` 를 찾던 검사들은 이제 검사할 원문이 없다.
 * 그리고 원문 검사보다 동작 검사가 낫다 — "재시도해도 복제되지 않는다"는
 * 실제로 두 번 돌려 봐야 아는 것이다.
 *
 * 옮겨 간 것들(같은 이유, 같은 과거 버그):
 *   · 사본은 원본 문서 ID를 쓴다 — 재시도가 사본을 복제하지 않도록
 *   · 이력을 작업 전에 남긴다 — 중간에 끊기면 미마감으로 보여 삼중으로 쌓였다
 *   · 비활성 계좌도 전진시킨다 — 거래만 지워지고 잔액이 안 올라 1년치가 증발했다
 *   · 이미 전진한 계좌를 다시 더하지 않는다
 */

test('중단된 마감이 이력 화면에 드러난다', () => {
  const body = bodyOf(src('public/modules/settings.js'), 'export async function loadArchiveHistory(');
  assert.ok(body.includes("in_progress"), '중단 상태를 표시하지 않습니다');
});

// ─────────────────────────────────────────────
// 보안 규칙
// ─────────────────────────────────────────────
test('마감 이력은 센터장도 직접 쓸 수 없어야 한다', () => {
  // 사본·삭제·진행 기록은 runArchive 서버 작업만 원자적으로 쓴다.
  const rules = src('firestore.rules');
  // archive_YYYY '컬렉션' 규칙이 아니라 config 블록 안을 봐야 한다 —
  // 둘 다 같은 정규식을 담고 있어서 파일 전체를 훑으면 잘못된 쪽이 걸린다.
  const at = rules.indexOf('match /config/');
  assert.ok(at > 0, 'config 규칙을 찾을 수 없습니다');
  const block = rules.slice(at, rules.indexOf('\n    }', at)).replace(/\s+/g, ' ');
  // 등급 리터럴(atLeast(4))이 아니라 caps 로 판정한다 — 등급표는 서버가
  // 계산해 authz.caps 에 담고, 규칙은 그 불리언만 읽는다.
  assert.ok(/id\.matches\('archive_\[0-9\]\{4\}'\)\s*\?\s*false/.test(block),
    'config/archive_YYYY가 브라우저 쓰기에 열려 있습니다');
});

test('엑셀 중복 대조 쿼리에 필요한 복합 인덱스가 등록되어 있다', () => {
  // 인덱스가 없으면 쿼리가 실패하고 중복 판정이 통째로 죽는다
  const idx = JSON.parse(src('firestore.indexes.json'));
  const fields = idx.indexes
    .filter(i => i.collectionGroup === 'transactions')
    .map(i => i.fields.map(f => f.fieldPath).join(','));
  assert.ok(fields.includes('accountId,date'), 'transactions(accountId,date) 인덱스가 없습니다');
});

// ─────────────────────────────────────────────
// 파서 설정이 실제로 연결되어 있는가
// ─────────────────────────────────────────────
test('parser-config.js는 ES 모듈이고 파서가 실제로 import한다', () => {
  // 예전에는 classic script라 143줄 전체가 아무 효과가 없었다
  const cfg = src('public/parser-config.js');
  assert.ok(cfg.includes('export const BANK_CONFIGS'), 'ES 모듈이 아닙니다');
  assert.ok(!cfg.includes('window.ExcelParser'), 'window 병합 코드가 남아 있습니다');

  const parser = src('public/services/excel-parser.js');
  assert.ok(/from '\.\.\/parser-config\.js'/.test(parser), '파서가 설정을 import하지 않습니다');

  const html = src('public/index.html');
  assert.ok(!html.includes('parser-config.js'), 'index.html이 아직 classic script로 로드합니다');

  // 설정 복제본이 app.js에 남아 있으면 두 벌이 다시 갈라진다
  const app = src('public/app.js');
  assert.ok(!app.includes('_defaultConfig'), 'app.js에 설정 복제본이 남아 있습니다');
});

// ─────────────────────────────────────────────
// 리스너 누수 (7단계)
// ─────────────────────────────────────────────
test('드래그 리스너는 손을 뗄 때 문서에서 제거된다', () => {
  // 영수증·통장 미리보기가 열 때마다 document에 mousemove/mouseup을 두 개씩 붙이고
  // 닫기는 패널 엘리먼트만 지웠다. 50번 열면 살아 있는 핸들러 100개가
  // 이미 제거된 DOM을 붙잡고 있다.
  const body = bodyOf(src('public/utils/ui.js'), 'export function makeDraggable(');
  assert.ok(body.includes("removeEventListener('mousemove'"), 'mousemove를 제거하지 않습니다');
  assert.ok(body.includes("removeEventListener('mouseup'"), 'mouseup을 제거하지 않습니다');
});

test('떠 있는 패널은 모두 공용 드래그 헬퍼를 쓴다', () => {
  // 각자 구현하면 각자 누수한다
  for (const f of ['public/modules/modals.js', 'public/modules/report.js']) {
    const text = src(f);
    assert.ok(text.includes('makeDraggable('), `${f}가 공용 헬퍼를 쓰지 않습니다`);
    assert.ok(!/document\.addEventListener\('mousemove'/.test(text),
      `${f}에 문서 전역 mousemove가 직접 붙어 있습니다`);
  }
});

test('설정 탭 버튼은 중복 바인딩되지 않는다', () => {
  // loadSettings()가 부를 때마다 실행되므로 핸들러가 쌓인다
  const body = bodyOf(src('public/modules/settings.js'), 'export function initSettingsTabs(){');
  assert.ok(body.includes('dataset.bound'), '중복 바인딩 가드가 없습니다');
});

// ─────────────────────────────────────────────
// 읽기 비용 (7단계)
// ─────────────────────────────────────────────
test('결재할 때마다 보고서 목록 전체를 다시 읽지 않는다', () => {
  // 입주자 30명 × 36개월이면 클릭 한 번에 약 1,080문서였다. 바뀐 것은 한 건인데.
  const body = bodyOf(src('public/modules/report.js'), 'export async function applyReportTransition(');
  assert.ok(body.includes('patchReportCache'), '바뀐 한 건만 고치지 않습니다');
  assert.ok(!/\bloadReportList\(/.test(body), '전이 뒤에 목록 전체를 다시 읽습니다');
});

test('보고서 목록은 캐시가 있으면 다시 읽지 않는다', () => {
  const body = bodyOf(src('public/modules/report.js'), 'export async function loadReportList(');
  assert.ok(/force/.test(body), '강제 재조회 구분이 없습니다');
  assert.ok(body.includes('S.reportList'), '캐시를 쓰지 않습니다');
});

test('결재 완료 월 잠금을 연도 제한된 목록에서 다시 만들지 않는다', () => {
  // 목록은 최근 연도만 담는다. 그것으로 confirmedMonths를 통째로 만들면
  // 예전 연도의 잠금이 전부 풀려 결재 끝난 달이 다시 편집 가능해진다.
  const text = src('public/modules/report.js');
  assert.ok(!/S\.confirmedMonths\s*=\s*new Set\(\s*list/.test(text),
    '목록에서 confirmedMonths를 통째로 다시 만들고 있습니다');
});

test('보고서 거래 캐시가 거래내역 탭 캐시를 덮어쓰지 않는다', () => {
  // 보고서를 한 번 열면 거래내역 탭의 조회 범위가 조용히 'all'로 바뀌고
  // 데이터가 다른 입주자 것으로 교체됐다.
  const body = bodyOf(src('public/modules/report.js'), 'async function getClientTrxAll(');
  // 비교(===)가 아니라 **대입**만 잡는다
  assert.ok(!/S\.transactions\s*=(?!=)/.test(body), '아직 거래내역 탭 캐시에 씁니다');
  assert.ok(!/S\.trxRange\s*=(?!=)/.test(body), '아직 거래내역 탭 조회 범위를 바꿉니다');
  assert.ok(!/S\.activeClient\s*=(?!=)/.test(body), '아직 거래내역 탭의 선택 입주자를 바꿉니다');
  assert.ok(body.includes('S.rptTrxCache'), '보고서 전용 캐시가 없습니다');
});

test('거래 조회에 재진입 가드가 있다', () => {
  // 입주자를 빠르게 두 번 바꾸면 늦게 끝난 응답이 이겼다
  const body = bodyOf(src('public/modules/core.js'), 'export async function loadTransactions(');
  assert.ok(body.includes('trxLoadSeq'), '재진입 가드가 없습니다');
  assert.ok(/mySeq\s*!==\s*trxLoadSeq/.test(body), '오래된 응답을 버리지 않습니다');
});

// ─────────────────────────────────────────────
// 배포 위생
// ─────────────────────────────────────────────
test('HTML·JS에 캐시 무효화 헤더가 있다', () => {
  // 없으면 배포 후 최대 1시간 동안 새 HTML과 낡은 모듈 JS가 섞인다
  const cfg = JSON.parse(src('firebase.json'));
  const headers = cfg.hosting.headers || [];
  const has = (src_) => headers.some(h => h.source === src_
    && h.headers.some(x => x.key === 'Cache-Control' && /no-cache/.test(x.value)));
  assert.ok(has('**/*.js'), 'JS에 no-cache가 없습니다');
  assert.ok(has('/index.html'), 'index.html에 no-cache가 없습니다');
  assert.ok(has('/sw.js'), '서비스 워커에 no-cache가 없습니다');
});

test('lint은 문법 검사가 아니라 ESLint다', () => {
  const pkg = JSON.parse(src('package.json'));
  assert.match(pkg.scripts.lint, /eslint/, 'lint가 여전히 문법 검사입니다');
  assert.ok(pkg.devDependencies?.eslint, 'eslint가 devDependency에 없습니다');
});

test('쓰이지 않는 Firestore 래퍼가 되살아나지 않는다', () => {
  // 범용 CRUD 6개 + 컬렉션별 24개, 모두 호출부가 0건이었다
  const text = src('public/services/firestore.js');
  for (const dead of ['function getAll(', 'function fetchUsers(', 'function saveTransaction(']) {
    assert.ok(!text.includes(dead), `${dead} 가 다시 생겼습니다`);
  }
});
