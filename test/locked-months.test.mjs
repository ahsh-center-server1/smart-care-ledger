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
