// public/modules/bank-parser-ui.js
//
// 은행 추가 — **파일을 열어 보고, 어느 열이 무엇인지 고른다.**
//
// 왜 이 화면이 필요한가
//   지금까지 은행 하나를 늘리는 일은 `parser-config.js` 에 한 줄을 넣고 **배포**
//   하는 것이었다. 이 시스템을 운영하는 사람은 사회복지사라, 그 한 줄 때문에
//   거래처 은행이 바뀔 때마다 개발자를 불러야 했다. 결국 아무도 안 부르고 그
//   은행의 거래는 손으로 옮겨 적힌다.
//
// 왜 「자동 분석」이 아니라 「고르기」인가
//   자동으로 다 하겠다고 하면 틀렸을 때 사고가 난다 — 출금과 입금이 뒤집힌
//   파일이 그대로 장부에 들어가고, 미리보기에서도 그럴듯해 보인다. 그래서
//   **추천은 첫 선택을 채워 주는 것까지**이고 결정은 사람이 한다. 규칙이 먼저
//   추천하고(`services/bank-parser-guess.js`), 「✨ AI 추천」은 그 위에 얹는다.
//   AI 에게 보내는 것은 **머리글 글자와 열의 꼴**뿐이다(거래는 한 줄도 안 간다).
//
// 왜 떠 있는 창인가
//   엑셀 업로드 모달에서 열리는데, 그 모달의 `#modal-body` 를 갈아 끼우면
//   고른 계좌와 파일이 사라진다. 저장한 뒤 **그 자리에서 다시 분석**하는 것이
//   이 기능의 요점이라 그럴 수 없다.
//
// 이 파일은 화면 모듈 중 얽힘(SCC)에 든 것을 부르지 않는다 — permissions 는
// 사실상 등급표다. test/architecture.test.mjs 가 그 선을 지킨다.

'use strict';

import { S } from '../state.js';
import { toast, escHtml, escAttr, showConfirm, makeDraggable } from '../utils/ui.js';
import { can } from './permissions.js';
import { iconSvg } from '../utils/icons.js';
import { fnErrorMessage } from '../services/fn-errors.js';
import { readFileSheets } from '../services/excel-parser.js';
import { guessBankParser } from '../services/bank-parser-guess.js';
import { bankParserFromPicks, bankParserProblem, normalizeBankParsers } from '../domain/bank-parser.js';

const PANEL_ID = 'bank-parser-panel';

/** 열 하나가 맡을 수 있는 자리. 값은 `domain/bank-parser.js` 의 필드 이름이다. */
const ROLES = [
  { v: '',         label: '— 안 씀 —' },
  { v: 'DATE',     label: '날짜' },
  { v: 'DESC',     label: '내용(적요)' },
  { v: 'WITHDRAW', label: '출금' },
  { v: 'DEPOSIT',  label: '입금' },
  { v: 'AMT',      label: '금액(출금만)' },
  { v: 'SKIP_IF',  label: '취소 표시' },
];

/** 편집 중인 것. 저장을 누를 때까지 화면에만 있다. */
let W = null;

const el = (id) => document.getElementById(id);
const closePanel = () => { el(PANEL_ID)?.remove(); W = null; };

// ─────────────────────────────────────────────
// 저장된 목록 — 설정 화면
// ─────────────────────────────────────────────

/**
 * 설정 → 시스템 → 「은행 파서」.
 *
 * 내장 은행은 여기 적지 않는다. 이 화면이 답하는 질문은 "내가 추가한 것이
 * 무엇인가"이고, 내장 목록까지 섞으면 지울 수 있는 것과 없는 것이 한 줄
 * 간격으로 붙어 헷갈린다.
 */
