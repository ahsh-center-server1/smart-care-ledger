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
const { fixedCan } = require('./fixed-role-policy.cjs');
const { teamMismatch } = require('./teams.cjs');

const CLIENTS = 'clients';
const USERS = 'users';
const ASSIGNMENT_CHANGES = 'assignmentChanges';

/**
 * 화면이 바꿀 수 있는 입주자 필드. 여기 없는 것은 무시한다.
 *
 * `team` 은 **배정의 틀**이다. 권한을 주지 않고(조회 범위는 여전히 담당
 * 투영본이 정한다), 대신 아래에서 "배정된 사람이 그 팀 사람인가"를 검증한다.
 */
const CLIENT_FIELDS = ['name', 'contact', 'memo', 'team'];

module.exports = function clientFns(ctx) {
  const { db, callable, HttpsError, logger, FieldValue, randomId } = ctx;

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
    if (!fixedCan(d, 'assignments.manage')) {
      throw new HttpsError('permission-denied', '입주자 관리 권한이 없습니다.');
    }
    return d;
  }

  /** 지정된 담당자가 실재하고 활성인지. 없는 uid 는 투영본에 유령을 만든다. */
  function assertUserSnapshots(list, snaps) {
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
    for (const op of plan.leaderOps || []) {
      tx.set(db.collection(AUTHZ).doc(op.uid), {
        uid: op.uid,
        leaderClientIds: op.op === 'add'
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
    const caller = await requireClientAdmin(auth);

    const d = request.data || {};
    const clientId = String(d.clientId || '').trim();
    if (!clientId) throw new HttpsError('invalid-argument', '입주자 아이디가 필요합니다.');

    const fields = pickFields(d.fields);
    if (Object.keys(fields).length && !fixedCan(caller, 'settings.client')) {
      throw new HttpsError('permission-denied', '입주자 기본정보는 이 화면에서 변경할 수 없습니다.');
    }
    if (d.fields && d.fields.name !== undefined && !fields.name) {
      throw new HttpsError('invalid-argument', '이름이 비어 있습니다.');
    }

    // 3상태 — 주지 않으면 바꾸지 않는다.
    const changeStaff = Array.isArray(d.staffUids);
    const changeLeader = d.leaderUid !== undefined;
    const nextStaff = changeStaff ? parseStaffIds(d.staffUids) : null;
    const nextLeader = changeLeader ? String(d.leaderUid || '').trim() : null;

    const assignedUids = [...new Set([
      ...(nextStaff || []), ...(nextLeader ? [nextLeader] : []),
    ])].filter(Boolean);

    const clientRef = db.collection(CLIENTS).doc(clientId);
    const assignmentChangeId = randomId();

    const result = await db.runTransaction(async (tx) => {
      // 규약상 읽기를 먼저 전부 끝내고 그 다음에 쓴다.
      const snap = await tx.get(clientRef);
      const cur = snap.exists ? (snap.data() || {}) : null;
      const created = !snap.exists;
      const actorSnap = await tx.get(db.collection(AUTHZ).doc(auth.uid));
      const assignedSnaps = await Promise.all(
        assignedUids.map((uid) => tx.get(db.collection(USERS).doc(uid))),
      );
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      assertUserSnapshots(assignedUids, assignedSnaps);
      if (!fixedCan(actor, 'assignments.manage')) {
        throw new HttpsError('permission-denied', '담당 배정 권한이 더 이상 유효하지 않습니다.');
      }
      // 신규 등록은 이름이 있어야 한다. 이름 없는 입주자는 목록에서 빈 줄로
      // 나타나고 무엇인지 알 방법이 없다.
      if (created) {
        if (!fixedCan(actor, 'settings.client')) {
          throw new HttpsError('permission-denied', '입주자를 등록할 권한이 없습니다.');
        }
        if (!fields.name) {
          throw new HttpsError('invalid-argument', '입주자 이름을 입력하세요.');
        }
      }

      // 기존 입주자에 대한 팀장 제약. 신규에는 "현재 지정 팀장"이 없으므로
      // 적용할 수 없다 — cur 이 null 이라 여기서 접근하면 터진다.
      if (!created && actor.role === '팀장'
          && String(cur.teamLeader || '').trim() !== String(auth.uid)) {
        throw new HttpsError('permission-denied', '본인이 지정 팀장인 입주자의 담당만 변경할 수 있습니다.');
      }
      if (!created && actor.role === '팀장' && changeLeader
          && nextLeader !== String(cur.teamLeader || '').trim()) {
        throw new HttpsError('permission-denied', '담당 팀장 지정은 센터장만 변경할 수 있습니다.');
      }
      // 팀장이 새로 등록하면 **본인이 그 입주자의 팀장**이 된다. 다른 사람을
      // 팀장으로 앉히는 것은 기존 입주자와 같은 이유로 센터장만 할 수 있다.
      // (이 줄이 없으면 팀장이 만든 입주자가 곧바로 본인에게 안 보인다 —
      //  팀장의 담당 범위는 leaderClientIds 이기 때문이다.)
      if (created && actor.role === '팀장'
          && changeLeader && nextLeader && nextLeader !== String(auth.uid)) {
        throw new HttpsError('permission-denied', '담당 팀장 지정은 센터장만 변경할 수 있습니다.');
      }

      // 신규 등록이면 **이전 상태가 없다.** cur 은 null 이므로 한 번만 풀어
      // 두고 아래에서 재사용한다 — 곳곳에서 cur.userIds 를 직접 읽으면
      // 신규 경로에서 터진다(실제로 그랬다).
      const prevStaff = cur ? parseStaffIds(cur.userIds) : [];
      const prevLeader = String((cur && cur.teamLeader) || '').trim();

      const staff = changeStaff ? nextStaff : prevStaff;
      let leader = changeLeader ? nextLeader : prevLeader;
      // 신규 등록인데 담당을 주지 않았으면 만든 사람을 담당으로 넣는다.
      // 담당이 없는 입주자는 만든 사람 화면에도 보이지 않아 막다른 길이 된다.
      if (created && actor.role === '팀장' && !leader) leader = String(auth.uid);

      // 팀이 정해져 있으면 배정은 그 팀 안에서만 이뤄진다.
      //
      // 화면은 이미 후보를 그 팀으로 좁혀 두지만, **좁히는 것과 막는 것은 다르다** —
      // 콜러블은 직접 부를 수 있다. 팀이 비어 있으면(기존 입주자 전부) 아무것도
      // 막지 않는다: 마이그레이션 없이 살기 위한 선택이다.
      //
      // 이 검사가 보는 것은 **결과 상태**다. 배정을 안 바꾸고 팀만 바꾸는 저장도
      // 있으므로, 이번 요청에 실려 오지 않은 기존 담당의 소속도 읽어서 본다.
      // (읽기는 아직 쓰기 전이어야 한다 — 트랜잭션 규약)
      const nextTeam = fields.team !== undefined
        ? String(fields.team || '').trim()
        : String((cur && cur.team) || '').trim();
      if (nextTeam) {
        const memberUids = [...new Set([...staff, leader].filter(Boolean))];
        const known = new Map(assignedUids.map((uid, i) => [uid,
          assignedSnaps[i].exists ? (assignedSnaps[i].data() || {}) : null]));
        const unknown = memberUids.filter(uid => !known.has(uid));
        const extraSnaps = await Promise.all(
          unknown.map(uid => tx.get(db.collection(USERS).doc(uid))),
        );
        unknown.forEach((uid, i) => {
          known.set(uid, extraSnaps[i].exists ? (extraSnaps[i].data() || {}) : null);
        });
        const wrong = teamMismatch({
          team: nextTeam,
          memberUids,
          users: memberUids
            .filter(uid => known.get(uid))
            .map(uid => ({ userId: uid, team: known.get(uid).team })),
        });
        if (wrong.length) {
          throw new HttpsError('failed-precondition',
            `${nextTeam} 소속이 아닌 담당이 있습니다: ${wrong.join(', ')}`);
        }
      }

      const rawPlan = planAssignmentChange({
        clientId,
        prev: { staff: prevStaff, leader: prevLeader },
        next: { staff, leader },
      });
      const assignmentChanged = rawPlan.memberOps.length > 0
        || rawPlan.accessOps.length > 0
        || rawPlan.leaderOps.length > 0;
      const plan = assertWritableOrThrow({
        ...rawPlan,
        writeCount: rawPlan.writeCount + (assignmentChanged ? 1 : 0),
      });

      // ── 여기서부터 쓰기 ──
      tx.set(clientRef, {
        ...fields,
        userIds: staff.join(','),
        teamLeader: leader,
        // revision 은 정합성 복구 작업의 낙관적 락이다.
        revision: FieldValue.increment(1),
      }, { merge: true });

      writeProjection(tx, clientId, plan);

      if (assignmentChanged) {
        tx.set(db.collection(ASSIGNMENT_CHANGES).doc(assignmentChangeId), {
          changeId: assignmentChangeId,
          clientId,
          before: { staffUids: prevStaff, leaderUid: prevLeader },
          after: { staffUids: staff, leaderUid: leader },
          changedBy: auth.uid,
          changedAt: FieldValue.serverTimestamp(),
        });
      }

      return {
        created,
        writeCount: plan.writeCount,
        affected: plan.affectedUids.length,
        assignmentChangeId: assignmentChanged ? assignmentChangeId : null,
      };
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
    throw new HttpsError(
      'failed-precondition',
      '입주자 활성 상태 변경 절차는 아직 열려 있지 않습니다.',
    );
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
    throw new HttpsError(
      'failed-precondition',
      '입주자와 금융 기록은 삭제하지 않습니다. 별도 보존 절차가 마련될 때까지 비활성·삭제를 할 수 없습니다.',
    );
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
