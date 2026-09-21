// test/report-xss.test.mjs
//
// 보고서 화면은 저장된 값을 마크업으로 해석하지 않는다.
//
// 왜 보고서인가
//   이 화면이 그리는 값은 **거의 전부 남이 저장한 것**이다. 입주자명·계좌명은
//   팀장이 시설 개설에서 만들고, 분류명은 담당자가 만들며, 거래 내용은 엑셀
//   업로드가 은행 파일의 가맹점명 칸에서 읽어 온다. 그리고 이 화면을 보는
//   사람은 **결재자**다 — 팀장·센터장은 전 입주자를 열람하므로, 한 곳이
//   innerHTML 이면 조작된 은행 파일 한 장으로 결재자 세션에서 스크립트가 돈다.
//
//   실제로 다섯 곳이 새고 있었다.
//     · 분류별 지출 표의 분류명
//     · 통장사진 갤러리의 계좌명·썸네일 URL
//     · 계좌 고르기 버튼의 계좌 id·이름 (인라인 onclick)
//     · 결재 대기 목록의 입주자명
//     · 통장사진 팝업 창의 제목 (document.write — innerHTML 과 같다)
//
//   앞의 것들은 escHtml 로 막고, 인라인 onclick 은 **막을 수 없어서** 걷어냈다:
//   HTML 파서가 &#39; 를 ' 로 되돌린 뒤에 JS 가 컴파일되므로 그 자리에서는
//   escAttr 도 무력하다(utils/ui.js 의 escHtml 주석이 같은 것을 경고한다).
//
// 두 가지로 지킨다
//   ⑴ 실제로 그려 본다 — 악성 계좌명을 넣고 DOM 에 이벤트 속성이 생기는지.
//   ⑵ 소스를 훑는다 — 직접 부를 수 없는 나머지 자리(갤러리·대기 목록·분류표)는
//      렌더 경로가 보고서 전체 로드를 요구해서 단위 테스트로 부르기 어렵다.
//      그 자리들은 "이스케이프 없이 이어 붙이지 않는다"를 소스에서 확인한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPORT = fileURLToPath(new URL('../public/modules/report.js', import.meta.url));

/** 마크업으로 해석되면 즉시 실행되는 고전적인 페이로드. */
const ATTACK = '<img src=x onerror="alert(1)">';

// ─────────────────────────────────────────────────────────
// ⑴ 실제로 그려 본다
// ─────────────────────────────────────────────────────────

/**
 * openBankStatementFromReport 가 쓰는 최소 DOM.
 * jsdom 을 들이지 않는다 — createElement·replaceChildren·textContent 면 된다.
 */
