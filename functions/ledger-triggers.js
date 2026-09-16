'use strict';

/**
 * functions/ledger-triggers.js — 잔액 재계산 · 마감 월 색인
 *
 * index.js 에서 떼어 왔다. 그 파일은 600줄 상한을 넘겼고
 * test/architecture.test.mjs 가 "기능을 더할 곳이 아니라 쪼갤 곳"이라고 말한다.
 * 예외 목록의 주석이 지목한 갈래(auth / balance / triggers / ai) 중 하나다.
 *
 * 여기 있는 것들의 공통점: **인증과 아무 관계가 없다.** 거래가 바뀌면 계좌
 * 잔액을 다시 계산하고, 보고서 상태가 바뀌면 마감 월 색인을 갱신한다.
 * 둘 다 Admin SDK 라 규칙을 우회하며, 그것이 이 계산을 서버에 둔 이유다.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { calcAccountBalance, affectsBalance } = require('./balance.cjs');

module.exports = function ledgerTriggers(ctx) {
  const { db, callable, requireCaller } = ctx;

  // ─────────────────────────────────────────────────────────────
  // syncAccountBalance — 거래가 바뀌면 계좌 currentBalance를 서버에서 재계산
  //
  // 왜 서버인가
  //   기존에는 클라이언트 updateAccBalance가 부분 로드된 S.transactions(기본 당월)로
  //   계산해 currentBalance를 덮어썼다. 그래서 거래를 하나만 저장해도 이전 기록이
  //   사라졌다. 게다가 입력자는 보안 규칙상 계좌 전체 거래를 읽을 수 없어
  //   클라이언트에서는 애초에 올바른 계산이 불가능하다.
  //
  //   서버에서 계산하면 역할과 무관하게 항상 전체 거래를 근거로 하고,
  //   "잔액 계산 → 거래 저장" 순서 뒤바뀜 문제도 함께 사라진다.
  // ─────────────────────────────────────────────────────────────

  const TRANSACTIONS = 'transactions';
  const ACCOUNTS = 'accounts';

  /**
   * 한 계좌의 currentBalance를 전체 거래 기준으로 다시 쓴다.
   *
   * 멱등하다 — 트리거가 중복 발동해도 같은 값이 나온다. 그래서 증분 갱신
   * (FieldValue.increment)을 쓰지 않는다. 중복 발동 한 번에 금액이 어긋나면
   * 금전 장부로서 신뢰를 잃는다.
   *
   * 읽기 범위
   *   기준일(initialBalanceDate)이 있으면 그 이후 거래만 읽는다. 잔액식이 어차피
   *   `date <= base`를 버리므로 결과는 동일하고, 과거 연도가 쌓인 계좌에서
   *   읽는 문서 수가 크게 줄어든다. (복합 인덱스 accountId+date 사용)
   */
  async function recalcAccount(accountId) {
  if (!accountId) return;
  const accRef = db.collection(ACCOUNTS).doc(accountId);
  const accSnap = await accRef.get();
  if (!accSnap.exists) return;

  const account = { id: accountId, ...accSnap.data() };
  let q = db.collection(TRANSACTIONS).where('accountId', '==', accountId);
  const base = account.initialBalanceDate || '';
  if (base) q = q.where('date', '>', base);
  const trxSnap = await q.get();
  const transactions = trxSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const balance = calcAccountBalance(account, transactions);
  if (Number(account.currentBalance || 0) === balance) return;   // 변화 없으면 쓰지 않는다
  await accRef.update({ currentBalance: balance });
  }

  const syncAccountBalance = onDocumentWritten(
  { document: 'transactions/{trxId}' },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();

    // 잔액식이 읽는 필드가 하나도 안 바뀌었으면 계좌 문서조차 읽지 않고 끝낸다.
    // 영수증 첨부·카테고리 인라인 수정·드래그 순서 변경이 여기서 걸러진다 —
    // 이들이 가장 흔한 쓰기이므로 이 한 줄이 읽기량을 크게 줄인다.
    if (!affectsBalance(before, after)) return;

    // 계좌가 바뀐 수정이면 양쪽 모두 다시 계산해야 한다.
    const affected = new Set();
    if (before && before.accountId) affected.add(before.accountId);
    if (after && after.accountId) affected.add(after.accountId);
    if (!affected.size) return;

    // 잔액 갱신 실패가 거래 저장을 되돌리지는 않는다. 실패는 로그로 남기고
    // tools/recalc-balances.mjs로 언제든 바로잡을 수 있다.
    for (const accountId of affected) {
      try {
        await recalcAccount(accountId);
      } catch (err) {
        console.error(`[syncAccountBalance] 계좌 ${accountId} 재계산 실패:`, err);
      }
    }
  }
  );

  /**
   * 계좌의 기초잔액·기준일이 바뀌면 currentBalance를 다시 계산한다.
   *
   * 필요한 이유
   *   거래 트리거만으로는 부족하다. 계좌 등록·수정 폼(modals.js)과 연도 마감
   *   (settings.js)이 currentBalance를 직접 쓰는데, 그 시점에는 거래가 변하지 않으므로
   *   syncAccountBalance가 발동하지 않는다. 특히 계좌 정보를 수정하면
   *   currentBalance가 기초잔액으로 되돌아간 채 남는다.
   *
   * 무한 루프 방지
   *   이 트리거 자신이 쓰는 값은 currentBalance뿐이다. 따라서 initialBalance나
   *   initialBalanceDate가 실제로 바뀐 경우에만 재계산하고, 그 외에는 즉시 반환한다.
   */
  const syncAccountOnSettingsChange = onDocumentWritten(
  { document: 'accounts/{accountId}' },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!after) return;                       // 삭제된 계좌는 계산할 것이 없다

    const baseChanged =
      !before ||
      Number(before.initialBalance || 0) !== Number(after.initialBalance || 0) ||
      (before.initialBalanceDate || '') !== (after.initialBalanceDate || '');

    if (!baseChanged) return;                 // currentBalance만 바뀐 경우 = 이 트리거 자신의 쓰기

    try {
      await recalcAccount(event.params.accountId);
    } catch (err) {
      console.error(
        `[syncAccountOnSettingsChange] 계좌 ${event.params.accountId} 재계산 실패:`,
        err
      );
    }
  }
  );

  // ─────────────────────────────────────────────────────────────
  // syncLockedMonths — 마감(최종 결재 완료) 월 색인을 유지한다
  //
  // 왜 필요한가
  //   마감 여부는 모든 역할이 알아야 한다 — 입력자도 마감된 달에는 거래를 넣을 수
  //   없어야 한다. 그런데 앱은 그 정보를 reports 컬렉션을 조회해서 만들고 있었고,
  //   보안 규칙은 reports를 담당자(등급 2) 이상만 읽게 한다. 그래서 입력자가
  //   로그인하면 그 조회가 거부되고 Promise.all이 깨져 **앱 초기화가 통째로 실패**했다
  //   (화면이 빈 채로 멈춘다). 규칙을 적용한 뒤에야 드러나는 문제였다.
  //
  //   금액·의견 없이 "어느 (입주자, 월)이 잠겼는지"만 담은 문서를 두면 전원 조회를
  //   허용해도 안전하고, 조회가 쿼리 대신 문서 1건 읽기라 읽기량도 줄어든다.
  //
  //   클라이언트는 규칙상 config를 쓸 수 없다(관리자 예외뿐). 이 트리거만 Admin SDK로
  //   갱신하므로 잠금을 위조해 풀 수 없다.
  // ─────────────────────────────────────────────────────────────
  const {
  LOCKED_MONTHS_DOC,
  buildLockIndex,
  } = require('./locked-months.cjs');

  const CONFIG = 'config';
  const REPORTS = 'reports';

  /**
   * rebuildLockedMonths — 색인을 reports 전체에서 다시 만든다.
   *
   * 쓰는 때
   *   · 마이그레이션 직후 최초 백필 (트리거는 그때부터의 변경만 본다)
   *   · 트리거가 실패해 색인이 어긋났을 때 복구
   *
   * 전체 스캔이므로 관리자만, 그리고 사람이 눌러야 돈다.
   */
  const rebuildLockedMonths = callable('rebuildLockedMonths', async (request) => {
    // 관리자 전용 복구 작업이다. 등급 리터럴(99) 대신 카탈로그 키로 판정한다 —
    // settings.reset 은 관리자 전용이고 보안 하한이 걸려 설정에서 낮출 수 없다.
    const me = await requireCaller(request.auth);
    me.require('settings.reset', '마감 색인 재생성');

  const snap = await db.collection(REPORTS).where('status', '==', 'confirmed').get();
  const months = buildLockIndex(snap.docs.map((d) => d.data()));

  // set(merge 없이)으로 통째로 교체한다 — 지워져야 할 낡은 키가 남지 않게.
  await db.collection(CONFIG).doc(LOCKED_MONTHS_DOC).set({
    months,
    updatedAt: new Date().toISOString(),
    rebuiltBy: request.auth.uid,
  });

  return { count: Object.keys(months).length };
  });

  return {
    syncAccountBalance, syncAccountOnSettingsChange,
    rebuildLockedMonths,
  };
};
