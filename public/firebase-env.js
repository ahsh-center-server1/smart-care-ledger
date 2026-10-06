/**
 * firebase-env.js — 어느 Firebase 프로젝트에 접속할지 결정한다.
 *
 * 이 앱은 빌드 단계가 없다(ES 모듈을 그대로 서빙한다). 그래서 접속 대상은
 * 빌드 시점 환경변수가 아니라 **실행 시점 호스트명**으로 정한다.
 *
 *   프로덕션 호스트 → prod      (실데이터. 운영 URL에서만)
 *   그 외 모든 호스트 → staging (Vercel 프리뷰, 로컬, 스테이징 Hosting)
 *   ?env=emulator            → 로컬 에뮬레이터 (Blaze 없이 전 기능 테스트)
 *
 * **기본값이 스테이징인 것이 핵심이다.** 새 호스트가 생겼을 때 실수로
 * 프로덕션에 붙는 일이 없다. 프로덕션은 명시된 호스트명에서만 열린다.
 *
 * 브라우저 밖(Node)에서도 부를 수 있게 순수 함수로 두었다 — 테스트가 있다.
 */

'use strict';

/** 프로덕션 설정이 허용되는 호스트명. 이 목록에 없으면 절대 실데이터에 붙지 않는다. */
export const PROD_HOSTNAMES = [
  'smart-care-ledger-a3355.web.app',
  'smart-care-ledger-a3355.firebaseapp.com',
];

export const FIREBASE_ENVS = {
  prod: {
    label: '프로덕션',
    config: {
      apiKey:            'AIzaSyC_CONNa29ckAMD25WH730U4NTTCrZj5kY',
      authDomain:        'smart-care-ledger-a3355.firebaseapp.com',
      projectId:         'smart-care-ledger-a3355',
      storageBucket:     'smart-care-ledger-a3355.firebasestorage.app',
      messagingSenderId: '539523033501',
      appId:             '1:539523033501:web:086336c17f86633c552774',
    },
  },
  staging: {
    label: '스테이징',
    config: {
      apiKey:            '',
      authDomain:        '',
      projectId:         '',
      storageBucket:     '',
      messagingSenderId: '',
      appId:             '',
    },
  },
  /**
   * 로컬 에뮬레이터. projectId만 맞으면 되고 apiKey 등은 검사되지 않지만,
   * SDK가 형식을 요구하므로 스테이징 값을 그대로 쓴다.
   */
  emulator: {
    label: '에뮬레이터',
    config: {
      apiKey:            '',
      authDomain:        '',
      projectId:         '',
      storageBucket:     '',
      messagingSenderId: '',
      appId:             '',
    },
    // 포트는 firebase.json의 emulators 블록과 같아야 한다.
    // (test/firebase-env.test.mjs가 두 파일이 갈리면 실패시킨다)
    emulators: {
      auth:      { port: 9099 },
      firestore: { port: 8080 },
      functions: { port: 5001 },
      storage:   { port: 9199 },
    },
  },
};

export const ENV_NAMES = Object.keys(FIREBASE_ENVS);

/** sessionStorage 키 — ?env=로 고른 환경을 새로고침 뒤에도 유지한다 */
export const ENV_STORAGE_KEY = 'scl_env';

/**
 * 접속할 환경을 고른다.
 *
 * @param {object}  loc            location 유사 객체 ({ hostname, search })
 * @param {Storage} [store]        sessionStorage (없으면 무시)
 * @returns {{name, label, config, emulators, explicit}}
 */
export function pickFirebaseEnv(loc = {}, store = null) {
  const hostname = String(loc.hostname || '');
  const search = String(loc.search || '');

  // 1) ?env=... 가 가장 우선한다. 고른 값은 세션에 남긴다.
  const requested = readEnvParam(search);
  if (requested && FIREBASE_ENVS[requested]) {
    safeStore(store, requested);
    return describe(requested, true);
  }

  // 2) 같은 탭에서 앞서 고른 환경 — 새로고침으로 프로덕션에 튕기지 않도록.
  //    프로덕션 호스트에서는 무시한다(운영 URL은 언제나 실데이터여야 한다).
  if (!PROD_HOSTNAMES.includes(hostname)) {
    const saved = safeRead(store);
    if (saved && FIREBASE_ENVS[saved]) return describe(saved, true);
  }

  // 3) 호스트명. 프로덕션 목록에 있을 때만 실데이터.
  return describe(PROD_HOSTNAMES.includes(hostname) ? 'prod' : 'staging', false);
}

/** `?env=staging` / `?env=emulator` 를 읽는다 (다른 파라미터가 섞여 있어도 된다) */
function readEnvParam(search) {
  const m = /[?&]env=([a-zA-Z]+)/.exec(search);
  return m ? m[1].toLowerCase() : '';
}

function describe(name, explicit) {
  const env = FIREBASE_ENVS[name];
  return {
    name,
    label: env.label,
    config: env.config,
    emulators: env.emulators || null,
    explicit,
    isProd: name === 'prod',
  };
}

function safeStore(store, value) {
  try { if (store) store.setItem(ENV_STORAGE_KEY, value); } catch (_) { /* 사생활 보호 모드 */ }
}

function safeRead(store) {
  try { return store ? store.getItem(ENV_STORAGE_KEY) : ''; } catch (_) { return ''; }
}
