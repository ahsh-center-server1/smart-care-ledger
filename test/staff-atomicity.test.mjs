import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  makeDb, FieldValue, FakeHttpsError, silentLogger,
} from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const staffFns = require('../functions/staff-fns.js');
const authzModule = require('../functions/authz.cjs');
const { computeCaps, rankOf, CAP_SCHEMA_VERSION } = require('../functions/perm-catalog.cjs');
const makeCaller = require('../functions/caller.cjs');

/**
 * 직원 변경의 **원자성** 검증.
 *
 * 무엇을 확인하나
 *   직원 문서를 고치면 두 곳이 바뀐다: 화면이 읽는 users/{uid} 와 규칙이 읽는
 *   authz/{uid}. 이 둘이 따로 커밋되면 사이에서 실패했을 때 부분 상태가 남는다 —
 *   퇴사 처리했는데 규칙은 통과시키는(authz.enabled=true) 상태가 대표적이다.
 *
 *   그래서 authz 쓰기만 골라 실패시키고, **users 도 안 바뀌었는지** 본다.
 *   실패를 삼키고 성공을 돌려주던 이전 판은 이 테스트를 통과하지 못한다.
 *
 * 왜 대역인가
 *   에뮬레이터로는 특정 쓰기만 실패시킬 수 없다. helpers/fake-firestore.mjs
 *   주석에 이 대역이 답할 수 있는 질문의 범위를 적어 뒀다.
 */

const ROLE_RANK = { 입력자: 1, 담당자: 2, 팀장: 3, 센터장: 4 };
const VALID_ROLES = Object.keys(ROLE_RANK);
const USERS = 'users';
const SECRETS = 'userSecrets';

/** index.js 의 rankOf 와 같은 계산 — 역할 문자열 하나를 받는다. */
const rankOfRole = (role) => ROLE_RANK[role] || 0;

/** 실제 배선과 같은 authzWriteFor. 카탈로그 계산까지 진짜를 쓴다. */
function makeAuthzWriter(db) {
  return {
    currentOverride: async () => ({}),
    authzWriteFor(uid, user, override) {
      const id = String(uid || '').trim();
      if (!id) return null;
      const caps = computeCaps(rankOf({ role: user.role, isAdmin: user.isAdmin }), override);
      return {
        ref: db.collection('authz').doc(id),
        data: authzModule.authzIdentityPatch({
          uid: id, user, caps, capSchemaVersion: CAP_SCHEMA_VERSION,
        }),
        merge: true,
      };
    },
  };
}

function build(seed) {
  const db = makeDb(seed);
  // 호출자 판정은 이제 authz 문서를 읽는다 — 토큰 클레임이 아니다.
  // 실제 배선과 같은 모듈을 쓴다(대역을 따로 만들면 검사가 헐거워진다).
  const { requireCaller } = makeCaller({ db, HttpsError: FakeHttpsError });
  const fns = staffFns({
    db,
    // callable 은 배포용 래퍼다. 테스트는 핸들러를 그대로 부른다.
    callable: (name, handler) => handler,
    requireCaller,
    rankOf: rankOfRole,
    HttpsError: FakeHttpsError,
    logger: silentLogger,
    FieldValue,
    hashPassword: async (pw) => ({ hash: `h:${pw}`, algo: 'fake' }),
    validUserId: (id) => typeof id === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(id),
    VALID_ROLES,
    USERS,
    SECRETS,
    randomId: () => 'request-fixed',
    ...makeAuthzWriter(db),
  });
  return { db, fns };
}

const ADMIN = { uid: 'boss' };

/** 권한 스냅샷 하나. caps 는 실제 카탈로그로 계산한다 — 손으로 적지 않는다. */
function authzOf(uid, role, isAdmin, clientIds = []) {
  return {
    uid, role, isAdmin: isAdmin === true, enabled: true,
    accessibleClientIds: clientIds,
    caps: computeCaps(rankOf({ role, isAdmin }), {}),
    capSchemaVersion: CAP_SCHEMA_VERSION,
  };
}

