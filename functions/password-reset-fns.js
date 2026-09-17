'use strict';

/**
 * 비밀번호 분실 처리 — **관리자가 발급하되, 결재자 계정은 2인이 필요하다.**
 *
 * 왜 이메일 재설정이 아닌가
 *   이 앱의 계정에는 이메일이 없다(users: userId·name·role·team). 재설정 링크를
 *   보낼 곳이 없으므로 사람이 발급하는 수밖에 없다.
 *
 * 왜 관리자 혼자로는 안 되는가
 *   관리자 자격은 업무 권한과 **직교**한다 — 관리자라고 결재할 수 있는 것이
 *   아니다(fixed-role-policy 의 전제). 그런데 남의 비밀번호를 발급할 수 있으면
 *   잠시 센터장이 되어 결재할 수 있고, 그 전제가 무너진다.
 *   그래서 코드가 세 곳에서 "다른 직원의 비밀번호는 바꿀 수 없다"고 막고 있었다.
 *
 *   여기서 여는 것은 그 구멍을 **결재 권한이 없는 계정으로 한정**한 것이다.
 *     · 입력자 · 담당자        → 관리자가 바로 발급
 *     · 팀장 · 센터장 · 관리자  → 다른 사람이 한 번 더 승인해야 발급
 *
 *   두 번째 사람은 요청한 사람과 **달라야** 한다. 같으면 2인이 아니다.
 *
 * 임시 비밀번호의 성질
 *   · 서버가 만든다. 사람이 고르면 "0000" 이 된다.
 *   · 한 번 쓰면 반드시 바꾼다(mustChangePassword). 바꾸기 전에는 앱을 쓸 수
 *     없으므로, 발급한 사람이 조용히 그 계정으로 일할 수 없다 — 주인이
 *     로그인하는 순간 바꾸라는 화면을 보게 되어 발급 사실이 드러난다.
 *   · 유효 시간이 있다. 지나면 다시 발급받아야 한다.
 *   · 호출 응답에 **한 번만** 실려 나간다. 어디에도 평문으로 저장하지 않는다.
 */

const USERS = 'users';
const SECRETS = 'userSecrets';
const RESETS = 'passwordResets';
const AUDIT = 'auditLogs';

/** 임시 비밀번호 유효 시간. 넘으면 다시 발급받는다. */
const TEMP_TTL_MS = 24 * 60 * 60 * 1000;

/** 승인 대기 요청의 유효 시간. 오래 남아 있으면 잊힌 채로 쓰인다. */
const REQUEST_TTL_MS = 60 * 60 * 1000;

/** 2인이 필요한 역할. 결재에 닿는 자리와 관리자 자격. */
const TWO_PERSON_ROLES = new Set(['팀장', '센터장']);

/** 헷갈리는 글자(0/O, 1/l/I)를 뺀다 — 종이에 적어 건네는 값이다. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeTempPassword(randomInt) {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  // 네 글자씩 끊어 읽고 옮겨 적기 쉽게 한다.
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** 이 계정을 되살리는 데 두 사람이 필요한가. */
function needsTwoPeople(user) {
  return TWO_PERSON_ROLES.has(String((user || {}).role || '')) || (user || {}).isAdmin === true;
}

