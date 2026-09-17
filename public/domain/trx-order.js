// public/domain/trx-order.js
//
// 거래를 늘어놓는 순서 — 순수 함수. DOM·Firestore를 모른다.
//
// 무엇이 잘못돼 있었나
//   비교기가 **sortOrder를 먼저** 봤다.
//
//     const oA = a.sortOrder!=null ? a.sortOrder : 99999;   // ← 1순위
//     if(oA!==oB) return oA-oB;
//     return (a.date+a.time).localeCompare(b.date+b.time);  // ← 2순위
//
//   장부에서 1순위는 언제나 날짜다. 통장이 그렇게 찍히고, 보고서도 그렇게
//   읽는다. sortOrder를 앞에 두면 **나중에 입력한 과거 거래가 뒤로 간다.**
//   그리고 수기 입력은 sortOrder를 아예 안 붙였으므로 전부 99999가 되어
//   목록 맨 아래로 몰렸다 — 사용자가 본 "순서가 이상하다"가 이것이다.
//
// 그래서 순서를 뒤집는다
//
//     날짜 → 그 날 안의 순서(sortOrder) → 시각
//
//   sortOrder는 이제 **그 날 안에서만** 뜻이 있다. 통장 파일은 날짜 오름차순
//   이므로 파일 순서가 그대로 보존되고, 날짜가 다른 거래끼리는 번호가 겹쳐도
//   상관이 없어진다. 겹침이 상관없어지는 것이 요점이다 —
//     · 엑셀이 화면에 로드된 것만 보고 최대값을 구해도 해가 없다
//     · 드래그가 한 페이지를 0..99로 다시 매겨도 다른 날을 건드리지 않는다
//   기존 데이터도 손대지 않는다. 지금 저장된 값은 날짜 오름차순으로 증가하고
//   있어서, 날짜를 먼저 보면 같은 날 안에서도 여전히 오름차순이다.
//
// 값이 없는 것은 그 날의 끝
//   sortOrder가 없는 거래(수기 입력분)는 그 날의 **맨 뒤**에 둔다. 앞에 두면
//   통장에서 옮겨 적은 줄보다 나중에 손으로 적은 줄이 위로 올라간다.

'use strict';

/** sortOrder가 없을 때의 자리. 그 날의 맨 뒤. */
const LAST = Number.MAX_SAFE_INTEGER;

/** 이 거래의 그 날 안 순서. 없으면 맨 뒤. */
export function orderOf(trx) {
  const v = trx && trx.sortOrder;
  return typeof v === 'number' && Number.isFinite(v) ? v : LAST;
}

/**
 * 장부 순서 비교기. **목록·보고서·엑셀 미리보기가 모두 이것을 쓴다.**
 *
 * 세 벌로 흩어져 있었고, 한 곳만 고치면 같은 거래가 화면마다 다른 자리에
 * 나타났다. 보고서를 인쇄해 결재를 올리는 앱에서 그것은 그냥 버그가 아니다.
 */
export function compareTrx(a, b) {
  const dA = String((a && a.date) || ''), dB = String((b && b.date) || '');
  if (dA !== dB) return dA < dB ? -1 : 1;
  const oA = orderOf(a), oB = orderOf(b);
  if (oA !== oB) return oA - oB;
  const tA = String((a && a.time) || ''), tB = String((b && b.time) || '');
  return tA.localeCompare(tB);
}

/** 장부 순서로 정렬한 새 배열. 원본을 건드리지 않는다. */
export function sortTrx(list) {
  return [...(list || [])].sort(compareTrx);
}

