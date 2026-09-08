import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { diagnose } = require('../functions/errors.js');
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * functions/ 의 우리 소스 전부 (node_modules 제외).
 *
 * 예전에는 index.js 하나만 봤다. 그런데 콜러블이 *-fns.js 로 옮겨 가면서
 * directory-fns · ai-fns · authz-fns · staff-fns 는 검사 밖에 있었다 —
 * 그 파일들이 맨 onCall 을 써도 아무도 몰랐다.
 */
function functionSources(dir = join(ROOT, 'functions'), out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) functionSources(p, out);
    else if (/\.(js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

test('맨 onCall을 쓰는 콜러블이 없다', () => {
  // 하나라도 맨 onCall이면 그 함수만 조용히 INTERNAL로 돌아간다.
  // callable() 헬퍼 정의 자체(index.js의 `return onCall(...)`)는 예외다.
  const bare = [];
  for (const file of functionSources()) {
    const rel = relative(ROOT, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!/(?:^|[=\s])onCall\s*\(/.test(line)) return;
      if (/return\s+onCall\(/.test(line)) return;          // 헬퍼 정의
      if (/require\(|^\s*(?:\/\/|\*)/.test(line)) return;   // import·주석
      bare.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(bare, [],
    `callable() 래퍼를 안 거치는 콜러블:\n  ${bare.join('\n  ')}\n`
    + '설정 오류가 INTERNAL로 묻힙니다.');
});

test('콜러블 이름이 변수·export 이름과 같다', () => {
  // 어긋나면 로그에서 어느 함수가 실패했는지 찾을 수 없다.
  // 두 가지 형태를 본다:
  //   index.js      exports.foo = callable('foo', …)
  //   *-fns.js      const foo = callable('foo', …)   ← 팩토리에서 반환
  const found = [];
  const mismatched = [];
  for (const file of functionSources()) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    const patterns = [
      /^exports\.(\w+)\s*=\s*callable\('(\w+)'/gm,        // index.js
      /^\s*const\s+(\w+)\s*=\s*callable\('(\w+)'/gm,      // *-fns.js 지역 변수
      /^\s*(\w+)\s*:\s*callable\('(\w+)'/gm,               // 반환 객체 리터럴 안에서 직접
    ];
    for (const re of patterns) {
      for (const [, name, label] of src.matchAll(re)) {
        found.push(label);
        if (name !== label) mismatched.push(`${rel}: ${name} ← callable('${label}')`);
      }
    }
  }
  assert.deepEqual(mismatched, [],
    `콜러블 이름이 어긋납니다:\n  ${mismatched.join('\n  ')}`);
  assert.ok(found.length >= 10, `콜러블이 너무 적습니다 (${found.length}) — 검사가 파일을 놓쳤을 수 있습니다`);
  assert.equal(new Set(found).size, found.length,
    `콜러블 이름이 중복됩니다: ${found.filter((x, i) => found.indexOf(x) !== i).join(', ')}`);
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

// ─────────────────────────────────────────────
// 배포 표면 — 이 실수는 배포 시점에만 드러난다
// ─────────────────────────────────────────────

test('내부 헬퍼가 exports에 섞이지 않는다', () => {
  // Firebase 는 **모든 export 를 배포 대상 함수로 해석한다.** 그래서
  // `Object.assign(exports, someModule)` 로 팩토리 반환값을 통째로 내보내면
  // 내부 헬퍼까지 함수로 배포된다 — 정체불명의 엔드포인트가 생기고,
  // 그 사실은 `firebase deploy` 를 돌려야 알 수 있다.
  //
  // 실제로 syncAuthzForUser 가 이렇게 새어 나갔다.
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'test-project';
  const mod = require('../functions/index.js');

  const suspicious = Object.keys(mod).filter((name) => {
    if (name.startsWith('__')) return true;               // 내부용 표기
    const fn = mod[name];
    if (!fn || typeof fn !== 'function') return true;      // 함수가 아닌 값
    // 배포 가능한 것은 __endpoint 메타데이터를 갖는다(onCall·onDocumentWritten 등).
    return !fn.__endpoint && !fn.__trigger;
  });

  assert.deepEqual(
    suspicious, [],
    'exports 에 배포 대상이 아닌 값이 있습니다:\n  ' + suspicious.join('\n  ')
    + '\n팩토리 반환값을 통째로 Object.assign 하지 말고 콜러블만 골라 내보내세요.',
  );
});

test('배포될 함수 이름이 중복되지 않는다', () => {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'test-project';
  const names = Object.keys(require('../functions/index.js'));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 15, `배포 함수가 너무 적습니다 (${names.length})`);
});
