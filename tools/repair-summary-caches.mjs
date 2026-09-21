#!/usr/bin/env node
/**
 * tools/repair-summary-caches.mjs — clientId 가 빠진 요약 캐시 문서를 고친다.
 *
 * 왜 필요한가
 *   `syncSummaryVersion` 트리거가 예전에는 sourceVersion 만 올렸다. 그 (입주자,
 *   월)을 아무도 보지 않은 상태에서 거래가 먼저 써지면 — 담당자가 엑셀을 올리는
 *   가장 흔한 순서다 — 그 set 이 **clientId 없는 문서**를 만든다. 규칙은 두 곳에서
 *   clientId 를 요구하므로(읽기의 seesClient, 갱신의 clientId 일치) 브라우저는 그
 *   문서를 읽지도 고치지도 못하고, 그 달의 대시보드는 매번 당월 거래를 다시 읽는다.
 *
 *   트리거는 고쳤지만(functions/index.js) **이미 만들어진 문서는 낫지 않는다.**
 *   그 계좌에 거래가 또 써지면 merge 로 채워지기는 하나, 조용한 달은 그대로 남는다.
 *   이 스크립트가 그것을 한 번에 채운다.
 *
 * 어떻게 clientId 를 되짚는가
 *   문서 id 는 `${clientId}_${ym}` 인데 clientId 에 `_` 가 들어갈 수 있어
 *   (`cli_seed_1`) 문자열을 가르면 틀린다. 그래서 **실제 입주자 목록과 맞춰 본다** —
 *   `<알려진 clientId>_<YYYY-MM>` 으로 딱 떨어지는 것만 고친다. 맞는 입주자가
 *   없거나 둘 이상이면 손대지 않고 보고만 한다. 지어내는 것보다 남기는 편이 낫다.
 *
 * 안전
 *   기본은 **드라이런**이다. `--apply` 를 붙여야 쓴다. 쓰는 것도 clientId·ym 두
 *   필드를 merge 로 채우는 것뿐이고 sourceVersion·computedVersion 은 건드리지
 *   않는다 — 그 둘은 신선도 판정의 근거라 값을 바꾸면 맞는 캐시가 낡은 것이 된다.
 *
 * 쓰는 법
 *   # 에뮬레이터
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=<project> \
 *     node tools/repair-summary-caches.mjs
 *
 *   # 실제 프로젝트
 *   GOOGLE_APPLICATION_CREDENTIALS=sa.json GCLOUD_PROJECT=<project> \
 *     node tools/repair-summary-caches.mjs --apply
 *
 * 나가는 값
 *   고칠 것이 없으면 0. 드라이런에서 고칠 것이 있으면 1(배포 게이트로 쓸 수 있다).
 *   --apply 로 다 고쳤으면 0.
 */

import admin from 'firebase-admin';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

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
console.log(`모드     : ${APPLY ? '적용 (--apply)' : '드라이런 — 아무것도 쓰지 않습니다'}\n`);

// ── 입주자 목록 — clientId 를 되짚는 유일한 근거 ──
const clientSnap = await db.collection('clients').get();
const clientIds = clientSnap.docs.map((d) => d.id);
console.log(`입주자   : ${clientIds.length}명`);

const YM = /^\d{4}-\d{2}$/;

/** 문서 id 를 알려진 입주자와 맞춰 (clientId, ym) 으로 되짚는다. */
function resolve(docId) {
  const hits = [];
  for (const cid of clientIds) {
    if (!docId.startsWith(`${cid}_`)) continue;
    const ym = docId.slice(cid.length + 1);
    if (YM.test(ym)) hits.push({ clientId: cid, ym });
  }
  return hits;
}

const snap = await db.collection('summaryCaches').get();
console.log(`요약 캐시 : ${snap.size}건\n`);

const broken = [];     // clientId 가 없어 규칙이 막는 것
const ambiguous = [];  // 되짚을 수 없는 것 — 사람이 봐야 한다
const mismatched = []; // clientId 는 있는데 id 와 다른 것 — 건드리지 않는다

for (const doc of snap.docs) {
  const data = doc.data() || {};
  const hits = resolve(doc.id);

  if (data.clientId) {
    // 이미 있는 값이 id 와 어긋나면 자동으로 고치지 않는다 — 어느 쪽이 맞는지
    // 기계가 정할 수 없고, 잘못 고치면 남의 입주자 집계를 덮는다.
    if (hits.length === 1 && hits[0].clientId !== data.clientId) {
      mismatched.push({ id: doc.id, stored: data.clientId, fromId: hits[0].clientId });
    }
    continue;
  }

  if (hits.length !== 1) { ambiguous.push({ id: doc.id, hits: hits.length }); continue; }
  broken.push({ ref: doc.ref, id: doc.id, ...hits[0] });
}

console.log(`clientId 없음 : ${broken.length}건  ← 규칙이 읽기·갱신을 막고 있는 것`);
console.log(`되짚기 실패   : ${ambiguous.length}건`);
console.log(`값 불일치     : ${mismatched.length}건\n`);

for (const a of ambiguous) {
  console.log(`  ⚠ 되짚을 수 없음: ${a.id} (맞는 입주자 ${a.hits}명) — 남겨 둡니다`);
}
for (const m of mismatched) {
  console.log(`  ⚠ 불일치: ${m.id} — 문서의 clientId=${m.stored}, id 가 가리키는 것=${m.fromId} — 남겨 둡니다`);
}
if (ambiguous.length || mismatched.length) console.log('');

if (!broken.length) {
  console.log('✔ 고칠 캐시 문서가 없습니다.\n');
  process.exit(0);
}

for (const b of broken.slice(0, 20)) {
  console.log(`  ${b.id.padEnd(40)} → clientId=${b.clientId} ym=${b.ym}`);
}
if (broken.length > 20) console.log(`  … 외 ${broken.length - 20}건`);
console.log('');

if (!APPLY) {
  console.log('실제로 고치려면 --apply 를 붙여 다시 실행하세요.\n');
  process.exit(1);
}

// ── 쓰기 — clientId·ym 만 채운다 ──
let written = 0;
for (let i = 0; i < broken.length; i += 400) {
  const chunk = broken.slice(i, i + 400);
  const batch = db.batch();
  for (const b of chunk) {
    batch.set(b.ref, { clientId: b.clientId, ym: b.ym }, { merge: true });
  }
  await batch.commit();
  written += chunk.length;
  console.log(`  ${written}/${broken.length} 기록`);
}

console.log(`\n✔ ${written}건을 고쳤습니다 — 이제 브라우저가 그 캐시를 읽고 갱신할 수 있습니다.`);
console.log('  (sourceVersion·computedVersion 은 건드리지 않았습니다. 다음 조회에서');
console.log('   한 번 재계산한 뒤부터 캐시가 듣습니다.)\n');
process.exit(0);
