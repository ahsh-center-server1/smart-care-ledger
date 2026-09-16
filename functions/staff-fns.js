'use strict';

/**
 * 직원 관리 콜러블 — 승인 · 등록/수정 · 재직 전환 · 삭제.
 *
 * 왜 서버에만 있는가
 *   firestore.rules 가 users 컬렉션의 클라이언트 쓰기를 전면 차단한다.
 *   역할·승인·관리자 플래그를 브라우저가 바꿀 수 있으면 개발자도구로
 *   자기 역할을 센터장으로 적으면 그만이다.
 *
 * 왜 전부 트랜잭션인가 — 이 파일의 핵심
 *   직원 문서 하나를 고치면 **두 곳**이 바뀌어야 한다: 화면이 읽는
 *   `users/{uid}` 와 보안 규칙이 읽는 `authz/{uid}`. 이 둘을 따로 커밋하면
 *   그 사이에서 실패했을 때 부분 상태가 남는다:
 *
 *     users 먼저 → 퇴사 처리했는데 authz.enabled 는 true — 규칙이 통과시킨다
 *     authz 먼저 → 규칙은 막는데 users 는 재직 — 화면과 집행이 어긋난다
 *
 *   어느 쪽을 먼저 써도 창이 열린다. 순서로는 못 막는다. 그래서 원본과
 *   투영본을 **한 트랜잭션**에서 쓴다 — 전부 성공하거나 전부 적용되지 않는다.
 *
 *   (이전 판은 authz 쓰기 실패를 삼키고 "성공"을 돌려줬다. 로그만 남고
 *    부분 상태가 그대로 굳었다. 그 판단이 틀렸다.)
 *
 * 마지막 관리자 보호도 같은 트랜잭션 안이다
 *   "다른 활성 관리자가 있는가"를 트랜잭션 밖에서 확인하면, 두 요청이
 *   동시에 서로를 "남은 관리자"로 보고 둘 다 내려간다 — 관리자가 0명이 되고
 *   되돌릴 방법이 없다(로그인 자체가 막힌다). 트랜잭션 안에서 읽으면
 *   그 쿼리 결과가 커밋 시점까지 잠기므로 둘 중 하나는 재시도·거부된다.
 *
 * 호출자 판정은 authz/{uid}.caps 다 — 규칙과 같은 근거다.
 *   백필 전에는 이 파일의 모든 콜러블이 거부된다. 그것이 의도다.
 *   부트스트랩은 막히지 않는다: signup 이 첫 관리자의 authz 를 함께 만들고,
 *   backfillAuthz 는 caps 가 아니라 users.isAdmin 으로 판정한다.
 *   순서는 여전히 배포 → 백필 → 규칙이다.
 */

