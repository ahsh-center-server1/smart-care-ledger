'use strict';

/**
 * 분류 이름·색상 수정.
 *
 * settings.js 에서 떼어 냈다 — 그 파일은 쪼갤 목록에 올라 있고, 이 화면은
 * 카테고리 관리에만 쓰인다.
 */

// **아무 화면 모듈도 import 하지 않는다.** 새로 고침은 호출부가 넘겨 준다 —
// core.js 를 직접 부르면 settings ↔ core ↔ … 순환에 이 파일이 끼어든다.
import { toast, escAttr } from '../utils/ui.js';

/**
 * 분류 이름·색상 수정 대화상자.
 *
 * 이름 변경은 **거래까지 따라간다.** 거래는 분류를 문자열로 들고 있어서,
 * 이름만 바꾸면 기존 거래가 옛 이름에 남고 보고서 집계가 두 줄로 갈라진다.
 * 그 일괄 수정은 서버(saveCategory)가 한다 — 공통 분류를 관리하는 팀장·센터장은
 * trx.edit 을 갖지 않으므로 브라우저에서는 할 수 없다.
 *
 * 마감된 달의 거래는 서버도 건드리지 않는다. 몇 건이 남았는지 돌려받아
 * 그대로 알려 준다 — 조용히 갈라지면 나중에 보고서에서야 드러난다.
 */
export function openCategoryEdit(type,catDoc,currentColor,reload){
  const panel=document.getElementById('cat-edit-panel');
  if(panel)panel.remove();
  const box=document.createElement('div');
  box.id='cat-edit-panel';
  box.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9998;'
    +'display:flex;align-items:center;justify-content:center;padding:16px;';
  const locked=catDoc.category==='확인필요';
  box.innerHTML=`<div style="background:#fff;border-radius:14px;padding:20px;width:min(360px,100%);box-shadow:0 8px 32px rgba(0,0,0,.2);">
    <h3 style="font-size:15px;font-weight:800;margin-bottom:14px;">분류 수정</h3>
    <label style="display:block;font-size:12px;font-weight:700;color:var(--sub);margin-bottom:5px;">이름</label>
    <input id="cat-edit-name" class="input" maxlength="20" value="${escAttr(catDoc.category)}"
      ${locked?'disabled':''} style="width:100%;margin-bottom:4px;">
    ${locked?'<p style="font-size:11px;color:var(--muted);margin-bottom:10px;">「확인필요」는 판독·업로드가 분류를 정하지 못했을 때 쓰는 자리라 이름을 바꿀 수 없습니다.</p>'
      :'<p style="font-size:11px;color:var(--muted);margin-bottom:10px;">이름을 바꾸면 이 분류를 쓰는 기존 거래도 함께 바뀝니다(마감된 달은 제외).</p>'}
    <label style="display:block;font-size:12px;font-weight:700;color:var(--sub);margin-bottom:5px;">색상</label>
    <input id="cat-edit-color" type="color" value="${escAttr(currentColor)}"
      style="width:100%;height:38px;padding:2px;margin-bottom:16px;cursor:pointer;">
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="cat-edit-cancel" class="btn btn-secondary" style="padding:8px 14px;font-size:13px;">취소</button>
      <button id="cat-edit-save" class="btn" style="padding:8px 14px;font-size:13px;">저장</button>
    </div>
  </div>`;
  document.body.appendChild(box);
  const close=()=>box.remove();
  box.addEventListener('click',e=>{ if(e.target===box)close(); });
  document.getElementById('cat-edit-cancel').addEventListener('click',close);
  document.getElementById('cat-edit-save').addEventListener('click',async()=>{
    const btn=document.getElementById('cat-edit-save');
    btn.disabled=true; btn.textContent='저장 중...';
    try{
      await saveCategoryEdit(type,catDoc,reload,
        (document.getElementById('cat-edit-name')?.value||'').trim(),
        document.getElementById('cat-edit-color')?.value||'');
      close();
    }catch(e){
      toast('수정하지 못했습니다: '+(e?.message||e),'error',6000);
      btn.disabled=false; btn.textContent='저장';
    }
  });
}

async function saveCategoryEdit(type,catDoc,reload,newName,color){
  if(!newName){toast('분류 이름을 입력하세요.','error');return;}
  const res=await window._fbFn.call('saveCategory')({
    type, clientId:catDoc.clientId||'', from:catDoc.category, to:newName, color,
  });
  const r=(res&&res.data)||{};
  await reload();
  const parts=[];
  if(r.transactions)parts.push(`거래 ${r.transactions}건`);
  if(r.rules)parts.push(`규칙 ${r.rules}건`);
  toast(parts.length?`"${newName}" 저장됨 · ${parts.join(' · ')} 함께 수정`:`"${newName}" 저장됨`,'success',4000);
  if(r.locked){
    // 조용히 갈라지면 나중에 보고서에서야 드러난다.
    toast(`마감된 달의 거래 ${r.locked}건은 옛 이름 그대로입니다. 결재가 끝난 숫자는 바꾸지 않습니다.`,
      'info',8000);
  }
}
