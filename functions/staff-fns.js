'use strict';

/**
 * 직원 관리 콜러블 — 승인 · 등록/수정 · 재직 전환 · 삭제.
 *
 * 왜 서버에만 있는가
 *   firestore.rules 가 users 컬렉션의 클라이언트 쓰기를 전면 차단한다.
 *   역할·승인·관리자 플래그를 브라우저가 바꿀 수 있으면 개발자도구로
 *   자기 역할을 센터장으로 적으면 그만이다.
 *
 * 왜 index.js 에서 옮겨 왔나
 *   test/architecture.test.mjs 가 "예외로 둔 파일은 더 커지지 않는다"로
 *   index.js 를 묶어 두고 있고, 그 실패 메시지는 **기능을 더할 곳이 아니라
 *   쪼갤 곳**이라고 말한다. caps 재계산을 넣으려면 줄이 늘어야 하므로
 *   먼저 쪼갠다.
 *
 * caps 재계산
 *   역할·관리자 플래그·재직 상태가 바뀌면 authz/{uid}.caps 도 바뀌어야 한다.
 *   그것을 하지 않으면 규칙이 낡은 값으로 판정한다 — 강등된 사람이 계속
 *   통과하거나 승진한 사람이 막힌다. 그래서 모든 변경 뒤에 syncAuthz 를 부른다.
 *
 * ⚠️ 권한 판정은 **아직 토큰 클레임(callerRank)** 이다.
 *    caps 로 바꾸는 것은 백필이 끝난 뒤여야 한다 — 지금 바꾸면 caps 가 없는
 *    상태에서 직원 관리가 통째로 막히고, 그러면 백필을 실행할 관리자도
 *    아무것도 못 한다. 순서: 배포 → 백필 → 판정 근거 전환(게이트 A).
 */

