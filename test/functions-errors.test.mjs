import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { diagnose } = require('../functions/errors.js');
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

// ─────────────────────────────────────────────
// 실제로 올라오는 예외 모양들
//
// 이 문자열들은 SDK 소스와 GCP 응답에서 그대로 온다.
// firebase-admin의 crypto-signer.js가 만드는 메시지가 대표적이다.
// ─────────────────────────────────────────────

test('커스텀 토큰 서명 실패를 알아본다 — 2세대 배포에서 가장 흔한 원인', () => {
  // firebase-admin lib/utils/crypto-signer.js — IAMSigner.getAccountId()
  const err1 = new Error(
    'Failed to determine service account. Make sure to initialize the SDK with a ' +
    'service account credential. Alternatively specify a service account with ' +
    'iam.serviceAccounts.signBlob permission. Original error: FirebaseAppError: ...'
  );
  // IAMSigner.sign() → iamcredentials signBlob 403
  const err2 = new Error(
    'Permission \'iam.serviceAccounts.signBlob\' denied on resource ' +
    '(or it may not exist).'
  );

  for (const e of [err1, err2]) {
    const d = diagnose(e);
    assert.ok(d, '서명 실패를 알아보지 못했습니다');
    assert.equal(d.code, 'E_SIGNBLOB');
    assert.match(d.message, /Service Account Token Creator|토큰 생성자/);
    assert.ok(d.fix, '고치는 방법이 비어 있습니다');
  }
});

test('Authentication 미활성화를 알아본다', () => {
  const err = new Error('There is no configuration corresponding to the provided identifier.');
  err.errorInfo = { code: 'auth/configuration-not-found', message: 'CONFIGURATION_NOT_FOUND' };
  const d = diagnose(err);
  assert.equal(d?.code, 'E_NO_AUTH');
});

test('Firestore 데이터베이스 없음을 알아본다', () => {
  const err = new Error('5 NOT_FOUND: The database (default) does not exist for project x');
  err.code = 5;
  assert.equal(diagnose(err)?.code, 'E_NO_FIRESTORE');
});

test('Firestore 권한 없음을 알아본다', () => {
  const err = new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
  err.code = 7;
  assert.equal(diagnose(err)?.code, 'E_FIRESTORE_PERM');
});

test('결제 미연결을 알아본다', () => {
  const err = new Error('Billing has not been enabled for this project.');
  assert.equal(diagnose(err)?.code, 'E_BILLING');
});

test('중첩된 cause 안의 원인도 찾는다', () => {
  // gRPC/HTTP 오류는 진짜 이유를 cause·details에 숨겨 온다
  const inner = new Error('Permission \'iam.serviceAccounts.signBlob\' denied on resource');
  const outer = new Error('Error while making request');
  outer.cause = inner;
  assert.equal(diagnose(outer)?.code, 'E_SIGNBLOB');

  const withDetails = new Error('2 UNKNOWN');
  withDetails.details = 'The database (default) does not exist';
  assert.equal(diagnose(withDetails)?.code, 'E_NO_FIRESTORE');
});

test('평범한 오류는 설정 오류로 오해하지 않는다', () => {
  // 오탐이 나면 진짜 버그가 "설정하세요"로 가려진다
  for (const m of [
    'Cannot read properties of undefined (reading \'x\')',
    'Request failed with status code 500',
    'ETIMEDOUT',
    '아이디 또는 비밀번호가 올바르지 않습니다.',
    'deadline-exceeded',
  ]) {
    assert.equal(diagnose(new Error(m)), null, `"${m}"를 설정 오류로 잘못 판정했습니다`);
  }
  assert.equal(diagnose(null), null);
  assert.equal(diagnose(undefined), null);
  assert.equal(diagnose(new Error('')), null);
});

test('진단 메시지에 프로젝트 값이나 자격증명이 섞이지 않는다', () => {
  // 화면에 그대로 띄우므로 계정 이메일·경로가 들어가면 안 된다
  const { SETUP_ERRORS } = require('../functions/errors.js');
  for (const [code, info] of Object.entries(SETUP_ERRORS)) {
    assert.ok(info.message.length > 20, `${code} 메시지가 너무 짧습니다`);
    assert.match(info.message, new RegExp(code), `${code} 메시지에 코드가 없습니다`);
    assert.ok(!/@|serviceAccountKey|AIza|private_key/.test(info.message),
      `${code} 메시지에 노출하면 안 되는 값이 있습니다`);
  }
});

// ─────────────────────────────────────────────
// 배선 — 이게 빠지면 진단이 화면까지 못 간다
// ─────────────────────────────────────────────

test('모든 콜러블이 callable() 래퍼를 통과한다', () => {
  // 하나라도 맨 onCall이면 그 함수만 조용히 INTERNAL로 돌아간다
  const src = read('functions/index.js');
  const bare = [...src.matchAll(/^exports\.(\w+)\s*=\s*onCall\(/gm)].map((m) => m[1]);
  assert.deepEqual(bare, [],
    `callable() 래퍼를 안 거치는 콜러블: ${bare.join(', ')} — 설정 오류가 INTERNAL로 묻힙니다`);

  const wrapped = [...src.matchAll(/^exports\.(\w+)\s*=\s*callable\('(\w+)'/gm)];
  assert.ok(wrapped.length >= 6, `콜러블이 너무 적습니다 (${wrapped.length})`);
  for (const [, exp, label] of wrapped) {
    assert.equal(exp, label, `callable('${label}')이 exports.${exp}에 붙어 있습니다 — 로그 이름이 어긋납니다`);
  }
});

test('의도한 거부(HttpsError)는 래퍼가 건드리지 않는다', () => {
  // 이 분기가 빠지면 "비밀번호가 틀렸습니다"까지 INTERNAL로 뭉개진다
  const src = read('functions/index.js');
  assert.match(src, /if \(err instanceof HttpsError\) throw err;/,
    'callable() 래퍼가 HttpsError를 그대로 통과시키지 않습니다');
});

test('진단된 설정 오류는 failed-precondition으로 나간다', () => {
  // internal로 두면 클라이언트 fnErrorMessage가 메시지를 버려 화면에 안 나온다
  const src = read('functions/index.js');
  assert.match(src, /if \(setup\) throw new HttpsError\('failed-precondition'/,
    '진단 결과가 failed-precondition으로 나가지 않습니다');

  // 클라이언트는 internal 메시지를 버린다(fn-errors.js). 그래서 진단은
  // 반드시 다른 코드로 나가야 화면까지 간다.
  const client = read('public/services/fn-errors.js');
  assert.match(client, /bareCode\(e\.code\) !== 'internal'/,
    'fn-errors.js가 internal 메시지를 버리는 조건이 바뀌었습니다 — 서버 코드와 함께 확인하세요');
});
