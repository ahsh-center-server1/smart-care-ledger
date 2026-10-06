/**
 * modules/client-picker.js — 입주자를 **찾아서** 고른다
 *
 * 왜 목록이 아니라 검색인가
 *   담당자는 네댓 명이지만 센터장은 전 입주자를 본다. 스무 명이 넘어가면
 *   드롭다운은 스크롤 상자가 되고, 찾는 사람은 이름을 알면서도 눈으로 훑어야
 *   한다. 이름을 아는 사람에게는 치는 것이 가장 빠르다.
 *
 * 무엇을 보여 주는가 — 이름만으로는 못 고른다
 *   동명이인이 있고, 「담당이 아닌 사람」이 섞여 보이면 잘못 고른다. 줄마다
 *   **팀과 담당 직원**을 함께 적고, 그 둘로도 검색된다(초성 포함).
 *
 * ⚠️ 범위는 여기서 정하지 않는다. 목록은 `S.clients` 그대로이고, 그것은
 *    core.js 의 `myScope()` 가 authz(담당 배정)로 이미 좁혀 놓은 것이다 —
 *    규칙이 보는 것과 같은 근거다. 여기서 또 거르면 근거가 두 벌이 되고,
 *    어긋나는 순간 "화면에는 있는데 열면 거부당하는 입주자"가 생긴다.
 *
 * 값의 근거는 여전히 `<select>` 다
 *   대시보드 카드는 `select.value` 를 직접 넣고, 필터를 읽는 곳도 그것을
 *   읽는다. 검색칸은 **그 위에 덧댄 화면**일 뿐이라, 골랐을 때 select 에
 *   넣고 `change` 를 쏘면 기존 경로가 그대로 돈다.
 */

'use strict';

import { S } from '../state.js';
import { escHtml } from '../utils/ui.js';
import { searchMatchesAny } from '../domain/hangul-search.js';

/** 그 입주자를 설명하는 한 줄 — 팀과 담당 직원. 검색도 이 값들로 한다. */
export function clientFacets(client, users) {
  const ids = String(client.userIds || '').split(',').map(x => x.trim()).filter(Boolean);
  const staff = ids
    .map(id => (users || []).find(u => String(u.userId) === id || String(u.id) === id))
    .map((u, i) => (u ? (u.name || u.userId) : ids[i]))
    .filter(Boolean);
  return { team: String(client.team || '').trim(), staff };
}

/** 줄에 적을 부연. 팀도 담당도 없으면 빈 문자열 — 없는 것을 적지 않는다. */
export function clientSubtitle(client, users) {
  const { team, staff } = clientFacets(client, users);
  return [team, staff.join(', ')].filter(Boolean).join(' · ');
}

/** 검색어와 맞는가 — 이름·팀·담당 직원 중 하나라도(초성 포함). */
export function clientMatches(client, users, query) {
  const { team, staff } = clientFacets(client, users);
  return searchMatchesAny([client.name, team, ...staff], query);
}

const els = () => ({
  input: document.getElementById('h-client-search'),
  list: document.getElementById('h-client-list'),
  sel: document.getElementById('h-client'),
});

/** select 가 가리키는 사람을 검색칸에 적는다. 값과 표시가 갈라지면 안 된다. */
export function syncClientPicker() {
  const { input, sel } = els();
  if (!input || !sel) return;
  const c = (S.clients || []).find(x => x.id === sel.value);
  input.value = c ? (c.name || '') : '';
  input.placeholder = sel.value ? '' : '이름·팀·담당자로 찾기';
}

function closeList() {
  const { list } = els();
  if (list) list.classList.remove('show');
}

function renderList(query) {
  const { list, sel } = els();
  if (!list) return;
  const users = S.users || [];
  const hits = (S.clients || []).filter(c => clientMatches(c, users, query));
  list.innerHTML = '';

  const row = (html, onPick) => {
    const d = document.createElement('div');
    d.className = 'client-dd-item';
    d.innerHTML = html;
    d.addEventListener('mousedown', (e) => { e.preventDefault(); onPick(); });
    list.appendChild(d);
  };

  // 「전체」는 고르는 값이 아니라 **푸는 값**이다 — 입주자를 안 고른 상태로
  // 돌아가는 길이 없으면 한 번 고른 뒤에는 표를 비울 수 없다.
  row('<span style="color:var(--muted);">전체 (선택 해제)</span>', () => {
    sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true }));
    syncClientPicker(); closeList();
  });

  if (!hits.length) {
    const d = document.createElement('div');
    d.style.cssText = 'padding:8px 10px;font-size:13px;color:var(--muted);';
    d.textContent = (S.clients || []).length ? '찾는 입주자가 없습니다.' : '담당 입주자가 없습니다.';
    list.appendChild(d);
  }

  hits.forEach((c) => {
    const sub = clientSubtitle(c, users);
    row(`<span style="font-weight:700;">${escHtml(c.name || '')}</span>`
      + (sub ? `<span style="font-size:11px;color:var(--muted);margin-left:6px;">${escHtml(sub)}</span>` : ''),
    () => {
      sel.value = c.id; sel.dispatchEvent(new Event('change', { bubbles: true }));
      syncClientPicker(); closeList();
    });
  });
  list.classList.add('show');
}

/** 한 번만 건다. 화면을 다시 그릴 때마다 걸면 핸들러가 쌓인다. */
export function initClientPicker() {
  const { input, list } = els();
  if (!input || !list || input.dataset.bound === '1') return;
  input.dataset.bound = '1';

  input.addEventListener('focus', () => { input.select(); renderList(''); });
  input.addEventListener('input', () => renderList(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { syncClientPicker(); closeList(); input.blur(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // 첫 줄은 「전체」이므로 그 다음이 첫 후보다.
      list.querySelectorAll('.client-dd-item')[1]
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
  });
  // 칸을 떠나면 고른 사람으로 되돌린다 — 치다 만 글자가 남으면 지금 무엇을
  // 보고 있는지 화면이 거짓말을 한다.
  input.addEventListener('blur', () => { setTimeout(() => { syncClientPicker(); closeList(); }, 0); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#h-client-search') && !e.target.closest('#h-client-list')) closeList();
  });
  syncClientPicker();
}
