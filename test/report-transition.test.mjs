import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, FieldValue, FakeHttpsError, silentLogger } from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const reportFns = require('../functions/report-fns.js');
const { computeCaps, rankOf } = require('../functions/perm-catalog.cjs');

/**
 * 보고서 결재 — **서버가 전이표를 집행하는가.**
 *
 * 무엇이 열려 있었나
 *   전이표는 브라우저에만 있었고 규칙은 등급으로만 막았다. 담당자 등급이면
 *   콘솔에서 status:'confirmed' 를 직접 쓸 수 있었고, 그러면 팀장·센터장
 *   결재란이 빈 채로 최종 결재가 되고 그 달의 거래가 잠긴다.
 *
 * 여기서 확인하는 것은 "화면이 막는가"가 아니라 **"서버가 막는가"** 다.
 * 화면을 통하지 않고 콜러블을 직접 부른다.
 */

const MY = 'c1';
const OTHER = 'c9';

function authzOf(uid, role) {
  return {
    uid, role, enabled: true, accessibleClientIds: [MY],
    caps: computeCaps(rankOf({ role, isAdmin: false }), {}),
  };
}

function build(seed = {}) {
  const db = makeDb({
    'authz/입력자': authzOf('입력자', '입력자'),
    'authz/담당자': authzOf('담당자', '담당자'),
    'authz/팀장': authzOf('팀장', '팀장'),
    'authz/센터장': authzOf('센터장', '센터장'),
    // 배정 팀장은 '팀장' 이다
    'clientAccess/c1/members/담당자': { uid: '담당자', isStaff: true, isLeader: false },
    'clientAccess/c1/members/팀장': { uid: '팀장', isStaff: false, isLeader: true },
    ...seed,
  });
  return { db, fns: reportFns({
    db, callable: (n, h) => h, HttpsError: FakeHttpsError,
    logger: silentLogger, FieldValue,
  }) };
}

const as = (uid) => ({ auth: { uid } });
const at = (extra = {}) => ({ clientId: MY, year: 2026, month: 9, ...extra });

function report(db, over = {}) {
  db.docs.set('reports/r1', {
    clientId: MY, year: 2026, month: 9, status: 'draft', createdBy: '담당자', ...over,
  });
}

// ─────────────────────────────────────────────
// 순서 강제 — 이 파일의 이유
// ─────────────────────────────────────────────

test('초안에서 최종 결재로 건너뛸 수 없다', async () => {
  const { db, fns } = build();
  report(db);
  await assert.rejects(
    () => fns.applyReportTransition({ ...as('센터장'), data: at({ action: 'approveCenter' }) }),
    (e) => e.code === 'failed-precondition' && /할 수 없는 동작/.test(e.message),
  );
  assert.equal(db.docs.get('reports/r1').status, 'draft');
});

test('제출 상태에서도 최종 결재로 건너뛸 수 없다', async () => {
  const { db, fns } = build();
  report(db, { status: 'submitted' });
  await assert.rejects(
    () => fns.applyReportTransition({ ...as('센터장'), data: at({ action: 'approveCenter' }) }),
    (e) => e.code === 'failed-precondition',
  );
  assert.equal(db.docs.get('reports/r1').status, 'submitted');
});

test('제출 → 팀장 결재 → 최종 결재 순서로는 통과한다', async () => {
  const { db, fns } = build();
  report(db);

  await fns.applyReportTransition({ ...as('담당자'), data: at({ action: 'submit' }) });
  assert.equal(db.docs.get('reports/r1').status, 'submitted');

  await fns.applyReportTransition({ ...as('팀장'), data: at({ action: 'approveTeam' }) });
  assert.equal(db.docs.get('reports/r1').status, 'team_approved');

  await fns.applyReportTransition({ ...as('센터장'), data: at({ action: 'approveCenter' }) });
  const r = db.docs.get('reports/r1');
  assert.equal(r.status, 'confirmed');
  assert.ok(r.centerApprovedAt && r.centerApprovedBy === '센터장');
  assert.equal(db.docs.get('config/lockedMonths').months[`${MY}_2026-09`], true);
});

