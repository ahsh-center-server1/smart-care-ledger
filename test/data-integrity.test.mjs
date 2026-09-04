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
test('자산이동은 양쪽 다리를 한 배치로 쓴다', () => {
  // 예전에는 addDoc → addDoc → updateDoc 3회 연속 쓰기라, 두 번째에서 끊기면
  // 출금만 남고 입금이 없었다 — 장부에서 돈이 증발한다.
  const body = bodyOf(src('public/modules/modals.js'), 'async function saveTransfer(');
  assert.ok(body.includes('writeBatch'), '배치로 쓰지 않습니다');
  assert.ok(!body.includes('addDoc('), '개별 addDoc이 남아 있습니다');
  const commits = (body.match(/batch\.commit\(\)/g) || []).length;
  assert.ok(commits >= 1, 'commit이 없습니다');
});

test('상대편이 없으면 자산이동을 반쪽으로 저장하지 않는다', () => {
  // 예전에는 상대편을 못 찾으면 토스트만 띄우고 그대로 '자산이동'으로 저장했다.
  // 상대편 탐색이 S.transactions만 훑었으므로 이게 사실상 기본 동작이었다.
  const body = bodyOf(src('public/modules/modals.js'), 'async function saveTransfer(');
  assert.ok(body.includes('candidates.length>1'), '후보가 여럿일 때 처리가 없습니다');
  assert.ok(/throw new Error/.test(body), '모호할 때 저장을 막지 않습니다');
  // 후보 0건이면 상대편을 만든다
  assert.ok(body.includes('batch.set(inRef'), '상대편을 만드는 경로가 없습니다');
  assert.ok(body.includes('getDocs'), '상대편을 Firestore에서 찾지 않습니다');
});

test('자산이동을 다른 유형으로 바꾸는 것을 막는다', () => {
  // linkedTrxId가 남아 한쪽은 지출, 다른 쪽은 여전히 자산이동인 짝이 생겼다
  const text = src('public/modules/modals.js');
  assert.ok(/isEdit&&t\.type==='자산이동'&&t\.linkedTrxId/.test(text),
    '유형 변경 차단이 없습니다');
});

test('자산이동이 아닌 거래에는 연결 정보를 남기지 않는다', () => {
  const text = src('public/modules/modals.js');
  assert.ok(/linkedAccountId:'',linkedTrxId:''/.test(text),
    '일반 거래 저장 시 연결 필드를 비우지 않습니다');
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
test('마감 사본은 원본 문서 ID를 쓴다 (재시도가 복제하지 않도록)', () => {
  const body = bodyOf(src('public/modules/settings.js'), 'export async function executeArchive(');
  assert.ok(body.includes('batchSetDocs'), '결정적 ID로 저장하지 않습니다');
  assert.ok(!body.includes('batchAddDocs'), 'batchAddDocs는 재시도 시 사본을 복제합니다');
  assert.ok(/docId:t\.id/.test(body), '원본 ID를 사본 ID로 쓰지 않습니다');
});

test('마감 이력을 작업 전에 남긴다', () => {
  // 예전에는 마지막에 남겨서, 중간에 끊기면 화면상 미마감으로 보이고
  // 다시 누르면 거래가 삼중으로 쌓였다.
  const body = bodyOf(src('public/modules/settings.js'), 'export async function executeArchive(');
  const logAt = body.indexOf("status:'in_progress'");
  const copyAt = body.indexOf('batchSetDocs');
  const deleteAt = body.indexOf('batchDeleteDocs');
  assert.ok(logAt > 0, 'in_progress 이력이 없습니다');
  assert.ok(logAt < copyAt && logAt < deleteAt, '이력이 작업보다 뒤에 있습니다');
  assert.ok(body.includes("status:'done'"), '완료 표시가 없습니다');
});

test('마감은 비활성 계좌도 전진시킨다', () => {
  // S.accounts는 활성 계좌만 담는다. 예전에는 비활성 계좌의 거래만 삭제되고
  // 기초잔액은 전진하지 않아 1년치가 영구 증발했다.
  const body = bodyOf(src('public/modules/settings.js'), 'export async function executeArchive(');
  assert.ok(body.includes('S.allAccounts'), '전 계좌를 보지 않습니다');
});

test('마감은 이미 전진한 계좌를 다시 더하지 않는다', () => {
  const body = bodyOf(src('public/modules/settings.js'), 'export async function executeArchive(');
  assert.ok(/already\s*=\s*String\(acc\.initialBalanceDate/.test(body),
    '이중 전진 방지 검사가 없습니다');
});

test('중단된 마감이 이력 화면에 드러난다', () => {
  const body = bodyOf(src('public/modules/settings.js'), 'export async function loadArchiveHistory(');
  assert.ok(body.includes("in_progress"), '중단 상태를 표시하지 않습니다');
});

// ─────────────────────────────────────────────
// 보안 규칙
// ─────────────────────────────────────────────
test('마감 이력은 센터장도 쓸 수 있어야 한다', () => {
  // config 쓰기가 관리자 전용이면 센터장이 마감을 시작하는 순간 거부된다
  const rules = src('firestore.rules');
  // archive_YYYY '컬렉션' 규칙이 아니라 config 블록 안을 봐야 한다 —
  // 둘 다 같은 정규식을 담고 있어서 파일 전체를 훑으면 잘못된 쪽이 걸린다.
  const at = rules.indexOf('match /config/');
  assert.ok(at > 0, 'config 규칙을 찾을 수 없습니다');
  const block = rules.slice(at, rules.indexOf('\n    }', at)).replace(/\s+/g, ' ');
  assert.ok(/id\.matches\('archive_\[0-9\]\{4\}'\) && atLeast\(4\)/.test(block),
    'config/archive_YYYY 예외가 없습니다 — 센터장이 마감을 시작하는 순간 거부됩니다');
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
