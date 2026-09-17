// public/modules/settings-overview.js
//
// 설정 「개요」 패널 — 지금 손봐야 할 것들.
//
// 판정은 domain/action-items.js(순수 함수)가 하고, 여기서는 그리기만 한다.
// 추가 읽기 없이 메모리 상태만으로 계산하므로 설정 화면을 열 때마다 불러도 된다.

'use strict';

import { S } from '../state.js';
import { can } from './permissions.js';
import { computeActionItems } from '../domain/action-items.js';
import { switchSettingsTab, updateSettingsBadges } from './settings-shell.js';

/** 현재 상태로 조치 항목을 계산한다. */
export function currentActionItems() {
  return computeActionItems({
    users: S.users,
    clients: S.allClients,
    accounts: S.allAccounts,
    fixedItems: S.allFixedItems,
    fixedGap: S.fixedGap,
    reportList: S.reportList,
    can,
  });
}

/** 조치 항목 개수를 탭 뱃지에 반영한다. */
export function refreshOverviewBadges() {
  const items = currentActionItems();
  const byTab = {};
  for (const it of items) {
    if (!it.tab || it.severity !== 'warn') continue;   // 참고 항목은 뱃지로 재촉하지 않는다
    byTab[it.tab] = (byTab[it.tab] || 0) + 1;
  }
  // 개요 뱃지는 손봐야 할 항목 종류의 수
  const warnCount = items.filter(it => it.severity === 'warn').length;
  updateSettingsBadges({ overview: warnCount, ...byTab });
}

export function renderSettingsOverview() {
  const host = document.getElementById('overview-tab-content');
  if (!host) return;
  host.textContent = '';

  const items = currentActionItems();
  refreshOverviewBadges();

  if (items.length === 0) {
    const ok = document.createElement('div');
    ok.className = 'ui-todo__empty';
    // 색만으로 "괜찮다"를 표현하지 않는다 — 아이콘과 문장을 함께 둔다.
    ok.textContent = '✅ 지금 손봐야 할 항목이 없습니다.';
    host.appendChild(ok);
    return;
  }

  const list = document.createElement('div');
  list.className = 'ui-todo';

  for (const it of items) {
    // 갈 곳이 있으면 버튼, 없으면 그냥 알림 줄. 눌러도 아무 일 없는 버튼을 두지 않는다.
    const el = document.createElement(it.tab ? 'button' : 'div');
    el.className = 'ui-todo__item';
    if (it.severity === 'info') el.style.borderLeftColor = 'var(--muted-foreground)';

    if (it.tab) {
      el.type = 'button';
      el.addEventListener('click', () => switchSettingsTab(it.tab));
      el.title = '눌러서 해당 설정으로 이동';
    } else {
      el.style.cursor = 'default';
    }

    const icon = document.createElement('span');
    icon.textContent = it.severity === 'warn' ? '⚠️' : 'ℹ️';
    icon.setAttribute('aria-hidden', 'true');
    el.appendChild(icon);

    const label = document.createElement('span');
    // textContent로 넣는다 — 입주자·직원 이름이 섞이지 않는 문장이지만
    // 라벨을 innerHTML로 다루는 습관 자체를 만들지 않는다.
    label.textContent = it.label;
    el.appendChild(label);

    const count = document.createElement('span');
    count.className = 'ui-todo__count';
    count.textContent = `${it.count}건`;
    if (it.severity === 'info') count.style.color = 'var(--muted-foreground)';
    el.appendChild(count);

    list.appendChild(el);
  }

  host.appendChild(list);

  const note = document.createElement('p');
  note.className = 'ui-hint';
  note.style.marginTop = '.75rem';
  note.textContent = '이 목록은 이미 불러온 자료로만 계산합니다 — 추가 조회를 하지 않습니다.';
  host.appendChild(note);
}
