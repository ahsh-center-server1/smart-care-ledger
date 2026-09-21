#!/usr/bin/env node
/**
 * tools/backfill-authz.mjs — 전 직원의 `authz/{uid}` 문서를 만든다.
 *
 * 왜 따로 있는가
 *   시드(`tools/seed-staging.mjs`)는 `users`·`clients` 만 만든다. 그런데 권한
 *   판정의 근거는 그 투영본인 **`authz/{uid}`** 다(CLAUDE.md §4). 그래서 시드만
 *   한 환경에서는 로그인은 되는데 결재·쓰기가 전부 이렇게 거부된다.
 *
 *     권한 정보가 아직 준비되지 않았습니다. 관리자에게 권한 백필을 요청하세요.
 *
 *   배포 순서 §10-2 의 2번을 빠뜨린 것과 같은 고장이고, 실제로 에뮬레이터
 *   왕복·브라우저 검증이 여기서 먼저 막혔다. 두 검사가 같은 단계를 각자
 *   구현하지 않도록 한 곳에 둔다.
 *
 * 무엇을 하는가
 *   관리자 계정으로 로그인해 `backfillAuthz` 콜러블을 부른다 — 서버가 하는
 *   일을 그대로 쓴다. 여기서 authz 문서를 직접 만들면 투영 규칙이 두 벌이 되고,
 *   어긋나는 순간 「화면에는 보이는데 서버가 거부한다」가 생긴다.
 *
 * 쓰는 법 (에뮬레이터)
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node tools/backfill-authz.mjs
 *
 *   --user <id>       관리자 계정 (기본: center)
 *   --password <pw>   비밀번호 (기본: staging1234 / SEED_PASSWORD)
 */

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };

const PROJECT = process.env.GCLOUD_PROJECT
  || process.env.FIREBASE_PROJECT
  || 'smart-care-ledger-staging';
const REGION = process.env.SCL_REGION || 'asia-northeast3';
const FN_HOST = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const USER = val('--user', 'center');
const PASSWORD = val('--password', process.env.SEED_PASSWORD || 'staging1234');

const FNS = `http://${FN_HOST}/${PROJECT}/${REGION}`;
const AUTH = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1`;

async function callable(name, data, idToken) {
  const res = await fetch(`${FNS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) throw new Error(`${body.error.status || 'ERROR'}: ${body.error.message}`);
  return body.result;
}

try {
  const login = await callable('login', { userId: USER, password: PASSWORD });
  const ex = await fetch(`${AUTH}/accounts:signInWithCustomToken?key=emulator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: login.token, returnSecureToken: true }),
  });
  const { idToken } = await ex.json();
  if (!idToken) throw new Error('커스텀 토큰을 ID 토큰으로 바꾸지 못했습니다.');

  const out = await callable('backfillAuthz', {}, idToken);
  console.log(`✔ 권한 백필 — 직원 ${out.users}명 · 입주자 ${out.clients}명 · 배정 ${out.members}건`);
  process.exit(0);
} catch (err) {
  console.error(`✘ 권한 백필 실패: ${err.message}`);
  console.error('  시드를 먼저 적용했는지(npm run emu:seed -- --apply), Functions 에뮬레이터가');
  console.error('  떠 있는지 확인하세요. 폐쇄망에서의 기동 문제는 STAGING.md 를 보세요.');
  process.exit(1);
}
