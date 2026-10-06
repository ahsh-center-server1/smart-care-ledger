// public/modules/mobile-record.js
//
// 휴대폰의 「＋ 기록」 — 하단 네비 가운데 버튼이 여는 시트.
//
// 왜 이 버튼이 가운데에 있나
//   휴대폰에서 이 앱으로 하는 일은 거의 전부 **기록을 남기는 일**이다(영수증
//   사진, 통장 사진, 수기 입력). 그런데 예전 하단 네비는 데스크톱 사이드바를
//   그대로 줄인 네 칸(대시보드·거래내역·보고서·설정)이었고, 정작 주된 행동인
//   촬영·입력은 네비에 없었다 — 대시보드로 가서 퀵 액션 일곱 개 중에서 골라야
//   했다. 가장 자주 하는 일이 가장 먼 자리에 있었다.
//
// 왜 대시보드 퀵 액션을 휴대폰에서 감추고 이리로 모았나
//   일곱 개가 세 줄로 접혀 화면 절반을 먹었고, 그중 넷(거래내역·보고서·설정·
//   영수증)은 네비나 헤더로 이미 갈 수 있었다. **다만 감추기만 하면 파일
//   업로드처럼 다른 길이 없는 것이 휴대폰에서 사라진다** — 그래서 여기 목록이
//   퀵 액션을 전부 덮는지 `test/mobile-record.test.mjs` 가 대조한다.
//
// 권한
//   목록은 열 때마다 `can()` 으로 고른다. 팀장·센터장은 거래를 입력하지 않으므로
//   (CLAUDE.md §4 작성자와 결재자의 분리) 고를 것이 하나도 없고, 그때는 ＋ 버튼
//   자체가 뜨지 않는다 — 눌러서 빈 시트를 보게 두지 않는다.

'use strict';

import { openModal } from './modals.js';
import { can } from './permissions.js';
import { refreshReceiptIntakeButtons } from './receipt-intake.js';
import { iconSvg } from '../utils/icons.js';

const SHEET_ID = 'record-sheet';

/**
 * 시트에 담는 것들.
 *
 * `ai: true` 는 영수증 판독처럼 **서버에 키가 있어야** 되는 것이다. 권한만으로는
 * 알 수 없어 `data-receipt-intake` 를 달아 두고 refreshReceiptIntakeButtons 가
 * 서버에 물어본 뒤 감추거나 끈다(기본은 숨김).
 */
export const RECORD_ACTIONS = [
  {
    key: 'receipt-camera', label: '영수증 촬영', hint: '카메라로 바로 찍기',
    icon: 'camera', cap: 'receipt.upload', ai: true, color: '#0d9488',
    run: () => openReceiptIntake({ camera: true }),
  },
  {
    key: 'receipt-pick', label: '영수증 불러오기', hint: '앨범에서 고르기',
    icon: 'photo', cap: 'receipt.upload', ai: true, color: '#0d9488',
    run: () => openReceiptIntake({ camera: false }),
  },
  {
    key: 'bankbook', label: '통장 사진', hint: '그 달의 통장 사진',
    icon: 'book', cap: 'bankbook.upload', color: '#0891b2',
    run: () => openModal('bankbook'),
  },
  {
    key: 'trx', label: '수기 입력', hint: '거래 한 건 직접 입력',
    icon: 'pen', cap: 'trx.create', color: '#16a34a',
    run: () => openModal('trx'),
  },
  {
    key: 'excel', label: '파일 업로드', hint: '은행 엑셀·문자 내역',
    icon: 'upload', cap: 'excel.upload', color: '#d97706',
    run: () => openModal('excel'),
  },
];

/** 지금 이 사람이 시트에서 볼 것들. */
export function availableRecordActions() {
  return RECORD_ACTIONS.filter(a => can(a.cap));
}

/**
 * 영수증 판독 화면을 열되, 촬영이면 카메라를 바로 띄운다.
 *
 * 파일 입력을 프로그램에서 여는 것은 **사용자가 누른 그 클릭 안에서만** 허용된다.
 * openModal 이 동기라서 이어서 click() 할 수 있다. 혹시 브라우저가 막아도
 * 판독 화면의 드롭존이 그대로 있으므로 한 번 더 누르면 된다 — 막다른 길이 아니다.
 */