export function renderBankParserPanel() {
  const host = el('bankparser-tab-content');
  if (!host) return;
  if (!can('excel.upload')) {
    host.innerHTML = '<div class="card" style="padding:18px;font-size:13px;color:var(--muted);">'
      + '엑셀 업로드 권한이 있는 역할(담당자)만 은행을 추가합니다.</div>';
    return;
  }
  const list = normalizeBankParsers(S.bankParsers);
  // 읽지 않았으면 null 이다 — 「없음」이라고 적으면 못 읽은 것을 없다고 보고한다.
  const body = S.bankParsers == null
    ? '<div style="padding:16px;font-size:13px;color:var(--muted);">불러오는 중…</div>'
    : (list.length ? list.map(rowHtml).join('') : emptyHtml());

  host.innerHTML = `
    <div class="card" style="padding:18px;">
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
        <div style="flex:1;min-width:240px;">
          <div style="font-size:15px;font-weight:800;color:var(--text);margin-bottom:4px;">은행 파서</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.6;">
            내장돼 있지 않은 은행의 거래내역 파일을 읽게 합니다. 그 은행 파일을 하나 고르면
            어느 열이 날짜·내용·출금·입금인지 고르는 화면이 열립니다.<br>
            추가한 설정은 <strong>내장 은행 뒤에서</strong> 판정하므로, 이미 잘 되던 은행에는
            영향을 주지 않습니다.
          </div>
        </div>
        <button id="bp-add-btn" class="btn" style="white-space:nowrap;">${iconSvg('plus')}파일로 은행 추가</button>
        <input type="file" id="bp-add-file" accept=".xlsx,.xls,.html,.htm,.csv" style="display:none;">
      </div>
      <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;">${body}</div>
    </div>`;

  const fi = el('bp-add-file');
  el('bp-add-btn')?.addEventListener('click', () => fi.click());
  fi?.addEventListener('change', () => {
    if (fi.files && fi.files.length) openBankParserWizard(fi.files[0]);
    fi.value = '';
  });
  host.querySelectorAll('[data-bp-del]').forEach((btn) => {
    btn.addEventListener('click', () => confirmDelete(btn.dataset.bpDel, btn.dataset.bpLabel || ''));
  });
}

function emptyHtml() {
  return '<div style="padding:22px;text-align:center;font-size:13px;color:var(--muted);">'
    + '추가한 은행이 없습니다. 내장 은행(국민·농협·우리·신한·수기 양식)은 그대로 동작합니다.</div>';
}

function rowHtml(p) {
  const cols = [
    ['날짜', p.DATE], ['내용', p.DESC], ['출금', p.WITHDRAW],
    ['입금', p.DEPOSIT], ['금액', p.AMT], ['취소표시', p.SKIP_IF],
  ].filter(([, v]) => v)
    .map(([k, v]) => `<span style="display:inline-block;margin-right:10px;">${k}: <code>${escHtml(v)}</code></span>`)
    .join('');
  return `<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:flex-start;">
    <div style="flex:1;min-width:0;">
      <div style="font-size:14px;font-weight:700;color:var(--text);">${escHtml(p.label)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px;line-height:1.8;">${cols}</div>
    </div>
    <button data-bp-del="${escAttr(p.key)}" data-bp-label="${escAttr(p.label)}"
      class="btn-sub" style="color:#dc2626;border-color:#fecaca;white-space:nowrap;">삭제</button>
  </div>`;
}

function confirmDelete(key, label) {
  showConfirm('은행 파서 삭제', `「${label}」 설정을 지웁니다. 이미 저장된 거래는 그대로입니다.`, async () => {
    try {
      const res = await window._fbFn.call('deleteBankParser')({ key });
      S.bankParsers = normalizeBankParsers(res.data && res.data.parsers);
      renderBankParserPanel();
      toast('지웠습니다.', 'success');
    } catch (err) { toast(fnErrorMessage(err), 'error', 5000); }
  }, '삭제', 'btn');
}

// ─────────────────────────────────────────────
// 열 고르기
// ─────────────────────────────────────────────

/**
 * 파일 하나를 열어 「어느 열이 무엇인가」를 묻는다.
 *
 * @param {File} file
 * @param {Function} [onSaved]  저장 뒤 부를 것 — 업로드 화면이 다시 분석한다.
 */
export async function openBankParserWizard(file, onSaved) {
  if (!can('excel.upload')) { toast('권한이 없습니다.', 'error'); return; }
  let sheets = [];
  try {
    ({ sheets } = await readFileSheets(file));
  } catch (err) {
    toast('파일을 읽지 못했습니다: ' + (err.message || ''), 'error', 5000); return;
  }
  if (!sheets.length) {
    toast('표를 찾지 못했습니다. 엑셀·CSV 파일에서만 은행을 추가할 수 있습니다.', 'error', 6000);
    return;
  }
  // 줄이 가장 많은 시트가 거래내역이다 — 앞에 안내 시트가 붙은 파일이 흔하다.
  const sheetIdx = sheets.reduce((best, s, i) => (s.rows.length > sheets[best].rows.length ? i : best), 0);
  W = {
    file, sheets, sheetIdx, onSaved,
    label: String(file.name || '').replace(/\.[^.]+$/, '').slice(0, 30),
    roles: new Map(), header: [], headerRow: -1, shapes: [],
  };
  applyGuess();
  drawPanel();
}

