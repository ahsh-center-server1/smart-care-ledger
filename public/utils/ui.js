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

export function toast(msg, type='info', duration=3000) {
  const c = document.getElementById('toast-wrap');
  if (!c) return;
  const icons = { success:'✅', error:'❌', info:'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span aria-hidden="true">${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut .25s ease forwards';
    setTimeout(() => el.remove(), 260);
  }, duration);
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
