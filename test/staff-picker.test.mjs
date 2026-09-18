// test/staff-picker.test.mjs
//
// 「담당 직원」 고르기 — 이 화면이 조용히 배정을 지우지 않는지.
//
// 검색을 붙이면서 가장 쉽게 저지를 실수는 **안 보이는 사람을 목록에서 빼는**
// 것이다. 저장은 "체크된 것 전부"를 보내므로, 체크된 줄이 DOM 에서 사라지면
// 저장하는 순간 그 사람의 배정이 사라진다. 오류도 경고도 없다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pickerModel, matchesQuery, selectionSummary, keepsAssignedEvenIfInactive, NO_TEAM,
} from '../public/domain/staff-picker.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const USERS = [
  { userId: 'kim', name: '김담당', role: '담당자', team: '1팀' },
  { userId: 'park', name: '박입력', role: '입력자', team: '1팀' },
  { userId: 'lee', name: '이담당', role: '담당자', team: '2팀' },
  { userId: 'choi', name: '최팀장', role: '팀장', team: '2팀' },
  { userId: 'no', name: '노소속', role: '입력자', team: '' },
  { userId: 'old', name: '옛담당', role: '담당자', team: '1팀', active: false },
];

const teamOf = (model, team) => model.groups.find(g => g.team === team);

test('퇴직한 사람도 담당으로 지정돼 있으면 목록에 남는다', () => {
  // 예전 화면은 active!==false 로 먼저 걸렀다. 그래서 담당자가 퇴직 처리되면
  // 이름만 고치고 저장해도 그 사람의 배정이 함께 지워졌다.
  const model = pickerModel(USERS, ['old']);
  const names = model.groups.flatMap(g => g.members).map(m => m.userId);
  assert.ok(names.includes('old'), '지정된 퇴직자가 목록에서 사라졌습니다');
  assert.equal(model.groups.flatMap(g => g.members).find(m => m.userId === 'old').inactive, true);

  // 지정돼 있지 않으면 새로 고를 이유가 없으므로 뺀다.
  const clean = pickerModel(USERS, []);
  assert.ok(!clean.groups.flatMap(g => g.members).some(m => m.userId === 'old'));
  assert.equal(keepsAssignedEvenIfInactive({ userId: 'old', active: false }, []), false);
});

test('검색은 목록에서 빼지 않고 보일 사람만 정한다', () => {
  const model = pickerModel(USERS, [], '이담당');
  const all = model.groups.flatMap(g => g.members).map(m => m.userId);
  const matched = model.groups.flatMap(g => g.matched);
  assert.ok(all.includes('kim'), '검색어와 다른 사람이 목록에서 빠졌습니다');
  assert.deepEqual(matched, ['lee']);
});

test('이름·아이디·팀 중 하나만 맞아도 찾는다', () => {
  const kim = { name: '김담당', userId: 'kim', team: '1팀' };
  assert.ok(matchesQuery(kim, '김'));
  assert.ok(matchesQuery(kim, 'KIM'));      // 대소문자 무관
  assert.ok(matchesQuery(kim, '1팀'));
  assert.ok(matchesQuery(kim, ''));         // 빈 검색어는 전부
  assert.ok(!matchesQuery(kim, '박'));
});

test('팀으로 묶고, 팀 없는 사람은 마지막에 모은다', () => {
  const model = pickerModel(USERS, []);
  assert.deepEqual(model.groups.map(g => g.team), ['1팀', '2팀', NO_TEAM]);
  assert.deepEqual(teamOf(model, '1팀').members.map(m => m.name), ['김담당', '박입력']);
  assert.equal(teamOf(model, NO_TEAM).members.length, 1);
});

test('고른 사람을 맨 위에 따로 모으고 팀마다 몇 명인지 센다', () => {
  // 지금은 누굴 골랐는지 보려면 상자를 끝까지 훑어야 한다.
  const model = pickerModel(USERS, ['lee', 'kim']);
  assert.deepEqual(model.selected.map(m => m.name), ['김담당', '이담당']);
  assert.equal(teamOf(model, '1팀').selectedCount, 1);
  assert.equal(teamOf(model, '2팀').selectedCount, 1);
});

test('요약은 몇 명인지와 누구인지를 함께 말한다', () => {
  assert.equal(selectionSummary([]), '아직 선택하지 않았습니다');
  assert.equal(selectionSummary([{ name: '김담당' }]), '1명 선택 · 김담당');
  assert.equal(
    selectionSummary([{ name: '김담당' }, { name: '박입력' }, { name: '이담당' }, { name: '최팀장' }]),
    '4명 선택 · 김담당 · 박입력 · 이담당 외 1명',
  );
});

test('피커가 그리는 체크박스와 저장이 읽는 선택자가 같다', () => {
  // 폼과 저장이 갈리면 저장 버튼이 아무도 고르지 않은 것처럼 동작한다 —
  // 그러면 담당 배정이 **전부** 지워진다.
  const picker = read('public/modules/staff-picker.js');
  const modals = read('public/modules/modals.js');
  assert.match(picker, /name="fc-staff"/);
  assert.match(modals, /input\[name="fc-staff"\]:checked/);
  assert.match(modals, /staffPickerHtml\(/, '입주자 폼이 피커를 쓰지 않습니다');
  assert.match(modals, /bindStaffPicker\(\)/, '검색·팀 묶음이 연결돼 있지 않습니다');
});

test('검색으로 걸러 두고 「팀 전체」를 눌러도 안 보이는 사람은 안 딸려온다', () => {
  // 화면 동작이라 소스로 확인한다. 보이는 줄만 바꾸는 것이 계약이다.
  const picker = read('public/modules/staff-picker.js');
  assert.match(picker, /filter\(r => r\.style\.display !== 'none'\)/);
});
