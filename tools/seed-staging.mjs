#!/usr/bin/env node
/**
 * 스테이징/에뮬레이터 시드 — 테스트할 수 있는 상태를 한 번에 만든다.
 *
 * 이 앱은 빈 Firestore에서는 아무것도 확인할 수 없다. 역할별 권한, 결재 흐름,
 * 잔액 계산, 입력자 범위 제한 — 전부 데이터가 있어야 눌러볼 수 있다.
 * 이 스크립트가 그 데이터를 만든다.
 *
 * 만드는 것
 *   직원 4명 (센터장+관리자 / 팀장 / 담당자 / 입력자) — 비밀번호는 모두 아래 PASSWORD
 *   입주자 3명(1명은 담당자 미배정 — 범위 검증용) · 계좌 4개 · 기본 카테고리 · 자동분류 규칙 3개
 *   최근 2개월 거래 (자산이동 1쌍 · 취소 1건 · 입력자 작성분 포함)
 *   고정항목 1건 · 연간 예산 1건 · 보고서 3건(제출·팀장결재·최종결재)
 *
 * 안전장치
 *   - **프로덕션 프로젝트 ID면 무조건 거부한다.** 이 스크립트는 데이터를 덮어쓴다.
 *   - 기본은 드라이런. 실제 쓰기는 --apply.
 *
 * 사용법
 *   # 에뮬레이터 (Blaze 불필요)
 *   npm run emu            # 다른 터미널에서 띄워둔다
 *   npm run seed:emu -- --apply
 *
 *   # 실제 스테이징 프로젝트
 *   export GOOGLE_APPLICATION_CREDENTIALS=/경로/staging-serviceAccountKey.json
 *   node tools/seed-staging.mjs --apply
 *
 * 옵션
 *   --apply              실제로 쓴다 (없으면 무엇을 만들지만 출력)
 *   --project <id>       대상 프로젝트 (기본: smart-care-ledger-staging)
 *   --wipe               시드 대상 컬렉션을 먼저 비운다
 *   --password <pw>      테스트 계정 비밀번호 (기본: staging1234)
 */

import admin from 'firebase-admin';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { hashPassword } = require('../functions/password.js');
// 명부는 서버가 만드는 것과 **같은 함수**로 만든다. 시드가 따로 조립하면
// 형태가 어긋나도 여기서는 통과하고 배포 후에만 드러난다.
const {
  buildStaffDirectory, buildCategoryDirectory, DIRECTORIES,
} = require('../functions/directories.cjs');

// ── 인자 파싱 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };

const APPLY = has('--apply');
const WIPE = has('--wipe');
const PASSWORD = val('--password', process.env.SEED_PASSWORD || 'staging1234');
const PROJECT_ID = val('--project', process.env.SEED_PROJECT_ID || 'smart-care-ledger-staging');

/** 실데이터가 있는 프로젝트. 여기에는 절대 시드하지 않는다. */
const FORBIDDEN_PROJECTS = ['smart-care-ledger'];

const log = (...a) => console.log(...a);
const head = (t) => log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));

// ── 0. 안전 확인 ─────────────────────────────────────────────
if (FORBIDDEN_PROJECTS.includes(PROJECT_ID)) {
  console.error(`\n✖ '${PROJECT_ID}'는 프로덕션 프로젝트입니다. 시드는 스테이징/에뮬레이터 전용입니다.`);
  console.error('  --project 로 스테이징 프로젝트 ID를 지정하세요.\n');
  process.exit(1);
}

const usingEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

head('대상 확인');
log(`프로젝트 : ${PROJECT_ID}`);
log(`접속     : ${usingEmulator ? `에뮬레이터 (${process.env.FIRESTORE_EMULATOR_HOST})` : '실제 Firestore'}`);
log(`모드     : ${APPLY ? '적용 (--apply)' : '드라이런 — 아무것도 쓰지 않습니다'}`);
if (WIPE) log('비우기   : 시드 대상 컬렉션을 먼저 삭제합니다 (--wipe)');

// ── 1. 만들 데이터 ───────────────────────────────────────────
/** 기본 카테고리는 앱과 같은 목록을 쓴다 (constants.js가 유일한 출처) */
function defaultCategories() {
  const src = readFileSync(new URL('../public/constants.js', import.meta.url), 'utf8');
  const start = src.indexOf('export const DEFAULT_CATEGORIES = [');
  const end = src.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error('constants.js에서 DEFAULT_CATEGORIES를 찾지 못했습니다');
  const body = src.slice(src.indexOf('[', start), end + 1);
  // 객체 리터럴이므로 JSON.parse 대신 평가한다 (신뢰된 저장소 파일)
  return new Function(`return ${body}`)();
}

