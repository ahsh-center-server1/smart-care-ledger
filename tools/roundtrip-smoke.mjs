#!/usr/bin/env node
/**
 * tools/roundtrip-smoke.mjs — 역할별 로그인부터 최종 결재까지 **실제로** 눌러 본다.
 *
 * 왜 필요한가
 *   이 저장소의 검사는 단위 테스트(순수 판정) · 보안 규칙(에뮬레이터) ·
 *   집행 계약(소스 대조) 셋이었다. 전부 초록인데도 확인되지 않는 것이 있었다:
 *   **네 역할이 실제로 로그인해서 보고서를 끝까지 올릴 수 있는가.**
 *
 *   그 길은 콜러블 여러 개와 authz 투영본, 잠금 색인 세 개를 차례로 지난다.
 *   조각마다 테스트가 있어도 이어 붙인 길은 아무도 걷지 않았고, 실제로
 *   시드 직후에는 authz 문서가 없어 **모든 결재 동작이 거부**됐다
 *   (`권한 정보가 아직 준비되지 않았습니다`). 배포 순서 §10-2 의 2번을
 *   빠뜨린 것과 같은 고장인데, 어떤 검사도 그것을 말해 주지 않았다.
 *
 *   그래서 이 스크립트가 backfillAuthz 부터 시작한다 — 그 단계 자체가
 *   검사 대상이다.
 *
 * 무엇을 쓰는가
 *   진짜 `login` 콜러블(비밀번호 해시 검증 포함)로 커스텀 토큰을 받고,
 *   Auth 에뮬레이터에서 ID 토큰으로 바꾼 뒤, 진짜 `applyReportTransition` 을
 *   부른다. 화면은 지나지 않는다 — 브라우저 렌더는 tools/qa-smoke.mjs 가 본다.
 *   여기서 보는 것은 **서버가 집행하는 결재 절차**다.
 *
 * 쓰는 법
 *   npm run emu                                   # 다른 터미널
 *   npm run emu:seed -- --apply
 *   node tools/roundtrip-smoke.mjs
 *
 *   또는 한 번에 (CI 가 이렇게 한다):
 *   firebase emulators:exec --only auth,firestore,functions \
 *     "npm run emu:seed -- --apply && node tools/roundtrip-smoke.mjs"
 *
 * ⚠ 폐쇄망에서
 *   Functions 에뮬레이터는 **Firestore 트리거를 등록할 때**
 *   firebase-public.firebaseio.com 에 접속한다. 그 호스트가 막혀 있으면
 *   에뮬레이터 전체가 기동에 실패한다(콜러블은 전부 정상 초기화된 뒤다).
 *   그때는 트리거를 뺀 진입점으로 띄워야 한다 — STAGING.md 참고.
 */

import admin from 'firebase-admin';

const PROJECT = process.env.GCLOUD_PROJECT
  || process.env.FIREBASE_PROJECT
  || 'smart-care-ledger-staging';
const REGION = process.env.SCL_REGION || 'asia-northeast3';
const FN_HOST = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const PASSWORD = process.env.SEED_PASSWORD || 'staging1234';

const FNS = `http://${FN_HOST}/${PROJECT}/${REGION}`;
const AUTH = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1`;

if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

// ── 결과 집계 ────────────────────────────────────────────
let pass = 0;
const failures = [];
const line = (ok, name, detail) => {
  if (ok) { pass += 1; console.log(`  ✔ ${name}`); }
  else { failures.push(name); console.log(`  ✘ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// ── 콜러블 ───────────────────────────────────────────────
async function callable(name, data, idToken) {
  const res = await fetch(`${FNS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) return { ok: false, code: body.error.status || 'ERROR', msg: body.error.message };
  return { ok: true, result: body.result };
}

/** 진짜 login 콜러블 → 커스텀 토큰 → ID 토큰. */
async function signIn(userId) {
  const out = await callable('login', { userId, password: PASSWORD });
  if (!out.ok) return { ok: false, code: out.code, msg: out.msg };
  const res = await fetch(`${AUTH}/accounts:signInWithCustomToken?key=emulator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: out.result.token, returnSecureToken: true }),
  });
  const tok = await res.json();
  if (!tok.idToken) return { ok: false, code: 'token-exchange', msg: JSON.stringify(tok) };
  return { ok: true, idToken: tok.idToken, user: out.result.user };
}

