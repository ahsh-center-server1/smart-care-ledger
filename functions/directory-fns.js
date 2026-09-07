'use strict';

/**
 * 파생 명부의 Cloud Functions — 트리거와 복구 콜러블.
 *
 * 명부가 무엇이고 왜 증분이 아니라 통째로 다시 만드는지는
 * functions/directories.cjs 머리말에 있다. 이 파일은 그것을 언제 돌릴지만 정한다.
 *
 * index.js에서 헬퍼(db·callable·callerRank…)를 주입받는다. 직접 require하면
 * index.js와 순환이 되고, admin.initializeApp()이 두 번 불릴 수 있다.
 */

const {
  DIRECTORIES, buildStaffDirectory, buildCategoryDirectory,
} = require('./directories.cjs');

const DIRECTORY_COL = 'directories';
const USERS = 'users';
const CATEGORIES = 'categories';

module.exports = function directoryFns(ctx) {
  const { db, callable, callerRank, HttpsError, logger, onDocumentWritten } = ctx;

  /** 컬렉션을 통째로 읽어 명부를 다시 만든다. */
  async function rebuildDirectory(name, col, build) {
    const snap = await db.collection(col).get();
    const docData = build(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
    // set(merge 없이) — 지워진 항목이 명부에 남지 않게 통째로 교체한다.
    // merge를 쓰면 삭제된 직원이 명부에 유령으로 남고, 그것은 화면에서만 드러난다.
    await db.collection(DIRECTORY_COL).doc(name).set(docData);
    return docData.count;
  }

  /**
   * 명부 갱신 트리거.
   *
   * 쓰기 한 번에 그 컬렉션을 통째로 다시 읽는다. 비싸 보이지만 이 두 컬렉션은
   * 작고(직원 수십 명·분류 수십 개) 거의 바뀌지 않는다. 반대로 명부가 없으면
   * **로그인마다** 같은 양을 전 사용자가 읽는다. 어느 쪽이 싼지는 분명하다.
   *
   * 실패는 삼킨다 — 명부가 낡으면 브라우저가 컬렉션 직접 조회로 떨어지므로
   * 화면은 맞는다. 직원 수정 자체가 실패로 되돌아가는 편이 더 나쁘다.
   */
  function directorySync(col, name, build) {
    return onDocumentWritten({ document: `${col}/{id}` }, async () => {
      try {
        await rebuildDirectory(name, col, build);
      } catch (err) {
        logger.error('[directory] 명부 갱신 실패', {
          directory: name, message: err && err.message,
        });
      }
    });
  }

  return {
    syncStaffDirectory:
      directorySync(USERS, DIRECTORIES.STAFF, buildStaffDirectory),
    syncCategoryDirectory:
      directorySync(CATEGORIES, DIRECTORIES.CATEGORIES, buildCategoryDirectory),

    /**
     * rebuildDirectories — 명부를 컬렉션 전체에서 다시 만든다.
     *
     * 쓰는 때
     *   · 최초 배포 직후 백필 (트리거는 그때부터의 변경만 본다)
     *   · 트리거가 실패해 명부가 어긋났을 때 복구
     */
    rebuildDirectories: callable('rebuildDirectories', async (request) => {
      if (callerRank(request.auth) < 99) {
        throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
      }
      const staff = await rebuildDirectory(DIRECTORIES.STAFF, USERS, buildStaffDirectory);
      const categories = await rebuildDirectory(
        DIRECTORIES.CATEGORIES, CATEGORIES, buildCategoryDirectory);
      return { staff, categories };
    }),
  };
};
