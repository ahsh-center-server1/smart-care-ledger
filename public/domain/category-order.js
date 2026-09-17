// public/domain/category-order.js
//
// 분류 목록의 순서 — 순수 함수. DOM·Firestore를 모른다.
//
// 왜 필요한가
//   분류가 20개를 넘으면 매번 훑어 내려가야 한다. 그런데 실제로 쓰는 것은
//   그 사람의 그 계좌에서 몇 개뿐이다.
//
// **sortOrder 를 덮어쓰지 않는다**
//   드래그로 정한 순서는 사용자가 의도적으로 만든 것이다. "자주 쓰는 것을
//   앞으로" 옮기라고 만든 기능이라, 자동 정렬이 그 위에 덮이면 애써 맞춘 것이
//   매번 흐트러진다. 그래서 기존 순서는 그대로 두고 **「최근」 묶음을 위에
//   얹기만 한다.** 목록에서 같은 분류가 두 번 보이는 것은 의도다 — 익숙한
//   자리도 그대로 있어야 한다.

'use strict';

/** 분류를 정하지 못했을 때의 자리. 「최근」으로 올리지 않는다. */
const FALLBACK = '확인필요';

/** 최근 묶음에 올릴 개수. 넘치면 「최근」이 목록이 되어 버린다. */
const RECENT_LIMIT = 3;

/** 얼마나 거슬러 볼지. 너무 넓으면 한참 전에 한 번 쓴 것이 계속 올라온다. */
const LOOKBACK = 40;

/**
 * 그 유형·입주자에 해당하는 분류 이름 목록. 기존 순서(sortOrder) 그대로.
 * 공통 분류와 그 입주자 전용 분류를 함께 본다.
 */
export function baseCategories(categories, type, clientId) {
  const cid = String(clientId || '');
  const names = (categories || [])
    .filter(c => c && c.keyword === '' && c.type === type
      && (!c.clientId || String(c.clientId) === cid))
    .slice()
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
    .map(c => c.category);
  const out = [...new Set(names)];
  if (!out.includes(FALLBACK)) out.push(FALLBACK);
  return out;
}

/**
 * 최근에 쓴 분류 — 최근 거래부터 훑어 나온 순서대로.
 *
 * 빈도가 아니라 **최근순**이다. 이번 달에 새로 생긴 지출(예: 병원비)이
 * 빈도로는 한참 뒤인데 지금 계속 입력하는 것일 수 있다.
 */
export function recentCategories(transactions, type, available, limit = RECENT_LIMIT) {
  const allowed = new Set(available || []);
  const rows = (transactions || [])
    .filter(t => t && t.type === type && t.category && t.category !== FALLBACK)
    .slice()
    // 날짜 내림차순. 같은 날은 입력 순서(sortOrder)가 늦은 것부터.
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
      || (b.sortOrder ?? 0) - (a.sortOrder ?? 0))
    .slice(0, LOOKBACK);

  const seen = [];
  for (const t of rows) {
    const name = t.category;
    if (!allowed.has(name) || seen.includes(name)) continue;
    seen.push(name);
    if (seen.length >= limit) break;
  }
  return seen;
}

/**
 * 화면이 그릴 순서.
 *
 * @returns {{recent:string[], all:string[]}}
 *   recent — 위에 얹을 묶음 (없으면 빈 배열)
 *   all    — 기존 순서 그대로의 전체 목록. **recent 를 빼지 않는다.**
 */
export function orderedCategories({ categories, transactions, type, clientId, limit } = {}) {
  const all = baseCategories(categories, type, clientId);
  const recent = recentCategories(transactions, type, all, limit ?? RECENT_LIMIT);
  // 전부가 최근이면 묶음을 만들 이유가 없다 — 같은 목록이 두 번 보일 뿐이다.
  // 비교 대상에서 확인필요는 뺀다. 그것은 최근이 될 수 없으므로, 넣고 세면
  // 이 조건이 영영 참이 되지 않는다.
  const choosable = all.filter(c => c !== FALLBACK).length;
  return { recent: recent.length < choosable ? recent : [], all };
}
