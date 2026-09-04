/**
 * services/firestore.js — Smart Care Ledger v2
 * Firebase SDK 핸들(fb/fdb)과 배치 쓰기 헬퍼.
 *
 * 각 모듈은 fb()로 SDK 함수를 받아 직접 쓴다. 이 파일이 제공하는 것은
 * 그 통로와, 500개 제한을 알아서 나눠 주는 배치 헬퍼뿐이다.
 */

'use strict';


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
  const { writeBatch, doc } = fb();
  // 500개씩 분할 처리
  for(let i=0;i<updates.length;i+=500){
    const chunk=updates.slice(i,i+500);
    const batch = writeBatch(fdb());
    chunk.forEach(({col, docId, data}) => {
      batch.update(doc(fdb(), col, docId), data);
    });
    await batch.commit();
  }
}

/** 다중 문서 삭제 (배치, 500개 단위 자동 분할) */
export async function batchDeleteDocs(deletes) {
  if(!deletes.length)return;
  const { writeBatch, doc } = fb();
  // 500개씩 분할 처리
  for(let i=0;i<deletes.length;i+=500){
    const chunk=deletes.slice(i,i+500);
    const batch = writeBatch(fdb());
    chunk.forEach(({col, docId}) => {
      batch.delete(doc(fdb(), col, docId));
    });
    await batch.commit();
  }
}

/** 다중 문서 추가 (배치, 500개 단위 자동 분할) */
export async function batchAddDocs(adds) {
  if(!adds.length)return [];
  const { writeBatch, collection, doc, serverTimestamp } = fb();
  const addedIds = [];
  // 500개씩 분할 처리
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
    await batch.commit();
  }
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
  const { writeBatch, doc } = fb();
  for(let i=0;i<items.length;i+=500){
    const chunk=items.slice(i,i+500);
    const batch = writeBatch(fdb());
    chunk.forEach(({col, docId, data}) => {
      batch.set(doc(fdb(), col, docId), data);
    });
    await batch.commit();
  }
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
    return addedIds;
  }

  // 500개 초과: 각 유형별로 분할 처리
  await batchUpdateDocs(updates);
  await batchDeleteDocs(deletes);
  const results=await batchAddDocs(adds);
  addedIds.push(...results);
  return addedIds;
}
