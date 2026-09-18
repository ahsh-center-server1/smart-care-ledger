/**
 * modules/report-inline-edit.js — 보고서 표의 칸을 그 자리에서 고친다
 *
 * 왜 폼이 아니라 칸인가
 *   내용 한 글자를 고치려고 날짜·계좌·유형·분류·금액이 다 있는 폼을 띄우면,
 *   눈은 고칠 곳을 다시 찾아야 하고 손은 저장까지 세 번을 더 눌러야 한다.
 *   고칠 것이 한 칸이면 그 칸이 입력칸이 되는 것이 가장 짧다.
 *   여러 칸을 함께 고치는 일은 여전히 폼이 낫다 — 그쪽은 「수정」 버튼이다.
 *
 * 왜 저장 함수를 주입받는가
 *   저장은 transactions.js 의 saveTrx 하나다(잠금·권한·잔액 갱신이 전부 거기
 *   있다). 그런데 여기서 직접 import 하면 report → 이 파일 → transactions →
 *   core → report 로 **얽힘이 한 파일 늘어난다**(test/architecture.test.mjs 가
 *   그것을 막는다). 부르는 쪽이 넘긴다 — openCatDropdownUI 가 쓰는 방식과 같다.
 *
 * 되돌리는 규칙
 *   저장이 거부되면(잠긴 달·권한 없음) **원래 보이던 것을 그대로 되돌린다.**
 *   입력칸이 남아 있으면 사용자는 고쳐진 줄 알고 넘어간다.
 *
 * 저장하는 것은 Enter 하나다
 *   칸을 벗어나는 것(blur)은 **취소**다. 표를 정리하다 보면 다음 칸을 누르거나
 *   다른 줄로 눈이 가는 일이 잦은데, 그때마다 손대던 값이 저장되면 무엇이
 *   언제 바뀌었는지 사용자가 세고 있을 수 없다. 저장은 **누른 사람이 그렇게
 *   말했을 때만** 일어나는 편이 장부에 맞는다 — 고치려던 것을 놓치면 다시
 *   누르면 되지만, 안 고치려던 것이 저장되면 되돌릴 방법이 없다.
 */

'use strict';

import { parseAmount, formatAmount } from '../utils/amount-input.js';

/** 칸 종류별 차이. 여기 없는 것은 이 파일이 다루지 않는다. */
const FIELDS = {
  date:        { inputType: 'date', align: 'left' },
  description: { inputType: 'text', align: 'left' },
  amountIn:    { inputType: 'amount', align: 'right' },
  amountOut:   { inputType: 'amount', align: 'right' },
};

export const INLINE_FIELDS = Object.freeze(Object.keys(FIELDS));

/** 편집 중인 칸이 하나뿐이도록 — 두 칸이 동시에 열리면 어느 쪽이 저장될지 모른다. */
let openEditor = null;

export function closeInlineEditor() {
  if (openEditor) openEditor.cancel();
}

/**
 * 칸 하나를 입력칸으로 바꾼다.
 *
 * @param {HTMLElement} td      바꿀 칸
 * @param {Object} trx          그 줄의 거래
 * @param {string} field        date | description | amountIn | amountOut
 * @param {Function} commit     (trx, field, value) => Promise<any>
 *                              참 같은 값을 돌려주면 저장된 것으로 본다.
 */
