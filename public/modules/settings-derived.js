// public/modules/settings-derived.js
//
// 파생 문서 다시 만들기 — 마감 색인 + 직원·분류 명부.
//
// 왜 버튼이 필요한가
//   이 문서들은 Cloud Functions 트리거가 유지하는데, **트리거는 배포 이후의
//   변경만 본다.** 배포 직후에는 전부 비어 있다.
//
//   명부가 비면 화면은 정상이고 읽기만 예전으로 돌아간다. 그런데 마감 색인이
//   비면 **최종 결재된 달이 잠기지 않는다** — 마감된 월의 거래를 누구나
//   수정·삭제할 수 있는 상태로 운영이 시작된다. 그것을 콘솔에 명령어를 붙여
//   넣어야만 고칠 수 있게 두면 안 된다.
//
//   트리거가 실패해 어긋났을 때의 복구 도구이기도 하다. 원본에서 전체를 다시
//   만들므로 여러 번 눌러도 결과가 같다.
//
// 절차는 RUNBOOK.md 「배포 5」에도 적혀 있다.

'use strict';

import { toast, escHtml } from '../utils/ui.js';
import { can, unavailableMessage } from './permissions.js';
import { auditLog } from '../services/audit.js';
import { fnErrorMessage } from '../services/fn-errors.js';
import { refetchReports } from './core.js';

export async function rebuildDerivedDocs() {
  // 전체 초기화와 같은 등급으로 둔다 — 원본에서 다시 만드는 작업이라
  // 데이터를 잃지는 않지만, 전 사용자에게 보이는 문서를 통째로 갈아 끼운다.
  if (!can('settings.reset')) { toast(unavailableMessage('settings.reset'), 'error', 5000); return; }

  const btn = document.getElementById('btn-rebuild-derived');
  const out = document.getElementById('rebuild-derived-result');
  const { call } = window._fbFn || {};
  if (!call) { toast('서버에 연결할 수 없습니다.', 'error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = '다시 만드는 중…'; }
  if (out) out.textContent = '';

  try {
    // 마감 색인을 먼저 — 정확성에 걸리는 쪽이다.
    const lock = await call('rebuildLockedMonths')();
    const dir = await call('rebuildDirectories')();

    const lockCount = Number((lock && lock.data && lock.data.count) || 0);
    const staff = Number((dir && dir.data && dir.data.staff) || 0);
    const cats = Number((dir && dir.data && dir.data.categories) || 0);

    if (out) {
      out.innerHTML =
        '<div style="color:#15803d;font-weight:700;">✅ 완료</div>'
        + '<div style="color:var(--muted-foreground);margin-top:4px;">'
        + `마감된 (입주자, 월) ${escHtml(lockCount)}건 · `
        + `직원 ${escHtml(staff)}명 · 분류 ${escHtml(cats)}건</div>`;
    }
    toast('파생 문서를 다시 만들었습니다.', 'success');
    await auditLog('archive.run', {
      summary: { target: 'derived', lockCount, staff, cats },
    });

    // 새 색인을 화면에 반영한다 — 안 하면 이 세션에서만 잠금이 안 걸린 채로 남는다.
    await refetchReports();
  } catch (e) {
    const msg = fnErrorMessage(e);
    if (out) out.innerHTML = `<div style="color:#c62828;">❌ ${escHtml(msg)}</div>`;
    toast('다시 만들기 실패: ' + msg, 'error', 5000);
    await auditLog('archive.failed', { summary: { target: 'derived', message: msg } });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔁 다시 만들기'; }
  }
}
