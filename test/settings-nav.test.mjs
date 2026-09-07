// test/settings-nav.test.mjs
//
// 설정 화면의 정보구조가 HTML·권한 정의와 어긋나지 않는지 검증한다.
//
// 왜 필요한가
//   탭 목록을 데이터로 옮긴 목적은 "한 곳만 고치면 된다"였다. 그런데 배열과
//   실제 패널 div, 그리고 권한 키 정의는 여전히 서로 다른 파일에 있다.
//   셋 중 하나만 어긋나면 **탭을 눌렀는데 빈 화면**이 나오거나
//   **아무에게도 안 보이는 탭**이 생긴다. 그 상태는 화면을 열어봐야만 드러난다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SETTINGS_TABS, SETTINGS_GROUPS, SETTINGS_TAB_BY_KEY, isKnownSettingsTab,
} from '../public/modules/settings-nav.js';
import { DEFAULT_MIN_RANK, PERM_SECTIONS } from '../public/modules/permissions.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('모든 탭에 대응하는 패널 div가 index.html에 있다', () => {
  const missing = SETTINGS_TABS
    .filter(t => !html.includes(`id="${t.key}-tab-content"`))
    .map(t => t.key);
  assert.deepEqual(
    missing, [],
    '탭은 정의됐지만 패널이 없습니다 — 누르면 빈 화면이 됩니다:\n  ' + missing.join('\n  '),
  );
});

test('패널 div가 있는데 탭 정의가 없는 것은 없다 — 아무도 열 수 없는 화면', () => {
  const panels = [...html.matchAll(/id="([a-z-]+)-tab-content"/g)].map(m => m[1]);
  assert.ok(panels.length > 0, '패널을 찾지 못했습니다(선택자 변경?)');
  const orphan = panels.filter(p => !isKnownSettingsTab(p));
  assert.deepEqual(orphan, [], '열 수 있는 경로가 없는 패널:\n  ' + orphan.join('\n  '));
});

test('탭이 요구하는 권한 키는 모두 등급표에 있다', () => {
  // 등급표에 없는 키는 requiredRank가 null을 돌려주고 can()이 항상 false가 된다.
  // 그러면 그 탭은 관리자에게도 보이지 않는다 — 눈에 띄지 않는 고장이다.
  const missing = SETTINGS_TABS
    .filter(t => t.perm && !(t.perm in DEFAULT_MIN_RANK))
    .map(t => `${t.key} → ${t.perm}`);
  assert.deepEqual(
    missing, [],
    '등급표에 없는 권한 키를 요구하는 탭 (아무에게도 안 보입니다):\n  ' + missing.join('\n  '),
  );
});

test('탭이 쓰는 권한 키는 권한 설정 화면에도 노출된다', () => {
  // 관리자가 조정할 수 없는 숨은 게이트를 만들지 않는다.
  const shown = new Set(PERM_SECTIONS.flatMap(s => Object.keys(s.keys)));
  const hidden = SETTINGS_TABS
    .filter(t => t.perm && !shown.has(t.perm))
    .map(t => `${t.key} → ${t.perm}`);
  assert.deepEqual(
    hidden, [],
    '권한 설정 화면에서 조정할 수 없는 키:\n  ' + hidden.join('\n  '),
  );
});

test('그룹은 모든 탭을 정확히 한 번씩 담는다', () => {
  const grouped = SETTINGS_GROUPS.flatMap(g => g.items);
  const defined = SETTINGS_TABS.map(t => t.key);

  const dup = grouped.filter((k, i) => grouped.indexOf(k) !== i);
  assert.deepEqual(dup, [], '두 그룹에 중복된 탭: ' + dup.join(', '));

  const ungrouped = defined.filter(k => !grouped.includes(k));
  assert.deepEqual(
    ungrouped, [],
    '어느 그룹에도 없어 레일에 나오지 않는 탭: ' + ungrouped.join(', '),
  );

  const unknown = grouped.filter(k => !isKnownSettingsTab(k));
  assert.deepEqual(unknown, [], '정의되지 않은 탭을 담은 그룹: ' + unknown.join(', '));
});

test('키가 중복되지 않는다', () => {
  const keys = SETTINGS_TABS.map(t => t.key);
  assert.equal(new Set(keys).size, keys.length, '탭 key가 중복됩니다');
});

test('모든 탭에 라벨·아이콘·설명이 있다', () => {
  for (const t of SETTINGS_TABS) {
    assert.ok(t.label && t.label.trim(), `${t.key}: label 없음`);
    assert.ok(t.icon && t.icon.trim(), `${t.key}: icon 없음`);
    // 설명은 "이 화면이 무엇을 하는 곳인지"를 말한다. 비면 사용자가 추측해야 한다.
    assert.ok(t.desc && t.desc.trim(), `${t.key}: desc 없음`);
  }
});

test('개요가 첫 탭이다 — 설정을 열면 무엇을 손봐야 하는지부터 보인다', () => {
  assert.equal(SETTINGS_TABS[0].key, 'overview');
  assert.equal(SETTINGS_GROUPS[0].items[0], 'overview');
  // 개요는 권한 제약이 없어야 한다(설정에 들어온 사람은 모두 볼 수 있게).
  assert.equal(SETTINGS_TAB_BY_KEY.overview.perm, undefined);
});

test('되돌릴 수 없는 작업은 관리자 전용이며 정상 업무와 다른 탭에 있다', () => {
  // 연도 마감(정상적인 연간 업무)과 전체 초기화가 같은 화면에 있으면
  // 실수로 누를 수 있다. 실제로 그런 배치였다.
  assert.equal(SETTINGS_TAB_BY_KEY.danger.perm, 'settings.reset');
  assert.notEqual(SETTINGS_TAB_BY_KEY.danger.key, SETTINGS_TAB_BY_KEY.archive.key);
  assert.ok(html.includes('id="danger-tab-content"'));
  // 초기화 버튼이 마감 탭에 남아 있지 않은지 확인한다.
  const archiveStart = html.indexOf('id="archive-tab-content"');
  const dangerStart = html.indexOf('id="danger-tab-content"');
  const resetBtn = html.indexOf('id="btn-firebase-reset"');
  assert.ok(resetBtn > -1, '초기화 버튼을 찾을 수 없습니다');
  assert.ok(
    Math.abs(resetBtn - dangerStart) < Math.abs(resetBtn - archiveStart),
    '초기화 버튼이 마감 탭 쪽에 있습니다',
  );
});

test('가로 탭 버튼 잔재가 남아 있지 않다', () => {
  // 종전 .settings-tab-btn 버튼이 남아 있으면 레일과 두 벌이 되어
  // 상태가 어긋난다(하나만 활성 표시가 바뀐다).
  assert.ok(
    !html.includes('class="settings-tab-btn'),
    'index.html에 옛 가로 탭 버튼이 남아 있습니다',
  );
});
