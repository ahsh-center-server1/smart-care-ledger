// test/receipt-jobs.test.mjs
//
// 영수증 최종화 상태 기계.
//
// 이 파일이 지키는 것 중 중요한 둘
//   1. finalizing 중 서버가 죽어도 lease 만료 후 재개된다.
//      `state === 'analyzed'` 만 선점 조건으로 두면 그 job 은 영구 정지다.
//   2. 거래에 붙은 최종 영수증은 job TTL 로 삭제되지 않는다.
//      job 의 수명과 증빙의 수명은 다르다. TTL 은 임시 작업만 정리한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  STATES, ALL_STATES, ATTACHED_STATES, LEASE_MS, STAGING_TTL_MS, CLEANUP_ORDER,
  canClaim, claimPatch, holdsLease, heartbeatPatch,
  finalPath, stagingPath, jobPath, canDeleteFinal, isAbandoned, newJob,
} = require('../functions/receipt-jobs.cjs');

const NOW = 1_700_000_000_000;

// ─────────────────────────────────────────────
// 선점
// ─────────────────────────────────────────────

test('analyzed 상태는 선점할 수 있다', () => {
  assert.equal(canClaim({ state: STATES.ANALYZED }, NOW), true);
});

test('수명이 끝난 analyzed 상태는 최종화하지 않는다', () => {
  assert.equal(canClaim({ state: STATES.ANALYZED, expireAt: new Date(NOW) }, NOW), false);
});

test('lease가 살아 있는 finalizing은 선점할 수 없다', () => {
  assert.equal(canClaim({ state: STATES.FINALIZING, leaseUntil: NOW + 1000 }, NOW), false);
});

test('lease가 만료된 finalizing은 다시 선점할 수 있다', () => {
  // ★ 이것이 없으면 finalizing 중 서버가 죽는 순간 job 이 영구 정지된다.
  assert.equal(canClaim({ state: STATES.FINALIZING, leaseUntil: NOW - 1 }, NOW), true);
  assert.equal(canClaim({ state: STATES.FINALIZING, leaseUntil: NOW }, NOW), true);
});

test('leaseUntil이 없는 finalizing도 재개 가능하다', () => {
  // 선점 직후 죽어 leaseUntil을 못 쓴 경우. 여기서도 갇히면 안 된다.
  assert.equal(canClaim({ state: STATES.FINALIZING }, NOW), true);
});

test('leaseUntil이 숫자가 아니면 재개 가능하다', () => {
  assert.equal(canClaim({ state: STATES.FINALIZING, leaseUntil: 'x' }, NOW), true);
});

test('첨부 이후 상태는 선점할 수 없다', () => {
  for (const state of ATTACHED_STATES) {
    assert.equal(canClaim({ state }, NOW), false, state);
  }
});

test('uploaded는 아직 선점 대상이 아니다', () => {
  // 판독 전이므로 최종화할 것이 없다.
  assert.equal(canClaim({ state: STATES.UPLOADED }, NOW), false);
});

test('job이 없으면 선점할 수 없다', () => {
  assert.equal(canClaim(null, NOW), false);
  assert.equal(canClaim(undefined, NOW), false);
});

test('선점 패치가 상태와 만료 시각을 담는다', () => {
  const p = claimPatch({ token: 'tok1', now: NOW });
  assert.equal(p.state, STATES.FINALIZING);
  assert.equal(p.leaseToken, 'tok1');
  assert.equal(p.leaseUntil.getTime(), NOW + LEASE_MS);
});

test('선점 패치는 토큰 없이 만들 수 없다', () => {
  assert.throws(() => claimPatch({ now: NOW }), /leaseToken/);
});

test('선점 시 대상 거래를 함께 기록할 수 있다', () => {
  assert.equal(claimPatch({ token: 't', now: NOW, trxId: 'trx9' }).trxId, 'trx9');
  assert.equal('trxId' in claimPatch({ token: 't', now: NOW }), false);
});

