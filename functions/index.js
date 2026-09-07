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
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
// FieldValue/Timestamp는 서브경로에서 직접 가져온다.
// `admin.firestore.FieldValue` 형태는 Functions 에뮬레이터가 admin 모듈을
// 감쌀 때 정적 프로퍼티가 사라져 로그인이 INTERNAL로 실패한다
// (배포본은 동작하므로 에뮬레이터에서만 드러난다).
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { hashPassword, verifyPassword } = require('./password');
const { diagnose } = require('./errors');

admin.initializeApp();
const db = admin.firestore();

// Firestore가 asia-northeast3(서울)에 있으므로 함수도 같은 리전에 둔다.
setGlobalOptions({ region: 'asia-northeast3', maxInstances: 10 });

/**
 * 모든 콜러블을 감싼다 — 잡히지 않은 예외가 그대로 나가지 않게.
 *
 * Cloud Functions는 잡히지 않은 예외를 `INTERNAL`로 돌려주고, 클라이언트는
 * `code === 'internal'`이면 메시지를 버린다. 그래서 프로젝트 설정이 하나
 * 빠졌을 때 화면에 단서가 하나도 남지 않았다 — 신규 배포에서 가장 오래
 * 붙잡히는 지점이다.
 *
 * 알아본 설정 오류는 `failed-precondition`으로 바꿔 **메시지가 화면까지**
 * 가게 하고, 구체적인 값(서비스 계정 이메일·스택)은 로그에만 남긴다.
 */
