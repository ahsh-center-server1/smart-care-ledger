'use strict';

/**
 * 자산이동 — 두 계좌 사이의 이체. **다리가 하나뿐인 상태를 만들지 않는다.**
 *
 * 이 기능의 역사가 왜 서버여야 하는지를 말해 준다. 예전에는 세 가지 방식으로
 * 한쪽만 남는 상태가 만들어졌다(modals.js 의 옛 주석):
 *
 *   1. 생성이 addDoc → addDoc → updateDoc 3회 연속 쓰기였다. 두 번째에서
 *      끊기면 출금만 남고 입금이 없다 — 장부에서 돈이 증발한다.
 *   2. 지출 → 자산이동으로 바꿀 때 상대편을 못 찾으면 토스트만 띄우고
 *      그대로 저장했다.
 *   3. 자산이동 → 지출로 바꾸면 linkedTrxId 가 남아 짝이 어긋났다.
 *
 * 브라우저 판은 1·3 을 writeBatch 로 고쳤지만 한 곳이 남아 있었다:
 * **상대편을 찾는 쿼리가 배치 밖에 있다.** 두 사람이 같은 순간 각자의 거래를
 * 자산이동으로 바꾸면 둘 다 같은 상대편을 발견해 서로를 덮어쓴다.
 * 여기서는 그 조회까지 트랜잭션 안에 있다.
 *
 * 그리고 계좌가 정말 그 입주자의 것인지도 서버가 본다. 규칙은 문서 하나만
 * 보므로 "이 accountId 가 이 clientId 에 속하는가"를 확인할 수 없다.
 */

const TRANSACTIONS = 'transactions';
const ACCOUNTS = 'accounts';
const CONFIG = 'config';
const LOCKED_MONTHS_DOC = 'lockedMonths';

const TYPE = '자산이동';

