'use strict';

/**
 * 팀 판정 — 브라우저 `public/domain/teams.js` 의 **서버 사본**이다.
 *
 * 왜 사본인가
 *   규칙과 콜러블은 CommonJS 라 브라우저의 ES 모듈을 그대로 쓸 수 없다. 값이
 *   갈리면 화면은 통과시키고 서버가 거절하는(또는 그 반대) 상태가 되므로,
 *   `test/teams.test.mjs` 가 **같은 표로 둘을 대조한다.** 한쪽만 고치면 실패한다.
 *
 * ⚠️ 팀은 권한의 축이 아니다. 누가 무엇을 보는지는 authz 투영본이 정한다.
 *    여기 있는 것은 "배정이 팀과 맞는가"라는 저장 시 검증뿐이다.
 */

const text = (v) => String(v ?? '').trim();

/** 팀이 정해진 입주자에 그 팀 사람이 아닌 사람이 배정됐는지 — 어긋난 uid 목록. */
function teamMismatch({ team, memberUids = [], users = [] }) {
  const key = text(team);
  if (!key) return [];
  const byId = new Map((users || []).map((u) => [text(u.userId), u]));
  return [...new Set(memberUids.map(text).filter(Boolean))]
    .filter((uid) => {
      const u = byId.get(uid);
      return !u || text(u.team) !== key;
    });
}

/** config/teams 문서 → 배열. 이름이 곧 신분이라 중복·빈 이름은 버린다. */
function normalizeTeams(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.teams) ? raw.teams : []);
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const name = text(t && t.name);
    if (!name || seen.has(name)) continue;
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

module.exports = { teamMismatch, normalizeTeams };