/** 관리자 1명 + 대상 직원 1명. authz 는 백필된 상태. */
function seedTwo() {
  return {
    'users/boss': { userId: 'boss', name: '센터장', role: '센터장', isAdmin: true, approved: true, active: true },
    'users/kim': { userId: 'kim', name: '김담당', role: '담당자', isAdmin: false, approved: true, active: true },
    'authz/boss': authzOf('boss', '센터장', true),
    'authz/kim': authzOf('kim', '담당자', false, ['c1']),
  };
}

// ─────────────────────────────────────────────
// 퇴사 처리 — 부분 상태가 남지 않는다
// ─────────────────────────────────────────────

test('퇴사 처리는 users 와 authz 를 함께 바꾼다', async () => {
  const { db, fns } = build(seedTwo());
  await fns.setStaffActive({ auth: ADMIN, data: { userId: 'kim', active: false } });

  assert.equal(db.docs.get('users/kim').active, false);
  assert.equal(db.docs.get('authz/kim').enabled, false, 'authz 가 따라가지 않았습니다');
});

test('authz 쓰기가 실패하면 users 도 바뀌지 않는다', async () => {
  // 이것이 이 파일의 이유다. 이전 판은 실패를 삼키고 성공을 돌려줬고,
  // users.active=false 인데 authz.enabled=true 가 남았다 — 화면에는 퇴사인데
  // 규칙은 통과시킨다.
  const { db, fns } = build(seedTwo());
  db.failWrite = (path) => path === 'authz/kim';

  await assert.rejects(
    () => fns.setStaffActive({ auth: ADMIN, data: { userId: 'kim', active: false } }),
    /쓰기 실패/,
  );

  assert.equal(db.docs.get('users/kim').active, true, '거부됐는데 users 가 바뀌었습니다');
  assert.equal(db.docs.get('authz/kim').enabled, true);
});

test('users 쓰기가 실패하면 authz 도 바뀌지 않는다', async () => {
  const { db, fns } = build(seedTwo());
  db.failWrite = (path) => path === 'users/kim';

  await assert.rejects(
    () => fns.setStaffActive({ auth: ADMIN, data: { userId: 'kim', active: false } }),
    /쓰기 실패/,
  );

  assert.equal(db.docs.get('authz/kim').enabled, true, '거부됐는데 authz 가 바뀌었습니다');
});

test('퇴사 처리가 담당 목록을 지우지 않는다', async () => {
  // authz 를 merge 가 아니라 set 으로 쓰면 여기서 담당이 사라진다.
  const { db, fns } = build(seedTwo());
  await fns.setStaffActive({ auth: ADMIN, data: { userId: 'kim', active: false } });
  assert.deepEqual(db.docs.get('authz/kim').accessibleClientIds, ['c1']);
});

test('본인 계정은 비활성화할 수 없다', async () => {
  const { db, fns } = build(seedTwo());
  await assert.rejects(
    () => fns.setStaffActive({ auth: ADMIN, data: { userId: 'boss', active: false } }),
    (e) => e.code === 'failed-precondition',
  );
  assert.equal(db.docs.get('users/boss').active, true);
});

test('업무 팀장은 관리자 계정을 비활성화할 수 없다', async () => {
  const seed = seedTwo();
  seed['users/kim'].isAdmin = true;   // 관리자 2명
  const { db, fns } = build(seed);

  // boss 를 지우면 kim 이 마지막 관리자가 된다
  db.docs.delete('users/boss');
  const other = { uid: 'lead' };
  db.docs.set('users/lead', { userId: 'lead', role: '팀장', active: true });
  db.docs.set('authz/lead', authzOf('lead', '팀장', false));

  await assert.rejects(
    () => fns.setStaffActive({ auth: other, data: { userId: 'kim', active: false } }),
    (e) => e.code === 'permission-denied',
  );
  assert.equal(db.docs.get('users/kim').active, true);
  assert.equal(db.docs.get('authz/kim').enabled, true);
});

// ─────────────────────────────────────────────
// 승인 · 등록
// ─────────────────────────────────────────────

