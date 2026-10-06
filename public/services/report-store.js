'use strict';

/**
 * 보고서 한 건을 기간으로 찾는다 — **조회는 한 번**, 고르는 것은 표준 ID 가 한다.
 *
 * ⚠️ 표준 ID 문서를 **직접 읽으면 안 된다** — `getDoc` 도, 문서 키 쿼리도.
 *
 *   예전 임의 ID 로 저장된 보고서에서는 표준 ID 문서가 **없다.** 그런데
 *   `reports` 규칙은 `reportViewAll` 이 없는 역할에게
 *
 *       cap('reportOwn') && seesClient(resource.data.get('clientId',''))
 *
 *   를 평가하고, 없는 문서에서는 `resource` 가 null 이라 **평가 자체가 오류**가
 *   되어 거부된다. 거부는 예외로 올라오고 `loadReport` 가 그것을 삼켜서 보고서가
 *   **빈 화면**이 된다(계좌 현황·분류별 지출이 통째로 빈다). 센터장은 첫 항에서
 *   참이라 `resource` 를 건드리지 않고 통과하므로 **담당자·팀장에게만** 터진다.
 *
 *   에뮬레이터로 네 가지를 재 봤다:
 *
 *       getDoc      있는 문서  ✔      없는 문서  ✘ 거부
 *       문서 키 쿼리 있는 문서  ✔      없는 문서  ✘ 거부   ← 이것도 막힌다
 *       (clientId, year, month) 쿼리 ✔
 *
 *   규칙을 푸는 길(`resource == null ||`)은 택하지 않았다. 표준 ID 가
 *   (입주자, 연, 월)에서 결정적으로 나오므로, 그러면 담당 밖 입주자의 보고서
 *   **존재 여부**를 떠볼 수 있다.
 *
 * 그래서 표준 ID 는 **찾는 데** 쓰지 않고 **고르는 데** 쓴다
 *   (clientId, year, month) 쿼리 하나로 그 달의 보고서를 전부 받고, 그중 표준
 *   ID 인 것을 고른다. 서버가 새로 만드는 보고서는 표준 ID 이므로 보통 한 건이고,
 *   예전 중복이 남아 있는 달에서도 **화면과 서버가 같은 문서를 가리킨다** —
 *   `docs[0]`(문서 ID 순)은 그것을 보장하지 못한다. 읽기도 늘지 않는다.
 *
 *   `test/rules/firestore-rules.test.mjs` 가 위 표를 규칙 층에서 지키고,
 *   `test/report-store.test.mjs` 가 「없는 문서를 직접 읽지 않는다」를 지킨다.
 */

import { COLS } from '../constants.js';
import { reportDocId } from '../domain/report-id.js';
import { fb, fdb } from './firestore.js';

export async function findReportByPeriod(clientId, year, month) {
  const { getDocs, collection, query, where } = fb();

  const snap = await getDocs(query(
    collection(fdb(), COLS.REPORTS),
    where('clientId', '==', clientId), where('year', '==', year), where('month', '==', month),
  ));
  if (snap.empty) return null;

  // 표준 ID 계산이 실패해도(구형 브라우저의 crypto.subtle 부재 등) 보고서는
  // 열려야 한다 — 그때는 예전처럼 첫 문서를 쓴다.
  let canonicalId = '';
  try { canonicalId = await reportDocId(clientId, year, month); } catch { canonicalId = ''; }

  const hit = (canonicalId && snap.docs.find(d => d.id === canonicalId)) || snap.docs[0];
  return { id: hit.id, ...hit.data() };
}
