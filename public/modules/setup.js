/**
 * modules/setup.js — Smart Care Ledger
 * 초기 설정 마법사
 *
 * 배경
 *   신규 배포 직후에는 카테고리·입주자·계좌가 모두 비어 있는데, 기존 대시보드는
 *   "등록된 입주자가 없습니다 → 설정으로" 버튼 하나만 보여줬다. 그런데 등록
 *   권한이 없는 사용자에게는 설정 화면의 +등록 버튼이 숨겨져 있어 막다른 길이었고,
 *   카테고리는 설정 → 규칙 탭 깊숙이 있는 "기본값 초기화"를 눌러야만 생겼다.
 *
 *   이 모듈은 남은 준비 단계를 순서대로 보여주고, 각 단계를 해당 화면·모달로
 *   바로 연결한다. 데이터가 채워지면 단계가 자동으로 완료 표시된다.
 */

'use strict';

import { S } from '../state.js';
import { COLS, DEFAULT_CATEGORIES } from '../constants.js';
import { toast, showLoading, escHtml } from '../utils/ui.js';
import { batchAddDocs } from '../services/firestore.js';
import { can } from './permissions.js';
import { refetchCategories, refetchClients } from './core.js';
import { openModal } from './modals.js';

/**
 * 남은 준비 단계를 계산한다.
 * @returns {{steps:Array, done:number, total:number, complete:boolean}}
 */
