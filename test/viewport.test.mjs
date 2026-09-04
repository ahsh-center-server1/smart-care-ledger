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

  // index.html에서 모바일 네비를 켜는 미디어 쿼리의 기준폭
  assert.ok(
    htmlSrc.includes('@media(max-width:768px){.mobile-nav{display:block;}'),
    '모바일 네비 미디어 쿼리를 찾지 못했습니다'
  );
  assert.ok(
    jsWidths.every(w => w === '768'),
    `core.js의 기준폭(${jsWidths.join(', ')})이 CSS(768px)와 다릅니다`
  );
});

test('PC 전용 화면 목록에 보고서와 설정이 들어 있다', () => {
  const m = coreSrc.match(/DESKTOP_ONLY_VIEWS\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'DESKTOP_ONLY_VIEWS를 찾지 못했습니다');
  assert.ok(m[1].includes('report'),   '보고서가 PC 전용 목록에 없습니다');
  assert.ok(m[1].includes('settings'), '설정이 PC 전용 목록에 없습니다');
});

test('CSS도 좁은 화면에서 보고서·설정 네비를 숨긴다', () => {
  // JS만 막고 CSS가 안 숨기면 눌러서 실패하는 버튼이 남는다
  assert.ok(
    htmlSrc.includes('.mobile-nav-item[data-view="report"]') &&
    htmlSrc.includes('.mobile-nav-item[data-view="settings"]'),
    '좁은 화면에서 보고서·설정 네비를 숨기는 규칙이 없습니다'
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

test('거래내역 표의 카드 전환에 필요한 data-label이 붙어 있다', () => {
  const trxSrc = readFileSync(new URL('../public/modules/transactions.js', import.meta.url), 'utf8');
  for (const label of ['날짜', '카테고리', '내용', '계좌', '수입', '지출', '증빙', '관리']) {
    assert.ok(
      trxSrc.includes(`data-label="${label}"`),
      `'${label}' 열에 data-label이 없습니다 — 좁은 화면에서 항목 이름이 사라집니다`
    );
  }
});
