// test/permissions-refresh.test.mjs
//
// 권한을 새로 고치는 동안 화면이 권한을 잃지 않는가.
//
// 겪은 일: 로그인하면 **빈 화면**이 나오고 새로고침해야 제대로 보였다.
//
//   signInWithCustomToken → onAuthStateChanged 가 깨어남
//   → 관찰자가 세션 복원으로 initPermissions 를 한 번 더 부름
//   → initPermissions 가 맨 앞에서 S.caps 를 null 로 비움
//   → 그 순간이 _enterApp 한가운데 → can() 이 전부 false → 아무것도 안 그려짐
//
// 새로고침하면 관찰자만 도니까(중복 호출 없음) 정상으로 보여서 원인이 가려졌다.
//
// 고친 뒤 계약: **이미 서 있는 권한은 로드 중에 비우지 않는다.** 성공하면
// 통째로 갈아 끼우고, 실패하면 그때 비운다 — 중간 상태가 없다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { S } from '../public/state.js';
import { can, initPermissions } from '../public/modules/permissions.js';

const UID = 'u1';

/**
 * 가짜 Firestore. fb() 는 window._fb 를 그대로 돌려주므로 이것이 이음매다
 * (프로덕션 코드에 테스트 전용 훅을 넣지 않는다).
 * gate 를 주면 응답 시점을 우리가 잡는다 — 로드 **중간**을 관찰하기 위해서다.
 */
function stubFirestore(docData, gate) {
  globalThis.window = {
    _fb: {
      db: {},
      doc: (_db, col, id) => ({ col, id }),
      getDoc: async () => {
        if (gate) await gate;
        return { exists: () => docData !== null, data: () => docData };
      },
    },
  };
}

const READY = {
  role: '담당자', enabled: true, isAdmin: false,
  accessibleClientIds: ['c1'], leaderClientIds: [],
};

test.beforeEach(() => { S.user = { userId: UID, role: '담당자' }; });
test.afterEach(() => {
  delete globalThis.window;
  Object.assign(S, { user: null, authz: null, authzStatus: 'idle', caps: null,
    permOverride: null, accessibleClientIds: [], leaderClientIds: [] });
});

test('처음 세울 때는 fail-closed 로 비운다', async () => {
  // 권한을 모르는 동안 버튼이 보이면 안 된다 — 이 비우기는 의도된 것이다.
  let release;
  const gate = new Promise(r => { release = r; });
  stubFirestore(READY, gate);

  const loading = initPermissions();
  assert.equal(S.authzStatus, 'loading');
  assert.equal(can('trx.create'), false, '로드 중인데 권한이 열려 있습니다');

  release();
  await loading;
  assert.equal(S.authzStatus, 'ready');
  assert.equal(can('trx.create'), true);
});

test('이미 서 있는 권한은 새로 고치는 동안에도 유지된다', async () => {
  // 이것이 빈 화면의 원인이었다. 두 번째 로드가 첫 번째를 비워 버렸다.
  stubFirestore(READY);
  await initPermissions();
  assert.equal(can('trx.create'), true);

  let release;
  const gate = new Promise(r => { release = r; });
  stubFirestore(READY, gate);

  const refreshing = initPermissions();
  // 로드가 끝나기 **전** — 화면이 그려지고 있을 수 있는 시점이다.
  assert.equal(can('trx.create'), true,
    '새로 고치는 동안 권한이 사라졌습니다 — 이 순간에 그리면 빈 화면이 됩니다');
  assert.deepEqual(S.accessibleClientIds, ['c1'],
    '담당 입주자 목록이 비었습니다 — 대시보드가 빈 채로 그려집니다');
  assert.equal(S.authzStatus, 'ready');

  release();
  await refreshing;
  assert.equal(can('trx.create'), true);
});

test('새로 고치다 실패하면 옛 권한을 남기지 않는다', async () => {
  // 강등·퇴사가 반영되지 않으면 안 된다 — 실패는 fail-closed 다.
  stubFirestore(READY);
  await initPermissions();
  assert.equal(can('trx.create'), true);

  stubFirestore(null);   // authz 문서가 사라진 상태
  await assert.rejects(() => initPermissions());

  assert.equal(S.authzStatus, 'error');
  assert.equal(can('trx.create'), false, '실패했는데 옛 권한이 남아 있습니다');
  assert.equal(S.caps, null);
  assert.deepEqual(S.accessibleClientIds, []);
});

test('다른 사람으로 바뀌면 비우고 새로 세운다', async () => {
  // 공용 PC 에서 앞사람 권한이 잠깐이라도 남으면 안 된다.
  stubFirestore(READY);
  await initPermissions();

  S.user = { userId: 'u2', role: '입력자' };
  let release;
  const gate = new Promise(r => { release = r; });
  stubFirestore({ ...READY, role: '입력자' }, gate);

  const loading = initPermissions();
  assert.equal(S.authzStatus, 'loading');
  assert.equal(can('trx.create'), false, '앞사람 권한이 남아 있습니다');

  release();
  await loading;
  assert.equal(S.authz.role, '입력자');
});
