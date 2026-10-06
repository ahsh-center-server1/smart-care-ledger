#!/usr/bin/env node
/**
 * 계좌 잔액 재계산 — BUGFIX_PLAN.md 「설계 6 · 배포 4」
 *
 * updateAccBalance가 부분 로드된 캐시(기본 당월)로 계산해 currentBalance를
 * 덮어써 왔다. 이 스크립트가 전체 거래를 근거로 바로잡는다.
 *
 * ⚠️ 반드시 **잔액 단일화 코드(services/balance.js 적용)를 먼저 배포한 뒤** 실행할 것.
 *    순서를 바꾸면 재계산 직후 앱이 다시 망가뜨린다.
 *
 * 기준일 경계
 *   initialBalance는 "기준일 시점의 잔액"이므로 그날 거래는 이미 포함된 것으로 본다
 *   (date > 기준일만 합산). 기존 코드는 반대로 그날 거래를 더하고 있었다.
 *   두 해석의 차이가 나는 계좌는 리포트에 따로 표시하니 **실제 통장과 대조해 확인**하라.
 *
 * 사용법
 *   export GOOGLE_APPLICATION_CREDENTIALS=/경로/serviceAccountKey.json
 *   node tools/recalc-balances.mjs            # 드라이런 — 변경될 값만 출력
 *   node tools/recalc-balances.mjs --apply    # 실제 반영 (백업 JSON 자동 저장)
 *
 * 월말 잔액 색인 백필
 *   보고서 「계좌 현황」의 전월·당월 말잔은 accounts.monthEndBalances 에서 읽고,
 *   없으면 그 입주자의 전체 이력을 읽어 직접 계산한다(느려지는 것이 아니라
 *   **비싸진다** — 읽기가 늘 뿐이라 아무도 눈치채지 못한다). 평소에는 거래
 *   트리거가 채우지만, 배포 직후에는 아직 거래가 바뀌지 않은 계좌가 비어 있다.
 *   이 스크립트가 한 번에 채운다. 잔액이 맞는 계좌도 색인이 없으면 갱신 대상이다.
 */

import { writeFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { calcAccountBalance, buildMonthEndBalances } from '../public/services/balance.js';

const APPLY = process.argv.includes('--apply');
const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
const head = (t) => console.log('\n' + '─'.repeat(72) + '\n' + t + '\n' + '─'.repeat(72));

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

head('1. 데이터 읽기');
const [accSnap, trxSnap, cliSnap] = await Promise.all([
  db.collection('accounts').get(),
  db.collection('transactions').get(),
  db.collection('clients').get(),
]);
const accounts = accSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const trx = trxSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const clientName = new Map(cliSnap.docs.map((d) => [d.id, d.data().name || d.id]));
console.log(`계좌 ${accounts.length}개 · 거래 ${trx.length}건`);

// 계좌별로 미리 묶어 O(n²) 스캔을 피한다
const byAccount = new Map();
for (const t of trx) {
  if (!byAccount.has(t.accountId)) byAccount.set(t.accountId, []);
  byAccount.get(t.accountId).push(t);
}

head('2. 재계산');
const rows = [];
let noBaseDate = 0;
for (const a of accounts) {
  const mine = byAccount.get(a.id) || [];
  const stored = Number(a.currentBalance || 0);
  const correct = calcAccountBalance(a, mine);
  const index = buildMonthEndBalances(a, mine);
  const indexStale = JSON.stringify(a.monthEndBalances || {}) !== JSON.stringify(index);

  // 기존 코드의 해석(기준일 당일 포함)으로도 계산해 차이를 확인한다
  const base = a.initialBalanceDate || '';
  const sameDay = base ? mine.filter((t) => (t.date || '') === base && t.type !== '취소') : [];
  const sameDayDelta = sameDay.reduce(
    (s, t) => s + Number(t.amountIn || 0) - Number(t.amountOut || 0), 0);

  if (!base) noBaseDate++;
  rows.push({
    id: a.id,
    label: `${clientName.get(a.clientId) || '?'} / ${a.label || a.id}`,
    stored, correct, index, indexStale,
    diff: correct - stored,
    trxCount: mine.length,
    base,
    sameDayDelta,
    sameDayCount: sameDay.length,
  });
}

rows.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
// 잔액이 맞아도 색인이 비었으면 갱신 대상이다 — 그것이 백필의 요점이다.
const changed = rows.filter((r) => r.diff !== 0 || r.indexStale);
const balanceChanged = rows.filter((r) => r.diff !== 0);
const indexOnly = changed.length - balanceChanged.length;

console.log(`\n변경 대상 ${changed.length}개 / 전체 ${rows.length}개`);
console.log(`  · 잔액이 달라지는 계좌 ${balanceChanged.length}개`);
console.log(`  · 월말 색인만 채우는 계좌 ${indexOnly}개\n`);
for (const r of balanceChanged) {
  const sign = r.diff > 0 ? '+' : '';
  console.log(
    `  ${r.label}\n` +
    `      저장값 ${won(r.stored).padStart(16)}  →  실제 ${won(r.correct).padStart(16)}` +
    `   (${sign}${won(r.diff)}, 거래 ${r.trxCount}건)`
  );
}

const boundaryAffected = rows.filter((r) => r.sameDayCount > 0);
if (boundaryAffected.length) {
  head('⚠️ 기준일 경계 확인 필요');
  console.log('아래 계좌는 기준일 **당일**에 거래가 있어, 기준일 해석에 따라 잔액이 달라집니다.');
  console.log('실제 통장과 대조해 기초잔액이 그날 거래를 이미 포함한 값인지 확인하세요.\n');
  for (const r of boundaryAffected) {
    console.log(
      `  ${r.label}\n` +
      `      기준일 ${r.base} 당일 거래 ${r.sameDayCount}건 = ${won(r.sameDayDelta)}\n` +
      `      이 스크립트 기준(당일 제외): ${won(r.correct)}\n` +
      `      당일 포함으로 볼 경우      : ${won(r.correct + r.sameDayDelta)}`
    );
  }
}

if (noBaseDate) {
  head('⚠️ 기준일 없는 계좌');
  console.log(`${noBaseDate}개 계좌에 initialBalanceDate가 없어 전 기간 거래가 합산됩니다.`);
  console.log('의도한 값인지 확인하고, 아니라면 계좌 설정에서 기준일을 먼저 입력하세요.');
}

if (!APPLY) {
  head('드라이런 종료');
  console.log('실제로 반영하려면 --apply 를 붙여 다시 실행하세요:');
  console.log('   node tools/recalc-balances.mjs --apply\n');
  process.exit(0);
}

head('3. 백업 및 반영');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `accounts-backup-${stamp}.json`;
writeFileSync(backupPath, JSON.stringify(accounts, null, 2));
console.log(`백업 저장: ${backupPath}`);

let n = 0;
for (let i = 0; i < changed.length; i += 400) {
  const batch = db.batch();
  for (const r of changed.slice(i, i + 400)) {
    batch.update(db.collection('accounts').doc(r.id), {
      currentBalance: r.correct,
      monthEndBalances: r.index,
    });
    n++;
  }
  await batch.commit();
}
console.log(`계좌 ${n}개 갱신 완료`);
console.log('\n✅ 완료 — 대시보드·보고서·설정 세 화면의 숫자가 일치하는지 확인하세요.\n');
process.exit(0);
