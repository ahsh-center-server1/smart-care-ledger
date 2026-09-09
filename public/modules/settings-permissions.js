/**
 * settings-permissions.js — 권한 등급표 패널 (관리자 전용)
 *
 * settings.js 에서 떼어 왔다. 그 파일은 이미 상한을 넘어 있고
 * test/architecture.test.mjs 가 "기능을 더할 곳이 아니라 쪼갤 곳"이라고 말한다.
 *
 * 이 화면이 하는 일은 하나다 — 각 기능의 **최소 등급**을 고르고 저장한다.
 * 저장은 서버 콜러블(savePermissions)이 받아 config/permissions 와 전 직원의
 * authz.caps 를 함께 고친다. 브라우저가 config 를 직접 쓰던 시절에는
 * 등급표만 바뀌고 규칙은 그대로여서 아무 일도 일어나지 않았다.
 */

'use strict';

import { escAttr, toast, showConfirm } from '../utils/ui.js';
import { auditLog } from '../services/audit.js';
import {
  savePermissions, requiredRank, DEFAULT_MIN_RANK,
  SELECTABLE_RANKS, RANK_LABEL, PERM_SECTIONS,
  isConfigurable, fixedReason,
} from './permissions.js';

// ─────────────────────────────────────────────
// 권한 관리 패널 (관리자 전용)
// ─────────────────────────────────────────────
export function renderPermissionPanel(){
  const container=document.getElementById('permission-panel-content');
  if(!container)return;

  // 편집용 초안 — 현재 유효 등급으로 시작한다
  const draft={};
  PERM_SECTIONS.forEach(sec=>Object.keys(sec.keys).forEach(k=>{draft[k]=requiredRank(k);}));

  const rankOpts=(cur)=>SELECTABLE_RANKS
    .map(r=>`<option value="${r}"${Number(cur)===r?' selected':''}>${escAttr(RANK_LABEL[r])}</option>`)
    .join('');

  function renderPanel(){
    const changed=Object.entries(draft).filter(([k,v])=>Number(v)!==DEFAULT_MIN_RANK[k]).length;
    container.innerHTML=`
      <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px;color:#5b21b6;line-height:1.6;">
        각 기능을 <b>어느 등급부터</b> 쓸 수 있는지 정합니다.
        등급은 <b>입력자 &lt; 담당자 &lt; 팀장 &lt; 센터장</b> 순이고,
        관리자 권한은 역할이 아니라 직원 등록 화면의 체크박스로 부여합니다.
        <div style="margin-top:6px;">🔒 표시는 보안 하한이 걸려 <b>등급을 낮출 수 없는</b> 권한입니다.</div>
        ${changed?`<div style="margin-top:6px;font-weight:700;">기본값과 다른 항목 ${changed}개</div>`:''}
      </div>
      <div style="overflow-x:auto;">
        ${PERM_SECTIONS.map(sec=>`
          <div style="font-weight:800;color:#fff;background:#3b82f6;padding:7px 12px;border-radius:8px 8px 0 0;font-size:12px;">${escAttr(sec.title)}</div>
          <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;margin-bottom:14px;">
            ${Object.entries(sec.keys).map(([key,label])=>{
              const isDefault=Number(draft[key])===DEFAULT_MIN_RANK[key];
              // 조정할 수 없는 권한은 드롭다운을 주지 않는다. 예전에는 똑같이
              // 선택할 수 있게 보여 주고 저장까지 됐지만 아무 일도 일어나지
              // 않았다 — "저장했는데 반영이 안 된다"의 절반이 이것이었다.
              const fixed=!isConfigurable(key);
              const ctrl=fixed
                ? `<span title="${escAttr(fixedReason(key))}" style="font-size:12px;color:var(--muted);white-space:nowrap;flex-shrink:0;">🔒 ${escAttr(RANK_LABEL[draft[key]]||'')}</span>`
                : `<select class="perm-rank input" data-key="${escAttr(key)}" style="width:auto;min-height:auto;height:32px;padding:4px 8px;font-size:12px;flex-shrink:0;">${rankOpts(draft[key])}</select>`;
              return `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 12px;border-bottom:1px solid #f1f5f9;">
                <span style="font-size:13px;color:${fixed?'var(--muted)':'var(--text)'};">${escAttr(label)}${isDefault?'':'<span style="margin-left:6px;font-size:10px;font-weight:700;color:#7c3aed;">변경됨</span>'}</span>
                ${ctrl}
              </div>`;
            }).join('')}
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <button id="btn-perm-save" class="btn" style="padding:9px 20px;font-size:13px;">💾 저장</button>
        <button id="btn-perm-reset" style="padding:9px 20px;background:#fff;color:#64748b;border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">↺ 기본값으로</button>
      </div>`;

    container.querySelectorAll('.perm-rank').forEach(sel=>{
      sel.addEventListener('change',()=>{
        draft[sel.dataset.key]=Number(sel.value);
        renderPanel();   // '변경됨' 표시와 개수를 갱신
      });
    });

    document.getElementById('btn-perm-save')?.addEventListener('click',async()=>{
      try{
        // 어떤 키가 기본값에서 벗어났는지 기록한다. 권한 등급표는 앱 전체의
        // 접근 범위를 정하므로, 나중에 "왜 이 사람이 이걸 할 수 있었나"를
        // 되짚을 수 있어야 한다.
        const changed=Object.keys(draft)
          .filter(k=>draft[k]!==DEFAULT_MIN_RANK[k])
          .map(k=>`${k}=${draft[k]}`);
        const res=await savePermissions(draft);
        // 기록은 저장이 성공한 뒤에 남긴다(실패한 시도를 변경으로 남기지 않게).
        await auditLog('permissions.update',{
          summary:{ count:changed.length, target:changed.slice(0,8).join(', ') },
        });
        // 서버가 전 직원의 권한 스냅샷까지 다시 계산했다. 몇 명에게
        // 적용됐는지 말해 주지 않으면 "정말 반영됐나"를 확인할 방법이 없다.
        if(res.missingAuthz){
          toast(`권한을 저장했지만 ${res.missingAuthz}명에게 적용되지 않았습니다. `
            +'권한 백필을 실행하세요.','error',9000);
        }else{
          toast(`권한이 저장되었습니다. 직원 ${res.users||0}명에게 적용했습니다.`,'success',5000);
        }
        setTimeout(()=>location.reload(),2000);
      }catch(e){toast('저장 실패: '+(e.message||'다시 시도하세요.'),'error');}
    });

    document.getElementById('btn-perm-reset')?.addEventListener('click',()=>{
      showConfirm('기본값으로','모든 기능의 최소 등급을 기본값으로 되돌립니다. 저장을 눌러야 반영됩니다.',()=>{
        Object.keys(draft).forEach(k=>{draft[k]=DEFAULT_MIN_RANK[k];});
        renderPanel();
        toast('기본값으로 되돌렸습니다. 저장을 눌러 적용하세요.','info');
      },'되돌리기');
    });
  }
  renderPanel();
}
