'use strict';

/**
 * Smart Care Ledger — 인증 Cloud Functions
 *
 * 이 앱은 사회복지사가 아이디/비밀번호로 로그인하는 기존 UX를 유지한다.
 * 대신 비밀번호 검증을 서버로 옮기고 Firebase 커스텀 토큰을 발급해서,
 * Firestore/Storage 보안 규칙이 request.auth를 근거로 판정할 수 있게 한다.
 *
 * 발급 토큰의 uid == users 문서 ID == 로그인 아이디.
 * 역할·재직·권한은 토큰에 싣지 않고 `authz/{uid}`를 매 요청마다 확인한다.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
// FieldValue/Timestamp는 서브경로에서 직접 가져온다.
// `admin.firestore.FieldValue` 형태는 Functions 에뮬레이터가 admin 모듈을
// 감쌀 때 정적 프로퍼티가 사라져 로그인이 INTERNAL로 실패한다
// (배포본은 동작하므로 에뮬레이터에서만 드러난다).
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { randomBytes } = require('node:crypto');
const { hashPassword, verifyPassword } = require('./password');
const { randomInt } = require('crypto');
const { diagnose } = require('./errors');

admin.initializeApp();
const db = admin.firestore();

// 호출자 판정은 한 곳에서 한다 — 규칙·Storage 규칙과 같은 근거(authz/{uid})를
// 본다. 토큰 클레임은 발급 시점에 굳어서 강등·퇴사를 반영하지 못한다.
const { requireCaller } = require('./caller.cjs')({ db, HttpsError });

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

/**
 * 권한 투영 헬퍼. 아래 authz-fns 배선에서 채워진다.
 *
 * 여기에 선언해 두는 이유: signup 이 이 파일 위쪽에 있어 배선보다 먼저
 * 정의된다. exports 에 걸면 Firebase 가 배포 대상 함수로 해석하므로
 * 모듈 변수여야 한다.
 *
 * 초기값이 던지는 이유: 배선을 빠뜨리면 조용히 authz 없는 계정이 만들어지는
 * 대신 가입이 실패한다. 둘 다 나쁘지만 조용한 쪽이 더 나쁘다.
 */
