// test/authz.test.mjs
//
// 권한 투영의 불변식.
//
// 이 파일이 지키는 것 중 가장 중요한 하나
//   **담당 직원에서 빠졌지만 여전히 결재 책임자인 사람은 접근 권한을 잃지 않는다.**
//   설계 검토에서 잡힌 결함이다. staff 와 leader 를 독립적으로 처리하면
//   반드시 이 실수를 하고, 그러면 팀장이 자기 결재 대상을 못 보게 된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MAX_ASSIGNMENT_WRITES, parseStaffIds, isEnabled,
  planAssignmentChange, assertWritable, memberPath, newAuthzDoc,
} = require('../functions/authz.cjs');

/** 계획을 읽기 쉬운 형태로 — 실패 메시지가 바로 이해되게. */
const summarize = (plan) => ({
  members: plan.memberOps.map(o => `${o.uid}:${o.op}${o.op === 'set' ? `(staff=${o.isStaff},leader=${o.isLeader})` : ''}`).sort(),
  access: plan.accessOps.map(o => `${o.uid}:${o.op}`).sort(),
  writes: plan.writeCount,
});

const plan = (prev, next) => planAssignmentChange({ clientId: 'c1', prev, next });

// ─────────────────────────────────────────────
// 입력 정규화
// ─────────────────────────────────────────────

test('쉼표 문자열을 uid 배열로 읽는다', () => {
  assert.deepEqual(parseStaffIds('u1,u2,u3'), ['u1', 'u2', 'u3']);
  assert.deepEqual(parseStaffIds('u1, u2 , u3'), ['u1', 'u2', 'u3']);
});

test('빈 값과 공백만 있는 항목을 버린다', () => {
  assert.deepEqual(parseStaffIds(''), []);
  assert.deepEqual(parseStaffIds(null), []);
  assert.deepEqual(parseStaffIds(undefined), []);
  assert.deepEqual(parseStaffIds('  ,  ,  '), []);
  assert.deepEqual(parseStaffIds('u1,,u2'), ['u1', 'u2']);
});

test('중복을 없앤다', () => {
  // 정규화하지 않으면 같은 문서를 트랜잭션에서 두 번 쓰려다 실패한다.
  assert.deepEqual(parseStaffIds('u1,u1,u2'), ['u1', 'u2']);
  assert.deepEqual(parseStaffIds(['u1', ' u1 ', 'u2']), ['u1', 'u2']);
});

test('배열 입력도 받는다', () => {
  assert.deepEqual(parseStaffIds(['u1', 'u2']), ['u1', 'u2']);
});

// ─────────────────────────────────────────────
// 재직 여부
// ─────────────────────────────────────────────

test('enabled는 approved와 active를 모두 본다', () => {
  assert.equal(isEnabled({ approved: true, active: true }), true);
  assert.equal(isEnabled({ approved: false, active: true }), false);
  assert.equal(isEnabled({ approved: true, active: false }), false);
  assert.equal(isEnabled({ approved: false, active: false }), false);
});

test('필드가 없으면 재직으로 본다 (기존 문서 호환)', () => {
  // 기존 사용자 문서에는 approved·active가 없을 수 있다. 없다는 것이
  // 비활성이라는 뜻은 아니다 — 마이그레이션 전 계정이 전부 잠기면 안 된다.
  assert.equal(isEnabled({}), true);
});

test('사용자가 없으면 재직이 아니다', () => {
  assert.equal(isEnabled(null), false);
  assert.equal(isEnabled(undefined), false);
});

// ─────────────────────────────────────────────
// 담당 변경 계획 — 기본
// ─────────────────────────────────────────────

test('담당자를 추가하면 멤버 생성 + 접근 부여', () => {
  const p = plan({ staff: [], leader: '' }, { staff: ['u1'], leader: '' });
  assert.deepEqual(summarize(p), {
    members: ['u1:set(staff=true,leader=false)'],
    access: ['u1:add'],
    writes: 3,   // clients 1 + 멤버 1 + 접근 1
  });
});

test('담당자를 제거하면 멤버 삭제 + 접근 회수', () => {
  const p = plan({ staff: ['u1'], leader: '' }, { staff: [], leader: '' });
  assert.deepEqual(summarize(p), {
    members: ['u1:delete'],
    access: ['u1:remove'],
    writes: 3,
  });
});

test('변경이 없으면 원본 쓰기 1건뿐', () => {
  const p = plan({ staff: ['u1', 'u2'], leader: 'u3' }, { staff: ['u1', 'u2'], leader: 'u3' });
  assert.deepEqual(summarize(p), { members: [], access: [], writes: 1 });
});

test('순서만 다르면 변경이 아니다', () => {
  const p = plan({ staff: ['u1', 'u2'] }, { staff: ['u2', 'u1'] });
  assert.deepEqual(summarize(p), { members: [], access: [], writes: 1 });
});

// ─────────────────────────────────────────────
// 이중 역할 — 설계 검토에서 잡힌 결함
// ─────────────────────────────────────────────

test('담당자에서 빠져도 결재 책임자로 남으면 접근을 유지한다', () => {
  // ★ 이것이 이 파일의 존재 이유다. accessibleClientIds를 staff만 보고
  //   갱신하면 팀장이 자기 결재 대상을 못 보게 된다.
  const p = plan(
    { staff: ['u1', 'u2'], leader: 'u1' },
    { staff: ['u2'], leader: 'u1' },
  );
  assert.deepEqual(summarize(p), {
    members: ['u1:set(staff=false,leader=true)'],
    access: [],            // ← 접근은 그대로
    writes: 2,
  });
});

