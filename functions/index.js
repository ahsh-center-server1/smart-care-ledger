'use strict';

/**
 * Smart Care Ledger — 인증 Cloud Functions
 *
 * 이 앱은 사회복지사가 아이디/비밀번호로 로그인하는 기존 UX를 유지한다.
 * 대신 비밀번호 검증을 서버로 옮기고 Firebase 커스텀 토큰을 발급해서,
 * Firestore/Storage 보안 규칙이 request.auth를 근거로 판정할 수 있게 한다.
 *
 * 발급 토큰의 uid == users 문서 ID == 로그인 아이디.
 * 클레임 { role, isAdmin }이 실려 규칙의 rank()가 이를 읽는다.
 *
 * ⚠️ 클레임은 토큰에 고정되므로 역할 변경은 재로그인 후 반영된다.
 *    (BUGFIX_PLAN.md 「토큰과 역할 변경」 참조)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { hashPassword, verifyPassword } = require('./password');

admin.initializeApp();
const db = admin.firestore();

// Firestore가 asia-northeast3(서울)에 있으므로 함수도 같은 리전에 둔다.
setGlobalOptions({ region: 'asia-northeast3', maxInstances: 10 });

const USERS = 'users';
const SECRETS = 'userSecrets';

const ROLE_RANK = { 입력자: 1, 담당자: 2, 팀장: 3, 센터장: 4 };
const VALID_ROLES = Object.keys(ROLE_RANK);

// 로그인 실패 잠금 정책
const MAX_FAILED = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

/** 아이디 형식 — 문서 ID로 쓰이므로 '/'와 공백을 막는다. */
function validUserId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(id);
}

function rankOf(role) {
  return ROLE_RANK[role] || 0;
}

/** 호출자의 등급을 토큰에서 읽는다. 관리자는 최상위로 취급. */
function callerRank(auth) {
  if (!auth) return 0;
  if (auth.token && auth.token.isAdmin === true) return 99;
  return rankOf(auth.token && auth.token.role);
}

