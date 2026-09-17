'use strict';

/**
 * 거래내역 화면의 작은 UI 조각들 — 미분류 배지, 필터 초기화, 분류 드롭다운.
 *
 * transactions.js 에서 떼어 냈다 — 그 파일은 쪼갤 목록에 올라 있고, 줄 수
 * 예산은 줄어들기만 한다. **화면 모듈을 import 하지 않는다**(순환에 끼어든다).
 * 다시 그릴 필요가 생기면 호출부가 콜백으로 넘겨 준다.
 */

import { S } from '../state.js';
import { toast, escHtml } from '../utils/ui.js';
import { orderedCategories } from '../domain/category-order.js';
import { cs } from '../constants.js';
import { isUnclassified } from '../domain/monthly-summary.js';

export { isUnclassified as isUnclassifiedTrx };

/**
 * 대시보드 배지가 **당월 요약 캐시** 기준인 것과 달리, 여기는 **지금 불러온
 * 범위** 기준이다. 기간 필터를 넓히면 숫자가 는다 — 그래야 "3월 것도 남았네"를
 * 알 수 있다. 판정은 같은 함수를 쓰므로 두 숫자가 뜻이 다를 뿐 기준은 같다.
 *
 * 누르면 그 건만 보이고, 다시 누르면 풀린다.
 */
export function renderUnclassifiedBadge(onToggle) {
  const el = document.getElementById('h-unclassified');
  if (!el) return;
  const n = S.transactions.filter(isUnclassified).length;
  if (!n && !S.onlyUnclassified) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.textContent = S.onlyUnclassified ? `🏷️ 미분류 ${n}건만 보는 중 · 해제` : `🏷️ 미분류 ${n}건`;
  el.style.background = S.onlyUnclassified ? '#b45309' : '#fffbeb';
  el.style.color = S.onlyUnclassified ? '#fff' : '#b45309';
  el._onToggle = onToggle;
  if (!el.dataset.bound) {
    el.dataset.bound = '1';
    el.addEventListener('click', () => {
      S.onlyUnclassified = !S.onlyUnclassified;
      if (typeof el._onToggle === 'function') el._onToggle();
    });
  }
}

/**
 * 모든 필터를 한 번에 초기화. 입주자 선택은 유지하고, 기간은 이번 달로 되돌린다.
 *
 * `reapply` 를 받는 이유: applyFilters 는 transactions.js 에 있고, 그것을
 * 직접 import 하면 순환이 된다.
 */
export function resetFiltersUI(reapply) {
  const defaults = { 'h-search': '', 'h-type': 'all', 'h-receipt': 'all', 'h-account': '' };
  Object.entries(defaults).forEach(([id, v]) => {
    const el = document.getElementById(id); if (el) el.value = v;
  });
  S.onlyUnclassified = false;
  const now = new Date();
  const fmt = dt => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0')
    + '-' + String(dt.getDate()).padStart(2, '0');
  const s = document.getElementById('h-start'), e = document.getElementById('h-end');
  if (s) s.value = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
  if (e) e.value = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
  S.page = 1;
  reapply();
  toast('필터를 초기화했습니다.', 'success', 1500);
}

/**
 * 분류 인라인 드롭다운.
 *
 * 「최근」을 위에 얹는다 — 드래그로 정한 순서는 그대로 두고 전체 목록도 줄이지
 * 않는다. 익숙한 자리가 그대로 있어야 한다.
 *
 * `onPick` 을 받는 이유: 저장은 transactions.js 에 있고, 직접 import 하면
 * 순환이 된다.
 */
export function openCatDropdownUI(trxId, chipEl, type, onPick) {
  closeCatDropdowns();
  const dd = document.getElementById('dd-' + trxId);
  if (!dd) return;
  const { recent, all } = orderedCategories({
    categories: S.categories, transactions: S.transactions,
    type, clientId: S.activeClient || '',
  });
  dd.innerHTML = '';
  const addItem = (cat) => {
    const c = cs(cat), item = document.createElement('div');
    item.className = 'cat-dd-item';
    item.innerHTML = `<span style="width:9px;height:9px;border-radius:50%;background:${c.dot};`
      + `display:inline-block;flex-shrink:0;"></span>${escHtml(cat)}`;
    item.addEventListener('click', (e) => {
      e.stopPropagation(); onPick(trxId, cat, chipEl); closeCatDropdowns();
    });
    dd.appendChild(item);
  };
  const addLabel = (text) => {
    const l = document.createElement('div');
    l.style.cssText = 'font-size:10px;font-weight:700;color:#94a3b8;padding:4px 10px 2px;';
    l.textContent = text; dd.appendChild(l);
  };
  if (recent.length) { addLabel('최근'); recent.forEach(addItem); addLabel('전체'); }
  all.forEach(addItem);
  dd.classList.add('show');
}

export function closeCatDropdowns() {
  document.querySelectorAll('.cat-dd.show').forEach(d => d.classList.remove('show'));
}
