// public/domain/report-session.js
//
// 「보고서를 보다 말고 다른 탭에 갔다」를 기억하는 자리 — 순수 함수.
// DOM·Firestore를 모른다.
//
// 왜 필요한가
//   changeView 가 보고서 탭을 **떠날 때** S.reportData 를 통째로 버렸다.
//   대시보드에서 숫자 하나를 확인하고 돌아오면 입주자·연·월을 다시 고르고
//   조회를 다시 눌러야 했다. 보고서는 한 번에 끝나는 화면이 아니라 거래를
//   고치고 의견을 적으며 오가는 화면이라, 이 왕복이 매번 일어난다.
//
// 왜 S.reportData 를 그냥 남기지 않나
//   남겨 두면 **낡은 숫자**가 그대로 보인다. 그 사이 거래를 고쳤거나 동료가
//   결재했을 수 있다. 보고서는 결재 문서라 낡은 화면이 가장 위험하다.
//   그래서 여기서 기억하는 것은 계산 결과가 아니라 **무엇을 보고 있었는지**
//   (입주자·연·월) 뿐이고, 돌아오면 그걸로 다시 조회한다.
//
// 왜 담당 범위를 다시 보나
//   담당 배정이 바뀌면 그 입주자는 목록에서 사라진다. 기억해 둔 것을 그대로
//   조회하면 규칙이 거절하고 화면에는 오류만 뜬다 — 사용자는 자기가 무엇을
//   잘못했는지 알 수 없다. 복원하지 않고 조용히 선택 화면으로 돌아간다.

'use strict';

/**
 * 「지금 이것을 보고 있었다」를 남길 형태로 다듬는다.
 *
 * 연·월이 숫자가 아니면 기억하지 않는다 — 빈 select 를 읽으면 0이 되고,
 * 0년 0월로 복원하면 빈 보고서가 열린다.
 *
 * @returns {{clientId:string, year:number, month:number}|null}
 */
export function rememberOpenReport({ clientId, year, month } = {}) {
  const id = String(clientId || '').trim();
  const y = Number(year);
  const m = Number(month);
  if (!id) return null;
  if (!Number.isInteger(y) || y < 2000 || y > 2999) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  return { clientId: id, year: y, month: m };
}

/**
 * 돌아왔을 때 다시 열어도 되는가.
 *
 * @param {Object|null} open      rememberOpenReport 가 남긴 것
 * @param {Array} clients         지금 이 사람이 볼 수 있는 입주자 목록
 * @returns {{clientId:string, year:number, month:number}|null}
 */
export function restorableReport(open, clients) {
  const rec = rememberOpenReport(open || {});
  if (!rec) return null;
  // 담당에서 빠졌으면 복원하지 않는다. 열어 봐야 규칙이 거절한다.
  const visible = (clients || []).some(c => c && String(c.id) === rec.clientId);
  return visible ? rec : null;
}
