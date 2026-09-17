'use strict';

/**
 * 금액 입력칸 — 천 단위 콤마.
 *
 * 왜 type="number" 가 아닌가
 *   브라우저의 숫자 입력칸은 콤마를 받지 않는다. 「1,250,000」을 보여주려면
 *   text 로 두고 우리가 서식을 입혀야 한다.
 *
 * 그래서 **파싱이 한 곳에만 있어야 한다.** 값을 읽는 자리마다 각자
 *   replace(/,/g,'') 를 하면 한 곳을 빠뜨렸을 때 1,250,000 이 1 이 된다.
 *   금액이 조용히 잘리는 버그는 장부에서 가장 늦게 발견된다.
 *   읽을 때는 언제나 parseAmount() 를 쓴다.
 */

/**
 * 입력칸의 문자열에서 금액을 얻는다. **이 함수만 쓴다.**
 *
 * 숫자가 하나도 없으면 0이다 — NaN 이 나가면 호출부의 `!amount` 검사와
 * `Number()` 변환이 자리마다 다르게 반응한다.
 *
 * @returns {number}
 */
export function parseAmount(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return 0;
  const negative = raw.startsWith('-');
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return 0;
  const n = Number(digits);
  return negative ? -n : n;
}

/**
 * 표시용 문자열.
 *
 * 숫자가 하나도 없으면 빈 문자열이다 — placeholder 가 보여야 한다.
 * 「0」을 친 것과 아무것도 안 친 것은 다르다.
 */
export function formatAmount(value) {
  const digits = String(value == null ? '' : value).replace(/[^0-9]/g, '');
  if (!digits) return '';
  return parseAmount(value).toLocaleString('en-US');
}

/**
 * 입력칸에 콤마 서식을 붙인다.
 *
 * 커서 위치는 **커서 앞의 숫자 개수**로 되돌린다. 콤마가 끼어들면 문자열
 * 길이가 달라지므로 위치를 그대로 복원하면 커서가 한 칸씩 밀린다 — 가운데를
 * 고치는 사람에게는 매 글자마다 어긋난다.
 */
export function attachAmountInput(el) {
  if (!el || el.dataset.amountBound === '1') return;
  el.dataset.amountBound = '1';
  el.type = 'text';
  el.inputMode = 'numeric';
  el.autocomplete = 'off';
  if (el.value) el.value = formatAmount(el.value);

  el.addEventListener('input', () => {
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const digitsBefore = (before.match(/[0-9]/g) || []).length;
    el.value = formatAmount(el.value);

    let pos = 0, seen = 0;
    while (pos < el.value.length && seen < digitsBefore) {
      if (/[0-9]/.test(el.value[pos])) seen += 1;
      pos += 1;
    }
    try { el.setSelectionRange(pos, pos); } catch (_) { /* 일부 브라우저는 못 한다 */ }
  });
}