const USERS = [
  { userId: 'center', name: '김센터', role: '센터장', isAdmin: true,  team: '본부' },
  { userId: 'leader', name: '박팀장', role: '팀장',   isAdmin: false, team: '1팀' },
  { userId: 'staff',  name: '이담당', role: '담당자', isAdmin: false, team: '1팀' },
  { userId: 'typist', name: '최입력', role: '입력자', isAdmin: false, team: '1팀' },
];

const CLIENTS = [
  {
    id: 'cli_seed_1', name: '홍길동',
    userIds: 'staff,typist',        // ← 쉼표 구분 문자열 (앱이 쓰는 형식)
    teamLeader: 'leader',           // ← 로그인 아이디 = users 문서 ID
    contact: '010-0000-0001', memo: '시드 데이터', active: true,
  },
  {
    id: 'cli_seed_2', name: '김영희',
    userIds: 'staff',
    teamLeader: 'leader',
    contact: '010-0000-0002', memo: '시드 데이터', active: true,
  },
  {
    // 담당자가 배정되지 않은 입주자.
    //
    // 이 한 명이 있어야 **범위 검증이 가능하다.** 담당자에게 보이면 안 되는
    // 것이 하나도 없으면 "담당분만 조회한다"를 확인할 방법이 없다.
    // 담당자 화면에는 이 입주자와 그 보고서가 나오지 않아야 하고,
    // 팀장·센터장 화면에는 나와야 한다.
    id: 'cli_seed_3', name: '박철수',
    userIds: '',
    teamLeader: 'leader',
    contact: '010-0000-0003', memo: '담당자 미배정 (범위 검증용)', active: true,
  },
];

/** 기준일 잔액 — 기준일 **다음날부터**의 거래가 여기에 합산된다 */
const ACCOUNTS = [
  // 계좌 이름에 마크업을 심어 둔다.
  //
  // 이 이름은 보고서·설정·거래내역의 innerHTML 템플릿에 그대로 들어간다.
  // 이스케이프가 빠지면 브라우저가 태그로 해석해 화면에서 <b>가 사라지고,
  // 그 차이를 tools/qa-smoke.mjs가 잡는다. 실데이터에는 이런 이름이 없지만
  // 엑셀 업로드의 가맹점명 칸은 파일에서 오므로 같은 경로가 열려 있다.
  { id: 'acc_seed_1', clientId: 'cli_seed_1', label: '생활비 통장 <b>주입</b>', accountNumber: '123-456-7890',
    initialBalance: 500000, initialBalanceDate: baseDate(), bankStatements: [], active: true },
  { id: 'acc_seed_2', clientId: 'cli_seed_1', label: '저축 통장', accountNumber: '123-456-7891',
    initialBalance: 2000000, initialBalanceDate: baseDate(), bankStatements: [], active: true },
  { id: 'acc_seed_3', clientId: 'cli_seed_2', label: '생활비 통장', accountNumber: '987-654-3210',
    initialBalance: 300000, initialBalanceDate: baseDate(), bankStatements: [], active: true },
  { id: 'acc_seed_4', clientId: 'cli_seed_3', label: '생활비 통장', accountNumber: '555-123-4567',
    initialBalance: 250000, initialBalanceDate: baseDate(), bankStatements: [], active: true },
];

const RULES = [
  { keyword: '마트',   type: '지출', category: '생필품', subcategory: '', sortOrder: 100 },
  { keyword: '병원',   type: '지출', category: '의료비', subcategory: '', sortOrder: 101 },
  { keyword: '버스',   type: '지출', category: '교통비', subcategory: '', sortOrder: 102 },
];

/** 지지난달 1일 — 기초잔액 기준일 */
function baseDate() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 2);
  return iso(d);
}
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** n개월 전 달의 day일 */
function dayOf(monthsAgo, day) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(day);
  return iso(d);
}

