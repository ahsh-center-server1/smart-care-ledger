// public/domain/directory.js
//
// 파생 명부의 형태 — 순수 함수. DOM·Firestore를 모른다.
//
// ⚠️ functions/directories.cjs와 **같은 형식**이어야 한다.
//    test/directories.test.mjs가 양쪽을 대조하므로 한쪽만 고치면 실패한다.
//
// 왜 두 벌인가
//   브라우저는 public/ 안의 ESM만 로드할 수 있고, Cloud Functions 번들에는
//   functions/ 만 들어간다. 같은 파일을 양쪽에서 쓸 방법이 없으므로,
//   대신 **테스트가 두 벌이 같은지 확인한다.**

'use strict';

/**
 * 명부 형태가 바뀌면 올린다. 버전이 다르면 명부를 무시하고 컬렉션을 직접 읽는다 —
 * 필드가 늘어났을 때 낡은 명부가 그 필드를 비운 채로 화면에 나가는 것을 막는다.
 */
export const DIRECTORY_SCHEMA_VERSION = 1;

/**
 * 명부에 실리는 직원 필드. **이 목록에 없는 값은 브라우저로 나가지 않는다.**
 * 비밀번호·해시·시크릿을 절대 추가하지 말 것.
 */
export const STAFF_FIELDS = ['userId', 'name', 'role', 'team', 'active', 'approved', 'isAdmin'];

/** 명부에 실리는 분류 필드. 자동분류 규칙도 같은 컬렉션에 있다. */
export const CATEGORY_FIELDS = ['keyword', 'type', 'category', 'subcategory', 'clientId', 'sortOrder'];

/** 명부 문서 이름. */
export const DIRECTORIES = { STAFF: 'staff', CATEGORIES: 'categories' };

/**
 * 명부를 그대로 써도 되는가.
 *
 * 형태가 어긋나면 false — 호출부는 컬렉션을 직접 읽는 쪽으로 떨어진다.
 * 즉 트리거가 배포되지 않았거나 실패해도 **화면은 항상 맞는다.** 읽기만 안 준다.
 * 이 성질이 없으면 명부 도입은 곧 "가끔 직원이 안 보이는" 위험이 된다.
 */
export function isDirectoryUsable(docData) {
  if (!docData) return false;
  if (Number(docData.schemaVersion) !== DIRECTORY_SCHEMA_VERSION) return false;
  if (!docData.entries || typeof docData.entries !== 'object') return false;
  return true;
}

/** 명부 문서 → `[{id, ...fields}]` (앱이 쓰는 배열 형태). */
export function directoryToArray(docData) {
  if (!isDirectoryUsable(docData)) return null;
  return Object.entries(docData.entries).map(([id, v]) => ({ id, ...v }));
}