async function reportsFor(clientId, year, month) {
  const snap = await db.collection('reports')
    .where('clientId', '==', clientId).where('year', '==', year).where('month', '==', month).get();
  return snap.docs.map((d) => ({ id: d.id, status: (d.data() || {}).status || '' }));
}

/** 시드가 만든 입주자 중 담당자(staff)에게 배정된 것. */
async function pickClient() {
  const snap = await db.collection('clients').get();
  const hit = snap.docs.find((d) => String((d.data() || {}).userIds || '').split(',').includes('staff'));
  if (!hit) throw new Error('담당자(staff)에게 배정된 입주자가 시드에 없습니다.');
  return hit.id;
}

// ─────────────────────────────────────────────────────────
console.log(`\n대상: ${PROJECT}   functions=${FN_HOST}  auth=${AUTH_HOST}  firestore=${process.env.FIRESTORE_EMULATOR_HOST}\n`);

// ── 0. 권한 백필 — 이것을 빠뜨리면 그 뒤가 전부 막힌다 ──
console.log('0. 권한 백필 (배포 순서 §10-2 의 2번)');
{
  const center = await signIn('center');
  if (!center.ok) {
    console.error(`\n관리자 로그인 실패 — 시드가 적용되지 않았습니다: ${center.code} ${center.msg}\n`);
    process.exit(1);
  }
  const out = await callable('backfillAuthz', {}, center.idToken);
  line(out.ok && out.result.users > 0, 'backfillAuthz 가 authz 문서를 만든다',
    out.ok ? `users=${out.result.users}` : `${out.code}: ${out.msg}`);
}

// ── 1. 네 역할 로그인 ──
console.log('\n1. 네 역할 로그인 (진짜 login 콜러블 · 비밀번호 검증)');
const sessions = {};
for (const [id, label] of [['center', '센터장'], ['leader', '팀장'], ['staff', '담당자'], ['typist', '입력자']]) {
  const s = await signIn(id);
  line(s.ok, `${id} (${label}) 로그인`, s.ok ? '' : `${s.code}: ${s.msg}`);
  if (s.ok) sessions[id] = s;
}
{
  const bad = await callable('login', { userId: 'leader', password: 'wrong-password' });
  line(!bad.ok, '틀린 비밀번호는 거부된다', bad.ok ? '로그인이 성공해 버렸다' : '');
}
if (!sessions.staff || !sessions.leader || !sessions.center) {
  console.error('\n로그인 단계가 실패해 이후를 진행할 수 없습니다.\n');
  process.exit(1);
}

const CLIENT = await pickClient();
const YEAR = 2031;            // 시드 보고서와 겹치지 않는 해
const name = (who) => sessions[who].user.name;

// ── 2. 결재 왕복 ──
console.log(`\n2. 결재 왕복 (${CLIENT} ${YEAR}-03)`);
const STEPS = [
  ['save', 'staff', '담당자 임시저장', 'draft'],
  ['submit', 'staff', '담당자 제출', 'submitted'],
  ['recall', 'staff', '담당자 회수', 'draft'],
  ['submit', 'staff', '담당자 재제출', 'submitted'],
  ['reject', 'leader', '팀장 반려 (사유 필수)', 'rejected'],
  ['submit', 'staff', '반려 후 재제출', 'submitted'],
  ['approveTeam', 'leader', '팀장 1차 결재', 'team_approved'],
  ['revert', 'leader', '팀장 회수 (결재 취소)', 'submitted'],
  ['approveTeam', 'leader', '팀장 재결재', 'team_approved'],
  ['approveCenter', 'center', '센터장 최종 결재', 'confirmed'],
  ['revert', 'center', '센터장 최종 결재 취소', 'team_approved'],
];
for (const [action, who, label, expect] of STEPS) {
  const data = { clientId: CLIENT, year: YEAR, month: 3, action, userName: name(who) };
  if (action === 'reject') data.reason = '검토 중 오류 발견';
  const out = await callable('applyReportTransition', data, sessions[who].idToken);
  if (!out.ok) { line(false, `${label} → ${expect}`, `${out.code}: ${out.msg}`); continue; }
  const [doc] = await reportsFor(CLIENT, YEAR, 3);
  line(doc && doc.status === expect, `${label} → ${expect}`, `실제 ${doc ? doc.status : '문서 없음'}`);
}