module.exports = function transferFns(ctx) {
  const { db, callable, requireCaller, HttpsError, logger, FieldValue } = ctx;

  /** 계좌가 실제로 그 입주자의 것인지 확인한다. 규칙이 볼 수 없는 관계다. */
  function assertAccountOf(accSnap, accountId, what) {
    if (!accSnap.exists) throw new HttpsError('not-found', `${what} 계좌를 찾을 수 없습니다.`);
    return String((accSnap.data() || {}).clientId || '');
  }

  // 우회는 없다. 예전에는 여기서 lock.bypass 로 빠져나갔지만 그 권한은
  // 아무에게도 없고(FORBIDDEN_KEYS) firestore.rules 의 editableMonth 에도
  // 우회가 없다. 검사만 남겨 두면 "관리자는 되겠지"로 읽혀 오해를 만든다.
  function assertOpenMonth(months, clientId, date) {
    if (months[`${clientId}_${String(date).slice(0, 7)}`] === true) {
      throw new HttpsError('failed-precondition',
        `${String(date).slice(0, 7)}은 최종 결재가 끝난 월입니다.`);
    }
  }

  const saveTransfer = callable('saveTransfer', async (request) => {
    const me = await requireCaller(request.auth);
    me.require('trx.transfer', '자산이동');

    const d = request.data || {};
    const fromAccountId = String(d.fromAccountId || '').trim();
    const toAccountId = String(d.toAccountId || '').trim();
    const date = String(d.date || '').trim();
    const amount = Math.abs(Number(d.amount) || 0);
    const existId = String(d.existId || '').trim();

    if (!fromAccountId || !toAccountId) {
      throw new HttpsError('invalid-argument', '출금·입금 계좌를 모두 선택하세요.');
    }
    if (fromAccountId === toAccountId) {
      throw new HttpsError('invalid-argument', '같은 계좌로는 이동할 수 없습니다.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpsError('invalid-argument', '날짜가 올바르지 않습니다.');
    }
    if (!amount) throw new HttpsError('invalid-argument', '금액이 올바르지 않습니다.');

    const base = {
      date,
      time: String(d.time || ''),
      type: TYPE,
      category: TYPE,
      description: String(d.description || ''),
      linkedAccountId: '',
    };

    return db.runTransaction(async (tx) => {
      // ── 읽기 (트랜잭션은 모든 읽기가 모든 쓰기보다 앞서야 한다) ──
      const fromRef = db.collection(ACCOUNTS).doc(fromAccountId);
      const toRef = db.collection(ACCOUNTS).doc(toAccountId);
      const lockRef = db.collection(CONFIG).doc(LOCKED_MONTHS_DOC);
      const [fromSnap, toSnap, lockSnap] = await Promise.all([
        tx.get(fromRef), tx.get(toRef), tx.get(lockRef),
      ]);
      const months = (lockSnap.exists ? (lockSnap.data() || {}).months : null) || {};
      const fromClient = assertAccountOf(fromSnap, fromAccountId, '출금');
      const toClient = assertAccountOf(toSnap, toAccountId, '입금');

      // 양쪽 입주자 모두 담당 범위 안이어야 한다. 한쪽만 보면 담당 밖
      // 입주자의 장부에 거래를 밀어 넣을 수 있다.
      me.requireSees(fromClient);
      me.requireSees(toClient);
      assertOpenMonth(months, fromClient, date);
      assertOpenMonth(months, toClient, date);

      let existing = null;
      if (existId) {
        const snap = await tx.get(db.collection(TRANSACTIONS).doc(existId));
        if (!snap.exists) throw new HttpsError('not-found', '수정할 거래를 찾을 수 없습니다.');
        existing = { id: existId, ...snap.data() };
        if (String(existing.clientId) !== fromClient) {
          throw new HttpsError('failed-precondition', '출금 계좌가 그 거래의 입주자와 다릅니다.');
        }
        assertOpenMonth(months, existing.clientId, existing.date);
      }

      // 이미 짝이 있으면 그 짝을 그대로 쓴다. 없으면 같은 날짜·금액의
      // 후보를 찾는다 — 이 조회가 트랜잭션 안에 있는 것이 요점이다.
      let mate = null;
      if (existing && existing.linkedTrxId) {
        const snap = await tx.get(db.collection(TRANSACTIONS).doc(existing.linkedTrxId));
        if (snap.exists) mate = { id: existing.linkedTrxId, ...snap.data() };
      } else if (existing) {
        const q = db.collection(TRANSACTIONS)
          .where('clientId', '==', toClient)
          .where('accountId', '==', toAccountId)
          .where('date', '==', date);
        const found = (await tx.get(q)).docs
          .map((x) => ({ id: x.id, ...x.data() }))
          .filter((x) => x.id !== existId && x.type !== TYPE
            && Number(x.amountIn || 0) === amount && Number(x.amountOut || 0) === 0);
        if (found.length > 1) {
          throw new HttpsError('failed-precondition',
            `입금 계좌에 같은 날짜·금액 거래가 ${found.length}건 있습니다. `
            + '어느 것이 상대편인지 알 수 없으니 입금 계좌에서 먼저 정리한 뒤 다시 시도하세요.');
        }
        if (found.length === 1) mate = found[0];
      }

      // ── 쓰기 ──
      const outRef = existing
        ? db.collection(TRANSACTIONS).doc(existId)
        : db.collection(TRANSACTIONS).doc();
      const inRef = mate
        ? db.collection(TRANSACTIONS).doc(mate.id)
        : db.collection(TRANSACTIONS).doc();

      const outData = {
        ...base,
        clientId: fromClient,
        accountId: fromAccountId,
        amountIn: 0,
        amountOut: amount,
        linkedAccountId: toAccountId,
        linkedTrxId: inRef.id,
        // 작성자는 서버가 정한다. 수정이면 원래 작성자를 지킨다 —
        // 남의 거래를 손대면서 자기 것으로 만들 수 없다.
        createdBy: (existing && existing.createdBy) || me.uid,
      };
      const inData = {
        ...base,
        clientId: toClient,
        accountId: toAccountId,
        amountIn: amount,
        amountOut: 0,
        linkedAccountId: fromAccountId,
        linkedTrxId: outRef.id,
        createdBy: (mate && mate.createdBy) || me.uid,
      };

      if (existing) tx.update(outRef, outData);
      else tx.set(outRef, { ...outData, createdAt: FieldValue.serverTimestamp() });

      if (mate) tx.update(inRef, inData);
      else tx.set(inRef, { ...inData, createdAt: FieldValue.serverTimestamp() });

      logger.info('[saveTransfer]', {
        by: me.uid, from: fromAccountId, to: toAccountId, amount,
        mode: existing ? (mate ? '연결' : '상대편 생성') : '신규',
      });
      return {
        outId: outRef.id,
        inId: inRef.id,
        linkedExisting: !!mate && !!existing,
        createdMate: !!existing && !mate,
      };
    });
  });

  return { saveTransfer };
};
