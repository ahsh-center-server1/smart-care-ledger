import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/state.js';
import {
  can, myRank, roleCan, requiredRank,
  ROLE_RANK, ROLES, ADMIN_RANK, DEFAULT_MIN_RANK, SELECTABLE_RANKS, PERM_SECTIONS,
} from '../public/modules/permissions.js';
import { PERM_CATALOG, PERM_KEYS, SERVER_ENFORCED_KEYS, capName } from '../public/domain/perm-catalog.js';

const as = (role, isAdmin = false) => { S.user = { userId: 'u', role, isAdmin }; };

test.afterEach(() => { S.user = null; S.permOverride = null; });

// ─────────────────────────────────────────────
// 서열
// ─────────────────────────────────────────────
test('등급은 입력자 < 담당자 < 팀장 < 센터장 순이다', () => {
  assert.deepEqual(ROLES, ['입력자', '담당자', '팀장', '센터장']);
  assert.ok(ROLE_RANK.입력자 < ROLE_RANK.담당자);
  assert.ok(ROLE_RANK.담당자 < ROLE_RANK.팀장);
  assert.ok(ROLE_RANK.팀장 < ROLE_RANK.센터장);
  assert.ok(ROLE_RANK.센터장 < ADMIN_RANK);
});

test('관리자는 역할과 무관한 플래그다', () => {
  as('입력자', true);
  assert.equal(myRank(), ADMIN_RANK);
  assert.equal(can('settings.reset'), true, '관리자 전용 키를 못 씁니다');
  assert.equal(can('report.approve.center'), true);
});

test('로그인하지 않으면 아무 권한도 없다', () => {
  S.user = null;
  assert.equal(myRank(), 0);
  for (const key of Object.keys(DEFAULT_MIN_RANK)) {
    assert.equal(can(key), false, `비로그인 상태에서 ${key}가 열려 있습니다`);
  }
});

test('알 수 없는 역할은 아무 권한도 없다 (fail-closed)', () => {
  as('원장');   // 등급표에 없는 역할
  assert.equal(myRank(), 0);
  assert.equal(can('trx.create'), false);
});

test('알 수 없는 키는 거부한다 (fail-closed)', () => {
  as('센터장');
  assert.equal(can('trx.nonexistent'), false);
  assert.equal(can(''), false);
  assert.equal(can(undefined), false);
  assert.equal(requiredRank('trx.nonexistent'), null);
});

// ─────────────────────────────────────────────
// 단조성 — 이 모델의 전제
// ─────────────────────────────────────────────
test('모든 권한이 등급에 단조증가한다 (상위가 하위 권한을 모두 포함)', () => {
  for (const key of Object.keys(DEFAULT_MIN_RANK)) {
    for (let i = 1; i < ROLES.length; i++) {
      const lower = ROLES[i - 1], higher = ROLES[i];
      if (roleCan(lower, key)) {
        assert.ok(roleCan(higher, key),
          `${key}: ${lower}는 되는데 ${higher}는 안 됩니다 — 서열이 깨졌습니다`);
      }
    }
  }
});

// ─────────────────────────────────────────────
// 역할별 기대 동작
// ─────────────────────────────────────────────
test('입력자 — 거래 입력·수정·삭제만 되고 나머지는 막힌다', () => {
  as('입력자');
  assert.equal(can('trx.create'), true);
  assert.equal(can('trx.edit'), true);
  assert.equal(can('trx.delete'), true);

  for (const key of ['trx.view.all', 'nav.report', 'nav.settings', 'excel.upload',
                     'receipt.print', 'bankbook.upload', 'trx.csv', 'trx.delete.bulk',
                     'trx.transfer', 'report.submit', 'settings.client']) {
    assert.equal(can(key), false, `입력자가 ${key}를 쓸 수 있습니다`);
  }
});

test('담당자 — 실무는 되지만 결재·직원관리는 막힌다', () => {
  as('담당자');
  assert.equal(can('trx.view.all'), true);
  assert.equal(can('excel.upload'), true);
  assert.equal(can('report.submit'), true);
  assert.equal(can('settings.category'), true);

  assert.equal(can('report.approve.team'), false);
  assert.equal(can('settings.client'), false);
  assert.equal(can('settings.staff'), false);
  assert.equal(can('settings.category.common'), false, '담당자가 공통 카테고리를 지울 수 있습니다');
  assert.equal(can('client.view.all'), false);
});

