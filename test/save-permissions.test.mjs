import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, FieldValue, FakeHttpsError, silentLogger } from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const permissionsFns = require('../functions/permissions-fns.js');
const { PERM_CATALOG, capName, CAP_SCHEMA_VERSION } = require('../functions/perm-catalog.cjs');

/**
 * savePermissions — **사용자가 신고한 버그가 고쳐졌는지** 확인한다.
 *
 *   "권한 변경하고 저장해도 반영이 안돼."
 *
 * 원인은 등급표가 두 곳에 있었다는 것이다. 브라우저는 config/permissions 를
 * 읽고, 서버(규칙)는 atLeast(2|3|4) 를 하드코딩했다. 저장은 앞의 문서만
 * 바꿨으므로 집행에는 아무 변화가 없었다.
 *
 * 그래서 여기서 확인하는 것은 "저장됐는가"가 아니라
 * **"규칙이 읽는 값이 바뀌었는가"** 다.
 */

function build(seed) {
  const db = makeDb(seed);
  const { savePermissions } = permissionsFns({
    db,
    callable: (name, handler) => handler,
    HttpsError: FakeHttpsError,
    logger: silentLogger,
    FieldValue,
  });
  return { db, savePermissions };
}

const CAP = (key) => capName(key);
const ADMIN = { uid: 'boss' };

/** 관리자 1 + 담당자 2. 전원 백필된 상태. */
function seedOrg() {
  const caps = (on) => ({ [CAP('trx.reorder')]: on, [CAP('settings.permissions')]: false });
  return {
    'authz/boss': {
      uid: 'boss', enabled: true, capSchemaVersion: CAP_SCHEMA_VERSION,
      caps: { ...caps(true), [CAP('settings.permissions')]: true },
    },
    'authz/kim': { uid: 'kim', enabled: true, capSchemaVersion: CAP_SCHEMA_VERSION, caps: caps(true) },
    'authz/lee': { uid: 'lee', enabled: true, capSchemaVersion: CAP_SCHEMA_VERSION, caps: caps(true) },
    'users/boss': { userId: 'boss', role: '센터장', isAdmin: true },
    'users/kim': { userId: 'kim', role: '담당자' },
    'users/lee': { userId: 'lee', role: '담당자' },
  };
}

// ─────────────────────────────────────────────
// 저장이 집행까지 바꾸는가 — 신고된 버그
// ─────────────────────────────────────────────

test('등급을 올리면 규칙이 읽는 caps 에서도 권한이 사라진다', async () => {
  const { db, savePermissions } = build(seedOrg());

  // trx.reorder 를 담당자(2) → 팀장(3) 으로 올린다
  const out = await savePermissions({ auth: ADMIN, data: { minRank: { 'trx.reorder': 3 } } });

  assert.equal(out.changed, 1);
  assert.equal(db.docs.get('config/permissions').minRank['trx.reorder'], 3);
  assert.equal(db.docs.get('authz/kim').caps[CAP('trx.reorder')], false,
    '등급표만 바뀌고 규칙이 읽는 값은 그대로입니다 — 신고된 버그입니다');
  assert.equal(db.docs.get('authz/lee').caps[CAP('trx.reorder')], false);
  assert.equal(db.docs.get('authz/boss').caps[CAP('trx.reorder')], true, '센터장은 유지돼야 합니다');
});

test('등급을 내리면 caps 에서 권한이 생긴다', async () => {
  const seed = seedOrg();
  seed['users/park'] = { userId: 'park', role: '입력자' };
  seed['authz/park'] = {
    uid: 'park', enabled: true, capSchemaVersion: CAP_SCHEMA_VERSION,
    caps: { [CAP('trx.reorder')]: false },
  };
  const { db, savePermissions } = build(seed);

  await savePermissions({ auth: ADMIN, data: { minRank: { 'trx.reorder': 1 } } });
  assert.equal(db.docs.get('authz/park').caps[CAP('trx.reorder')], true);
});

