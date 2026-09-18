// test/locked-months.test.mjs
//
// 마감(최종 결재 완료) 월 색인.
//
// 배경 — 이 색인이 왜 생겼는가
//   마감 여부는 모든 역할이 알아야 한다(입력자도 마감된 달에는 거래를 못 넣어야 한다).
//   그런데 앱은 그 정보를 reports 컬렉션 조회로 만들었고, 보안 규칙은 reports를
//   담당자(등급 2) 이상만 읽게 한다. 그래서 규칙을 적용하면 **입력자가 로그인할 때
//   앱 초기화가 통째로 실패**했다 — 브라우저 화면 검증(tools/qa-smoke.mjs)에서
//   입력자만 앱에 진입하지 못하는 것으로 잡혔다.
//
//   해결: 잠긴 (입주자, 월) 키만 담은 config/lockedMonths 문서를 두고 전원이 읽는다.
//   이 파일은 그 색인의 키 형식과 갱신 판단을 고정한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { lockKey, LOCKED_MONTHS_DOC } from '../public/constants.js';

const require = createRequire(import.meta.url);
const server = require('../functions/locked-months.cjs');

const rpt = (over = {}) => ({
  clientId: 'c1', year: 2026, month: 9, status: 'confirmed', ...over,
});

test('키 형식 — 월은 2자리로 채운다', () => {
  assert.equal(lockKey('c1', 2026, 9), 'c1_2026-09');
  assert.equal(lockKey('c1', 2026, 12), 'c1_2026-12');
  assert.equal(lockKey('c1', 2026, '9'), 'c1_2026-09');
  assert.equal(lockKey('c1', 2026, '09'), 'c1_2026-09');
});

test('브라우저(ESM)와 서버(CJS)의 키가 일치한다', () => {
  const 경우 = [
    ['c1', 2026, 1], ['c1', 2026, 9], ['c1', 2026, 10], ['c1', 2026, 12],
    ['c1', 2026, '3'], ['입주자-한글', 2025, 7], ['c_2', 2030, 11],
  ];
  for (const [c, y, m] of 경우) {
    assert.equal(
      server.lockKey(c, y, m), lockKey(c, y, m),
      `불일치: ${c}/${y}/${m}`,
    );
  }
});

test('문서 이름이 양쪽에서 같다', () => {
  assert.equal(server.LOCKED_MONTHS_DOC, LOCKED_MONTHS_DOC);
});

test('confirmed가 되면 잠그고, 풀리면 해제한다', () => {
  const { lockIndexChange } = server;
  // 미저장 → confirmed
  assert.deepEqual(lockIndexChange(null, rpt()), { key: 'c1_2026-09', locked: true });
  // confirmed → 반려
  assert.deepEqual(
    lockIndexChange(rpt(), rpt({ status: 'rejected' })),
    { key: 'c1_2026-09', locked: false },
  );
  // confirmed 보고서 삭제
  assert.deepEqual(lockIndexChange(rpt(), null), { key: 'c1_2026-09', locked: false });
});

test('마감 여부가 그대로면 색인을 건드리지 않는다', () => {
  const { lockIndexChange } = server;
  // 의견만 수정 — 쓰기마다 색인을 갱신하면 불필요한 쓰기가 계속 발생한다.
  assert.equal(lockIndexChange(rpt(), rpt({ staffComment: '수정' })), null);
  // draft → submitted (둘 다 미마감)
  assert.equal(
    lockIndexChange(rpt({ status: 'draft' }), rpt({ status: 'submitted' })),
    null,
  );
  // team_approved → confirmed 는 잠금이므로 null이 아니다
  assert.deepEqual(
    lockIndexChange(rpt({ status: 'team_approved' }), rpt()),
    { key: 'c1_2026-09', locked: true },
  );
});

test('clientId·year·month가 없는 문서는 무시한다', () => {
  const { lockIndexChange } = server;
  assert.equal(lockIndexChange(null, { status: 'confirmed' }), null);
  assert.equal(lockIndexChange(null, { clientId: 'c1', status: 'confirmed' }), null);
  assert.equal(lockIndexChange(null, { clientId: 'c1', year: 2026, status: 'confirmed' }), null);
  assert.equal(lockIndexChange(null, null), null);
});

