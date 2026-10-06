'use strict';

/**
 * 호출자 판정 — **규칙과 같은 근거를 본다.**
 *
 * 무엇을 대체하나
 *   예전에는 커스텀 토큰의 클레임(role · isAdmin)으로 판정했다. 클레임은
 *   발급 시점에 굳는다. 그래서:
 *
 *     · 역할을 강등해도 이미 발급된 토큰은 옛 등급을 그대로 갖는다
 *     · 퇴사 처리해도 refresh token 으로 계속 갱신되므로 만료를 기다리는 것이
 *       유일한 차단이 된다 — 그것은 차단 정책이 아니다
 *     · 등급표를 바꿔도 반영되지 않는다(토큰에 등급이 박혀 있다)
 *
 *   이제 매 호출마다 authz/{uid} 를 읽는다. firestore.rules · storage.rules 가
 *   보는 바로 그 문서다. 판정 근거가 하나면 화면·규칙·함수가 갈라질 수 없다.
 *
 * 왜 파일 하나로 모았나
 *   같은 검사가 다섯 군데에 복사돼 있었다(권한·영수증·보고서·마감·입주자).
 *   같은 질문에 근거가 여럿이면 언젠가 갈라진다 — 이 프로젝트가 등급표에서
 *   이미 겪은 일이다.
 *
 * 비용
 *   호출당 문서 1회 읽기다. 콜러블은 규칙 평가보다 훨씬 드물게 일어나므로
 *   할당량에서 의미 있는 몫이 아니다.
 */

const { fixedCan, FIXED_ROLES } = require('./fixed-role-policy.cjs');

const AUTHZ = 'authz';

module.exports = function makeCaller({ db, HttpsError }) {
  /**
   * 로그인한 호출자의 권한을 읽는다.
   *
   * 문서가 없으면 거부한다(fail-closed). 백필 전에는 모든 새 경로가 닫혀 있고,
   * 그것이 의도다 — 열어 두고 나중에 잠그는 것보다 안전하다. 다만 무엇을
   * 해야 하는지는 말해 준다. 그러지 않으면 "왜 안 되는지" 알 수 없다.
   */
  async function requireCaller(auth) {
    if (!auth || !auth.uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const snap = await db.collection(AUTHZ).doc(auth.uid).get();
    if (!snap.exists) {
      throw new HttpsError(
        'failed-precondition',
        '권한 정보가 아직 준비되지 않았습니다. 관리자 권한으로 권한 백필을 먼저 실행하세요.',
      );
    }
    const d = snap.data() || {};
    if (d.enabled !== true) throw new HttpsError('permission-denied', '비활성화된 계정입니다.');

    const scope = d.role === '팀장' ? d.leaderClientIds : d.accessibleClientIds;
    const accessible = Array.isArray(scope) ? scope : [];

    const can = (key) => fixedCan(d, key);

    return {
      uid: auth.uid,
      role: String(d.role || ''),
      isAdmin: d.isAdmin === true,
      /** 등급. "본인보다 높은 역할은 부여할 수 없다" 같은 비교에만 쓴다. */
      rank: FIXED_ROLES.indexOf(d.role) + 1,
      can,

      /** 담당이거나, 담당과 무관하게 전체를 보는 권한이 있거나. 규칙의 seesClient 와 같다. */
      sees(clientId) {
        return can('client.view.all') || (can('trx.create') || can('trx.view.all')) && accessible.includes(String(clientId));
      },

      /** 권한 하나를 요구한다. 메시지는 호출부가 정한다 — 화면까지 가는 문구다. */
      require(key, what) {
        if (!can(key)) throw new HttpsError('permission-denied', `${what} 권한이 없습니다.`);
      },

      /** 담당 범위를 요구한다. */
      requireSees(clientId) {
        if (!this.sees(clientId)) {
          throw new HttpsError('permission-denied', '담당하지 않는 입주자입니다.');
        }
      },
    };
  }

  return { requireCaller };
};
