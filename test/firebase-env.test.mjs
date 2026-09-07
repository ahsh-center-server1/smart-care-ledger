import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  pickFirebaseEnv, FIREBASE_ENVS, PROD_HOSTNAMES, ENV_STORAGE_KEY,
} from '../public/firebase-env.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

/** sessionStorage 흉내 */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

// ─────────────────────────────────────────────
// 기본 판정 — 기본값이 스테이징인 것이 안전장치의 핵심
// ─────────────────────────────────────────────

test('운영 호스트에서만 프로덕션에 붙는다', () => {
  for (const h of PROD_HOSTNAMES) {
    const env = pickFirebaseEnv({ hostname: h });
    assert.equal(env.name, 'prod', `${h}가 프로덕션으로 판정되지 않았습니다`);
    assert.equal(env.config.projectId, 'smart-care-ledger');
  }
});

test('그 외 모든 호스트는 스테이징이다', () => {
  const others = [
    'smart-care-ledger-git-feature-x.vercel.app',   // Vercel 프리뷰
    'smart-care-ledger.vercel.app',
    'localhost',
    '127.0.0.1',
    'smart-care-ledger-staging.web.app',
    '',                                              // file:// 등
    'smart-care-ledger.web.app.evil.example',        // 접두사만 같은 호스트
  ];
  for (const h of others) {
    const env = pickFirebaseEnv({ hostname: h });
    assert.equal(env.name, 'staging', `${h}가 스테이징으로 판정되지 않았습니다`);
    assert.equal(env.config.projectId, 'smart-care-ledger-staging');
  }
});

test('프로덕션 판정은 부분 일치가 아니라 완전 일치다', () => {
  // 'smart-care-ledger.web.app'을 포함하기만 하는 호스트가 실데이터에 붙으면 안 된다
  for (const h of ['evil-smart-care-ledger.web.app', 'smart-care-ledger.web.app.attacker.io']) {
    assert.equal(pickFirebaseEnv({ hostname: h }).name, 'staging');
  }
});

// ─────────────────────────────────────────────
// ?env= 오버라이드
// ─────────────────────────────────────────────

test('?env= 로 환경을 고를 수 있다', () => {
  assert.equal(pickFirebaseEnv({ hostname: 'localhost', search: '?env=emulator' }).name, 'emulator');
  assert.equal(pickFirebaseEnv({ hostname: 'localhost', search: '?env=prod' }).name, 'prod');
  assert.equal(pickFirebaseEnv({ hostname: 'localhost', search: '?a=1&env=staging&b=2' }).name, 'staging');
  assert.equal(pickFirebaseEnv({ hostname: 'localhost', search: '?env=EMULATOR' }).name, 'emulator');
});

test('모르는 ?env= 값은 무시하고 호스트명 판정으로 돌아간다', () => {
  assert.equal(pickFirebaseEnv({ hostname: 'localhost', search: '?env=nope' }).name, 'staging');
  assert.equal(pickFirebaseEnv({ hostname: PROD_HOSTNAMES[0], search: '?env=nope' }).name, 'prod');
});

test('고른 환경은 세션에 남아 새로고침해도 유지된다', () => {
  const store = fakeStore();
  pickFirebaseEnv({ hostname: 'localhost', search: '?env=emulator' }, store);
  assert.equal(store.getItem(ENV_STORAGE_KEY), 'emulator');
  // 쿼리 없이 새로고침
  assert.equal(pickFirebaseEnv({ hostname: 'localhost', search: '' }, store).name, 'emulator');
});

test('운영 URL은 세션 값에 관계없이 언제나 프로덕션이다', () => {
  // 스테이징을 보다가 운영 URL을 열었을 때 스테이징 데이터가 뜨면 안 된다
  const store = fakeStore({ [ENV_STORAGE_KEY]: 'staging' });
  assert.equal(pickFirebaseEnv({ hostname: PROD_HOSTNAMES[0], search: '' }, store).name, 'prod');
});

test('sessionStorage를 못 쓰는 환경에서도 죽지 않는다', () => {
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  assert.equal(pickFirebaseEnv({ hostname: 'localhost' }, throwing).name, 'staging');
  assert.equal(pickFirebaseEnv({ hostname: 'localhost', search: '?env=prod' }, throwing).name, 'prod');
  assert.equal(pickFirebaseEnv({}, null).name, 'staging');
});

// ─────────────────────────────────────────────
// 설정값 자체
// ─────────────────────────────────────────────

test('프로덕션과 스테이징이 서로 다른 프로젝트를 가리킨다', () => {
  // 복사·붙여넣기로 스테이징 설정이 프로덕션 값이 되면 프리뷰가 실데이터를 건드린다
  const p = FIREBASE_ENVS.prod.config, s = FIREBASE_ENVS.staging.config;
  for (const k of ['projectId', 'apiKey', 'appId', 'authDomain', 'storageBucket', 'messagingSenderId']) {
    assert.notEqual(s[k], p[k], `스테이징의 ${k}가 프로덕션과 같습니다`);
  }
});