test('month가 0이어도 필드 누락으로 보지 않는다', () => {
  // `doc.month == null` 대신 `!doc.month`로 판정하면 0월(비정상 데이터)이 조용히
  // 무시된다. 색인은 들어온 값을 그대로 반영하고 판단은 상위에 맡긴다.
  const { lockIndexChange } = server;
  assert.deepEqual(
    lockIndexChange(null, rpt({ month: 0 })),
    { key: 'c1_2026-00', locked: true },
  );
});

test('백필 — confirmed만 모으고 중복은 하나로 접는다', () => {
  const { buildLockIndex } = server;
  const months = buildLockIndex([
    rpt({ clientId: 'c1', month: 8 }),
    rpt({ clientId: 'c1', month: 9 }),
    rpt({ clientId: 'c2', month: 9 }),
    rpt({ clientId: 'c1', month: 9 }),            // 중복
    rpt({ clientId: 'c3', month: 9, status: 'draft' }),      // 미마감
    rpt({ clientId: 'c4', month: 9, status: 'submitted' }),  // 미마감
    { clientId: 'c5', status: 'confirmed' },      // 연·월 누락
  ]);
  assert.deepEqual(months, {
    'c1_2026-08': true,
    'c1_2026-09': true,
    'c2_2026-09': true,
  });
});

test('백필 입력이 비어도 깨지지 않는다', () => {
  assert.deepEqual(server.buildLockIndex([]), {});
  assert.deepEqual(server.buildLockIndex(null), {});
  assert.deepEqual(server.buildLockIndex(undefined), {});
});

// ─────────────────────────────────────────────
// 제출 색인 — 삭제 가능 여부의 근거
//
// 마감 색인과 답하는 질문이 다르다. 마감은 "최종 결재가 끝났는가"(수정·삭제
// 모두 잠금), 제출은 "결재 절차에 올라갔는가"(삭제만 잠금).
// ─────────────────────────────────────────────
test('제출~결재 중인 상태만 제출 색인에 오른다', () => {
  for (const status of ['submitted', 'team_approved', 'confirmed']) {
    assert.equal(server.isSubmittedOrBeyond({ status }), true, status);
  }
  for (const status of ['draft', 'rejected', '', undefined]) {
    assert.equal(server.isSubmittedOrBeyond({ status }), false, String(status));
  }
  assert.equal(server.isSubmittedOrBeyond(null), false);
});

test('제출하면 색인에 오르고 회수하면 내려간다', () => {
  const base = { clientId: 'c1', year: 2026, month: 9 };
  const key = lockKey('c1', 2026, 9);

  // 없던 보고서가 곧바로 submitted 로 만들어지는 경로 — before 가 null 이다.
  // 이 경우를 빠뜨리면 제출된 달의 거래가 그대로 삭제된다.
  assert.deepEqual(
    server.submitIndexChange(null, { ...base, status: 'submitted' }),
    { key, submitted: true },
  );
  // 회수·반려 — 다시 담당자 손으로 돌아오므로 삭제가 열린다.
  assert.deepEqual(
    server.submitIndexChange({ ...base, status: 'submitted' }, { ...base, status: 'draft' }),
    { key, submitted: false },
  );
  assert.deepEqual(
    server.submitIndexChange({ ...base, status: 'team_approved' }, { ...base, status: 'rejected' }),
    { key, submitted: false },
  );
});

test('결재 단계 사이 이동은 제출 색인을 건드리지 않는다', () => {
  const base = { clientId: 'c1', year: 2026, month: 9 };
  for (const [from, to] of [
    ['submitted', 'team_approved'], ['team_approved', 'confirmed'],
    ['confirmed', 'team_approved'], ['draft', 'rejected'],
  ]) {
    assert.equal(
      server.submitIndexChange({ ...base, status: from }, { ...base, status: to }), null,
      `${from} → ${to}`,
    );
  }
});

test('제출 색인 백필은 결재 중인 달을 전부 담는다', () => {
  const months = server.buildSubmitIndex([
    { clientId: 'c1', year: 2026, month: 9, status: 'submitted' },
    { clientId: 'c2', year: 2026, month: 9, status: 'confirmed' },
    { clientId: 'c3', year: 2026, month: 9, status: 'draft' },
    { clientId: 'c4', year: 2026, month: 9, status: 'rejected' },
    { year: 2026, month: 9, status: 'submitted' },          // clientId 없음
  ]);
  assert.deepEqual(
    Object.keys(months).sort(),
    [lockKey('c1', 2026, 9), lockKey('c2', 2026, 9)].sort(),
  );
});

