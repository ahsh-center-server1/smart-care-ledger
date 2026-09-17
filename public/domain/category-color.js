// public/domain/category-color.js
//
// 분류의 색 — 순수 함수 + 작은 등록소. DOM·Firestore를 모른다.
//
// 무엇이 잘못돼 있었나
//   색을 이름으로만 찾았다.
//
//     export function cs(cat) {
//       return CAT_COLORS[cat] || {회색};
//     }
//
//   그래서 **이름을 바꾸는 순간 회색이 됐다.** 「식비」를 「음식비」로 바꾸면
//   표에 적힌 이름이 아니므로 기본값으로 떨어진다. 설정 화면에서 색을 골라
//   저장해도 마찬가지였다 — 저장된 색을 읽는 곳이 없었다.
//
//   게다가 그 색은 브라우저까지 오지도 않았다. 분류 명부(directory.js)의
//   CATEGORY_FIELDS 에 color 가 없어서 투영 단계에서 잘려 나갔다.
//   즉 고칠 곳이 셋이었다: 명부가 싣고, 화면이 등록하고, 여기서 읽는다.
//
// 왜 등록소인가
//   cs() 는 표·칩·차트 등 열 곳 남짓에서 이름 하나만 들고 불린다. 호출부마다
//   분류 문서를 찾아 넘기게 하면 그 열 곳을 다 고쳐야 하고, 한 곳만 빠뜨리면
//   같은 분류가 화면마다 다른 색이 된다. 그래서 분류를 불러올 때 한 번
//   등록해 두고 cs() 가 그것을 본다.
//
// 이름을 바꿔도 회색이 되지 않는다
//   저장된 색도 기본 표도 없으면 **이름에서 색을 만든다.** 예쁘지 않을 수는
//   있어도 회색 무더기보다 낫다 — 색의 쓸모는 "옆 줄과 다르다"이지
//   "특정 색이다"가 아니다.

'use strict';

/** 기본 분류의 색. 이름이 그대로인 동안에는 이 표가 이긴다. */
export const CAT_COLORS = {
  '식비':    { bg: '#fef2f2', text: '#dc2626', dot: '#dc2626', border: '#fecaca' },
  '교통비':  { bg: '#eff6ff', text: '#2563eb', dot: '#2563eb', border: '#bfdbfe' },
  '의료비':  { bg: '#f0fdf4', text: '#16a34a', dot: '#16a34a', border: '#bbf7d0' },
  '생필품':  { bg: '#fff7ed', text: '#ea580c', dot: '#ea580c', border: '#fed7aa' },
  '여가비':  { bg: '#faf5ff', text: '#9333ea', dot: '#9333ea', border: '#e9d5ff' },
  '개인관리': { bg: '#fdf4ff', text: '#c026d3', dot: '#c026d3', border: '#f0abfc' },
  '의생활':  { bg: '#ecfdf5', text: '#059669', dot: '#059669', border: '#a7f3d0' },
  '세금공과': { bg: '#f8fafc', text: '#475569', dot: '#64748b', border: '#cbd5e1' },
  '교육비':  { bg: '#eff6ff', text: '#1d4ed8', dot: '#1d4ed8', border: '#bfdbfe' },
  '기타':    { bg: '#f8fafc', text: '#64748b', dot: '#94a3b8', border: '#e2e8f0' },
  '확인필요': { bg: '#fafaf9', text: '#78716c', dot: '#a8a29e', border: '#d6d3d1' },
  '수입':    { bg: '#f0fdf4', text: '#15803d', dot: '#15803d', border: '#bbf7d0' },
  '자산이동': { bg: '#f0f9ff', text: '#0369a1', dot: '#0ea5e9', border: '#bae6fd' },
  '취소':    { bg: '#fafafa', text: '#71717a', dot: '#a1a1aa', border: '#d4d4d8' },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** #rrggbb → [r,g,b]. 형식이 아니면 null. */
function rgb(hex) {
  if (!HEX.test(String(hex || ''))) return null;
  const h = String(hex).slice(1);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

/** 흰색과 섞는다. ratio 1이면 원색, 0이면 흰색. */
function mix(channels, ratio) {
  const v = channels.map(c => Math.round(255 - (255 - c) * ratio));
  return '#' + v.map(c => c.toString(16).padStart(2, '0')).join('');
}

/**
 * 색 하나에서 칩이 필요한 네 가지를 만든다.
 *
 * 설정 화면은 색을 **하나만** 고르게 한다(색상 선택기 하나). 표·칩은 배경·
 * 글자·점·테두리 넷이 필요한데, 사람에게 네 개를 고르게 하면 아무도 안 쓴다.
 * 그래서 고른 색을 글자·점으로 쓰고 나머지는 흰색과 섞어 만든다.
 *
 * @returns {{bg:string,text:string,dot:string,border:string}|null}
 */
export function shadesFromHex(hex) {
  const c = rgb(hex);
  if (!c) return null;
  return { bg: mix(c, 0.08), text: hex.toLowerCase(), dot: hex.toLowerCase(), border: mix(c, 0.32) };
}

/**
 * 이름에서 색을 만든다 — 같은 이름이면 언제나 같은 색.
 *
 * 채도·명도를 고정하고 색상만 이름에서 뽑는다. 아무 색이나 쓰면 어떤 것은
 * 글자가 안 보이고 어떤 것은 배경에 묻힌다.
 */
export function autoColorFor(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return hslHex(h, 0.62, 0.42);
}

/** HSL → #rrggbb. 외부 의존 없이 쓰려고 직접 계산한다. */
function hslHex(hDeg, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hDeg / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hDeg / 60) % 6;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg];
  return '#' + [r, g, b]
    .map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

// ── 등록소 ──────────────────────────────────────────────────

/** 분류 이름 → 저장된 색(#rrggbb). 분류를 불러올 때 채운다. */
let saved = new Map();

/**
 * 지금 불러온 분류들의 색을 등록한다.
 *
 * 분류가 갱신될 때마다 **통째로** 바꾼다. 덧붙이면 지워진 분류의 색이 남고,
 * 같은 이름을 다시 만들었을 때 예전 색이 되살아난다.
 */
export function registerCategoryColors(categories) {
  const next = new Map();
  for (const c of (categories || [])) {
    // 자동분류 규칙(keyword가 있는 문서)은 분류 정의가 아니다.
    if (!c || c.keyword || !c.category) continue;
    if (HEX.test(String(c.color || ''))) next.set(String(c.category), String(c.color).toLowerCase());
  }
  saved = next;
}

/**
 * 분류의 색. **화면 어디서나 이것 하나를 쓴다.**
 *
 * 우선순위: 사용자가 고른 색 → 기본 표 → 이름에서 만든 색.
 * 회색으로 떨어지는 길은 이제 없다.
 */
export function cs(cat) {
  const name = String(cat || '');
  const chosen = saved.get(name);
  if (chosen) return shadesFromHex(chosen);
  if (CAT_COLORS[name]) return CAT_COLORS[name];
  if (!name) return CAT_COLORS['기타'];
  return shadesFromHex(autoColorFor(name));
}