export function getSetupState() {
  const steps = [
    {
      key: 'categories',
      title: '기본 분류 만들기',
      desc: '식비·교통비 같은 지출 분류입니다. 나중에 설정에서 바꿀 수 있어요.',
      done: (S.categories || []).length > 0,
      can: can('settings.category'),
      actionLabel: '기본 분류 만들기',
      action: seedDefaultCategories,
    },
    {
      key: 'clients',
      title: '입주자 등록',
      desc: '금전을 관리할 입주자를 등록합니다.',
      done: (S.allClients || S.clients || []).length > 0,
      can: can('assignments.manage'),
      actionLabel: '입주자 등록하기',
      action: () => openModal('client'),
    },
    {
      key: 'accounts',
      title: '계좌와 기초잔액 등록',
      desc: '통장별로 등록하고, 기준일과 그 시점 잔액을 입력합니다.',
      done: (S.allAccounts || S.accounts || []).length > 0,
      can: can('settings.account'),
      actionLabel: '계좌 등록하기',
      action: () => openModal('account'),
      // 입주자가 없으면 계좌를 만들 수 없다 (계좌 폼이 입주자를 고르게 되어 있음)
      blockedBy: 'clients',
    },
  ];

  const done = steps.filter(s => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}

/** 기본 카테고리를 한 번에 만든다. 이미 있으면 아무것도 하지 않는다. */
async function seedDefaultCategories() {
  if ((S.categories || []).length) {
    toast('이미 분류가 등록되어 있습니다.', 'info');
    return;
  }
  showLoading(true);
  try {
    await batchAddDocs(DEFAULT_CATEGORIES.map(d => ({ col: COLS.CATEGORIES, data: { ...d } })));
    await refetchCategories();
    toast(`기본 분류 ${DEFAULT_CATEGORIES.length}개를 만들었습니다.`, 'success');
    renderSetupWizard();
  } catch (e) {
    toast('분류 생성 실패: ' + (e.message || '다시 시도하세요.'), 'error');
  }
  showLoading(false);
}

/**
 * 대시보드 자리에 마법사를 그린다.
 * 준비가 끝났으면 아무것도 그리지 않고 false를 반환한다(대시보드가 평소대로 렌더).
 * @returns {boolean} 마법사를 그렸는지
 */
export function renderSetupWizard() {
  const grid = document.getElementById('client-grid');
  if (!grid) return false;

  const { steps, done, total, complete } = getSetupState();
  if (complete) return false;

  // 아무 단계도 진행할 권한이 없으면 마법사 대신 안내만 띄운다.
  // (예전에는 등록 버튼이 숨겨진 설정 화면으로 보내 막다른 길이었다)
  const anyActionable = steps.some(s => !s.done && s.can);
  if (!anyActionable) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="icon" aria-hidden="true">🔒</div>
        <p>아직 사용할 준비가 되지 않았습니다.<br>
        관리자나 팀장이 입주자와 계좌를 등록하면 여기에 표시됩니다.</p>
      </div>`;
    return true;
  }

  const rows = steps.map((s, i) => {
    const blocked = s.blockedBy && !steps.find(x => x.key === s.blockedBy)?.done;
    const state = s.done ? 'done' : (blocked || !s.can ? 'locked' : 'ready');
    const mark  = s.done ? '✅' : (state === 'locked' ? '🔒' : `${i + 1}`);
    const markBg = s.done ? '#dcfce7' : (state === 'ready' ? 'var(--blue)' : '#e2e8f0');
    const markColor = s.done ? '#15803d' : (state === 'ready' ? '#fff' : '#94a3b8');
    const note = !s.can
      ? '<div style="font-size:12px;color:#b45309;margin-top:4px;">권한이 없어 관리자·팀장이 등록해야 합니다.</div>'
      : (blocked
        ? '<div style="font-size:12px;color:var(--muted);margin-top:4px;">앞 단계를 먼저 끝내주세요.</div>'
        : '');

    const btn = (state === 'ready')
      ? `<button class="btn setup-action" data-step="${escHtml(s.key)}" style="white-space:nowrap;padding:9px 16px;">${escHtml(s.actionLabel)}</button>`
      : '';

    return `
      <div style="display:flex;gap:14px;align-items:flex-start;padding:16px 4px;border-bottom:1px solid var(--border);">
        <div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:${markBg};color:${markColor};
                    display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;">${mark}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:700;color:${s.done ? 'var(--muted)' : 'var(--text)'};
                      ${s.done ? 'text-decoration:line-through;' : ''}">${escHtml(s.title)}</div>
          <div style="font-size:13px;color:var(--muted);margin-top:3px;">${escHtml(s.desc)}</div>
          ${note}
        </div>
        ${btn}
      </div>`;
  }).join('');

  grid.innerHTML = `
    <div style="grid-column:1/-1;background:var(--surface);border:1px solid var(--border);
                border-radius:14px;padding:22px 24px;max-width:720px;">
      <div style="font-size:19px;font-weight:900;color:var(--text);">처음 설정</div>
      <div style="font-size:13px;color:var(--muted);margin-top:5px;">
        ${done}/${total} 단계 완료 — 아래 순서대로 진행하면 바로 사용할 수 있습니다.
      </div>
      <div style="height:6px;background:#e2e8f0;border-radius:99px;margin:14px 0 6px;overflow:hidden;">
        <div style="height:100%;width:${Math.round((done / total) * 100)}%;background:var(--blue);
                    border-radius:99px;transition:width .3s;"></div>
      </div>
      ${rows}
      <div style="font-size:12px;color:var(--muted);margin-top:16px;">
        💡 설정 화면에서 언제든 다시 등록·수정할 수 있습니다.
      </div>
    </div>`;

  // 인라인 onclick 대신 이벤트 위임 — 전역 함수 이름에 의존하지 않는다
  grid.querySelectorAll('.setup-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const step = steps.find(s => s.key === btn.dataset.step);
      if (step && step.action) step.action();
    });
  });

  return true;
}

/**
 * 입주자·계좌 등록 모달이 저장된 뒤 호출된다.
 * 대시보드를 보고 있으면 마법사가 다음 단계로 넘어간 것처럼 갱신된다.
 */
export async function refreshSetupAfterChange() {
  const { complete } = getSetupState();
  if (complete) return;              // 준비가 끝났으면 대시보드가 평소대로 그린다
  await refetchClients();            // clients + accounts + 통계를 함께 갱신
  renderSetupWizard();
}
