'use strict';

/**
 * 설정 미비로 생긴 예외를 "무엇을 해야 하는지"로 바꾼다.
 *
 * 왜 필요한가 — Cloud Functions는 잡히지 않은 예외를 전부 `INTERNAL`로
 * 클라이언트에 돌려준다. 그리고 클라이언트(`auth.js` `fnErrorMessage`)는
 * `code === 'internal'`이면 메시지를 버리고 "로그인 실패. 다시 시도하세요."만
 * 보여준다. 그래서 **프로젝트 설정이 하나 빠졌을 때 화면에 아무 단서가 없다.**
 * 신규 프로젝트(스테이징 포함) 구축에서 가장 많이 막히는 지점이다.
 *
 * 여기서 알아보는 원인은 전부 "사람이 콘솔에서 한 번 해야 하는 일"이다.
 * 데이터도 자격증명도 노출하지 않으므로 화면에 그대로 띄워도 안전하다.
 * 서비스 계정 이메일·스택 등 구체적인 값은 로그로만 남긴다.
 */

/** 진단된 설정 오류들 */
const SETUP_ERRORS = {
  E_SIGNBLOB: {
    message:
      '서버 설정이 끝나지 않았습니다 (E_SIGNBLOB). ' +
      '이 프로젝트의 함수 실행 서비스 계정에 ' +
      '"서비스 계정 토큰 생성자(Service Account Token Creator)" 역할을 부여해야 ' +
      '로그인 토큰을 발급할 수 있습니다.',
    // 2세대 함수는 Cloud Run의 기본 컴퓨팅 서비스 계정으로 도는데, 이 계정에는
    // 해당 역할이 기본으로 없다. 1세대에서 쓰던 App Engine 기본 계정에는 있었다.
    fix: 'gcloud projects add-iam-policy-binding <PROJECT_ID> ' +
         '--member=serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com ' +
         '--role=roles/iam.serviceAccountTokenCreator',
  },
  E_NO_FIRESTORE: {
    message:
      '서버 설정이 끝나지 않았습니다 (E_NO_FIRESTORE). ' +
      'Firebase 콘솔에서 Firestore 데이터베이스를 먼저 만들어 주세요.',
    fix: 'Firebase 콘솔 → Firestore Database → 데이터베이스 만들기 (리전: asia-northeast3)',
  },
  E_FIRESTORE_PERM: {
    message:
      '서버 설정이 끝나지 않았습니다 (E_FIRESTORE_PERM). ' +
      '함수 실행 서비스 계정이 Firestore에 접근할 수 없습니다.',
    fix: '실행 서비스 계정에 roles/datastore.user 부여',
  },
  E_NO_AUTH: {
    message:
      '서버 설정이 끝나지 않았습니다 (E_NO_AUTH). ' +
      'Firebase 콘솔에서 Authentication을 활성화해 주세요.',
    fix: 'Firebase 콘솔 → Authentication → 시작하기 (로그인 제공업체는 켜지 않아도 됩니다)',
  },
  E_BILLING: {
    message:
      '서버 설정이 끝나지 않았습니다 (E_BILLING). ' +
      '이 프로젝트에 결제(Blaze 요금제)가 연결되어 있지 않습니다.',
    fix: 'Firebase 콘솔 → 프로젝트 설정 → 사용량 및 결제 → 요금제 수정',
  },
};

/**
 * 예외에서 읽을 수 있는 문자열을 전부 모은다.
 * gRPC 오류는 `details`에, HTTP 오류는 중첩된 `errorInfo`/`cause`에 실려 온다.
 */
function textOf(err) {
  if (!err) return '';
  const parts = [];
  const push = (v) => { if (typeof v === 'string' && v) parts.push(v); };
  push(err.message);
  push(err.details);
  push(err.code === undefined ? '' : String(err.code));
  if (err.errorInfo) { push(err.errorInfo.code); push(err.errorInfo.message); }
  if (err.cause && err.cause !== err) push(textOf(err.cause));
  return parts.join(' | ');
}

/**
 * 알아본 설정 오류면 그 정보를, 아니면 null을 돌려준다.
 * @returns {{code:string, message:string, fix:string}|null}
 */
function diagnose(err) {
  const t = textOf(err).toLowerCase();
  if (!t) return null;

  // 커스텀 토큰 서명 실패 — 신규 2세대 배포에서 가장 흔하다
  if (t.includes('iam.serviceaccounts.signblob') ||
      t.includes('signblob') ||
      t.includes('failed to determine service account') ||
      t.includes('iamcredentials.googleapis.com')) {
    return { code: 'E_SIGNBLOB', ...SETUP_ERRORS.E_SIGNBLOB };
  }

  // Authentication 미활성화
  if (t.includes('configuration-not-found') ||
      t.includes('configuration_not_found') ||
      t.includes('identitytoolkit') && t.includes('has not been used')) {
    return { code: 'E_NO_AUTH', ...SETUP_ERRORS.E_NO_AUTH };
  }

  // 결제 미연결
  if (t.includes('billing') && (t.includes('disabled') || t.includes('not been enabled') || t.includes('enable billing'))) {
    return { code: 'E_BILLING', ...SETUP_ERRORS.E_BILLING };
  }

  // Firestore 데이터베이스 없음 (gRPC NOT_FOUND=5)
  if (t.includes('does not exist') && t.includes('database')) {
    return { code: 'E_NO_FIRESTORE', ...SETUP_ERRORS.E_NO_FIRESTORE };
  }
  if (t.includes('firestore') && t.includes('has not been used')) {
    return { code: 'E_NO_FIRESTORE', ...SETUP_ERRORS.E_NO_FIRESTORE };
  }

  // Firestore 접근 권한 없음 (gRPC PERMISSION_DENIED=7)
  if (t.includes('permission_denied') || t.includes('missing or insufficient permissions')) {
    return { code: 'E_FIRESTORE_PERM', ...SETUP_ERRORS.E_FIRESTORE_PERM };
  }

  return null;
}

module.exports = { diagnose, SETUP_ERRORS };
