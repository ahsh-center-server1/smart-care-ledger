#!/usr/bin/env node
/**
 * tools/read-budget.mjs — Firestore 일일 읽기 예산을 모델링한다.
 *
 * 왜 필요한가
 *   "읽기를 줄였다"는 주장은 숫자 없이는 확인할 수 없다. 그리고 이 앱에서
 *   비용을 결정하는 것은 **한 동작의 읽기 수가 아니라 그것 × 인원 × 세션 수**다.
 *   동작 하나만 세면 통과해도 일일 한도를 넘길 수 있다(false-safe).
 *
 *   그래서 화면별 읽기 수를 **소스에서 세어** 역할별 인원과 하루 콜드 세션
 *   수를 곱한다. 실제 Firestore에 접속하지 않으므로 이 스크립트를 돌리는
 *   것 자체가 읽기를 쓰지 않는다.
 *
 * 한계 (정직하게)
 *   · 컬렉션 문서 수는 인자로 받는다(실측이 아니다). 모르면 기본값을 쓴다.
 *   · 영속 캐시 적중은 반영하지 않는다 — **캐시가 없을 때의 상한**을 낸다.
 *     실제 값은 이보다 낮다. 상한으로 판단하는 것이 안전하다.
 *
 * 사용
 *   node tools/read-budget.mjs
 *   node tools/read-budget.mjs --staff=20 --clients=40 --sessions=3
 *   node tools/read-budget.mjs --json
 */

import { readFileSync } from 'node:fs';

const FREE_TIER_DAILY_READS = 50_000;
/** 한도를 안 넘어도 여유가 없으면 경고한다 — 하루 편차와 재연결 여지. */
const WARN_THRESHOLD = 35_000;

// ── 인자 ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const num = (name, def) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const JSON_OUT = argv.includes('--json');

const cfg = {
  // 인원 — 센터장과 관리자를 나눈다.
  //
  // 예전에는 둘을 `admins` 로 묶고 「관리자·센터장」으로 찍었는데, 읽기로는
  // **정반대**다. 센터장만 client.view.all 을 갖고, 관리자는 역할이 비어 있어
  // myScope() 가 빈 목록을 준다 — 관리자는 입주자를 하나도 읽지 않는다.
  centers:  num('centers', 1),
  admins:   num('admins', 1),
  leaders:  num('leaders', 3),
  staff:    num('staff', 12),
  typists:  num('typists', 8),
  // 데이터 규모
  clients:  num('clients', 30),
  accounts: num('accounts', 60),
  users:    num('users', 25),
  categories: num('categories', 60),
  fixedItems: num('fixedItems', 40),
  // 담당 입주자 1인당 (담당자·입력자)
  clientsPerStaff: num('clientsPerStaff', 4),
  // 팀장 한 사람이 보는 입주자 수. 팀장도 **전체를 읽지 않는다** —
  // myScope() 가 leaderClientIds 로 좁힌다. 생략하면 입주자÷팀장.
  clientsPerLeader: num('clientsPerLeader', 0),
  // 입주자 1명의 당월 거래 수
  trxPerClientMonth: num('trxPerClientMonth', 40),
  // 보고서 문서 수 (열람 기간)
  reports: num('reports', 200),
  // 1인당 하루 콜드 세션 수 (탭을 새로 열거나 30분 넘게 끊긴 경우)
  sessions: num('sessions', 2),
  // 세션당 입주자 전환 횟수 (거래내역을 몇 명 열어보는가)
  clientSwitchesPerSession: num('clientSwitchesPerSession', 3),
  // 대시보드 진입 시점에 요약 캐시가 낡아 있는 (입주자, 월)의 비율.
  //
  // 캐시는 그 입주자의 당월 거래가 바뀔 때만 무효화된다. 하루 종일 아무도
  // 손대지 않은 입주자는 계속 1 읽기다. 0.3은 "세션마다 담당 입주자 중
  // 3할은 누군가 방금 건드렸다"는 보수적인 가정이다 — 실제로는 더 낮다.
  staleRatio: num('staleRatio', 0.3),
};