function transactions() {
  const t = [];
  let order = 0;
  const add = (o) => t.push({
    id: `trx_seed_${String(++order).padStart(3, '0')}`,
    subcategory: '', receiptUrl: '', isFixed: false,
    amountIn: 0, amountOut: 0, sortOrder: order, createdBy: 'staff',
    ...o,
  });

  for (const monthsAgo of [1, 0]) {
    add({ clientId: 'cli_seed_1', accountId: 'acc_seed_1', date: dayOf(monthsAgo, 5),
          type: '수입', category: '수입', description: '장애인연금', amountIn: 400000 });
    add({ clientId: 'cli_seed_1', accountId: 'acc_seed_1', date: dayOf(monthsAgo, 7),
          type: '지출', category: '생필품', description: '○○마트', amountOut: 38500 });
    add({ clientId: 'cli_seed_1', accountId: 'acc_seed_1', date: dayOf(monthsAgo, 11),
          type: '지출', category: '의료비', description: '△△병원', amountOut: 12000 });
    add({ clientId: 'cli_seed_1', accountId: 'acc_seed_1', date: dayOf(monthsAgo, 12),
          type: '지출', category: '교통비', description: '시내버스', amountOut: 1500,
          createdBy: 'typist' });   // ← 입력자 작성분 (입력자 화면 범위 확인용)
    add({ clientId: 'cli_seed_2', accountId: 'acc_seed_3', date: dayOf(monthsAgo, 5),
          type: '수입', category: '수입', description: '기초생활수급비', amountIn: 620000 });
    add({ clientId: 'cli_seed_2', accountId: 'acc_seed_3', date: dayOf(monthsAgo, 9),
          type: '지출', category: '식비', description: '식자재 구입', amountOut: 74300 });
    // 담당자 미배정 입주자 — 담당자 화면에 나오면 안 된다
    add({ clientId: 'cli_seed_3', accountId: 'acc_seed_4', date: dayOf(monthsAgo, 5),
          type: '수입', category: '수입', description: '장애인연금', amountIn: 380000,
          createdBy: 'leader' });
    add({ clientId: 'cli_seed_3', accountId: 'acc_seed_4', date: dayOf(monthsAgo, 8),
          type: '지출', category: '식비', description: '반찬 구입', amountOut: 41000,
          createdBy: 'leader' });
  }

  // 환불 (음수 지출) — 잔액이 다시 늘어나는 경로
  add({ clientId: 'cli_seed_1', accountId: 'acc_seed_1', date: dayOf(0, 14),
        type: '지출', category: '생필품', description: '○○마트 반품', amountOut: -8500 });

  // 취소 — 집계·잔액 모두 제외되어야 한다
  add({ clientId: 'cli_seed_1', accountId: 'acc_seed_1', date: dayOf(0, 15),
        type: '취소', category: '취소', description: '카드 승인취소', amountOut: 25000 });

  // 자산이동 한 쌍 — 두 문서가 서로를 가리킨다 (한쪽만 남으면 안 된다)
  const outId = `trx_seed_out`;
  const inId = `trx_seed_in`;
  t.push({ id: outId, clientId: 'cli_seed_1', accountId: 'acc_seed_1', date: dayOf(0, 18),
           type: '자산이동', category: '자산이동', subcategory: '', description: '저축 통장으로 이체',
           amountIn: 0, amountOut: 100000, receiptUrl: '', isFixed: false, sortOrder: ++order,
           createdBy: 'staff', linkedAccountId: 'acc_seed_2', linkedTrxId: inId });
  t.push({ id: inId, clientId: 'cli_seed_1', accountId: 'acc_seed_2', date: dayOf(0, 18),
           type: '자산이동', category: '자산이동', subcategory: '', description: '생활비 통장에서 이체',
           amountIn: 100000, amountOut: 0, receiptUrl: '', isFixed: false, sortOrder: ++order,
           createdBy: 'staff', linkedAccountId: 'acc_seed_1', linkedTrxId: outId });

  return t;
}

const TRANSACTIONS = transactions();

const FIXED_ITEMS = [
  { id: 'fix_seed_1', clientId: 'cli_seed_1', accountId: 'acc_seed_1', type: '지출',
    day: 25, category: '세금공과', description: '휴대폰 요금', amount: 33000, isMandatory: true },
];

/**
 * 보고서 3건 — 입주자별 1건, 상태를 각각 다르게 둔다.
 *
 * 왜 필요한가
 *   보고서가 하나도 없으면 결재 대기 뱃지·결재 버튼·목록 범위를 전부
 *   빈 화면으로만 확인하게 된다. 특히 **cli_seed_3의 보고서**가 있어야
 *   "담당자는 담당분만 읽는다"를 검증할 수 있다 — 담당자 목록에 이것이
 *   나오면 범위가 새고 있는 것이다.
 *
 * 상태 배치
 *   cli_seed_1 submitted     → 팀장 결재 대기 (팀장 뱃지가 잡혀야 한다)
 *   cli_seed_2 team_approved → 센터장 결재 대기
 *   cli_seed_3 confirmed     → 마감. 담당자에게는 아예 보이지 않아야 하고,
 *                              마감 색인(config/lockedMonths)의 대상이기도 하다
 */
