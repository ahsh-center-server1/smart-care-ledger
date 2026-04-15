/**
 * services/firestore.js — Smart Care Ledger v2
 * Firebase / Firestore 접근 헬퍼 및 컬렉션별 CRUD 래퍼
 * 모든 모듈은 Firestore 접근 시 이 파일을 통한다.
 */

'use strict';

import { COLS } from '../constants.js';

// ─────────────────────────────────────────────
// Firebase 헬퍼 (index.html에서 window._fb로 초기화됨)
// ─────────────────────────────────────────────
export function fb()  { return window._fb; }
export function fdb() { return window._fb.db; }

// ─────────────────────────────────────────────
// 공통 쿼리 헬퍼
// ─────────────────────────────────────────────

/** 컬렉션 전체 조회 */
export async function getAll(colName) {
  const { getDocs, collection } = fb();
  const snap = await getDocs(collection(fdb(), colName));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** 단일 조건 필터 조회 */
export async function getWhere(colName, field, op, value) {
  const { getDocs, collection, query, where } = fb();
  const snap = await getDocs(query(collection(fdb(), colName), where(field, op, value)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** 문서 추가 (자동 ID) */
export async function addDoc_(colName, data) {
  const { addDoc, collection, serverTimestamp } = fb();
  const ref = await addDoc(collection(fdb(), colName), {
    ...data,
    createdAt: serverTimestamp ? serverTimestamp() : Date.now(),
  });
  return ref.id;
}

/** 문서 업데이트 (부분) */
export async function updateDoc_(colName, docId, data) {
  const { updateDoc, doc } = fb();
  await updateDoc(doc(fdb(), colName, docId), data);
}

/** 문서 삭제 */
export async function deleteDoc_(colName, docId) {
  const { deleteDoc, doc } = fb();
  await deleteDoc(doc(fdb(), colName, docId));
}

/** 문서 set (전체 덮어쓰기) */
export async function setDoc_(colName, docId, data) {
  const { setDoc, doc } = fb();
  await setDoc(doc(fdb(), colName, docId), data);
}

// ─────────────────────────────────────────────
// 컬렉션별 래퍼 (B단계: 기존 호출 패턴 유지)
// ─────────────────────────────────────────────

export async function fetchUsers()      { return getAll(COLS.USERS); }
export async function fetchClients()    { return getAll(COLS.CLIENTS); }
export async function fetchAccounts()   { return getAll(COLS.ACCOUNTS); }
export async function fetchCategories() { return getAll(COLS.CATEGORIES); }
export async function fetchReports()    { return getAll(COLS.REPORTS); }

export async function fetchTransactionsByClient(clientId) {
  return getWhere(COLS.TRANSACTIONS, 'clientId', '==', clientId);
}

export async function saveTransaction(data) {
  return addDoc_(COLS.TRANSACTIONS, data);
}

export async function updateTransaction(id, data) {
  return updateDoc_(COLS.TRANSACTIONS, id, data);
}

export async function removeTransaction(id) {
  return deleteDoc_(COLS.TRANSACTIONS, id);
}

export async function saveReport(data) {
  return addDoc_(COLS.REPORTS, data);
}

export async function updateReport(id, data) {
  return updateDoc_(COLS.REPORTS, id, data);
}

export async function removeReport(id) {
  return deleteDoc_(COLS.REPORTS, id);
}

export async function saveCategory(data) {
  return addDoc_(COLS.CATEGORIES, data);
}

export async function updateCategory(id, data) {
  return updateDoc_(COLS.CATEGORIES, id, data);
}

export async function removeCategory(id) {
  return deleteDoc_(COLS.CATEGORIES, id);
}

export async function saveAccount(data) {
  return addDoc_(COLS.ACCOUNTS, data);
}

export async function updateAccount(id, data) {
  return updateDoc_(COLS.ACCOUNTS, id, data);
}

export async function removeAccount(id) {
  return deleteDoc_(COLS.ACCOUNTS, id);
}

export async function saveClient(data) {
  return addDoc_(COLS.CLIENTS, data);
}

export async function updateClient(id, data) {
  return updateDoc_(COLS.CLIENTS, id, data);
}

export async function removeClient(id) {
  return deleteDoc_(COLS.CLIENTS, id);
}

export async function saveUser(data) {
  return addDoc_(COLS.USERS, data);
}

export async function updateUser(id, data) {
  return updateDoc_(COLS.USERS, id, data);
}

export async function removeUser(id) {
  return deleteDoc_(COLS.USERS, id);
}