export function openReceiptIntake({ camera } = {}) {
  openModal('receipt-intake');
  const input = document.getElementById('ri-files');
  if (!input) return;
  applyCaptureMode(input, camera);
  try { input.click(); } catch { /* 브라우저가 막으면 드롭존을 쓰면 된다 */ }
}

/**
 * 파일 입력을 카메라로 열지 앨범으로 열지.
 *
 * **끄는 쪽이 중요하다.** capture 를 붙여 두고 지우지 않으면, 다음에
 * 「불러오기」를 눌러도 카메라가 뜬다 — 이미 찍어 둔 영수증을 고르려던 사람이
 * 영수증을 다시 찍어야 한다. 같은 input 을 두 버튼이 나눠 쓰기 때문이다.
 */
export function applyCaptureMode(input, camera) {
  if (camera) input.setAttribute('capture', 'environment');
  else input.removeAttribute('capture');
}

// ─────────────────────────────────────────────────────────────
// 시트
// ─────────────────────────────────────────────────────────────

function sheetEl() { return document.getElementById(SHEET_ID); }

function actionButton(action) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'record-action';
  btn.dataset.recordAction = action.key;
  if (action.ai) {
    btn.setAttribute('data-receipt-intake', '');
    btn.style.display = 'none';        // 서버에 물어보기 전에는 숨긴다
  }
  btn.innerHTML =
    `<span class="record-action__icon" style="color:${action.color}">${iconSvg(action.icon, 26)}</span>`
    + `<span class="record-action__text"><span class="record-action__label"></span>`
    + '<span class="record-action__hint"></span></span>';
  // 라벨은 textContent 로 — innerHTML 에 섞지 않는다.
  btn.querySelector('.record-action__label').textContent = action.label;
  btn.querySelector('.record-action__hint').textContent = action.hint;
  btn.addEventListener('click', () => { closeRecordSheet(); action.run(); });
  return btn;
}

export function openRecordSheet() {
  const actions = availableRecordActions();
  if (!actions.length) return;

  closeRecordSheet();
  const backdrop = document.createElement('div');
  backdrop.id = SHEET_ID;
  backdrop.className = 'sheet-backdrop';
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeRecordSheet(); });

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', '기록하기');

  const grip = document.createElement('div');
  grip.className = 'sheet__grip';
  sheet.appendChild(grip);

  const title = document.createElement('div');
  title.className = 'sheet__title';
  title.textContent = '기록하기';
  sheet.appendChild(title);

  actions.forEach(a => sheet.appendChild(actionButton(a)));

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sheet__cancel';
  cancel.textContent = '닫기';
  cancel.addEventListener('click', closeRecordSheet);
  sheet.appendChild(cancel);

  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKeydown);

  const fab = document.getElementById('btn-record');
  if (fab) fab.setAttribute('aria-expanded', 'true');

  // 영수증 판독은 서버에 키가 있을 때만 뜬다. 못 물어보면 숨긴 채로 둔다.
  refreshReceiptIntakeButtons().catch(() => {});

  // 첫 항목에 초점 — 화면 낭독기가 시트 안으로 들어온다.
  const first = sheet.querySelector('.record-action:not([style*="display: none"])') || cancel;
  if (first.focus) first.focus();
}

export function closeRecordSheet() {
  const el = sheetEl();
  if (el) el.remove();
  document.removeEventListener('keydown', onKeydown);
  const fab = document.getElementById('btn-record');
  if (fab) {
    fab.setAttribute('aria-expanded', 'false');
    if (el && fab.focus) fab.focus();
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') closeRecordSheet();
}

export function toggleRecordSheet() {
  if (sheetEl()) closeRecordSheet();
  else openRecordSheet();
}

/**
 * ＋ 버튼을 보일지.
 *
 * 인라인 style 이 아니라 클래스로 감춘다 — 이 버튼은 좁은 화면에서만 뜨는데
 * style="display:''" 를 쓰면 미디어 쿼리를 이겨서 데스크톱에도 나온다.
 */
export function refreshRecordButton() {
  const fab = document.getElementById('btn-record');
  if (!fab) return;
  fab.classList.toggle('perm-hidden', availableRecordActions().length === 0);
}
