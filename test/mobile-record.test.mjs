// test/mobile-record.test.mjs
//
// 휴대폰 화면을 줄이면서 **길을 잃지 않았는지** 확인한다.
//
// 이 개편의 위험은 보기 흉한 화면이 아니라 조용한 실종이다. 하단 네비를 네 칸에서
// 세 칸으로 줄이고 대시보드 퀵 액션 일곱 개를 감췄으므로, 그중 하나라도 다른 길이
// 없으면 그 일은 **휴대폰에서 아예 못 하게 된다.** 화면은 멀쩡해 보이고 아무도
// 오류를 보지 못하므로, 현장에서 "예전엔 됐는데" 라는 말이 나오기 전까지 모른다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { S } from '../public/state.js';
import {
  RECORD_ACTIONS, availableRecordActions, applyCaptureMode,
} from '../public/modules/mobile-record.js';
import { ICON_NAMES, iconSvg, hydrateIcons } from '../public/utils/icons.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const html = read('public/index.html');
const coreSrc = read('public/modules/core.js');
const recordSrc = read('public/modules/mobile-record.js');

/** 역할 하나로 가장해 시트 목록을 본다. */
function asRole(role, fn) {
  const keys = ['user', 'authz', 'authzStatus'];
  const saved = Object.fromEntries(keys.map(k => [k, S[k]]));
  try {
    S.user = { userId: 'u1', role };
    S.authz = { uid: 'u1', role, enabled: true };
    S.authzStatus = 'ready';
    return fn();
  } finally { Object.assign(S, saved); }
}

const labels = (role) => asRole(role, () => availableRecordActions().map(a => a.label));

// ─────────────────────────────────────────────────────────
// 네비 구조
// ─────────────────────────────────────────────────────────

