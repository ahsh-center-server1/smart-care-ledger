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
  parseStaffIds, planAssignmentChange, assertWritable,
  newAuthzDoc, withCaps, projectAssignments,
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

  /**
   * 호출자가 담당 배정을 바꿀 수 있는가.
   *
   * caps 스냅샷만 본다. 등급 계산을 하지 않는 이유는 권한 카탈로그가
   * public/domain/perm-catalog.js에 있고 그것은 functions/ 배포에 포함되지
   * 않기 때문이다 — 서버가 caps를 미리 계산해 두고 여기서는 읽기만 한다.
   */
  async function requireClientAdmin(auth) {
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const snap = await db.collection(AUTHZ).doc(auth.uid).get();
    if (!snap.exists) {
      // 백필 전 상태. 무엇이 없는지 알려주지 않으면 "왜 안 되는지" 알 수 없다.
      throw new HttpsError(
        'failed-precondition',
        '권한 정보가 아직 준비되지 않았습니다. 관리자에게 권한 백필을 요청하세요.',
      );
    }
    const d = snap.data() || {};
    if (d.enabled !== true) {
      throw new HttpsError('permission-denied', '비활성화된 계정입니다.');
    }
    const caps = d.caps;
    if (!caps || caps.settingsClient !== true) {
      throw new HttpsError('permission-denied', '입주자 관리 권한이 없습니다.');
    }
    return d;
  }

  /** 입력 정리 — 문자열 하나만 와도, 배열이 와도 같은 형태로 만든다. */
  function readInput(data) {
    const clientId = String((data && data.clientId) || '').trim();
    if (!clientId) throw new HttpsError('invalid-argument', '입주자를 지정하세요.');
    return {
      clientId,
      staff: parseStaffIds(data && data.staffUids),
      leader: String((data && data.leaderUid) || '').trim(),
      // 담당과 함께 저장되는 표시용 필드. 없으면 건드리지 않는다.
      patch: (data && data.patch) || null,
    };
  }

  /**
   * updateClientAssignments — 담당 직원과 담당 팀장을 한 번에 바꾼다.
   *
   * 둘을 함께 받는 이유: 입주자 폼이 둘을 같은 저장 버튼으로 다룬다. 따로
   * 처리하면 담당자만 반영되고 팀장은 누락되는 중간 상태가 생긴다.
   */
  const updateClientAssignments = callable('updateClientAssignments', async (request) => {
    await requireClientAdmin(request.auth);
    const input = readInput(request.data);

    // 존재하는 활성 계정만 담당으로 지정할 수 있다. 없는 uid를 넣으면
    // 투영본에 유령 문서가 생기고, 그것은 화면에서만 드러난다.
    const wanted = [...new Set([...input.staff, ...(input.leader ? [input.leader] : [])])];
    if (wanted.length) {
      const refs = wanted.map((uid) => db.collection(USERS).doc(uid));
      const snaps = await db.getAll(...refs);
      const bad = snaps
        .map((s, i) => ({ uid: wanted[i], ok: s.exists && s.data().active !== false }))
        .filter((x) => !x.ok)
        .map((x) => x.uid);
      if (bad.length) {
        throw new HttpsError(
          'invalid-argument',
          `없거나 비활성인 계정입니다: ${bad.join(', ')}`,
        );
      }
    }

    const clientRef = db.collection(CLIENTS).doc(input.clientId);

    const result = await db.runTransaction(async (tx) => {
      // 규약상 **읽기를 먼저 전부** 끝내고 그 다음에 쓴다.
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) {
        throw new HttpsError('not-found', '입주자를 찾을 수 없습니다.');
      }
      const cur = clientSnap.data() || {};

      const plan = assertWritableOrThrow(planAssignmentChange({
        clientId: input.clientId,
        prev: { staff: cur.userIds, leader: cur.teamLeader },
        next: { staff: input.staff, leader: input.leader },
      }));

      // ── 여기서부터 쓰기 ──
      tx.update(clientRef, {
        userIds: input.staff.join(','),
        teamLeader: input.leader,
        // revision은 정합성 복구 작업의 낙관적 락이다. 이벤트의 옛 값을
        // 적용하지 않고 현재 원본을 다시 읽어 비교하는 근거가 된다.
        revision: FieldValue.increment(1),
        ...(input.patch || {}),
      });

      for (const op of plan.memberOps) {
        const ref = db.collection(CLIENT_ACCESS).doc(input.clientId)
          .collection(MEMBERS).doc(op.uid);
        if (op.op === 'delete') tx.delete(ref);
        else {
          tx.set(ref, {
            uid: op.uid,
            isStaff: op.isStaff,
            isLeader: op.isLeader,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      for (const op of plan.accessOps) {
        const ref = db.collection(AUTHZ).doc(op.uid);
        // update가 아니라 set(merge)인 이유: 백필 전 사용자는 authz 문서가
        // 없을 수 있고, update는 없는 문서에 실패한다. 여기서 만들어지는
        // 문서에는 caps가 없으므로 권한은 여전히 전부 거부된다.
        tx.set(ref, {
          uid: op.uid,
          accessibleClientIds: op.op === 'add'
            ? FieldValue.arrayUnion(input.clientId)
            : FieldValue.arrayRemove(input.clientId),
        }, { merge: true });
      }

      return {
        writeCount: plan.writeCount,
        affected: plan.affectedUids.length,
        members: plan.memberOps.length,
        access: plan.accessOps.length,
      };
    });

    logger.info('[updateClientAssignments] 완료', {
      clientId: input.clientId, ...result,
    });
    return result;
  });

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

  /** assertWritable의 오류를 사용자에게 보이는 형태로 바꾼다. */
  function assertWritableOrThrow(plan) {
    try {
      return assertWritable(plan);
    } catch (err) {
      throw new HttpsError('invalid-argument', err.message);
    }
  }

  return { updateClientAssignments, backfillAuthz };
};
