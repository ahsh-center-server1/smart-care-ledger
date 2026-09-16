import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, FieldValue, FakeHttpsError, silentLogger } from './helpers/fake-firestore.mjs';
const require = createRequire(import.meta.url);
const authzFns = require('../functions/authz-fns.js');
const makeCaller = require('../functions/caller.cjs');
function build(seed = {}) {
  const db = makeDb({ 'users/admin': { role: '', isAdmin: true, active: true, approved: true }, ...seed });
  return { db, ...authzFns({ db, callable: (_name, fn) => fn, HttpsError: FakeHttpsError, FieldValue, logger: silentLogger }) };
}
const request = { auth: { uid: 'admin' } };

test('identity patch keeps assignment arrays and ignores legacy override', async () => {
  const { db, authzWriteFor, currentOverride } = build();
  const w = authzWriteFor('s', { role: '팀장', approved: true, active: true }, { 'trx.create': 1 });
  assert.equal(w.data.caps.trxCreate, false);
  assert.equal('accessibleClientIds' in w.data, false);
  assert.equal('leaderClientIds' in w.data, false);
  assert.equal(authzWriteFor('a', { isAdmin: true }).data.role, '');
  db.collection = () => { throw new Error('must not read config'); };
  assert.deepEqual(await currentOverride(), {});
});

test('backfill re-reads demotion and assignment removal after enumeration', async () => {
  const { db, backfillAuthz } = build({
    'users/u': { role: '센터장', approved: true, active: true },
    'clients/c': { userIds: 'u', teamLeader: 'u' },
  });
  const original = db.runTransaction.bind(db);
  let calls = 0;
  db.runTransaction = async (fn) => {
    if (++calls === 2) {
      db.docs.set('users/u', { role: '입력자', active: false, approved: true });
      db.docs.set('clients/c', { userIds: '', teamLeader: '' });
    }
    return original(fn);
  };
  await backfillAuthz(request);
  const u = db.docs.get('authz/u');
  assert.equal(u.role, '입력자');
  assert.equal(u.enabled, false);
  assert.equal(u.caps.clientViewAll, false);
  assert.deepEqual(u.accessibleClientIds, []);
  assert.deepEqual(u.leaderClientIds, []);
});

test('backfill stops when administrator is deactivated mid-loop', async () => {
  const { db, backfillAuthz } = build({ 'users/u': { role: '담당자' } });
  const original = db.runTransaction.bind(db);
  let calls = 0;
  db.runTransaction = async (fn) => {
    if (++calls === 2) db.docs.set('users/admin', { isAdmin: true, active: false });
    return original(fn);
  };
  await assert.rejects(backfillAuthz(request), { code: 'permission-denied' });
  assert.equal(db.docs.has('authz/u'), false);
});

test('backfill projects separate leader scope and removes stale members', async () => {
  const { db, backfillAuthz } = build({
    'users/u': { role: '팀장' },
    'clients/a': { userIds: 'u' }, 'clients/b': { teamLeader: 'u' },
    'clientAccess/b/members/old': { uid: 'old', isLeader: true },
  });
  await backfillAuthz(request);
  assert.deepEqual(db.docs.get('authz/u').accessibleClientIds, ['a', 'b']);
  assert.deepEqual(db.docs.get('authz/u').leaderClientIds, ['b']);
  assert.equal(db.docs.has('clientAccess/b/members/old'), false);
});

test('caller ignores stale caps and restricts team leaders to explicit leader assignments', async () => {
  const db = makeDb({ 'authz/u': { enabled: true, role: '팀장', isAdmin: true, accessibleClientIds: ['a', 'b'], leaderClientIds: ['b'], caps: { trxCreate: true, clientViewAll: true } } });
  const { requireCaller } = makeCaller({ db, HttpsError: FakeHttpsError });
  const caller = await requireCaller({ uid: 'u' });
  assert.equal(caller.rank, 3);
  assert.equal(caller.can('trx.create'), false);
  assert.equal(caller.sees('a'), false);
  assert.equal(caller.sees('b'), true);
  db.docs.get('authz/u').leaderClientIds = undefined;
  assert.equal((await requireCaller({ uid: 'u' })).sees('b'), false);
});

test('technical-only and invalid identities cannot read business scope from stale arrays', async () => {
  for (const role of ['', '관리자', 'unknown']) {
    const db = makeDb({ 'authz/u': { enabled: true, role, isAdmin: true, accessibleClientIds: ['a'], caps: { clientViewAll: true } } });
    const caller = await makeCaller({ db, HttpsError: FakeHttpsError }).requireCaller({ uid: 'u' });
    assert.equal(caller.rank, 0);
    assert.equal(caller.sees('a'), false);
    assert.equal(caller.can('trx.create'), false);
  }
});