module.exports = function passwordResetFns(ctx) {
  const {
    db, callable, requireCaller, HttpsError, logger,
    FieldValue, Timestamp, hashPassword, validUserId, randomInt,
  } = ctx;

  /** 관리자만 이 절차를 시작하거나 승인할 수 있다. */
  async function requireAdmin(auth, what) {
    const me = await requireCaller(auth);
    if (!me.isAdmin) {
      throw new HttpsError('permission-denied', `${what}은(는) 시스템 관리자만 할 수 있습니다.`);
    }
    return me;
  }

  async function loadTarget(userId) {
    if (!validUserId(userId)) {
      throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
    }
    const snap = await db.collection(USERS).doc(userId).get();
    if (!snap.exists) throw new HttpsError('not-found', '그런 직원이 없습니다.');
    const user = snap.data() || {};
    if (user.active === false) {
      // 퇴사 계정을 되살리는 통로가 되면 안 된다. 재직 처리가 먼저다.
      throw new HttpsError('failed-precondition', '퇴사 처리된 계정입니다. 먼저 재직으로 되돌리세요.');
    }
    return user;
  }

  /** 임시 비밀번호를 만들어 심고, 감사 기록을 남긴다. */
  async function issueTemp({ userId, actor, approver }) {
    const temp = makeTempPassword(randomInt);
    const record = await hashPassword(temp);
    const now = Date.now();

    await db.runTransaction(async (tx) => {
      tx.set(db.collection(SECRETS).doc(userId), {
        ...record,
        // 바꾸기 전에는 앱을 쓸 수 없다 — 발급 사실이 주인에게 반드시 드러난다.
        mustChangePassword: true,
        tempExpiresAt: Timestamp.fromMillis(now + TEMP_TTL_MS),
        failedCount: 0,
        lockedUntil: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // 대기 요청은 소비한다. 남겨 두면 한 번 승인으로 여러 번 발급된다.
      tx.delete(db.collection(RESETS).doc(userId));
      tx.set(db.collection(AUDIT).doc(), {
        action: 'staff.passwordReset',
        actorUid: actor.uid,
        actorName: actor.uid,
        resourceId: userId,
        summary: { 대상: userId, 승인자: approver || '(단독)' },
        timestamp: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(now + 365 * 24 * 60 * 60 * 1000),
      });
    });

    logger.info('[passwordReset] 임시 비밀번호 발급', {
      target: userId, actor: actor.uid, approver: approver || null,
    });
    return { ok: true, tempPassword: temp, expiresInHours: TEMP_TTL_MS / 3600000 };
  }

  /**
   * 재설정 시작. 결재에 닿지 않는 계정이면 바로 발급하고,
   * 팀장·센터장·관리자 계정이면 승인 대기로 남긴다.
   */
  const requestPasswordReset = callable('requestPasswordReset', async (request) => {
    const me = await requireAdmin(request.auth, '비밀번호 재설정');
    const userId = String((request.data || {}).userId || '').trim();
    const user = await loadTarget(userId);

    if (userId === me.uid) {
      // 본인 것은 changePassword 로 바꾼다. 여기로 오면 임시 비밀번호가
      // 필요 없는데도 계정이 잠시 잠긴다.
      throw new HttpsError('failed-precondition', '본인 비밀번호는 비밀번호 변경 화면에서 바꾸세요.');
    }

    if (!needsTwoPeople(user)) return issueTemp({ userId, actor: me, approver: null });

    const now = Date.now();
    await db.collection(RESETS).doc(userId).set({
      userId,
      requestedBy: me.uid,
      requestedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + REQUEST_TTL_MS),
    });
    return {
      ok: true,
      needsApproval: true,
      message: '결재에 닿는 계정이라 다른 관리자의 승인이 한 번 더 필요합니다.',
      expiresInMinutes: REQUEST_TTL_MS / 60000,
    };
  });

  /** 두 번째 사람의 승인. 요청한 사람과 달라야 한다. */
  const approvePasswordReset = callable('approvePasswordReset', async (request) => {
    const me = await requireAdmin(request.auth, '비밀번호 재설정 승인');
    const userId = String((request.data || {}).userId || '').trim();
    await loadTarget(userId);

    const snap = await db.collection(RESETS).doc(userId).get();
    if (!snap.exists) throw new HttpsError('not-found', '대기 중인 재설정 요청이 없습니다.');
    const req = snap.data() || {};

    if (req.requestedBy === me.uid) {
      throw new HttpsError(
        'permission-denied',
        '요청한 사람과 승인하는 사람이 같으면 2인 확인이 아닙니다. 다른 관리자가 승인해야 합니다.',
      );
    }
    const expires = req.expiresAt && typeof req.expiresAt.toMillis === 'function'
      ? req.expiresAt.toMillis() : 0;
    if (!expires || expires <= Date.now()) {
      throw new HttpsError('deadline-exceeded', '요청이 만료되었습니다. 다시 요청하세요.');
    }

    return issueTemp({ userId, actor: me, approver: req.requestedBy });
  });

  return {
    requestPasswordReset,
    approvePasswordReset,
    __test: { makeTempPassword, needsTwoPeople, TEMP_TTL_MS, REQUEST_TTL_MS },
  };
};