module.exports = function staffFns(ctx) {
  const {
    db, callable, callerRank, rankOf, HttpsError, logger, FieldValue,
    hashPassword, validUserId, VALID_ROLES, USERS, SECRETS,
    syncAuthzForUser,
  } = ctx;

  const CLIENTS = 'clients';
  const AUTHZ = 'authz';
  const CLIENT_ACCESS = 'clientAccess';
  const MEMBERS = 'members';

  /** 직원 관리 최소 등급. 팀장 이상. */
  const STAFF_ADMIN_RANK = 3;

  function requireStaffAdmin(auth, what) {
    if (!auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    if (callerRank(auth) < STAFF_ADMIN_RANK) {
      throw new HttpsError('permission-denied', `${what} 권한이 없습니다.`);
    }
    return callerRank(auth);
  }

  /** caps 재계산. 실패해도 본 작업은 되돌리지 않는다 — 아래 주석 참고. */
  async function syncAuthz(uid, user) {
    try {
      return await syncAuthzForUser(uid, user);
    } catch (err) {
      // 여기서 던지면 이미 성공한 users 쓰기가 롤백되지 않은 채 오류만 나간다.
      // caps 가 낡은 것은 백필로 고칠 수 있지만, 사용자에게는 "실패했는데
      // 반영은 됐다"가 가장 나쁘다. 그래서 기록만 남기고 성공으로 둔다.
      logger.error('[staff] caps 재계산 실패 — 백필로 복구하세요', {
        uid, message: err && err.message,
      });
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────
  // approveStaff — 가입 신청 승인
  // ───────────────────────────────────────────────────────────
  const approveStaff = callable('approveStaff', async (request) => {
    const auth = request.auth;
    const myRank = requireStaffAdmin(auth, '직원 승인');

    const d = request.data || {};
    const targetId = String(d.userId || '').trim();
    const role = String(d.role || '').trim();
    const isAdmin = d.isAdmin === true;

    if (!validUserId(targetId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    if (!VALID_ROLES.includes(role)) throw new HttpsError('invalid-argument', '역할이 올바르지 않습니다.');

    // 자기 등급을 넘는 역할은 부여 불가. 관리자 플래그는 관리자만 줄 수 있다.
    if (rankOf(role) > myRank) {
      throw new HttpsError('permission-denied', '본인보다 높은 등급은 부여할 수 없습니다.');
    }
    if (isAdmin && !(auth.token && auth.token.isAdmin === true)) {
      throw new HttpsError('permission-denied', '관리자 권한은 관리자만 부여할 수 있습니다.');
    }

    const ref = db.collection(USERS).doc(targetId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', '해당 직원을 찾을 수 없습니다.');

    await ref.update({ approved: true, role, isAdmin, active: true });
    await syncAuthz(targetId, { ...snap.data(), approved: true, role, isAdmin, active: true });
    return { ok: true };
  });

  // ───────────────────────────────────────────────────────────
  // upsertStaff — 등록·수정 (일괄 처리 가능)
  // ───────────────────────────────────────────────────────────
  const upsertStaff = callable('upsertStaff', async (request) => {
    const auth = request.auth;
    const myRank = requireStaffAdmin(auth, '직원 관리');

    const list = Array.isArray(request.data && request.data.staff)
      ? request.data.staff
      : [request.data || {}];
    if (!list.length) throw new HttpsError('invalid-argument', '등록할 직원이 없습니다.');
    if (list.length > 200) throw new HttpsError('invalid-argument', '한 번에 200명까지만 처리할 수 있습니다.');

    const isAdminCaller = auth.token && auth.token.isAdmin === true;
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
      if (rankOf(role) > myRank) {
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
        const userRef = db.collection(USERS).doc(userId);
        const existing = await userRef.get();

        // 신규 등록은 비밀번호가 반드시 필요하다 (없으면 로그인할 수 없다)
        if (!existing.exists && !password) {
          results.push({ userId, ok: false, error: '신규 등록에는 비밀번호가 필요합니다.' });
          continue;
        }

        // merge — approved·active 등 기존 필드를 보존한다
        const patch = {
          userId, name, role, team,
          isAdmin: wantAdmin,
          ...(existing.exists ? {} : { approved: true, active: true }),
          updatedAt: FieldValue.serverTimestamp(),
        };
        await userRef.set(patch, { merge: true });

        if (password) {
          const record = await hashPassword(password);
          await db.collection(SECRETS).doc(userId).set(
            { ...record, failedCount: 0, updatedAt: FieldValue.serverTimestamp() },
            { merge: true }
          );
        }

        // 신규 사용자도 **현재** 오버라이드로 caps 를 받는다. 이것을 빠뜨리면
        // 새 직원만 caps 없이 만들어져 아무것도 못 하게 된다.
        await syncAuthz(userId, { ...(existing.data() || {}), ...patch });

        results.push({ userId, ok: true, created: !existing.exists });
      } catch (err) {
        logger.error(`[upsertStaff] ${userId} 처리 실패`, { message: err && err.message });
        results.push({ userId, ok: false, error: '저장 중 오류가 발생했습니다.' });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    return { okCount, failCount: results.length - okCount, results };
  });

  // ───────────────────────────────────────────────────────────
  // setStaffActive — 재직·퇴사 전환
  //
  // 마지막 관리자를 비활성화하면 권한 설정·전체 초기화가 영구히 불가능해지므로
  // 서버에서 막는다(로그인 자체가 차단되기 때문에 되돌릴 방법이 없다).
  // ───────────────────────────────────────────────────────────
  const setStaffActive = callable('setStaffActive', async (request) => {
    const auth = request.auth;
    requireStaffAdmin(auth, '직원 관리');

    const d = request.data || {};
    const userId = String(d.userId || '').trim();
    const active = d.active === true;

    if (!validUserId(userId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    if (userId === auth.uid && !active) {
      throw new HttpsError('failed-precondition', '본인 계정은 비활성화할 수 없습니다.');
    }

    const ref = db.collection(USERS).doc(userId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', '해당 직원을 찾을 수 없습니다.');

    // 마지막 관리자 보호
    if (!active && snap.data().isAdmin === true) {
      const admins = await db.collection(USERS).where('isAdmin', '==', true).get();
      const activeAdmins = admins.docs.filter(
        (x) => x.id !== userId && x.data().active !== false
      );
      if (!activeAdmins.length) {
        throw new HttpsError(
          'failed-precondition',
          '마지막 관리자는 비활성화할 수 없습니다. 다른 직원에게 먼저 관리자 권한을 부여하세요.'
        );
      }
    }

    // authz.enabled 를 **먼저** 내린다. users.active 보다 앞서는 이유는
    // 규칙이 보는 것이 authz 이기 때문이다 — 중간에 실패해도 접근은 이미
    // 막힌 상태로 남는다(회수는 먼저, 부여는 나중).
    if (!active) await syncAuthz(userId, { ...snap.data(), active: false });
    await ref.update({ active });
    if (active) await syncAuthz(userId, { ...snap.data(), active: true });

    return { ok: true };
  });

  // ───────────────────────────────────────────────────────────
  // deleteStaff — 직원 삭제
  //
  // 왜 새로 만드나
  //   화면(settings.js confirmDelete)이 브라우저에서 deleteDoc(users/{id}) 를
  //   호출하는데 규칙은 users 쓰기를 전면 차단한다. 게다가 showConfirm 이
  //   onOk() 를 await 도 catch 도 없이 부르므로 **거부가 삼켜진다** —
  //   대화상자만 닫히고 아무 일도 일어나지 않으며 감사 기록도 없다.
  //
  // 왜 담당 배정이 있으면 거부하나
  //   지우면서 clients.userIds 를 대신 고쳐 주면, 관리자가 의도하지 않은
  //   담당 변경이 조용히 일어난다. 담당 관계는 업무 원본이고 그것을 바꾸는
  //   것은 updateClientAssignments 의 일이다. 그래서 "먼저 재배정하라"고
  //   말하고 멈춘다 — 유령 참조도, 조용한 변경도 만들지 않는다.
  // ───────────────────────────────────────────────────────────
  const deleteStaff = callable('deleteStaff', async (request) => {
    const auth = request.auth;
    requireStaffAdmin(auth, '직원 관리');

    const userId = String((request.data && request.data.userId) || '').trim();
    if (!validUserId(userId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    if (userId === auth.uid) {
      throw new HttpsError('failed-precondition', '본인 계정은 삭제할 수 없습니다.');
    }

    const ref = db.collection(USERS).doc(userId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', '해당 직원을 찾을 수 없습니다.');

    // 마지막 관리자 보호 — 비활성화와 같은 이유다.
    if (snap.data().isAdmin === true) {
      const admins = await db.collection(USERS).where('isAdmin', '==', true).get();
      const others = admins.docs.filter((x) => x.id !== userId && x.data().active !== false);
      if (!others.length) {
        throw new HttpsError(
          'failed-precondition',
          '마지막 관리자는 삭제할 수 없습니다. 다른 직원에게 먼저 관리자 권한을 부여하세요.'
        );
      }
    }

    // 담당 배정이 남아 있으면 거부한다.
    const clients = await db.collection(CLIENTS).get();
    const assigned = clients.docs.filter((c) => {
      const d = c.data() || {};
      const staff = String(d.userIds || '').split(',').map((x) => x.trim());
      return staff.includes(userId) || String(d.teamLeader || '').trim() === userId;
    });
    if (assigned.length) {
      const names = assigned.slice(0, 5).map((c) => (c.data().name || c.id));
      throw new HttpsError(
        'failed-precondition',
        `담당으로 배정된 입주자가 있습니다 (${names.join(', ')}${assigned.length > 5 ? ' 외' : ''}). `
        + '먼저 담당을 다른 직원에게 옮기세요.',
      );
    }

    // 접근 근거를 **먼저** 끊는다. users 문서보다 앞서는 이유는 규칙이 보는
    // 것이 authz 이기 때문이다 — 중간에 실패해도 접근은 막힌 상태로 남는다.
    await db.collection(AUTHZ).doc(userId).delete();
    await ref.delete();
    await db.collection(SECRETS).doc(userId).delete();

    // 남은 멤버 문서 정리. 담당 배정이 없음을 위에서 확인했으므로 보통은
    // 비어 있지만, 투영본이 어긋나 있었다면 여기서 함께 정리된다.
    const stale = await db.collectionGroup(MEMBERS).where('uid', '==', userId).get();
    for (const d of stale.docs) await d.ref.delete();

    logger.info('[deleteStaff] 완료', { userId, staleMembers: stale.size });
    return { ok: true, staleMembers: stale.size };
  });

  return { approveStaff, upsertStaff, setStaffActive, deleteStaff };
};

// 상수는 index.js 와 공유한다 — 컬렉션 이름이 갈라지면 조용히 다른 곳을 쓴다.
module.exports.CLIENT_ACCESS_MEMBERS = 'members';
