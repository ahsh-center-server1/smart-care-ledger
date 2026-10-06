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

// 신규 등록은 settings.client 로 판정한다. assignments.manage 만으로 열리면
// "담당을 배정할 수 있는 사람"과 "입주자를 만들 수 있는 사람"이 같아진다 —
// 그 둘은 별개다. 코드가 두 권한을 따로 확인하는지 본다.
test('입주자 신규 등록은 settings.client 를 따로 확인한다', async () => {
  const { db, fns } = build();
  // 담당 배정 권한은 있지만 settings.client 가 없는 주체.
  db.docs.set('authz/assigner', {
    ...authz('assigner', '팀장', ['c1'], ['c1']),
    // fixedCan 은 role 로 판정하므로, 권한을 떼려면 역할을 지운다.
    role: '', isAdmin: false,
  });
  await assert.rejects(() => fns.saveClient({
    auth: { uid: 'assigner' },
    data: { clientId: 'new-client', fields: { name: '새 입주자' } },
  }), (e) => e.code === 'permission-denied');
  assert.equal(db.docs.has('clients/new-client'), false);
});

test('이름 없는 입주자는 만들 수 없다', async () => {
  const { db, fns } = build();
  await assert.rejects(() => fns.saveClient({
    auth: { uid: 'center' }, data: { clientId: 'new-client', staffUids: ['staff1'] },
  }), (e) => e.code === 'invalid-argument');
  assert.equal(db.docs.has('clients/new-client'), false);
});

test('센터장은 입주자를 등록하고 담당까지 함께 배정한다', async () => {
  const { db, fns } = build();
  await fns.saveClient({
    auth: { uid: 'center' },
    data: { clientId: 'new-client', fields: { name: '새 입주자' }, staffUids: ['staff1'] },
  });
  assert.equal(db.docs.get('clients/new-client').name, '새 입주자');
  assert.equal(db.docs.get('clients/new-client').userIds, 'staff1');
  // 투영본이 같은 트랜잭션에서 따라와야 담당자 화면에 곧바로 보인다.
  assert.deepEqual(db.docs.get('authz/staff1').accessibleClientIds, ['new-client']);
});

// 팀장의 담당 범위는 leaderClientIds 다. 본인을 팀장으로 넣지 않으면 방금
// 만든 입주자가 곧바로 본인에게 안 보인다 — 만들자마자 사라지는 셈이다.
test('팀장이 등록한 입주자는 본인이 담당 팀장이 된다', async () => {
  const { db, fns } = build();
  await fns.saveClient({
    auth: { uid: 'leader' },
    data: { clientId: 'new-client', fields: { name: '새 입주자' }, staffUids: ['staff1'] },
  });
  assert.equal(db.docs.get('clients/new-client').teamLeader, 'leader');
  assert.deepEqual(db.docs.get('authz/leader').leaderClientIds, ['c1', 'new-client']);
});

test('팀장은 등록하면서 다른 사람을 담당 팀장으로 앉힐 수 없다', async () => {
  const { db, fns } = build();
  await assert.rejects(() => fns.saveClient({
    auth: { uid: 'leader' },
    data: { clientId: 'new-client', fields: { name: '새 입주자' }, leaderUid: 'other' },
  }), (e) => e.code === 'permission-denied');
  assert.equal(db.docs.has('clients/new-client'), false);
});

test('기본정보 수정은 settings.client 가 있어야 한다', async () => {
  const { db, fns } = build();
  await fns.saveClient({
    auth: { uid: 'leader' }, data: { clientId: 'c1', fields: { name: '고친 이름' } },
  });
  assert.equal(db.docs.get('clients/c1').name, '고친 이름');
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
