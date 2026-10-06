/**
 * services/firestore.js — Smart Care Ledger v2
 * Firebase SDK 핸들(fb/fdb)과 배치 쓰기 헬퍼.
 *
 * 각 모듈은 fb()로 SDK 함수를 받아 직접 쓴다. 이 파일이 제공하는 것은
 * 그 통로와, 500개 제한을 알아서 나눠 주는 배치 헬퍼뿐이다.
 */

'use strict';

import { S } from '../state.js';
import { COLS } from '../constants.js';

// ─────────────────────────────────────────────
// 보고서 전용 거래 캐시 — **쓰기가 버린다, 읽기가 아니라**
//
// 예전에는 loadTransactions 가 끝날 때마다 이 캐시를 버렸다. 이유가 뒤집혀
// 있었다 — 거래를 **다시 읽었다고** 보고서가 낡는 것이 아니라, 거래가
// **바뀌었을 때** 낡는다. 그래서 기간 필터만 바꿔도, 입주자를 전환했다
// 돌아와도 캐시가 날아갔고, 월초에 보고서를 네 번 열면 네 번 다 그 입주자의
// 전체 이력을 다시 읽었다.
//
// 배치 헬퍼가 자동으로 부르므로 엑셀·일괄삭제·순서변경·고정항목은 신경 쓸
// 것이 없다. updateDoc/addDoc 을 직접 쓰는 곳만 손으로 부른다
// (test/report-trx-cache.test.mjs 가 빠진 곳을 잡는다).
// ─────────────────────────────────────────────

/** 거래가 바뀌었다는 신호. 열려 있는 보고서가 스스로 다시 그리려고 듣는다. */
export const TRX_WRITE_EVENT = 'scl:trx-written';

/**
 * 거래가 바뀌었다 — 보고서 캐시를 버리고, 듣는 화면에 알린다.
 *
 * 알림을 여기 두는 이유: **모든 거래 쓰기 경로가 이미 이 함수를 지난다.**
 * 저장하는 쪽(폼·엑셀·일괄삭제)마다 콜백을 실로 꿰면 언젠가 한 곳을 빠뜨리고,
 * 그러면 보고서에서 고친 숫자가 화면에만 옛날 값으로 남는다.
 *
 * @param {string} [clientId] 알면 그 입주자 것만. 모르면 무조건 버린다(안전한 쪽).
 */
export function invalidateReportTrxCache(clientId, detail = {}) {
  if (!clientId || S.rptTrxCache?.clientId === clientId) S.rptTrxCache = null;
  if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent(TRX_WRITE_EVENT, {
      detail: { ...detail, clientId: clientId || '' },
    }));
  }
}

/** 배치 항목 중 거래 쓰기와 영향을 받은 입주자를 찾는다. */
function inspectBatch(...lists) {
  let hasTransactions = false;
  const clientIds = new Set();
  for (const list of lists) {
    for (const it of (list || [])) {
      if (!it || it.col !== COLS.TRANSACTIONS) continue;
      hasTransactions = true;
      const clientId = String(it.clientId || (it.data && it.data.clientId) || '');
      if (clientId) clientIds.add(clientId);
    }
  }
  return { hasTransactions, clientIds: [...clientIds] };
}

/** 성공한 커밋 뒤에만 거래 변경을 알린다. */
function noteBatch(info) {
  if (!info || !info.hasTransactions) return;
  invalidateReportTrxCache('', {
    clientIds: info.clientIds,
    forceRefresh: true,
  });
}

// ─────────────────────────────────────────────
// Firebase 헬퍼 (index.html에서 window._fb로 초기화됨)
// ─────────────────────────────────────────────
export function fb()  { return window._fb; }
export function fdb() { return window._fb.db; }

// ─────────────────────────────────────────────
// 범용 CRUD 래퍼는 삭제했다
//
// 여기에 범용 CRUD 6개 + 컬렉션별 래퍼 24개, 모두 30개(약 130줄)가 있었는데
// **한 곳에서도 호출되지 않았다.** 파일 주석은 "모든 모듈은 Firestore 접근 시
// 이 파일을 통한다"고 적혀 있었지만 실제로는 60여 곳이 fb()를 직접 쓴다.
// 지키지 않는 규약을 문서로 남겨두면 다음 사람이 그 말을 믿는다.
//
// 배치 헬퍼는 실제로 쓰이고, 500개 제한을 알아서 나눠 준다는 실질적인 값이 있다.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// 배치 작업 (Phase 1 최적화)
// ─────────────────────────────────────────────

