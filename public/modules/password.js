'use strict';

/**
 * 비밀번호 — 본인 변경, 그리고 분실 시 관리자 발급.
 *
 * 왜 새로 만드나
 *   `changePassword` 콜러블은 진작 있었는데 **브라우저에서 아무도 부르지
 *   않았다.** 즉 본인 비밀번호를 바꿀 화면 자체가 없었고, 그래서 분실하면
 *   방법이 없었다.
 *
 * 강제 변경
 *   관리자가 발급한 임시 비밀번호로 들어오면 `mustChangePassword` 가 실려 온다.
 *   그때는 **앱에 들여보내기 전에** 바꾸게 한다. 바꾸기 전에는 아무것도 할 수
 *   없으므로, 발급한 사람이 그 계정으로 조용히 일할 수 없다 — 주인이
 *   로그인하는 순간 이 화면을 보게 되어 발급 사실이 드러난다.
 *
 * modules/ 를 import 하지 않는다
 *   auth·settings 에서 부르는 화면이라, 그쪽을 되부르면 순환에 끼어든다.
 *   로그인 뒤 무엇을 할지는 호출부가 콜백으로 넘긴다.
 */

import { toast } from '../utils/ui.js';

function panel(html) {
  const old = document.getElementById('pw-panel');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'pw-panel';
  box.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:10000;'
    + 'display:flex;align-items:center;justify-content:center;padding:16px;';
  box.innerHTML = `<div style="background:#fff;border-radius:14px;padding:22px;width:min(380px,100%);
    box-shadow:0 8px 32px rgba(0,0,0,.25);">${html}</div>`;
  document.body.appendChild(box);
  return box;
}

/**
 * 비밀번호 변경 화면.
 *
 * @param {Object} opts
 * @param {boolean} opts.forced 임시 비밀번호로 들어온 경우. 닫을 수 없다.
 * @param {Function} opts.onDone 성공 뒤에 할 일 (강제일 때 앱 진입)
 */
export function openChangePassword({ forced = false, onDone } = {}) {
  const box = panel(`
    <h3 style="font-size:16px;font-weight:900;margin-bottom:6px;">비밀번호 변경</h3>
    <p style="font-size:12px;color:#64748b;margin-bottom:16px;">${forced
      ? '임시 비밀번호로 접속했습니다. 새 비밀번호를 정해야 계속할 수 있습니다.'
      : '8자 이상으로 정해 주세요.'}</p>
    <label class="label">현재 비밀번호</label>
    <input id="pw-cur" type="password" class="input" autocomplete="current-password"
      style="width:100%;margin-bottom:10px;">
    <label class="label">새 비밀번호</label>
    <input id="pw-new" type="password" class="input" autocomplete="new-password"
      style="width:100%;margin-bottom:10px;">
    <label class="label">새 비밀번호 확인</label>
    <input id="pw-new2" type="password" class="input" autocomplete="new-password"
      style="width:100%;margin-bottom:6px;">
    <p id="pw-err" style="display:none;font-size:12px;color:#dc2626;margin-bottom:8px;"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      ${forced ? '' : '<button id="pw-cancel" class="btn btn-secondary" style="padding:8px 14px;font-size:13px;">취소</button>'}
      <button id="pw-ok" class="btn" style="padding:8px 14px;font-size:13px;">변경</button>
    </div>`);

  const err = (msg) => {
    const el = document.getElementById('pw-err');
    el.textContent = msg; el.style.display = 'block';
  };
  if (!forced) {
    // 강제일 때는 닫는 길을 두지 않는다 — 닫으면 앱을 못 쓰는 상태로 남는다.
    document.getElementById('pw-cancel').addEventListener('click', () => box.remove());
    box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  }

  document.getElementById('pw-ok').addEventListener('click', async () => {
    const cur = document.getElementById('pw-cur').value;
    const a = document.getElementById('pw-new').value;
    const b = document.getElementById('pw-new2').value;
    if (a.length < 8) return err('새 비밀번호는 8자 이상이어야 합니다.');
    if (a !== b) return err('새 비밀번호가 서로 다릅니다.');
    if (a === cur) return err('지금 쓰는 비밀번호와 같습니다.');

    const btn = document.getElementById('pw-ok');
    btn.disabled = true; btn.textContent = '변경 중...';
    try {
      await window._fbFn.call('changePassword')({ currentPassword: cur, newPassword: a });
      box.remove();
      toast('비밀번호를 바꿨습니다.', 'success');
      if (typeof onDone === 'function') await onDone();
    } catch (e) {
      err(e?.message || String(e));
      btn.disabled = false; btn.textContent = '변경';
    }
  });
}

