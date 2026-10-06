// public/domain/teams.js
//
// 팀 — 배정의 **틀**이지 권한의 축이 아니다.
//
// 왜 실체로 올렸나
//   `users.team` 이 자유 입력 텍스트였다. 「1팀」·「1 팀」·「일팀」이 서로 다른
//   팀이 되고, 목록도 검증도 없으니 오타를 알아차릴 방법이 없었다. 입주자에
//   담당을 붙일 때도 서른 명 전체에서 골라야 했다.
//
//   이제 팀이 `config/teams` 문서 하나에 모여 있고, 직원은 그 목록에서 고른다.
//   입주자에 팀을 정하면 담당 후보가 그 팀으로 좁혀지고, 담당 팀장은 그 팀의
//   팀장으로 자동으로 채워진다. 서른 명 중에서 고르던 것이 다섯 명이 된다.
//
// ⚠️ **팀은 권한을 주지 않는다.** 누가 무엇을 보는지는 여전히 `clients.userIds`
//   와 `clients.teamLeader` 의 투영본(authz)이 정한다. 팀을 권한 축으로 올리면
//   authz·firestore.rules·storage.rules·계약 게이트를 전부 다시 맞춰야 하고,
//   투영본이 어긋나는 순간 결재가 조용히 막힌다(그 고장을 이미 한 번 겪었다).
//   여기 있는 것은 **고르는 화면의 제약과 저장 시 검증**까지다.

'use strict';

/** 팀 미지정 — 값이 빈 문자열인 것이 곧 "정하지 않음"이다. */
export const NO_TEAM = '';

const text = (v) => String(v ?? '').trim();

/** config/teams 문서 → 다루기 좋은 배열. 모양이 깨져 있어도 화면은 떠야 한다. */
export function normalizeTeams(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.teams) ? raw.teams : []);
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const name = text(t && t.name);
    if (!name || seen.has(name)) continue;      // 이름이 곧 신분이다(중복은 버린다)
    seen.add(name);
    out.push({
      id: text(t.id) || name,
      name,
      leaderUid: text(t.leaderUid),
      active: t.active !== false,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

export function activeTeams(teams) {
  return normalizeTeams(teams).filter(t => t.active);
}

export function teamByName(teams, name) {
  const key = text(name);
  return normalizeTeams(teams).find(t => t.name === key) || null;
}

/** 그 팀 사람들. 팀이 비어 있으면 **전원**이다(제약이 없다는 뜻). */
export function membersOfTeam(users, name) {
  const key = text(name);
  const list = (users || []).filter(u => text(u.userId));
  return key ? list.filter(u => text(u.team) === key) : list;
}

/**
 * 저장 전 검증 — 배정된 사람이 그 팀 사람인가.
 *
 * ⚠️ 이 판정은 서버(`functions/teams.cjs`)에 **같은 내용으로** 한 벌 더 있다.
 *    화면만 막으면 콜러블을 직접 부르는 경로가 남고, 서버만 막으면 사용자는
 *    저장을 누른 뒤에야 안다. `test/teams.test.mjs` 가 둘을 같은 표로 대조한다.
 *
 * 규칙
 *   · 팀이 없으면(기존 입주자 전부) 아무것도 막지 않는다 — 마이그레이션 없이 산다
 *   · 팀이 있으면 담당 직원·담당 팀장은 그 팀 소속이어야 한다
 *   · 팀이 없는 직원(team 미지정)은 어느 팀에도 속하지 않으므로 걸린다
 */
export function teamMismatch({ team, memberUids = [], users = [] }) {
  const key = text(team);
  if (!key) return [];
  const byId = new Map((users || []).map(u => [text(u.userId), u]));
  return [...new Set(memberUids.map(text).filter(Boolean))]
    .filter((uid) => {
      const u = byId.get(uid);
      return !u || text(u.team) !== key;
    });
}

/**
 * 마이그레이션 — 지금 직원들이 적어 둔 팀 이름에서 목록을 만든다.
 *
 * 이미 있는 팀은 그대로 둔다(팀장 지정을 잃지 않는다). 새로 발견한 이름만 더하고,
 * 그 팀에 팀장 역할인 사람이 **한 명뿐이면** 팀장으로 넣어 준다 — 둘 이상이면
 * 고르는 것은 사람의 일이다.
 */
export function deriveTeamsFromUsers(users, existing = []) {
  const teams = normalizeTeams(existing);
  const known = new Set(teams.map(t => t.name));
  const names = [...new Set((users || [])
    .filter(u => u.active !== false)
    .map(u => text(u.team))
    .filter(Boolean))];

  for (const name of names) {
    if (known.has(name)) continue;
    const leaders = (users || []).filter(u => text(u.team) === name && text(u.role) === '팀장');
    teams.push({
      id: name,
      name,
      leaderUid: leaders.length === 1 ? text(leaders[0].userId) : '',
      active: true,
    });
  }
  return normalizeTeams(teams);
}

/** 저장 전 팀 목록 자체의 검증. 이름이 신분이므로 빈 이름·중복을 막는다. */
export function validateTeams(teams) {
  const errors = [];
  const seen = new Set();
  for (const t of (teams || [])) {
    const name = text(t && t.name);
    if (!name) { errors.push('이름이 비어 있는 팀이 있습니다.'); continue; }
    if (seen.has(name)) errors.push(`팀 이름이 겹칩니다: ${name}`);
    seen.add(name);
  }
  return errors;
}
