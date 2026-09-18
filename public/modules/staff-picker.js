// public/modules/staff-picker.js
//
// 「담당 직원」 고르기 — 검색 · 팀별 묶음 · 고른 사람 맨 위.
//
// 예전에는 높이 140px 상자 안의 2열 체크박스였다. 직원이 서른 명이면 일곱 명쯤
// 보이고 나머지는 스크롤인데 **검색이 없었고**, 누구를 골랐는지 보려면 끝까지
// 훑어야 했다. 입주자가 늘수록 이 화면을 여는 횟수도 같이 는다.
//
// 저장 쪽 계약은 그대로다 — 체크박스 이름은 여전히 `fc-staff` 이고, 저장은
// `input[name="fc-staff"]:checked` 를 읽는다. 검색은 **보이고 안 보이고**만
// 정하고 목록에서 빼지 않는다: 체크된 것이 DOM 에서 사라지면 저장하는 순간
// 그 사람의 배정이 조용히 지워진다.

'use strict';

import { S } from '../state.js';
import { escHtml } from '../utils/ui.js';
import { pickerModel, selectionSummary } from '../domain/staff-picker.js';

const LIST_ID = 'fc-staff-list';

/**
 * 지금 배정된 사람들 — 저장은 `userIds` 를 **쉼표로 이은 문자열**로 들고 있다.
 * 그 모양을 아는 곳을 여기 하나로 둔다(폼마다 따로 쪼개면 공백 처리가 갈린다).
 */
export function assignedIds(userIds) {
  if (Array.isArray(userIds)) return userIds.map(v => String(v).trim()).filter(Boolean);
  return String(userIds || '').split(',').map(v => v.trim()).filter(Boolean);
}

function memberRow(m) {
  const badge = (txt, color, bg) => `<span style="font-size:10px;font-weight:800;color:${color};`
    + `background:${bg};border-radius:99px;padding:1px 6px;">${escHtml(txt)}</span>`;
  return `<label class="staff-row" data-staff-row="${escHtml(m.userId)}"
      style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;
             border:1px solid var(--border);background:#f8fafc;cursor:pointer;font-size:13px;">
      <input type="checkbox" name="fc-staff" value="${escHtml(m.userId)}"${m.selected ? ' checked' : ''}
             style="accent-color:var(--blue);">
      <span style="font-weight:700;">${escHtml(m.name)}</span>
      ${m.role ? badge(m.role, '#475569', '#e2e8f0') : ''}
      ${m.inactive ? badge('퇴직', '#b91c1c', '#fee2e2') : ''}
    </label>`;
}

function groupBlock(g) {
  return `<div data-staff-group="${escHtml(g.team)}" style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
        <span style="font-size:11px;font-weight:900;color:var(--muted);">${escHtml(g.team)}
          <span data-group-count>(${g.selectedCount}/${g.members.length})</span></span>
        <button type="button" data-staff-team="${escHtml(g.team)}"
          style="font-size:11px;font-weight:700;color:var(--blue);background:none;border:none;cursor:pointer;">
          팀 전체</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        ${g.members.map(memberRow).join('')}
      </div>
    </div>`;
}

/**
 * 폼에 끼울 HTML. 선택 상태는 체크박스가 들고 있으므로 이 함수는 **처음 한 번만**
 * 그린다 — 검색할 때마다 다시 그리면 그 사이 바꾼 체크가 날아간다.
 */
export function staffPickerHtml(assigned = []) {
  const model = pickerModel(S.users, assignedIds(assigned), '');
  return `<div>
    <label class="label">담당 직원</label>
    <input type="search" id="fc-staff-search" class="input" placeholder="이름 · 아이디 · 팀으로 찾기"
           style="padding:8px 12px;margin-bottom:6px;" autocomplete="off">
    <div id="fc-staff-summary" style="font-size:12px;font-weight:700;color:var(--blue);
         background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:6px 10px;margin-bottom:6px;">
      ${escHtml(selectionSummary(model.selected))}</div>
    <div id="${LIST_ID}" style="max-height:220px;overflow-y:auto;padding:4px;border:1px solid var(--border);
         border-radius:10px;background:#fff;">
      ${model.groups.map(groupBlock).join('')}
      <div id="fc-staff-empty" style="display:none;font-size:12px;color:var(--muted);padding:10px;text-align:center;">
        찾는 직원이 없습니다</div>
    </div>
  </div>`;
}

