'use strict';

/**
 * 권한 투영의 Cloud Functions — 담당 배정을 서버가 원자적으로 처리한다.
 *
 * 무엇이 문제였나
 *   담당 직원 변경은 브라우저가 `setDoc(clients/{id}, …, {merge:true})`로
 *   직접 했다(modals.js). 그러면 규칙이 판정할 근거(투영본)를 브라우저가
 *   갱신할 수 없고, 트리거로 뒤따라 갱신하면 **해제된 사용자가 그 창 동안
 *   계속 접근한다.** Firestore 트리거는 순서도 시각도 보장하지 않는다.
 *
 *   그래서 원본(clients)과 투영본(authz · clientAccess)을 **한 트랜잭션**에서
 *   쓴다. 전부 성공하거나 전부 적용되지 않는다 — 부분 반영이 없으므로
 *   "회수를 먼저" 같은 순서 규칙도 필요하지 않다.
 *
 * 왜 지금은 아무도 쓸 수 없나 (의도된 것이다)
 *   호출자 권한을 `authz/{uid}.caps.settingsClient`로 판정한다. caps 백필이
 *   끝나기 전에는 그 문서가 없으므로 **모든 호출이 거부된다.** 새 경로는
 *   전제가 갖춰지기 전까지 닫혀 있어야 한다 — 열어 두고 나중에 잠그는 것보다
 *   닫아 두고 나중에 여는 편이 안전하다.
 *
 *   토큰 클레임(callerRank)으로 판정하지 않는 이유는 그것이 제거 대상이기
 *   때문이다. 여기서 쓰면 계약 테스트의 게이트 A가 통과하지 못한다.
 *
 * index.js에서 헬퍼를 주입받는다. 직접 require하면 순환이 되고
 * admin.initializeApp()이 두 번 불릴 수 있다.
 */

const {
  AUTHZ, CLIENT_ACCESS, MEMBERS,
  newAuthzDoc, withCaps, projectAssignments, authzIdentityPatch,
} = require('./authz.cjs');
const {
  CAP_SCHEMA_VERSION, computeCaps, rankOf, sanitizeOverride,
} = require('./perm-catalog.cjs');

const CLIENTS = 'clients';
const USERS = 'users';
const CONFIG = 'config';
const PERMISSIONS_DOC = 'permissions';

/** 한 번에 커밋할 백필 문서 수. 트랜잭션이 아니라 배치라 500까지 쓸 수 있지만
 *  중단 지점을 촘촘히 남기려고 낮춘다 — 재개 단위가 곧 손실 상한이다. */
const BACKFILL_CHUNK = 100;