// ── 화면별 읽기 수 ────────────────────────────────────────────
/**
 * 로그인 1회(콜드 세션)의 읽기 수.
 *
 * core.js fetchBaseData가 실제로 무엇을 읽는지에 맞춘다. 코드가 바뀌면
 * 이 모델도 바뀌어야 하므로, 아래 assertSourceShape()가 소스를 확인한다.
 */
/**
 * 이 역할이 로그인 때 보는 입주자 수.
 *
 * **규칙이 아니라 myScope() 가 정한다**(core.js). 넓게 물으면 규칙이 쿼리를
 * 통째로 거부하므로, 앱은 담당 목록으로 나눠 묻는다(services/scoped-fetch.js).
 * 그래서 읽기는 전 입주자가 아니라 **그 사람이 보는 수**만큼이다.
 */
function visibleClients(role) {
  if (role === 'center') return cfg.clients;                  // client.view.all
  if (role === 'admin') return 0;                             // 역할이 비어 범위가 없다
  if (role === 'leader') {
    return cfg.clientsPerLeader
      || Math.ceil(cfg.clients / Math.max(1, cfg.leaders));
  }
  return Math.min(cfg.clientsPerStaff, cfg.clients);
}

/**
 * 이 역할이 당월 집계를 읽는가.
 *
 * 카드의 「당월 수입/지출·미분류·고정항목」은 **장부를 쓰는 사람**이 오늘 무엇을
 * 더 해야 하는지 보는 숫자다. 팀장·센터장은 거래를 입력하지 않으므로
 * (trx.create 를 갖지 않는다) 읽지 않는다 — core.js 가 그렇게 막는다.
 *
 * 읽기로는 이것이 센터장 한 세션에서 가장 큰 항목이었다: 전 입주자의 요약 캐시
 * + 낡은 것의 재계산이라, 입주자가 늘면 그대로 늘어난다.
 */
function readsMonthlyStats(role) {
  return role === 'staff' || role === 'typist';
}

function loginReads(role) {
  const mine = visibleClients(role);
  const perClientAccounts = cfg.clients > 0 ? cfg.accounts / cfg.clients : 0;
  let r = 0;

  // 직원·분류는 파생 명부 문서 1건씩 (예전에는 컬렉션 전체 = users+categories)
  r += 1;                 // directories/staff
  r += 1;                 // directories/categories
  // 입주자·계좌는 아직 컬렉션 전체다 — 앱이 모든 필드를 쓰고(설정 화면이 편집한다),
  // accounts.bankStatements가 해마다 늘어 한 문서에 담으면 1 MiB 한도에 부딪힌다.
  r += mine;
  r += Math.ceil(mine * perClientAccounts);
  r += 1;                 // config/lockedMonths (문서 1건 — 예전에는 reports 쿼리였다)
  r += 1;                 // config/permissions

  // 당월 집계 — 요약 캐시 문서를 읽는다. **거래를 쓰는 역할만.**
  //
  // 예전에는 담당 입주자 전원의 당월 거래를 전부 읽어 합산했다
  // (입주자 1명당 trxPerClientMonth건). 이제 입주자 1명당 **문서 1건**이고,
  // 캐시가 낡은 입주자만 예전 비용을 낸다.
  if (readsMonthlyStats(role)) {
    r += mine;                                                   // 캐시 조회
    r += Math.ceil(mine * cfg.staleRatio) * cfg.trxPerClientMonth; // 낡은 것만 재계산
    // 고정항목도 담당 범위로 좁혀 읽는다(myScope('clientId')).
    r += cfg.clients > 0 ? Math.ceil(cfg.fixedItems * (mine / cfg.clients)) : 0;
  }

  return r;
}

/** 입주자 하나의 거래내역을 여는 읽기 수(당월 기준). */
function historyReads() {
  return cfg.trxPerClientMonth;
}

/**
 * 보고서 탭 진입 — 목록 조회.
 *
 * 팀장·센터장(report.view.all)은 결재 대기가 담당 배정과 무관하게 올라오므로
 * 전체를 읽는다. 담당자는 담당 입주자의 것만 읽는다 — 예전에는 담당 4명인
 * 담당자도 전 입주자의 보고서를 다 읽었고, 그것이 담당자 한 세션에서
 * 가장 큰 항목이었다.
 */