function withDirector(seed) {
  seed['users/director'] = { userId: 'director', name: '다른 센터장', role: '센터장', isAdmin: false, approved: true, active: true };
  seed['authz/director'] = authzOf('director', '센터장', false);
  return seed;
}

function withLeader(seed) {
  seed['users/leader'] = { userId: 'leader', name: '팀장', role: '팀장', isAdmin: false, approved: true, active: true };
  seed['authz/leader'] = authzOf('leader', '팀장', false);
  return seed;
}

test('센터장·관리자는 신규 직원을 한 번의 승인으로 적용한다', async () => {
  const seed = seedTwo();
  seed['users/new1'] = { userId: 'new1', name: '신입', role: '입력자', approved: false, active: true };
  const { db, fns } = build(seed);

  const data = { userId: 'new1', role: '팀장', isAdmin: false };
  const out = await fns.approveStaff({ auth: ADMIN, data });

  assert.equal(out.ok, true);
  assert.equal(out.state, 'executed');
  assert.equal(db.docs.get('users/new1').approved, true);
  const authz = db.docs.get('authz/new1');
  assert.equal(authz.role, '팀장');
  assert.equal(authz.enabled, true);
  const history = db.docs.get('staffPrivilegeRequests/request-fixed');
  assert.equal(history.state, 'executed');
  assert.equal(history.mode, 'direct');
  assert.equal(history.approvedBy, 'boss');
});

test('팀장 요청은 대기하고 센터장 승인 한 번으로 적용된다', async () => {
  const seed = withDirector(withLeader(seedTwo()));
  seed['users/new1'] = { userId: 'new1', name: '신입', role: '입력자', approved: false, active: true };
  const { db, fns } = build(seed);
  const data = { userId: 'new1', role: '팀장', isAdmin: false };

  const requested = await fns.approveStaff({ auth: { uid: 'leader' }, data });
  assert.equal(requested.state, 'pending');
  assert.equal(db.docs.get('users/new1').approved, false, '센터장 승인 전에 적용됐습니다');
  assert.equal(db.docs.get('staffPrivilegeRequests/request-fixed').requestedBy, 'leader');

  const approved = await fns.approveStaff({ auth: { uid: 'director' }, data });
  assert.equal(approved.state, 'executed');
  assert.equal(db.docs.get('users/new1').approved, true);
  assert.equal(db.docs.get('authz/new1').role, '팀장');
  assert.equal(db.docs.get('staffPrivilegeRequests/request-fixed').approvedBy, 'director');
});

test('직접 승인 중 authz 쓰기가 실패하면 사용자와 이력이 모두 남지 않는다', async () => {
  const { db, fns } = build(seedTwo());
  db.docs.set('users/new1', { userId: 'new1', name: '신입', role: '입력자', approved: false, active: true });
  db.failWrite = (path) => path === 'authz/new1';

  await assert.rejects(
    () => fns.approveStaff({ auth: ADMIN, data: { userId: 'new1', role: '팀장', isAdmin: false } }),
    /쓰기 실패/,
  );
  assert.equal(db.docs.get('users/new1').approved, false, '승인이 반쯤 적용됐습니다');
  assert.equal(db.docs.has('staffPrivilegeRequests/request-fixed'), false);
});

test('기존 2단계 요청은 요청한 관리자도 한 번에 마무리할 수 있다', async () => {
  const seed = seedTwo();
  seed['users/kim'].privilegeChange = {
    requestId: 'request-fixed', role: '팀장', isAdmin: false,
    state: 'pending', requestedBy: 'boss',
  };
  seed['staffPrivilegeRequests/request-fixed'] = {
    requestId: 'request-fixed', targetId: 'kim', role: '팀장', isAdmin: false,
    state: 'pending', requestedBy: 'boss',
  };
  const { db, fns } = build(seed);

  const out = await fns.approveStaff({
    auth: ADMIN, data: { userId: 'kim', role: '팀장', isAdmin: false },
  });

  assert.equal(out.state, 'executed');
  assert.equal(db.docs.get('users/kim').role, '팀장');
  assert.equal(db.docs.get('users/kim').privilegeChange, undefined);
  assert.equal(db.docs.get('staffPrivilegeRequests/request-fixed').state, 'executed');
});