export function startInlineEdit(td, trx, field, commit) {
  const spec = FIELDS[field];
  if (!spec || !td || td.dataset.editing === '1') return;
  closeInlineEditor();

  const original = td.innerHTML;
  const before = field === 'date' ? String(trx.date || '') : Number(trx[field] || 0);
  const row = td.closest('tr');
  // 끌 수 있는 줄 안에서는 입력칸의 글자를 마우스로 고를 수 없다 — 드래그가
  // 먼저 잡는다. 고치는 동안만 끄고 끝나면 되돌린다.
  const wasDraggable = row ? row.draggable : false;
  if (row) row.draggable = false;

  const input = document.createElement('input');
  input.type = spec.inputType === 'amount' ? 'text' : spec.inputType;
  if (spec.inputType === 'amount') { input.inputMode = 'numeric'; }
  input.value = field === 'date' ? String(trx.date || '')
    : spec.inputType === 'amount' ? formatAmount(trx[field] || 0)
      : String(trx[field] || '');
  input.className = 'rpt-inline-input';
  input.style.textAlign = spec.align;

  td.dataset.editing = '1';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (input.type === 'text') input.select();

  let done = false;
  // Enter 로 저장을 시작하면 input.disabled 가 blur 를 한 번 더 부른다.
  // done 이 그때 이미 참이라 취소가 저장을 덮지 않는다.
  const restore = () => {
    if (done) return; done = true;
    openEditor = null;
    if (row) row.draggable = wasDraggable;
    delete td.dataset.editing;
    td.innerHTML = original;
  };
  const save = async () => {
    if (done) return; done = true;
    openEditor = null;
    if (row) row.draggable = wasDraggable;
    const next = spec.inputType === 'amount' ? parseAmount(input.value) : input.value.trim();
    // 바뀐 것이 없으면 서버에 묻지 않는다. 눌러 보기만 한 것도 편집이다.
    if (next === before) { delete td.dataset.editing; td.innerHTML = original; return; }
    input.disabled = true;
    const ok = await commit(trx, field, next);
    // 저장됐으면 표를 다시 그리는 쪽이 이 칸을 통째로 갈아 끼운다.
    // 거부됐으면 원래대로 — 입력칸이 남으면 고쳐진 줄 안다.
    if (!ok) { delete td.dataset.editing; td.innerHTML = original; }
  };

  openEditor = { cancel: restore };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); restore(); }
  });
  // 칸을 벗어나면 취소한다 — 저장은 Enter 만.
  input.addEventListener('blur', restore);
  // 칸을 누른 것이 줄·문서까지 올라가면 방금 연 입력칸이 도로 닫힌다.
  ['click', 'mousedown'].forEach(t => input.addEventListener(t, e => e.stopPropagation()));
}

/**
 * 칸 하나를 저장할 때 서버로 보낼 것.
 *
 * **바뀐 칸과 판정에 필요한 것만** 보낸다. 규칙은 바뀐 필드만 세므로
 * (`diff().affectedKeys()`) 같은 값을 다시 보내도 걸리지 않지만, 없는 값을
 * 실어 보내면 Firestore 가 거절한다.
 *
 * 순수 함수라 Node 에서 그대로 시험한다 — 금액을 고치면 유형이 따라오는
 * 규칙이 조용히 어긋나면 한 거래가 수입이면서 지출이 된다.
 */
export function fieldPatch(trx, field, value) {
  const t = trx || {};
  const patch = {
    id: t.id, clientId: t.clientId, accountId: t.accountId,
    date: field === 'date' ? value : t.date,
    [field]: value,
  };
  // 작성자 검사(editingOthers)가 같은 답을 내도록 — 같은 값이라 규칙에는 안 걸린다.
  if (t.createdBy) patch.createdBy = t.createdBy;
  // 한 줄은 수입이거나 지출이다. 반대쪽을 비우고 유형도 맞춘다 — 그러지 않으면
  // 수입이면서 지출인 거래가 남는다. 구형 유형(자산이동·취소)은 건드리지
  // 않는다: 그 이름이 말하는 뜻이 따로 있고, 바꾸면 짝이 끊긴다.
  if ((field === 'amountIn' || field === 'amountOut')
      && (t.type === '수입' || t.type === '지출')) {
    patch.amountIn = field === 'amountIn' ? value : 0;
    patch.amountOut = field === 'amountOut' ? value : 0;
    patch.type = field === 'amountIn' ? '수입' : '지출';
  }
  return patch;
}

/**
 * 한 줄의 고칠 수 있는 칸들에 「눌러서 고치기」를 건다.
 *
 * 누를 때마다 잠금을 다시 본다 — 표를 그린 뒤에 결재가 끝났을 수 있고,
 * 그때는 서버가 거부하기 전에 이쪽이 이유를 말하는 편이 낫다.
 */
export function bindInlineCells(tr, trx, { blockReason, onBlocked, save }) {
  tr.querySelectorAll('.rpt-cell-inline').forEach((td) => {
    const field = td.dataset.field;
    if (!FIELDS[field]) return;
    td.addEventListener('click', (e) => {
      e.stopPropagation();
      const blocked = blockReason && blockReason();
      if (blocked) { if (onBlocked) onBlocked(blocked); return; }
      startInlineEdit(td, trx, field, save);
    });
  });
}