function reportListReads(role) {
  // report.view.all 은 **센터장만** 갖는다. 팀장은 결재 대기도 담당 범위로
  // 좁혀 읽는다 — 예전 모델은 팀장을 관리자와 묶어 전체를 읽는다고 봤다.
  if (role === 'center') return cfg.reports;
  const share = cfg.clients > 0 ? visibleClients(role) / cfg.clients : 0;
  return Math.ceil(cfg.reports * share);
}

/** 결재 대기 뱃지 — status in [...] 쿼리. */
function pendingBadgeReads() {
  return 10;   // 대기 중인 보고서 수 정도
}

// ── 합산 ──────────────────────────────────────────────────────
const ROLES = [
  { key: 'center', label: '센터장',  count: cfg.centers, report: true },
  { key: 'admin',  label: '관리자',  count: cfg.admins,  report: false },
  { key: 'leader', label: '팀장',    count: cfg.leaders, report: true },
  { key: 'staff',  label: '담당자',  count: cfg.staff,   report: true },
  { key: 'typist', label: '입력자',  count: cfg.typists, report: false },
];

const rows = [];
let total = 0;

for (const r of ROLES) {
  if (!r.count) continue;
  // 볼 입주자가 없으면 거래내역 전환도 일어나지 않는다(관리자).
  const switches = visibleClients(r.key) > 0 ? cfg.clientSwitchesPerSession : 0;
  const perSession = loginReads(r.key)
    + historyReads() * switches
    + (r.report ? reportListReads(r.key) + pendingBadgeReads() : 0);
  const daily = perSession * cfg.sessions * r.count;
  rows.push({ ...r, perSession, daily });
  total += daily;
}

// ── 모델이 소스와 어긋나지 않는지 확인 ────────────────────────
/**
 * 이 모델은 core.js가 무엇을 읽는지 가정한다. 코드가 바뀌면 모델이 거짓이 된다.
 * 확인할 수 있는 몇 가지를 소스에서 직접 본다.
 */
function assertSourceShape() {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const core = read('../public/modules/core.js');
  const problems = [];

  // 마감 월을 문서 1건으로 읽는가 (예전에는 reports 쿼리였다)
  if (!/LOCKED_MONTHS_DOC/.test(core)) {
    problems.push('core.js가 config/lockedMonths를 읽지 않습니다 — '
      + '이 모델은 그것을 1 읽기로 가정합니다');
  }

  // 대시보드 당월 집계가 요약 캐시를 거치는가.
  // 이것이 이 모델에서 가장 큰 항목이므로, 직접 조회로 되돌아가면
  // 예산이 조용히 두 배가 된다.
  if (!/fetchMonthlySummaries/.test(core)) {
    problems.push('core.js가 요약 캐시를 쓰지 않습니다 — '
      + '이 모델은 입주자 1명당 1 읽기를 가정합니다');
  }

  // 결재 역할이 당월 집계를 아예 건너뛰는가. 이 모델은 팀장·센터장·관리자가
  // 그 항목을 0으로 계산한다 — 게이트가 사라지면 예산이 조용히 늘어난다.
  if (!/if \(!can\('trx\.create'\)\)/.test(core)) {
    problems.push("core.js가 당월 집계를 can('trx.create')로 막지 않습니다 — "
      + '이 모델은 팀장·센터장이 그것을 읽지 않는다고 가정합니다');
  }

  // 보고서 목록이 담당 입주자로 좁혀져 있는가
  const report = read('../public/modules/report.js');
  if (!/report\.view\.all/.test(report) || !/chunkForInQuery/.test(report)) {
    problems.push('report.js가 보고서 목록을 담당 입주자로 좁히지 않습니다 — '
      + '이 모델은 담당자가 담당분만 읽는다고 가정합니다');
  }

  // 직원·분류를 명부로 읽는가
  if (!/fetchStaffDirectory/.test(core) || !/fetchCategoryDirectory/.test(core)) {
    problems.push('core.js가 파생 명부를 쓰지 않습니다 — '
      + '이 모델은 직원·분류를 각 1 읽기로 가정합니다');
  }

  const summary = read('../public/services/summary.js');
  // 30명 초과 시 전체 스캔 폴백이 남아 있지 않은가 (in 절 분할을 가정한다)
  if (!/chunkForInQuery/.test(summary)) {
    problems.push('services/summary.js가 in 절 분할을 쓰지 않습니다 — '
      + '담당 입주자 30명 초과 시 전 입주자 스캔으로 흘러내릴 수 있습니다');
  }

  const html = read('../public/index.html');
  if (!/persistentLocalCache/.test(html)) {
    problems.push('영속 캐시가 켜져 있지 않습니다 — 반복 세션의 읽기가 전량 과금됩니다');
  }
  return problems;
}

