// public/modules/settings-teams.js
//
// 팀 관리 — 팀을 만들고 팀장을 지정한다.
//
// 이 화면이 하는 일은 딱 하나다: **고르는 목록을 만드는 것.** 직원은 여기 있는
// 이름 중에서 팀을 고르고(자유 입력이 아니라), 입주자에 팀을 정하면 담당 후보가
// 그 팀으로 좁혀진다. 서른 명 중에서 고르던 것이 다섯 명이 된다.
//
// ⚠️ 팀은 **권한을 주지 않는다.** 조회 범위는 여전히 담당 배정의 투영본(authz)이
//    정한다 — domain/teams.js 머리말에 왜 그렇게 두는지 적어 뒀다.

'use strict';

import { S } from '../state.js';
import { toast, escHtml, showConfirm } from '../utils/ui.js';
import { can } from './permissions.js';
import { fnErrorMessage } from '../services/fn-errors.js';
import { iconSvg } from '../utils/icons.js';
import {
  normalizeTeams, deriveTeamsFromUsers, validateTeams, membersOfTeam,
} from '../domain/teams.js';

/** 편집 중인 목록. 저장을 누를 때까지 화면에만 있다. */
let draft = null;

function leaderOptions(selected) {
  const leaders = (S.users || []).filter(u => u.role === '팀장' && u.active !== false);
  return ['<option value="">— 미지정 —</option>']
    .concat(leaders.map(u => `<option value="${escHtml(u.userId)}"`
      + `${String(selected) === String(u.userId) ? ' selected' : ''}>${escHtml(u.name || u.userId)}</option>`))
    .join('');
}

function row(t, i) {
  const members = membersOfTeam(S.users || [], t.name).length;
  return `<tr data-team-row="${i}">
    <td style="padding:8px 6px;">
      <input class="input" data-team-name value="${escHtml(t.name)}" style="padding:7px 10px;">
    </td>
    <td style="padding:8px 6px;">
      <select class="input" data-team-leader style="padding:7px 10px;">${leaderOptions(t.leaderUid)}</select>
    </td>
    <td style="padding:8px 6px;text-align:center;font-size:13px;color:var(--muted);">${members}명</td>
    <td style="padding:8px 6px;text-align:center;">
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;white-space:nowrap;">
        <input type="checkbox" data-team-active${t.active ? ' checked' : ''} style="accent-color:var(--blue);">
        사용
      </label>
    </td>
    <td style="padding:8px 6px;text-align:right;">
      <button type="button" class="icon-btn del" data-team-del="${i}" title="삭제">${iconSvg('trash',18)}</button>
    </td>
  </tr>`;
}

/** 화면 → draft. 저장 직전과 줄을 더하기 전에 부른다(입력 중인 값을 잃지 않게). */
function readDraft() {
  const rows = document.querySelectorAll('#teams-table tbody tr[data-team-row]');
  draft = Array.from(rows).map((tr, i) => ({
    id: (draft && draft[i] && draft[i].id) || '',
    name: tr.querySelector('[data-team-name]').value.trim(),
    leaderUid: tr.querySelector('[data-team-leader]').value,
    active: tr.querySelector('[data-team-active]').checked,
  }));
  return draft;
}

export function renderTeamsPanel() {
  const el = document.getElementById('team-tab-content');
  if (!el) return;
  if (!can('assignments.manage')) {
    el.innerHTML = '<p style="color:var(--muted);font-size:13px;">팀을 관리할 권한이 없습니다.</p>';
    return;
  }
  if (!draft) draft = normalizeTeams(S.teams);

  const unassigned = membersOfTeam(S.users || [], '')
    .filter(u => !String(u.team || '').trim() && u.active !== false).length;

  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
      <button class="btn-sub" id="btn-team-add">+ 팀 추가</button>
      <button class="btn-sub" id="btn-team-derive"
        title="직원들이 적어 둔 팀 이름에서 목록을 만듭니다. 이미 있는 팀은 그대로 둡니다.">
        ${iconSvg('refresh')}직원 정보에서 가져오기</button>
      <button class="btn" id="btn-team-save" style="margin-left:auto;">${iconSvg('check')}저장</button>
    </div>
    <table id="teams-table" style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead><tr style="text-align:left;color:var(--muted);font-size:12px;">
        <th style="padding:4px 6px;">팀 이름</th><th style="padding:4px 6px;">팀장</th>
        <th style="padding:4px 6px;text-align:center;">소속</th>
        <th style="padding:4px 6px;text-align:center;">사용</th><th></th>
      </tr></thead>
      <tbody>${draft.map(row).join('')}</tbody>
    </table>
    ${draft.length ? '' : '<p style="color:var(--muted);font-size:13px;padding:12px 0;">'
      + '아직 팀이 없습니다. 「직원 정보에서 가져오기」를 누르면 지금 직원들이 적어 둔 '
      + '팀 이름으로 목록을 만듭니다.</p>'}
    <p style="font-size:12px;color:var(--muted);margin-top:14px;line-height:1.6;">
      팀은 <b>고르는 범위</b>만 정합니다 — 누가 무엇을 볼 수 있는지는 입주자별 담당 배정이
      그대로 정합니다.<br>
      팀에 속하지 않은 직원 ${unassigned}명은 팀이 정해진 입주자의 담당으로 고를 수 없습니다.
    </p>`;

  document.getElementById('btn-team-add').addEventListener('click', () => {
    readDraft().push({ id: '', name: '', leaderUid: '', active: true });
    renderTeamsPanel();
  });
  document.getElementById('btn-team-derive').addEventListener('click', () => {
    draft = deriveTeamsFromUsers(S.users || [], readDraft());
    renderTeamsPanel();
    toast('직원 정보에서 팀을 가져왔습니다. 확인하고 저장하세요.', 'info', 4000);
  });
  document.getElementById('btn-team-save').addEventListener('click', saveTeams);
  el.querySelectorAll('[data-team-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.teamDel);
      const target = readDraft()[i];
      const members = membersOfTeam(S.users || [], target.name).length;
      // 사람이 남아 있는 팀을 지우면 그 사람들의 `team` 값이 목록에 없는 이름으로
      // 남는다. 지우는 것보다 「사용」을 끄는 편이 안전하다고 먼저 알린다.
      if (members) {
        showConfirm('팀 삭제',
          `${target.name} 에는 직원 ${members}명이 속해 있습니다. `
          + '지우면 그 직원들의 팀이 목록에 없는 이름으로 남습니다. 계속할까요?',
          () => { draft.splice(i, 1); renderTeamsPanel(); });
        return;
      }
      draft.splice(i, 1);
      renderTeamsPanel();
    });
  });
}

async function saveTeams() {
  const teams = readDraft();
  const errors = validateTeams(teams);
  if (errors.length) { toast(errors[0], 'error', 5000); return; }

  const btn = document.getElementById('btn-team-save');
  if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
  try {
    const res = await window._fbFn.call('saveTeams')({ teams });
    S.teams = normalizeTeams((res.data && res.data.teams) || teams);
    draft = normalizeTeams(S.teams);
    toast('팀을 저장했습니다.', 'success');
    renderTeamsPanel();
  } catch (e) {
    toast(fnErrorMessage(e, '팀 저장에 실패했습니다.'), 'error', 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = iconSvg('check') + '저장'; }
  }
}

/** 설정을 떠났다 돌아오면 서버 값으로 다시 시작한다. */
export function resetTeamsDraft() { draft = null; }
