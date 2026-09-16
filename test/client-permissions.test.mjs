import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, FieldValue, FakeHttpsError, silentLogger } from './helpers/fake-firestore.mjs';

const require = createRequire(import.meta.url);
const clientFns = require('../functions/client-fns.js');

function authz(uid, role, clients = [], leaders = []) {
  return {
    uid, role, isAdmin: false, enabled: true,
    accessibleClientIds: clients, leaderClientIds: leaders,
  };
}

function build() {
  const db = makeDb({
    'authz/leader': authz('leader', '팀장', ['c1'], ['c1']),
    'authz/center': authz('center', '센터장', ['c1', 'c9']),
    'users/staff1': { userId: 'staff1', role: '담당자', active: true },
    'users/leader': { userId: 'leader', role: '팀장', active: true },
    'users/other': { userId: 'other', role: '팀장', active: true },
    'clients/c1': { name: '내 입주자', userIds: '', teamLeader: 'leader', revision: 1 },
    'clients/c9': { name: '다른 입주자', userIds: '', teamLeader: 'other', revision: 1 },
  });
  const fns = clientFns({
    db, callable: (_name, handler) => handler, HttpsError: FakeHttpsError,
    logger: silentLogger, FieldValue, randomId: () => 'change-1',
  });
  return { db, fns };
}

test('팀장은 본인이 지정 팀장인 입주자의 담당만 변경한다', async () => {
  const { db, fns } = build();
  await fns.saveClient({
    auth: { uid: 'leader' },
    data: { clientId: 'c1', staffUids: ['staff1'], leaderUid: 'leader' },
  });
  assert.equal(db.docs.get('clients/c1').userIds, 'staff1');
  assert.deepEqual(db.docs.get('authz/staff1').accessibleClientIds, ['c1']);
  assert.deepEqual(db.docs.get('assignmentChanges/change-1').before, {
    staffUids: [], leaderUid: 'leader',
  });
  assert.deepEqual(db.docs.get('assignmentChanges/change-1').after, {
    staffUids: ['staff1'], leaderUid: 'leader',
  });
  assert.equal(db.docs.get('assignmentChanges/change-1').changedBy, 'leader');
});

test('팀장은 다른 팀장의 입주자 담당을 바꾸거나 빼앗을 수 없다', async () => {
  const { db, fns } = build();
  await assert.rejects(() => fns.saveClient({
    auth: { uid: 'leader' },
    data: { clientId: 'c9', staffUids: ['staff1'], leaderUid: 'leader' },
  }), (e) => e.code === 'permission-denied');
  assert.equal(db.docs.get('clients/c9').teamLeader, 'other');
});

test('팀장은 자기 담당 입주자의 담당 직원만 바꾸고 담당 팀장은 바꿀 수 없다', async () => {
  const { db, fns } = build();
  await assert.rejects(() => fns.saveClient({
    auth: { uid: 'leader' },
    data: { clientId: 'c1', staffUids: ['staff1'], leaderUid: 'other' },
  }), (e) => e.code === 'permission-denied');
  assert.equal(db.docs.get('clients/c1').teamLeader, 'leader');
  assert.equal(db.docs.has('assignmentChanges/change-1'), false);
});

test('담당 배정 권한은 입주자 기본정보 수정이나 신규 등록을 포함하지 않는다', async () => {
  const { db, fns } = build();
  await assert.rejects(() => fns.saveClient({
    auth: { uid: 'leader' }, data: { clientId: 'c1', fields: { name: '변조' } },
  }), (e) => e.code === 'permission-denied');
  await assert.rejects(() => fns.saveClient({
    auth: { uid: 'center' }, data: { clientId: 'new-client', staffUids: ['staff1'] },
  }), (e) => e.code === 'failed-precondition');
  assert.equal(db.docs.get('clients/c1').name, '내 입주자');
  assert.equal(db.docs.has('clients/new-client'), false);
});

test('센터장은 모든 입주자의 담당 배정을 변경할 수 있다', async () => {
  const { db, fns } = build();
  await fns.saveClient({
    auth: { uid: 'center' },
    data: { clientId: 'c9', staffUids: ['staff1'], leaderUid: 'other' },
  });
  assert.equal(db.docs.get('clients/c9').userIds, 'staff1');
});

test('입주자 활성 상태 변경과 물리 삭제는 보존 절차가 마련될 때까지 닫혀 있다', async () => {
  const { db, fns } = build();
  await assert.rejects(() => fns.setClientActive({
    auth: { uid: 'center' }, data: { clientId: 'c1', active: false },
  }), (e) => e.code === 'failed-precondition');
  await assert.rejects(() => fns.deleteClient({
    auth: { uid: 'center' }, data: { clientId: 'c1' },
  }), (e) => e.code === 'failed-precondition');
  assert.equal(db.docs.has('clients/c1'), true);
});