test('본인 계정의 역할은 직접 승인할 수 없다', async () => {
  const { db, fns } = build(seedTwo());
  await assert.rejects(
    () => fns.approveStaff({ auth: ADMIN, data: { userId: 'boss', role: '팀장', isAdmin: true } }),
    (e) => e.code === 'failed-precondition',
  );
  assert.equal(db.docs.get('users/boss').role, '센터장');
});

test('직접 승인도 마지막 시스템 관리자의 관리자 권한은 해제하지 않는다', async () => {
  const { db, fns } = build(withDirector(seedTwo()));
  await assert.rejects(
    () => fns.approveStaff({
      auth: { uid: 'director' },
      data: { userId: 'boss', role: '센터장', isAdmin: false },
    }),
    (e) => e.code === 'failed-precondition' && /마지막 관리자/.test(e.message),
  );
  assert.equal(db.docs.get('users/boss').isAdmin, true);
  assert.equal(db.docs.get('authz/boss').isAdmin, true);
});

test('팀장은 본인이 만든 역할 변경 요청을 취소할 수 있다', async () => {
  const { db, fns } = build(withLeader(seedTwo()));
  const data = { userId: 'kim', role: '팀장', isAdmin: false };
  await fns.approveStaff({ auth: { uid: 'leader' }, data });
  await fns.cancelStaffPrivilegeChange({ auth: { uid: 'leader' }, data: { userId: 'kim' } });
  assert.equal(db.docs.get('users/kim').privilegeChange, undefined);
  assert.equal(db.docs.get('users/kim').role, '담당자');
  const history=db.docs.get('staffPrivilegeRequests/request-fixed');
  assert.equal(history.state, 'cancelled');
  assert.equal(history.cancelledBy, 'leader');
});

test('없는 직원을 승인하면 아무것도 쓰지 않는다', async () => {
  const { db, fns } = build(seedTwo());
  const before = db.commits;
  await assert.rejects(
    () => fns.approveStaff({ auth: ADMIN, data: { userId: 'ghost', role: '담당자' } }),
    (e) => e.code === 'not-found',
  );
  assert.equal(db.commits, before);
  assert.equal(db.docs.has('authz/ghost'), false);
});

test('신규 등록은 입력자·승인대기로 고정하고 비밀번호·authz 를 원자적으로 만든다', async () => {
  const { db, fns } = build(seedTwo());
  const out = await fns.upsertStaff({
    auth: ADMIN,
    data: { userId: 'new2', name: '신입2', role: '담당자', password: 'longenough1' },
  });

  assert.equal(out.okCount, 1, JSON.stringify(out.results));
  assert.equal(db.docs.get('users/new2').name, '신입2');
  assert.equal(db.docs.get('userSecrets/new2').hash, 'h:longenough1');
  assert.equal(db.docs.get('users/new2').role, '입력자');
  assert.equal(db.docs.get('users/new2').approved, false);
  assert.equal(db.docs.get('authz/new2').enabled, false);
  assert.equal(db.docs.get('authz/new2').capSchemaVersion, CAP_SCHEMA_VERSION);
});

test('등록 중 authz 가 실패하면 계정도 비밀번호도 남지 않는다', async () => {
  const { db, fns } = build(seedTwo());
  db.failWrite = (path) => path === 'authz/new2';

  const out = await fns.upsertStaff({
    auth: ADMIN,
    data: { userId: 'new2', name: '신입2', role: '담당자', password: 'longenough1' },
  });

  assert.equal(out.okCount, 0);
  assert.equal(out.results[0].ok, false);
  assert.equal(db.docs.has('users/new2'), false, '권한 없는 계정이 남았습니다');
  assert.equal(db.docs.has('userSecrets/new2'), false);
});