test('하단 네비는 세 자리다 — 담당 · ＋ 기록 · 내역', () => {
  const items = [...html.matchAll(/<button[^>]*class="mobile-nav-item[^"]*"[^>]*data-view="([^"]+)"/g)]
    .map(m => m[1]);
  assert.deepEqual(items, ['dashboard', 'history'],
    '하단 네비 칸이 바뀌었습니다. 가운데 자리는 ＋ 기록이고, 양옆은 담당·내역 둘뿐입니다.');
  assert.match(html, /id="btn-record"[^>]*class="record-fab"/,
    '＋ 기록 버튼이 없습니다 — 휴대폰에서 가장 자주 하는 일이 네비에서 사라집니다.');
});

// ─────────────────────────────────────────────────────────
// 감춘 것에 다른 길이 있는가 (이 파일의 핵심)
// ─────────────────────────────────────────────────────────

test('휴대폰에서 감춘 퀵 액션은 전부 다른 길이 있다', () => {
  // 퀵 액션은 휴대폰에서 통째로 감춘다 — 그 전제가 지켜지는지부터.
  assert.match(html, /@media\(max-width:768px\)\{[^@]*?#dashboard-actions\{display:none!important;\}/,
    '퀵 액션을 감추는 규칙이 없습니다 — 이 검사의 전제가 바뀌었습니다.');

  const block = html.slice(html.indexOf('<div id="dashboard-actions">'),
    html.indexOf('<!-- 입주자 카드 -->'));
  assert.ok(block.length > 100, '퀵 액션 블록을 찾지 못했습니다');

  const targets = [...block.matchAll(/onclick="(openModal|changeView)\('([^']+)'\)"/g)]
    .map(m => `${m[1]}:${m[2]}`);
  assert.ok(targets.length >= 7, `퀵 액션을 다 읽지 못했습니다 (${targets.length}개)`);

  // 시트가 여는 것들 — run 함수의 소스에서 읽는다(목록과 실제 동작이 갈리지 않게).
  const sheetOpens = new Set();
  for (const a of RECORD_ACTIONS) {
    const src = String(a.run);
    for (const m of src.matchAll(/openModal\('([^']+)'\)/g)) sheetOpens.add(m[1]);
    if (src.includes('openReceiptIntake')) sheetOpens.add('receipt-intake');
  }
  // 네비·헤더가 가는 곳들
  const navViews = new Set([...html.matchAll(/class="mobile-nav-item[^"]*"[^>]*data-view="([^"]+)"/g)]
    .map(m => m[1]));
  if (/id="btn-mobile-settings"/.test(html)) navViews.add('settings');
  // 보고서는 좁은 화면에서 못 여는 것이 **의도**다. 그 근거가 코드에 있을 때만 봐준다.
  const desktopOnly = (coreSrc.match(/DESKTOP_ONLY_VIEWS\s*=\s*\{([^}]*)\}/) || [, ''])[1];

  const lost = targets.filter((t) => {
    const [kind, name] = t.split(':');
    if (kind === 'openModal') return !sheetOpens.has(name);
    return !navViews.has(name) && !desktopOnly.includes(name);
  });
  assert.deepEqual(lost, [],
    `휴대폰에서 갈 길이 없어진 기능이 있습니다: ${lost.join(', ')}\n`
    + '＋ 시트(RECORD_ACTIONS)에 넣거나 네비·헤더에 자리를 주세요.');
});

// ─────────────────────────────────────────────────────────
// 권한
// ─────────────────────────────────────────────────────────

test('결재 역할에게는 ＋ 기록이 뜨지 않는다', () => {
  // 팀장·센터장은 거래를 입력하지 않는다(CLAUDE.md §4). 시트를 열면 빈 화면이므로
  // 버튼 자체를 내린다 — 누를 수 있는데 아무것도 없는 것이 가장 나쁘다.
  assert.deepEqual(labels('팀장'), []);
  assert.deepEqual(labels('센터장'), []);
  assert.match(recordSrc, /classList\.toggle\('perm-hidden', availableRecordActions\(\)\.length === 0\)/,
    '고를 것이 없을 때 ＋ 버튼을 내리는 코드가 없습니다');
});

test('입력자와 담당자가 보는 것이 다르다', () => {
  // 입력자는 통장 사진·엑셀 권한이 없다. 시트가 역할을 따르지 않으면
  // 눌러서 서버에 거부당하는 버튼이 생긴다.
  assert.deepEqual(labels('입력자'), ['영수증 촬영', '영수증 불러오기', '수기 입력']);
  assert.deepEqual(labels('담당자'),
    ['영수증 촬영', '영수증 불러오기', '통장 사진', '수기 입력', '파일 업로드']);
});

test('＋ 버튼은 인라인 style 이 아니라 클래스로 감춘다', () => {
  // 인라인 style="display:''" 는 미디어 쿼리를 이겨서, 휴대폰 전용 버튼이
  // 데스크톱 화면에도 뜬다. 예전 설정 네비에서 실제로 그랬다.
  assert.doesNotMatch(recordSrc, /fab\.style\.display/);
  assert.match(html, /\.perm-hidden\{display:none!important;\}/);
});

// ─────────────────────────────────────────────────────────
// 카메라 / 앨범
// ─────────────────────────────────────────────────────────

test('촬영은 카메라를 열고, 불러오기는 그것을 되돌린다', () => {
  // 같은 input 을 두 버튼이 나눠 쓴다. 되돌리지 않으면 「불러오기」에서도
  // 카메라가 떠서, 이미 찍어 둔 영수증을 고를 수 없다.
  const attrs = {};
  const input = {
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  };
  applyCaptureMode(input, true);
  assert.equal(attrs.capture, 'environment');
  applyCaptureMode(input, false);
  assert.equal(attrs.capture, undefined);
});

// ─────────────────────────────────────────────────────────
// 아이콘
// ─────────────────────────────────────────────────────────

test('화면이 부르는 아이콘 이름은 전부 존재한다', () => {
  const used = new Set([
    ...[...html.matchAll(/data-icon="([^"]+)"/g)].map(m => m[1]),
    ...[...read('public/app.js').matchAll(/iconSvg\('([^']+)'/g)].map(m => m[1]),
    ...[...recordSrc.matchAll(/icon: '([^']+)'/g)].map(m => m[1]),
    // 설정 탭도 같은 한 벌을 쓴다(settings-nav.js 의 icon 은 이름이다)
    ...[...read('public/modules/settings-nav.js').matchAll(/icon: '([^']+)'/g)].map(m => m[1]),
    ...[...read('public/modules/modals.js').matchAll(/iconSvg\('([^']+)'/g)].map(m => m[1]),
  ]);
  const missing = [...used].filter(n => !ICON_NAMES.includes(n));
  assert.deepEqual(missing, [],
    `없는 아이콘을 부르고 있습니다: ${missing.join(', ')} — 그 자리는 빈칸으로 남습니다.`);
});

test('없는 이름은 대체 그림 없이 빈 문자열이다', () => {
  // 물음표 같은 것을 그리면 오타가 화면에 그럴듯하게 남아 아무도 고치지 않는다.
  assert.equal(iconSvg('없는이름'), '');
  assert.match(iconSvg('pen'), /^<svg class="icon" viewBox="0 0 24 24"/);
});

test('아이콘 한 벌이 굵기·색을 공유한다', () => {
  // 이모지가 촌스러웠던 이유가 기기마다 굵기·색이 달랐다는 것이므로,
  // 우리 아이콘이 같은 실수를 하면 바꾼 의미가 없다.
  for (const name of ICON_NAMES) {
    const svg = iconSvg(name);
    assert.match(svg, /stroke="currentColor"/, `${name}: 색이 고정돼 있습니다`);
    assert.match(svg, /stroke-width="1\.5"/, `${name}: 굵기가 다릅니다`);
    assert.doesNotMatch(svg.replace('fill="none"', ''), /fill="/, `${name}: 면을 칠했습니다`);
  }
});

test('아이콘 채우기는 두 번 불러도 한 번만 한다', () => {
  // 화면을 다시 그리는 곳에서 부담 없이 부를 수 있어야 한다.
  const el = {
    attrs: { 'data-icon': 'pen' }, innerHTML: '',
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
  const root = { querySelectorAll: () => [el] };
  assert.equal(hydrateIcons(root), 1);
  assert.match(el.innerHTML, /<svg/);
  assert.equal(hydrateIcons(root), 0);
});

test('버튼 맨 앞에 이모지를 쓰지 않는다 — 모달·설정·보고서까지', () => {
  // 네비만 바꾸고 모달을 두면 같은 화면에서 SVG 와 이모지가 섞여 통일감은
  // 바꾸기 전보다 나빠진다. 버튼 **선두** 아이콘만 본다(문장 속 이모지는 말투다).
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{270E}\u{270F}]/u;
  const files = ['public/index.html', ...readdirSync(new URL('../public/modules', import.meta.url))
    .filter(f => f.endsWith('.js')).map(f => 'public/modules/' + f)];
  const found = [];
  for (const rel of files) {
    const src = read(rel);
    // /u 가 없으면 [^\s<] 가 **UTF-16 한 칸**만 잡는다 — 이모지는 두 칸이라
    // 앞의 반쪽만 들어와 어떤 이모지도 걸리지 않았다(처음엔 ✕ 만 잡혔다).
    for (const m of src.matchAll(/<button[^>]*>\s*([^\s<])/gu)) {
      // ✕ 는 닫기 버튼의 글자다 — 기기마다 달리 그려지는 그림이 아니라 기호라서
      // 그대로 둔다. 통일감을 깨는 것은 컬러 이모지 쪽이다.
      if (m[1] !== '✕' && emoji.test(m[1])) found.push(`${rel}: ${m[1]}`);
    }
  }
  assert.deepEqual(found, [],
    `버튼 아이콘이 이모지입니다:\n  ${found.join('\n  ')}\n`
    + 'utils/icons.js 의 iconSvg() 로 바꾸세요. 없는 그림이면 거기에 먼저 더합니다.');
});

test('앱 크롬에 이모지가 남아 있지 않다', () => {
  // 한 화면에 이모지와 SVG 가 섞이면 통일감은 바꾸기 전보다 나빠진다.
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}]/u;
  const zones = {
    '사이드바': html.slice(html.indexOf('<nav style="flex:1'), html.indexOf('</nav>')),
    '하단 네비': html.slice(html.indexOf('<nav class="mobile-nav"'),
      html.indexOf('</nav>', html.indexOf('<nav class="mobile-nav"'))),
    '퀵 액션': html.slice(html.indexOf('<div id="dashboard-actions">'),
      html.indexOf('<!-- 입주자 카드 -->')),
  };
  for (const [name, zone] of Object.entries(zones)) {
    assert.ok(zone.length > 50, `${name} 구역을 찾지 못했습니다`);
    const found = zone.match(emoji);
    assert.equal(found, null, `${name}에 이모지가 남아 있습니다: ${found && found[0]}`);
  }
});