test('팀장 — 1차 결재와 입주자·계좌 관리는 되지만 최종 결재·마감은 막힌다', () => {
  as('팀장');
  assert.equal(can('report.approve.team'), true);
  assert.equal(can('report.reject'), true);
  assert.equal(can('settings.client'), true);
  assert.equal(can('settings.category.common'), true);

  assert.equal(can('report.approve.center'), false);
  assert.equal(can('settings.archive'), false);
  assert.equal(can('settings.reset'), false);
  assert.equal(can('settings.permissions'), false);
});

test('센터장 — 최종 결재·마감은 되지만 초기화·권한설정은 관리자만', () => {
  as('센터장');
  assert.equal(can('report.approve.center'), true);
  assert.equal(can('report.revert'), true);
  assert.equal(can('settings.archive'), true);

  assert.equal(can('settings.reset'), false);
  assert.equal(can('settings.permissions'), false);
  assert.equal(can('lock.bypass'), false);
});

test('관리자 전용 키는 센터장도 못 쓴다', () => {
  const adminOnly = Object.entries(DEFAULT_MIN_RANK)
    .filter(([, r]) => r === ADMIN_RANK).map(([k]) => k);
  assert.ok(adminOnly.length >= 3, '관리자 전용 키가 너무 적습니다');
  as('센터장');
  for (const key of adminOnly) {
    assert.equal(can(key), false, `센터장이 관리자 전용 키 ${key}를 씁니다`);
  }
});

// ─────────────────────────────────────────────
// 오버라이드
// ─────────────────────────────────────────────
test('오버라이드로 기능을 잠글 수 있다', () => {
  as('담당자');
  assert.equal(can('trx.csv'), true);
  S.permOverride = { 'trx.csv': ROLE_RANK.팀장 };
  assert.equal(can('trx.csv'), false, '오버라이드가 반영되지 않습니다');
  as('팀장');
  assert.equal(can('trx.csv'), true);
});

test('보안 하한이 걸린 권한은 오버라이드가 통하지 않는다', () => {
  // 카탈로그가 configurable:false 로 표시한 키다. 예전에는 설정 화면에
  // 똑같이 드롭다운이 보이고 저장까지 됐지만, 이제 서버가 거절하고
  // 판정도 기본 등급을 쓴다 — 조용히 무시하지 않는다.
  const locked = PERM_KEYS.filter(k => !PERM_CATALOG[k].configurable);
  assert.ok(locked.length >= 10, `보안 하한 키가 너무 적습니다 (${locked.length})`);

  as('입력자');
  for (const key of locked) {
    S.permOverride = { [key]: 1 };   // 입력자까지 낮춰 본다
    assert.equal(
      can(key), PERM_CATALOG[key].defaultRank <= 1,
      `${key}: 오버라이드로 보안 하한을 뚫었습니다`,
    );
  }
  S.permOverride = {};
});

test('오버라이드로 기능을 열 수도 있다', () => {
  as('입력자');
  assert.equal(can('trx.csv'), false);
  S.permOverride = { 'trx.csv': ROLE_RANK.입력자 };
  assert.equal(can('trx.csv'), true);
});

test('잘못된 오버라이드 값은 무시하고 기본값을 쓴다', () => {
  as('담당자');
  for (const bad of [0, -1, 7, 'abc', null, undefined, {}]) {
    S.permOverride = { 'trx.csv': bad };
    assert.equal(can('trx.csv'), true,
      `잘못된 값 ${JSON.stringify(bad)}에서 기본값으로 복귀하지 않습니다`);
  }
});

test('등급표에 없는 키는 오버라이드해도 열리지 않는다', () => {
  as('센터장');
  S.permOverride = { 'trx.nonexistent': 1 };
  assert.equal(can('trx.nonexistent'), false);
});

test('관리자 플래그는 오버라이드보다 우선한다', () => {
  as('입력자', true);
  S.permOverride = { 'trx.create': ADMIN_RANK };
  assert.equal(can('trx.create'), true);
});

// ─────────────────────────────────────────────
// 설정 화면과의 정합성
// ─────────────────────────────────────────────
test('권한 화면에 모든 키가 빠짐없이 나온다', () => {
  // 화면에 없는 키는 관리자가 조정할 수 없다 — 조용히 고정되어 버린다
  const shown = new Set(PERM_SECTIONS.flatMap(sec => Object.keys(sec.keys)));
  for (const key of Object.keys(DEFAULT_MIN_RANK)) {
    assert.ok(shown.has(key), `${key}가 권한 설정 화면에 없습니다`);
  }
});

