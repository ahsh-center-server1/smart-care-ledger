'use strict';

/**
 * 입주자 관리 콜러블 — 등록·수정 · 재직 전환 · 삭제.
 *
 * 왜 서버로 옮겼나
 *   담당 배정은 clients 원본과 두 투영본(authz.accessibleClientIds ·
 *   clientAccess 의 members)을 **함께** 바꿔야 한다. 브라우저가 clients 를
 *   직접 쓰면 투영본을 갱신할 수 없고, 트리거로 뒤따라 갱신하면 해제된
 *   사용자가 그 창 동안 계속 접근한다(Firestore 트리거는 순서도 시각도
 *   보장하지 않는다).
 *
 *   그래서 세 문서를 한 트랜잭션에서 쓴다. 전부 성공하거나 전부 적용되지
 *   않으므로 "회수를 먼저" 같은 순서 규칙이 필요 없다.
 *
 * 왜 updateClientAssignments 를 흡수했나
 *   입주자 폼은 이름·메모와 담당을 **같은 저장 버튼**으로 다룬다. 두 함수로
 *   나누면 이름만 반영되고 담당은 누락되는 중간 상태가 생긴다. 세 문서를
 *   건드리는 함수가 둘이면 어느 쪽이 원본을 갱신하는지도 흐려진다.
 *
 * 담당 필드의 3상태
 *   staffUids · leaderUid 는 **주지 않으면 바꾸지 않는다.** 화면에서 담당
 *   편집 권한이 없는 사용자는 그 필드를 보내지 않고, 그때 빈 값으로 덮어쓰면
 *   동료의 접근권이 통째로 사라진다(원래 merge 로 피하던 문제다).
 */

const {
  AUTHZ, CLIENT_ACCESS, MEMBERS,
  parseStaffIds, planAssignmentChange, assertWritable,
} = require('./authz.cjs');

const CLIENTS = 'clients';
const USERS = 'users';

/** 화면이 바꿀 수 있는 입주자 필드. 여기 없는 것은 무시한다. */
const CLIENT_FIELDS = ['name', 'contact', 'memo'];

