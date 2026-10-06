'use strict';

/**
 * 보고서 문서 ID — 기간 키 하나에 문서 하나.
 *
 * 무엇이 잘못돼 있었나
 *   보고서를 처음 저장할 때 서버는 이렇게 했다.
 *
 *     const report = await findReport(clientId, year, month);   // ← 트랜잭션 **밖**
 *     await db.runTransaction(async (tx) => {
 *       const ref = report ? db.doc(report.id) : db.collection(REPORTS).doc();  // 임의 ID
 *       ...
 *     });
 *
 *   조회가 트랜잭션 밖이고 새 문서는 **임의 ID** 라, 두 탭이(또는 느린 응답에
 *   두 번 누른 손가락이) 동시에 첫 저장을 하면 둘 다 "없음"을 보고 서로 다른
 *   문서를 만든다. 트랜잭션은 같은 문서를 건드릴 때만 충돌하는데, 임의 ID 는
 *   애초에 같은 문서가 아니다 — 충돌할 것이 없으니 둘 다 성공한다.
 *
 *   에뮬레이터에서 동시 저장 5건을 보내면 문서가 3개 만들어졌고, 그 뒤 제출하면
 *   하나만 submitted 가 되고 나머지는 draft 로 남았다. 보고서 화면은 쿼리 결과의
 *   첫 문서만 쓰므로(`rSnap.docs[0]`) 남은 것들은 **화면에서 닿을 수 없는 고아**가
 *   되고, 목록·결재 대기 쿼리에는 같은 달이 여러 줄로 뜬다.
 *
 * 어떻게 막는가
 *   ID 를 (clientId, year, month) 에서 만든다. 그러면 같은 기간의 첫 저장은
 *   **같은 문서 경로**를 읽고 쓰므로 Firestore 의 낙관적 동시성이 둘 중 하나를
 *   재시도시킨다. 재시도한 쪽은 이제 "있음"을 보고 그 문서를 갱신한다.
 *
 * 왜 해시인가
 *   `${clientId}_${year}-${month}` 같은 읽기 좋은 ID 가 운영에는 편하지만,
 *   clientId 는 임의 문자열이라 `/` 가 들어갈 수 있고(문서 ID 에 못 쓴다)
 *   길이 상한도 있다. 한편 지우거나 치환해서 만들면 **서로 다른 clientId 가
 *   같은 ID 로 뭉개질 수 있다** — 그러면 남의 입주자 보고서를 덮어쓴다.
 *   해시는 길이가 고정이고 그 충돌이 현실적으로 없다.
 *
 * 기존 문서는 건드리지 않는다
 *   이미 임의 ID 로 저장된 보고서는 **제자리에서 계속 쓴다**(조회가 canonical 을
 *   먼저 보고, 없으면 예전 쿼리로 떨어진다). 결재가 끝난 문서의 ID 를 배포가
 *   조용히 바꾸면 감사 로그의 targetId 가 가리키는 대상이 사라지고, 무엇보다
 *   **중복이 이미 있는 달에서는 어느 것을 남길지 기계가 정할 수 없다.**
 *   그래서 이관은 자동이 아니라 운영자가 한다 —
 *   `node tools/diagnose-duplicate-reports.mjs` 가 먼저 현황을 보여 준다.
 */

const { createHash } = require('node:crypto');

/** 문서 ID 접두어. 해시만 두면 이 ID 가 무엇인지 로그에서 알 수 없다. */
const PREFIX = 'r_';

/**
 * (clientId, year, month) → 결정적 문서 ID.
 *
 * 구분자로 NUL 을 쓴다. `-`·`_` 는 clientId 에 들어갈 수 있어서,
 * ('a_1', 2026, 1) 과 ('a', 12026, 1) 이 같은 문자열이 되는 길을 막는다.
 *
 * @param {string} clientId
 * @param {number} year
 * @param {number} month
 * @returns {string}
 */
function reportDocId(clientId, year, month) {
  const cid = String(clientId || '').trim();
  const y = Number(year);
  const m = Number(month);
  if (!cid) throw new Error('reportDocId: clientId 가 비었습니다.');
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`reportDocId: 연월이 올바르지 않습니다 (${year}-${month})`);
  }
  const key = `${cid}\u0000${y}\u0000${m}`;
  const digest = createHash('sha256').update(key, 'utf8').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // 32자면 128비트다 — 이 규모에서 충돌은 없다고 봐도 된다.
  return PREFIX + digest.slice(0, 32);
}

/** 이 ID 가 이 기간 키의 canonical ID 인가. 진단 스크립트가 쓴다. */
function isCanonicalReportId(id, clientId, year, month) {
  try {
    return String(id) === reportDocId(clientId, year, month);
  } catch {
    return false;
  }
}

module.exports = { reportDocId, isCanonicalReportId, REPORT_ID_PREFIX: PREFIX };