const problems = assertSourceShape();

// ── 출력 ──────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ cfg, rows, total, problems,
    warnThreshold: WARN_THRESHOLD, freeTier: FREE_TIER_DAILY_READS }, null, 2));
} else {
  const n = (x) => x.toLocaleString('ko-KR');
  console.log('\nFirestore 일일 읽기 예산 (캐시 미적중 상한)');
  console.log('─'.repeat(64));
  console.log(`인원  센터장 ${cfg.centers} · 관리자 ${cfg.admins} · 팀장 ${cfg.leaders} · `
    + `담당자 ${cfg.staff} · 입력자 ${cfg.typists}`);
  console.log(`범위  센터장 전체 · 팀장 ${visibleClients('leader')}명 · `
    + `담당자 ${visibleClients('staff')}명 · 관리자 0명`);
  console.log(`규모  입주자 ${cfg.clients} · 계좌 ${cfg.accounts} · `
    + `당월 거래/입주자 ${cfg.trxPerClientMonth} · 보고서 ${cfg.reports}`);
  console.log(`습관  1인 하루 콜드 세션 ${cfg.sessions}회 · `
    + `세션당 입주자 전환 ${cfg.clientSwitchesPerSession}회`);
  console.log(`캐시  요약 캐시 낡음 비율 ${Math.round(cfg.staleRatio * 100)}%`);
  console.log('집계  당월 집계는 담당자·입력자만 읽는다 (결재 역할은 건너뛴다)');
  console.log('─'.repeat(64));
  console.log('역할'.padEnd(16) + '인원'.padStart(6)
    + '세션당'.padStart(10) + '일일'.padStart(12));
  for (const r of rows) {
    console.log(r.label.padEnd(16) + String(r.count).padStart(6)
      + n(r.perSession).padStart(10) + n(r.daily).padStart(12));
  }
  console.log('─'.repeat(64));
  console.log('합계'.padEnd(32) + n(total).padStart(12)
    + `  / 무료 한도 ${n(FREE_TIER_DAILY_READS)}`);
  const pct = Math.round((total / FREE_TIER_DAILY_READS) * 100);
  console.log(`사용률 ${pct}%`);

  if (problems.length) {
    console.log('\n⚠️ 모델과 코드가 어긋납니다:');
    for (const p of problems) console.log('  · ' + p);
  }
  console.log('');
}

// 한도를 넘으면 실패로 끝난다 — CI에 걸어 두면 회귀를 잡는다.
if (problems.length) process.exit(2);
if (total > FREE_TIER_DAILY_READS) {
  console.error(`✘ 무료 한도 초과 (${total} > ${FREE_TIER_DAILY_READS})`);
  process.exit(1);
}
if (total > WARN_THRESHOLD) {
  console.error(`⚠ 여유가 없습니다 (${total} > ${WARN_THRESHOLD}) — `
    + '하루 편차와 재연결을 감당하지 못할 수 있습니다.');
  process.exit(1);
}
// --json 일 때는 아무것도 덧붙이지 않는다 — 한 줄이라도 섞이면 파싱이 깨진다.
if (!JSON_OUT) {
  console.log(`✔ 여유 있음 (경보선 ${WARN_THRESHOLD.toLocaleString('ko-KR')} 이하)\n`);
}
