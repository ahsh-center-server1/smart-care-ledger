// public/modules/settings-shell.js
//
// 설정 화면의 껍데기 — 레일·선택·패널 전환을 SETTINGS_TABS 하나로 그린다.
//
// 왜 분리했나
//   settings.js는 806줄이고 이미 목록·카테고리·규칙·예산·마감·권한을 다 담고 있다.
//   여기에 탐색까지 넣으면 무엇이 무엇을 그리는지 읽을 수 없다.
//   이 파일은 "어느 패널을 보여줄지"만 안다 — 패널 내용은 각 렌더 함수의 몫이다.

'use strict';

import { iconSvg } from '../utils/icons.js';

import {
  SETTINGS_TABS, SETTINGS_GROUPS, SETTINGS_TAB_BY_KEY,
  canSeeSettingsTab, visibleSettingsTabs, initialSettingsTab,
} from './settings-nav.js';
import { toast } from '../utils/ui.js';

const STORAGE_KEY = 'scl_settingsTab';

/** 지금 열린 탭. */
let activeTab = null;

/**
 * 패널을 그려야 할 때 불릴 함수들. settings.js가 등록한다.
 * 여기서 직접 import하면 settings.js ↔ 이 파일이 순환 참조가 된다.
 */
const renderers = new Map();

/** 탭이 열릴 때 실행할 렌더 함수를 등록한다. */
export function registerPanel(key, fn) {
  renderers.set(key, fn);
}

export function currentSettingsTab() {
  return activeTab;
}

function readStored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
}
function writeStored(key) {
  try { localStorage.setItem(STORAGE_KEY, key); } catch (e) { /* 저장소 차단 환경 */ }
}

/**
 * 탭을 전환한다.
 *
 * 권한이 없으면 조용히 무시하지 않고 알린다 — 눌렀는데 아무 일도 안 일어나면
 * 고장으로 읽힌다. 다만 alert()이 아니라 토스트를 쓴다(모달이 흐름을 끊지 않게).
 */
