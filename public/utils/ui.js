/**
 * utils/ui.js — Smart Care Ledger v2
 * 공통 UI 유틸리티 함수 (toast, 확인 다이얼로그, 로딩, DOM 헬퍼)
 */

'use strict';

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
  el.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut .25s ease forwards';
    setTimeout(() => el.remove(), 260);
  }, duration);
}