test('결재 책임자에서 빠져도 담당자로 남으면 접근을 유지한다', () => {
  const p = plan(
    { staff: ['u1'], leader: 'u1' },
    { staff: ['u1'], leader: 'u2' },
  );
  const s = summarize(p);
  assert.deepEqual(s.members, [
    'u1:set(staff=true,leader=false)',
    'u2:set(staff=false,leader=true)',
  ]);
  assert.deepEqual(s.access, ['u2:add']);   // u1은 유지, u2는 새로 부여
});

test('담당자이면서 결재 책임자일 수 있다', () => {
  const p = plan({ staff: [], leader: '' }, { staff: ['u1'], leader: 'u1' });
  assert.deepEqual(summarize(p), {
    members: ['u1:set(staff=true,leader=true)'],
    access: ['u1:add'],
    writes: 3,
  });
});

test('두 역할을 동시에 잃으면 접근을 회수한다', () => {
  const p = plan({ staff: ['u1'], leader: 'u1' }, { staff: [], leader: '' });
  assert.deepEqual(summarize(p), {
    members: ['u1:delete'],
    access: ['u1:remove'],
    writes: 3,
  });
});

test('결재 책임자만 교체하면 이전 사람은 접근을 잃는다', () => {
  const p = plan({ staff: ['u9'], leader: 'u1' }, { staff: ['u9'], leader: 'u2' });
  const s = summarize(p);
  assert.deepEqual(s.access, ['u1:remove', 'u2:add']);
  assert.deepEqual(s.members, ['u1:delete', 'u2:set(staff=false,leader=true)']);
});

test('결재 책임자를 공석으로 두면 접근을 잃는다', () => {
  const p = plan({ staff: [], leader: 'u1' }, { staff: [], leader: '' });
  assert.deepEqual(summarize(p), {
    members: ['u1:delete'], access: ['u1:remove'], writes: 3,
  });
});

// ─────────────────────────────────────────────
// 쓰기 수
// ─────────────────────────────────────────────

test('쓰기 수는 원본 1 + 멤버 + 접근이다', () => {
  const p = plan({ staff: [] }, { staff: ['u1', 'u2', 'u3'] });
  assert.equal(p.memberOps.length, 3);
  assert.equal(p.accessOps.length, 3);
  assert.equal(p.writeCount, 7);
});

test('역할만 바뀐 사람은 접근 쓰기를 만들지 않는다', () => {
  // `1 + 2 × 인원`은 상한이다. 실제로는 그보다 적을 수 있다.
  const p = plan({ staff: ['u1'], leader: 'u1' }, { staff: ['u1'], leader: '' });
  assert.equal(p.affectedUids.length, 1);
  assert.equal(p.writeCount, 2);          // 1 + 2×1 = 3 이 아니다
});

test('중복 입력이 쓰기 수를 부풀리지 않는다', () => {
  const p = plan({ staff: [] }, { staff: ['u1', 'u1', 'u1'] });
  assert.equal(p.writeCount, 3);
});

test('상한 안이면 통과한다', () => {
  const p = plan({ staff: [] }, { staff: Array.from({ length: 100 }, (_, i) => `u${i}`) });
  assert.equal(p.writeCount, 201);
  assert.equal(assertWritable(p), p);
});

test('상한을 넘으면 트랜잭션 시작 전에 거부한다', () => {
  // 트랜잭션을 시작한 뒤 한도에 닿으면 통째로 실패하고 원인이 남지 않는다.
  const many = Array.from({ length: MAX_ASSIGNMENT_WRITES }, (_, i) => `u${i}`);
  const p = plan({ staff: [] }, { staff: many });
  assert.ok(p.writeCount > MAX_ASSIGNMENT_WRITES);
  assert.throws(() => assertWritable(p), /담당 인원을 넘었습니다/);
});

// ─────────────────────────────────────────────
// 문서 형태
// ─────────────────────────────────────────────

test('clientId가 없으면 계획을 세우지 않는다', () => {
  assert.throws(() => planAssignmentChange({ prev: {}, next: {} }), /clientId/);
});

test('멤버 경로가 규칙과 같은 모양이다', () => {
  assert.equal(memberPath('c1', 'u1'), 'clientAccess/c1/members/u1');
});

test('새 authz 문서에는 caps가 없다 — fail-closed', () => {
  // caps 백필 전에는 모든 권한이 거부되어야 한다. 빈 객체라도 넣으면
  // 규칙이 "값이 있다"고 읽어 판정이 흔들린다.
  const doc = newAuthzDoc({ uid: 'u1', role: '담당자', approved: true, active: true });
  assert.equal('caps' in doc, false);
  assert.equal('capSchemaVersion' in doc, false);
});

test('새 authz 문서가 enabled를 계산해 담는다', () => {
  assert.equal(newAuthzDoc({ uid: 'u1', approved: true, active: true }).enabled, true);
  assert.equal(newAuthzDoc({ uid: 'u1', approved: false, active: true }).enabled, false);
  assert.equal(newAuthzDoc({ uid: 'u1', approved: true, active: false }).enabled, false);
});

test('새 authz 문서의 담당 목록에서 중복을 없앤다', () => {
  const doc = newAuthzDoc({ uid: 'u1', accessibleClientIds: ['c1', 'c1', ' c2 '] });
  assert.deepEqual(doc.accessibleClientIds, ['c1', 'c2']);
});

test('역할이 없으면 가장 낮은 등급으로 둔다', () => {
  assert.equal(newAuthzDoc({ uid: 'u1' }).role, '입력자');
  assert.equal(newAuthzDoc({ uid: 'u1' }).isAdmin, false);
});
