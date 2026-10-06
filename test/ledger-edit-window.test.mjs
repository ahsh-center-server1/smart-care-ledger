// test/ledger-edit-window.test.mjs
//
// 「본인이 결재한 뒤에는 회수하기 전까지 못 고친다」 — 경계는 역할마다 다르다.
//
// 이 규칙이 없던 시절의 고장: 담당자가 제출한 뒤에도 자기 거래를 고칠 수 있었고,
// 팀장이 결재한 숫자가 그 뒤에 조용히 달라졌다. 결재는 "그 시점의 숫자를 봤다"는
// 서명인데, 서명이 가리키는 대상이 사라진다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EDIT_BLOCKED_FROM, ledgerEditBlockedBy, ledgerEditBlockMessage,
} from '../public/domain/ledger-edit-window.js';

const OPEN = { submitted: false, teamApproved: false, confirmed: false };
const SUBMITTED = { submitted: true, teamApproved: false, confirmed: false };
const TEAM = { submitted: true, teamApproved: true, confirmed: false };
const CONFIRMED = { submitted: true, teamApproved: true, confirmed: true };

test('아무도 결재하지 않은 달은 누구나 고친다', () => {
  for (const role of ['입력자', '담당자', '팀장', '센터장']) {
    assert.equal(ledgerEditBlockedBy(role, OPEN), null, `${role}이 막혔습니다`);
  }
});

test('담당자·입력자는 제출하는 순간 닫힌다', () => {
  for (const role of ['입력자', '담당자']) {
    assert.equal(ledgerEditBlockedBy(role, SUBMITTED), 'submitted');
  }
});

test('팀장은 제출된 달을 고칠 수 있고, 자기 결재 뒤에 닫힌다', () => {
  // 이것이 이 기능의 요점이다 — 오타 하나에 반려하고 담당자를 기다렸다가
  // 다시 결재하는 왕복을 없앤다.
  assert.equal(ledgerEditBlockedBy('팀장', SUBMITTED), null);
  assert.equal(ledgerEditBlockedBy('팀장', TEAM), 'team_approved');
});

test('센터장은 팀장 결재까지 고칠 수 있고, 최종 결재 뒤에 닫힌다', () => {
  assert.equal(ledgerEditBlockedBy('센터장', SUBMITTED), null);
  assert.equal(ledgerEditBlockedBy('센터장', TEAM), null);
  assert.equal(ledgerEditBlockedBy('센터장', CONFIRMED), 'confirmed');
});

test('마감은 역할과 무관하다 — 센터장도 못 고친다', () => {
  for (const role of ['입력자', '담당자', '팀장', '센터장']) {
    assert.equal(ledgerEditBlockedBy(role, CONFIRMED), 'confirmed', `${role}에게 마감이 안 걸립니다`);
  }
});

test('모르는 역할은 가장 좁게 본다 (fail-closed)', () => {
  // 권한 정보가 아직 안 온 화면에서 잠깐 전부 열리면 안 된다.
  for (const role of ['', null, undefined, '관리자', '알수없음']) {
    assert.equal(ledgerEditBlockedBy(role, SUBMITTED), 'submitted');
  }
});

test('문구는 어떻게 푸는지까지 말한다', () => {
  for (const key of ['submitted', 'team_approved', 'confirmed']) {
    const msg = ledgerEditBlockMessage(key);
    assert.ok(msg.length > 0, `${key} 문구가 없습니다`);
    assert.match(msg, /회수|취소/, `${key}: 푸는 방법이 문구에 없습니다`);
  }
  assert.equal(ledgerEditBlockMessage(null), '');
});

test('규칙의 editableStage 가 같은 표를 쓴다', () => {
  // 화면과 규칙의 근거가 갈라지면 버튼은 보이는데 서버가 거부한다.
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const fn = rules.slice(rules.indexOf('function editableStage('));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /'센터장'\s*\?\s*true/, '센터장이 최종 결재 전까지 열려 있지 않습니다');
  assert.match(body, /'팀장'\s*\?\s*!isApprovedMonth/, '팀장 경계가 팀장 결재가 아닙니다');
  assert.match(body, /!isSubmittedMonth/, '담당자 경계가 제출이 아닙니다');
  // 역할 목록도 어긋나면 안 된다.
  assert.deepEqual(Object.keys(EDIT_BLOCKED_FROM).sort(),
    ['담당자', '센터장', '입력자', '팀장'].sort());
});
