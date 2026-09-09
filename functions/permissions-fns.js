'use strict';

/**
 * 권한 등급표 저장 — **저장과 집행을 같은 동작으로 만든다.**
 *
 * 원래 무엇이 잘못돼 있었나
 *   관리자가 설정→권한에서 등급을 바꾸면 브라우저가 `config/permissions` 를
 *   직접 썼다. 그런데 그 문서를 읽는 것은 브라우저의 can() 뿐이고,
 *   **서버는 아무도 읽지 않았다.** firestore.rules 와 storage.rules 는
 *   등급을 atLeast(2|3|4) 로 하드코딩하고 있었다.
 *
 *   그래서 등급을 낮추면 버튼은 보이는데 서버가 거부하고,
 *   등급을 올리면 버튼은 숨는데 서버는 여전히 허용했다.
 *   사용자가 "권한 변경하고 저장해도 반영이 안돼"라고 말한 것이 앞의 증상이고,
 *   뒤의 증상은 보이지 않는 구멍이었다.
 *
 * 지금 하는 일
 *   저장은 두 가지를 함께 한다.
 *     1. config/permissions      — 의도의 원본(다시 계산할 수 있는 근거)
 *     2. 전 사용자 authz/{uid}.caps — 규칙이 실제로 읽는 값
 *
 *   둘을 한 트랜잭션에 넣을 수는 없다(사용자 수만큼 쓰기가 늘어 한도를 넘는다).
 *   그래서 순서를 정한다:
 *     · config 를 **먼저** 쓴다 — 중간에 끊겨도 의도가 남아 있어야
 *       backfillAuthz 가 같은 결과를 다시 만든다.
 *     · caps 는 **잃는 사람부터** 쓴다 — 중간에 끊겨도 권한이 열린 채로
 *       남는 사람이 없다(회수 먼저, 부여 나중).
 *
 * caps 를 update 로 쓰는 이유
 *   set(…, {merge:true}) 는 **중첩 맵을 병합한다.** 카탈로그에서 키가 빠져도
 *   옛 키가 true 인 채로 남는다. update 는 caps 필드를 통째로 갈아치우므로
 *   그런 잔재가 생기지 않는다 — 전체 재계산 경로는 낡은 키를 치유해야 한다.
 */

const { AUTHZ } = require('./authz.cjs');
const {
  CAP_SCHEMA_VERSION, PERM_CATALOG, SELECTABLE_RANKS,
  capName, computeCaps, rankOf, sanitizeOverride,
} = require('./perm-catalog.cjs');

const USERS = 'users';
const CONFIG = 'config';
const PERMISSIONS_DOC = 'permissions';

/** 한 배치에 담을 caps 수. 중단 지점을 촘촘히 남긴다. */
const CAPS_CHUNK = 100;

/** 이 권한을 가진 사람만 등급표를 바꾼다. 카탈로그상 관리자 전용이고 조정 불가다. */
const GATE_KEY = 'settings.permissions';