function reports() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const year = d.getFullYear(), month = d.getMonth() + 1;
  const at = new Date(year, month, 1).toISOString();
  const base = { year, month, summary: {}, createdAt: at,
                 staffComment: '시드 데이터', leaderComment: '', centerComment: '' };
  return [
    { id: `rpt_seed_1`, clientId: 'cli_seed_1', status: 'submitted', ...base,
      createdBy: 'staff', submittedAt: at, submittedBy: 'staff', submittedByName: '이담당' },
    { id: `rpt_seed_2`, clientId: 'cli_seed_2', status: 'team_approved', ...base,
      createdBy: 'staff', submittedAt: at, submittedBy: 'staff', submittedByName: '이담당',
      teamApprovedAt: at, teamApprovedBy: 'leader', teamApprovedByName: '박팀장' },
    { id: `rpt_seed_3`, clientId: 'cli_seed_3', status: 'confirmed', ...base,
      createdBy: 'leader', submittedAt: at, submittedBy: 'leader', submittedByName: '박팀장',
      teamApprovedAt: at, teamApprovedBy: 'leader', teamApprovedByName: '박팀장',
      centerApprovedAt: at, centerApprovedBy: 'center', centerApprovedByName: '김센터' },
  ];
}

const REPORTS = reports();

const BUDGETS = [
  { id: `cli_seed_1_${new Date().getFullYear()}`, clientId: 'cli_seed_1', year: new Date().getFullYear(),
    categoryBudgets: { 식비: 1200000, 생필품: 600000, 의료비: 300000, 교통비: 240000 } },
];

/**
 * 계좌의 현재 잔액 — Cloud Functions 트리거(syncAccountBalance)와 같은 규칙.
 * 시드는 트리거 없이(또는 트리거가 돌기 전에) 쓰므로 여기서 미리 계산해 둔다.
 * 기준일 **당일은 제외**한다 (기준일 잔액이 그날 마지막 거래 이후의 잔액이므로).
 */
function currentBalance(acc) {
  const base = acc.initialBalanceDate || '';
  return TRANSACTIONS.reduce((bal, t) => {
    if (t.accountId !== acc.id) return bal;
    if (base && String(t.date || '') <= base) return bal;
    if (t.type === '취소') return bal;
    return bal + Number(t.amountIn || 0) - Number(t.amountOut || 0);
  }, Number(acc.initialBalance || 0));
}

// ── 2. 요약 출력 ─────────────────────────────────────────────
const CATEGORIES = [...defaultCategories(), ...RULES];

head('만들 데이터');
log(`직원       ${USERS.length}명   ${USERS.map((u) => `${u.userId}(${u.role}${u.isAdmin ? '·관리자' : ''})`).join(' · ')}`);
log(`입주자     ${CLIENTS.length}명   ${CLIENTS.map((c) => c.name).join(' · ')}`);
log(`계좌       ${ACCOUNTS.length}개`);
for (const a of ACCOUNTS) {
  log(`   ${a.label.padEnd(12)} 기초 ${String(a.initialBalance).padStart(9)}원 (${a.initialBalanceDate}) → 현재 ${String(currentBalance(a)).padStart(9)}원`);
}
log(`카테고리   ${CATEGORIES.length}건 (기본 ${CATEGORIES.length - RULES.length} + 자동분류 규칙 ${RULES.length})`);
log(`거래       ${TRANSACTIONS.length}건 (자산이동 1쌍 · 취소 1 · 환불 1 · 입력자 작성 2)`);
log(`고정항목   ${FIXED_ITEMS.length}건 · 예산 ${BUDGETS.length}건`);

if (!APPLY) {
  head('드라이런 종료');
  log('실제로 만들려면 --apply 를 붙여 다시 실행하세요.\n');
  process.exit(0);
}

// ── 3. 쓰기 ──────────────────────────────────────────────────
// 접속은 여기서 시작한다 — 드라이런은 자격증명 없이도 돌아야 하므로.
// 에뮬레이터는 자격증명이 필요 없고, 실제 프로젝트는 서비스 계정 키가 있어야 한다.
if (!usingEmulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('\n✖ GOOGLE_APPLICATION_CREDENTIALS 가 설정되지 않았습니다.');
  console.error('  스테이징 프로젝트의 서비스 계정 키 경로를 지정하거나, 에뮬레이터를 쓰세요.\n');
  process.exit(1);
}

