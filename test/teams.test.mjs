// test/teams.test.mjs
//
// 팀 — **배정의 틀이지 권한의 축이 아니다.**
//
// 이 파일이 지키는 것은 두 가지다.
//   1) 화면과 서버가 같은 판정을 한다 (한쪽만 막으면 저장을 눌러야 알게 된다)
//   2) 팀이 권한으로 새어 나가지 않는다 — authz·규칙은 팀을 모른다
//
// 2번이 왜 중요한가: 팀을 권한 축으로 올리면 투영본(authz)·firestore.rules·
// storage.rules·계약 게이트를 전부 다시 맞춰야 하고, 투영본이 어긋나는 순간
// 결재가 조용히 막힌다. 그 고장을 이미 한 번 겪었다(담당 팀장인데 보고서가
// 안 보이던 건). 그래서 "안 하기로 한 것"도 테스트로 박아 둔다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  normalizeTeams, teamMismatch, membersOfTeam, deriveTeamsFromUsers, validateTeams,
} from '../public/domain/teams.js';

const require = createRequire(import.meta.url);
const server = require('../functions/teams.cjs');
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const USERS = [
  { userId: 'kim', name: '김담당', role: '담당자', team: '1팀' },
  { userId: 'park', name: '박입력', role: '입력자', team: '1팀' },
  { userId: 'lee', name: '이담당', role: '담당자', team: '2팀' },
  { userId: 'choi', name: '최팀장', role: '팀장', team: '2팀' },
  { userId: 'free', name: '무소속', role: '담당자', team: '' },
];

// ─────────────────────────────────────────────────────────
// 목록
// ─────────────────────────────────────────────────────────

test('이름이 곧 신분이다 — 빈 이름·중복은 목록에 없다', () => {
  const list = normalizeTeams({ teams: [
    { name: '2팀' }, { name: '1팀', leaderUid: 'choi' }, { name: '' }, { name: '1팀' },
  ] });
  assert.deepEqual(list.map(t => t.name), ['1팀', '2팀']);
  assert.equal(list[0].leaderUid, 'choi');
  assert.equal(list[0].active, true);       // active 를 안 적으면 사용 중
});

test('저장 전 검증이 빈 이름과 중복을 말로 알려 준다', () => {
  assert.deepEqual(validateTeams([{ name: '1팀' }, { name: '2팀' }]), []);
  assert.equal(validateTeams([{ name: '' }]).length, 1);
  assert.equal(validateTeams([{ name: '1팀' }, { name: '1팀' }]).length, 1);
});

test('마이그레이션 — 직원이 적어 둔 이름에서 목록을 만든다', () => {
  const teams = deriveTeamsFromUsers(USERS);
  assert.deepEqual(teams.map(t => t.name), ['1팀', '2팀']);
  // 그 팀에 팀장이 한 명뿐이면 팀장으로 넣어 준다.
  assert.equal(teams.find(t => t.name === '2팀').leaderUid, 'choi');
  // 팀장이 없으면 비워 둔다 — 아무나 넣으면 결재 라인이 조용히 생긴다.
  assert.equal(teams.find(t => t.name === '1팀').leaderUid, '');
});

test('마이그레이션은 이미 있는 팀의 팀장 지정을 덮어쓰지 않는다', () => {
  const existing = [{ name: '2팀', leaderUid: 'somebody', active: false }];
  const teams = deriveTeamsFromUsers(USERS, existing);
  const t2 = teams.find(t => t.name === '2팀');
  assert.equal(t2.leaderUid, 'somebody');
  assert.equal(t2.active, false);
});

test('팀장이 둘이면 고르지 않는다', () => {
  const users = [...USERS, { userId: 'ko', name: '고팀장', role: '팀장', team: '2팀' }];
  assert.equal(deriveTeamsFromUsers(users).find(t => t.name === '2팀').leaderUid, '');
});

test('팀이 비어 있으면 후보는 전원이다 — 제약이 없다는 뜻', () => {
  assert.equal(membersOfTeam(USERS, '').length, USERS.length);
  assert.deepEqual(membersOfTeam(USERS, '1팀').map(u => u.userId), ['kim', 'park']);
});

// ─────────────────────────────────────────────────────────
// 화면과 서버가 같은 판정을 하는가
// ─────────────────────────────────────────────────────────