module.exports = function permissionsFns(ctx) {
  const { db, callable, HttpsError, logger, FieldValue } = ctx;

  /**
   * 요청된 등급표를 카탈로그에 대고 검증한다. **순수 함수.**
   *
   * 조용히 버리지 않고 거절하는 이유
   *   조정할 수 없는 키를 조용히 무시하면 관리자는 바뀌었다고 믿는다.
   *   그것이 원래 버그의 다른 얼굴이다 — "저장했는데 반영이 안 된다".
   *   무엇을 저장할 수 없었는지 이름을 대고 거절한다.
   *
   * @returns {{diff: Object, rejected: string[]}}
   */
  function validate(wanted) {
    const diff = {};
    const rejected = [];

    for (const [key, raw] of Object.entries(wanted || {})) {
      const entry = PERM_CATALOG[key];
      if (!entry) { rejected.push(`${key}: 없는 권한입니다`); continue; }

      const v = Number(raw);
      if (!SELECTABLE_RANKS.includes(v)) {
        rejected.push(`${key}: 선택할 수 없는 등급입니다 (${raw})`);
        continue;
      }

      // 기본값과 같으면 저장하지 않는다 — 나중에 기본값을 바꾸면 따라오도록.
      // 조정 불가 키도 여기서 통과하므로, 화면이 전체 목록을 보내도 문제없다.
      if (v === entry.defaultRank) continue;

      if (!entry.configurable) {
        rejected.push(`${key}: 등급을 조정할 수 없는 권한입니다`);
        continue;
      }
      if (v < entry.securityFloor) {
        rejected.push(`${key}: 보안 하한(${entry.securityFloor}) 아래로 내릴 수 없습니다`);
        continue;
      }
      diff[key] = v;
    }

    return { diff, rejected };
  }

  /**
   * 사용자별 새 caps 와 **권한을 잃는지** 여부.
   * 잃는 사람을 앞에 놓는다(회수 먼저). 순수 함수 — 테스트가 순서를 확인한다.
   */
  function planCapsRewrite(users, currentCaps, override) {
    const plans = users.map((u) => {
      const caps = computeCaps(rankOf({ role: u.role, isAdmin: u.isAdmin }), override);
      const prev = currentCaps.get(u.uid) || null;
      const loses = prev != null && Object.keys(caps).some((k) => prev[k] === true && caps[k] !== true);
      return { uid: u.uid, caps, loses, hasAuthz: prev != null };
    });
    // 안정 정렬 — 같은 분류 안에서는 입력 순서를 지킨다(재실행이 같은 순서를 낸다).
    return plans
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (Number(b.p.loses) - Number(a.p.loses)) || (a.i - b.i))
      .map(({ p }) => p);
  }

  async function requirePermissionAdmin(auth) {
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
    if (!d.caps || d.caps[capName(GATE_KEY)] !== true) {
      throw new HttpsError('permission-denied', '권한 관리 권한이 없습니다.');
    }
  }

  const savePermissions = callable('savePermissions', async (request) => {
    const auth = request.auth;
    await requirePermissionAdmin(auth);

    const { diff, rejected } = validate((request.data || {}).minRank);
    if (rejected.length) {
      throw new HttpsError(
        'invalid-argument',
        `저장할 수 없는 항목이 있습니다.\n${rejected.join('\n')}`,
      );
    }

    const override = sanitizeOverride({ schema: 'minRank', minRank: diff });

    // 지금 상태를 먼저 읽는다 — 누가 권한을 잃는지 알아야 순서를 정할 수 있다.
    const [usersSnap, authzSnap] = await Promise.all([
      db.collection(USERS).get(),
      db.collection(AUTHZ).get(),
    ]);
    const currentCaps = new Map(
      authzSnap.docs.map((d) => [d.id, (d.data() || {}).caps || {}])
    );
    const users = usersSnap.docs.map((d) => ({
      uid: d.id, role: (d.data() || {}).role, isAdmin: (d.data() || {}).isAdmin,
    }));
    const plans = planCapsRewrite(users, currentCaps, override);

    // 1) 의도를 먼저 남긴다. 아래가 중간에 끊겨도 backfillAuthz 가 이 문서로
    //    같은 결과를 다시 만든다.
    await db.collection(CONFIG).doc(PERMISSIONS_DOC).set({
      schema: 'minRank',
      minRank: diff,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: String(auth.uid),
    });

    // 2) 규칙이 읽는 값을 갈아치운다. 회수부터.
    const writable = plans.filter((p) => p.hasAuthz);
    let updated = 0;
    for (let i = 0; i < writable.length; i += CAPS_CHUNK) {
      const batch = db.batch();
      for (const p of writable.slice(i, i + CAPS_CHUNK)) {
        batch.update(db.collection(AUTHZ).doc(p.uid), {
          caps: p.caps,
          capSchemaVersion: CAP_SCHEMA_VERSION,
        });
      }
      await batch.commit();
      updated += Math.min(CAPS_CHUNK, writable.length - i);
    }

    // authz 문서가 없는 사용자는 백필 전이다. 조용히 넘기면 그 사람만
    // 옛 권한으로 남는다 — 몇 명인지 돌려주고 화면이 알리게 한다.
    const missingAuthz = plans.filter((p) => !p.hasAuthz).map((p) => p.uid);

    const result = {
      changed: Object.keys(diff).length,
      users: updated,
      revoked: plans.filter((p) => p.loses).length,
      missingAuthz: missingAuthz.length,
      capSchemaVersion: CAP_SCHEMA_VERSION,
    };
    logger.info('[savePermissions] 완료', { ...result, by: auth.uid, keys: Object.keys(diff) });
    if (missingAuthz.length) {
      logger.warn('[savePermissions] authz 문서가 없는 사용자', { uids: missingAuthz.slice(0, 20) });
    }
    return result;
  });

  return { savePermissions, __validate: validate, __planCapsRewrite: planCapsRewrite };
};