/** 지금 체크된 사람들. 저장 경로와 **같은 선택자**를 쓴다. */
export function checkedStaffIds() {
  return Array.from(document.querySelectorAll('input[name="fc-staff"]:checked')).map(x => x.value);
}

function refreshSummary() {
  const list = document.getElementById(LIST_ID);
  const box = document.getElementById('fc-staff-summary');
  if (!list || !box) return;
  const checked = new Set(checkedStaffIds());
  const selected = Array.from(list.querySelectorAll('[data-staff-row]'))
    .filter(row => checked.has(row.dataset.staffRow))
    .map(row => ({ name: row.querySelector('span')?.textContent || row.dataset.staffRow }));
  box.textContent = selectionSummary(selected);

  // 고른 줄은 색으로 먼저 보이게 — 스크롤하지 않고도 눈에 띈다.
  list.querySelectorAll('[data-staff-row]').forEach((row) => {
    const on = checked.has(row.dataset.staffRow);
    row.style.background = on ? '#eff6ff' : '#f8fafc';
    row.style.borderColor = on ? '#bfdbfe' : 'var(--border)';
  });
  list.querySelectorAll('[data-staff-group]').forEach((g) => {
    const rows = g.querySelectorAll('[data-staff-row]');
    const n = Array.from(rows).filter(r => checked.has(r.dataset.staffRow)).length;
    const label = g.querySelector('[data-group-count]');
    if (label) label.textContent = `(${n}/${rows.length})`;
  });
}

function applySearch(query) {
  const list = document.getElementById(LIST_ID);
  if (!list) return;
  const model = pickerModel(S.users, checkedStaffIds(), query);
  const visible = new Set(model.groups.flatMap(g => g.matched));
  let shown = 0;
  list.querySelectorAll('[data-staff-row]').forEach((row) => {
    // 고른 사람은 검색과 무관하게 남긴다 — 검색어를 지우기 전에는 무엇을
    // 골랐는지 볼 수 없다면 검색이 오히려 헷갈리게 만든다.
    const keep = visible.has(row.dataset.staffRow) || row.querySelector('input')?.checked;
    row.style.display = keep ? '' : 'none';
    if (keep) shown += 1;
  });
  list.querySelectorAll('[data-staff-group]').forEach((g) => {
    const any = Array.from(g.querySelectorAll('[data-staff-row]')).some(r => r.style.display !== 'none');
    g.style.display = any ? '' : 'none';
  });
  const empty = document.getElementById('fc-staff-empty');
  if (empty) empty.style.display = shown ? 'none' : 'block';
}

/** 검색·팀 전체·요약을 붙인다. 폼을 그린 **뒤에** 한 번 부른다. */
export function bindStaffPicker() {
  const list = document.getElementById(LIST_ID);
  if (!list) return;

  document.getElementById('fc-staff-search')?.addEventListener('input', (e) => {
    applySearch(e.target.value);
  });

  list.addEventListener('change', (e) => {
    if (e.target.name === 'fc-staff') refreshSummary();
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-staff-team]');
    if (!btn) return;
    e.preventDefault();
    const group = btn.closest('[data-staff-group]');
    // 보이는 줄만 바꾼다. 검색으로 걸러 놓고 「팀 전체」를 누르면 안 보이는
    // 사람까지 딸려 오는 것이 가장 놀라운 동작이다.
    const rows = Array.from(group.querySelectorAll('[data-staff-row]'))
      .filter(r => r.style.display !== 'none');
    const boxes = rows.map(r => r.querySelector('input')).filter(Boolean);
    const turnOn = boxes.some(b => !b.checked);
    boxes.forEach((b) => { b.checked = turnOn; });
    refreshSummary();
  });

  refreshSummary();
}