// ─────────────────────────────────────────────
// lease 소유권
// ─────────────────────────────────────────────

test('자기 토큰이면 lease를 들고 있다', () => {
  const job = { state: STATES.FINALIZING, leaseToken: 'mine', leaseUntil: NOW + 1000 };
  assert.equal(holdsLease(job, 'mine', NOW), true);
});

test('토큰이 바뀌었으면 lease를 잃었다', () => {
  // 늦게 돌아온 이전 작업자가 새 작업 결과를 덮지 못하게 한다.
  const job = { state: STATES.FINALIZING, leaseToken: 'theirs', leaseUntil: NOW + 1000 };
  assert.equal(holdsLease(job, 'mine', NOW), false);
});

test('lease가 만료됐으면 들고 있지 않다', () => {
  const job = { state: STATES.FINALIZING, leaseToken: 'mine', leaseUntil: NOW - 1 };
  assert.equal(holdsLease(job, 'mine', NOW), false);
});

test('상태가 finalizing이 아니면 lease가 없다', () => {
  for (const state of [STATES.ANALYZED, ...ATTACHED_STATES]) {
    const job = { state, leaseToken: 'mine', leaseUntil: NOW + 1000 };
    assert.equal(holdsLease(job, 'mine', NOW), false, state);
  }
});

test('토큰이 비면 lease가 없다', () => {
  const job = { state: STATES.FINALIZING, leaseToken: '', leaseUntil: NOW + 1000 };
  assert.equal(holdsLease(job, '', NOW), false);
});

test('lease를 들고 있으면 연장할 수 있다', () => {
  const job = { state: STATES.FINALIZING, leaseToken: 'mine', leaseUntil: NOW + 10 };
  assert.equal(heartbeatPatch({ job, token: 'mine', now: NOW }).leaseUntil.getTime(), NOW + LEASE_MS);
});

test('lease를 잃었으면 연장할 수 없다', () => {
  const job = { state: STATES.FINALIZING, leaseToken: 'theirs', leaseUntil: NOW + 10 };
  assert.throws(() => heartbeatPatch({ job, token: 'mine', now: NOW }), /lease-lost/);
});

// ─────────────────────────────────────────────
// 경로
// ─────────────────────────────────────────────

test('최종 경로는 uploadId에서 결정적으로 나온다', () => {
  // 같은 원본을 같은 목적지로 복사하면 내용이 동일하다. 그래서 작업자별
  // 경로가 필요 없고 create-only 복사로 충돌을 처리할 수 있다.
  assert.equal(finalPath('c1', 'up1'), 'receipts/c1/up1');
  assert.equal(finalPath('c1', 'up1'), finalPath('c1', 'up1'));
});

test('스테이징 경로에 uid가 들어간다', () => {
  // 규칙이 경로로 소유권을 검증한다 — 문서 필드로 하면 남의 job을 가리킬 수 있다.
  assert.equal(stagingPath('u1', 'up1'), 'receiptStaging/u1/up1/source');
  assert.equal(jobPath('u1', 'up1'), 'receiptJobs/u1/items/up1');
});

test('경로 인자가 비면 만들지 않는다', () => {
  assert.throws(() => finalPath('', 'up1'), /clientId/);
  assert.throws(() => finalPath('c1', ''), /uploadId/);
  assert.throws(() => stagingPath('', 'up1'), /uid/);
  assert.throws(() => jobPath('u1', ''), /uid|uploadId/);
});

// ─────────────────────────────────────────────
// 최종 파일 삭제 — 가장 조심할 곳
// ─────────────────────────────────────────────

test('첨부된 영수증은 어떤 경우에도 삭제 대상이 아니다', () => {
  // ★ job TTL 은 임시 작업을 정리할 뿐, 거래 증빙의 보존 기간을 정하지 않는다.
  for (const state of ATTACHED_STATES) {
    assert.equal(canDeleteFinal({ state, finalGeneration: '7' }, '7'), false, state);
  }
});