test('기본값으로 되돌리면 저장 문서에서 항목이 빠진다', async () => {
  const { db, savePermissions } = build(seedOrg());
  await savePermissions({ auth: ADMIN, data: { minRank: { 'trx.reorder': 3 } } });
  assert.deepEqual(Object.keys(db.docs.get('config/permissions').minRank), ['trx.reorder']);

  const def = PERM_CATALOG['trx.reorder'].defaultRank;
  const out = await savePermissions({ auth: ADMIN, data: { minRank: { 'trx.reorder': def } } });
  assert.equal(out.changed, 0);
  assert.deepEqual(db.docs.get('config/permissions').minRank, {});
  assert.equal(db.docs.get('authz/kim').caps[CAP('trx.reorder')], true);
});

test('caps 는 병합이 아니라 교체된다 — 낡은 키가 남지 않는다', async () => {
  const seed = seedOrg();
  seed['authz/kim'].caps.삭제된권한 = true;   // 카탈로그에서 사라진 키
  const { db, savePermissions } = build(seed);

  await savePermissions({ auth: ADMIN, data: { minRank: {} } });
  assert.equal('삭제된권한' in db.docs.get('authz/kim').caps, false,
    'set(merge) 로 쓰면 옛 키가 true 인 채로 남습니다');
});

test('capSchemaVersion 을 함께 올린다', async () => {
  const seed = seedOrg();
  seed['authz/kim'].capSchemaVersion = 0;
  const { db, savePermissions } = build(seed);
  await savePermissions({ auth: ADMIN, data: { minRank: {} } });
  assert.equal(db.docs.get('authz/kim').capSchemaVersion, CAP_SCHEMA_VERSION);
});

// ─────────────────────────────────────────────
// 조용히 무시하지 않는다 — 버그의 다른 얼굴
// ─────────────────────────────────────────────

test('조정할 수 없는 권한을 바꾸려 하면 이름을 대고 거절한다', async () => {
  const { db, savePermissions } = build(seedOrg());
  await assert.rejects(
    () => savePermissions({ auth: ADMIN, data: { minRank: { 'settings.staff': 2 } } }),
    (e) => e.code === 'invalid-argument' && /settings\.staff/.test(e.message),
  );
  assert.equal(db.docs.has('config/permissions'), false, '거절했는데 저장됐습니다');
});

test('조정 불가 권한도 기본값 그대로면 통과한다 (화면이 전체 목록을 보낸다)', async () => {
  const { savePermissions } = build(seedOrg());
  const all = {};
  for (const [k, e] of Object.entries(PERM_CATALOG)) all[k] = e.defaultRank;
  all['trx.reorder'] = 3;

  const out = await savePermissions({ auth: ADMIN, data: { minRank: all } });
  assert.equal(out.changed, 1);
});

test('보안 하한 아래로는 내릴 수 없다', async () => {
  // 하한이 기본값보다 낮은 조정 가능 키를 고른다 — 없으면 이 검사는 무의미하다
  const key = Object.keys(PERM_CATALOG).find(
    (k) => PERM_CATALOG[k].configurable && PERM_CATALOG[k].securityFloor > 1
  );
  if (!key) return;   // 카탈로그가 그런 키를 갖지 않으면 검사할 것이 없다

  const { savePermissions } = build(seedOrg());
  await assert.rejects(
    () => savePermissions({ auth: ADMIN, data: { minRank: { [key]: 1 } } }),
    (e) => e.code === 'invalid-argument' && /보안 하한/.test(e.message),
  );
});

test('없는 키와 이상한 등급은 거절한다', async () => {
  const { savePermissions } = build(seedOrg());
  for (const bad of [{ 'no.such.key': 2 }, { 'trx.reorder': 7 }, { 'trx.reorder': 'abc' }, { 'trx.reorder': 0 }]) {
    await assert.rejects(
      () => savePermissions({ auth: ADMIN, data: { minRank: bad } }),
      (e) => e.code === 'invalid-argument',
      `${JSON.stringify(bad)} 가 통과했습니다`,
    );
  }
});

// ─────────────────────────────────────────────
// 순서와 부분 적용
// ─────────────────────────────────────────────

