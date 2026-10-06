// test/report-stamps.test.mjs
//
// 결재 도장이 말하는 것 — **이름**뿐이다.
//
// 시각 변환은 여기서 시험하지 않는다. 그것은 domain/timestamps.js 하나이고
// test/timestamps.test.mjs 가 세 모양(Timestamp · ISO · Date)을 함께 지킨다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalStamps, reportStaffName } from '../public/domain/report-stamps.js';

test('결재란은 문서에 박힌 이름만 읽는다 — 날짜는 넣지 않는다', () => {
  // 담당이 바뀌거나 팀장이 퇴사해도 과거 결재 문서는 그대로여야 한다.
  // 지금의 배정표에서 이름을 다시 찾으면 결재란이 조용히 달라진다.
  //
  // 날짜는 도장 칸을 두 줄로 만들어 인쇄물을 빽빽하게 한다. 언제 결재됐는지는
  // 꼬리의 제출일과 화면의 결재 트랙이 말한다.
  const rows = approvalStamps({
    submittedByName: '김담당', submittedAt: '2026-03-04T00:00:00.000Z',
    teamApprovedByName: '이팀장', teamApprovedAt: '2026-03-05T00:00:00.000Z',
  });
  assert.deepEqual(rows, [
    { label: '담당', name: '김담당' },
    { label: '팀장', name: '이팀장' },
    { label: '센터장', name: '' },   // 아직 지나지 않은 단계는 비어 있다
  ]);
});

test('보고서가 없어도 세 칸은 그대로 있다', () => {
  assert.deepEqual(approvalStamps(null), [
    { label: '담당', name: '' },
    { label: '팀장', name: '' },
    { label: '센터장', name: '' },
  ]);
});

test('담당 칸은 제출자, 없으면 작성자', () => {
  // 지금 보고 있는 사람이 아니다 — 결재자가 열었을 뿐인데 담당 칸에 결재자
  // 이름이 찍히면, 보는 사람은 결재 라인이 바뀐 것으로 읽는다.
  assert.equal(reportStaffName({ submittedByName: '김담당', createdByName: '박작성' }), '김담당');
  assert.equal(reportStaffName({ createdByName: '박작성' }), '박작성');
  assert.equal(reportStaffName({}), '-');
  assert.equal(reportStaffName(null), '-');
});
