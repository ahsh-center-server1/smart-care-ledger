import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as esm from '../public/domain/report-workflow.js';

const require = createRequire(import.meta.url);
const cjs = require('../functions/report-workflow.cjs');

/**
 * 결재 전이표가 화면과 서버에서 **같은 답을 내는가.**
 *
 * 왜 이 파일이 필요한가
 *   functions/ 는 별도 배포 단위라 public/ 을 import 할 수 없다. 그래서
 *   생성기가 원본을 기계적으로 옮긴다. 생성기를 돌리지 않고 원본만 고치면
 *   화면은 새 규칙으로, 서버는 옛 규칙으로 결재를 판정한다 — 그리고 그 사실은
 *   배포한 뒤에야 드러난다.
 *
 *   그래서 두 겹으로 막는다:
 *     1. 생성물이 최신인가 (--check)
 *     2. 두 구현이 **모든 조합에서** 같은 답을 내는가
 *
 *   2번이 있는 이유: 생성기가 언젠가 손질되면 텍스트는 같아도 동작이 갈릴 수
 *   있다. 텍스트 비교가 아니라 동작 비교여야 한다.
 */

test('생성물이 원본과 동기화돼 있다', () => {
  execFileSync(process.execPath, ['tools/gen-report-workflow.mjs', '--check'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'pipe',
  });
});

test('내보내는 이름이 같다', () => {
  const esmNames = Object.keys(esm).sort();
  const cjsNames = Object.keys(cjs).sort();
  assert.deepEqual(cjsNames, esmNames);
});

test('전이표가 글자 하나까지 같다', () => {
  assert.deepEqual(cjs.TRANSITIONS, esm.TRANSITIONS);
  assert.deepEqual(cjs.STAGE_STAMPS, esm.STAGE_STAMPS);
  assert.deepEqual(cjs.STAGE_LEVEL, esm.STAGE_LEVEL);
});

/** 권한 조합을 전수로 만든다 — 결재 판정에 실제로 쓰이는 키만. */
const PERM_KEYS = [
  'report.draft', 'report.submit', 'report.approve.team', 'report.approve.center',
  'report.reject', 'report.recall', 'report.revert', 'report.release',
];

function* permSets() {
  for (let mask = 0; mask < (1 << PERM_KEYS.length); mask += 1) {
    const on = new Set(PERM_KEYS.filter((_, i) => mask & (1 << i)));
    yield { mask, can: (k) => on.has(k) };
  }
}

test('모든 (상태 × 동작 × 권한 × 신원) 조합에서 답이 같다', () => {
  const states = [...Object.keys(esm.TRANSITIONS), '', '알수없음'];
  const actions = [...new Set(Object.values(esm.TRANSITIONS).flatMap(Object.keys)), '없는동작'];
  const flags = [false, true];

  let checked = 0;
  for (const { can } of permSets()) {
    for (const state of states) {
      for (const action of actions) {
        for (const isAuthor of flags) {
          for (const isAssignedLeader of flags) {
            for (const leaderVacant of flags) {
              const ctx = {
                can, isAuthor, isAssignedLeader, leaderVacant,
                userId: 'u1', userName: '홍길동', now: '2026-09-04T00:00:00.000Z',
              };
              assert.deepEqual(
                cjs.planTransition(action, state, ctx),
                esm.planTransition(action, state, ctx),
                `갈라짐: ${state} --${action}--> (author=${isAuthor}, leader=${isAssignedLeader}, vacant=${leaderVacant})`,
              );
              checked += 1;
            }
          }
        }
      }
    }
  }
  // 조합 수가 줄면 검사가 헐거워진 것이다 — 그것도 잡는다.
  assert.ok(checked > 20000, `검사한 조합이 너무 적습니다 (${checked})`);
});

test('availableActions 도 같은 답을 낸다', () => {
  for (const { can } of permSets()) {
    for (const state of Object.keys(esm.TRANSITIONS)) {
      for (const isAssignedLeader of [false, true]) {
        const ctx = { can, isAssignedLeader, isAuthor: true, leaderVacant: false };
        assert.deepEqual(cjs.availableActions(state, ctx), esm.availableActions(state, ctx));
      }
    }
  }
});

test('normalizeStatus · stampsFor 도 같다', () => {
  for (const s of ['draft', 'submitted', 'team_approved', 'confirmed', 'rejected', '', null, '이상한값']) {
    assert.equal(cjs.normalizeStatus(s), esm.normalizeStatus(s));
    assert.deepEqual(cjs.stampsFor(s), esm.stampsFor(s));
  }
});