/** 규칙 추천을 지금 시트에 적용한다. */
function applyGuess() {
  const rows = W.sheets[W.sheetIdx].rows;
  const g = guessBankParser(rows);
  W.roles = new Map();
  if (!g) {
    W.headerRow = 0;
    W.header = (rows[0] || []).map(v => String(v ?? '').trim());
    W.shapes = [];
    return;
  }
  W.headerRow = g.headerRow;
  W.header = g.header;
  W.shapes = g.shapes;
  for (const [role, idx] of Object.entries(g.picks)) {
    if (Number.isInteger(idx) && idx >= 0) W.roles.set(idx, role);
  }
}

function currentPicks() {
  const picks = {};
  for (const [idx, role] of W.roles.entries()) if (role) picks[role] = idx;
  return picks;
}

function currentDraft() {
  return bankParserFromPicks(W.label, W.header, currentPicks());
}

function drawPanel() {
  el(PANEL_ID)?.remove();
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.cssText = 'position:fixed;left:50%;top:40px;transform:translateX(-50%);'
    + 'width:min(920px,94vw);max-height:88vh;z-index:9999;background:var(--card,#fff);'
    + 'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;'
    + 'flex-direction:column;overflow:hidden;border:1px solid var(--border);';
  panel.innerHTML = `
    <div id="bp-head" style="padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border);
      cursor:move;display:flex;align-items:center;gap:10px;user-select:none;">
      <span style="font-size:14px;font-weight:800;color:var(--text);flex:1;">은행 추가 — 어느 열이 무엇인가요?</span>
      <button id="bp-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted);line-height:1;">✕</button>
    </div>
    <div style="padding:14px 16px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;border-bottom:1px solid var(--border);">
      <div style="flex:1;min-width:180px;">
        <label class="label">은행 이름</label>
        <input id="bp-label" class="input" style="padding:8px 12px;" value="${escAttr(W.label)}"
          placeholder="예: 하나은행 · IBK기업은행">
      </div>
      ${W.sheets.length > 1 ? `<div><label class="label">시트</label>
        <select id="bp-sheet" class="input" style="padding:8px 12px;">
          ${W.sheets.map((s, i) => `<option value="${i}"${i === W.sheetIdx ? ' selected' : ''}>${escHtml(s.name)} (${s.rows.length}줄)</option>`).join('')}
        </select></div>` : ''}
      <button id="bp-ai" class="btn-sub" style="white-space:nowrap;">${iconSvg('sparkle')}AI 추천</button>
    </div>
    <div id="bp-body" style="flex:1;overflow:auto;padding:8px 16px;"></div>
    <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:center;">
      <div id="bp-problem" style="flex:1;font-size:12px;color:#b91c1c;"></div>
      <button id="bp-cancel" class="btn-sub">닫기</button>
      <button id="bp-save" class="btn">저장</button>
    </div>`;
  document.body.appendChild(panel);
  makeDraggable(panel, panel.querySelector('#bp-head'));

  el('bp-close').addEventListener('click', closePanel);
  el('bp-cancel').addEventListener('click', closePanel);
  el('bp-label').addEventListener('input', (e) => { W.label = e.target.value.trim(); refreshProblem(); });
  el('bp-sheet')?.addEventListener('change', (e) => {
    W.sheetIdx = Number(e.target.value) || 0; applyGuess(); drawTable(); refreshProblem();
  });
  el('bp-ai').addEventListener('click', askAi);
  el('bp-save').addEventListener('click', save);
  drawTable();
  refreshProblem();
}