/**
 * 새 거래가 받을 그 날의 순서 — **그 날의 맨 뒤.**
 *
 * 왜 맨 뒤인가
 *   수기 입력은 통장에 없는 것을 보태는 일이거나, 통장을 다 옮긴 뒤에
 *   빠진 것을 채우는 일이다. 둘 다 그 날의 끝이 맞는 자리다. 가운데로
 *   넣고 싶으면 넣은 뒤에 드래그한다.
 *
 * 화면에 로드된 것만 보고 계산해도 된다 — 다른 날의 번호와는 겹쳐도
 * 상관이 없고, 같은 날 거래는 그 날을 보고 있다면 화면에 있다.
 *
 * @param {string} date       새 거래의 날짜 (YYYY-MM-DD)
 * @param {Array} transactions 거래 목록 (다른 입주자·날짜가 섞여 있어도 된다)
 * @param {string} clientId    이 입주자의 것만 센다
 * @returns {number}
 */
export function nextOrderInDay(date, transactions, clientId) {
  const d = String(date || '');
  const cid = String(clientId || '');
  let max = -1;
  for (const t of (transactions || [])) {
    if (!t || String(t.date || '') !== d) continue;
    if (cid && String(t.clientId || '') !== cid) continue;
    const o = t.sortOrder;
    // 값이 없는 거래는 세지 않는다. 그것들이야말로 자리를 못 받은 것들이다.
    if (typeof o === 'number' && Number.isFinite(o) && o > max) max = o;
  }
  return max + 1;
}

/**
 * 한 줄을 다른 줄의 자리로 옮긴다 — **같은 날 안에서만.**
 *
 * 예전에는 화면의 한 페이지를 통째로 0..99로 다시 매겼다. 그래서
 *   · 계좌 필터를 켠 채 한 줄을 옮기면 필터 밖 거래의 번호와 충돌했고,
 *   · 엑셀이 준 큰 번호(예: 1..300)가 0..99로 깎여 그 뒤의 저장과 어긋났다.
 * "한참 수정하다 보면 순서가 이상해진다"가 이것이다.
 *
 * 이제 그 **날** 하나만 0..N으로 다시 매긴다. 날짜가 다른 거래의 번호와는
 * 겹쳐도 무해하므로(compareTrx 가 날짜를 먼저 본다) 충돌할 곳이 없다.
 * 대상은 화면에 보이는 것이 아니라 **그 날 전부**다 — 필터 안만 매기면
 * 필터 밖 같은 날 거래와 번호가 어긋난다.
 *
 * 날짜를 건너뛰는 이동은 거절한다. 장부에서 3월 15일 줄을 3월 10일 앞으로
 * 옮긴다는 것은 순서가 아니라 날짜를 고치는 일이다.
 *
 * @param {Array} transactions 같은 입주자의 거래들 (필터 이전의 것)
 * @returns {{ok:true, date:string, order:Array, changed:Array<{id:string,sortOrder:number}>}
 *          |{ok:false, reason:'notfound'|'same'|'cross-date'}}
 */
export function planReorder(transactions, fromId, toId) {
  const list = transactions || [];
  const from = list.find(t => t && t.id === fromId);
  const to = list.find(t => t && t.id === toId);
  if (!from || !to) return { ok: false, reason: 'notfound' };
  if (fromId === toId) return { ok: false, reason: 'same' };
  if (String(from.date || '') !== String(to.date || '')) return { ok: false, reason: 'cross-date' };

  const day = sortTrx(list.filter(t =>
    String(t.date || '') === String(from.date || '')
    && String(t.clientId || '') === String(from.clientId || '')));
  const fi = day.findIndex(t => t.id === fromId);
  const ti = day.findIndex(t => t.id === toId);
  if (fi < 0 || ti < 0) return { ok: false, reason: 'notfound' };
  const [moved] = day.splice(fi, 1);
  day.splice(ti, 0, moved);
  return { ok: true, date: String(from.date || ''), order: day, changed: renumberDay(day) };
}

/**
 * 그 날 거래에 0..N을 새로 매긴다.
 * @returns {Array<{id:string, sortOrder:number}>} 값이 실제로 바뀌는 것만
 */
function renumberDay(dayTrx) {
  const out = [];
  (dayTrx || []).forEach((t, i) => {
    if (t && t.sortOrder !== i) out.push({ id: t.id, sortOrder: i });
  });
  return out;
}
