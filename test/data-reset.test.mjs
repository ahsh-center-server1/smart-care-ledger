// test/data-reset.test.mjs
//
// 전체 초기화의 대상 목록·진행 상태 계산.
//
// 이 모듈이 있는 이유는 종전 초기화가 (1) 중단되면 반쯤 지워진 채 남고
// (2) 화면에 알린 범위와 실제 삭제 범위가 달랐기 때문이다.
// 그래서 여기서 고정하는 것은 두 가지다: **지우지 말아야 할 것을 지우지 않는다**,
// **중단된 지점부터 이어서 진행할 수 있다**.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_RESET_CONFIRM_TEXT, RESET_COLLECTIONS, RESET_PRESERVED,
  MAX_DELETES_PER_BATCH, RESET_OPERATION_ID,
  isResetLockActive, remainingCollections, resetProgressPercent,
  resetProgressLabel, isResetConfirmed,
} from '../public/domain/data-reset.js';

test('배치 크기는 499다 — 진행 상태 갱신 1건이 같은 배치에 탄다', () => {
  // 500으로 두면 진행 표시를 합칠 때마다 배치가 넘쳐 실패한다.
  assert.equal(MAX_DELETES_PER_BATCH, 499);
  assert.ok(MAX_DELETES_PER_BATCH < 500);
});

test('직원 계정·감사 로그·마감 보관본은 지우지 않는다', () => {
  const cols = RESET_COLLECTIONS.map(c => c.col);
  // users를 지우면 아무도 로그인할 수 없다.
  assert.ok(!cols.includes('users'), 'users를 지우면 로그인이 불가능해진다');
  assert.ok(!cols.includes('userSecrets'), 'userSecrets를 지우면 로그인이 불가능해진다');
  // 초기화로 기록을 없앨 수 있으면 기록의 의미가 없다.
  assert.ok(!cols.includes('auditLogs'), '변경 이력은 초기화로 지울 수 없어야 한다');
  // config를 통째로 지우면 권한 등급표와 마감 색인이 함께 사라진다 (종전 버그).
  assert.ok(!cols.includes('config'), 'config를 지우면 권한 등급표가 사라진다');
  assert.ok(!cols.some(c => c.startsWith('archive_')), '마감 보관본은 지우지 않는다');
});

test('운영 데이터는 빠짐없이 지운다', () => {
  const cols = RESET_COLLECTIONS.map(c => c.col);
  for (const must of ['transactions', 'reports', 'accounts', 'clients',
    'categories', 'fixedItems', 'budgets', 'excelUploads']) {
    assert.ok(cols.includes(must), `${must}가 삭제 대상에서 빠졌다`);
  }
});

test('모든 대상에 한글 이름이 있다 — 확인 창이 이 이름을 보여준다', () => {
  for (const c of RESET_COLLECTIONS) {
    assert.ok(c.col && c.col.trim(), '컬렉션명이 비었다');
    assert.ok(c.label && c.label.trim(), `${c.col}: 한글 이름이 없다`);
  }
  const cols = RESET_COLLECTIONS.map(c => c.col);
  assert.equal(new Set(cols).size, cols.length, '중복된 컬렉션이 있다');
});

test('보존 목록이 비어 있지 않다 — 무엇이 남는지 알려야 안심할 수 있다', () => {
  assert.ok(RESET_PRESERVED.length >= 3);
  for (const p of RESET_PRESERVED) assert.ok(p && p.trim());
});

test('확인 문구 — 공백은 허용하고 다른 입력은 거부한다', () => {
  assert.equal(DATA_RESET_CONFIRM_TEXT, '초기화');
  assert.equal(isResetConfirmed('초기화'), true);
  assert.equal(isResetConfirmed('  초기화  '), true);
  assert.equal(isResetConfirmed('초기화합니다'), false);
  assert.equal(isResetConfirmed('reset'), false);
  assert.equal(isResetConfirmed(''), false);
  assert.equal(isResetConfirmed(null), false);
  assert.equal(isResetConfirmed(undefined), false);
});

test('진행 중 잠금 — 방금 갱신된 running은 잠긴 것으로 본다', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const state = { status: 'running', updatedAt: new Date(now - 60_000).toISOString() };
  assert.equal(isResetLockActive(state, now), true);
});

test('오래된 running은 죽은 것으로 보고 이어서 진행할 수 있다', () => {
  // 브라우저가 닫히면 running이 영원히 남아 아무도 다시 실행할 수 없게 된다.
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const state = { status: 'running', updatedAt: new Date(now - 20 * 60_000).toISOString() };
  assert.equal(isResetLockActive(state, now), false);
});

test('running이 아니거나 시각을 못 읽으면 잠긴 것으로 보지 않는다', () => {
  const now = Date.now();
  assert.equal(isResetLockActive(null, now), false);
  assert.equal(isResetLockActive({}, now), false);
  assert.equal(isResetLockActive({ status: 'done', updatedAt: new Date().toISOString() }, now), false);
  assert.equal(isResetLockActive({ status: 'failed', updatedAt: new Date().toISOString() }, now), false);
  assert.equal(isResetLockActive({ status: 'running' }, now), false);
  assert.equal(isResetLockActive({ status: 'running', updatedAt: '엉터리' }, now), false);
});

test('startedAt만 있어도 잠금을 판정한다', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(
    isResetLockActive({ status: 'running', startedAt: new Date(now - 60_000).toISOString() }, now),
    true,
  );
});

test('이어서 진행 — 끝낸 컬렉션은 건너뛴다', () => {
  const state = { doneCollections: ['transactions', 'reports'] };
  const left = remainingCollections(state).map(c => c.col);
  assert.ok(!left.includes('transactions'));
  assert.ok(!left.includes('reports'));
  assert.equal(left.length, RESET_COLLECTIONS.length - 2);
  // 순서는 원래 정의 순서를 지킨다(거래 → 보고서 → … 참조 관계 순).
  assert.deepEqual(left, RESET_COLLECTIONS.slice(2).map(c => c.col));
});

test('처음 실행이면 전부 대상이다', () => {
  assert.equal(remainingCollections(null).length, RESET_COLLECTIONS.length);
  assert.equal(remainingCollections({}).length, RESET_COLLECTIONS.length);
});

test('진행률 — 컬렉션 단위로 센다', () => {
  assert.equal(resetProgressPercent(null), 0);
  assert.equal(resetProgressPercent({ doneCollections: [] }), 0);
  assert.equal(
    resetProgressPercent({ doneCollections: RESET_COLLECTIONS.map(c => c.col) }),
    100,
  );
  const half = RESET_COLLECTIONS.slice(0, 4).map(c => c.col);
  assert.equal(resetProgressPercent({ doneCollections: half }), 50);
});

test('진행 문구 — 완료 항목과 삭제 건수를 함께 보여준다', () => {
  const label = resetProgressLabel({
    doneCollections: ['transactions', 'reports'],
    deletedCounts: { transactions: 1500, reports: 24 },
  });
  assert.match(label, /2\/8/);
  assert.match(label, /1,524/);
  // 상태가 없어도 문구가 깨지지 않는다
  assert.match(resetProgressLabel(null), /0\/8/);
});

test('작업 문서 id가 고정되어 있다 — 재실행이 상태를 새로 만들지 않게', () => {
  assert.equal(RESET_OPERATION_ID, 'data-reset');
});
