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