function stubDom() {
  const make = (tag) => ({
    tagName: tag, className: '', children: [], attrs: {}, handlers: {},
    _text: '', _html: null, style: { cssText: '' },
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(ev, fn) { (this.handlers[ev] ||= []).push(fn); },
    append(...k) { this.children.push(...k); },
    appendChild(k) { this.children.push(k); return k; },
    replaceChildren(...k) { this.children = [...k]; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    // src 는 속성이자 프로퍼티다. 값으로 들어갔는지 보려고 함께 기록한다.
    set src(v) { this.attrs.src = String(v); },
    get src() { return this.attrs.src; },
  });
  const byId = { 'modal-wrap': make('div'), 'modal-body': make('div') };
  global.document = {
    getElementById: (id) => byId[id] || null,
    createElement: make,
    body: make('body'),
    addEventListener() {},
  };
  return byId;
}

/** 트리 전체를 훑어 innerHTML 로 쓰인 값과 속성을 모은다. */
function walk(node, acc = { html: [], attrs: [], text: [] }) {
  if (node._html != null) acc.html.push(node._html);
  for (const [k, v] of Object.entries(node.attrs || {})) acc.attrs.push(`${k}=${v}`);
  if (node._text) acc.text.push(node._text);
  for (const kid of node.children || []) walk(kid, acc);
  return acc;
}

test('악성 계좌명이 마크업으로 들어가지 않는다 — 계좌 고르기', async (t) => {
  const byId = stubDom();
  const { S } = await import('../public/state.js');
  let mod;
  try {
    mod = await import('../public/modules/report.js');
  } catch (err) {
    t.skip(`report.js 를 불러올 수 없습니다: ${err.message}`);
    return;
  }

  // 계좌가 둘 이상이어야 고르는 화면이 뜬다(하나면 바로 연다).
  S.accounts = [
    { id: 'acc1', clientId: 'c1', label: ATTACK },
    { id: "acc2'); alert(1); //", clientId: 'c1', label: '저축 통장' },
  ];

  await mod.openBankStatementFromReport('c1', 2026, 3);

  const acc = walk(byId['modal-body']);

  // innerHTML 을 아예 쓰지 않는 것이 정답이다. 쓰더라도 페이로드가 없어야 한다.
  const leaked = acc.html.filter((h) => h.includes('onerror') || h.includes('<img'));
  assert.deepEqual(leaked, [],
    '계좌명이 innerHTML 로 들어갔습니다 — 마크업으로 해석됩니다:\n  ' + leaked.join('\n  '));

  // 인라인 이벤트 속성이 붙어서도 안 된다.
  const onAttr = acc.attrs.filter((a) => /^on[a-z]+=/i.test(a));
  assert.deepEqual(onAttr, [],
    '인라인 이벤트 속성이 생겼습니다: ' + onAttr.join(', '));

  // 이스케이프가 아니라 **텍스트 노드**여야 한다 — 원문이 그대로 보이는 것이 정상이다.
  assert.ok(acc.text.some((t2) => t2.includes(ATTACK)),
    '계좌명이 화면에서 사라졌습니다 — 텍스트로는 그대로 보여야 합니다');
});

// ─────────────────────────────────────────────────────────
// ⑵ 소스를 훑는다
// ─────────────────────────────────────────────────────────

test('보고서 화면에 인라인 이벤트 핸들러가 없다', () => {
  const src = readFileSync(REPORT, 'utf8');
  // 값이 끼어드는 핸들러만 잡는다. `onclick="window.close()"` 처럼 고정 문구뿐인
  // 것은 주입 경로가 아니다 — 전부 금지하면 통장사진 팝업의 닫기 버튼까지 걸려
  // 규칙이 소음이 되고, 소음이 되면 사람이 규칙을 끈다.
  const INLINE = /\son[a-z]+\s*=\s*\\?["']([^"']*)/gi;
  const hits = [];
  src.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('//')) return;
    for (const m of line.matchAll(INLINE)) {
      if (/'\s*\+|\$\{/.test(m[1])) hits.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
  assert.deepEqual(hits, [],
    '값이 끼어드는 인라인 이벤트 핸들러가 있습니다(addEventListener 로 옮기세요):\n  '
    + hits.join('\n  '));
});

test('저장된 값을 이스케이프 없이 innerHTML 에 이어 붙이지 않는다', () => {
  const src = readFileSync(REPORT, 'utf8');

  // 이 화면이 그리는 값 중 **사람이 지은 것**. 늘어나면 여기에 더한다.
  //
  // `s.label` 은 넣지 않는다 — 이 파일에서 `s` 는 통장사진(계좌명)이기도 하고
  // 의견 칸·결재 단계의 **고정 문구**이기도 해서, 이름만으로는 갈리지 않는다.
  // 통장사진 갤러리는 아래 전용 검사가 따로 본다.
  const UNTRUSTED = [
    'client.name', 'c.name', 'a.label', 'acc.label',
    't.description', 'r.submittedByName',
  ];

  const bad = [];
  src.split('\n').forEach((line, i) => {
    if (!/innerHTML\s*=/.test(line) && !/^\s*\+/.test(line)) return;
    for (const field of UNTRUSTED) {
      // escHtml(field) / escAttr(field) 로 감싼 것은 통과.
      const raw = new RegExp(`\\+\\s*${field.replace('.', '\\.')}\\b`);
      const wrapped = new RegExp(`esc(Html|Attr)\\(\\s*${field.replace('.', '\\.')}`);
      if (raw.test(line) && !wrapped.test(line)) bad.push(`${i + 1}: ${field} — ${line.trim().slice(0, 90)}`);
    }
  });

  assert.deepEqual(bad, [],
    '저장된 값이 이스케이프 없이 마크업에 들어갑니다:\n  ' + bad.join('\n  '));
});

test('통장사진 갤러리는 계좌명·URL을 값으로 넣는다', () => {
  const src = readFileSync(REPORT, 'utf8');
  // 계좌명은 textContent, 썸네일은 img.src — 문자열로 이어 붙이지 않는다.
  assert.match(src, /cap\.textContent\s*=\s*String\(s\.label\|\|''\)/,
    '갤러리 캡션이 textContent 가 아닙니다');
  assert.match(src, /img\.src\s*=\s*thumb/,
    '썸네일 URL 이 src 프로퍼티가 아니라 마크업으로 들어갑니다');
  assert.match(src, /cell\.replaceChildren\(cap,\s*img\)/,
    '갤러리 칸이 다시 innerHTML 로 돌아갔습니다');
});

test('통장사진 팝업 창도 이스케이프한다 — document.write 는 innerHTML 과 같다', () => {
  const src = readFileSync(REPORT, 'utf8');
  // 새 창의 <title>·<h1> 에 계좌명이 그대로 들어가고 있었다.
  assert.match(src, /const title=escHtml\(/,
    '팝업 창 제목(계좌명)이 이스케이프되지 않았습니다');
  assert.match(src, /const safeUrl=escAttr\(url\)/,
    '팝업 창의 URL 이 속성 이스케이프를 지나지 않습니다');
});

test('분류명은 이스케이프해서 칩에 넣는다', () => {
  const src = readFileSync(REPORT, 'utf8');
  // 분류명은 엑셀 업로드의 가맹점명에서도 만들어진다 — 가장 바깥에서 오는 값이다.
  assert.match(src, /white-space:nowrap;">'\+escHtml\(k\)\+'<\/span>'/,
    '분류별 지출 표의 분류명이 이스케이프되지 않았습니다');
});
