#!/usr/bin/env node
/**
 * tools/diagnose-duplicate-reports.mjs — 같은 달에 보고서가 둘 이상인 곳을 찾는다.
 *
 * 왜 진단이 먼저인가
 *   보고서 문서 ID 가 임의 ID 이던 시절에는, 두 탭이 동시에 첫 저장을 하면
 *   같은 (입주자·연·월) 에 문서가 여럿 생길 수 있었다(functions/report-id.cjs
 *   머리말에 재현 결과가 있다). 이제 새로 만드는 것은 결정적 ID 를 쓰므로
 *   더 생기지 않지만, **이미 생긴 것은 그대로 남아 있다.**
 *
 *   그것을 기계가 알아서 정리하면 안 된다. 중복 중 어느 것이 "진짜"인지는
 *   결재 상태와 내용을 사람이 봐야 안다 — 하나는 confirmed 인데 다른 하나에
 *   담당자가 적어 둔 의견이 들어 있을 수 있다. 그래서 이 스크립트는
 *   **읽기만 한다.** 지우지도, 이관하지도 않는다.
 *
 * 쓰는 법
 *   # 에뮬레이터
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=<project> \
 *     node tools/diagnose-duplicate-reports.mjs
 *
 *   # 실제 프로젝트 (서비스 계정 키로)
 *   GOOGLE_APPLICATION_CREDENTIALS=sa.json GCLOUD_PROJECT=<project> \
 *     node tools/diagnose-duplicate-reports.mjs
 *
 * 나가는 값
 *   중복이 하나도 없으면 0, 있으면 1. 배포 전 게이트로 걸 수 있다
 *   (RUNBOOK 의 「중복 보고서 0건 확인」).
 */

import admin from 'firebase-admin';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reportDocId } = require('../functions/report-id.cjs');

const PROJECT = process.env.GCLOUD_PROJECT
  || process.env.GOOGLE_CLOUD_PROJECT
  || process.env.FIREBASE_PROJECT;

if (!PROJECT) {
  console.error('GCLOUD_PROJECT 를 지정하세요. (예: GCLOUD_PROJECT=smart-care-ledger-staging)');
  process.exit(2);
}

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const emu = process.env.FIRESTORE_EMULATOR_HOST;
console.log(`\n대상     : ${PROJECT}${emu ? `  (에뮬레이터 ${emu})` : '  ⚠ 실제 프로젝트'}`);
console.log('모드     : 읽기 전용 — 아무것도 고치지 않습니다\n');

const snap = await db.collection('reports').get();
console.log(`보고서   : ${snap.size}건\n`);

/** 기간 키 → 그 기간의 문서들 */
const byPeriod = new Map();
for (const doc of snap.docs) {
  const d = doc.data() || {};
  const clientId = String(d.clientId || '');
  const year = Number(d.year);
  const month = Number(d.month);
  if (!clientId || !Number.isInteger(year) || !Number.isInteger(month)) {
    console.log(`  ⚠ 기간을 읽을 수 없는 문서: ${doc.id} (clientId=${d.clientId} ${d.year}-${d.month})`);
    continue;
  }
  const key = `${clientId}\u0000${year}\u0000${month}`;
  if (!byPeriod.has(key)) byPeriod.set(key, { clientId, year, month, docs: [] });
  byPeriod.get(key).docs.push({ id: doc.id, status: d.status || '(없음)', createdBy: d.createdBy || '', createdAt: d.createdAt });
}

const dups = [];
let legacy = 0;
for (const period of byPeriod.values()) {
  const canonical = reportDocId(period.clientId, period.year, period.month);
  for (const doc of period.docs) if (doc.id !== canonical) legacy += 1;
  if (period.docs.length > 1) dups.push({ ...period, canonical });
}

// ── 예전 ID ─────────────────────────────────────────────
// 중복이 아니어도 임의 ID 인 것은 있다. 그것은 고장이 아니다 —
// 조회가 canonical 을 먼저 보고 없으면 쿼리로 떨어지므로 그대로 동작한다.
console.log(`예전 ID  : ${legacy}건  (임의 ID 로 만들어진 보고서 — 그대로 동작합니다)`);

if (!dups.length) {
  console.log('\n✔ 같은 달에 문서가 둘 이상인 곳은 없습니다.\n');
  process.exit(0);
}

console.log(`\n✗ 중복 ${dups.length}곳 — 사람이 확인해야 합니다\n`);
for (const d of dups) {
  console.log(`  ${d.clientId}  ${d.year}-${String(d.month).padStart(2, '0')}   (canonical: ${d.canonical})`);
  for (const doc of d.docs) {
    const when = doc.createdAt && typeof doc.createdAt.toDate === 'function'
      ? doc.createdAt.toDate().toISOString().slice(0, 19).replace('T', ' ')
      : '(시각 없음)';
    const mark = doc.id === d.canonical ? '←canonical' : '';
    console.log(`     ${doc.id.padEnd(34)} ${String(doc.status).padEnd(14)} ${when}  ${doc.createdBy} ${mark}`);
  }
  console.log('');
}
console.log('무엇을 할 것인가');
console.log('  결재가 진행된 문서(제출·결재 도장이 있는 것)를 남기고, 나머지에 든 내용');
console.log('  (의견·summary)이 있으면 옮긴 뒤 지웁니다. 자동으로 고르지 않는 이유는');
console.log('  둘 다 내용이 있을 수 있고, 그때 무엇을 버릴지는 기계가 정할 수 없어서입니다.\n');
process.exit(1);