test('최종 결재와 월 잠금 중 하나가 실패하면 둘 다 반영되지 않는다', async () => {
  const { db, fns } = build();
  report(db, { status: 'team_approved' });
  db.failWrite = (path) => path === 'config/lockedMonths';

  await assert.rejects(
    () => fns.applyReportTransition({ ...as('센터장'), data: at({ action: 'approveCenter' }) }),
  );
  assert.equal(db.docs.get('reports/r1').status, 'team_approved');
  assert.equal(db.docs.has('config/lockedMonths'), false);
});

// ─────────────────────────────────────────────
// 배정 팀장 — 근거는 투영본이다
// ─────────────────────────────────────────────

test('배정 팀장이 아니면 팀장 결재를 할 수 없다', async () => {
  const { db, fns } = build({
    'authz/다른팀장': authzOf('다른팀장', '팀장'),
  });
  report(db, { status: 'submitted' });
  await assert.rejects(
    () => fns.applyReportTransition({ ...as('다른팀장'), data: at({ action: 'approveTeam' }) }),
    (e) => /담당 팀장이 아닙니다|담당하지 않는/.test(e.message),
  );
});

test('배정 팀장이 있으면 센터장이 대행할 수 없다', async () => {
  // 이 조건이 없으면 센터장이 언제든 팀장 단계를 건너뛴다.
  const { db, fns } = build();
  report(db, { status: 'submitted' });
  await assert.rejects(
    () => fns.applyReportTransition({ ...as('센터장'), data: at({ action: 'approveTeamProxy' }) }),
    (e) => /배정된 팀장이 있어/.test(e.message),
  );
});

test('배정 팀장이 없으면 센터장이 대행할 수 있고 대행 표시가 남는다', async () => {
  const { db, fns } = build();
  db.docs.delete('clientAccess/c1/members/팀장');
  report(db, { status: 'submitted' });

  await fns.applyReportTransition({
    ...as('센터장'), data: at({ action: 'approveTeamProxy', userName: '박센터' }),
  });
  const r = db.docs.get('reports/r1');
  assert.equal(r.status, 'team_approved');
  assert.match(r.teamApprovedByName, /대행/);
});

test('배정 팀장이 퇴사했으면 공석으로 본다', async () => {
  const { db, fns } = build();
  db.docs.set('authz/팀장', { ...authzOf('팀장', '팀장'), enabled: false });
  report(db, { status: 'submitted' });

  await fns.applyReportTransition({ ...as('센터장'), data: at({ action: 'approveTeamProxy' }) });
  assert.equal(db.docs.get('reports/r1').status, 'team_approved');
});

// ─────────────────────────────────────────────
// 도장 정리 — 취소된 서명이 인쇄물에 남으면 안 된다
// ─────────────────────────────────────────────

test('결재를 취소하면 뒤 단계 도장이 지워진다', async () => {
  const { db, fns } = build();
  report(db, {
    status: 'confirmed',
    submittedBy: '담당자', submittedByName: '김담당', submittedAt: 'x',
    teamApprovedBy: '팀장', teamApprovedByName: '이팀장', teamApprovedAt: 'y',
    centerApprovedBy: '센터장', centerApprovedByName: '박센터', centerApprovedAt: 'z',
  });

  await fns.applyReportTransition({ ...as('센터장'), data: at({ action: 'revert' }) });
  const r = db.docs.get('reports/r1');
  assert.equal(r.status, 'team_approved');
  assert.equal('centerApprovedByName' in r, false, '취소된 서명이 남았습니다');
  assert.equal(r.teamApprovedByName, '이팀장', '아직 유효한 서명까지 지웠습니다');
});

test('반려하면 제출·결재 기록이 함께 정리된다', async () => {
  const { db, fns } = build();
  report(db, {
    status: 'team_approved',
    submittedByName: '김담당', teamApprovedByName: '이팀장',
  });
  await fns.applyReportTransition({ ...as('센터장'), data: at({ action: 'reject' }) });
  const r = db.docs.get('reports/r1');
  assert.equal(r.status, 'rejected');
  assert.equal('teamApprovedByName' in r, false);
  assert.equal('submittedByName' in r, false);
});

// ─────────────────────────────────────────────
// 위조 방어
// ─────────────────────────────────────────────

