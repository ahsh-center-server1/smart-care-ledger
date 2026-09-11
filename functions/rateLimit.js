'use strict';

/**
 * 사용자별 레이트리밋.
 *
 * 왜 필요한가
 *   영수증 판독은 호출마다 실제 비용이 든다(사진 1장 약 $0.02). 브라우저에서
 *   부르는 기능이므로, 실수로 반복 클릭하거나 스크립트로 반복 호출하면
 *   비용이 그대로 나간다. 클라이언트 쪽 버튼 잠금은 우회할 수 있으니
 *   **서버에서** 센다.
 *
 *   범위(scope)별로 한도를 따로 둔다 — 영수증 판독과 비밀번호 변경은
 *   남용의 성격이 달라 같은 예산을 공유하면 안 된다.
 *
 * 저장 위치
 *   rateLimits/{scope}-{uid}. 트랜잭션으로 읽고 쓰므로 동시 호출에도
 *   한도가 새지 않는다.
 */

const RATE_LIMITS = 'rateLimits';

/**
 * 창(window) 안의 호출 횟수를 계산한다 — 순수 함수라 테스트할 수 있다.
 *
 * @param {Object|undefined} state 기존 문서 { count, windowStart }
 * @param {number} now  현재 시각(ms)
 * @param {Object} opts { maxAttempts, windowMs }
 * @returns {{count:number, windowStart:number}} 다음 상태
 * @throws {Error} 'rate-limit-exceeded'
 */
function consume(state, now, { maxAttempts, windowMs }) {
  if (!(maxAttempts > 0)) throw new Error('maxAttempts는 1 이상이어야 합니다');
  if (!(windowMs > 0)) throw new Error('windowMs는 1 이상이어야 합니다');

  const started = Number(state && state.windowStart);
  const count = Number(state && state.count) || 0;

  // 창이 지났으면(또는 시각을 못 읽으면) 새 창을 시작한다.
  const fresh = !Number.isFinite(started) || now - started >= windowMs;
  if (fresh) return { count: 1, windowStart: now };

  if (count >= maxAttempts) {
    const err = new Error('rate-limit-exceeded');
    err.retryAfterMs = Math.max(0, started + windowMs - now);
    throw err;
  }
  return { count: count + 1, windowStart: started };
}

/**
 * 한도를 소비한다. 초과하면 던진다.
 *
 * @param {Object} db  Firestore(Admin SDK)
 * @param {string} scope  'receipt-analyze' 등
 * @param {string} uid
 * @param {Object} opts { maxAttempts, windowMs }
 */
async function consumeRateLimit(db, scope, uid, opts) {
  if (!uid) throw new Error('unauthenticated');
  const ref = db.collection(RATE_LIMITS).doc(`${scope}-${uid}`);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = consume(snap.exists ? snap.data() : undefined, now, opts);
    tx.set(ref, { ...next, scope, uid, updatedAt: new Date().toISOString() });
  });
}

/**
 * 서로 다른 한도를 **한 트랜잭션**에서 함께 소비한다.
 * AI 공급자의 할당량은 사용자별이 아니라 프로젝트 전체이므로 사용자 한도만
 * 두면 직원 수만큼 우회된다. 어느 하나라도 초과하면 아무 카운터도 증가하지 않는다.
 */
async function consumeRateLimits(db, limits) {
  if (!Array.isArray(limits) || !limits.length) throw new Error('limits가 필요합니다');
  const normalized = limits.map((item) => {
    const scope = String((item && item.scope) || '');
    const key = String((item && item.key) || '');
    if (!scope || !key || scope.includes('/') || key.includes('/')) {
      throw new Error('rate-limit-key-invalid');
    }
    return { ...item, scope, key, ref: db.collection(RATE_LIMITS).doc(`${scope}-${key}`) };
  });
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snaps = [];
    for (const item of normalized) snaps.push(await tx.get(item.ref));
    const next = normalized.map((item, i) => consume(
      snaps[i].exists ? snaps[i].data() : undefined,
      now,
      { maxAttempts: item.maxAttempts, windowMs: item.windowMs },
    ));
    normalized.forEach((item, i) => {
      tx.set(item.ref, {
        ...next[i], scope: item.scope, key: item.key,
        updatedAt: new Date(now).toISOString(),
      });
    });
  });
}

module.exports = { RATE_LIMITS, consume, consumeRateLimit, consumeRateLimits };
