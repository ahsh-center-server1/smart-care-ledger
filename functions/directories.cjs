'use strict';

/**
 * 파생 명부 — 로그인 한 번에 컬렉션 전체를 읽지 않기 위한 문서.
 *
 * 무엇이 문제였나
 *   로그인하면 users·clients·accounts·categories를 **where도 limit도 없이**
 *   통째로 읽었다. 직원 25명·분류 60개면 그것만으로 한 세션에 85 읽기이고,
 *   전 역할·전 세션에 걸린다. 사용자가 늘면 그대로 무료 한도에 부딪힌다.
 *
 *   users는 읽기 비용만의 문제도 아니었다. 예전에는 그 문서에 **평문 비밀번호가
 *   들어 있었고 모든 브라우저로 전송됐다.** 지금은 해시가 userSecrets로 분리돼
 *   있지만, "필드를 명시해서 담는다"는 규율 자체가 그런 사고를 구조적으로 막는다.
 *   아래 STAFF_FIELDS에 없는 값은 어떤 경우에도 명부에 실리지 않는다.
 *
 * 왜 증분이 아니라 매번 통째로 다시 만드는가
 *   증분 갱신(merge)은 두 가지 함정이 있다.
 *     · merge는 맵을 **깊게** 병합한다 — 비워진 선택 필드가 남는다.
 *       지우려면 명시적으로 FieldValue.delete()를 넣어야 하고, 하나만 빠뜨려도
 *       명부에 유령 값이 남는다.
 *     · merge는 문서를 **생성한다** — 1건짜리 조각이 전체 명부로 위장한다.
 *
 *   이 두 컬렉션은 작다(직원 수십 명, 분류 수십 개). 그래서 쓰기가 있을 때마다
 *   전체를 다시 읽어 통째로 덮어쓴다. 드리프트가 **구조적으로** 불가능해지고,
 *   대신 직원·분류를 한 번 고칠 때 서버에서 수십 건을 읽는다. 이 컬렉션들은
 *   거의 바뀌지 않으므로 그 비용이 로그인마다 내던 비용보다 훨씬 싸다.
 *
 *   clients·accounts는 이 방식을 쓰지 않는다 — 아래 주석 참고.
 *
 * ⚠️ public/services/directory.js와 **같은 형식**이어야 한다.
 *    test/directories.test.mjs가 양쪽을 대조한다.
 */

/**
 * 명부 형태가 바뀌면 올린다. 브라우저는 버전이 다르면 명부를 무시하고
 * 컬렉션을 직접 읽는다 — 필드가 늘어났을 때 낡은 명부가 그 필드를 비운 채로
 * 화면에 나가는 것을 막는다.
 */
const DIRECTORY_SCHEMA_VERSION = 1;

/**
 * 명부에 실을 직원 필드. **이 목록에 없는 값은 나가지 않는다.**
 *
 * 비밀번호·해시·시크릿을 여기에 절대 추가하지 말 것.
 * test/directories.test.mjs가 그런 이름이 끼어들면 실패시킨다.
 */
const STAFF_FIELDS = ['userId', 'name', 'role', 'team', 'active', 'approved', 'isAdmin'];

/** 명부에 실을 분류 필드. 자동분류 규칙도 같은 컬렉션에 있다. */
const CATEGORY_FIELDS = ['keyword', 'type', 'category', 'subcategory', 'clientId', 'sortOrder'];

/** 명부 문서 이름. */
const DIRECTORIES = { STAFF: 'staff', CATEGORIES: 'categories' };

/** 지정한 필드만 뽑는다. 없는 필드는 넣지 않는다(문서 크기 절약). */
function pick(data, fields) {
  const out = {};
  for (const f of fields) {
    if (data && data[f] !== undefined) out[f] = data[f];
  }
  return out;
}

/**
 * `[{id, data}]` → 명부 문서.
 *
 * @param {Array<{id:string, data:Object}>} docs
 * @param {string[]} fields
 * @param {number} [now]
 */
function buildDirectory(docs, fields, now = Date.now()) {
  const entries = {};
  for (const d of (docs || [])) {
    if (!d || !d.id) continue;
    entries[d.id] = pick(d.data, fields);
  }
  return {
    entries,
    count: Object.keys(entries).length,
    schemaVersion: DIRECTORY_SCHEMA_VERSION,
    rebuiltAt: new Date(now).toISOString(),
  };
}

const buildStaffDirectory = (docs, now) => buildDirectory(docs, STAFF_FIELDS, now);
const buildCategoryDirectory = (docs, now) => buildDirectory(docs, CATEGORY_FIELDS, now);

/**
 * 명부를 그대로 써도 되는가 (브라우저·서버 공통 판정).
 *
 * 형태가 어긋나면 false — 호출부는 컬렉션을 직접 읽는 쪽으로 떨어진다.
 * 즉 트리거가 배포되지 않았거나 실패해도 **화면은 항상 맞는다.** 읽기만 안 준다.
 * 이 성질이 없으면 명부 도입은 곧 "가끔 직원이 안 보이는" 위험이 된다.
 */
function isDirectoryUsable(docData) {
  if (!docData) return false;
  if (Number(docData.schemaVersion) !== DIRECTORY_SCHEMA_VERSION) return false;
  if (!docData.entries || typeof docData.entries !== 'object') return false;
  return true;
}

/** 명부 문서 → `[{id, ...fields}]` (앱이 쓰는 배열 형태). */
function directoryToArray(docData) {
  if (!isDirectoryUsable(docData)) return null;
  return Object.entries(docData.entries).map(([id, v]) => ({ id, ...v }));
}

module.exports = {
  DIRECTORY_SCHEMA_VERSION, STAFF_FIELDS, CATEGORY_FIELDS, DIRECTORIES,
  buildDirectory, buildStaffDirectory, buildCategoryDirectory,
  isDirectoryUsable, directoryToArray,
};
