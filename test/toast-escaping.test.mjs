// test/toast-escaping.test.mjs
//
// 토스트 메시지는 마크업으로 해석되지 않는다.
//
// 왜 이것만 따로 고정하는가
//   toast()는 이 앱에서 가장 많이 불리는 UI 함수이고, 오류 경로가
//   `toast('저장 실패: ' + e.message)` 형태로 부른다. Firestore·Storage의
//   오류 메시지에는 문서 ID나 내용이 되비칠 수 있고, 엑셀 업로드 실패
//   메시지에는 파일에서 읽은 값이 들어간다.
//
//   즉 여기 하나가 innerHTML이면 거의 모든 오류 경로가 주입 경로가 된다.
//   되돌리기도 쉽다 — `el.innerHTML = ...` 한 줄이 더 짧아 보이기 때문에.
//   그래서 "메시지가 텍스트로 남는가"를 실행해서 확인한다.

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * toast()가 쓰는 최소 DOM.
 * jsdom을 새로 들이지 않는다 — 필요한 것은 createElement·append·textContent뿐이다.
 */
function stubDom() {
  const make = (tag) => {
    const el = {
      tagName: tag, className: '', children: [], attrs: {},
      _text: '', _html: null,
      style: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      append(...kids) { this.children.push(...kids); },
      appendChild(kid) { this.children.push(kid); return kid; },
      remove() {},
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
    };
    return el;
  };
  const wrap = make('div');
  global.document = {
    getElementById: (id) => (id === 'toast-wrap' ? wrap : null),
    createElement: make,
  };
  return wrap;
}

/** 트리 전체에서 innerHTML로 설정된 값을 모은다. */
function htmlWrites(node, out = []) {
  if (node._html != null) out.push(node._html);
  for (const kid of node.children) htmlWrites(kid, out);
  return out;
}

/** 트리 전체의 텍스트를 잇는다. */
function allText(node, out = []) {
  if (node._text) out.push(node._text);
  for (const kid of node.children) allText(kid, out);
  return out.join('');
}

const ATTACK = '<img src=x onerror="alert(1)">';

test('메시지를 innerHTML로 넣지 않는다', async () => {
  const wrap = stubDom();
  const { toast } = await import('../public/utils/ui.js');

  toast(ATTACK, 'error');

  const writes = htmlWrites(wrap);
  assert.deepEqual(writes, [],
    'toast가 innerHTML을 썼습니다. 오류 메시지가 마크업으로 해석됩니다:\n  '
    + writes.join('\n  '));
});

test('메시지가 텍스트로 그대로 남는다', async () => {
  const wrap = stubDom();
  const { toast } = await import('../public/utils/ui.js');

  toast(ATTACK, 'error');

  // 이스케이프가 아니라 **텍스트 노드**여야 한다. 텍스트 노드는 브라우저가
  // 마크업으로 해석하지 않으므로 원문이 그대로 남는 것이 정상이다.
  assert.ok(allText(wrap).includes(ATTACK),
    '메시지가 화면에서 사라졌습니다 — 이스케이프된 문자열이 아니라 원문이 보여야 합니다');
});

test('메시지가 없어도 깨지지 않는다', async () => {
  const wrap = stubDom();
  const { toast } = await import('../public/utils/ui.js');

  for (const msg of [undefined, null, 0, '']) {
    assert.doesNotThrow(() => toast(msg));
  }
  assert.equal(htmlWrites(wrap).length, 0);
});

test('토스트를 붙일 곳이 없으면 조용히 아무것도 안 한다', async () => {
  global.document = { getElementById: () => null, createElement: () => { throw new Error('부르면 안 된다'); } };
  const { toast } = await import('../public/utils/ui.js');
  assert.doesNotThrow(() => toast('안녕'));
});