test('generation이 일치하면 폐기된 job의 최종 파일을 지운다', () => {
  assert.equal(canDeleteFinal({ state: STATES.FINALIZING, finalGeneration: '7' }, '7'), true);
});

test('generation이 다르면 지우지 않는다', () => {
  // 연도 마감 재압축이 같은 경로를 덮어써 generation 을 바꾼다. 경로만 보고
  // 지우면 새 객체를 지운다.
  assert.equal(canDeleteFinal({ state: STATES.FINALIZING, finalGeneration: '7' }, '8'), false);
});

test('generation을 모르면 지우지 않는다', () => {
  // 확인되지 않은 객체는 자동 삭제하지 않고 감사 대상으로 남긴다.
  assert.equal(canDeleteFinal({ state: STATES.FINALIZING }, '7'), false);
  assert.equal(canDeleteFinal({ state: STATES.FINALIZING, finalGeneration: '7' }, null), false);
  assert.equal(canDeleteFinal({ state: STATES.FINALIZING, finalGeneration: '7' }, undefined), false);
});

test('generation은 문자열과 숫자를 같게 본다', () => {
  // Storage API 가 문자열로 주고 우리가 숫자로 저장하는 경우가 섞인다.
  assert.equal(canDeleteFinal({ state: STATES.FINALIZING, finalGeneration: 7 }, '7'), true);
});

// ─────────────────────────────────────────────
// 폐기와 정리
// ─────────────────────────────────────────────

test('수명을 넘긴 미첨부 job은 폐기 대상이다', () => {
  assert.equal(isAbandoned({ state: STATES.ANALYZED, expireAt: NOW - 1 }, NOW), true);
});

test('수명이 남았으면 폐기 대상이 아니다', () => {
  assert.equal(isAbandoned({ state: STATES.ANALYZED, expireAt: NOW + 1 }, NOW), false);
});

test('첨부된 job은 수명을 넘겨도 폐기 대상이 아니다', () => {
  for (const state of ATTACHED_STATES) {
    assert.equal(isAbandoned({ state, expireAt: NOW - 1 }, NOW), false, state);
  }
});

test('정리 순서는 파일 → job이다', () => {
  // job 을 먼저 지우면 남은 객체를 추적할 경로·generation 이 사라진다.
  assert.deepEqual(CLEANUP_ORDER, ['final', 'staging', 'job']);
  assert.ok(CLEANUP_ORDER.indexOf('job') === CLEANUP_ORDER.length - 1);
});

// ─────────────────────────────────────────────
// 새 job
// ─────────────────────────────────────────────

test('새 job은 uploaded 상태로 시작한다', () => {
  const job = newJob({ uid: 'u1', uploadId: 'up1', clientId: 'c1', now: NOW });
  assert.equal(job.state, STATES.UPLOADED);
  assert.equal(job.leaseToken, '');
  assert.equal(job.leaseUntil.getTime(), 0);
  assert.equal(job.attempts, 0);
});

test('새 job이 스테이징 경로와 수명을 담는다', () => {
  const job = newJob({ uid: 'u1', uploadId: 'up1', clientId: 'c1', now: NOW });
  assert.equal(job.stagingPath, 'receiptStaging/u1/up1/source');
  assert.equal(job.expireAt.getTime(), NOW + STAGING_TTL_MS);
});

test('새 job은 필수 인자 없이 만들 수 없다', () => {
  assert.throws(() => newJob({ uploadId: 'up1', clientId: 'c1', now: NOW }), /uid/);
  assert.throws(() => newJob({ uid: 'u1', clientId: 'c1', now: NOW }), /uploadId/);
  assert.throws(() => newJob({ uid: 'u1', uploadId: 'up1', now: NOW }), /clientId/);
});

test('상태 목록에 중복이 없다', () => {
  assert.equal(new Set(ALL_STATES).size, ALL_STATES.length);
});