test('모든 환경 설정에 필수 키가 있다', () => {
  const required = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
  for (const [name, env] of Object.entries(FIREBASE_ENVS)) {
    for (const k of required) {
      assert.ok(env.config[k], `${name} 설정에 ${k}가 없습니다`);
    }
    assert.ok(env.label, `${name}에 표시 이름이 없습니다`);
  }
});

test('에뮬레이터 환경만 emulators를 갖는다', () => {
  assert.ok(FIREBASE_ENVS.emulator.emulators, '에뮬레이터 포트 설정이 없습니다');
  assert.equal(pickFirebaseEnv({ hostname: 'localhost' }).emulators, null);
  assert.equal(pickFirebaseEnv({ hostname: PROD_HOSTNAMES[0] }).emulators, null);
});

// ─────────────────────────────────────────────
// 다른 파일과 어긋나지 않는지
// ─────────────────────────────────────────────

test('에뮬레이터 포트가 firebase.json과 같다', () => {
  // 갈리면 앱이 안 뜨는 포트에 붙어 "에뮬레이터가 안 된다"로만 보인다
  const fj = JSON.parse(read('firebase.json'));
  assert.ok(fj.emulators, 'firebase.json에 emulators 블록이 없습니다');
  for (const [name, cfg] of Object.entries(FIREBASE_ENVS.emulator.emulators)) {
    assert.equal(fj.emulators[name]?.port, cfg.port,
      `${name} 에뮬레이터 포트가 firebase.json(${fj.emulators[name]?.port})과 firebase-env.js(${cfg.port})에서 다릅니다`);
  }
});

test('.firebaserc의 별칭이 각 환경의 projectId와 맞는다', () => {
  const rc = JSON.parse(read('.firebaserc'));
  assert.equal(rc.projects.staging, FIREBASE_ENVS.staging.config.projectId);
  assert.equal(rc.projects.prod, FIREBASE_ENVS.prod.config.projectId);
});

test('배포 기본 별칭이 프로덕션이 아니다', () => {
  // `firebase deploy`를 --project 없이 치면 default로 간다.
  // 그게 프로덕션이면 스테이징에 올리려던 배포가 실데이터를 덮어쓴다.
  // 접속 환경 판정과 같은 원칙 — 틀리더라도 안전한 쪽으로 틀린다.
  const rc = JSON.parse(read('.firebaserc'));
  assert.notEqual(rc.projects.default, FIREBASE_ENVS.prod.config.projectId,
    '.firebaserc의 default가 프로덕션입니다 — --project를 빠뜨리면 실데이터로 배포됩니다');
  assert.equal(rc.projects.default, FIREBASE_ENVS.staging.config.projectId);
});

test('프로덕션 배포 명령에는 --project prod가 붙어 있다', () => {
  // 절차서의 명령을 그대로 복사해 쓰므로, 하나라도 빠지면 스테이징에 올라가
  // "배포했는데 아무것도 안 바뀐다"가 된다 (반대 방향 사고).
  const runbook = read('RUNBOOK.md');
  const bare = [];
  for (const m of runbook.matchAll(/^firebase (deploy|functions:log)([^\n]*)$/gm)) {
    if (!m[2].includes('--project')) bare.push(m[0]);
  }
  assert.deepEqual(bare, [],
    `RUNBOOK에 대상을 명시하지 않은 명령이 있습니다:\n${bare.join('\n')}`);
});

test('배포 스크립트가 두 환경 모두 명시적이다', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['deploy:prod', 'deploy:staging']) {
    assert.ok(pkg.scripts[name], `${name} 스크립트가 없습니다`);
    assert.match(pkg.scripts[name], /--project (prod|staging)\b/,
      `${name}에 --project가 없습니다`);
  }
  assert.match(pkg.scripts['deploy:prod'], /--project prod\b/);
  assert.match(pkg.scripts['deploy:staging'], /--project staging\b/);
});

test('index.html이 설정을 직접 쓰지 않고 firebase-env.js를 통한다', () => {
  // 예전에는 firebaseConfig가 index.html에 박혀 있었다. 다시 그렇게 되면
  // 프리뷰 URL이 실데이터에 붙는 사고가 조용히 돌아온다.
  const html = read('public/index.html');
  assert.ok(/import\s*\{[^}]*pickFirebaseEnv[^}]*\}\s*from\s*['"]\.\/firebase-env\.js['"]/.test(html),
    'index.html이 pickFirebaseEnv를 import하지 않습니다');
  assert.ok(/initializeApp\(\s*env\.config\s*\)/.test(html),
    'index.html이 env.config로 초기화하지 않습니다');
  assert.ok(!/projectId\s*:\s*["']smart-care-ledger["']/.test(html),
    'index.html에 프로덕션 projectId가 다시 하드코딩되어 있습니다');
});

test('시드 스크립트가 프로덕션 프로젝트를 거부한다', () => {
  const src = read('tools/seed-staging.mjs');
  assert.ok(/FORBIDDEN_PROJECTS\s*=\s*\[\s*'smart-care-ledger'/.test(src),
    '시드 스크립트의 프로덕션 차단 목록이 사라졌습니다');
  assert.ok(/FORBIDDEN_PROJECTS\.includes\(PROJECT_ID\)/.test(src),
    '시드 스크립트가 차단 목록을 확인하지 않습니다');
});
