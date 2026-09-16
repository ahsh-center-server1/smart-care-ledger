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
  withCaps, projectAssignments,
} = require('../functions/authz.cjs');

/** 계획을 읽기 쉬운 형태로 — 실패 메시지가 바로 이해되게. */
const summarize = (plan) => ({
  members: plan.memberOps.map(o => `${o.uid}:${o.op}${o.op === 'set' ? `(staff=${o.isStaff},leader=${o.isLeader})` : ''}`).sort(),
  access: plan.accessOps.map(o => `${o.uid}:${o.op}`).sort(),
  leaders: plan.leaderOps.map(o => `${o.uid}:${o.op}`).sort(),
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
    access: ['u1:add'], leaders: [],
    writes: 3,   // clients 1 + 멤버 1 + 접근 1
  });
});

test('담당자를 제거하면 멤버 삭제 + 접근 회수', () => {
  const p = plan({ staff: ['u1'], leader: '' }, { staff: [], leader: '' });
  assert.deepEqual(summarize(p), {
    members: ['u1:delete'],
    access: ['u1:remove'], leaders: [],
    writes: 3,
  });
});

test('변경이 없으면 원본 쓰기 1건뿐', () => {
  const p = plan({ staff: ['u1', 'u2'], leader: 'u3' }, { staff: ['u1', 'u2'], leader: 'u3' });
  assert.deepEqual(summarize(p), { members: [], access: [], leaders: [], writes: 1 });
});

test('순서만 다르면 변경이 아니다', () => {
  const p = plan({ staff: ['u1', 'u2'] }, { staff: ['u2', 'u1'] });
  assert.deepEqual(summarize(p), { members: [], access: [], leaders: [], writes: 1 });
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
    access: [], leaders: [],            // ← 접근은 그대로
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
    leaders: ['u1:add'],
    writes: 4,
  });
});

test('두 역할을 동시에 잃으면 접근을 회수한다', () => {
  const p = plan({ staff: ['u1'], leader: 'u1' }, { staff: [], leader: '' });
  assert.deepEqual(summarize(p), {
    members: ['u1:delete'],
    access: ['u1:remove'],
    leaders: ['u1:remove'],
    writes: 4,
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
    members: ['u1:delete'], access: ['u1:remove'], leaders: ['u1:remove'], writes: 4,
  });
});

// ─────────────────────────────────────────────
// 쓰기 수
// ─────────────────────────────────────────────

test('쓰기 수는 원본 1 + 멤버 + 접근 + 팀장 범위다', () => {
  const p = plan({ staff: [] }, { staff: ['u1', 'u2', 'u3'] });
  assert.equal(p.memberOps.length, 3);
  assert.equal(p.accessOps.length, 3);
  assert.equal(p.writeCount, 7);
});