/** 머리글 + 앞 다섯 줄. 값을 보여 주는 이유는 열 이름만으로는 확신이 안 서기 때문이다. */
function drawTable() {
  const body = el('bp-body'); if (!body) return;
  const rows = W.sheets[W.sheetIdx].rows;
  const sample = rows.slice(W.headerRow + 1, W.headerRow + 6);
  const width = Math.max(W.header.length, ...sample.map(r => (r || []).length), 1);

  const head = Array.from({ length: width }, (_, c) => {
    const role = W.roles.get(c) || '';
    const opts = ROLES.map(r => `<option value="${r.v}"${r.v === role ? ' selected' : ''}>${r.label}</option>`).join('');
    return `<th style="padding:6px 5px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border);min-width:96px;">
      <select data-bp-col="${c}" class="input" style="padding:4px 6px;font-size:12px;width:100%;">${opts}</select>
      <div style="font-size:11px;font-weight:700;color:var(--sub);margin-top:4px;word-break:break-all;">
        ${escHtml(W.header[c] || '(빈 칸)')}</div>
    </th>`;
  }).join('');

  const bodyRows = sample.map(r => '<tr>' + Array.from({ length: width }, (_, c) =>
    `<td style="padding:4px 5px;font-size:11px;color:var(--sub);border-top:1px solid var(--border);
      max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
      ${escHtml(String((r || [])[c] ?? ''))}</td>`).join('') + '</tr>').join('');

  body.innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin:6px 0 10px;">
      ${W.headerRow >= 0 ? `머리글로 ${W.headerRow + 1}행을 잡았습니다.` : ''}
      각 열 위의 목록에서 그 열이 무엇인지 고르세요. 값 다섯 줄을 함께 보여 드립니다.
    </div>
    <div style="overflow-x:auto;"><table style="border-collapse:collapse;width:100%;">
      <thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;

  body.querySelectorAll('[data-bp-col]').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const c = Number(e.target.dataset.bpCol);
      const role = e.target.value;
      // 한 자리는 한 열뿐이다 — 같은 자리를 이미 맡은 열이 있으면 그쪽을 비운다.
      if (role) for (const [idx, r] of [...W.roles.entries()]) if (r === role && idx !== c) W.roles.delete(idx);
      if (role) W.roles.set(c, role); else W.roles.delete(c);
      drawTable(); refreshProblem();
    });
  });
}

function refreshProblem() {
  const box = el('bp-problem'); if (!box) return;
  const problem = bankParserProblem(currentDraft());
  box.textContent = problem;
  const save = el('bp-save'); if (save) save.disabled = !!problem;
}

/**
 * AI 추천 — **머리글 글자와 열의 꼴만** 보낸다. 거래는 한 줄도 가지 않는다.
 * 실패해도 규칙 추천이 화면에 그대로 남으므로 여기서 멈출 이유가 없다.
 */
async function askAi() {
  const btn = el('bp-ai'); if (!btn) return;
  const kindOf = (c) => (W.shapes.find(s => s.idx === c) || {}).kind || 'text';
  const columns = W.header.map((label, index) => ({ index, label: String(label || ''), kind: kindOf(index) }));
  btn.disabled = true; btn.textContent = '묻는 중…';
  try {
    const res = await window._fbFn.call('suggestBankParser')({ columns });
    const p = (res.data && res.data.picks) || {};
    const MAP = { date: 'DATE', description: 'DESC', withdraw: 'WITHDRAW', deposit: 'DEPOSIT', amount: 'AMT', cancelFlag: 'SKIP_IF' };
    const next = new Map();
    for (const [from, role] of Object.entries(MAP)) {
      const idx = Number(p[from]);
      // 목록 밖의 번호는 버린다 — 모델이 없는 열을 지어내면 조용히 어긋난다.
      if (Number.isInteger(idx) && idx >= 0 && idx < W.header.length && !next.has(idx)) next.set(idx, role);
    }
    if (!next.size) { toast('추천을 받지 못했습니다. 직접 골라 주세요.', 'info', 4000); return; }
    W.roles = next;
    drawTable(); refreshProblem();
    toast('추천을 채웠습니다. 맞는지 확인하고 저장하세요.', 'success', 4000);
  } catch (err) {
    toast(fnErrorMessage(err), 'info', 5000);
  } finally {
    btn.disabled = false; btn.innerHTML = iconSvg('sparkle') + 'AI 추천';
  }
}

async function save() {
  const draft = currentDraft();
  const problem = bankParserProblem(draft);
  if (problem) { toast(problem, 'error'); return; }
  const btn = el('bp-save'); if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
  try {
    const res = await window._fbFn.call('saveBankParser')({ parser: draft });
    S.bankParsers = normalizeBankParsers(res.data && res.data.parsers);
    const again = W.onSaved;
    closePanel();
    renderBankParserPanel();
    toast(`「${draft.label}」 을(를) 추가했습니다.`, 'success', 4000);
    if (again) await again();
  } catch (err) {
    toast(fnErrorMessage(err), 'error', 6000);
    if (btn) { btn.disabled = false; btn.textContent = '저장'; }
  }
}