test('한 명이 실패해도 나머지는 저장된다', async () => {
  const { db, fns } = build(seedTwo());
  const out = await fns.upsertStaff({
    auth: ADMIN,
    data: {
      staff: [
        { userId: 'ok1', name: '가', role: '담당자', password: 'longenough1' },
        { userId: 'bad', name: '나', role: '담당자' },            // 신규인데 비밀번호 없음
        { userId: 'ok2', name: '다', role: '담당자', password: 'longenough1' },
      ],
    },
  });

  assert.equal(out.okCount, 2);
  assert.equal(out.failCount, 1);
  assert.match(out.results[1].error, /비밀번호가 필요/);
  assert.equal(db.docs.has('users/ok1'), true);
  assert.equal(db.docs.has('users/bad'), false);
  assert.equal(db.docs.has('users/ok2'), true);
});

test('기존 직원의 일반 정보는 역할을 바꾸지 않을 때만 수정된다', async () => {
  const seed = seedTwo();
  seed['users/kim'].approved = true;
  const { db, fns } = build(seed);

  const out = await fns.upsertStaff({ auth: ADMIN, data: { userId: 'kim', name: '김수정', role: '담당자' } });

  const u = db.docs.get('users/kim');
  assert.equal(out.okCount, 1);
  assert.equal(u.name, '김수정');
  assert.equal(u.approved, true);
  assert.equal(u.active, true);
  assert.equal(db.docs.get('authz/kim').role, '담당자');
  assert.deepEqual(db.docs.get('authz/kim').accessibleClientIds, ['c1'], '담당이 지워졌습니다');
});

test('기존 직원 비밀번호는 일반 정보 저장 경로로 재설정할 수 없다', async () => {
  const seed = seedTwo();
  seed['userSecrets/kim'] = { hash: 'old' };
  const { db, fns } = build(seed);
  const out = await fns.upsertStaff({
    auth: ADMIN,
    data: { userId: 'kim', name: '김담당', role: '담당자', password: 'newpassword1' },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /비밀번호.*변경할 수 없습니다/);
  assert.equal(db.docs.get('userSecrets/kim').hash, 'old');
});

test('퇴사 계정의 이름을 바꿔 UID를 다른 사람에게 재사용할 수 없다', async () => {
  const seed = seedTwo();
  seed['users/kim'].active = false;
  seed['authz/kim'].enabled = false;
  const { db, fns } = build(seed);
  const out = await fns.upsertStaff({
    auth: ADMIN,
    data: { userId: 'kim', name: '새 사람', role: '담당자', team: '새 팀' },
  });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /UID.*재사용/);
  assert.equal(db.docs.get('users/kim').name, '김담당');
  assert.equal(db.docs.get('users/kim').active, false);
});

test('upsertStaff로 기존 직원의 역할이나 관리자 자격을 직접 바꿀 수 없다', async () => {
  const { db, fns } = build(seedTwo());
  const out = await fns.upsertStaff({ auth: ADMIN, data: { userId: 'kim', name: '김담당', role: '팀장' } });
  assert.equal(out.okCount, 0);
  assert.match(out.results[0].error, /별도 승인/);
  assert.equal(db.docs.get('users/kim').role, '담당자');
});

// ─────────────────────────────────────────────
// 삭제
// ─────────────────────────────────────────────

test('직원 삭제는 UID와 이력 보존을 위해 항상 거부된다', async () => {
  const seed = seedTwo();
  seed['userSecrets/kim'] = { hash: 'x' };
  seed['clients/c1'] = { name: '입주자1', userIds: 'other', teamLeader: 'boss' };
  const { db, fns } = build(seed);

  await assert.rejects(
    () => fns.deleteStaff({ auth: ADMIN, data: { userId: 'kim' } }),
    (e) => e.code === 'failed-precondition' && /삭제하지 않습니다/.test(e.message),
  );
  assert.equal(db.docs.has('users/kim'), true);
  assert.equal(db.docs.has('authz/kim'), true);
  assert.equal(db.docs.has('userSecrets/kim'), true);
});

test('본인 계정은 삭제할 수 없다', async () => {
  const { db, fns } = build(seedTwo());
  await assert.rejects(
    () => fns.deleteStaff({ auth: ADMIN, data: { userId: 'boss' } }),
    (e) => e.code === 'failed-precondition',
  );
  assert.equal(db.docs.has('users/boss'), true);
});

