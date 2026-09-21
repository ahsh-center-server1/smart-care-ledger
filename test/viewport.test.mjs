import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 좁은 화면 판정은 CSS 미디어 쿼리와 **같은 기준(768px)**을 써야 한다.
 * 어긋나면 네비게이션은 숨겨졌는데 화면은 열리거나, 그 반대가 된다.
 *
 * core.js는 브라우저 전역에 의존하므로 여기서는 소스에 담긴 계약을 검증한다.
 * (모듈 전체를 Node에서 평가하려면 DOM 셰임이 필요하고, 그건 이 검사가
 *  잡으려는 실수 — 두 값이 갈리는 것 — 를 더 잘 잡아주지 못한다)
 */
import { readFileSync } from 'node:fs';

const coreSrc = readFileSync(new URL('../public/modules/core.js', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('isNarrowScreen의 기준폭이 CSS 미디어 쿼리와 일치한다', () => {
  const jsWidths = [...coreSrc.matchAll(/max-width:\s*(\d+)px/g)].map(m => m[1]);
  assert.ok(jsWidths.length > 0, 'core.js에 max-width 기준이 없습니다');

  // index.html에서 모바일 네비를 켜는 미디어 쿼리의 기준폭.
  // 규칙이 여러 줄로 늘어난 뒤에도(＋ 기록 버튼·퀵 액션 숨김이 같은 블록에 들어왔다)
  // **그 블록의 기준폭**을 읽는다 — 한 줄로 붙어 있는지가 아니라 숫자가 계약이다.
  const navRule = htmlSrc.match(/@media\(max-width:(\d+)px\)\{[^@]*?\.mobile-nav\{display:block;\}/);
  assert.ok(navRule, '모바일 네비 미디어 쿼리를 찾지 못했습니다');
  assert.equal(navRule[1], '768', `모바일 네비 기준폭이 ${navRule[1]}px 입니다`);
  assert.ok(
    jsWidths.every(w => w === '768'),
    `core.js의 기준폭(${jsWidths.join(', ')})이 CSS(768px)와 다릅니다`
  );
});

test('보고서만 PC 전용이고 설정의 역할 안내는 모바일에서도 연다', () => {
  const m = coreSrc.match(/DESKTOP_ONLY_VIEWS\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'DESKTOP_ONLY_VIEWS를 찾지 못했습니다');
  assert.ok(m[1].includes('report'),   '보고서가 PC 전용 목록에 없습니다');
  assert.ok(!m[1].includes('settings'), '설정 전체가 PC 전용으로 막혀 있습니다');
});

test('좁은 화면에 보고서 진입점이 없고 설정 진입점은 있다', () => {
  // 예전에는 하단 네비에 보고서·설정 칸이 있어서 CSS로 보고서만 숨겼다.
  // 지금 하단 네비는 세 자리(담당·＋·내역)뿐이라 **보고서 칸이 아예 없다** —
  // 숨김 규칙이 아니라 부재가 계약이다. 대신 사이드바 쪽 규칙은 그대로 확인한다.
  assert.ok(
    // 한 태그 안에서만 본다(줄바꿈 금지) — [^>]* 로 두면 CSS 규칙에서 시작해
    // 수백 줄 아래 사이드바 버튼까지 이어 붙어 없는 것을 있다고 읽는다.
    !/<button[^>\n]*mobile-nav-item[^>\n]*data-view="report"/.test(htmlSrc),
    '하단 네비에 보고서 칸이 다시 생겼습니다 — 누르면 PC에서 하라는 토스트만 뜹니다'
  );
  assert.ok(
    /@media\(max-width:768px\)\{\s*\.nav-item\[data-view="report"\]\{display:none!important;\}/.test(htmlSrc),
    '사이드바의 보고서 메뉴가 좁은 화면에서 숨겨지지 않습니다'
  );
  // 설정(내 역할 안내)은 휴대폰에서도 열려야 한다 — 헤더 버튼으로 옮겼다.
  assert.ok(
    /id="btn-mobile-settings"/.test(htmlSrc),
    '좁은 화면의 설정(역할 안내) 진입점이 없습니다'
  );
  assert.ok(
    /@media\(max-width:768px\)\{[^@]*?\.header-icon-btn:not\(\.perm-hidden\)\{display:inline-flex;\}/.test(htmlSrc),
    '헤더 설정 버튼이 좁은 화면에서 보이지 않습니다'
  );
});

test('모바일 전용 앱의 흔적이 남아 있지 않다', () => {
  // 별도 구현이 되살아나면 결재 순서 우회·정렬 역전이 함께 돌아온다
  const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const dead = ['isMobile', 'initMobileApp', 'mobileView', 'renderMobile', 'mobile-view'];
  for (const name of dead) {
    assert.ok(!appSrc.includes(name), `app.js에 '${name}'가 남아 있습니다`);
    assert.ok(!htmlSrc.includes(name), `index.html에 '${name}'가 남아 있습니다`);
  }
});

test('좁은 화면에서 사이드바를 숨기는 규칙에 !important가 있다', () => {
  // <aside>에 인라인 style="display:flex"가 붙어 있어 !important가 없으면
  // 미디어 쿼리가 무시되고 휴대폰에서 216px 사이드바가 화면을 잡아먹는다.
  // 모바일 전용 앱이 있을 때는 드러나지 않던 문제라 실제 브라우저로 잡았다.
  assert.ok(
    /@media\(max-width:768px\)\{aside\{display:none!important;\}\}/.test(htmlSrc),
    '사이드바 숨김 규칙에 !important가 없습니다 — 인라인 display:flex가 이깁니다'
  );
  assert.ok(
    /<aside[^>]*style="[^"]*display:flex/.test(htmlSrc),
    'aside의 인라인 display가 사라졌다면 위 !important 요구도 재검토하세요'
  );
});

test('거래내역 표의 카드 전환에 필요한 data-label이 붙어 있다', () => {
  const trxSrc = readFileSync(new URL('../public/modules/transactions.js', import.meta.url), 'utf8');
  for (const label of ['날짜', '카테고리', '내용', '계좌', '수입', '지출', '증빙', '관리']) {
    assert.ok(
      trxSrc.includes(`data-label="${label}"`),
      `'${label}' 열에 data-label이 없습니다 — 좁은 화면에서 항목 이름이 사라집니다`
    );
  }
});

// ─────────────────────────────────────────────
// 휴대폰 거래내역 — 남기는 것과 내리는 것
// ─────────────────────────────────────────────
//
// 휴대폰에서 이 화면을 여는 이유는 거의 하나다: 어떤 거래를 찾아 영수증을
// 붙이거나 한 칸 고치는 것(§7). 그런데 화면은 데스크톱 관리 도구를 그대로
// 접어 놓은 것이라 필터 여섯 개와 버튼 아홉 개가 표보다 먼저 나왔다.
//
// 여기서 지키는 두 가지
//   ⑴ 내린 것이 **데스크톱에는 그대로 있다** — 좁은 화면에서만 접는 것이지
//      기능을 지우는 것이 아니다. 미디어 쿼리 밖에서 지우면 담당자의 주
//      작업(수기 입력·엑셀 업로드)이 통째로 사라진다.
//   ⑵ 감추기는 **!important 로** 한다 — 권한 판정(auth.js 의 show())이
//      인라인 style.display 를 쓰기 때문에, 없으면 권한이 있는 사람 화면에서만
//      버튼이 되살아난다.

/**
 * CSS 를 규칙 단위로 갈라, 셀렉터 목록에 `sel` 이 **그 자체로** 들어 있는 것을
 * 찾는다. 문자열 포함으로 보면 `td[data-label="내용"]::before` 같은 가상 요소
 * 규칙이 `td[data-label="내용"]` 을 숨기는 것으로 잘못 읽힌다.
 *
 * **여러 개를 돌려준다.** 같은 셀렉터가 좁은 화면 블록 안에서 두 번 잡히는 일이
 * 실제로 있다(버튼들을 inline-flex 로 펴 주는 규칙이 앞에 있다). 첫 번째만 보면
 * 뒤에 오는 숨김 규칙을 놓친다.
 */
function rulesFor(css, sel, bodyRe) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map(x => x.trim());
    if (!selectors.some(x => x === sel || x.endsWith(` ${sel}`))) continue;
    if (bodyRe && !bodyRe.test(m[2])) continue;
    out.push(m[2]);
  }
  return out;
}

/** 좁은 화면 블록들만 이어 붙인다. 데스크톱 규칙과 섞어 보면 뜻이 없다. */
function narrowBlocks(src) {
  return [...src.matchAll(/@media\(max-width:768px\)\{([\s\S]*?)\n    \}/g)]
    .map(m => m[1]).join('\n');
}

test('휴대폰 거래내역에서 내리는 것은 미디어 쿼리 안에서만 내려간다', () => {
  const narrow = narrowBlocks(htmlSrc);
  const hidden = [
    '.trx-filter-extra', '#btn-filter-reset',
    '#btn-h-trx', '#btn-h-excel', '#btn-h-receipt-intake', '#btn-h-fixed',
    '#btn-h-receipt-print', '#btn-trx-view-toggle', '#btn-csv-export', '#btn-bulk-del',
  ];
  for (const sel of hidden) {
    assert.ok(narrow.includes(sel), `${sel} 가 좁은 화면 규칙에 없습니다`);
    // 데스크톱에서도 사라지면 담당자가 거래를 입력할 길이 없어진다.
    const desktop = htmlSrc.replace(/@media\(max-width:768px\)\{[\s\S]*?\n    \}/g, '');
    assert.ok(
      !new RegExp(`${sel.replace(/[.#]/g, '\\$&')}[^{]*\\{[^}]*display:none`).test(desktop),
      `${sel} 가 데스크톱에서도 숨겨집니다 — 좁은 화면에서만 접어야 합니다`,
    );
  }
});

test('감추기에 !important 가 있다 — 권한 판정이 인라인 style 을 쓴다', () => {
  // auth.js 의 show() 가 el.style.display 를 직접 건드린다. !important 가 없으면
  // 권한이 있는 사람에게만 버튼이 되살아나 「어떤 사람 폰에서만 보인다」가 된다.
  const authSrc = readFileSync(new URL('../public/modules/auth.js', import.meta.url), 'utf8');
  assert.ok(/style\.display\s*=/.test(authSrc),
    'auth.js 가 인라인 display 를 쓰지 않는다면 이 요구를 재검토하세요');

  for (const sel of ['#btn-h-excel', '#btn-bulk-del', '#btn-h-fixed', '#btn-h-receipt-print']) {
    const rules = rulesFor(narrowBlocks(htmlSrc), sel);
    assert.ok(rules.length, `${sel} 를 숨기는 규칙이 없습니다`);
    // 같은 블록에 이 버튼을 inline-flex 로 펴 주는 규칙도 있다. !important 는
    // 순서와 무관하게 이기므로, 한 규칙에라도 붙어 있으면 된다.
    assert.ok(rules.some(b => /display:none!important/.test(b)),
      `${sel} 숨김에 !important 가 없습니다 — 인라인 style 이 이깁니다`);
  }
});

test('휴대폰 줄에는 날짜·내용·금액·증빙·수정이 남는다', () => {
  const narrow = narrowBlocks(htmlSrc);
  for (const label of ['카테고리', '계좌']) {
    const rules = rulesFor(narrow, `td[data-label="${label}"]`);
    assert.ok(rules.some(b => /display:none/.test(b)),
      `'${label}' 열이 좁은 화면에서 그대로 보입니다`);
  }
  // 금액은 **남긴다.** 같은 날 같은 가맹점 두 건을 가르는 유일한 값이고,
  // 장부에서 금액이 안 보이면 지금 무엇을 보고 있는지 알 수 없다.
  for (const cls of ['td.col-in', 'td.col-out']) {
    assert.equal(rulesFor(narrow, cls, /display:none!important/).length, 0,
      `${cls}(수입·지출)가 좁은 화면에서 숨겨집니다 — 금액은 남아야 합니다`);
  }
  // 남겨야 하는 것 — 이 넷이 사라지면 휴대폰에서 할 일 자체가 없어진다.
  // (::before 같은 가상 요소 규칙은 열 자체를 숨기는 것이 아니므로 센다.)
  for (const label of ['날짜', '내용', '증빙', '관리']) {
    assert.equal(rulesFor(narrow, `td[data-label="${label}"]`, /display:none/).length, 0,
      `'${label}' 열이 좁은 화면에서 숨겨집니다 — 영수증을 붙일 줄을 찾을 수 없습니다`);
  }
});

test('휴대폰에 로그아웃 자리가 있다', () => {
  // 사이드바(로그아웃이 있던 유일한 자리)가 좁은 화면에서 통째로 숨는다.
  // 즉 이 버튼이 없으면 휴대폰에는 로그아웃할 방법이 아예 없다 — 공용 단말을
  // 다음 사람에게 넘길 때 그것을 처음 알게 된다.
  assert.ok(
    /id="btn-mobile-logout"[^>]*class="header-icon-btn"/.test(htmlSrc),
    '헤더에 모바일 로그아웃 버튼이 없습니다',
  );
  const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(
    /btn-mobile-logout'\)\?\.addEventListener\('click'/.test(appSrc),
    '모바일 로그아웃 버튼이 아무 일도 하지 않습니다',
  );
  // 설정 버튼과 같은 클래스라야 같은 미디어 쿼리로 켜진다.
  assert.ok(
    /@media\(max-width:768px\)\{[^@]*?\.header-icon-btn:not\(\.perm-hidden\)\{display:inline-flex;\}/.test(htmlSrc),
    '헤더 아이콘 버튼이 좁은 화면에서 보이지 않습니다',
  );
});