test('권한을 잃는 사람의 caps 를 먼저 쓴다', async () => {
  // 배치가 여러 개로 나뉘어 중간에 끊겨도, 열린 채로 남는 사람이 없어야 한다.
  const { savePermissions } = build(seedOrg());
  const { __planCapsRewrite } = permissionsFns({
    db: makeDb({}), callable: (n, h) => h,
    HttpsError: FakeHttpsError, logger: silentLogger, FieldValue,
  });

  const users = [
    { uid: 'gain', role: '입력자' },
    { uid: 'lose', role: '담당자' },
    { uid: 'same', role: '센터장' },
  ];
  const current = new Map([
    ['gain', { [CAP('trx.reorder')]: false }],
    ['lose', { [CAP('trx.reorder')]: true }],
    ['same', { [CAP('trx.reorder')]: true }],
  ]);
  const plans = __planCapsRewrite(users, current, { 'trx.reorder': 3 });

  assert.equal(plans[0].uid, 'lose', '회수가 먼저가 아닙니다');
  assert.equal(plans[0].loses, true);
  assert.deepEqual(plans.slice(1).map((p) => p.uid), ['gain', 'same'], '나머지 순서가 흔들립니다');
  void savePermissions;
});

test('authz 문서가 없는 사용자는 조용히 넘기지 않고 보고한다', async () => {
  const seed = seedOrg();
  seed['users/newbie'] = { userId: 'newbie', role: '담당자' };   // authz 없음
  const { db, savePermissions } = build(seed);

  const out = await savePermissions({ auth: ADMIN, data: { minRank: { 'trx.reorder': 3 } } });
  assert.equal(out.missingAuthz, 1, '적용되지 않은 사람을 보고하지 않습니다');
  assert.equal(out.users, 3);
  assert.equal(db.docs.has('authz/newbie'), false, '반쪽짜리 authz 문서를 만들었습니다');
});

test('저장 의도는 caps 재계산보다 먼저 기록된다', async () => {
  // caps 쓰기가 실패해도 config 는 남아야 backfillAuthz 가 같은 결과를 만든다.
  const { db, savePermissions } = build(seedOrg());
  db.failWrite = (path) => path.startsWith('authz/');

  await assert.rejects(
    () => savePermissions({ auth: ADMIN, data: { minRank: { 'trx.reorder': 3 } } }),
    /쓰기 실패/,
  );
  assert.equal(db.docs.get('config/permissions').minRank['trx.reorder'], 3,
    '의도가 남지 않아 백필로도 복구할 수 없습니다');
});

// ─────────────────────────────────────────────
// 호출자 권한
// ─────────────────────────────────────────────

test('권한 관리 권한이 없으면 거부한다', async () => {
  const { db, savePermissions } = build(seedOrg());
  await assert.rejects(
    () => savePermissions({ auth: { uid: 'kim' }, data: { minRank: { 'trx.reorder': 3 } } }),
    (e) => e.code === 'permission-denied',
  );
  assert.equal(db.docs.has('config/permissions'), false);
});

test('백필 전이면 무엇을 해야 하는지 말하고 거부한다', async () => {
  const { savePermissions } = build({ 'users/boss': { userId: 'boss', isAdmin: true } });
  await assert.rejects(
    () => savePermissions({ auth: ADMIN, data: { minRank: {} } }),
    (e) => e.code === 'failed-precondition' && /백필/.test(e.message),
  );
});

test('비활성 계정은 caps 가 남아 있어도 거부한다', async () => {
  const seed = seedOrg();
  seed['authz/boss'].enabled = false;
  const { savePermissions } = build(seed);
  await assert.rejects(
    () => savePermissions({ auth: ADMIN, data: { minRank: {} } }),
    (e) => e.code === 'permission-denied',
  );
});

test('로그인하지 않으면 거부한다', async () => {
  const { savePermissions } = build(seedOrg());
  await assert.rejects(
    () => savePermissions({ data: { minRank: {} } }),
    (e) => e.code === 'unauthenticated',
  );
});
