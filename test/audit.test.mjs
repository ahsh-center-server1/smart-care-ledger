// test/audit.test.mjs
//
// 변경 이력의 라벨·요약·보관 계산.
//
// 가장 중요한 것은 **라벨 없는 액션 코드가 없다**는 것이다. 코드를 새로 쓰면서
// ACTION_LABELS에 넣지 않으면 화면에 'trx.bulkDelete' 같은 문자열이 그대로
// 노출된다. 사용자에게 코드를 보여주는 화면은 없는 것보다 나쁘다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTION_LABELS, AUDIT_RETENTION_DAYS, AUDIT_RESOURCES,
  actionLabel, actionResource, isKnownAction,
  auditExpireAt, buildAuditEntry, pruneSummary, summaryText,
} from '../public/domain/audit.js';

const ROOT = new URL('..', import.meta.url).pathname;

test('라벨 표가 비어 있지 않고 모든 값이 한글 설명이다', () => {
  const keys = Object.keys(ACTION_LABELS);
  assert.ok(keys.length > 30, `액션 코드가 너무 적습니다 (${keys.length}개)`);
  for (const [k, v] of Object.entries(ACTION_LABELS)) {
    assert.ok(v && v.trim(), `${k}: 라벨이 비었습니다`);
    // 라벨이 코드와 같으면 라벨을 안 쓴 것이다.
    assert.notEqual(v, k, `${k}: 라벨이 코드와 같습니다`);
  }
});

test('액션 코드는 resource.verb 형식이다', () => {
  for (const k of Object.keys(ACTION_LABELS)) {
    assert.match(k, /^[a-zA-Z]+\.[a-zA-Z]+$/, `${k}: resource.verb 형식이 아닙니다`);
  }
});

test('코드에서 실제로 쓰는 액션은 모두 라벨이 있다', () => {
  // auditOp('x')·auditLog('x') 호출의 첫 인자를 소스에서 긁어 대조한다.
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'vendor' || name === 'icons') continue;
        walk(p);
      } else if (name.endsWith('.js')) files.push(p);
    }
  })(join(ROOT, 'public'));

  const used = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/audit(?:Op|Log)\(\s*'([^']+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 0, 'audit 호출을 찾지 못했습니다 (선택자 변경?)');

  const missing = [...used].filter(a => !isKnownAction(a));
  assert.deepEqual(
    missing, [],
    '코드에서 쓰는데 ACTION_LABELS에 없는 액션 (화면에 코드가 그대로 노출됩니다):\n  '
      + missing.join('\n  '),
  );
});

test('actionLabel — 모르는 코드도 화면을 깨뜨리지 않는다', () => {
  assert.equal(actionLabel('trx.create'), '거래 입력');
  assert.equal(actionLabel('없는.코드'), '없는.코드');
  assert.equal(actionLabel(''), '알 수 없는 작업');
  assert.equal(actionLabel(null), '알 수 없는 작업');
  assert.equal(actionLabel(undefined), '알 수 없는 작업');
});

test('actionResource — 접두어를 뽑는다', () => {
  assert.equal(actionResource('report.approveTeam'), 'report');
  assert.equal(actionResource('trx.create'), 'trx');
  assert.equal(actionResource(''), '');
  assert.equal(actionResource(null), '');
});

test('분류 필터 선택지는 라벨 표에서 파생되어 어긋날 수 없다', () => {
  const fromLabels = new Set(Object.keys(ACTION_LABELS).map(actionResource));
  const fromList = new Set(AUDIT_RESOURCES.map(r => r.key));
  assert.deepEqual([...fromList].sort(), [...fromLabels].sort());
  for (const r of AUDIT_RESOURCES) {
    assert.ok(r.label && r.label.trim(), `${r.key}: 분류 이름이 없습니다`);
  }
});

test('보관 만료는 2년 뒤다', () => {
  assert.equal(AUDIT_RETENTION_DAYS, 730);
  const now = Date.UTC(2026, 0, 1);
  const exp = auditExpireAt(now);
  assert.ok(exp instanceof Date);
  assert.equal(exp.getTime() - now, 730 * 24 * 60 * 60 * 1000);
  // Date로 넘겨도 같아야 한다
  assert.equal(auditExpireAt(new Date(now)).getTime(), exp.getTime());
});

