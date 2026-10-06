'use strict';

const {
  AUTHZ, CLIENT_ACCESS, MEMBERS, isEnabled,
  newAuthzDoc, withCaps, projectAssignments, authzIdentityPatch,
} = require('./authz.cjs');
const { FIXED_POLICY_VERSION, computeFixedCaps } = require('./fixed-role-policy.cjs');

module.exports = function authzFns({ db, callable, HttpsError, logger, FieldValue }) {
  function authzWriteFor(uid, user) {
    const id = String(uid || '').trim();
    if (!id) return null;
    const data = user || {};
    const caps = computeFixedCaps({ ...data, enabled: isEnabled(user) });
    return {
      ref: db.collection(AUTHZ).doc(id),
      data: authzIdentityPatch({ uid: id, user, caps, capSchemaVersion: FIXED_POLICY_VERSION }),
      merge: true,
    };
  }

  async function currentOverride() { return {}; }

  function requireAdmin(snap) {
    if (!snap.exists || !isEnabled(snap.data()) || snap.data().isAdmin !== true) {
      throw new HttpsError('permission-denied', '재직 중인 승인된 관리자만 실행할 수 있습니다.');
    }
  }

  const backfillAuthz = callable('backfillAuthz', async (request) => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const adminRef = db.collection('users').doc(request.auth.uid);
    requireAdmin(await adminRef.get());
    const usersSnap = await db.collection('users').get();
    let users = 0;
    for (const candidate of usersSnap.docs) {
      const written = await db.runTransaction(async (tx) => {
        requireAdmin(await tx.get(adminRef));
        const user = await tx.get(candidate.ref);
        const clients = await tx.get(db.collection('clients'));
        if (!user.exists) return false;
        const projection = projectAssignments(clients.docs.map((d) => ({ ...d.data(), id: d.id })));
        const base = newAuthzDoc({
          ...user.data(), uid: user.id,
          accessibleClientIds: projection.accessByUid.get(user.id) || [],
          leaderClientIds: projection.leaderByUid.get(user.id) || [],
        });
        tx.set(db.collection(AUTHZ).doc(user.id), withCaps(base, computeFixedCaps(base), FIXED_POLICY_VERSION));
        return true;
      });
      if (written) users += 1;
    }

    const clientsSnap = await db.collection('clients').get();
    let members = 0;
    for (const candidate of clientsSnap.docs) {
      members += await db.runTransaction(async (tx) => {
        requireAdmin(await tx.get(adminRef));
        const client = await tx.get(candidate.ref);
        const col = db.collection(CLIENT_ACCESS).doc(candidate.id).collection(MEMBERS);
        const existing = await tx.get(col);
        const projection = projectAssignments(client.exists ? [{ ...client.data(), id: client.id }] : []);
        const list = projection.membersByClient.get(candidate.id) || [];
        if (list.length + existing.size > 400) {
          throw new HttpsError('resource-exhausted', '담당 관계 수가 백필 트랜잭션 한도를 초과했습니다.');
        }
        const keep = new Set(list.map((m) => m.uid));
        for (const old of existing.docs) if (!keep.has(old.id)) tx.delete(old.ref);
        for (const member of list) tx.set(col.doc(member.uid), { ...member, updatedAt: FieldValue.serverTimestamp() });
        return list.length;
      });
    }
    const result = { users, clients: clientsSnap.size, members, capSchemaVersion: FIXED_POLICY_VERSION, overrideKeys: 0 };
    logger.info('[backfillAuthz] 완료', result);
    return result;
  });

  return { backfillAuthz, currentOverride, authzWriteFor };
};
