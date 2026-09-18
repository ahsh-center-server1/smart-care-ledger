'use strict';

/**
 * 팀 목록 콜러블 — `config/teams` 문서 하나를 통째로 쓴다.
 *
 * 왜 컬렉션이 아니라 문서 하나인가
 *   팀은 많아야 열 몇 개이고, **거의 모든 화면이 처음에 한 번 읽는다**(직원 폼의
 *   선택지, 입주자 폼의 후보 좁히기). 컬렉션이면 세션마다 팀 수만큼 읽기가 늘고,
 *   이 앱의 한도를 정하는 것은 월초 열흘의 읽기다(CLAUDE.md §12-1). 문서 하나면
 *   언제나 1회다.
 *
 * 왜 콜러블인가
 *   `config/{id}` 쓰기는 규칙이 `settingsPermissions` 를 요구하는데 그 권한은
 *   **아무도 갖지 않는다**(고정 정책의 FORBIDDEN_KEYS). 즉 config 는 서버만
 *   쓴다. 여기서 이름 중복·팀장 실재를 검증하고 한 번에 덮어쓴다.
 *
 * ⚠️ 팀은 권한을 주지 않는다. 배정·조회 범위는 여전히 clients 의 담당 필드와
 *    그 투영본(authz)이 정한다 — teams.cjs 머리말 참고.
 */

const { normalizeTeams } = require('./teams.cjs');
const { fixedCan } = require('./fixed-role-policy.cjs');

const CONFIG = 'config';
const USERS = 'users';
const AUTHZ = 'authz';
const TEAMS_DOC = 'teams';

module.exports = function teamFns(ctx) {
  const { db, callable, HttpsError, logger, FieldValue } = ctx;

  async function requireTeamAdmin(auth) {
    if (!auth || !auth.uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const snap = await db.collection(AUTHZ).doc(auth.uid).get();
    if (!snap.exists) {
      throw new HttpsError('failed-precondition',
        '권한 정보가 아직 준비되지 않았습니다. 관리자에게 권한 백필을 요청하세요.');
    }
    const d = snap.data() || {};
    if (d.enabled !== true) throw new HttpsError('permission-denied', '비활성화된 계정입니다.');
    // 팀은 배정의 틀이므로 배정 권한과 같은 자리에 둔다. 새 권한 키를 만들면
    // 규칙·카탈로그·계약 게이트까지 함께 손대야 하는데, 여기서 여는 것은
    // 담당 배정이 이미 하던 일의 **모양**뿐이다.
    if (!fixedCan(d, 'assignments.manage')) {
      throw new HttpsError('permission-denied', '팀을 관리할 권한이 없습니다.');
    }
    return d;
  }

  const saveTeams = callable('saveTeams', async (request) => {
    const auth = request.auth;
    await requireTeamAdmin(auth);

    const teams = normalizeTeams((request.data || {}).teams);
    if (teams.length > 50) {
      throw new HttpsError('invalid-argument', '팀이 너무 많습니다 (최대 50개).');
    }

    // 팀장으로 지정한 사람이 실재하고 활성인지. 없는 uid 를 넣어 두면 입주자
    // 폼에서 「담당 팀장 자동 지정」이 조용히 빈칸이 된다.
    const leaderUids = [...new Set(teams.map(t => t.leaderUid).filter(Boolean))];
    if (leaderUids.length) {
      const snaps = await db.getAll(...leaderUids.map(uid => db.collection(USERS).doc(uid)));
      const bad = snaps
        .map((s, i) => ({ uid: leaderUids[i], ok: s.exists && s.data().active !== false }))
        .filter(x => !x.ok).map(x => x.uid);
      if (bad.length) {
        throw new HttpsError('invalid-argument', `없거나 비활성인 계정입니다: ${bad.join(', ')}`);
      }
    }

    await db.collection(CONFIG).doc(TEAMS_DOC).set({
      type: 'teams',
      teams,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.uid,
    });

    logger.info('[saveTeams] 저장', { count: teams.length, by: auth.uid });
    return { count: teams.length, teams };
  });

  return { saveTeams };
};
