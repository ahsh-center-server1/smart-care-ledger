'use strict';

/**
 * 엑셀·통장사진 업로드가 쓰는 조각들 — 중복 대조, 사진 판별, 제외된 행 표시.
 *
 * modals.js 에서 떼어 냈다. 그 파일은 쪼갤 목록의 맨 위에 있고, 줄 수 예산은
 * 줄어들기만 한다. **modules/ 를 import 하지 않는다** — modals.js 가 이 파일을
 * 부르므로, 되부르면 순환에 끼어든다(architecture.test.mjs 가 잡는다).
 */

import { S } from '../state.js';
import { COLS } from '../constants.js';
import { escAttr } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import * as ExcelParser from '../services/excel-parser.js';

// 중복 판정 키는 services/excel-parser.js의 transactionKey — 거기서 테스트한다
export const dupKey=ExcelParser.transactionKey;

/**
 * 중복 대조용 기존 거래를 Firestore에서 직접 읽는다.
 * 화면 캐시가 아니라 **파일에 들어 있는 날짜 범위 전체**를 본다.
 */
export async function fetchExistingForDup(accId,rows){
  const dates=rows.map(r=>r.date).filter(Boolean).sort();
  if(!dates.length)return new Set();
  const{getDocs,collection,query,where}=fb();
  // 위와 같은 이유로 clientId 를 먼저 건다.
  const clientId=String((S.allAccounts||[]).find(a=>a.id===accId)?.clientId||'');
  if(!clientId)return new Set();
  const snap=await getDocs(query(collection(fdb(),COLS.TRANSACTIONS),
    where('clientId','==',clientId),
    where('accountId','==',accId),
    where('date','>=',dates[0]),
    where('date','<=',dates[dates.length-1])));
  return new Set(snap.docs.map(d=>dupKey({accountId:accId,...d.data()})));
}

/**
 * 엑셀 자리에 들어온 것이 사진인가.
 *
 * type 만 보지 않는다 — HEIC 는 브라우저에 따라 빈 type 으로 오고, 그러면
 * 사진인데 엑셀로 넘어가 엉뚱한 오류가 난다. 확장자도 함께 본다.
 */
export function isImageFile(file){
  if(!file)return false;
  const type=String(file.type||'').toLowerCase();
  if(type.startsWith('image/'))return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(String(file.name||''));
}

export function renderXlSkipped(){
  const list=S.excelSkipped||[];
  if(!list.length)return '';
  const byReason={};
  list.forEach(x=>{(byReason[x.reason]=byReason[x.reason]||[]).push(x);});
  const summary=Object.entries(byReason).map(([r,v])=>`${r} ${v.length}건`).join(' · ');
  const rows=list.slice(0,50).map(x=>
    `<tr style="border-top:1px solid #fde68a;">
       <td style="padding:5px 8px;font-size:11px;color:#92400e;white-space:nowrap;">${x.row}행</td>
       <td style="padding:5px 8px;font-size:11px;color:#92400e;white-space:nowrap;">${escAttr(x.reason)}</td>
       <td style="padding:5px 8px;font-size:11px;color:#a16207;overflow:hidden;text-overflow:ellipsis;">${escAttr(x.text)}</td>
     </tr>`).join('');
  const more=list.length>50?`<div style="padding:5px 8px;font-size:11px;color:#a16207;">… 외 ${list.length-50}건</div>`:'';
  return `
    <details style="margin-bottom:10px;border:1px solid #fde68a;border-radius:9px;background:#fffbeb;">
      <summary style="padding:8px 10px;font-size:12px;font-weight:700;color:#92400e;cursor:pointer;">
        ⚠️ 제외된 행 ${list.length}건 — ${escAttr(summary)}
      </summary>
      <div style="max-height:160px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
          <colgroup><col style="width:52px;"><col style="width:130px;"><col></colgroup>
          <tbody>${rows}</tbody>
        </table>${more}
      </div>
    </details>`;
}