test('두 색인의 범위가 다르다 — 마감은 최종 결재만', () => {
  const reports = [
    { clientId: 'c1', year: 2026, month: 9, status: 'submitted' },
    { clientId: 'c2', year: 2026, month: 9, status: 'confirmed' },
  ];
  assert.equal(Object.keys(server.buildSubmitIndex(reports)).length, 2);
  assert.deepEqual(Object.keys(server.buildLockIndex(reports)), [lockKey('c2', 2026, 9)]);
});

// ─────────────────────────────────────────────────────────────
// 결재 색인 — 세 번째 질문: 팀장 결재가 끝났는가
// ─────────────────────────────────────────────────────────────

test('팀장 결재로 결재 색인에 들어가고, 취소하면 빠진다', () => {
  const base = { clientId: 'c1', year: 2026, month: 9 };
  const key = lockKey('c1', 2026, 9);
  assert.deepEqual(
    server.approveIndexChange({ ...base, status: 'submitted' }, { ...base, status: 'team_approved' }),
    { key, approved: true },
  );
  // 팀장이 자기 결재를 무르면(회수) 그 달은 다시 열린다.
  assert.deepEqual(
    server.approveIndexChange({ ...base, status: 'team_approved' }, { ...base, status: 'submitted' }),
    { key, approved: false },
  );
  assert.deepEqual(
    server.approveIndexChange({ ...base, status: 'confirmed' }, { ...base, status: 'rejected' }),
    { key, approved: false },
  );
});

test('제출·최종 결재 사이 이동은 결재 색인을 건드리지 않는다', () => {
  const base = { clientId: 'c1', year: 2026, month: 9 };
  for (const [from, to] of [
    ['draft', 'submitted'], ['team_approved', 'confirmed'], ['confirmed', 'team_approved'],
    ['draft', 'rejected'],
  ]) {
    assert.equal(
      server.approveIndexChange({ ...base, status: from }, { ...base, status: to }), null,
      `${from} → ${to}`,
    );
  }
});

test('세 색인의 범위가 층을 이룬다 — 마감 ⊂ 결재 ⊂ 제출', () => {
  // 이 포함 관계가 깨지면 "팀장은 못 고치는데 담당자는 고칠 수 있는 달"처럼
  // 뜻이 없는 상태가 생긴다.
  const reports = [
    { clientId: 'c1', year: 2026, month: 9, status: 'submitted' },
    { clientId: 'c2', year: 2026, month: 9, status: 'team_approved' },
    { clientId: 'c3', year: 2026, month: 9, status: 'confirmed' },
    { clientId: 'c4', year: 2026, month: 9, status: 'draft' },
  ];
  const submitted = new Set(Object.keys(server.buildSubmitIndex(reports)));
  const approved = new Set(Object.keys(server.buildApproveIndex(reports)));
  const locked = new Set(Object.keys(server.buildLockIndex(reports)));
  assert.equal(submitted.size, 3);
  assert.equal(approved.size, 2);
  assert.equal(locked.size, 1);
  for (const k of approved) assert.ok(submitted.has(k), `${k}가 제출 색인에 없습니다`);
  for (const k of locked) assert.ok(approved.has(k), `${k}가 결재 색인에 없습니다`);
});

test('결재 색인도 세 곳이 함께 유지된다 — 전이·백필·규칙', () => {
  // 한 곳만 고치면 색인이 어긋나고, 어긋난 색인은 "결재했는데 아직 고쳐지는 달"로
  // 조용히 나타난다. 화면으로는 티가 나지 않는다.
  const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  assert.match(read('functions/report-fns.js'), /approveIndexChange/,
    '결재 전이가 결재 색인을 갱신하지 않습니다');
  assert.match(read('functions/report-fns.js'), /indexPatch\.approvedMonths/,
    '결재 색인을 문서에 쓰지 않습니다');
  assert.match(read('functions/ledger-triggers.js'), /buildApproveIndex/,
    '색인 재생성이 결재 색인을 빼먹습니다');
  assert.match(read('firestore.rules'), /function approvedMonths\(\)/,
    '규칙이 결재 색인을 읽지 않습니다');
  assert.match(read('public/modules/core.js'), /S\.approvedMonths/,
    '화면이 결재 색인을 읽지 않습니다');
});