function callable(name, handler, options) {
  // options는 onCall에 그대로 넘긴다 — 시크릿 선언(secrets)이 대표적이다.
  // 선언하지 않으면 배포된 함수에서 process.env로 값을 읽을 수 없다.
  return onCall(options || {}, async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof HttpsError) throw err;   // 의도한 거부는 그대로

      const setup = diagnose(err);
      logger.error(`[${name}] 처리 실패${setup ? ' — ' + setup.code : ''}`, {
        code: err && err.code,
        message: err && err.message,
        fix: setup && setup.fix,
        stack: err && err.stack,
      });

      if (setup) throw new HttpsError('failed-precondition', setup.message);
      throw new HttpsError('internal', '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    }
  });
}

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
exports.login = callable('login', async (request) => {
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
    const update = { failedCount: failed, lastFailedAt: FieldValue.serverTimestamp() };
    if (failed >= MAX_FAILED) {
      update.lockedUntil = Timestamp.fromMillis(Date.now() + LOCKOUT_MS);
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
    .update({ failedCount: 0, lockedUntil: FieldValue.delete() })
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
exports.signup = callable('signup', async (request) => {
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
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(secretRef, {
      ...secretRecord,
      failedCount: 0,
      updatedAt: FieldValue.serverTimestamp(),
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
exports.approveStaff = callable('approveStaff', async (request) => {
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
// upsertStaff — 직원 등록·수정 (관리자 화면에서 호출)
//
// users 컬렉션은 보안 규칙이 클라이언트 쓰기를 전면 차단하므로
// 등록·수정·비밀번호 변경이 모두 이 함수를 거친다.
// 호출자보다 높은 등급은 부여할 수 없다.
// ─────────────────────────────────────────────────────────────
exports.upsertStaff = callable('upsertStaff', async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

  const myRank = callerRank(auth);
  if (myRank < 3) throw new HttpsError('permission-denied', '직원 관리 권한이 없습니다.');

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
      await userRef.set(
        {
          userId, name, role, team,
          isAdmin: wantAdmin,
          ...(existing.exists ? {} : { approved: true, active: true }),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (password) {
        const record = await hashPassword(password);
        await db.collection(SECRETS).doc(userId).set(
          { ...record, failedCount: 0, updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
      results.push({ userId, ok: true, created: !existing.exists });
    } catch (err) {
      console.error(`[upsertStaff] ${userId} 처리 실패:`, err);
      results.push({ userId, ok: false, error: '저장 중 오류가 발생했습니다.' });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return { okCount, failCount: results.length - okCount, results };
});

// ─────────────────────────────────────────────────────────────
// setStaffActive — 재직·퇴사 전환
//
// 마지막 관리자를 비활성화하면 권한 설정·전체 초기화가 영구히 불가능해지므로
// 서버에서 막는다(로그인 자체가 차단되기 때문에 되돌릴 방법이 없다).
// ─────────────────────────────────────────────────────────────
exports.setStaffActive = callable('setStaffActive', async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  if (callerRank(auth) < 3) {
    throw new HttpsError('permission-denied', '직원 관리 권한이 없습니다.');
  }

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

  await ref.update({ active });
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────
// changePassword — 본인 또는 관리자가 변경
// ─────────────────────────────────────────────────────────────
exports.changePassword = callable('changePassword', async (request) => {
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
      lockedUntil: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────
// syncAccountBalance — 거래가 바뀌면 계좌 currentBalance를 서버에서 재계산
//
// 왜 서버인가
//   기존에는 클라이언트 updateAccBalance가 부분 로드된 S.transactions(기본 당월)로
//   계산해 currentBalance를 덮어썼다. 그래서 거래를 하나만 저장해도 이전 기록이
//   사라졌다. 게다가 입력자는 보안 규칙상 계좌 전체 거래를 읽을 수 없어
//   클라이언트에서는 애초에 올바른 계산이 불가능하다.
//
//   서버에서 계산하면 역할과 무관하게 항상 전체 거래를 근거로 하고,
//   "잔액 계산 → 거래 저장" 순서 뒤바뀜 문제도 함께 사라진다.
// ─────────────────────────────────────────────────────────────
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { calcAccountBalance, affectsBalance } = require('./balance.cjs');

const TRANSACTIONS = 'transactions';
const ACCOUNTS = 'accounts';

/**
 * 한 계좌의 currentBalance를 전체 거래 기준으로 다시 쓴다.
 *
 * 멱등하다 — 트리거가 중복 발동해도 같은 값이 나온다. 그래서 증분 갱신
 * (FieldValue.increment)을 쓰지 않는다. 중복 발동 한 번에 금액이 어긋나면
 * 금전 장부로서 신뢰를 잃는다.
 *
 * 읽기 범위
 *   기준일(initialBalanceDate)이 있으면 그 이후 거래만 읽는다. 잔액식이 어차피
 *   `date <= base`를 버리므로 결과는 동일하고, 과거 연도가 쌓인 계좌에서
 *   읽는 문서 수가 크게 줄어든다. (복합 인덱스 accountId+date 사용)
 */
async function recalcAccount(accountId) {
  if (!accountId) return;
  const accRef = db.collection(ACCOUNTS).doc(accountId);
  const accSnap = await accRef.get();
  if (!accSnap.exists) return;

  const account = { id: accountId, ...accSnap.data() };
  let q = db.collection(TRANSACTIONS).where('accountId', '==', accountId);
  const base = account.initialBalanceDate || '';
  if (base) q = q.where('date', '>', base);
  const trxSnap = await q.get();
  const transactions = trxSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const balance = calcAccountBalance(account, transactions);
  if (Number(account.currentBalance || 0) === balance) return;   // 변화 없으면 쓰지 않는다
  await accRef.update({ currentBalance: balance });
}

exports.syncAccountBalance = onDocumentWritten(
  { document: 'transactions/{trxId}' },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();

    // 잔액식이 읽는 필드가 하나도 안 바뀌었으면 계좌 문서조차 읽지 않고 끝낸다.
    // 영수증 첨부·카테고리 인라인 수정·드래그 순서 변경이 여기서 걸러진다 —
    // 이들이 가장 흔한 쓰기이므로 이 한 줄이 읽기량을 크게 줄인다.
    if (!affectsBalance(before, after)) return;

    // 계좌가 바뀐 수정이면 양쪽 모두 다시 계산해야 한다.
    const affected = new Set();
    if (before && before.accountId) affected.add(before.accountId);
    if (after && after.accountId) affected.add(after.accountId);
    if (!affected.size) return;

    // 잔액 갱신 실패가 거래 저장을 되돌리지는 않는다. 실패는 로그로 남기고
    // tools/recalc-balances.mjs로 언제든 바로잡을 수 있다.
    for (const accountId of affected) {
      try {
        await recalcAccount(accountId);
      } catch (err) {
        console.error(`[syncAccountBalance] 계좌 ${accountId} 재계산 실패:`, err);
      }
    }
  }
);

/**
 * 계좌의 기초잔액·기준일이 바뀌면 currentBalance를 다시 계산한다.
 *
 * 필요한 이유
 *   거래 트리거만으로는 부족하다. 계좌 등록·수정 폼(modals.js)과 연도 마감
 *   (settings.js)이 currentBalance를 직접 쓰는데, 그 시점에는 거래가 변하지 않으므로
 *   syncAccountBalance가 발동하지 않는다. 특히 계좌 정보를 수정하면
 *   currentBalance가 기초잔액으로 되돌아간 채 남는다.
 *
 * 무한 루프 방지
 *   이 트리거 자신이 쓰는 값은 currentBalance뿐이다. 따라서 initialBalance나
 *   initialBalanceDate가 실제로 바뀐 경우에만 재계산하고, 그 외에는 즉시 반환한다.
 */
exports.syncAccountOnSettingsChange = onDocumentWritten(
  { document: 'accounts/{accountId}' },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!after) return;                       // 삭제된 계좌는 계산할 것이 없다

    const baseChanged =
      !before ||
      Number(before.initialBalance || 0) !== Number(after.initialBalance || 0) ||
      (before.initialBalanceDate || '') !== (after.initialBalanceDate || '');

    if (!baseChanged) return;                 // currentBalance만 바뀐 경우 = 이 트리거 자신의 쓰기

    try {
      await recalcAccount(event.params.accountId);
    } catch (err) {
      console.error(
        `[syncAccountOnSettingsChange] 계좌 ${event.params.accountId} 재계산 실패:`,
        err
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────
// syncLockedMonths — 마감(최종 결재 완료) 월 색인을 유지한다
//
// 왜 필요한가
//   마감 여부는 모든 역할이 알아야 한다 — 입력자도 마감된 달에는 거래를 넣을 수
//   없어야 한다. 그런데 앱은 그 정보를 reports 컬렉션을 조회해서 만들고 있었고,
//   보안 규칙은 reports를 담당자(등급 2) 이상만 읽게 한다. 그래서 입력자가
//   로그인하면 그 조회가 거부되고 Promise.all이 깨져 **앱 초기화가 통째로 실패**했다
//   (화면이 빈 채로 멈춘다). 규칙을 적용한 뒤에야 드러나는 문제였다.
//
//   금액·의견 없이 "어느 (입주자, 월)이 잠겼는지"만 담은 문서를 두면 전원 조회를
//   허용해도 안전하고, 조회가 쿼리 대신 문서 1건 읽기라 읽기량도 줄어든다.
//
//   클라이언트는 규칙상 config를 쓸 수 없다(관리자 예외뿐). 이 트리거만 Admin SDK로
//   갱신하므로 잠금을 위조해 풀 수 없다.
// ─────────────────────────────────────────────────────────────
const {
  LOCKED_MONTHS_DOC,
  lockIndexChange,
  buildLockIndex,
} = require('./locked-months.cjs');

const CONFIG = 'config';
const REPORTS = 'reports';

exports.syncLockedMonths = onDocumentWritten(
  { document: 'reports/{reportId}' },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();

    const change = lockIndexChange(before, after);
    if (!change) return;                        // 마감 여부가 안 바뀌면 할 일 없음

    const ref = db.collection(CONFIG).doc(LOCKED_MONTHS_DOC);
    try {
      await ref.set({
        months: {
          [change.key]: change.locked ? true : FieldValue.delete(),
        },
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (err) {
      // 색인 갱신 실패가 결재 자체를 되돌리지는 않는다. rebuildLockedMonths로 복구한다.
      logger.error('[syncLockedMonths] 색인 갱신 실패', {
        key: change.key, locked: change.locked, message: err && err.message,
      });
    }
  }
);

/**
 * rebuildLockedMonths — 색인을 reports 전체에서 다시 만든다.
 *
 * 쓰는 때
 *   · 마이그레이션 직후 최초 백필 (트리거는 그때부터의 변경만 본다)
 *   · 트리거가 실패해 색인이 어긋났을 때 복구
 *
 * 전체 스캔이므로 관리자만, 그리고 사람이 눌러야 돈다.
 */
exports.rebuildLockedMonths = callable('rebuildLockedMonths', async (request) => {
  if (callerRank(request.auth) < 99) {
    throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
  }

  const snap = await db.collection(REPORTS).where('status', '==', 'confirmed').get();
  const months = buildLockIndex(snap.docs.map((d) => d.data()));

  // set(merge 없이)으로 통째로 교체한다 — 지워져야 할 낡은 키가 남지 않게.
  await db.collection(CONFIG).doc(LOCKED_MONTHS_DOC).set({
    months,
    updatedAt: new Date().toISOString(),
    rebuiltBy: request.auth.uid,
  });

  return { count: Object.keys(months).length };
});

// ─────────────────────────────────────────────────────────────
// 파생 명부 — 로그인 한 번에 컬렉션 전체를 읽지 않게 한다
//
// 트리거와 복구 콜러블은 functions/directory-fns.js에 있다.
// 이 파일은 이미 상한을 넘겨 있고(test/architecture.test.mjs), 명부는
// 인증과 아무 관계가 없어 따로 두는 편이 읽기 쉽다.
// ─────────────────────────────────────────────────────────────
Object.assign(exports, require('./directory-fns')({
  db, callable, callerRank, HttpsError, logger, onDocumentWritten,
}));

// ─────────────────────────────────────────────────────────────
// 영수증·통장 사진 자동입력 (Claude API)
//
// 콜러블과 가드는 functions/ai-fns.js에 있다. 이 파일은 인증이 본업이고
// 이미 상한을 넘겨 있어(test/architecture.test.mjs), 관계없는 기능은 따로 둔다.
// ─────────────────────────────────────────────────────────────
Object.assign(exports, require('./ai-fns')({
  db, callable, callerRank, HttpsError, logger, FieldValue, Timestamp,
}));

// ─────────────────────────────────────────────────────────────
// syncSummaryVersion — 월별 요약 캐시를 낡았다고 표시한다
//
// 대시보드는 입주자 카드마다 당월 수입·지출을 보여주는데, 그 값을 만들려고
// **당월 거래 전체를 읽었다.** 관리자가 입주자 30명을 보면 한 세션에 1,200건이고,
// 하루 두 번 접속하는 사람이 25명이면 그것만으로 무료 한도의 절반을 쓴다.
//
// 그 값은 거래가 바뀌지 않으면 바뀌지 않는다. 그래서 계산 결과를 문서 하나에
// 담아 두고, 이 트리거가 **버전만 올려** 낡음을 표시한다. 계산은 클라이언트가
// 한다 — 서버가 계산하면 입력자 권한으로는 읽을 수 없는 거래까지 합산해야 하고,
// 그 값을 누구에게 보여줄지 다시 판단해야 한다.
//
// 클라이언트는 버전이 어긋나면 직접 계산으로 떨어진다. 따라서 이 트리거가
// 배포되지 않았거나 실패해도 **화면 값은 항상 맞는다** — 읽기만 줄지 않는다.
// ─────────────────────────────────────────────────────────────
const {
  affectedSummaryKeys,
  affectsSummary,
} = require('./summary-cache.cjs');

const SUMMARY_CACHES = 'summaryCaches';

exports.syncSummaryVersion = onDocumentWritten(
  { document: 'transactions/{trxId}' },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();

    // 합계를 바꾸지 않는 쓰기(영수증 첨부·순서 변경·내용 수정)는 무시한다.
    // 그런 쓰기까지 버전을 올리면 캐시가 계속 무효화되어 캐시가 없는 것과 같다.
    if (!affectsSummary(before, after)) return;

    const keys = affectedSummaryKeys(before, after);
    if (!keys.length) return;

    // 날짜나 입주자가 바뀐 수정이면 양쪽 달을 모두 올린다 —
    // 8월 거래를 9월로 옮기면 두 달의 합계가 다 바뀐다.
    await Promise.all(keys.map(async (key) => {
      try {
        await db.collection(SUMMARY_CACHES).doc(key).set({
          sourceVersion: FieldValue.increment(1),
        }, { merge: true });
      } catch (err) {
        // 표시 실패는 화면을 틀리게 만들지 않는다(클라이언트가 직접 계산한다).
        logger.warn('[syncSummaryVersion] 버전 갱신 실패', {
          key, message: err && err.message,
        });
      }
    }));
  }
);