admin.initializeApp(
  usingEmulator
    ? { projectId: PROJECT_ID }
    : { projectId: PROJECT_ID, credential: admin.credential.applicationDefault() }
);
const db = admin.firestore();

const SEEDED_COLLECTIONS = ['users', 'userSecrets', 'clients', 'accounts', 'categories',
  'transactions', 'fixedItems', 'budgets', 'reports', 'excelUploads',
  // 파생 문서도 비운다. 남겨 두면 지워진 직원이 명부에 유령으로 남고,
  // 낡은 요약 캐시가 새 거래와 어긋난 금액을 보여준다.
  'directories', 'summaryCaches'];

async function wipe(name) {
  const snap = await db.collection(name).get();
  if (snap.empty) return 0;
  // 배치 500개 제한
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const d of snap.docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
  return snap.size;
}

/** 배치로 나눠 쓴다. docs: [{col, id, data}] */
async function writeAll(docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) {
      batch.set(db.collection(d.col).doc(d.id), d.data);
    }
    await batch.commit();
  }
}

if (WIPE) {
  head('기존 데이터 삭제');
  for (const c of SEEDED_COLLECTIONS) {
    const n = await wipe(c);
    log(`  ${c.padEnd(14)} ${n}건 삭제`);
  }
}

head('쓰는 중');

const docs = [];

for (const u of USERS) {
  const secret = await hashPassword(PASSWORD);
  docs.push({ col: 'users', id: u.userId, data: { ...u, approved: true, active: true } });
  docs.push({ col: 'userSecrets', id: u.userId, data: { ...secret, updatedAt: admin.firestore.FieldValue.serverTimestamp() } });
}
for (const c of CLIENTS) docs.push({ col: 'clients', id: c.id, data: c });
for (const a of ACCOUNTS) docs.push({ col: 'accounts', id: a.id, data: { ...a, currentBalance: currentBalance(a) } });
CATEGORIES.forEach((c, i) => docs.push({ col: 'categories', id: `cat_seed_${i}`, data: c }));
for (const t of TRANSACTIONS) {
  const { id, ...data } = t;
  docs.push({ col: 'transactions', id, data });
}
for (const f of FIXED_ITEMS) { const { id, ...data } = f; docs.push({ col: 'fixedItems', id, data }); }
for (const b of BUDGETS) { const { id, ...data } = b; docs.push({ col: 'budgets', id, data }); }
for (const r of REPORTS) { const { id, ...data } = r; docs.push({ col: 'reports', id, data }); }

// 파생 명부 — 실제 배포에서는 Cloud Functions 트리거가 만든다.
// 시드가 미리 넣어 두면 에뮬레이터에서도 "명부가 있는" 경로를 눌러볼 수 있다.
// (Functions 에뮬레이터가 뜨지 않는 환경이라 트리거를 기다릴 수 없다)
docs.push({
  col: 'directories', id: DIRECTORIES.STAFF,
  data: buildStaffDirectory(USERS.map((u) => ({ id: u.userId, data: u }))),
});
docs.push({
  col: 'directories', id: DIRECTORIES.CATEGORIES,
  data: buildCategoryDirectory(
    CATEGORIES.map((c, i) => ({ id: `cat_seed_${i}`, data: c }))),
});

await writeAll(docs);
log(`  문서 ${docs.length}건 기록 완료`);

// ── 4. 안내 ──────────────────────────────────────────────────
head('완료 — 이 계정으로 로그인하세요');
log(`비밀번호는 모두  ${PASSWORD}\n`);
for (const u of USERS) {
  log(`  ${u.userId.padEnd(8)} ${u.name}  ${u.role}${u.isAdmin ? ' · 관리자' : ''}`);
}
log('\n확인해 볼 것');
log('  · typist(입력자)로 로그인 → 담당 입주자 1명, 본인이 쓴 거래 2건만 보인다');
log('  · staff(담당자)로 로그인  → 입주자 2명만 보인다 (박철수는 담당 배정이 없다)');
log('  · leader(팀장)로 로그인   → 입주자 3명 · 결재 대기 1건 (홍길동 제출분)');
log('  · center(센터장)로 로그인 → 결재 대기 1건 (김영희 팀장결재분)');
log('  · 대시보드 · 보고서 · 설정 세 화면의 계좌 잔액이 같은지');
log('  · 계좌 "생활비 통장"의 자산이동 −100,000이 "저축 통장"에 +100,000으로 있는지\n');

process.exit(0);