// ─────────────────────────────────────────────
// 호출자 권한
// ─────────────────────────────────────────────

test('팀장 미만은 직원 관리를 할 수 없다', async () => {
  const { fns } = build(seedTwo());
  const staff = { uid: 'kim' };
  for (const [name, data] of [
    ['setStaffActive', { userId: 'boss', active: false }],
    ['upsertStaff', { userId: 'x', name: 'x', role: '입력자', password: 'longenough1' }],
    ['deleteStaff', { userId: 'boss' }],
    ['approveStaff', { userId: 'boss', role: '입력자' }],
    ['cancelStaffPrivilegeChange', { userId: 'boss' }],
  ]) {
    await assert.rejects(
      () => fns[name]({ auth: staff, data }),
      (e) => e.code === 'permission-denied',
      `${name} 가 담당자에게 열려 있습니다`,
    );
  }
});

test('센터장은 시스템 관리자 요청 없이 역할을 직접 승인한다', async () => {
  const seed = seedTwo();
  seed['authz/lead'] = authzOf('lead', '센터장', false);
  const { db, fns } = build(seed);
  const lead = { uid: 'lead' };
  const out = await fns.approveStaff({
    auth: lead, data: { userId: 'kim', role: '센터장' },
  });
  assert.equal(out.state, 'executed');
  assert.equal(db.docs.get('authz/kim').role, '센터장');
});

test('센터장은 관리자 플래그도 한 번의 승인으로 부여한다', async () => {
  const seed = seedTwo();
  seed['authz/lead'] = authzOf('lead', '센터장', false);   // isAdmin 아님
  const { db, fns } = build(seed);
  const lead = { uid: 'lead' };
  const out = await fns.approveStaff({
    auth: lead, data: { userId: 'kim', role: '담당자', isAdmin: true },
  });
  assert.equal(out.state, 'executed');
  assert.equal(db.docs.get('users/kim').isAdmin, true);
});

// ─────────────────────────────────────────────
// 구조 — 위 테스트가 덮지 못하는 **앞으로의** 실수
//
// 위 검사들은 지금 있는 네 개의 콜러블만 본다. 나중에 다섯 번째가 추가되면서
// db.batch() 로 users 를 쓰면 아무도 못 잡는다. 그래서 "이 파일의 모든 쓰기는
// tx 를 거친다"를 파일 자체에 대고 확인한다.
//
// 이 검사가 잡지 못하는 것: tx 로 users 를 쓰면서 authz 쓰기를 빠뜨리는 것.
// 그건 위의 동작 검사가 콜러블마다 잡는다 — 새 콜러블에는 새 검사가 필요하다.
// ─────────────────────────────────────────────

test('staff-fns 의 모든 쓰기가 트랜잭션을 거친다', () => {
  const src = readFileSync(new URL('../functions/staff-fns.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const direct = [...src.matchAll(/(\w+)\.(set|update|delete|batch|commit)\s*\(/g)]
    .filter((m) => m[1] !== 'tx' && m[1] !== 'FieldValue')
    .map((m) => `${m[1]}.${m[2]}(`);

  assert.deepEqual(
    direct, [],
    '트랜잭션 밖에서 쓰고 있습니다 — users 와 authz 가 따로 커밋되면 부분 상태가 남습니다: '
    + direct.join(', '),
  );
});

test('authz 쓰기 헬퍼를 거치지 않는 경로가 없다', () => {
  // writeAuthz 는 authz 쓰기의 유일한 입구다. tx.set 이 authz 컬렉션을
  // 직접 겨냥하면 caps 계산을 건너뛸 수 있다.
  const src = readFileSync(new URL('../functions/staff-fns.js', import.meta.url), 'utf8');
  const bypass = [...src.matchAll(/tx\.set\(\s*db\.collection\(\s*AUTHZ/g)];
  assert.equal(bypass.length, 0, 'authz 를 writeAuthz 없이 직접 쓰고 있습니다');
});