module.exports = function authzFns(ctx) {
  const { db, callable, HttpsError, logger, FieldValue } = ctx;

  // ───────────────────────────────────────────────────────────
  // 한 사용자의 권한 스냅샷 — **쓰기를 만들어 주기만 한다**
  //
  // 역할·관리자 플래그·재직 상태가 바뀌면 caps 도 함께 바뀐다. 이것을
  // 빠뜨리면 authz 문서가 낡은 채로 남고 규칙은 그 낡은 값으로 판정한다 —
  // 강등된 사람이 계속 통과하거나, 승진한 사람이 막힌다.
  //
  // 담당 목록(accessibleClientIds)은 건드리지 않는다. 그것은
  // saveClient 와 backfillAuthz 만 바꾼다 — 역할 변경이 담당을 지우면 안 된다.
  // ───────────────────────────────────────────────────────────

  /**
   * users 문서 하나로 authz 에 쓸 **쓰기 한 건**을 만든다. 쓰지는 않는다.
   *
   * 왜 여기서 쓰지 않고 돌려주나
   *   users 쓰기와 authz 쓰기를 따로 커밋하면 그 사이에서 실패했을 때
   *   `users.active=false` 인데 `authz.enabled=true` 가 남는다 — 화면에는
   *   퇴사인데 규칙은 통과시킨다. 순서를 바꾸는 것으로는 못 막는다.
   *   반대로 두면 이번엔 규칙이 막는데 화면은 재직이다.
   *
   *   그래서 호출부가 이 쓰기를 **users 쓰기와 같은 배치·트랜잭션에** 넣는다.
   *   전부 성공하거나 전부 적용되지 않는다. 부분 상태가 만들어질 자리가 없다.
   *
   * override 를 인자로 받는 이유
   *   트랜잭션은 모든 읽기가 모든 쓰기보다 앞서야 한다. 여기서 config 를
   *   읽으면 호출부의 트랜잭션 안에서 읽기 순서를 어기거나, 그 문서까지
   *   잠가서 직원 변경이 서로 직렬화된다. 그래서 호출부가 트랜잭션 **밖에서**
   *   currentOverride() 를 한 번 읽어 넘긴다.
   *
   * @param {string} uid
   * @param {Object} user users 문서 데이터(변경 후의 값)
   * @param {Object} override sanitizeOverride 를 거친 등급 오버라이드
   * @returns {{ref: Object, data: Object, merge: boolean}|null}
   */
  function authzWriteFor(uid, user, override) {
    const id = String(uid || '').trim();
    if (!id) return null;
    const data = user || {};
    const caps = computeCaps(rankOf({ role: data.role, isAdmin: data.isAdmin }), override);
    return {
      ref: db.collection(AUTHZ).doc(id),
      // merge 로 쓴다 — accessibleClientIds 를 보존해야 한다. set 으로 덮으면
      // 담당 목록이 사라지고 그 사람은 자기 입주자를 못 보게 된다.
      data: authzIdentityPatch({ uid: id, user: data, caps, capSchemaVersion: CAP_SCHEMA_VERSION }),
      merge: true,
    };
  }

  // ───────────────────────────────────────────────────────────
  // 백필 — 기존 사용자에게 authz 문서를 만든다
  //
  // 이것이 끝나기 전에는 updateClientAssignments 를 포함한 새 경로가 전부
  // 거부된다(caps 가 없으므로). 규칙 잠금보다 **먼저** 돌려야 하고,
  // 그 순서를 뒤집으면 전원이 차단된다.
  // ───────────────────────────────────────────────────────────

  /** 현재 유효한 오버라이드. 문서가 없거나 형식이 다르면 빈 값(기본 등급표). */
  async function currentOverride() {
    const snap = await db.collection(CONFIG).doc(PERMISSIONS_DOC).get();
    return sanitizeOverride(snap.exists ? snap.data() : null);
  }

  /**
   * backfillAuthz — 전 사용자의 authz 문서와 clientAccess 멤버를 다시 만든다.
   *
   * 왜 재계산인가
   *   증분으로 고치면 어긋난 부분을 찾아야 하는데, 어긋났다는 것 자체를
   *   모르는 상태에서 시작한다. 원본(users · clients)에서 통째로 다시 만들면
   *   드리프트가 구조적으로 불가능해진다. 두 컬렉션 모두 작다.
   *
   * 왜 트랜잭션이 아닌가
   *   사용자 수십 명 × (authz 1 + 멤버 N) 이면 500 쓰기를 넘길 수 있다.
   *   그래서 배치로 나눠 쓰고, 중단되면 다시 돌린다 — **멱등**하므로
   *   몇 번을 돌려도 결과가 같다.
   *
   * 권한
   *   caps 가 아직 없는 상태에서 도는 함수라 caps 로 판정할 수 없다.
   *   그래서 users 문서의 isAdmin 을 본다. 이 함수만의 예외이고,
   *   백필이 끝난 뒤에는 다른 모든 경로가 caps 를 쓴다.
   */
  const backfillAuthz = callable('backfillAuthz', async (request) => {
    const auth = request.auth;
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const me = await db.collection(USERS).doc(auth.uid).get();
    if (!me.exists || me.data().isAdmin !== true) {
      throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
    }

    const [usersSnap, clientsSnap, override] = await Promise.all([
      db.collection(USERS).get(),
      db.collection(CLIENTS).get(),
      currentOverride(),
    ]);

    const clients = clientsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const { accessByUid, membersByClient } = projectAssignments(clients);

    // ── authz 문서 ──
    let writes = [];
    const flush = async () => {
      if (!writes.length) return;
      const batch = db.batch();
      for (const w of writes) {
        if (w.op === 'delete') batch.delete(w.ref);
        else batch.set(w.ref, w.data, w.merge ? { merge: true } : undefined);
      }
      await batch.commit();
      writes = [];
    };
    const push = async (w) => {
      writes.push(w);
      if (writes.length >= BACKFILL_CHUNK) await flush();
    };

    let users = 0;
    for (const doc of usersSnap.docs) {
      const u = doc.data() || {};
      const base = newAuthzDoc({
        uid: doc.id,
        role: u.role,
        isAdmin: u.isAdmin,
        approved: u.approved,
        active: u.active,
        accessibleClientIds: accessByUid.get(doc.id) || [],
      });
      // 등급은 users 문서에서 나온다 — 토큰 클레임을 보지 않는다(제거 대상).
      const caps = computeCaps(rankOf({ role: u.role, isAdmin: u.isAdmin }), override);
      await push({
        op: 'set',
        ref: db.collection(AUTHZ).doc(doc.id),
        data: withCaps(base, caps, CAP_SCHEMA_VERSION),
      });
      users += 1;
    }

    // ── clientAccess 멤버 ──
    // 기존 멤버를 먼저 지우고 다시 만든다. merge 로 덮으면 담당에서 빠진
    // 사람이 유령으로 남고, 그것은 결재 화면에서만 드러난다.
    let members = 0;
    for (const [clientId, list] of membersByClient) {
      const col = db.collection(CLIENT_ACCESS).doc(clientId).collection(MEMBERS);
      const existing = await col.get();
      const keep = new Set(list.map((m) => m.uid));
      for (const d of existing.docs) {
        if (!keep.has(d.id)) await push({ op: 'delete', ref: d.ref });
      }
      for (const m of list) {
        await push({
          op: 'set',
          ref: col.doc(m.uid),
          data: {
            uid: m.uid,
            isStaff: m.isStaff,
            isLeader: m.isLeader,
            updatedAt: FieldValue.serverTimestamp(),
          },
        });
        members += 1;
      }
    }

    await flush();

    const result = {
      users,
      clients: clients.length,
      members,
      capSchemaVersion: CAP_SCHEMA_VERSION,
      overrideKeys: Object.keys(override).length,
    };
    logger.info('[backfillAuthz] 완료', result);
    return result;
  });

  return { backfillAuthz, currentOverride, authzWriteFor };
};
