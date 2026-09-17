'use strict';

/**
 * 영수증 판독 결과로 자동분류 규칙을 배운다.
 *
 * receipt-intake.js 에서 떼어 냈다 — 그 파일이 600줄 상한을 넘었고, 이 기능은
 * 저장이 끝난 **뒤에만** 도는 독립된 일이다.
 *
 * **modules/ 를 import 하지 않는다.** core·permissions 를 직접 부르면 이미
 * 얽혀 있는 무리에 이 파일까지 끼어든다. 권한 확인은 호출부가 하고, 목록
 * 새로고침은 콜백으로 받는다.
 */

import { S } from '../state.js';
import { toast, showConfirm } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import { COLS } from '../constants.js';
import { ruleLearnCandidates } from '../domain/receipt-match.js';

/**
 * 「이 가맹점을 항상 이 분류로」 제안.
 *
 * 판독은 상호명을 읽어 주지만 분류는 사람이 고른다. 같은 가맹점을 매달 같은
 * 분류로 고치고 있다면 그 손질은 규칙 하나로 대체할 수 있다.
 *
 * 세 가지를 지킨다.
 *   · **이미 규칙이 같은 답을 내면 묻지 않는다.** 잘 되고 있는 건까지
 *     물어보면 사용자는 창을 닫는 법만 배운다.
 *   · 만드는 규칙은 **입주자 전용**이다. 공통 규칙은 전 입주자에게 영향을
 *     주고, 담당자에게는 권한도 없다(settings.category.common).
 *   · 실패해도 저장은 이미 끝났다. 규칙을 못 만들었다고 영수증 저장이
 *     실패한 것처럼 보이면 안 된다.
 */
export function offerRuleLearning(savedRows, clientId, onSaved) {
  const candidates = ruleLearnCandidates({
    rows: savedRows, clientId, rules: S.categories.filter(c => c && c.keyword),
  });
  if (!candidates.length) return;

  const lines = candidates.slice(0, 5)
    .map(c => `· ${c.keyword} → ${c.category}${c.existing ? ' (기존 규칙 변경)' : ''}`)
    .join('\n');
  const more = candidates.length > 5 ? `\n… 외 ${candidates.length - 5}건` : '';
  showConfirm(
    '자동분류 규칙으로 등록할까요?',
    `다음 상호명을 만나면 자동으로 분류하도록 규칙을 만듭니다.\n`
      + `이 입주자에게만 적용됩니다.\n\n${lines}${more}`,
    () => saveLearnedRules(candidates, clientId, onSaved),
    '규칙 등록',
  );
}

async function saveLearnedRules(candidates, clientId, onSaved) {
  try {
    const { addDoc, updateDoc, collection, doc } = fb();
    for (const c of candidates) {
      if (c.existing) {
        await updateDoc(doc(fdb(), COLS.CATEGORIES, c.existing.id), { category: c.category });
      } else {
        await addDoc(collection(fdb(), COLS.CATEGORIES), {
          keyword: c.keyword, type: '지출', category: c.category, subcategory: '', clientId,
        });
      }
    }
    if (typeof onSaved === 'function') await onSaved();
    toast(`자동분류 규칙 ${candidates.length}건을 등록했습니다.`, 'success', 4000);
  } catch (e) {
    // 저장은 이미 끝났다 — 규칙 실패가 영수증 저장 실패처럼 보이면 안 된다.
    toast('규칙 등록만 실패했습니다(영수증은 저장됨): ' + (e.message || e), 'error', 6000);
  }
}