module.exports = function clientFns(ctx) {
  const { db, callable, HttpsError, logger, FieldValue } = ctx;

  /**
   * 입주자 관리 권한. caps 스냅샷만 본다 — 등급 계산은 서버가 미리 끝내
   * authz/{uid}.caps 에 심어 두므로, 여기서는 불리언만 읽는다.
   *
   * ⚠️ caps 백필 전에는 문서가 없어 **모든 호출이 거부된다.** 의도된 것이다 —
   *    새 경로는 전제가 갖춰지기 전까지 닫혀 있어야 한다.
   */
  async function requireClientAdmin(auth) {
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const snap = await db.collection(AUTHZ).doc(auth.uid).get();
    if (!snap.exists) {
      throw new HttpsError(
        'failed-precondition',
        '권한 정보가 아직 준비되지 않았습니다. 관리자에게 권한 백필을 요청하세요.',
      );
    }
    const d = snap.data() || {};
    if (d.enabled !== true) throw new HttpsError('permission-denied', '비활성화된 계정입니다.');
    if (!d.caps || d.caps.settingsClient !== true) {
      throw new HttpsError('permission-denied', '입주자 관리 권한이 없습니다.');
    }
    return d;
  }

  /** 지정된 담당자가 실재하고 활성인지. 없는 uid 는 투영본에 유령을 만든다. */
  async function assertUsersExist(uids) {
    const list = [...new Set(uids)].filter(Boolean);
    if (!list.length) return;
    const snaps = await db.getAll(...list.map((uid) => db.collection(USERS).doc(uid)));
    const bad = snaps
      .map((s, i) => ({ uid: list[i], ok: s.exists && s.data().active !== false }))
      .filter((x) => !x.ok)
      .map((x) => x.uid);
    if (bad.length) {
      throw new HttpsError('invalid-argument', `없거나 비활성인 계정입니다: ${bad.join(', ')}`);
    }
  }

  /** 허용 필드만 남긴다. 빈 문자열도 의미가 있으므로(메모 지우기) undefined 만 뺀다. */
  function pickFields(raw) {
    const out = {};
    for (const key of CLIENT_FIELDS) {
      if (raw && raw[key] !== undefined) out[key] = String(raw[key]);
    }
    return out;
  }

  /** 담당·투영본 쓰기를 트랜잭션에 실어 준다. */
  function writeProjection(tx, clientId, plan) {
    for (const op of plan.memberOps) {
      const ref = db.collection(CLIENT_ACCESS).doc(clientId).collection(MEMBERS).doc(op.uid);
      if (op.op === 'delete') tx.delete(ref);
      else {
        tx.set(ref, {
          uid: op.uid, isStaff: op.isStaff, isLeader: op.isLeader,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
    for (const op of plan.accessOps) {
      // set(merge) 인 이유: 백필 전 사용자는 authz 문서가 없을 수 있고,
      // update 는 없는 문서에 실패한다. 여기서 만들어지는 문서에는 caps 가
      // 없으므로 권한은 여전히 전부 거부된다.
      tx.set(db.collection(AUTHZ).doc(op.uid), {
        uid: op.uid,
        accessibleClientIds: op.op === 'add'
          ? FieldValue.arrayUnion(clientId)
          : FieldValue.arrayRemove(clientId),
      }, { merge: true });
    }
  }

  // ───────────────────────────────────────────────────────────
  // saveClient — 등록·수정 (담당 변경을 포함할 수 있다)
  // ───────────────────────────────────────────────────────────
  const saveClient = callable('saveClient', async (request) => {
    const auth = request.auth;
    await requireClientAdmin(auth);

    const d = request.data || {};
    const clientId = String(d.clientId || '').trim();
    if (!clientId) throw new HttpsError('invalid-argument', '입주자 아이디가 필요합니다.');

    const fields = pickFields(d.fields);
    if (d.fields && d.fields.name !== undefined && !fields.name) {
      throw new HttpsError('invalid-argument', '이름이 비어 있습니다.');
    }

    // 3상태 — 주지 않으면 바꾸지 않는다.
    const changeStaff = Array.isArray(d.staffUids);
    const changeLeader = d.leaderUid !== undefined;
    const nextStaff = changeStaff ? parseStaffIds(d.staffUids) : null;
    const nextLeader = changeLeader ? String(d.leaderUid || '').trim() : null;

    if (changeStaff || changeLeader) {
      await assertUsersExist([...(nextStaff || []), ...(nextLeader ? [nextLeader] : [])]);
    }

    const clientRef = db.collection(CLIENTS).doc(clientId);

    const result = await db.runTransaction(async (tx) => {
      // 규약상 읽기를 먼저 전부 끝내고 그 다음에 쓴다.
      const snap = await tx.get(clientRef);
      const cur = snap.exists ? (snap.data() || {}) : null;
      const created = !snap.exists;

      // 신규 등록인데 담당을 주지 않았으면 만든 사람을 담당으로 넣는다.
      // 담당이 없는 입주자는 만든 사람 화면에도 보이지 않아 막다른 길이 된다.
      const staff = changeStaff ? nextStaff
        : (created ? [auth.uid] : parseStaffIds(cur.userIds));
      const leader = changeLeader ? nextLeader
        : (created ? '' : String((cur && cur.teamLeader) || '').trim());

      const plan = assertWritableOrThrow(planAssignmentChange({
        clientId,
        prev: {
          staff: created ? [] : parseStaffIds(cur.userIds),
          leader: created ? '' : String((cur && cur.teamLeader) || '').trim(),
        },
        next: { staff, leader },
      }));

      // ── 여기서부터 쓰기 ──
      tx.set(clientRef, {
        ...fields,
        userIds: staff.join(','),
        teamLeader: leader,
        ...(created ? { active: true, createdAt: FieldValue.serverTimestamp() } : {}),
        // revision 은 정합성 복구 작업의 낙관적 락이다.
        revision: FieldValue.increment(1),
      }, { merge: true });

      writeProjection(tx, clientId, plan);

      return { created, writeCount: plan.writeCount, affected: plan.affectedUids.length };
    });

    logger.info('[saveClient] 완료', { clientId, ...result });
    return result;
  });

  // ───────────────────────────────────────────────────────────
  // setClientActive — 활성·비활성 전환
  //
  // 담당 관계는 건드리지 않는다. 비활성 입주자를 다시 켤 때 담당을 다시
  // 입력하게 만들면 실수로 담당이 비는 상태가 생긴다.
  // ───────────────────────────────────────────────────────────
  const setClientActive = callable('setClientActive', async (request) => {
    await requireClientAdmin(request.auth);

    const d = request.data || {};
    const clientId = String(d.clientId || '').trim();
    const active = d.active === true;
    if (!clientId) throw new HttpsError('invalid-argument', '입주자 아이디가 필요합니다.');

    const ref = db.collection(CLIENTS).doc(clientId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', '입주자를 찾을 수 없습니다.');

    await ref.update({ active, revision: FieldValue.increment(1) });
    return { ok: true, active };
  });

  // ───────────────────────────────────────────────────────────
  // deleteClient — 삭제
  //
  // ⚠️ 거래·계좌는 함께 지우지 않는다(기존 동작 유지). 그래서 삭제된 입주자의
  //    거래가 남는다 — 이 프로젝트의 선행 문제이고 별도 과제다. 여기서는
  //    적어도 **투영본은 정리**해 유령 접근권이 남지 않게 한다.
  // ───────────────────────────────────────────────────────────
  const deleteClient = callable('deleteClient', async (request) => {
    await requireClientAdmin(request.auth);

    const clientId = String((request.data && request.data.clientId) || '').trim();
    if (!clientId) throw new HttpsError('invalid-argument', '입주자 아이디가 필요합니다.');

    const ref = db.collection(CLIENTS).doc(clientId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', '입주자를 찾을 수 없습니다.');

    const cur = snap.data() || {};
    const touched = new Set(parseStaffIds(cur.userIds));
    const leader = String(cur.teamLeader || '').trim();
    if (leader) touched.add(leader);

    // 접근 근거를 **먼저** 끊는다. 원본보다 앞서는 이유는 규칙이 보는 것이
    // authz 이기 때문이다 — 중간에 실패해도 접근은 막힌 상태로 남는다.
    const batch = db.batch();
    for (const uid of touched) {
      batch.set(db.collection(AUTHZ).doc(uid), {
        accessibleClientIds: FieldValue.arrayRemove(clientId),
      }, { merge: true });
      batch.delete(db.collection(CLIENT_ACCESS).doc(clientId).collection(MEMBERS).doc(uid));
    }
    batch.delete(ref);
    await batch.commit();

    logger.info('[deleteClient] 완료', { clientId, revoked: touched.size });
    return { ok: true, revoked: touched.size };
  });

  /** assertWritable 의 오류를 사용자에게 보이는 형태로. */
  function assertWritableOrThrow(plan) {
    try {
      return assertWritable(plan);
    } catch (err) {
      throw new HttpsError('invalid-argument', err.message);
    }
  }

  return { saveClient, setClientActive, deleteClient };
};
