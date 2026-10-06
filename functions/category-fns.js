'use strict';

/**
 * 카테고리 이름·색상 수정 — **이름을 바꾸면 장부가 따라와야 한다.**
 *
 * 왜 서버인가
 *   거래는 분류를 문자열로 들고 있다(정규화된 참조가 아니다). 그래서 이름만
 *   바꾸면 기존 거래는 옛 이름에 남고, 보고서 집계가 두 줄로 갈라진다.
 *
 *   그런데 **분류를 고치는 사람과 거래를 고칠 수 있는 사람이 다르다.**
 *   공통 분류는 팀장·센터장이 관리하는데, 그 둘은 trx.edit 을 갖지 않는다
 *   (작성자와 결재자의 분리). 브라우저에서 일괄 수정하면 규칙이 거절한다 —
 *   이름만 바뀌고 거래는 그대로 남는, 가장 나쁜 절반의 상태가 된다.
 *
 *   서버는 Admin SDK 로 쓰되, **권한은 규칙과 같은 근거로 직접 판정한다.**
 *
 * 무엇을 함께 바꾸나
 *   1. 분류 문서(keyword === '')의 category
 *   2. 그 분류를 가리키는 자동분류 규칙(keyword !== '')의 category
 *      — 빠뜨리면 다음 엑셀 업로드가 사라진 이름으로 분류한다
 *   3. 그 분류를 쓰는 거래의 category
 *
 * 무엇을 건드리지 않나
 *   **마감된 달의 거래.** 최종 결재가 끝난 숫자는 서버도 바꾸지 않는다.
 *   그 결과 장부가 두 이름으로 갈라지지만, 결재된 기록을 소급해 고치는 것보다
 *   낫다. 몇 건이 남았는지 돌려주므로 화면이 그대로 말해 준다.
 */

const CATEGORIES = 'categories';
const TRANSACTIONS = 'transactions';
const CONFIG = 'config';
const LOCKED_MONTHS_DOC = 'lockedMonths';

/** Firestore 배치 한 번에 담을 수 있는 쓰기 수. */
const BATCH_LIMIT = 400;

/** 이름 길이 상한 — 화면 입력칸(maxlength=20)과 맞춘다. */
const MAX_NAME = 20;

/** #rrggbb 만 받는다. 화면이 style 에 그대로 넣으므로 자유 문자열이면 안 된다. */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const lockKey = (clientId, date) => `${clientId}_${String(date || '').slice(0, 7)}`;