// ─────────────────────────────────────────────────────────────
// login — 비밀번호 검증 후 커스텀 토큰 발급
// ─────────────────────────────────────────────────────────────
exports.login = onCall(async (request) => {
  const userId = String((request.data && request.data.userId) || '').trim();
  const password = String((request.data && request.data.password) || '');

  // 아이디 존재 여부를 노출하지 않도록 실패 메시지를 하나로 통일한다.
  const GENERIC = '아이디 또는 비밀번호가 올바르지 않습니다.';

  if (!userId || !password) {
    throw new HttpsError('invalid-argument', '아이디와 비밀번호를 입력하세요.');
  }
  if (!validUserId(userId)) {
    throw new HttpsError('unauthenticated', GENERIC);
  }

  const userRef = db.collection(USERS).doc(userId);
  const secretRef = db.collection(SECRETS).doc(userId);
  const [userSnap, secretSnap] = await Promise.all([userRef.get(), secretRef.get()]);

  if (!userSnap.exists || !secretSnap.exists) {
    throw new HttpsError('unauthenticated', GENERIC);
  }

  const user = userSnap.data();
  const secret = secretSnap.data();

  // 잠금 확인
  if (secret.lockedUntil && secret.lockedUntil.toMillis() > Date.now()) {
    const mins = Math.ceil((secret.lockedUntil.toMillis() - Date.now()) / 60000);
    throw new HttpsError(
      'resource-exhausted',
      `로그인 시도가 많아 잠겼습니다. ${mins}분 후 다시 시도하세요.`
    );
  }

  const ok = await verifyPassword(password, secret);
  if (!ok) {
    const failed = (secret.failedCount || 0) + 1;
    const update = { failedCount: failed, lastFailedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (failed >= MAX_FAILED) {
      update.lockedUntil = admin.firestore.Timestamp.fromMillis(Date.now() + LOCKOUT_MS);
      update.failedCount = 0;
    }
    await secretRef.update(update);
    throw new HttpsError('unauthenticated', GENERIC);
  }

  // 승인·재직 확인 — 여기서는 구체적 사유를 알려도 안전하다(비밀번호를 이미 통과했으므로).
  if (user.approved === false) {
    throw new HttpsError('permission-denied', '관리자 승인 대기 중입니다. 담당자에게 문의하세요.');
  }
  if (user.active === false) {
    throw new HttpsError('permission-denied', '비활성화된 계정입니다. 관리자에게 문의하세요.');
  }

  const role = VALID_ROLES.includes(user.role) ? user.role : '입력자';
  const isAdmin = user.isAdmin === true;

  const token = await admin.auth().createCustomToken(userId, { role, isAdmin });

  // 실패 카운트 초기화 (로그인 성공 경로를 막지 않도록 실패해도 무시)
  secretRef
    .update({ failedCount: 0, lockedUntil: admin.firestore.FieldValue.delete() })
    .catch(() => {});

  return {
    token,
    user: { userId, name: user.name || userId, role, isAdmin, team: user.team || '' },
  };
});

// ─────────────────────────────────────────────────────────────
// signup — 가입 신청. users가 비어 있으면 첫 계정을 관리자로 만든다.
//          (신규 배포 시 아무도 로그인할 수 없던 부트스트랩 교착 해소)
// ─────────────────────────────────────────────────────────────
exports.signup = onCall(async (request) => {
  const d = request.data || {};
  const userId = String(d.userId || '').trim();
  const password = String(d.password || '');
  const name = String(d.name || '').trim();
  const team = String(d.team || '').trim();

  if (!name) throw new HttpsError('invalid-argument', '이름을 입력하세요.');
  if (!validUserId(userId)) {
    throw new HttpsError('invalid-argument', '아이디는 영문·숫자·밑줄(_)만 사용할 수 있습니다.');
  }
  if (password.length < 8) {
    throw new HttpsError('invalid-argument', '비밀번호는 8자 이상이어야 합니다.');
  }

  const userRef = db.collection(USERS).doc(userId);
  const secretRef = db.collection(SECRETS).doc(userId);
  const secretRecord = await hashPassword(password);

  // 첫 계정 판정과 아이디 중복 검사를 한 트랜잭션에서 처리해
  // 동시 가입으로 중복 아이디나 관리자 2명이 생기지 않게 한다.
  const isFirst = await db.runTransaction(async (tx) => {
    const existing = await tx.get(userRef);
    if (existing.exists) {
      throw new HttpsError('already-exists', '이미 사용 중인 아이디입니다.');
    }
    // 문서 1건만 읽어 비어 있는지 확인 (전체 스캔 회피)
    const anyUser = await tx.get(db.collection(USERS).limit(1));
    const first = anyUser.empty;

    tx.set(userRef, {
      userId,
      name,
      team,
      role: first ? '센터장' : '입력자',
      isAdmin: first,
      approved: first,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(secretRef, {
      ...secretRecord,
      failedCount: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return first;
  });

  if (isFirst) {
    console.log(`[bootstrap] 첫 계정 '${userId}'을(를) 관리자로 생성했습니다.`);
  }

  return {
    bootstrapped: isFirst,
    message: isFirst
      ? '첫 관리자 계정이 생성되었습니다. 바로 로그인하세요.'
      : '가입 신청이 완료되었습니다. 관리자 승인 후 로그인하세요.',
  };
});

// ─────────────────────────────────────────────────────────────
// approveStaff — 가입 승인 + 역할 부여
//   호출자보다 높은 등급은 부여할 수 없다.
//   (기존에는 팀장이 신규 가입자를 센터장으로 승인할 수 있었다)
// ─────────────────────────────────────────────────────────────
exports.approveStaff = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

  const myRank = callerRank(auth);
  if (myRank < 3) {
    throw new HttpsError('permission-denied', '직원 승인 권한이 없습니다.');
  }

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
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────
// changePassword — 본인 또는 관리자가 변경
// ─────────────────────────────────────────────────────────────
exports.changePassword = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

  const d = request.data || {};
  const targetId = String(d.userId || auth.uid).trim();
  const newPassword = String(d.newPassword || '');
  const currentPassword = String(d.currentPassword || '');

  if (!validUserId(targetId)) throw new HttpsError('invalid-argument', '대상 아이디가 올바르지 않습니다.');
  if (newPassword.length < 8) {
    throw new HttpsError('invalid-argument', '비밀번호는 8자 이상이어야 합니다.');
  }

  const isSelf = targetId === auth.uid;
  const isAdminCaller = auth.token && auth.token.isAdmin === true;
  if (!isSelf && !isAdminCaller) {
    throw new HttpsError('permission-denied', '다른 직원의 비밀번호는 관리자만 변경할 수 있습니다.');
  }

  const secretRef = db.collection(SECRETS).doc(targetId);

  // 본인 변경은 현재 비밀번호를 확인한다. 관리자 재설정은 생략.
  if (isSelf) {
    const snap = await secretRef.get();
    if (!snap.exists || !(await verifyPassword(currentPassword, snap.data()))) {
      throw new HttpsError('unauthenticated', '현재 비밀번호가 올바르지 않습니다.');
    }
  }

  const record = await hashPassword(newPassword);
  await secretRef.set(
    {
      ...record,
      failedCount: 0,
      lockedUntil: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { ok: true };
});