test('기록 한 건 — 필수 필드가 채워진다', () => {
  const e = buildAuditEntry({
    action: 'trx.delete',
    actor: { userId: 'staff', name: '이담당', role: '담당자' },
    resourceId: 't-1',
    summary: { clientName: '홍길동', amount: 5000 },
    now: Date.UTC(2026, 0, 1),
  });
  assert.equal(e.action, 'trx.delete');
  assert.equal(e.actorUid, 'staff');       // 규칙이 토큰 uid와 대조한다
  assert.equal(e.actorName, '이담당');
  assert.equal(e.actorRole, '담당자');
  assert.equal(e.resourceId, 't-1');
  assert.deepEqual(e.summary, { clientName: '홍길동', amount: 5000 });
  assert.ok(e.expireAt instanceof Date);
  // timestamp는 서버 시각을 써야 하므로 여기서 넣지 않는다.
  assert.equal('timestamp' in e, false);
});

test('이름이 없으면 아이디로 대신한다', () => {
  const e = buildAuditEntry({ action: 'trx.create', actor: { userId: 'typist' } });
  assert.equal(e.actorName, 'typist');
  assert.equal(e.actorRole, '');
});

test('action이나 actor가 없으면 만들지 않는다 — 익명 기록을 남기지 않는다', () => {
  assert.throws(() => buildAuditEntry({ actor: { userId: 'a' } }), /action/);
  assert.throws(() => buildAuditEntry({ action: 'trx.create' }), /actor/);
  assert.throws(() => buildAuditEntry({ action: 'trx.create', actor: {} }), /actor/);
});

test('빈 요약은 필드를 만들지 않는다', () => {
  const e = buildAuditEntry({ action: 'trx.create', actor: { userId: 'a' }, summary: {} });
  assert.equal('summary' in e, false);
  const e2 = buildAuditEntry({ action: 'trx.create', actor: { userId: 'a' } });
  assert.equal('summary' in e2, false);
});

test('요약은 빈 값을 걷어내고 긴 문자열을 자른다', () => {
  // 기록에 거래 내용이나 의견 전문이 들어가면 문서가 커지고
  // 기록 자체가 개인정보 사본이 된다.
  const long = 'ㄱ'.repeat(300);
  const out = pruneSummary({ a: 1, b: '', c: null, d: undefined, e: long, f: 0, g: false });
  assert.equal(out.a, 1);
  assert.equal('b' in out, false);
  assert.equal('c' in out, false);
  assert.equal('d' in out, false);
  assert.equal(out.e.length, 121);            // 120자 + '…'
  assert.ok(out.e.endsWith('…'));
  assert.equal(out.f, 0);                      // 0은 유효한 값이다
  assert.equal(out.g, false);
});

test('요약 문장 — 키를 한글로 바꿔 보여준다', () => {
  assert.equal(
    summaryText({ clientName: '홍길동', amount: 12000 }),
    '입주자 홍길동 · 금액 12,000',
  );
  assert.equal(summaryText({}), '');
  assert.equal(summaryText(null), '');
  assert.equal(summaryText({ ok: true }), 'ok 예');
});

// ─────────────────────────────────────────────────────────────
// 결재 전이 ↔ 이력 액션 코드
//
// 모든 결재 동작이 applyReportTransition 하나를 통과하므로 이력도 그 한 곳에서
// 남는다. 그런데 전이표에 동작을 추가하고 매핑을 빼먹으면 그 동작이
// **'report.save'로 잘못 기록된다** — 이력이 있으나 틀린 상태가 되고,
// 그것은 이력이 없는 것보다 나쁘다.
// ─────────────────────────────────────────────────────────────
test('전이표의 모든 동작에 이력 액션 코드가 매핑돼 있다', async () => {
  const { TRANSITIONS } = await import('../public/domain/report-workflow.js');
  const { TRANSITION_AUDIT } = await import('../public/modules/report.js');

  const actions = new Set();
  for (const byAction of Object.values(TRANSITIONS)) {
    for (const a of Object.keys(byAction)) actions.add(a);
  }
  assert.ok(actions.size >= 8, `전이 동작이 너무 적습니다 (${actions.size}개)`);

  const missing = [...actions].filter(a => !(a in TRANSITION_AUDIT));
  assert.deepEqual(
    missing, [],
    "전이표에 있지만 이력 매핑이 없는 동작 (report.save로 잘못 기록됩니다):\n  "
      + missing.join('\n  '),
  );
});

test('매핑된 이력 액션 코드는 모두 라벨이 있다', async () => {
  const { TRANSITION_AUDIT } = await import('../public/modules/report.js');
  for (const [action, code] of Object.entries(TRANSITION_AUDIT)) {
    assert.ok(isKnownAction(code), `${action} → ${code}: 라벨이 없습니다`);
    assert.equal(actionResource(code), 'report', `${action} → ${code}: report.* 가 아닙니다`);
  }
});
