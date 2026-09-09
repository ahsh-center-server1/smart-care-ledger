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
 * ⚠️ 호출자 권한 판정은 **아직 토큰 클레임(callerRank)** 이다.
 *    caps 로 바꾸는 것은 백필이 끝난 뒤여야 한다 — 지금 바꾸면 caps 가 없는
 *    상태에서 직원 관리가 통째로 막히고, 그러면 백필을 실행할 관리자도
 *    아무것도 못 한다. 순서: 배포 → 백필 → 판정 근거 전환(게이트 A).
 */

module.exports = function staffFns(ctx) {
  const {
    db, callable, callerRank, rankOf, HttpsError, logger, FieldValue,
    hashPassword, validUserId, VALID_ROLES, USERS, SECRETS,
    currentOverride, authzWriteFor,
  } = ctx;

  const CLIENTS = 'clients';
  const AUTHZ = 'authz';
  const MEMBERS = 'members';

  /** 직원 관리 최소 등급. 팀장 이상. */
  const STAFF_ADMIN_RANK = 3;

  /**
   * 삭제 한 건이 만들 수 있는 쓰기 수 상한.
   *
   * 트랜잭션 한도(500)보다 낮게 잡는다. 유령 멤버 문서가 이만큼 쌓였다면
   * 투영본이 심하게 어긋난 것이고, 그때는 조용히 절반만 지우는 것보다
   * 멈추고 백필을 돌리라고 말하는 편이 낫다.
   */
  const MAX_DELETE_WRITES = 400;

  function requireStaffAdmin(auth, what) {
    if (!auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    if (callerRank(auth) < STAFF_ADMIN_RANK) {
      throw new HttpsError('permission-denied', `${what} 권한이 없습니다.`);
    }
    return callerRank(auth);
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

    // 등급표는 트랜잭션 **밖에서** 읽는다 — config 문서를 잠그면 직원 변경이
    // 서로 직렬화되고, 트랜잭션의 "읽기가 쓰기보다 먼저" 규칙도 지키기 어렵다.
    const override = await currentOverride();
    const ref = db.collection(USERS).doc(targetId);
    const patch = { approved: true, role, isAdmin, active: true };

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', '해당 직원을 찾을 수 없습니다.');
      tx.update(ref, patch);
      writeAuthz(tx, targetId, { ...(snap.data() || {}), ...patch }, override);
    });

    return { ok: true };
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
    const myRank = requireStaffAdmin(auth, '직원 관리');

    const list = Array.isArray(request.data && request.data.staff)
      ? request.data.staff
      : [request.data || {}];
    if (!list.length) throw new HttpsError('invalid-argument', '등록할 직원이 없습니다.');
    if (list.length > 200) throw new HttpsError('invalid-argument', '한 번에 200명까지만 처리할 수 있습니다.');

    const isAdminCaller = auth.token && auth.token.isAdmin === true;
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

          // merge — approved·active 등 기존 필드를 보존한다
          const patch = {
            userId, name, role, team,
            isAdmin: wantAdmin,
            ...(created ? { approved: true, active: true } : {}),
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
    requireStaffAdmin(auth, '직원 관리');

    const d = request.data || {};
    const userId = String(d.userId || '').trim();
    const active = d.active === true;

    if (!validUserId(userId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    if (userId === auth.uid && !active) {
      throw new HttpsError('failed-precondition', '본인 계정은 비활성화할 수 없습니다.');
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
    const auth = request.auth;
    requireStaffAdmin(auth, '직원 관리');

    const userId = String((request.data && request.data.userId) || '').trim();
    if (!validUserId(userId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    if (userId === auth.uid) {
      throw new HttpsError('failed-precondition', '본인 계정은 삭제할 수 없습니다.');
    }

    const ref = db.collection(USERS).doc(userId);

    const staleMembers = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', '해당 직원을 찾을 수 없습니다.');
      await assertNotLastAdmin(tx, userId, snap.data() || {}, '삭제할');

      // 담당 배정이 남아 있으면 거부한다.
      const clients = await tx.get(db.collection(CLIENTS));
      const assigned = clients.docs.filter((c) => {
        const cd = c.data() || {};
        const staff = String(cd.userIds || '').split(',').map((x) => x.trim());
        return staff.includes(userId) || String(cd.teamLeader || '').trim() === userId;
      });
      if (assigned.length) {
        const names = assigned.slice(0, 5).map((c) => (c.data().name || c.id));
        throw new HttpsError(
          'failed-precondition',
          `담당으로 배정된 입주자가 있습니다 (${names.join(', ')}${assigned.length > 5 ? ' 외' : ''}). `
          + '먼저 담당을 다른 직원에게 옮기세요.',
        );
      }

      // 남은 멤버 문서. 위에서 담당이 없음을 확인했으므로 보통 비어 있지만,
      // 투영본이 어긋나 있었다면 여기서 함께 정리된다.
      const stale = await tx.get(db.collectionGroup(MEMBERS).where('uid', '==', userId));
      if (stale.size + 3 > MAX_DELETE_WRITES) {
        throw new HttpsError(
          'failed-precondition',
          '정리할 권한 문서가 너무 많습니다. 권한 백필을 먼저 실행하세요.',
        );
      }

      // 여기서부터 쓰기. 접근 근거(authz)와 명부(users)와 비밀번호가 한꺼번에
      // 사라진다 — 셋 중 하나만 남는 상태가 없다.
      tx.delete(db.collection(AUTHZ).doc(userId));
      tx.delete(ref);
      tx.delete(db.collection(SECRETS).doc(userId));
      for (const m of stale.docs) tx.delete(m.ref);

      return stale.size;
    });

    logger.info('[deleteStaff] 완료', { userId, staleMembers });
    return { ok: true, staleMembers };
  });

  return { approveStaff, upsertStaff, setStaffActive, deleteStaff };
};

// 상수는 index.js 와 공유한다 — 컬렉션 이름이 갈라지면 조용히 다른 곳을 쓴다.
module.exports.CLIENT_ACCESS_MEMBERS = 'members';
