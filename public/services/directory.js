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
 * ⚠️ **방금 고친 것을 다시 읽을 때는 명부를 믿으면 안 된다.**
 *   명부(`directories/{name}`)를 다시 만드는 것은 **Firestore 트리거**이고
 *   비동기다. 분류 이름을 바꾸고 곧바로 다시 읽으면 트리거가 아직 안 돌아
 *   **바뀌기 전 이름이 그대로 온다** — 사용자에게는 "저장이 안 됐다"로 보이고,
 *   실제로 그렇게 보였다. 잠시 뒤 새로고침하면 낫는 것이 더 나쁘다: 무엇이
 *   저장됐는지 확인할 방법이 없다.
 *
 *   그래서 쓰기 직후의 조회는 `fresh` 로 명부를 건너뛴다. 값은 컬렉션이
 *   원본이므로 언제나 맞고, 비용은 그 한 번뿐이다(분류 60건·직원 25건).
 *   로그인처럼 **쓰기와 무관한** 조회는 그대로 명부 1건으로 읽는다.
 *
 * @param {string} name  DIRECTORIES 값
 * @param {string} col   폴백으로 읽을 컬렉션
 * @param {Object} [opts]
 * @param {boolean} [opts.fresh]  명부를 건너뛰고 컬렉션을 직접 읽는다
 * @returns {Promise<{rows:Array, reads:number, fromDirectory:boolean}>}
 */
async function loadWithFallback(name, col, opts = {}) {
  const { getDoc, getDocs, doc, collection } = fb();
  const db = fdb();

  if (!opts.fresh) {
    try {
      const snap = await getDoc(doc(db, DIRECTORY_COL, name));
      const rows = snap.exists() ? directoryToArray(snap.data()) : null;
      if (rows) return { rows, reads: 1, fromDirectory: true };
    } catch (e) {
      // 명부를 못 읽어도 앱은 떠야 한다. 조용히 직접 조회로 넘어간다.
      console.warn(`[directory] ${name} 조회 실패, 컬렉션을 직접 읽습니다:`, e);
    }
  }

  const snap = await getDocs(collection(db, col));
  return {
    rows: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    reads: snap.size,
    fromDirectory: false,
  };
}

/** 직원 명부. 비밀번호·해시는 명부에 들어 있지 않다(domain/directory.js 참고). */
export const fetchStaffDirectory = (opts) =>
  loadWithFallback(DIRECTORIES.STAFF, COLS.USERS, opts);

/** 분류·자동분류 규칙 명부. */
export const fetchCategoryDirectory = (opts) =>
  loadWithFallback(DIRECTORIES.CATEGORIES, COLS.CATEGORIES, opts);