// ── 3. 작성자와 결재자의 분리 ──
console.log('\n3. 역할 분리 (§4 작성자와 결재자의 분리)');
for (const [action, who, label] of [
  ['submit', 'leader', '팀장은 제출할 수 없다'],
  ['submit', 'center', '센터장은 제출할 수 없다'],
  ['approveCenter', 'leader', '팀장은 최종 결재할 수 없다'],
  ['approveTeam', 'staff', '담당자는 1차 결재할 수 없다'],
  ['approveCenter', 'staff', '담당자는 최종 결재할 수 없다'],
]) {
  const out = await callable('applyReportTransition',
    { clientId: CLIENT, year: YEAR, month: 3, action, userName: name(who) }, sessions[who].idToken);
  line(!out.ok, label, out.ok ? '허용되어 버렸다' : '');
}

// ── 4. 단계 건너뛰기 ──
console.log('\n4. 단계 건너뛰기 방지 (전이표는 실행 시점에 본다)');
{
  await callable('applyReportTransition', { clientId: CLIENT, year: YEAR, month: 4, action: 'save', userName: name('staff') }, sessions.staff.idToken);
  for (const [action, who, label] of [
    ['approveCenter', 'center', 'draft 에서 최종 결재로 건너뛸 수 없다'],
    ['approveTeam', 'leader', 'draft 에서 1차 결재할 수 없다'],
  ]) {
    const out = await callable('applyReportTransition',
      { clientId: CLIENT, year: YEAR, month: 4, action, userName: name(who) }, sessions[who].idToken);
    line(!out.ok, label, out.ok ? '허용되어 버렸다' : '');
  }
}

// ── 5. 같은 달에 문서는 하나 ──
//
// 결정적 문서 ID 가 없던 시절에는 동시 첫 저장 5건이 문서 3개를 만들었다.
// 그 고장은 조용하다 — 화면은 첫 문서만 쓰므로 나머지는 고아가 된다.
console.log('\n5. 동시 최초 저장 (functions/report-id.cjs)');
{
  const M = 7;
  const N = 5;
  const out = await Promise.all(Array.from({ length: N }, () => callable('applyReportTransition',
    { clientId: CLIENT, year: YEAR, month: M, action: 'save', userName: name('staff') }, sessions.staff.idToken)));
  const okN = out.filter((r) => r.ok).length;
  const docs = await reportsFor(CLIENT, YEAR, M);
  line(docs.length === 1, `동시 저장 ${N}건 → 보고서 문서 1개`,
    `문서 ${docs.length}개 (성공 ${okN}건): ${docs.map((d) => d.id).join(', ')}`);
  line(docs.length === 1 && docs[0].id.startsWith('r_'), '문서 ID 가 기간 키에서 나온 결정적 ID 다',
    docs.map((d) => d.id).join(', '));
}

// ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(56)}`);
if (failures.length) {
  console.log(`✘ ${pass} 통과 / ${failures.length} 실패\n`);
  failures.forEach((f) => console.log(`   - ${f}`));
  console.log('');
  process.exit(1);
}
console.log(`✔ ${pass} 항목 전부 통과 — 네 역할이 보고서를 끝까지 올리고 되돌릴 수 있다\n`);
process.exit(0);
