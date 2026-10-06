#!/usr/bin/env node
/**
 * 인증 마이그레이션 — BUGFIX_PLAN.md 「설계 6 · 배포 1」
 *
 * 하는 일
 *   1. users 문서 ID를 로그인 아이디(userId)로 승격
 *   2. 평문 비밀번호를 userSecrets/{userId}의 scrypt 해시로 이전
 *   3. role '관리자' → role '센터장' + isAdmin:true 로 분리
 *   4. clients.teamLeader 를 로그인 아이디로 정규화
 *      (현재 usr_xxx / Firestore 자동 ID / 로그인 아이디 3종이 섞여 있다)
 *
 * 안전장치
 *   - 기본은 **드라이런**. 실제 쓰기는 --apply 를 붙여야 한다.
 *   - 사전 점검에 걸리면 아무것도 쓰지 않고 중단한다.
 *   - 구 users/{구ID} 문서는 **삭제하지 않는다** (배포 3까지 롤백 경로로 남긴다).
 *
 * 사용법
 *   export GOOGLE_APPLICATION_CREDENTIALS=/경로/serviceAccountKey.json
 *   node tools/migrate-auth.mjs            # 드라이런 — 무엇이 바뀔지만 출력
 *   node tools/migrate-auth.mjs --apply    # 실제 반영
 */

import admin from 'firebase-admin';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hashPassword } = require('../functions/password.js');

const APPLY = process.argv.includes('--apply');
const USERS = 'users';
const SECRETS = 'userSecrets';
const CLIENTS = 'clients';
const VALID_ROLES = ['입력자', '담당자', '팀장', '센터장'];
const USER_ID_RE = /^[a-zA-Z0-9_]{1,64}$/;

function log(...a) { console.log(...a); }
function head(t) { log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64)); }

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

// ── 0. 현재 상태 읽기 ─────────────────────────────────────────
head('0. 현재 데이터 읽기');
const userSnap = await db.collection(USERS).get();
const clientSnap = await db.collection(CLIENTS).get();
const users = userSnap.docs.map((d) => ({ docId: d.id, ...d.data() }));
const clients = clientSnap.docs.map((d) => ({ docId: d.id, ...d.data() }));
log(`직원 ${users.length}명 · 입주자 ${clients.length}명`);

// ── 1. 사전 점검 (하나라도 걸리면 중단) ────────────────────────
head('1. 사전 점검');
const problems = [];

const byUserId = new Map();
for (const u of users) {
  const uid = String(u.userId || '').trim();
  if (!uid) {
    problems.push(`userId 없음: 문서 ${u.docId} (이름: ${u.name || '?'})`);
    continue;
  }
  if (!USER_ID_RE.test(uid)) {
    problems.push(`문서 ID로 쓸 수 없는 userId '${uid}' (문서 ${u.docId}) — 영문·숫자·밑줄만 가능`);
    continue;
  }
  if (!byUserId.has(uid)) byUserId.set(uid, []);
  byUserId.get(uid).push(u);
}

for (const [uid, list] of byUserId) {
  if (list.length > 1) {
    problems.push(
      `userId 중복 '${uid}' — 문서 ${list.map((u) => u.docId).join(', ')} ` +
      `(이름: ${list.map((u) => u.name || '?').join(', ')})`
    );
  }
}

const noPassword = users.filter((u) => !u.password && byUserId.has(String(u.userId || '').trim()));
if (noPassword.length) {
  log(`⚠️  비밀번호 필드가 없는 계정 ${noPassword.length}명 — 해시를 만들 수 없어 건너뜁니다:`);
  noPassword.forEach((u) => log(`     ${u.userId} (${u.name || '?'})`));
}

if (problems.length) {
  log('\n❌ 사전 점검 실패 — 아무것도 변경하지 않았습니다.\n');
  problems.forEach((p) => log('   • ' + p));
  log('\n위 항목을 Firebase 콘솔에서 먼저 정리한 뒤 다시 실행하세요.');
  log('특히 userId 중복은 새 문서 ID가 충돌하므로 반드시 사람이 판단해야 합니다.\n');
  process.exit(1);
}
log('✅ 사전 점검 통과');

// ── 2. 구 문서ID → 로그인아이디 매핑표 ─────────────────────────
head('2. 매핑표 작성');
const docIdToUserId = new Map();
for (const u of users) {
  const uid = String(u.userId).trim();
  docIdToUserId.set(u.docId, uid);
  docIdToUserId.set(uid, uid); // 이미 로그인 아이디인 값도 통과시킨다
}
log(`매핑 항목 ${docIdToUserId.size}개`);