module.exports = function categoryFns(ctx) {
  const { db, callable, requireCaller, HttpsError, logger, FieldValue } = ctx;

  /**
   * 이 수정을 할 수 있는가. 규칙(categories 블록)과 같은 판정이다.
   * 공통(clientId 없음)은 settings.category.common, 전용은 settings.category + 담당.
   */
  function requireCategoryScope(me, clientId) {
    if (!clientId) {
      me.require('settings.category.common', '공통 분류 수정');
      return;
    }
    me.require('settings.category', '입주자 전용 분류 수정');
    me.requireSees(clientId);
  }

  /** 잠긴 달 색인. 문서가 없으면 잠긴 달이 없는 것으로 본다(백필 전 상태). */
  async function lockedMonths() {
    const snap = await db.collection(CONFIG).doc(LOCKED_MONTHS_DOC).get();
    return (snap.exists ? (snap.data() || {}).months : null) || {};
  }

  /** 쓰기를 400개씩 나눠 커밋한다. */
  async function commitInChunks(writes) {
    for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const w of writes.slice(i, i + BATCH_LIMIT)) batch.update(w.ref, w.data);
      await batch.commit();
    }
  }

  const saveCategory = callable('saveCategory', async (request) => {
    const me = await requireCaller(request.auth);
    const d = request.data || {};

    const type = String(d.type || '');
    if (type !== '지출' && type !== '수입') {
      throw new HttpsError('invalid-argument', '수입·지출 중 하나여야 합니다.');
    }
    const clientId = String(d.clientId || '').trim();
    const from = String(d.from || '').trim();
    const to = String(d.to || from).trim();
    const color = String(d.color || '').trim();

    if (!from) throw new HttpsError('invalid-argument', '바꿀 분류를 지정하세요.');
    if (!to) throw new HttpsError('invalid-argument', '분류 이름은 비울 수 없습니다.');
    if (to.length > MAX_NAME) {
      throw new HttpsError('invalid-argument', `분류 이름은 ${MAX_NAME}자까지입니다.`);
    }
    if (color && !COLOR_RE.test(color)) {
      throw new HttpsError('invalid-argument', '색상 형식이 올바르지 않습니다.');
    }
    // '확인필요' 는 판독·업로드가 분류를 정하지 못했을 때 넣는 자리다.
    // 이름이 바뀌면 그 자리를 가리키는 코드가 조용히 어긋난다.
    if (from === '확인필요' && to !== from) {
      throw new HttpsError('failed-precondition', '「확인필요」는 이름을 바꿀 수 없습니다.');
    }

    requireCategoryScope(me, clientId);

    const inScope = (data) => String((data || {}).clientId || '') === clientId;

    // 대상 분류 문서. 같은 이름이 여러 문서로 들어가 있을 수 있어 전부 고친다.
    const defsSnap = await db.collection(CATEGORIES)
      .where('keyword', '==', '').where('type', '==', type).where('category', '==', from).get();
    const defs = defsSnap.docs.filter(doc => inScope(doc.data()));
    if (!defs.length) throw new HttpsError('not-found', '분류를 찾을 수 없습니다.');

    const renaming = to !== from;
    if (renaming) {
      const clashSnap = await db.collection(CATEGORIES)
        .where('keyword', '==', '').where('type', '==', type).where('category', '==', to).get();
      if (clashSnap.docs.some(doc => inScope(doc.data()))) {
        throw new HttpsError('already-exists', `"${to}"는 이미 있는 분류입니다.`);
      }
    }

    const writes = [];
    const defPatch = { ...(renaming ? { category: to } : {}) };
    if (color) defPatch.color = color;
    else if (d.color === null) defPatch.color = FieldValue.delete();
    if (!Object.keys(defPatch).length) return { renamed: 0, rules: 0, transactions: 0, locked: 0 };
    for (const doc of defs) writes.push({ ref: doc.ref, data: defPatch });

    // 자동분류 규칙도 따라간다 — 빠뜨리면 다음 업로드가 사라진 이름으로 분류한다.
    let ruleCount = 0;
    if (renaming) {
      const rulesSnap = await db.collection(CATEGORIES)
        .where('type', '==', type).where('category', '==', from).get();
      for (const doc of rulesSnap.docs) {
        const data = doc.data() || {};
        if (!data.keyword || !inScope(data)) continue;
        writes.push({ ref: doc.ref, data: { category: to } });
        ruleCount += 1;
      }
    }

    // 거래. 공통 분류는 전 입주자에게 걸리지만, **같은 이름의 전용 분류를 가진
    // 입주자는 건드리지 않는다** — 그 거래는 다른 분류에 속한다.
    let trxCount = 0;
    let lockedCount = 0;
    if (renaming) {
      const months = await lockedMonths();
      let ownRename = new Set();
      if (!clientId) {
        const ownSnap = await db.collection(CATEGORIES)
          .where('keyword', '==', '').where('type', '==', type).where('category', '==', from).get();
        ownRename = new Set(ownSnap.docs
          .map(doc => String((doc.data() || {}).clientId || ''))
          .filter(Boolean));
      }

      let query = db.collection(TRANSACTIONS).where('category', '==', from);
      if (clientId) query = query.where('clientId', '==', clientId);
      const trxSnap = await query.get();
      for (const doc of trxSnap.docs) {
        const data = doc.data() || {};
        const cid = String(data.clientId || '');
        if (!clientId && ownRename.has(cid)) continue;   // 그 입주자의 전용 분류다
        if (months[lockKey(cid, data.date)] === true) { lockedCount += 1; continue; }
        writes.push({ ref: doc.ref, data: { category: to } });
        trxCount += 1;
      }
    }

    await commitInChunks(writes);
    logger.info('[saveCategory] 분류 수정', {
      actor: me.uid, type, clientId, from, to, trxCount, lockedCount,
    });
    return { renamed: renaming ? defs.length : 0, rules: ruleCount,
      transactions: trxCount, locked: lockedCount };
  });

  return { saveCategory };
};
