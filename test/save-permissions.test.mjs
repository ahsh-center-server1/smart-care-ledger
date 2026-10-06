import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FakeHttpsError } from './helpers/fake-firestore.mjs';
const require = createRequire(import.meta.url);
const permissionsFns = require('../functions/permissions-fns.js');

for (const auth of [undefined, { uid: 'staff' }, { uid: 'admin' }]) {
  test('retired permission endpoint rejects without database access: ' + (auth?.uid || 'anonymous'), async () => {
    const { savePermissions } = permissionsFns({
      db: new Proxy({}, { get() { throw new Error('database must not be accessed'); } }),
      callable: (_name, fn) => fn, HttpsError: FakeHttpsError,
    });
    await assert.rejects(savePermissions({ auth, data: { minRank: { 'settings.reset': 1 } } }), { code: 'failed-precondition' });
  });
}