/** 다중 문서 업데이트 (배치, 500개 단위 자동 분할) */
export async function batchUpdateDocs(updates) {
  if(!updates.length)return;
  const trxWrites = inspectBatch(updates);
  const { writeBatch, doc } = fb();
  let committed = false;
  // 500개씩 분할 처리
  try {
    for(let i=0;i<updates.length;i+=500){
      const chunk=updates.slice(i,i+500);
      const batch = writeBatch(fdb());
      chunk.forEach(({col, docId, data}) => {
        batch.update(doc(fdb(), col, docId), data);
      });
      await batch.commit(); committed = true;
    }
  } finally { if (committed) noteBatch(trxWrites); }
}

/** 다중 문서 삭제 (배치, 500개 단위 자동 분할) */
export async function batchDeleteDocs(deletes) {
  if(!deletes.length)return;
  const trxWrites = inspectBatch(deletes);
  const { writeBatch, doc } = fb();
  let committed = false;
  // 500개씩 분할 처리
  try {
    for(let i=0;i<deletes.length;i+=500){
      const chunk=deletes.slice(i,i+500);
      const batch = writeBatch(fdb());
      chunk.forEach(({col, docId}) => {
        batch.delete(doc(fdb(), col, docId));
      });
      await batch.commit(); committed = true;
    }
  } finally { if (committed) noteBatch(trxWrites); }
}

/** 다중 문서 추가 (배치, 500개 단위 자동 분할) */
export async function batchAddDocs(adds) {
  if(!adds.length)return [];
  const trxWrites = inspectBatch(adds);
  const { writeBatch, collection, doc, serverTimestamp } = fb();
  const addedIds = [];
  let committed = false;
  // 500개씩 분할 처리
  try {
    for(let i=0;i<adds.length;i+=500){
      const chunk=adds.slice(i,i+500);
      const batch = writeBatch(fdb());
      chunk.forEach(({col, data}) => {
        const ref = doc(collection(fdb(), col));
        addedIds.push(ref.id);
        batch.set(ref, {
          ...data,
          createdAt: serverTimestamp ? serverTimestamp() : Date.now(),
        });
      });
      await batch.commit(); committed = true;
    }
  } finally { if (committed) noteBatch(trxWrites); }
  return addedIds;
}

/**
 * 문서 ID를 지정해 다중 저장 (배치, 500개 단위 자동 분할).
 *
 * batchAddDocs와 달리 ID를 호출부가 정하므로 **같은 작업을 다시 돌려도
 * 같은 문서에 덮어쓴다.** 연도 마감처럼 중간에 끊길 수 있는 작업에서
 * 재시도가 사본을 복제하지 않도록 하는 데 쓴다.
 */
export async function batchSetDocs(items) {
  if(!items.length)return;
  const trxWrites = inspectBatch(items);
  const { writeBatch, doc } = fb();
  let committed = false;
  try {
    for(let i=0;i<items.length;i+=500){
      const chunk=items.slice(i,i+500);
      const batch = writeBatch(fdb());
      chunk.forEach(({col, docId, data}) => {
        batch.set(doc(fdb(), col, docId), data);
      });
      await batch.commit(); committed = true;
    }
  } finally { if (committed) noteBatch(trxWrites); }
}

/** 복합 배치 작업 (추가/수정/삭제 동시, 500개 단위 자동 분할) */
export async function batchMixedOps(operations) {
  const { writeBatch, doc, collection, serverTimestamp } = fb();
  const addedIds = [];
  const updates = operations.updates || [];
  const deletes = operations.deletes || [];
  const adds = operations.adds || [];
  const totalOps = updates.length + deletes.length + adds.length;

  if(!totalOps)return addedIds;
  const trxWrites = inspectBatch(updates, deletes, adds);

  // 총 작업이 500개 이하면 한 번에 처리
  if(totalOps<=500){
    const batch = writeBatch(fdb());
    updates.forEach(({col, docId, data}) => {
      batch.update(doc(fdb(), col, docId), data);
    });
    deletes.forEach(({col, docId}) => {
      batch.delete(doc(fdb(), col, docId));
    });
    adds.forEach(({col, data}) => {
      const ref = doc(collection(fdb(), col));
      addedIds.push(ref.id);
      batch.set(ref, {
        ...data,
        createdAt: serverTimestamp ? serverTimestamp() : Date.now(),
      });
    });
    await batch.commit();
    noteBatch(trxWrites);
    return addedIds;
  }

  // 500개 초과: 각 유형별로 분할 처리
  await batchUpdateDocs(updates);
  await batchDeleteDocs(deletes);
  const results=await batchAddDocs(adds);
  addedIds.push(...results);
  // 500개 초과 경로는 각 하위 헬퍼가 성공한 커밋 뒤에 알린다.
  return addedIds;
}
