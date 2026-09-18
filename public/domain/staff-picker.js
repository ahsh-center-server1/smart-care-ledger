// public/domain/staff-picker.js
//
// 「담당 직원」 고르기 — 목록을 어떻게 추리고 묶을지.
//
// 왜 도메인으로 뺐나
//   이 화면의 어려움은 그리기가 아니라 **누구를 보여 주느냐**다. 직원이 서른
//   명이 되면 2열 체크박스 상자에서 일곱 명쯤 보이고 나머지는 스크롤인데 검색이
//   없었다. 그런데 "안 보이는 사람"에는 위험한 부류가 하나 더 있었다 — 아래
//   `keepsAssignedEvenIfInactive` 를 보라.

'use strict';

/** 팀이 비어 있는 사람들을 모으는 이름. 마지막에 온다. */
export const NO_TEAM = '팀 미지정';

const text = (v) => String(v ?? '').trim();
const norm = (v) => text(v).toLowerCase();

/**
 * ⚠️ 비활성(퇴직) 직원이라도 **이미 담당으로 지정돼 있으면 목록에 남긴다.**
 *
 * 예전 화면은 `active !== false` 로 먼저 걸렀다. 그래서 담당자가 퇴직 처리되면
 * 그 사람의 체크박스가 사라지는데, 저장은 "체크된 것 전부"를 보낸다 — 입주자
 * 이름만 고치고 저장해도 **그 사람의 배정이 조용히 지워졌다.** 화면에는 아무
 * 경고도 없고, 알아차리는 시점은 그 사람이 다시 돌아왔을 때다.
 *
 * 지우려면 체크를 풀어야 한다. 보이지 않는 것이 지워지면 안 된다.
 */
export function keepsAssignedEvenIfInactive(user, selectedIds) {
  return user.active !== false || selectedIds.includes(text(user.userId));
}

/** 검색어와 맞는가 — 이름·아이디·팀 중 하나라도. */
export function matchesQuery(user, query) {
  const q = norm(query);
  if (!q) return true;
  return [user.name, user.userId, user.team].some(v => norm(v).includes(q));
}

/**
 * 화면에 뿌릴 모델.
 *
 * 규칙
 *   · 선택된 사람은 **맨 위에** 따로 모은다(지금은 스크롤해야 누굴 골랐는지 안다)
 *   · 나머지는 팀으로 묶는다. 팀 없는 사람은 마지막 「팀 미지정」
 *   · 팀·이름은 가나다순 — 매번 같은 자리에 있어야 눈이 익는다
 */
export function pickerModel(users, selectedIds = [], query = '') {
  const ids = selectedIds.map(text).filter(Boolean);
  const candidates = (users || [])
    .filter(u => text(u.userId))
    .filter(u => keepsAssignedEvenIfInactive(u, ids));

  const decorate = u => ({
    userId: text(u.userId),
    name: text(u.name) || text(u.userId),
    role: text(u.role),
    team: text(u.team) || NO_TEAM,
    inactive: u.active === false,
    selected: ids.includes(text(u.userId)),
  });

  const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
  const all = candidates.map(decorate).sort(byName);

  const groups = [];
  for (const m of all) {
    let g = groups.find(x => x.team === m.team);
    if (!g) { g = { team: m.team, members: [] }; groups.push(g); }
    g.members.push(m);
  }
  groups.sort((a, b) => (a.team === NO_TEAM) - (b.team === NO_TEAM)
    || a.team.localeCompare(b.team, 'ko'));

  return {
    selected: all.filter(m => m.selected),
    groups: groups.map(g => ({
      ...g,
      selectedCount: g.members.filter(m => m.selected).length,
      // 검색은 **보이고 안 보이고**만 정한다. 목록에서 빼지 않는다 —
      // 빼면 체크된 채로 사라져 저장할 때 조용히 지워진다.
      matched: g.members.filter(m => matchesQuery(m, query)).map(m => m.userId),
    })),
  };
}

/** 요약 문구 — "3명 선택 · 김담당 · 박입력 …" */
export function selectionSummary(selected, max = 3) {
  if (!selected.length) return '아직 선택하지 않았습니다';
  const names = selected.slice(0, max).map(m => m.name).join(' · ');
  const rest = selected.length - Math.min(max, selected.length);
  return `${selected.length}명 선택 · ${names}${rest ? ` 외 ${rest}명` : ''}`;
}
