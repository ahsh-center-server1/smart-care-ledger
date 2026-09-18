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
import { iconSvg } from '../utils/icons.js';
import { can } from './permissions.js';
import { auditLog } from '../services/audit.js';
import { fnErrorMessage } from '../services/fn-errors.js';
import { refetchReports } from './core.js';

export async function rebuildDerivedDocs() {
  // 예전에는 settings.reset 을 요구했다. 그 키는 아무에게도 없으므로
  // **복구 버튼 자체가 눌리지 않았다** — 색인이 어긋났을 때 고칠 방법이 없다는
  // 뜻이다. 서버(rebuildLockedMonths)와 같은 기준으로 맞춘다: 연도 마감(센터장)
  // 이나 백업 운영(관리자). 원본에서 다시 만드는 작업이라 데이터를 잃지 않는다.
  if (!can('settings.archive') && !can('system.backup')) {
    toast('파생 문서 재생성 권한이 없습니다.', 'error', 5000); return;
  }

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

    // 권한 투영본(authz) — **관리자만** 돌릴 수 있다(backfillAuthz 가 users.isAdmin
    // 으로 판정한다). 센터장이 눌렀다고 버튼 전체가 실패하면 안 되므로 건너뛴다.
    //
    // 이것이 없으면 고칠 방법이 없던 고장이 있다: clients.teamLeader 는 맞는데
    // authz.leaderClientIds 가 비어 있으면 **팀장에게 그 입주자의 보고서가 보이지
    // 않는다.** 팀장의 조회 범위가 leaderClientIds 이기 때문이다. 게다가 입주자
    // 화면에서 다시 저장해도 낫지 않는다 — saveClient 는 이전 상태와 다른 것만
    // 반영하는데, 팀장이 그대로면 바꿀 것이 없다고 보고 투영본을 건드리지 않는다.
    // 원본에서 통째로 다시 만드는 이 백필만이 그 상태를 되돌린다.
    let authz = null;
    if (can('system.backup')) {
      authz = await call('backfillAuthz')();
    }

    const lockCount = Number((lock && lock.data && lock.data.count) || 0);
    const submitted = Number((lock && lock.data && lock.data.submitted) || 0);
    const staff = Number((dir && dir.data && dir.data.staff) || 0);
    const cats = Number((dir && dir.data && dir.data.categories) || 0);

    const authzUsers = Number((authz && authz.data && authz.data.users) || 0);
    if (out) {
      out.innerHTML =
        '<div style="color:#15803d;font-weight:700;">✅ 완료</div>'
        + '<div style="color:var(--muted-foreground);margin-top:4px;">'
        + `마감 ${escHtml(lockCount)}건 · 결재 중 ${escHtml(submitted)}건 · `
        + `직원 ${escHtml(staff)}명 · 분류 ${escHtml(cats)}건`
        + (authz
          ? ` · 권한 ${escHtml(authzUsers)}명`
          : ' · <span style="color:#b45309;">권한 투영본은 관리자만 다시 만들 수 있습니다</span>')
        + '</div>';
    }
    toast('파생 문서를 다시 만들었습니다.', 'success');
    await auditLog('archive.run', {
      summary: { target: 'derived', lockCount, staff, cats, authzUsers },
    });

    // 새 색인을 화면에 반영한다 — 안 하면 이 세션에서만 잠금이 안 걸린 채로 남는다.
    await refetchReports();
  } catch (e) {
    const msg = fnErrorMessage(e);
    if (out) out.innerHTML = `<div style="color:#c62828;">❌ ${escHtml(msg)}</div>`;
    toast('다시 만들기 실패: ' + msg, 'error', 5000);
    await auditLog('archive.failed', { summary: { target: 'derived', message: msg } });
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = iconSvg('refresh') + '다시 만들기'; }
  }
}

/**
 * 잔액·월말 색인 백필 — 터미널 없이 누르는 쪽.
 *
 * 왜 위 버튼과 나눠 두나
 *   위 버튼은 문서 몇 건만 읽는다. 이쪽은 **계좌마다 그 계좌의 거래를 전부**
 *   읽는다(1년치면 계좌당 수백 건). 한 버튼에 묶어 두면 가벼운 줄 알고 눌렀다가
 *   하루치 읽기 할당량을 쓴다. 비용이 다르면 버튼도 달라야 한다.
 *
 * 왜 이어서 부르나
 *   한 호출에 전 계좌를 처리하면 콜러블 제한 시간에 걸린다. 서버가 남은 수를
 *   돌려주므로 0이 될 때까지 이어 부른다. 이미 끝난 계좌는 다시 읽지 않는다.
 */
export async function rebuildBalanceIndex() {
  if (!can('settings.archive') && !can('system.backup')) {
    toast('잔액 색인 재생성 권한이 없습니다.', 'error', 5000); return;
  }

  const btn = document.getElementById('btn-rebuild-balances');
  const out = document.getElementById('rebuild-balances-result');
  const { call } = window._fbFn || {};
  if (!call) { toast('서버에 연결할 수 없습니다.', 'error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = '다시 만드는 중…'; }
  if (out) out.textContent = '';

  let done = 0, failed = 0, total = 0;
  try {
    // 남은 계좌가 0이 될 때까지. 상한을 두는 이유: 서버가 어떤 이유로 같은
    // 수를 계속 돌려주면 여기서 무한히 돈다.
    for (let round = 0; round < 200; round += 1) {
      const res = await call('rebuildBalances')({ limit: 20 });
      const d = (res && res.data) || {};
      done += Number(d.done || 0);
      failed += Number(d.failed || 0);
      total = Number(d.total || total);
      const remaining = Number(d.remaining || 0);
      if (out) {
        out.innerHTML = '<div style="color:var(--muted-foreground);">'
          + `계좌 ${escHtml(done)}/${escHtml(total)} 처리… 남은 ${escHtml(remaining)}개</div>`;
      }
      if (!remaining) break;
      if (!d.done && !d.failed) break;        // 진척이 없으면 멈춘다
    }

    if (out) {
      out.innerHTML =
        '<div style="color:#15803d;font-weight:700;">✅ 완료</div>'
        + '<div style="color:var(--muted-foreground);margin-top:4px;">'
        + `계좌 ${escHtml(done)}개 다시 계산`
        + (failed ? ` · <span style="color:#c62828;">실패 ${escHtml(failed)}개</span>` : '')
        + '</div>';
    }
    toast('잔액 색인을 다시 만들었습니다.', 'success');
    await auditLog('archive.run', { summary: { target: 'balances', done, failed } });
  } catch (e) {
    const msg = fnErrorMessage(e);
    if (out) out.innerHTML = `<div style="color:#c62828;">❌ ${escHtml(msg)}</div>`;
    toast('다시 만들기 실패: ' + msg, 'error', 5000);
    await auditLog('archive.failed', { summary: { target: 'balances', message: msg } });
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = iconSvg('coin') + '잔액 색인 다시 만들기'; }
  }
}
