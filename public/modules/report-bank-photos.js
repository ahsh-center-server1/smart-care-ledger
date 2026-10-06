/**
 * modules/report-bank-photos.js — 결재하면서 통장사진을 띄워 두는 창
 *
 * report.js 에서 떼어 왔다. 그 파일은 상한을 넘겨 있고, 이 조각은 **아무
 * 화면 모듈도 부르지 않는다**(S · 토스트 · 저장소 URL · 드래그 유틸이 전부).
 * 그래서 옮겨도 모듈끼리 새로 얽히지 않는다 — test/architecture.test.mjs 가
 * 그것을 막는다.
 *
 * 왜 떠 있는 창인가: 결재자는 통장사진과 장부를 **나란히** 본다. 모달이면
 * 사진을 보는 동안 숫자가 가려져서, 닫았다 열었다를 줄마다 반복하게 된다.
 */

'use strict';

import { S } from '../state.js';
import { toast, makeDraggable } from '../utils/ui.js';
import { getImageUrl } from '../services/storage.js';

export function openBankStatementsForApproval(){
  if(!S.reportData)return;
  const{year,month,accs}=S.reportData;
  const mStr=`${year}-${String(month).padStart(2,'0')}`;
  const imgs=[];
  (accs||[]).forEach(a=>{
    (a.bankStatements||[]).filter(b=>b.month===mStr&&b.url).forEach(b=>{
      imgs.push({url:b.url,label:a.label||''});
    });
  });
  if(!imgs.length){toast('해당 월 통장사진이 없습니다.','info');return;}
  // 기존 패널 제거
  document.getElementById('bank-float-panel')?.remove();
  const panel=document.createElement('div');
  panel.id='bank-float-panel';
  panel.style.cssText='position:fixed;right:16px;top:60px;width:400px;min-height:200px;max-height:90vh;z-index:9998;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);display:flex;flex-direction:column;resize:both;overflow:hidden;border:1px solid var(--border);';
  panel.innerHTML=`
    <div id="bfp-header" style="padding:10px 14px;background:var(--surface);border-bottom:1px solid var(--border);cursor:move;display:flex;align-items:center;gap:8px;user-select:none;">
      <span style="font-size:13px;font-weight:700;color:var(--text);flex:1;">📷 통장사진</span>
      <span id="bfp-label" style="font-size:12px;color:var(--muted);"></span>
      <button onclick="document.getElementById('bank-float-panel').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--muted);line-height:1;">×</button>
    </div>
    <div style="flex:1;overflow:auto;display:flex;flex-direction:column;align-items:center;padding:10px;gap:8px;">
      <img id="bfp-img" style="max-width:100%;border-radius:6px;display:block;" alt="통장사진" />
      ${imgs.length>1?`<div style="display:flex;gap:8px;margin-top:4px;">
        <button onclick="if(window._bfpIdx>0){window._bfpIdx--;document.getElementById('bank-float-panel').__renderImg();}" style="padding:4px 14px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;">‹ 이전</button>
        <button onclick="if(window._bfpIdx<window._bfpImgs.length-1){window._bfpIdx++;document.getElementById('bank-float-panel').__renderImg();}" style="padding:4px 14px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;">다음 ›</button>
      </div>`:''}
    </div>`;
  document.body.appendChild(panel);
  window._bfpImgs=imgs; window._bfpIdx=0;
  panel.__renderImg=()=>{
    const it=window._bfpImgs[window._bfpIdx];
    let src=it.url;
    src=getImageUrl(src,'w800');
    panel.querySelector('#bfp-img').src=src;
    panel.querySelector('#bfp-label').textContent=`${it.label} (${window._bfpIdx+1}/${window._bfpImgs.length})`;
  };
  panel.__renderImg();
  // 드래그 — 누르고 있는 동안에만 문서에 리스너가 붙는다(누수 없음)
  makeDraggable(panel, panel.querySelector('#bfp-header'));
}