module.exports = function staffFns(ctx) {
  const {
    db, callable, requireCaller, rankOf, HttpsError, logger, FieldValue,
    hashPassword, validUserId, VALID_ROLES, USERS, SECRETS,
    currentOverride, authzWriteFor, randomId,
  } = ctx;

  const AUTHZ = 'authz';
  const PRIVILEGE_REQUESTS = 'staffPrivilegeRequests';
  const { fixedCan } = require('./fixed-role-policy.cjs');

  /**
   * 직원 관리 권한. 등급 리터럴이 아니라 카탈로그 키로 판정한다 —
   * 관리자가 설정에서 등급표를 바꾸면 그것이 그대로 반영돼야 한다.
   * (settings.staff 는 보안 하한이 걸려 있어 담당자 이하로는 못 내린다)
   */
  async function requireStaffAdmin(auth, what) {
    const me = await requireCaller(auth);
    me.require('settings.staff', what);
    return me;
  }

  /**
   * users 쓰기와 짝이 되는 authz 쓰기를 트랜잭션에 넣는다.
   *
   * 이 함수를 거치지 않고 users 를 쓰는 경로가 생기면 그 순간 투영본이
   * 낡는다. 그래서 users 를 쓰는 자리마다 바로 옆에 둔다.
   */
  function writeAuthz(tx, uid, nextUser, override) {
    const w = authzWriteFor(uid, nextUser, override);
    if (!w) throw new HttpsError('internal', '권한 스냅샷을 만들지 못했습니다.');
    tx.set(w.ref, w.data, { merge: true });
  }

  /**
   * 마지막 관리자 보호. **트랜잭션 안에서** 부른다(위 주석 참고).
   * 대상이 관리자가 아니면 아무것도 읽지 않는다 — 흔한 경우에 쿼리를 아낀다.
   */
  async function assertNotLastAdmin(tx, userId, user, what) {
    if (user.isAdmin !== true) return;
    const admins = await tx.get(db.collection(USERS).where('isAdmin', '==', true));
    const others = admins.docs.filter(
      (x) => x.id !== userId && (x.data() || {}).active !== false
    );
    if (!others.length) {
      throw new HttpsError(
        'failed-precondition',
        `마지막 관리자는 ${what} 수 없습니다. 다른 직원에게 먼저 관리자 권한을 부여하세요.`
      );
    }
  }

  // ───────────────────────────────────────────────────────────
  // approveStaff — 가입 신청 승인
  // ───────────────────────────────────────────────────────────
  const approveStaff = callable('approveStaff', async (request) => {
    const auth = request.auth;
    const me = await requireCaller(auth);
    const canApprove = me.can('staff.role.approve');
    const canExecute = me.can('settings.staff');
    if (!canApprove && !canExecute) {
      throw new HttpsError('permission-denied', '직원 역할 승인 또는 실행 권한이 없습니다.');
    }

    const d = request.data || {};
    const targetId = String(d.userId || '').trim();
    const role = String(d.role || '').trim();
    const isAdmin = d.isAdmin === true;

    if (!validUserId(targetId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    if (!VALID_ROLES.includes(role)) throw new HttpsError('invalid-argument', '역할이 올바르지 않습니다.');

    const override = await currentOverride();
    const ref = db.collection(USERS).doc(targetId);
    const nextRequestId = randomId();

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', '해당 직원을 찾을 수 없습니다.');
      const currentChange = (snap.data() || {}).privilegeChange || {};
      const requestId = String(currentChange.requestId || nextRequestId);
      const requestRef = db.collection(PRIVILEGE_REQUESTS).doc(requestId);
      const actorSnap = await tx.get(db.collection(AUTHZ).doc(me.uid));
      const pendingSnap = await tx.get(requestRef);
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      const approverNow = fixedCan(actor, 'staff.role.approve');
      const executorNow = fixedCan(actor, 'settings.staff');
      const pending = pendingSnap.exists ? pendingSnap.data() || {} : null;
      const sameChange = pending && pending.role === role && pending.isAdmin === isAdmin;

      if (pending && pending.state === 'pending' && sameChange && approverNow) {
        if (pending.requestedBy === me.uid || targetId === me.uid) {
          throw new HttpsError('failed-precondition', '본인이 요청했거나 본인에게 적용되는 역할 변경은 승인할 수 없습니다.');
        }
        tx.update(requestRef, {
          state: 'approved', approvedBy: me.uid, approvedAt: FieldValue.serverTimestamp(),
        });
        tx.update(ref, {
          privilegeChange: {
            requestId, role, isAdmin, state: 'approved', requestedBy: pending.requestedBy,
            approvedBy: me.uid,
          },
        });
        return { state: 'approved', waitingFor: 'executor' };
      }

      if (pending && pending.state === 'approved' && sameChange && executorNow) {
        if (!pending.approvedBy || pending.approvedBy === me.uid) {
          throw new HttpsError('failed-precondition', '승인자와 실행자는 서로 달라야 합니다. 다른 실행자를 기다립니다.');
        }
        const patch = {
          approved: true, role, isAdmin, active: true,
          privilegeChange: FieldValue.delete(),
        };
        tx.update(ref, patch);
        writeAuthz(tx, targetId, { ...(snap.data() || {}), ...patch }, override);
        tx.update(requestRef, {
          state: 'executed', executedBy: me.uid, executedAt: FieldValue.serverTimestamp(),
        });
        return { state: 'executed', waitingFor: null };
      }

      if (!executorNow) {
        throw new HttpsError('failed-precondition', '시스템 관리자가 먼저 역할 변경을 요청해야 합니다.');
      }
      tx.set(requestRef, {
        requestId, targetId, role, isAdmin, state: 'pending', requestedBy: me.uid,
        requestedAt: FieldValue.serverTimestamp(), approvedBy: null, executedBy: null,
      });
      tx.update(ref, {
        privilegeChange: { requestId, role, isAdmin, state: 'pending', requestedBy: me.uid },
      });
      return { state: 'pending', waitingFor: 'approver' };
    });

    return { ok: result.state === 'executed', ...result };
  });

  const cancelStaffPrivilegeChange = callable('cancelStaffPrivilegeChange', async (request) => {
    const auth = request.auth;
    const me = await requireCaller(auth);
    if (!me.can('staff.role.approve') && !me.can('settings.staff')) {
      throw new HttpsError('permission-denied', '역할 변경 취소 권한이 없습니다.');
    }
    const targetId = String((request.data || {}).userId || '').trim();
    if (!validUserId(targetId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    const userRef = db.collection(USERS).doc(targetId);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new HttpsError('not-found', '해당 직원을 찾을 수 없습니다.');
      const change = (userSnap.data() || {}).privilegeChange || {};
      if (!change.requestId) throw new HttpsError('failed-precondition', '취소할 역할 변경이 없습니다.');
      const requestRef = db.collection(PRIVILEGE_REQUESTS).doc(String(change.requestId));
      const requestSnap = await tx.get(requestRef);
      const actorSnap = await tx.get(db.collection(AUTHZ).doc(me.uid));
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      const pending = requestSnap.exists ? requestSnap.data() || {} : {};
      const stillAllowed = fixedCan(actor, 'staff.role.approve') || fixedCan(actor, 'settings.staff');
      const participated = pending.requestedBy === me.uid || pending.approvedBy === me.uid;
      if (!stillAllowed || !participated || !['pending', 'approved'].includes(pending.state)) {
        throw new HttpsError('permission-denied', '본인이 요청하거나 승인한 대기 작업만 취소할 수 있습니다.');
      }
      tx.update(requestRef, {
        state: 'cancelled', cancelledBy: me.uid, cancelledAt: FieldValue.serverTimestamp(),
      });
      tx.update(userRef, { privilegeChange: FieldValue.delete() });
    });
    return { ok: true, state: 'cancelled' };
  });

  // ───────────────────────────────────────────────────────────
  // upsertStaff — 등록·수정 (일괄 처리 가능)
  //
  // 사람마다 트랜잭션 하나다. 전원을 한 트랜잭션에 넣으면 200명 × 3쓰기가
  // 한도를 넘고, 한 명의 아이디 오타로 나머지 199명이 통째로 취소된다.
  // 한 사람 안에서는(users · 비밀번호 · authz) 원자적이다.
  // ───────────────────────────────────────────────────────────

  /** 이 사람만 실패했다는 신호. 예외로 던지고 결과 목록에 담는다. */
  class Rejected extends Error {
    constructor(message) { super(message); this.rejected = true; }
  }

  const upsertStaff = callable('upsertStaff', async (request) => {
    const auth = request.auth;
    const me = await requireStaffAdmin(auth, '직원 관리');

    const list = Array.isArray(request.data && request.data.staff)
      ? request.data.staff
      : [request.data || {}];
    if (!list.length) throw new HttpsError('invalid-argument', '등록할 직원이 없습니다.');
    if (list.length > 200) throw new HttpsError('invalid-argument', '한 번에 200명까지만 처리할 수 있습니다.');

    const isAdminCaller = me.isAdmin;
    const override = await currentOverride();
    const results = [];

    for (const raw of list) {
      const userId = String(raw.userId || '').trim();
      const name = String(raw.name || '').trim();
      const role = String(raw.role || '입력자').trim();
      const team = String(raw.team || '').trim();
      const password = raw.password ? String(raw.password) : '';
      const wantAdmin = raw.isAdmin === true;

      if (!validUserId(userId)) {
        results.push({ userId, ok: false, error: '아이디는 영문·숫자·밑줄만 사용할 수 있습니다.' });
        continue;
      }
      if (!name) {
        results.push({ userId, ok: false, error: '이름이 비어 있습니다.' });
        continue;
      }
      if (!VALID_ROLES.includes(role)) {
        results.push({ userId, ok: false, error: `알 수 없는 역할: ${role}` });
        continue;
      }
      if (rankOf(role) > me.rank) {
        results.push({ userId, ok: false, error: '본인보다 높은 등급은 부여할 수 없습니다.' });
        continue;
      }
      if (wantAdmin && !isAdminCaller) {
        results.push({ userId, ok: false, error: '관리자 권한은 관리자만 부여할 수 있습니다.' });
        continue;
      }
      if (password && password.length < 8) {
        results.push({ userId, ok: false, error: '비밀번호는 8자 이상이어야 합니다.' });
        continue;
      }

      try {
        // 해시는 트랜잭션 밖에서 만든다 — 느려서(의도적으로) 트랜잭션 안에
        // 두면 잠금을 오래 쥐고 재시도마다 다시 계산된다.
        const record = password ? await hashPassword(password) : null;
        const userRef = db.collection(USERS).doc(userId);
        let created = false;

        await db.runTransaction(async (tx) => {
          const existing = await tx.get(userRef);
          created = !existing.exists;

          // 신규 등록은 비밀번호가 반드시 필요하다 (없으면 로그인할 수 없다)
          if (created && !record) throw new Rejected('신규 등록에는 비밀번호가 필요합니다.');
          if (!created && record) {
            throw new Rejected('기존 직원의 비밀번호는 직원 정보 화면에서 변경할 수 없습니다.');
          }

          // merge — approved·active 등 기존 필드를 보존한다
          const old = existing.data() || {};
          if (!created && old.active === false
              && (name !== String(old.name || '') || team !== String(old.team || ''))) {
            throw new Rejected(
              '퇴사 계정의 신원 정보는 바꿀 수 없습니다. UID를 다른 사람에게 재사용하지 마세요.',
            );
          }
          if (!created && (role !== String(old.role || '') || wantAdmin !== (old.isAdmin === true))) {
            throw new Rejected('역할·관리자 자격 변경은 별도 승인 절차를 이용하세요.');
          }
          const patch = {
            userId, name, role: created ? '입력자' : old.role, team,
            isAdmin: created ? false : old.isAdmin === true,
            ...(created ? { approved: false, active: true } : {}),
            updatedAt: FieldValue.serverTimestamp(),
          };
          tx.set(userRef, patch, { merge: true });

          if (record) {
            tx.set(db.collection(SECRETS).doc(userId), {
              ...record, failedCount: 0, updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          }

          // 신규 사용자도 **현재** 오버라이드로 caps 를 받는다. 이것을 빠뜨리면
          // 새 직원만 caps 없이 만들어져 아무것도 못 하게 된다.
          writeAuthz(tx, userId, { ...(existing.data() || {}), ...patch }, override);
        });

        results.push({ userId, ok: true, created });
      } catch (err) {
        if (err && err.rejected) {
          results.push({ userId, ok: false, error: err.message });
        } else {
          logger.error(`[upsertStaff] ${userId} 처리 실패`, { message: err && err.message });
          results.push({ userId, ok: false, error: '저장 중 오류가 발생했습니다.' });
        }
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    return { okCount, failCount: results.length - okCount, results };
  });

  // ───────────────────────────────────────────────────────────
  // setStaffActive — 재직·퇴사 전환
  // ───────────────────────────────────────────────────────────
  const setStaffActive = callable('setStaffActive', async (request) => {
    const auth = request.auth;
    await requireStaffAdmin(auth, '직원 관리');

    const d = request.data || {};
    const userId = String(d.userId || '').trim();
    const active = d.active === true;

    if (!validUserId(userId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    if (userId === auth.uid && !active) {
      throw new HttpsError('failed-precondition', '본인 계정은 비활성화할 수 없습니다.');
    }
    if (active && d.confirmAssignments !== true) {
      throw new HttpsError('failed-precondition', '재활성화 전에 기존 담당 관계를 확인해야 합니다.');
    }

    const override = await currentOverride();
    const ref = db.collection(USERS).doc(userId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', '해당 직원을 찾을 수 없습니다.');
      const user = snap.data() || {};
      if (!active) await assertNotLastAdmin(tx, userId, user, '비활성화할');

      tx.update(ref, { active });
      writeAuthz(tx, userId, { ...user, active }, override);
    });

    return { ok: true };
  });

  // ───────────────────────────────────────────────────────────
  // deleteStaff — 직원 삭제
  //
  // 왜 새로 만들었나
  //   화면(settings.js confirmDelete)이 브라우저에서 deleteDoc(users/{id}) 를
  //   호출하는데 규칙은 users 쓰기를 전면 차단한다. 게다가 showConfirm 이
  //   onOk() 를 await 도 catch 도 없이 불러 **거부가 삼켜졌다** —
  //   대화상자만 닫히고 아무 일도 일어나지 않으며 감사 기록도 없었다.
  //
  // 왜 담당 배정이 있으면 거부하나
  //   지우면서 clients.userIds 를 대신 고쳐 주면, 관리자가 의도하지 않은
  //   담당 변경이 조용히 일어난다. 담당 관계는 업무 원본이고 그것을 바꾸는
  //   것은 saveClient 의 일이다. 그래서 "먼저 재배정하라"고 말하고 멈춘다.
  //
  //   그 확인도 트랜잭션 안에서 한다 — 밖에서 보면 확인과 삭제 사이에
  //   배정이 들어와 유령 참조가 남는다.
  // ───────────────────────────────────────────────────────────
  const deleteStaff = callable('deleteStaff', async (request) => {
    await requireStaffAdmin(request.auth, '직원 관리');

    throw new HttpsError(
      'failed-precondition',
      '직원 계정은 삭제하지 않습니다. UID와 이력을 보존한 채 퇴사(비활성) 처리하세요.',
    );
  });

  return { approveStaff, cancelStaffPrivilegeChange, upsertStaff, setStaffActive, deleteStaff };
};
