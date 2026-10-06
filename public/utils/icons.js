// public/utils/icons.js
//
// 아이콘 한 벌 — 화면에 쓰는 그림은 여기서만 나온다.
//
// 왜 이모지를 걷어냈나
//   📊📜📑⚙️ 가 촌스러워 보이는 진짜 이유는 취향이 아니라 **OS마다 다른 그림을
//   그리기 때문**이다. 같은 📑 가 안드로이드에서는 파랑 굵은 클립보드, iOS에서는
//   노랑 가는 문서, 윈도우에서는 또 다른 것으로 나온다. 한 화면 안에서 굵기도
//   색도 제각각이니 무엇을 어떻게 배치해도 통일감이 생기지 않는다.
//
//   인라인 SVG 는 우리가 그린 그대로 모든 기기에서 같게 나오고, `currentColor`
//   라서 버튼 색을 따라간다. 아이콘 **폰트**는 쓰지 않는다 — 네트워크에서 받아야
//   하고, PWA 를 오프라인에서 열면 글자가 네모로 뜬다.
//
// 어떻게 쓰나
//   · 정적 HTML: `<span data-icon="pen"></span>` → 시작할 때 hydrateIcons() 가 채운다
//   · 만들어 내는 HTML: `iconSvg('pen')` 문자열을 그대로 끼운다
//
// 그리는 규칙 (새 아이콘을 더할 때도 지킨다 — 어기면 통일감이 깨진다)
//   24×24 · 선만(면 없음) · 굵기 1.5 · 끝과 모서리는 둥글게 · 색은 currentColor
//
// ⚠️ 여기 있는 것은 **경로(path)뿐**이다. 크기·굵기·색을 path 안에 적지 말 것.
//    한 아이콘만 굵으면 그 자리만 눈에 띄고, 그게 정확히 이모지의 문제였다.

'use strict';

/** 이름 → SVG 내부 경로. 24×24 격자. */
export const ICON_PATHS = {
  // 사람들 — 담당 입주자
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 2.7-5 6-5s6 2 6 5"/>'
    + '<path d="M16.5 6.2a3 3 0 0 1 0 5.6"/><path d="M18 14.5c2 .7 3 2.2 3 4.5"/>',
  // 목록 — 거래 내역
  list: '<path d="M8 7h12M8 12h12M8 17h12"/><path d="M4 7h.01M4 12h.01M4 17h.01"/>',
  // 더하기 — 기록하기
  plus: '<path d="M12 5v14M5 12h14"/>',
  // 조절 손잡이 — 설정
  //
  // 톱니바퀴를 먼저 그려 봤는데 18px(사이드바)로 줄이면 이가 뭉개져 꽃처럼
  // 보였다. 선만으로 그리는 아이콘은 작을 때 버티는 모양이어야 한다.
  settings: '<path d="M4 8h8M17 8h3M4 16h3M12 16h8"/>'
    + '<circle cx="14.5" cy="8" r="2.5"/><circle cx="9.5" cy="16" r="2.5"/>',
  // 카메라 — 영수증 촬영
  camera: '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0 1 21 8.5v9'
    + 'A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
  // 사진 — 앨범에서 고르기
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/>'
    + '<path d="M21 16l-5-5-6 6-2-2-5 4"/>',
  // 펼친 책 — 통장 사진
  book: '<path d="M3 5.5C5 4.5 7 4.5 9 5.5c1 .5 1.7 1.2 3 1.2s2-.7 3-1.2c2-1 4-1 6 0V18'
    + 'c-2-1-4-1-6 0-1 .5-1.7 1.2-3 1.2s-2-.7-3-1.2c-2-1-4-1-6 0z"/><path d="M12 6.7V19"/>',
  // 펜 — 수기 입력
  pen: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14.5 6.5l3 3"/>',
  // 올리기 — 파일 업로드
  upload: '<path d="M12 16V4"/><path d="M8 8l4-4 4 4"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13'
    + 'a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  // 내리기 — 엑셀 저장
  download: '<path d="M12 4v12"/><path d="M8 12l4 4 4-4"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13'
    + 'a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  // 문서 — 보고서
  report: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>'
    + '<path d="M14 3v4h4"/><path d="M8.5 12h7M8.5 16h5"/>',
  // 막대 — 대시보드
  chart: '<path d="M4 20h16"/><path d="M7 20v-6M12 20V6M17 20v-9"/>',
  // 압정 — 고정항목
  pin: '<path d="M9 3h6l-.8 5.2 3.3 3.3H6.5l3.3-3.3z"/><path d="M12 11.5V21"/>',
  // 프린터 — 증빙 출력
  printer: '<path d="M7 9V3h10v6"/><path d="M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4'
    + 'a2 2 0 0 1-2 2h-2"/><path d="M7 14h10v7H7z"/>',
  // 달력 — 달력 보기
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>'
    + '<path d="M8 3v4M16 3v4"/>',
  // 휴지통 — 일괄 삭제
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'
    + '<path d="M10 11v6M14 11v6"/>',
  // 열쇠 — 비밀번호 변경
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9"/><path d="M17 12v3M20 12v2"/>',
  // 되돌리기 — 필터 초기화
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>',
  // 확인 — 저장·완료
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  // 겹친 종이 — 복사
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/>'
    + '<path d="M15 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1.5"/>',
  // 클립 — 증빙 첨부
  clip: '<path d="M17.5 9.5l-7.6 7.6a3.2 3.2 0 0 1-4.5-4.5l8-8a2.2 2.2 0 0 1 3.1 3.1l-7.9 7.9'
    + 'a1.2 1.2 0 0 1-1.7-1.7l7.1-7.1"/>',
  // 돋보기 — 찾기
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
  // 반짝임 — AI 문장 생성
  sparkle: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>'
    + '<path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
  // 상자 — 연도 마감 보관
  archive: '<path d="M3 7h18v3H3z"/><path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9"/>'
    + '<path d="M10 14h4"/>',
  // 동전 — 잔액
  coin: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8"/><path d="M14.5 9.8c-.6-.6-1.5-.9-2.5-.9'
    + '-1.4 0-2.5.7-2.5 1.8s1.1 1.6 2.5 1.6 2.5.5 2.5 1.6-1.1 1.8-2.5 1.8c-1 0-1.9-.3-2.5-.9"/>',
  // 나가기 — 로그아웃
  logout: '<path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M3 12h12"/>'
    + '<path d="M11 8l4 4-4 4"/>',
};

export const ICON_NAMES = Object.keys(ICON_PATHS);

/**
 * 아이콘 하나를 SVG 문자열로.
 *
 * 이름이 없으면 **빈 문자열**을 준다. 물음표 같은 대체 그림을 그리면 오타가
 * 화면에 그럴듯하게 남아 아무도 못 고친다 — 빈 자리는 눈에 띈다.
 */
export function iconSvg(name, size = 24) {
  const path = ICON_PATHS[name];
  if (!path) return '';
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"`
    + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
    + ` aria-hidden="true" focusable="false">${path}</svg>`;
}

/**
 * `data-icon` 이 붙은 자리를 전부 채운다.
 *
 * 두 번 불러도 안전하다(이미 채운 자리는 건너뛴다) — 화면을 다시 그리는 곳에서
 * 부담 없이 부를 수 있어야 한다.
 */
export function hydrateIcons(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let filled = 0;
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    if (!name || el.getAttribute('data-icon-done') === name) return;
    const svg = iconSvg(name, Number(el.getAttribute('data-icon-size')) || 24);
    if (!svg) return;
    el.innerHTML = svg;
    el.setAttribute('data-icon-done', name);
    filled += 1;
  });
  return filled;
}
