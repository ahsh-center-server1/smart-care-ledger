// public/modules/font-scale.js
//
// 화면 글자 크기 3단계.
//
// 왜 2단계에서 3단계로 바꾸는가
//   기존 「큰 글씨」 토글은 body.large-text 클래스를 붙이고 **각 요소의 px 크기를
//   개별 규칙으로 다시 지정**했다(index.html에 그 오버라이드가 12줄). 새 UI를 만들 때마다
//   그 목록에 한 줄씩 추가해야 하고, 빠뜨리면 그 부분만 작게 남는다 —
//   실제로 여러 곳이 빠져 있었다.
//
//   대신 루트 font-size를 올린다. rem 기반 크기가 전부 함께 커지므로 새 UI에
//   추가 작업이 필요 없다. 그리고 2단계로는 부족했다 — 시력 차가 큰 사용자층에서
//   "조금 크게"와 "많이 크게"는 다른 요구다.
//
// 저장 위치
//   localStorage (기기 단위). 기존 sessionStorage는 탭을 닫으면 초기화돼
//   매번 다시 눌러야 했다. 글자 크기는 그 사람의 시력에 딸린 설정이므로 유지한다.
//
// 첫 페인트
//   index.html의 인라인 스크립트가 페인트 전에 data-font-scale을 적용한다.
//   이 모듈은 그 뒤에 로드되므로 DOM에 이미 반영된 값을 읽어 UI만 맞춘다.

'use strict';

export const FONT_SCALE_KEY = 'scl_fontScale';

/** 단계 정의 — 값(dataset), 라벨, 견본 글자 크기. */
export const FONT_SCALES = [
  { key: 'normal', label: '보통', ratio: '100%' },
  { key: 'large',  label: '크게', ratio: '112.5%' },
  { key: 'xlarge', label: '아주 크게', ratio: '125%' },
];

const VALID = new Set(FONT_SCALES.map(s => s.key));

/** 저장값·속성값을 유효한 단계로 정규화한다. 모르는 값은 'normal'. */
export function normalizeFontScale(v) {
  return VALID.has(v) ? v : 'normal';
}

/** 현재 단계 — DOM이 단일 출처다(인라인 부트스트랩이 이미 적용해 둔 값). */
export function currentFontScale() {
  return normalizeFontScale(document.documentElement.dataset.fontScale);
}

/**
 * 단계를 적용한다.
 * 'normal'은 속성을 지운다 — 기본값을 속성으로 박아 두면
 * CSS에서 기본 상태를 특수 케이스로 다뤄야 한다.
 */
export function setFontScale(key) {
  const scale = normalizeFontScale(key);
  if (scale === 'normal') delete document.documentElement.dataset.fontScale;
  else document.documentElement.dataset.fontScale = scale;

  try { localStorage.setItem(FONT_SCALE_KEY, scale); }
  catch (e) { /* 저장소가 막힌 환경 — 이번 세션에만 적용된다 */ }

  renderFontScaleControl();
}

/**
 * 세그먼트 컨트롤을 그린다. `#font-scale-control` 안에 렌더한다.
 *
 * 견본 글자('가')를 각 버튼에 고정 크기로 넣는다 — 버튼이 현재 설정에 따라
 * 같이 커지면 세 단계를 서로 비교할 수 없다.
 */
export function renderFontScaleControl() {
  const host = document.getElementById('font-scale-control');
  if (!host) return;

  const cur = currentFontScale();
  host.className = 'ui-fontscale';
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', '화면 글자 크기');
  host.textContent = '';

  for (const s of FONT_SCALES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ui-fontscale__btn ui-fontscale__btn--${s.key}`;
    btn.textContent = '가';
    btn.title = `글자 크기 ${s.label} (${s.ratio})`;
    // 스크린리더에는 '가'가 아니라 뜻이 전달되어야 한다.
    btn.setAttribute('aria-label', `글자 크기 ${s.label}`);
    btn.setAttribute('aria-pressed', s.key === cur ? 'true' : 'false');
    btn.addEventListener('click', () => setFontScale(s.key));
    host.appendChild(btn);
  }
}

/** 앱 시작 시 한 번. 저장값과 DOM을 맞추고 컨트롤을 그린다. */
export function initFontScale() {
  // 인라인 부트스트랩이 실패했거나(저장소 차단) 값이 손상된 경우를 여기서 바로잡는다.
  let saved = null;
  try { saved = localStorage.getItem(FONT_SCALE_KEY); } catch (e) { /* 무시 */ }
  const scale = normalizeFontScale(saved);
  if (scale !== currentFontScale()) {
    if (scale === 'normal') delete document.documentElement.dataset.fontScale;
    else document.documentElement.dataset.fontScale = scale;
  }
  renderFontScaleControl();
}