test('역할만 바뀐 사람은 접근 쓰기를 만들지 않는다', () => {
  // `1 + 2 × 인원`은 상한이다. 실제로는 그보다 적을 수 있다.
  const p = plan({ staff: ['u1'], leader: 'u1' }, { staff: ['u1'], leader: '' });
  assert.equal(p.affectedUids.length, 1);
  assert.equal(p.writeCount, 3);          // 원본 + 멤버 + 팀장 범위 회수
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

test('역할이 없으면 업무 역할을 임의 부여하지 않는다', () => {
  assert.equal(newAuthzDoc({ uid: 'u1' }).role, '');
  assert.equal(newAuthzDoc({ uid: 'u1' }).isAdmin, false);
});

// ─────────────────────────────────────────────
// 백필 투영 — clients 원본에서 투영본을 다시 만든다
//
// 증분으로 고치면 "어긋났다는 것"을 모르는 상태에서 시작해야 한다.
// 원본에서 통째로 다시 만들면 드리프트가 구조적으로 불가능해진다.
// ─────────────────────────────────────────────

/** 계획 비교를 읽기 쉽게 — Map을 평범한 객체로. */
const proj = (clients) => {
  const { accessByUid, membersByClient } = projectAssignments(clients);
  return {
    access: Object.fromEntries(accessByUid),
    members: Object.fromEntries(
      [...membersByClient].map(([k, v]) => [
        k, v.map(m => `${m.uid}(staff=${m.isStaff},leader=${m.isLeader})`).sort(),
      ]),
    ),
  };
};

test('담당 직원과 담당 팀장을 모두 접근 목록에 넣는다', () => {
  const out = proj([{ id: 'c1', userIds: 'u1,u2', teamLeader: 'u3' }]);
  assert.deepEqual(out.access, { u1: ['c1'], u2: ['c1'], u3: ['c1'] });
});

test('팀장으로만 배정된 사람도 접근을 갖는다', () => {
  // ★ staff만 보고 만들면 팀장이 자기 결재 대상을 못 본다.
  const out = proj([{ id: 'c1', userIds: 'u1', teamLeader: 'u9' }]);
  assert.deepEqual(out.access.u9, ['c1']);
  assert.deepEqual(out.members.c1, [
    'u1(staff=true,leader=false)',
    'u9(staff=false,leader=true)',
  ]);
});

test('겸임은 멤버 문서 하나로 표현된다', () => {
  const out = proj([{ id: 'c1', userIds: 'u1', teamLeader: 'u1' }]);
  assert.deepEqual(out.members.c1, ['u1(staff=true,leader=true)']);
  assert.deepEqual(out.access.u1, ['c1']);
});

test('여러 입주자의 담당이 한 사람에게 모인다', () => {
  const out = proj([
    { id: 'c1', userIds: 'u1' },
    { id: 'c2', userIds: 'u1,u2' },
    { id: 'c3', teamLeader: 'u1' },
  ]);
  assert.deepEqual(out.access.u1, ['c1', 'c2', 'c3']);
  assert.deepEqual(out.access.u2, ['c2']);
});

test('담당 목록의 중복을 없애고 정렬한다', () => {
  const out = proj([
    { id: 'c1', userIds: 'u1,u1' },
    { id: 'c1', userIds: 'u1' },   // 같은 입주자가 두 번 들어와도
  ]);
  assert.deepEqual(out.access.u1, ['c1']);
});

test('담당이 없는 입주자는 멤버가 비어 있다', () => {
  const out = proj([{ id: 'c1', userIds: '', teamLeader: '' }]);
  assert.deepEqual(out.members.c1, []);
  assert.deepEqual(out.access, {});
});

test('id가 없는 입주자는 건너뛴다', () => {
  // 손상된 문서 하나 때문에 백필 전체가 실패하면 안 된다.
  const out = proj([{ userIds: 'u1' }, { id: '  ', userIds: 'u2' }, { id: 'c1', userIds: 'u3' }]);
  assert.deepEqual(Object.keys(out.members), ['c1']);
  assert.deepEqual(out.access, { u3: ['c1'] });
});

test('빈 입력에도 안전하다', () => {
  assert.deepEqual(proj([]), { access: {}, members: {} });
  assert.deepEqual(proj(null), { access: {}, members: {} });
  assert.deepEqual(proj(undefined), { access: {}, members: {} });
});

test('투영은 같은 입력에 같은 결과를 낸다 (멱등)', () => {
  // 백필은 중단되면 다시 돌린다. 몇 번을 돌려도 결과가 같아야 한다.
  const clients = [
    { id: 'c2', userIds: 'u2,u1', teamLeader: 'u3' },
    { id: 'c1', userIds: 'u1' },
  ];
  assert.deepEqual(proj(clients), proj(clients));
});

// ─────────────────────────────────────────────
// caps 얹기
// ─────────────────────────────────────────────

test('withCaps가 caps와 스키마 버전을 담는다', () => {
  const doc = newAuthzDoc({ uid: 'u1', role: '담당자', approved: true, active: true });
  const out = withCaps(doc, { trxCreate: true, settingsReset: false }, 7);
  assert.equal(out.capSchemaVersion, 7);
  assert.deepEqual(out.caps, { trxCreate: true, settingsReset: false });
  // 원래 필드는 유지된다.
  assert.equal(out.uid, 'u1');
  assert.equal(out.enabled, true);
});

test('withCaps가 원본 문서를 바꾸지 않는다', () => {
  const doc = newAuthzDoc({ uid: 'u1' });
  withCaps(doc, { a: true }, 1);
  assert.equal('caps' in doc, false);
});

test('withCaps가 caps 객체를 복사한다', () => {
  // 같은 caps 객체를 여러 사용자에게 얹을 때 한 사람의 수정이 번지면 안 된다.
  const caps = { trxCreate: true };
  const out = withCaps(newAuthzDoc({ uid: 'u1' }), caps, 1);
  caps.trxCreate = false;
  assert.equal(out.caps.trxCreate, true);
});