// ── 3. clients.teamLeader 정규화 계획 ─────────────────────────
head('3. clients.teamLeader 정규화 계획');
const clientUpdates = [];
const unmapped = [];
for (const c of clients) {
  const cur = String(c.teamLeader || '').trim();
  if (!cur) continue;
  const mapped = docIdToUserId.get(cur);
  if (!mapped) {
    unmapped.push({ client: c.name || c.docId, value: cur });
    clientUpdates.push({ docId: c.docId, name: c.name, from: cur, to: '' });
  } else if (mapped !== cur) {
    clientUpdates.push({ docId: c.docId, name: c.name, from: cur, to: mapped });
  }
}
log(`변경 대상 입주자 ${clientUpdates.length}명`);
clientUpdates.forEach((u) =>
  log(`   ${u.name || u.docId}: '${u.from}' → '${u.to || '(비움)'}'`)
);
if (unmapped.length) {
  log(`\n⚠️  매핑할 수 없는 teamLeader ${unmapped.length}건 — 빈 값으로 두고 담당 팀장을 다시 지정해야 합니다:`);
  unmapped.forEach((u) => log(`     ${u.client}: '${u.value}'`));
}

// ── 4. users 이전 계획 ────────────────────────────────────────
head('4. users 이전 계획');
const userPlans = [];
for (const u of users) {
  const uid = String(u.userId).trim();
  const wasAdmin = u.role === '관리자';
  const role = wasAdmin ? '센터장' : (VALID_ROLES.includes(u.role) ? u.role : '입력자');
  userPlans.push({
    oldDocId: u.docId,
    userId: uid,
    name: u.name || uid,
    role,
    isAdmin: wasAdmin || u.isAdmin === true,
    team: u.team || '',
    approved: u.approved !== false,
    active: u.active !== false,
    password: u.password || null,
    changedRole: wasAdmin ? '관리자 → 센터장 + isAdmin' : (u.role !== role ? `${u.role} → ${role}` : ''),
    idChanged: u.docId !== uid,
  });
}
userPlans.forEach((p) =>
  log(
    `   ${p.userId.padEnd(16)} ${p.role.padEnd(4)}${p.isAdmin ? ' [관리자]' : '        '}` +
    `${p.idChanged ? ` (문서ID ${p.oldDocId} → ${p.userId})` : ' (문서ID 유지)'}` +
    `${p.changedRole ? '  ※ ' + p.changedRole : ''}` +
    `${p.password ? '' : '  ※ 비밀번호 없음 — 해시 생략'}`
  )
);

const adminCount = userPlans.filter((p) => p.isAdmin).length;
if (adminCount === 0) {
  log('\n⚠️  관리자가 한 명도 없습니다. 마이그레이션 후 권한 설정·전체 초기화가 불가능해집니다.');
  log('   기존에 role="관리자"인 계정이 있었는지 확인하세요.');
}

// ── 5. 실행 ──────────────────────────────────────────────────
if (!APPLY) {
  head('드라이런 종료');
  log('실제로 반영하려면 --apply 를 붙여 다시 실행하세요:');
  log('   node tools/migrate-auth.mjs --apply\n');
  process.exit(0);
}

head('5. 반영 중');
let done = 0;
for (const p of userPlans) {
  const batch = db.batch();
  batch.set(
    db.collection(USERS).doc(p.userId),
    {
      userId: p.userId,
      name: p.name,
      role: p.role,
      isAdmin: p.isAdmin,
      team: p.team,
      approved: p.approved,
      active: p.active,
      migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      migratedFrom: p.oldDocId,
    },
    { merge: true }
  );
  if (p.password) {
    const rec = await hashPassword(String(p.password));
    batch.set(
      db.collection(SECRETS).doc(p.userId),
      { ...rec, failedCount: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }
  await batch.commit();
  done++;
  if (done % 10 === 0) log(`   ${done}/${userPlans.length}명 처리`);
}
log(`   직원 ${done}명 이전 완료`);

if (clientUpdates.length) {
  const batch = db.batch();
  clientUpdates.forEach((u) =>
    batch.update(db.collection(CLIENTS).doc(u.docId), { teamLeader: u.to })
  );
  await batch.commit();
  log(`   입주자 teamLeader ${clientUpdates.length}건 정규화 완료`);
}

// ── 6. 검증 ──────────────────────────────────────────────────
head('6. 검증');
const afterUsers = await db.collection(USERS).get();
const afterSecrets = await db.collection(SECRETS).get();
const newDocs = afterUsers.docs.filter((d) => USER_ID_RE.test(d.id));
const withPassword = afterUsers.docs.filter((d) => d.data().password !== undefined);

log(`신규 users 문서: ${newDocs.length}개 (기대 ${userPlans.length}개)`);
log(`userSecrets 문서: ${afterSecrets.size}개 (기대 ${userPlans.filter((p) => p.password).length}개)`);
log(`password 필드가 남은 문서: ${withPassword.length}개 (구 문서 포함 — 배포 3에서 함께 삭제)`);

log('\n✅ 마이그레이션 완료');
log('\n다음 단계:');
log('  1. 기존 앱이 여전히 정상 동작하는지 확인 (아직 아무것도 안 바뀌어야 정상)');
log('  2. 배포 2 — auth.js를 커스텀 토큰 로그인으로 교체');
log('  3. 배포 3 — 보안 규칙 적용 + 구 users 문서 삭제');
log('\n구 문서는 남겨 두었습니다. 문제가 생기면 배포 2를 되돌리면 복구됩니다.\n');
process.exit(0);
