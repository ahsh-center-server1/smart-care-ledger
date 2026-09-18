// test/client-picker.test.mjs
//
// 입주자 찾기 — 이름만으로는 못 고른다.
//
// 동명이인이 있고, 센터장 화면에는 전 입주자가 올라온다. 줄마다 팀과 담당
// 직원이 함께 보여야 고르는 사람이 확신할 수 있다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientFacets, clientSubtitle, clientMatches } from '../public/modules/client-picker.js';

const USERS = [
  { id: 'u1', userId: 'hong', name: '홍길동' },
  { id: 'u2', userId: 'kim', name: '김담당' },
];
const CLIENT = { id: 'c1', name: '박입주', team: '1팀', userIds: 'hong, kim' };

test('팀과 담당 직원을 뽑는다', () => {
  const f = clientFacets(CLIENT, USERS);
  assert.equal(f.team, '1팀');
  assert.deepEqual(f.staff, ['홍길동', '김담당']);
});

test('명부에 없는 담당 아이디도 그대로 보여 준다', () => {
  // 퇴직자나 마이그레이션 전 데이터. 빈칸으로 두면 "담당 없음"으로 읽힌다.
  const f = clientFacets({ ...CLIENT, userIds: 'ghost' }, USERS);
  assert.deepEqual(f.staff, ['ghost']);
});

test('부연은 팀 · 담당자 — 없는 것은 적지 않는다', () => {
  assert.equal(clientSubtitle(CLIENT, USERS), '1팀 · 홍길동, 김담당');
  assert.equal(clientSubtitle({ name: 'x' }, USERS), '');
  assert.equal(clientSubtitle({ name: 'x', team: '2팀' }, USERS), '2팀');
});

test('이름·팀·담당자 중 하나라도 맞으면 걸린다 (초성 포함)', () => {
  assert.equal(clientMatches(CLIENT, USERS, '박입주'), true);
  assert.equal(clientMatches(CLIENT, USERS, '1팀'), true);
  assert.equal(clientMatches(CLIENT, USERS, '홍길동'), true);
  assert.equal(clientMatches(CLIENT, USERS, 'ㅎㄱㄷ'), true, '담당자 초성으로도 찾아야 합니다');
  assert.equal(clientMatches(CLIENT, USERS, 'ㅂㅇㅈ'), true, '입주자 초성으로도 찾아야 합니다');
  assert.equal(clientMatches(CLIENT, USERS, '없는사람'), false);
});

test('빈 검색어는 전부 통과', () => {
  assert.equal(clientMatches(CLIENT, USERS, ''), true);
});

test('범위를 여기서 다시 거르지 않는다 — S.clients 를 그대로 쓴다', () => {
  // 담당 범위는 core.js 의 myScope() 가 authz 로 정한다. 여기서 또 거르면
  // 근거가 두 벌이 되고, 어긋나는 순간 "보이는데 열면 거부당하는 입주자"가 생긴다.
  const src = readFileSync(new URL('../public/modules/client-picker.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.ok(!/accessibleClientIds|leaderClientIds|myScope|allClients/.test(code),
    '피커가 담당 범위를 스스로 판정합니다');
  assert.match(code, /S\.clients/, 'S.clients 를 쓰지 않습니다');
});
