// test/report-stamps.test.mjs
//
// 결재 도장의 날짜 — 「작성일: Invalid Date」가 인쇄되던 자리.
//
// 한 문서 안에 두 모양이 섞여 있다: createdAt 은 서버가 찍는 Firestore
// Timestamp, 결재 도장은 report-workflow.js 가 찍는 ISO 문자열.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toDateValue, formatStampDate, reportDateLine, approvalStamps, reportStaffName,
} from '../public/domain/report-stamps.js';

test('Firestore Timestamp 를 읽는다 — 이것이 Invalid Date 의 원인이었다', () => {
  const at = new Date('2026-03-04T05:06:07.000Z');
  const secs = Math.floor(at.getTime() / 1000);
  assert.equal(toDateValue({ seconds: secs, nanoseconds: 0 }).getTime(), at.getTime());
  assert.equal(toDateValue({ _seconds: secs, _nanoseconds: 0 }).getTime(), at.getTime());
  assert.equal(toDateValue({ toDate: () => at }).getTime(), at.getTime());
});

test('ISO 문자열·숫자·Date 도 그대로 읽는다', () => {
  const at = new Date('2026-03-04T05:06:07.000Z');
  assert.equal(toDateValue(at.toISOString()).getTime(), at.getTime());
  assert.equal(toDateValue(at.getTime()).getTime(), at.getTime());
  assert.equal(toDateValue(at).getTime(), at.getTime());
});

test('읽을 수 없으면 null — 0(1970년)으로 답하지 않는다', () => {
  // 1970년이 인쇄되면 틀렸다는 것조차 보이지 않는다. Invalid Date 보다 나쁘다.
  for (const v of [null, undefined, '', 'garbage', {}, { seconds: 'x' }, new Date('x')]) {
    assert.equal(toDateValue(v), null, `${JSON.stringify(v)} 에서 날짜가 나왔습니다`);
  }
  assert.equal(formatStampDate(null), '');
  assert.equal(formatStampDate('garbage'), '');
});

test('인쇄물의 날짜는 제출일이다 — 제출 전에만 작성일로 떨어진다', () => {
  const created = { createdAt: { seconds: 1700000000, nanoseconds: 0 } };
  assert.equal(reportDateLine(created).label, '작성일');
  assert.ok(reportDateLine(created).date !== '-');

  const submitted = { ...created, submittedAt: '2026-03-04T00:00:00.000Z' };
  assert.equal(reportDateLine(submitted).label, '제출일');

  // 회수하면 제출 도장이 지워진다(도장 정리) — 그때는 다시 작성일이다.
  assert.equal(reportDateLine(created).label, '작성일');
  assert.deepEqual(reportDateLine(null), { label: '작성일', date: '-' });
});

test('결재란은 문서에 박힌 이름·날짜만 읽는다', () => {
  // 담당이 바뀌거나 팀장이 퇴사해도 과거 결재 문서는 그대로여야 한다.
  // 지금의 배정표에서 이름을 다시 찾으면 결재란이 조용히 달라진다.
  const rows = approvalStamps({
    submittedByName: '김담당', submittedAt: '2026-03-04T00:00:00.000Z',
    teamApprovedByName: '이팀장', teamApprovedAt: '2026-03-05T00:00:00.000Z',
  });
  assert.deepEqual(rows.map(r => r.label), ['담당', '팀장', '센터장']);
  assert.equal(rows[0].name, '김담당');
  assert.equal(rows[1].name, '이팀장');
  assert.ok(rows[0].date && rows[1].date);
  assert.deepEqual(rows[2], { label: '센터장', name: '', date: '' },
    '아직 지나지 않은 단계는 비어 있어야 합니다');
});

test('담당 칸은 제출자, 없으면 작성자', () => {
  assert.equal(reportStaffName({ submittedByName: '김담당', createdByName: '박작성' }), '김담당');
  assert.equal(reportStaffName({ createdByName: '박작성' }), '박작성');
  assert.equal(reportStaffName({}), '-');
  assert.equal(reportStaffName(null), '-');
});