test('클라이언트가 보낸 도장 필드는 무시한다', async () => {
  const { db, fns } = build();
  report(db);
  await fns.applyReportTransition({
    ...as('담당자'),
    data: at({ action: 'submit', extraSet: {
      status: 'confirmed',
      centerApprovedByName: '위조된 센터장',
      teamApprovedBy: '위조',
    } }),
  });
  const r = db.docs.get('reports/r1');
  assert.equal(r.status, 'submitted', '클라이언트가 보낸 status 가 먹혔습니다');
  assert.equal(r.centerApprovedByName, undefined, '결재란이 위조됐습니다');
});

test('의견란은 함께 저장된다', async () => {
  const { db, fns } = build();
  report(db);
  await fns.applyReportTransition({
    ...as('담당자'), data: at({ action: 'submit', extraSet: { staffComment: '이상 없음' } }),
  });
  assert.equal(db.docs.get('reports/r1').staffComment, '이상 없음');
});

test('createdBy 는 서버가 정한다', async () => {
  const { db, fns } = build();
  const out = await fns.applyReportTransition({
    ...as('담당자'),
    data: at({ action: 'save', extraSet: { createdBy: '남의아이디' } }),
  });
  assert.equal(db.docs.get('reports/' + out.reportId).createdBy, '담당자');
});

test('담당 밖 입주자의 보고서는 건드릴 수 없다', async () => {
  const { fns } = build();
  await assert.rejects(
    () => fns.applyReportTransition({
      ...as('담당자'), data: { clientId: OTHER, year: 2026, month: 9, action: 'save' },
    }),
    (e) => e.code === 'permission-denied',
  );
});

test('읽은 뒤 상태가 바뀌었으면 중단한다', async () => {
  // 탭 두 개 · 동시 결재. 사전 조회와 트랜잭션 사이에 상태가 바뀌면 낡은
  // 판단으로 전이하게 된다. 그 틈을 흉내내려고 트랜잭션 직전에 상태를 바꾼다.
  const { db, fns } = build();
  report(db, { status: 'submitted' });

  const original = db.runTransaction.bind(db);
  db.runTransaction = async (fn) => {
    db.docs.set('reports/r1', { ...db.docs.get('reports/r1'), status: 'team_approved' });
    return original(fn);
  };

  await assert.rejects(
    () => fns.applyReportTransition({ ...as('팀장'), data: at({ action: 'approveTeam' }) }),
    (e) => e.code === 'aborted',
  );
  // 남의 결재를 덮어쓰지 않았다
  assert.equal(db.docs.get('reports/r1').status, 'team_approved');
});

// ─────────────────────────────────────────────
// 의견 · 삭제
// ─────────────────────────────────────────────

test('의견은 정해진 항목만 저장한다', async () => {
  const { db, fns } = build();
  report(db);
  await assert.rejects(
    () => fns.saveReportComment({ ...as('담당자'), data: at({ key: 'status', value: 'confirmed' }) }),
    (e) => e.code === 'invalid-argument',
  );
  assert.equal(db.docs.get('reports/r1').status, 'draft');

  await fns.saveReportComment({ ...as('담당자'), data: at({ key: 'staffComment', value: '메모' }) });
  assert.equal(db.docs.get('reports/r1').staffComment, '메모');
});

test('의견 저장이 보고서를 처음 만들면 초안이다', async () => {
  const { db, fns } = build();
  const out = await fns.saveReportComment({
    ...as('담당자'), data: at({ key: 'leaderComment', value: '확인' }),
  });
  const r = db.docs.get('reports/' + out.reportId);
  assert.equal(r.status, 'draft');
  assert.equal(r.createdBy, '담당자');
});

test('삭제 권한이 없으면 지울 수 없다', async () => {
  const { db, fns } = build();
  report(db);
  await assert.rejects(
    () => fns.deleteReport({ ...as('담당자'), data: at() }),
    (e) => e.code === 'permission-denied',
  );
  assert.equal(db.docs.has('reports/r1'), true);

  await fns.deleteReport({ ...as('팀장'), data: at() });
  assert.equal(db.docs.has('reports/r1'), false);
});

test('로그인하지 않으면 아무것도 못 한다', async () => {
  const { fns } = build();
  for (const [name, data] of [
    ['applyReportTransition', at({ action: 'save' })],
    ['saveReportComment', at({ key: 'staffComment', value: 'x' })],
    ['deleteReport', at()],
  ]) {
    await assert.rejects(() => fns[name]({ data }), (e) => e.code === 'unauthenticated', name);
  }
});
