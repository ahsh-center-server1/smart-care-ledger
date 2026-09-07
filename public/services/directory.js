// public/services/directory.js
//
// 파생 명부 읽기 — 명부 우선, 없거나 형태가 어긋나면 컬렉션 직접 조회.
//
// 읽기 비용
//   명부가 맞으면 **문서 1건**이다(예전에는 컬렉션 전체).
//   직원 25명 + 분류 60개 = 85 읽기가 2 읽기가 된다. 로그인마다 걸리던 비용이다.
//
// 정확성
//   명부가 없거나 낡으면 **컬렉션 직접 조회로 떨어진다.** 트리거가 배포되지
//   않았거나 실패해도 화면 값은 항상 맞는다 — 읽기만 줄지 않는다.
//   이 성질이 없으면 "가끔 직원이 안 보이는" 위험이 된다.

'use strict';

import { COLS } from '../constants.js';
import { fb, fdb } from './firestore.js';
import { DIRECTORIES, directoryToArray } from '../domain/directory.js';

/** 명부 컬렉션 이름. Firestore 규칙에서 서버 전용으로 잠겨 있다. */
const DIRECTORY_COL = 'directories';

/**
 * 명부 문서 하나를 읽고, 못 쓰면 컬렉션을 직접 읽는다.
 *
 * @param {string} name  DIRECTORIES 값
 * @param {string} col   폴백으로 읽을 컬렉션
 * @returns {Promise<{rows:Array, reads:number, fromDirectory:boolean}>}
 */
async function loadWithFallback(name, col) {
  const { getDoc, getDocs, doc, collection } = fb();
  const db = fdb();

  try {
    const snap = await getDoc(doc(db, DIRECTORY_COL, name));
    const rows = snap.exists() ? directoryToArray(snap.data()) : null;
    if (rows) return { rows, reads: 1, fromDirectory: true };
  } catch (e) {
    // 명부를 못 읽어도 앱은 떠야 한다. 조용히 직접 조회로 넘어간다.
    console.warn(`[directory] ${name} 조회 실패, 컬렉션을 직접 읽습니다:`, e);
  }

  const snap = await getDocs(collection(db, col));
  return {
    rows: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    reads: snap.size,
    fromDirectory: false,
  };
}

/** 직원 명부. 비밀번호·해시는 명부에 들어 있지 않다(domain/directory.js 참고). */
export const fetchStaffDirectory = () =>
  loadWithFallback(DIRECTORIES.STAFF, COLS.USERS);

/** 분류·자동분류 규칙 명부. */
export const fetchCategoryDirectory = () =>
  loadWithFallback(DIRECTORIES.CATEGORIES, COLS.CATEGORIES);
