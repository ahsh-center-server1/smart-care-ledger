import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

import { fnErrorMessage, isUnreachable, UNREACHABLE_MESSAGE } from '../public/services/fn-errors.js';

const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

/** Firebase SDK가 전송 실패(CORS 차단·미배포·네트워크)에 채워 넣는 모양 */
function transportFailure(code = 'functions/internal') {
  const e = new Error('internal');
  e.code = code;
  return e;
}

// ─────────────────────────────────────────────
// 서버에 닿지 못한 것과 서버가 낸 오류를 구분한다
// ─────────────────────────────────────────────

test('전송 실패를 서버 오류와 구분한다', () => {
  // 이 구분이 없으면 CORS 차단도 "로그인 실패. 다시 시도하세요."로 묻힌다
  assert.equal(isUnreachable(transportFailure()), true);
  assert.equal(isUnreachable(transportFailure('internal')), true);

  const e = new Error('');
  e.code = 'functions/internal';
  assert.equal(isUnreachable(e), true, '메시지가 빈 internal도 전송 실패다');
});

test('전송 실패에는 무엇이 잘못됐는지 알려 준다', () => {
  const msg = fnErrorMessage(transportFailure(), '로그인 실패. 다시 시도하세요.');
  assert.equal(msg, UNREACHABLE_MESSAGE);
  assert.match(msg, /E_UNREACHABLE/);
  assert.notEqual(msg, '로그인 실패. 다시 시도하세요.', 'fallback에 묻혔습니다');
});

test('서버가 만든 메시지는 그대로 보여준다', () => {
  // 설정 오류 진단(E_SIGNBLOB 등)이 이 경로로 화면까지 간다
  for (const [code, message] of [
    ['functions/failed-precondition', '서버 설정이 끝나지 않았습니다 (E_SIGNBLOB). ...'],
    ['functions/unauthenticated', '아이디 또는 비밀번호가 올바르지 않습니다.'],
    ['functions/permission-denied', '관리자 승인 대기 중입니다. 담당자에게 문의하세요.'],
    ['functions/resource-exhausted', '로그인 시도가 많아 잠겼습니다. 3분 후 다시 시도하세요.'],
    ['functions/already-exists', '이미 사용 중인 아이디입니다.'],
  ]) {
    const e = new Error(message); e.code = code;
    assert.equal(fnErrorMessage(e, 'fallback'), message, `${code}의 메시지가 버려졌습니다`);
  }
});

test('서버가 던진 진짜 internal은 fallback으로 간다', () => {
  // 서버는 internal에 한국어 문장을 담는다 — 전송 실패와 구별되는 지점
  const e = new Error('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  e.code = 'functions/internal';
  assert.equal(isUnreachable(e), false);
  assert.equal(fnErrorMessage(e, '로그인 실패. 다시 시도하세요.'), '로그인 실패. 다시 시도하세요.');
});

test('code 접두사가 있든 없든 같게 판정한다', () => {
  // SDK 버전에 따라 'internal' 또는 'functions/internal'로 온다
  const bare = new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
  bare.code = 'unauthenticated';
  assert.equal(fnErrorMessage(bare, 'fallback'), bare.message);

  assert.equal(isUnreachable(transportFailure('INTERNAL')), true, '대소문자에 걸립니다');
});

test('오류가 아예 없어도 죽지 않는다', () => {
  assert.equal(isUnreachable(null), false);
  assert.equal(isUnreachable(undefined), false);
  assert.equal(isUnreachable({}), false);
  assert.equal(fnErrorMessage(null, 'fallback'), 'fallback');
  assert.equal(fnErrorMessage(undefined, 'fallback'), 'fallback');
});

// ─────────────────────────────────────────────
// 서버와 클라이언트의 약속이 유지되는가
// ─────────────────────────────────────────────

test('서버는 internal에 절대 빈 메시지나 "internal"을 보내지 않는다', () => {
  // 이 약속이 깨지면 서버 오류가 "서버에 연결하지 못했습니다"로 잘못 안내된다
  const src = read('functions/index.js');
  const internals = [...src.matchAll(/new HttpsError\(\s*'internal'\s*,\s*(['"`])([\s\S]*?)\1/g)];
  assert.ok(internals.length > 0, "서버에 internal HttpsError가 없습니다 — 약속을 다시 확인하세요");
  for (const [, , message] of internals) {
    const m = message.trim().toLowerCase();
    assert.notEqual(m, '', 'internal에 빈 메시지를 보내고 있습니다');
    assert.notEqual(m, 'internal', "internal에 'internal'을 보내고 있습니다");
  }
});

test('auth.js가 자체 fnErrorMessage를 다시 만들지 않는다', () => {
  // 예전에는 auth.js 안에 있었고, internal 메시지를 조건 없이 버렸다
  const src = read('public/modules/auth.js');
  assert.ok(!/function\s+fnErrorMessage/.test(src),
    'auth.js에 fnErrorMessage가 다시 정의되어 있습니다 — 구분 로직이 두 벌이 됩니다');
  assert.match(src, /import\s*\{[^}]*fnErrorMessage[^}]*\}\s*from\s*['"]\.\.\/services\/fn-errors\.js['"]/,
    'auth.js가 fn-errors.js를 import하지 않습니다');
});

test('콜러블 함수 이름이 클라이언트와 서버에서 일치한다', () => {
  // 이름이 어긋나면 404 → 브라우저에는 CORS 오류로 보인다 (원인 찾기 최악)
  const server = new Set(
    [...read('functions/index.js').matchAll(/^exports\.(\w+)\s*=\s*callable\(/gm)].map((m) => m[1])
  );
  // 세 파일만 훑으면 다른 곳의 호출을 놓친다 — public 전체를 본다
  const client = new Set();
  for (const dir of ['public/modules', 'public/services', 'public/utils']) {
    for (const f of readdirSync(new URL('../' + dir + '/', import.meta.url))) {
      if (!f.endsWith('.js')) continue;
      for (const m of read(`${dir}/${f}`).matchAll(/\bcall\(\s*'(\w+)'\s*\)/g)) client.add(m[1]);
    }
  }
  for (const m of read('public/app.js').matchAll(/\bcall\(\s*'(\w+)'\s*\)/g)) client.add(m[1]);
  assert.ok(client.size >= 4, `클라이언트 콜러블 호출이 너무 적습니다 (${client.size}) — 스캔이 잘못됐을 수 있습니다`);
  const missing = [...client].filter((n) => !server.has(n));
  assert.deepEqual(missing, [],
    `클라이언트가 부르는데 서버에 없는 함수: ${missing.join(', ')} — 404가 CORS 오류로 보입니다`);
});
