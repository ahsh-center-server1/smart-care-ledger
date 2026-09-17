'use strict';

/**
 * 영수증 검토 표의 분류 선택 칸.
 *
 * receipt-intake.js 에서 떼어 냈다 — 그 파일이 600줄 상한에 닿아 있었고, 이
 * 칸은 검토 루프(rematch·paintReview)에 기대지 않는 유일한 필드다.
 *
 * 거래내역·수기 입력과 **같은 순서**를 쓴다. 판독 결과를 고르는 자리에서만
 * 순서가 다르면, 방금 거래내역에서 본 목록과 달라 매번 다시 찾게 된다.
 */

import { S } from '../state.js';
import { orderedCategories } from '../domain/category-order.js';

export function categoryField(row) {
  const d = document.createElement('div');
  const l = document.createElement('label');
  l.className = 'ui-label';
  l.textContent = '분류';
  const s = document.createElement('select');
  s.className = 'ui-select';

  if (row.decision === 'choose') s.appendChild(new Option('후보를 선택하세요', ''));
  s.appendChild(new Option('분류 없음', ''));

  const { recent, all } = orderedCategories({
    categories: S.categories, transactions: S.transactions,
    type: '지출', clientId: S.activeClient || '',
  });
  if (recent.length) {
    const g = document.createElement('optgroup'); g.label = '최근';
    recent.forEach(c => g.appendChild(new Option(c, c)));
    s.appendChild(g);
    const rest = document.createElement('optgroup'); rest.label = '전체';
    all.forEach(c => rest.appendChild(new Option(c, c)));
    s.appendChild(rest);
  } else {
    all.forEach(c => s.appendChild(new Option(c, c)));
  }

  s.value = all.includes(row.category) ? row.category : '';
  s.addEventListener('change', () => { row.category = s.value; });
  d.append(l, s);
  return d;
}
