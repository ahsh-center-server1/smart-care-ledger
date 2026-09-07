/**
 * utils/ui.js — Smart Care Ledger v2
 * 공통 UI 유틸리티 함수 (toast, 확인 다이얼로그, 로딩, DOM 헬퍼)
 */

'use strict';

/**
 * HTML 속성값 내 특수문자를 이스케이프합니다.
 * onclick="fn('${escAttr(id)}')" 형태로 사용하여 XSS 방지.
 */
export function escAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * HTML 텍스트 노드용 이스케이프.
 *
 * escAttr은 속성값용이고, innerHTML 템플릿의 **본문**에 사용자 입력을 넣을 때는
 * 이 함수를 쓴다. 거래 내용(description)은 엑셀 업로드의 가맹점명 칸에서 오므로
 * 조작된 은행 파일 하나로 스크립트가 실행될 수 있다.
 *
 * 주의: `onclick="fn('${escAttr(x)}')"` 형태는 HTML 파서가 &#39;를 '로 되돌린
 * 뒤에 JS가 컴파일되므로 JS 문자열 문맥에서는 이스케이프가 무력하다.
 * 그런 곳은 addEventListener + dataset으로 옮겨야 한다.
 */
export function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function showConfirm(title, msg, onOk, okLabel='확인', okStyle='btn') {
  setText('c-title', title);
  setText('c-msg', msg);
  const btn = document.getElementById('c-ok');
  btn.textContent = okLabel;
  btn.className = okStyle || 'btn';
  btn.onclick = () => { closeConfirm(); onOk(); };
  document.getElementById('confirm-dialog').classList.add('show');
}

export function closeConfirm() {
  document.getElementById('confirm-dialog').classList.remove('show');
}

export function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

export function showLoading(on) {
  const el = document.getElementById('loading');
  if (!el) return;
  if (on) el.classList.add('show');
  else    el.classList.remove('show');
}

/**
 * 토스트.
 *
 * 메시지는 **textContent로 넣는다.** 예전에는 innerHTML 템플릿에 그대로
 * 끼워 넣었는데, 오류 경로가 `toast('저장 실패: '+e.message)` 형태로 부르고
 * Firestore 오류 메시지는 문서 내용을 되비칠 수 있다. 앱에서 가장 많이 불리는
 * UI 함수라 여기 하나가 열려 있으면 거의 모든 경로가 열려 있는 것과 같다.
 */
export function toast(msg, type='info', duration=3000) {
  const c = document.getElementById('toast-wrap');
  if (!c) return;
  const icons = { success:'✅', error:'❌', info:'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = icons[type] || 'ℹ️';
  const body = document.createElement('span');
  body.textContent = String(msg == null ? '' : msg);
  el.append(icon, body);
  c.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut .25s ease forwards';
    setTimeout(() => el.remove(), 260);
  }, duration);
}

/**
 * 액션 버튼이 달린 토스트 (되돌리기 등).
 * - actionLabel 버튼 클릭: onAction() 실행 후 즉시 닫힘 (onExpire 미실행)
 * - 시간 만료: onExpire() 실행 후 닫힘
 * 삭제 등 "실수 복구"용으로 사용. 기본 6초로 넉넉하게 노출.
 * @returns {Function} 프로그램적으로 즉시 닫는 함수(만료 콜백 실행)
 */
export function toastAction(msg, actionLabel, onAction, duration=6000, onExpire) {
  const c = document.getElementById('toast-wrap');
  if (!c) { if (onExpire) onExpire(); return () => {}; }
  const el = document.createElement('div');
  el.className = 'toast info';
  const msgSpan = document.createElement('span');
  msgSpan.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = actionLabel;
  btn.style.cssText = 'margin-left:auto;padding:6px 14px;border-radius:8px;border:1.5px solid var(--blue);background:var(--blue);color:#fff;font-weight:700;font-size:14px;cursor:pointer;flex-shrink:0;min-height:36px;';
  el.appendChild(document.createRange().createContextualFragment('<span aria-hidden="true">↩️</span>'));
  el.appendChild(msgSpan);
  el.appendChild(btn);
  c.appendChild(el);
  let done = false;
  const close = (runExpire) => {
    if (done) return; done = true;
    clearTimeout(timer);
    if (runExpire && onExpire) onExpire();
    el.style.animation = 'toastOut .25s ease forwards';
    setTimeout(() => el.remove(), 260);
  };
  btn.addEventListener('click', () => { close(false); if (onAction) onAction(); });
  const timer = setTimeout(() => close(true), duration);
  return () => close(true);
}

/**
 * 스켈레톤 로더 생성 유틸리티
 * @param {string} type - 'card' | 'row' | 'text'
 * @param {number} count - 생성할 개수
 * @returns {string} HTML 문자열
 */
export function skeleton(type = 'card', count = 3) {
  const templates = {
    card: '<div class="skeleton skeleton-card"></div>',
    row: '<div class="skeleton skeleton-row"></div>',
    text: '<div class="skeleton skeleton-text"></div>',
    textShort: '<div class="skeleton skeleton-text short"></div>',
    textLong: '<div class="skeleton skeleton-text long"></div>',
  };
  return Array(count).fill(templates[type] || templates.card).join('');
}

/**
 * 빈 상태 UI 생성 유틸리티
 * @param {string} icon - 아이콘 (이모지)
 * @param {string} message - 안내 메시지
 * @param {string} [ctaText] - CTA 버튼 텍스트 (옵션)
 * @param {string} [ctaAction] - CTA 버튼 onclick 핸들러 (옵션)
 * @returns {string} HTML 문자열
 */
export function emptyState(icon, message, ctaText, ctaAction) {
  let html = `<div class="empty-state">
    <div class="icon" aria-hidden="true">${icon}</div>
    <p>${message}</p>`;
  if (ctaText && ctaAction) {
    html += `<button class="btn" onclick="${ctaAction}">${ctaText}</button>`;
  }
  html += '</div>';
  return html;
}

/**
 * 떠 있는 패널을 드래그로 옮길 수 있게 한다.
 *
 * 왜 헬퍼로 뺐는가
 *   영수증·통장 미리보기가 각자 `document`에 mousemove/mouseup 리스너를
 *   **열 때마다 두 개씩** 붙였고, 닫기는 패널 엘리먼트만 지웠다.
 *   영수증을 50번 열면 살아 있는 핸들러 100개가 이미 제거된 DOM을 붙잡고 있다.
 *
 *   여기서는 **누르고 있는 동안에만** 문서에 리스너를 건다. 손을 떼면 사라지므로
 *   따로 정리할 것이 없고, 패널을 어떻게 닫든 누수가 생기지 않는다.
 */
export function makeDraggable(panel, handle) {
  if (!panel || !handle) return;
  let ox = 0, oy = 0;
  const onMove = (e) => {
    panel.style.left = (e.clientX - ox) + 'px';
    panel.style.top = (e.clientY - oy) + 'px';
    panel.style.right = 'auto';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    handle.style.cursor = 'grab';
  };
  handle.addEventListener('mousedown', (e) => {
    ox = e.clientX - panel.offsetLeft;
    oy = e.clientY - panel.offsetTop;
    handle.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}