export function switchSettingsTab(key) {
  if (!canSeeSettingsTab(key)) {
    const tab = SETTINGS_TAB_BY_KEY[key];
    toast(tab ? `${tab.label}은 권한이 없습니다.` : '알 수 없는 설정 항목입니다.', 'error');
    return;
  }

  activeTab = key;
  writeStored(key);

  // 패널 표시
  document.querySelectorAll('#view-settings .tab-content')
    .forEach(el => el.classList.remove('active'));
  document.getElementById(`${key}-tab-content`)?.classList.add('active');

  // 제목·설명
  const tab = SETTINGS_TAB_BY_KEY[key];
  const titleEl = document.getElementById('settings-panel-title');
  const descEl = document.getElementById('settings-panel-desc');
  // 아이콘은 SVG 라 textContent 로는 들어가지 않는다. 이름은 우리 상수뿐이지만
  // 값이 아니라 **요소로** 넣는다 — 나중에 라벨이 데이터가 돼도 안전하게.
  if (titleEl) {
    titleEl.textContent = '';
    const ic = document.createElement('span');
    ic.innerHTML = iconSvg(tab.icon, 20);
    ic.setAttribute('aria-hidden', 'true');
    titleEl.append(ic, ' ', tab.label);
  }
  if (descEl) descEl.textContent = tab.desc || '';

  // 레일·선택 상태
  document.querySelectorAll('#settings-rail .ui-settings__tab').forEach(btn => {
    if (btn.dataset.tab === key) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  const picker = document.getElementById('settings-tab-picker');
  if (picker && picker.value !== key) picker.value = key;

  // 패널 내용
  const render = renderers.get(key);
  if (render) {
    try { render(); }
    catch (e) { toast(`${tab.label} 표시 실패: ${e.message}`, 'error'); }
  }
}

/** 그룹 레일. 권한에 걸려 전부 빈 그룹은 그리지 않는다. */
function renderRail() {
  const rail = document.getElementById('settings-rail');
  if (!rail) return;
  rail.textContent = '';

  for (const group of SETTINGS_GROUPS) {
    const items = group.items.filter(canSeeSettingsTab);
    if (items.length === 0) continue;          // 빈 그룹 제목만 남지 않게

    const wrap = document.createElement('div');
    wrap.className = 'ui-settings__group';

    const label = document.createElement('div');
    label.className = 'ui-settings__group-label';
    label.textContent = group.label;
    wrap.appendChild(label);

    for (const key of items) {
      const tab = SETTINGS_TAB_BY_KEY[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-settings__tab';
      btn.dataset.tab = key;
      btn.title = tab.desc || tab.label;

      const icon = document.createElement('span');
      icon.innerHTML = iconSvg(tab.icon, 18);
      icon.setAttribute('aria-hidden', 'true');
      btn.appendChild(icon);

      const text = document.createElement('span');
      text.textContent = tab.label;
      btn.appendChild(text);

      // 승인 대기 같은 알림 개수를 붙일 자리 (updateSettingsBadges가 채운다)
      const badge = document.createElement('span');
      badge.className = 'ui-badge ui-badge--warning ui-count';
      badge.dataset.count = '0';
      badge.dataset.badgeFor = key;
      badge.style.marginLeft = 'auto';
      btn.appendChild(badge);

      btn.addEventListener('click', () => switchSettingsTab(key));
      wrap.appendChild(btn);
    }
    rail.appendChild(wrap);
  }
}

/** 좁은 화면용 select. optgroup으로 같은 4분류를 유지한다. */
function renderPicker() {
  const picker = document.getElementById('settings-tab-picker');
  if (!picker) return;
  picker.textContent = '';

  for (const group of SETTINGS_GROUPS) {
    const items = group.items.filter(canSeeSettingsTab);
    if (items.length === 0) continue;
    const og = document.createElement('optgroup');
    og.label = group.label;
    for (const key of items) {
      const tab = SETTINGS_TAB_BY_KEY[key];
      // <option> 안에는 그림이 들어가지 않는다(브라우저가 글자만 그린다).
      og.appendChild(new Option(tab.label, key));
    }
    picker.appendChild(og);
  }

  if (!picker.dataset.bound) {
    picker.dataset.bound = '1';
    picker.addEventListener('change', e => switchSettingsTab(e.target.value));
  }
}

/**
 * 탭 옆 개수 뱃지를 갱신한다. 0이면 CSS가 감춘다.
 * @param {Object} counts { [tabKey]: number }
 */
export function updateSettingsBadges(counts) {
  for (const [key, n] of Object.entries(counts || {})) {
    document.querySelectorAll(`[data-badge-for="${key}"]`).forEach(el => {
      el.dataset.count = String(n || 0);
      el.textContent = n > 99 ? '99+' : String(n || 0);
    });
  }
}

/**
 * 설정 화면을 열 때 호출. 레일·선택을 다시 그리고 탭 하나를 연다.
 *
 * 매번 다시 그리는 이유: 권한은 로그인마다 달라지고, 관리자가 등급표를 바꾸면
 * 보이는 탭이 변한다. 한 번만 그리면 그 변화가 반영되지 않는다.
 */
export function initSettingsShell() {
  renderRail();
  renderPicker();

  const tabs = visibleSettingsTabs();
  if (tabs.length === 0) {
    // 설정 탭 자체에 못 들어오게 막혀 있어야 정상이지만, 등급표를 잘못 만지면
    // 여기까지 올 수 있다. 빈 화면 대신 이유를 보여준다.
    const titleEl = document.getElementById('settings-panel-title');
    if (titleEl) titleEl.textContent = '표시할 설정 항목이 없습니다';
    const descEl = document.getElementById('settings-panel-desc');
    if (descEl) descEl.textContent = '관리자에게 권한을 문의하세요.';
    return;
  }

  // 저장값을 현재 권한으로 다시 검사한다 — 역할이 강등됐을 때
  // 저장된 관리자 탭이 그대로 열리면 안 된다.
  switchSettingsTab(initialSettingsTab(readStored()));
}

// 전체 탭 목록은 테스트가 참조한다.
export { SETTINGS_TABS, SETTINGS_GROUPS };
