// public/modules/settings-audit.js
//
// 설정 「변경 이력」 패널.
//
// 읽기 비용
//   최근 100건을 **한 번만** 조회하고 분류·검색 필터는 화면에서 돌린다.
//   필터를 서버 쿼리로 만들면 조합마다 복합 인덱스가 필요하고, 필터를 바꿀
//   때마다 읽기가 다시 나간다. 100건이면 화면에서 걸러도 즉시 반응한다.
//   다시 읽는 것은 (1) 이 세션에서 새 기록을 썼을 때와 (2) 사용자가
//   「새로 고침」을 누를 때뿐이다. 다른 사람의 변경은 실시간일 필요가 없다.

'use strict';

import { toast, skeleton } from '../utils/ui.js';
import { fetchRecentAuditLogs, auditWriteToken } from '../services/audit.js';
import { actionLabel, actionResource, summaryText, AUDIT_RESOURCES } from '../domain/audit.js';
import { searchMatchesAny } from '../domain/hangul-search.js';

const PAGE_SIZE = 100;

/**
 * 이번 세션에서 읽어 둔 기록. 탭을 왕복해도 다시 읽지 않는다.
 * 단 이 세션에서 새 기록을 쓰면(auditWriteToken 증가) 다시 읽는다 —
 * 방금 한 변경이 목록에 없으면 "기록이 안 남았다"고 오해하게 된다.
 */
let cache = null;
let cacheToken = -1;
let filterResource = '';
let filterText = '';

/** Firestore Timestamp | Date | number | ISO 문자열을 사람이 읽는 시각으로. */
function formatTime(ts) {
  if (!ts) return '';
  const d = typeof ts?.toDate === 'function' ? ts.toDate()
    : ts instanceof Date ? ts
    : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function matches(entry) {
  if (filterResource && actionResource(entry.action) !== filterResource) return false;
  if (!filterText) return true;
  // 칸을 이어 붙여 한 문자열로 보지 않는다. 붙이면 띄어쓰기가 든 질의가
  // 칸 경계를 넘어 걸려서, 아무 칸에도 없는 말로 결과가 나온다.
  return searchMatchesAny([
    entry.actorName, entry.actorUid, entry.actorRole,
    actionLabel(entry.action), entry.action,
    entry.resourceId, summaryText(entry.summary),
  ], filterText);
}

export async function renderSettingsAudit() {
  const host = document.getElementById('audit-tab-content');
  if (!host) return;

  if (cache === null || cacheToken !== auditWriteToken()) {
    host.innerHTML = skeleton('row', 6);
    try {
      cache = await fetchRecentAuditLogs(PAGE_SIZE);
      cacheToken = auditWriteToken();
    } catch (e) {
      cache = [];
      host.textContent = '';
      const err = document.createElement('p');
      err.className = 'ui-error';
      err.textContent = `변경 이력을 읽을 수 없습니다: ${e.message || e}`;
      host.appendChild(err);
      return;
    }
  }
  paint(host);
}

/** 다시 읽는다 (사용자가 눌렀을 때만). */
export async function reloadSettingsAudit() {
  cache = null;
  cacheToken = -1;
  await renderSettingsAudit();
}

function paint(host) {
  host.textContent = '';

  // ── 도구 줄 ──
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:.75rem;';

  const resWrap = document.createElement('div');
  const resLabel = document.createElement('label');
  resLabel.className = 'ui-label';
  resLabel.textContent = '분류';
  resLabel.htmlFor = 'audit-resource';
  const resSel = document.createElement('select');
  resSel.id = 'audit-resource';
  resSel.className = 'ui-select';
  resSel.style.width = 'auto';
  resSel.appendChild(new Option('전체', ''));
  // 실제로 기록이 있는 분류만 보여준다 — 텅 빈 선택지를 늘리지 않는다.
  const present = new Set(cache.map(e => actionResource(e.action)));
  for (const r of AUDIT_RESOURCES) {
    if (present.has(r.key)) resSel.appendChild(new Option(r.label, r.key));
  }
  resSel.value = filterResource;
  resSel.addEventListener('change', () => { filterResource = resSel.value; paint(host); });
  resWrap.append(resLabel, resSel);

  const qWrap = document.createElement('div');
  qWrap.style.flex = '1 1 12rem';
  const qLabel = document.createElement('label');
  qLabel.className = 'ui-label';
  qLabel.textContent = '검색 (사람·작업·대상)';
  qLabel.htmlFor = 'audit-search';
  const q = document.createElement('input');
  q.id = 'audit-search';
  q.type = 'search';
  q.className = 'ui-input';
  q.value = filterText;
  q.placeholder = '이름이나 작업을 입력하세요';
  q.addEventListener('input', () => { filterText = q.value; paint(host); });
  qWrap.append(qLabel, q);

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'ui-btn ui-btn--outline';
  reload.textContent = '↺ 새로 고침';
  reload.title = '지금까지의 기록을 다시 읽습니다';
  reload.addEventListener('click', async () => {
    reload.disabled = true;
    try { await reloadSettingsAudit(); }
    catch (e) { toast('다시 읽기 실패: ' + (e.message || e), 'error'); }
    finally { reload.disabled = false; }
  });

  bar.append(resWrap, qWrap, reload);
  host.appendChild(bar);

  // ── 목록 ──
  const shown = cache.filter(matches);

  if (cache.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ui-hint';
    empty.textContent = '아직 기록이 없습니다. 이 기능을 켠 뒤의 변경부터 남습니다.';
    host.appendChild(empty);
    return;
  }
  if (shown.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ui-hint';
    empty.textContent = '조건에 맞는 기록이 없습니다.';
    host.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'ui-log';

  for (const e of shown) {
    const row = document.createElement('div');
    row.className = 'ui-log__row';

    const time = document.createElement('span');
    time.className = 'ui-log__time';
    time.textContent = formatTime(e.timestamp);
    row.appendChild(time);

    const what = document.createElement('span');
    what.className = 'ui-log__what';
    const title = document.createElement('strong');
    // 전부 textContent로 넣는다 — 기록에는 입주자·직원 이름과 거래 내용이
    // 섞여 들어오므로 innerHTML로 다루면 그대로 XSS 경로가 된다.
    title.textContent = actionLabel(e.action);
    what.appendChild(title);
    const detail = summaryText(e.summary);
    if (detail) {
      const d = document.createElement('span');
      d.className = 'ui-log__detail';
      d.textContent = detail;
      what.appendChild(d);
    }
    row.appendChild(what);

    const who = document.createElement('span');
    who.className = 'ui-log__who';
    who.textContent = e.actorRole ? `${e.actorName} (${e.actorRole})` : String(e.actorName || '');
    row.appendChild(who);

    list.appendChild(row);
  }
  host.appendChild(list);

  const note = document.createElement('p');
  note.className = 'ui-hint';
  note.style.marginTop = '.75rem';
  note.textContent = shown.length === cache.length
    ? `최근 ${cache.length}건 · 기록은 2년 후 자동 삭제됩니다.`
    : `${cache.length}건 중 ${shown.length}건 표시 · 기록은 2년 후 자동 삭제됩니다.`;
  host.appendChild(note);
}

/** 로그아웃 시 캐시를 비운다 — 다음 사람에게 남의 기록이 보이면 안 된다. */
export function clearAuditCache() {
  cache = null;
  cacheToken = -1;
  filterResource = '';
  filterText = '';
}