const CASES = [
  { name: '팀이 없으면 아무것도 막지 않는다', team: '', memberUids: ['kim', 'lee'], expect: [] },
  { name: '같은 팀이면 통과', team: '1팀', memberUids: ['kim', 'park'], expect: [] },
  { name: '다른 팀은 걸린다', team: '1팀', memberUids: ['kim', 'lee'], expect: ['lee'] },
  { name: '팀 없는 직원도 걸린다', team: '1팀', memberUids: ['free'], expect: ['free'] },
  { name: '없는 계정은 걸린다', team: '1팀', memberUids: ['ghost'], expect: ['ghost'] },
  { name: '빈 값은 무시한다', team: '1팀', memberUids: ['kim', '', null], expect: [] },
  { name: '중복은 한 번만 센다', team: '1팀', memberUids: ['lee', 'lee'], expect: ['lee'] },
];

test('배정이 팀과 맞는지 — 화면과 서버가 같은 답을 낸다', () => {
  for (const c of CASES) {
    const args = { team: c.team, memberUids: c.memberUids, users: USERS };
    assert.deepEqual(teamMismatch(args), c.expect, `브라우저: ${c.name}`);
    assert.deepEqual(server.teamMismatch(args), c.expect, `서버: ${c.name}`);
  }
});

test('목록 정규화도 서버와 같다', () => {
  const raw = { teams: [{ name: '2팀' }, { name: '1팀', leaderUid: 'choi', active: false }, { name: '1팀' }] };
  assert.deepEqual(server.normalizeTeams(raw), normalizeTeams(raw));
});

// ─────────────────────────────────────────────────────────
// 집행 — 좁히는 것과 막는 것은 다르다
// ─────────────────────────────────────────────────────────

test('서버가 팀 밖 배정을 거절한다', () => {
  // 화면이 후보를 좁혀도 콜러블은 직접 부를 수 있다.
  const src = read('functions/client-fns.js');
  assert.match(src, /teamMismatch/, 'saveClient 가 팀 검증을 하지 않습니다');
  assert.match(src, /failed-precondition[\s\S]{0,120}소속이 아닌 담당/);
  // 팀이 비어 있으면 통과해야 한다 — 기존 입주자 전부가 그 상태다.
  assert.match(src, /if \(nextTeam\) \{/);
});

test('팀 목록이 없으면 직원 저장이 막히지 않는다', () => {
  // 배포 직후 config/teams 는 없다. 그때 팀을 막으면 계정 운영이 통째로 멈춘다.
  const src = read('functions/staff-fns.js');
  assert.match(src, /teamNames\.size && !teamNames\.has\(team\)/);
});

// ─────────────────────────────────────────────────────────
// 팀은 권한이 아니다 (이 파일의 핵심)
// ─────────────────────────────────────────────────────────

test('규칙과 투영본은 팀을 모른다', () => {
  // 팀이 조회 범위를 정하기 시작하면 authz·rules·storage·계약 게이트가 전부
  // 얽힌다. 배정(userIds·teamLeader)의 투영본만이 범위를 정한다.
  for (const rel of ['firestore.rules', 'storage.rules', 'functions/authz.cjs']) {
    const src = read(rel);
    assert.doesNotMatch(src, /\bteams\b/,
      `${rel} 가 팀을 읽습니다 — 팀은 권한의 축이 아닙니다(domain/teams.js 머리말).`);
  }
});

test('팀 저장은 배정 권한과 같은 자리에 있다', () => {
  // 새 권한 키를 만들면 규칙·카탈로그·계약 게이트까지 함께 손대야 하는데,
  // 여기서 여는 것은 담당 배정이 이미 하던 일의 모양뿐이다.
  const src = read('functions/team-fns.js');
  assert.match(src, /fixedCan\(d, 'assignments\.manage'\)/);
  assert.match(read('public/modules/settings-teams.js'), /can\('assignments\.manage'\)/);
});

// ─────────────────────────────────────────────────────────
// 화면 — 좁히면서 잃지 않는가
// ─────────────────────────────────────────────────────────

test('팀으로 좁혀도 이미 고른 사람은 목록에 남는다', () => {
  // 체크된 줄이 사라지면 저장할 때 그 배정이 조용히 지워진다(저장은 "체크된 것
  // 전부"를 보낸다). 검색과 팀을 **한 곳에서** 판정하는 이유도 같다.
  const src = read('public/modules/staff-picker.js');
  assert.match(src, /const picked = row\.querySelector\('input'\)\?\.checked;/);
  assert.match(src, /const keep = picked \|\|/);
  assert.equal((src.match(/row\.style\.display = keep/g) || []).length, 1,
    '보이기 판정이 두 곳에 있으면 나중에 부른 쪽이 앞의 좁힘을 지웁니다');
});

test('목록에 없는 팀 값도 선택지로 남는다', () => {
  // 자유 입력 시절의 값이 select 에 없으면 첫 항목으로 떨어져, 이름만 고치고
  // 저장해도 그 사람의 팀이 조용히 바뀐다.
  assert.match(read('public/modules/staff-picker.js'), /\(목록에 없음\)/);
});