/**
 * 관리자: 남의 비밀번호 재설정.
 *
 * 결재에 닿는 계정(팀장·센터장·관리자)이면 서버가 승인 대기로 돌려준다 —
 * 관리자 자격이 결재 권한으로 번지지 않게 하는 장치다. 그 경우 **다른**
 * 관리자가 같은 버튼을 눌러 승인해야 임시 비밀번호가 나온다.
 */
export async function resetStaffPassword(userId, name) {
  try {
    const res = await window._fbFn.call('requestPasswordReset')({ userId });
    const d = (res && res.data) || {};
    if (d.needsApproval) {
      showTempPassword(name, null,
        `${d.message}\n대기 시간: ${d.expiresInMinutes}분 이내`);
      return;
    }
    showTempPassword(name, d.tempPassword, `유효 시간: ${d.expiresInHours}시간`);
  } catch (e) {
    // 대기 중인 요청이 있으면 이 호출이 승인이 된다.
    if (e?.code === 'functions/already-exists' || /대기/.test(e?.message || '')) {
      return approveStaffPasswordReset(userId, name);
    }
    toast('재설정하지 못했습니다: ' + (e?.message || e), 'error', 6000);
  }
}

/** 두 번째 사람의 승인. 요청한 사람과 같으면 서버가 거절한다. */
export async function approveStaffPasswordReset(userId, name) {
  try {
    const res = await window._fbFn.call('approvePasswordReset')({ userId });
    const d = (res && res.data) || {};
    showTempPassword(name, d.tempPassword, `유효 시간: ${d.expiresInHours}시간`);
  } catch (e) {
    toast('승인하지 못했습니다: ' + (e?.message || e), 'error', 7000);
  }
}

/**
 * 임시 비밀번호를 **한 번만** 보여 준다.
 *
 * 어디에도 저장하지 않으므로 이 창을 닫으면 다시 볼 수 없다. 그 사실을
 * 화면에 적는다 — 닫고 나서 찾으면 다시 발급받아야 한다.
 */
function showTempPassword(name, temp, note) {
  const box = panel(`
    <h3 style="font-size:16px;font-weight:900;margin-bottom:10px;">${temp ? '임시 비밀번호' : '승인 대기'}</h3>
    <p style="font-size:13px;color:#334155;margin-bottom:12px;">${name || ''}</p>
    ${temp ? `<div style="font-family:'JetBrains Mono',monospace;font-size:20px;font-weight:800;
        letter-spacing:1px;text-align:center;background:#f1f5f9;border:1px solid #cbd5e1;
        border-radius:8px;padding:14px;margin-bottom:10px;user-select:all;">${temp}</div>
      <p style="font-size:12px;color:#b45309;margin-bottom:4px;">이 창을 닫으면 다시 볼 수 없습니다.
        본인에게 직접 전달하세요.</p>
      <p style="font-size:12px;color:#64748b;">본인이 처음 로그인할 때 반드시 새 비밀번호로 바꾸게 됩니다.</p>`
      : '<p style="font-size:13px;color:#b45309;white-space:pre-line;"></p>'}
    <p style="font-size:12px;color:#64748b;margin-top:8px;white-space:pre-line;"></p>
    <div style="display:flex;justify-content:flex-end;margin-top:14px;">
      <button id="pw-close" class="btn" style="padding:8px 14px;font-size:13px;">닫기</button>
    </div>`);
  // 서버 문구는 textContent 로 넣는다 — innerHTML 로 엮지 않는다.
  const notes = box.querySelectorAll('p');
  notes[notes.length - 1].textContent = note || '';
  if (!temp) notes[1].textContent = note || '';
  document.getElementById('pw-close').addEventListener('click', () => box.remove());
}