const notWired = () => { throw new Error('authz-fns 배선 전에 호출됐습니다'); };
let authz = { currentOverride: notWired, authzWriteFor: notWired };

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

  // 임시 비밀번호는 유효 시간이 지나면 쓸 수 없다. 여기서 막지 않으면
  // 한 번 발급된 값이 영영 살아 있는 두 번째 비밀번호가 된다.
  const tempExpired = secret.mustChangePassword === true
    && secret.tempExpiresAt && typeof secret.tempExpiresAt.toMillis === 'function'
    && secret.tempExpiresAt.toMillis() <= Date.now();
  if (tempExpired) {
    throw new HttpsError(
      'deadline-exceeded',
      '임시 비밀번호의 유효 시간이 지났습니다. 관리자에게 다시 요청하세요.',
    );
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

  // 토큰에는 **신원만** 싣는다(uid).
  //
  // 예전에는 { role, isAdmin } 을 클레임으로 실었고, 규칙과 함수가 그것으로
  // 판정했다. 클레임은 발급 시점에 굳는다 — 강등해도, 퇴사시켜도 이미 나간
  // 토큰은 옛 권한을 그대로 갖고 refresh 로 계속 갱신된다. 만료를 기다리는
  // 것은 차단 정책이 아니다.
  //
  // 이제 판정 근거는 authz/{uid} 한 곳이고 매번 새로 읽는다. 아래 user 객체는
  // 화면이 이름·역할을 표시하는 데 쓰는 값이지 권한의 근거가 아니다.
  const token = await admin.auth().createCustomToken(userId);

  // 실패 카운트 초기화 (로그인 성공 경로를 막지 않도록 실패해도 무시)
  secretRef
    .update({ failedCount: 0, lockedUntil: FieldValue.delete() })
    .catch(() => {});

  return {
    token,
    user: { userId, name: user.name || userId, role, isAdmin, team: user.team || '' },
    // 임시 비밀번호로 들어왔다. 화면이 바꾸기 전에는 앱에 들여보내지 않는다.
    mustChangePassword: secret.mustChangePassword === true,
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
  // 등급표는 트랜잭션 밖에서 읽는다 — 안에서 읽으면 config 문서가 잠겨
  // 가입이 서로 직렬화된다.
  const override = await authz.currentOverride();

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

    const userDoc = {
      userId,
      name,
      team,
      role: first ? '센터장' : '입력자',
      isAdmin: first,
      approved: first,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    };
    tx.set(userRef, userDoc);
    tx.set(secretRef, {
      ...secretRecord,
      failedCount: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 권한 스냅샷도 **같은 트랜잭션**에서 만든다. 뒤따라 쓰면 실패했을 때
    // caps 없는 계정이 남고, 그것이 첫 관리자라면 백필조차 실행할 수 없어
    // 부트스트랩이 통째로 막힌다.
    // (승인 대기 계정은 enabled:false 로 만들어지므로 열리는 것은 없다)
    const w = authz.authzWriteFor(userId, userDoc, override);
    tx.set(w.ref, w.data, { merge: true });

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
// 권한 투영 · 직원 관리
//
// 순서가 중요하다 — 직원 함수가 authz 의 authzWriteFor 를 받아 쓴다.
// 역할·재직이 바뀌면 caps 도 함께 바뀌어야 하고, 그것을 빠뜨리면 규칙이
// 낡은 값으로 판정한다(강등된 사람이 계속 통과한다).
//
// ⚠️ caps 백필 전에는 authz 콜러블이 모든 호출을 거부한다 — 의도된 것이다.
//    백필은 기존 users 문서와 권한 카탈로그를 바탕으로 authz를 만든다.
// ─────────────────────────────────────────────────────────────
const authzFns = require('./authz-fns')({
  db, callable, HttpsError, logger, FieldValue,
});
// 콜러블만 내보낸다. Firebase 는 **모든 export 를 배포 대상 함수로 해석**하므로,
// authzWriteFor 같은 내부 헬퍼가 섞이면 정체불명의 함수가 배포된다.
exports.backfillAuthz = authzFns.backfillAuthz;

// 입주자 관리 — clients 원본과 두 투영본을 한 트랜잭션에서 쓴다.
Object.assign(exports, require('./client-fns')({
  db, callable, HttpsError, logger, FieldValue,
  randomId: () => randomBytes(16).toString('base64url'),
}));

// 팀 목록 — config/teams 문서 하나. 팀은 배정의 틀이지 권한의 축이 아니다.
Object.assign(exports, require('./team-fns')({
  db, callable, HttpsError, logger, FieldValue,
}));

// 은행 파서 — config/bankParsers 문서 하나. 은행 하나 늘리는 데 배포가
// 필요하지 않게 한다(파일을 가진 사람이 곧 열을 아는 사람이다).
Object.assign(exports, require('./bank-parser-fns')({
  db, callable, HttpsError, logger, FieldValue,
}));

// 권한 등급표 — 저장이 곧 집행이 되도록 config 와 전 사용자 caps 를 함께 쓴다.
// 콜러블만 꺼낸다(팩토리 반환값에 테스트용 순수 함수가 함께 들어 있다).
exports.savePermissions = require('./permissions-fns')({
  db, callable, HttpsError, logger, FieldValue,
}).savePermissions;

// 분류 이름·색상 — 이름을 바꾸면 거래가 따라와야 하는데, 공통 분류를
// 관리하는 팀장·센터장은 trx.edit 을 갖지 않는다(작성자·결재자 분리).
// 브라우저에서 하면 이름만 바뀌고 거래는 그대로 남는 절반의 상태가 된다.
Object.assign(exports, require('./category-fns')({
  db, callable, requireCaller, HttpsError, logger, FieldValue,
}));

// 자산이동 — 두 다리를 한 트랜잭션에서 만든다. 상대편을 찾는 조회까지
// 그 안에 있어야 두 사람이 같은 상대편을 덮어쓰지 않는다.
Object.assign(exports, require('./transfer-fns')({
  db, callable, requireCaller, HttpsError, logger, FieldValue,
}));

// 연도 마감 — 잠긴 달의 거래를 지우고 보관 이미지를 덮어쓴다.
// 둘 다 브라우저에서는 할 수 없는 일이다(규칙이 막고, generation 사전조건이 없다).
Object.assign(exports, require('./archive-fns')({
  db, getBucket: () => admin.storage().bucket(), callable, HttpsError, logger, FieldValue,
}));

// 보고서 결재 — 전이표를 서버가 집행한다. 브라우저가 reports 를 직접 쓰면
// 콘솔 한 줄로 팀장·센터장 결재를 건너뛸 수 있었다.
Object.assign(exports, require('./report-fns')({
  db, callable, HttpsError, logger, FieldValue,
}));

// 영수증 최종화 — 브라우저는 스테이징에만 올리고 옮기는 것은 서버가 한다.
// randomId 를 주입하는 이유: 난수 생성은 순수 모듈이 할 일이 아니고,
// 테스트가 결정적인 값을 넣을 수 있어야 한다.
Object.assign(exports, require('./receipt-fns')({
  db, getBucket: () => admin.storage().bucket(), callable, HttpsError, logger, FieldValue,
  onSchedule,
  randomId: () => randomBytes(16).toString('base64url'),
}));

// signup 은 이 배선보다 위에 정의돼 있다. exports 에 걸면 Firebase 가 그것을
// 배포 대상 함수로 취급하므로(모든 export 가 함수로 해석된다) 모듈 변수에 담는다.
// 콜러블은 배포가 아니라 호출 시점에 실행되므로 순서는 문제되지 않는다.
authz = authzFns;

Object.assign(exports, require('./staff-fns')({
  db, callable, requireCaller, rankOf, HttpsError, logger, FieldValue,
  hashPassword, validUserId, VALID_ROLES, USERS, SECRETS,
  currentOverride: authzFns.currentOverride,
  authzWriteFor: authzFns.authzWriteFor,
  randomId: () => randomBytes(16).toString('base64url'),
}));

// 비밀번호 분실 — 관리자가 임시 비밀번호를 발급한다. 다만 결재에 닿는 계정
// (팀장·센터장·관리자)은 다른 관리자의 승인이 한 번 더 필요하다. 관리자 자격은
// 업무 권한과 직교한다는 전제를 지키기 위해서다.
// 콜러블만 꺼낸다(팩토리 반환값에 테스트용 순수 함수가 함께 들어 있다).
const passwordResetFns = require('./password-reset-fns')({
  db, callable, requireCaller, HttpsError, logger, FieldValue, Timestamp,
  hashPassword, validUserId, randomInt,
});
exports.requestPasswordReset = passwordResetFns.requestPasswordReset;
exports.approvePasswordReset = passwordResetFns.approvePasswordReset;

// ─────────────────────────────────────────────────────────────
// changePassword — 본인만 변경
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
  if (!isSelf) {
    throw new HttpsError(
      'permission-denied',
      '다른 직원의 비밀번호는 변경할 수 없습니다. 본인이 재설정 절차를 진행해야 합니다.'
    );
  }

  const secretRef = db.collection(SECRETS).doc(targetId);

  const snap = await secretRef.get();
  if (!snap.exists || !(await verifyPassword(currentPassword, snap.data()))) {
    throw new HttpsError('unauthenticated', '현재 비밀번호가 올바르지 않습니다.');
  }

  const record = await hashPassword(newPassword);
  await secretRef.set(
    {
      ...record,
      failedCount: 0,
      lockedUntil: FieldValue.delete(),
      // 임시 비밀번호로 들어온 경우 여기서 그 표식이 사라진다 — 바꾸기 전에는
      // 앱을 쓸 수 없고, 바꾸고 나면 평범한 계정으로 돌아간다.
      mustChangePassword: FieldValue.delete(),
      tempExpiresAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────
// 잔액 재계산 · 마감 월 색인 — functions/ledger-triggers.js
//
// 인증과 아무 관계가 없어 따로 뒀다. 이 파일이 600줄 상한을 넘겨
// test/architecture.test.mjs 가 쪼개라고 말한 것이 계기다.
// ─────────────────────────────────────────────────────────────
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
Object.assign(exports, require('./ledger-triggers')({
  db, callable, requireCaller, HttpsError, logger, FieldValue,
}));

// ─────────────────────────────────────────────────────────────
// 파생 명부 — 로그인 한 번에 컬렉션 전체를 읽지 않게 한다
//
// 트리거와 복구 콜러블은 functions/directory-fns.js에 있다.
// 이 파일은 이미 상한을 넘겨 있고(test/architecture.test.mjs), 명부는
// 인증과 아무 관계가 없어 따로 두는 편이 읽기 쉽다.
// ─────────────────────────────────────────────────────────────
Object.assign(exports, require('./directory-fns')({
  db, callable, requireCaller, HttpsError, logger, onDocumentWritten,
}));

// ─────────────────────────────────────────────────────────────
// 영수증·통장 사진 자동입력 · 보고서 분석 (Gemini API)
//
// 콜러블과 가드는 functions/ai-fns.js에 있다. 이 파일은 인증이 본업이고
// 이미 상한을 넘겨 있어(test/architecture.test.mjs), 관계없는 기능은 따로 둔다.
// ─────────────────────────────────────────────────────────────
Object.assign(exports, require('./ai-fns')({
  db, getBucket: () => admin.storage().bucket(),
  callable, requireCaller, HttpsError, logger, FieldValue, Timestamp,
}));


// ─────────────────────────────────────────────────────────────
// syncSummaryVersion — 월별 요약 캐시를 낡았다고 표시한다
// 왜 캐시가 있고 왜 서버가 계산하지 않는지는 functions/summary-cache.cjs 머리말에.
// ─────────────────────────────────────────────────────────────
const {
  affectedSummaryTargets,
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

    const targets = affectedSummaryTargets(before, after);
    if (!targets.length) return;

    // 날짜나 입주자가 바뀐 수정이면 양쪽 달을 모두 올린다 —
    // 8월 거래를 9월로 옮기면 두 달의 합계가 다 바뀐다.
    await Promise.all(targets.map(async ({ key, clientId, ym }) => {
      try {
        // clientId·ym 을 **함께** 심는다.
        //
        // 예전에는 sourceVersion 만 올렸다. 그러면 그 (입주자, 월)을 아무도
        // 아직 보지 않은 상태에서 거래가 먼저 써질 때, 트리거가 **clientId 가
        // 없는 문서**를 만든다. 그 문서는 규칙상 브라우저가 다룰 수 없다:
        //   · 읽기는 seesClient(resource.data.clientId) 가 '' 를 보고 막고,
        //   · 쓰기는 request.resource.data.clientId == resource.data.clientId
        //     가 없는 필드를 비교하다 평가 오류로 막힌다.
        // 그래서 그 달의 캐시는 **영영 채워지지 않고** 대시보드가 매번 당월
        // 거래를 다시 읽는다 — 화면 값은 맞으므로 아무도 눈치채지 못한다.
        // 읽기 비용 최적화(§12-1)가 조용히 꺼져 있던 자리다.
        await db.collection(SUMMARY_CACHES).doc(key).set({
          clientId, ym,
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