test('권한 화면에 등급표에 없는 유령 키가 없다', () => {
  // 예전에는 32키 중 15개가 코드에서 읽히지 않는데도 스위치로 표시됐다.
  // 켜고 꺼도 아무 일이 없는 그 상태를 다시 만들지 않는다.
  for (const sec of PERM_SECTIONS) {
    for (const key of Object.keys(sec.keys)) {
      assert.ok(key in DEFAULT_MIN_RANK, `${key}가 화면에는 있는데 등급표에 없습니다`);
    }
  }
});

test('모든 기본 등급이 선택 가능한 값이다', () => {
  for (const [key, rank] of Object.entries(DEFAULT_MIN_RANK)) {
    assert.ok(SELECTABLE_RANKS.includes(rank),
      `${key}의 기본 등급 ${rank}은 설정 화면에서 선택할 수 없는 값입니다`);
  }
});

test('코드에서 호출하는 모든 can() 키가 등급표에 등록되어 있다', async () => {
  // 미등록 키는 fail-closed로 조용히 false가 되어 기능이 사라진다
  const { readFileSync, readdirSync } = await import('node:fs');
  const dirs = ['../public/modules', '../public/services', '../public'];
  const used = new Set();
  for (const d of dirs) {
    const base = new URL(d + '/', import.meta.url);
    for (const f of readdirSync(base)) {
      if (!f.endsWith('.js')) continue;
      const src = readFileSync(new URL(f, base), 'utf8');
      for (const m of src.matchAll(/\bcan\('([a-z][a-z.]*)'\)/g)) used.add(m[1]);
    }
  }
  assert.ok(used.size > 10, `can() 호출을 찾지 못했습니다 (${used.size}건)`);
  for (const key of used) {
    assert.ok(key in DEFAULT_MIN_RANK, `코드가 쓰는 '${key}'가 등급표에 없습니다`);
  }
});

// ─────────────────────────────────────────────
// caps — 화면과 집행의 근거를 하나로
//
// 신고된 버그의 반대쪽 얼굴: 등급을 올리면 버튼은 숨는데 서버는 여전히
// 허용했다. 이제 can() 은 서버가 집행하는 키에 대해 규칙이 읽는 것과
// **같은 문서**(authz/{uid}.caps)를 본다. 두 판단이 갈라질 자리가 없다.
// ─────────────────────────────────────────────

test('caps 가 있으면 서버 집행 키는 caps 로 판정한다', () => {
  as('센터장');
  const key = 'trx.reorder';
  assert.ok(SERVER_ENFORCED_KEYS.includes(key), '전제가 깨졌습니다 — 서버 집행 키가 아닙니다');
  assert.equal(can(key), true);

  // 등급으로는 통과하지만 caps 가 막으면 막힌다
  S.caps = { [capName(key)]: false };
  assert.equal(can(key), false, 'caps 를 보지 않고 등급으로 판정했습니다');

  S.caps = { [capName(key)]: true };
  assert.equal(can(key), true);
  S.caps = null;
});

test('caps 에 없는 키는 거부한다 (fail-closed)', () => {
  as('센터장');
  S.caps = {};   // 백필은 됐지만 이 키가 빠졌다
  assert.equal(can('trx.reorder'), false);
  S.caps = null;
});

test('UI 전용 키는 caps 가 있어도 등급으로 판정한다', () => {
  // caps 는 서버가 집행하는 키만 담는다. UI 전용 키까지 caps 로 판정하면
  // 백필된 사용자에게 그 기능이 통째로 사라진다.
  const uiOnly = PERM_KEYS.filter(k => !SERVER_ENFORCED_KEYS.includes(k));
  assert.ok(uiOnly.length > 0, 'UI 전용 키가 없습니다 — 전제가 깨졌습니다');

  as('센터장');
  S.caps = {};
  for (const key of uiOnly) {
    assert.equal(can(key), myRank() >= requiredRank(key), `${key}: caps 로 판정했습니다`);
  }
  S.caps = null;
});

test('caps 가 없으면 등급 계산으로 물러선다 (백필 전)', () => {
  as('담당자');
  S.caps = null;
  assert.equal(can('trx.reorder'), true);
  S.permOverride = { 'trx.reorder': ROLE_RANK.팀장 };
  assert.equal(can('trx.reorder'), false);
  S.permOverride = {};
});
