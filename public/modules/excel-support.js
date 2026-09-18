'use strict';

/**
 * 엑셀·통장사진 업로드가 쓰는 조각들 — 중복 대조, 사진 판별, 제외된 행 표시.
 *
 * modals.js 에서 떼어 냈다. 그 파일은 쪼갤 목록의 맨 위에 있고, 줄 수 예산은
 * 줄어들기만 한다. modals.js 가 이 파일을 부르므로 **되부르면 순환에 끼어든다**
 * (architecture.test.mjs 가 잡는다). 얽힘(SCC)에 들지 않은 화면 모듈
 * (permissions · bank-parser-ui)만 부른다 — 그쪽에서 이리로 오는 길이 없다.
 */

import { S } from '../state.js';
import { COLS } from '../constants.js';
import { escAttr } from '../utils/ui.js';
import { fb, fdb } from '../services/firestore.js';
import * as ExcelParser from '../services/excel-parser.js';
import { mergedBankConfigs } from '../domain/bank-parser.js';
import { can } from './permissions.js';
import { openBankParserWizard } from './bank-parser-ui.js';

/**
 * 파서가 실제로 쓸 설정 — 내장 + 사용자가 추가한 것.
 *
 * **저장분은 언제나 뒤다.** 판정은 위에서부터 먼저 맞는 것을 택하므로, 앞에
 * 두면 느슨하게 만든 설정 하나가 이미 잘 되던 은행을 가로챌 수 있다.
 */
export function parserConfigs(){
  return mergedBankConfigs(ExcelParser.BANK_CONFIGS, S.bankParsers);
}

/**
 * 인식하지 못한 파일 위에 **다음에 할 일**을 띄운다.
 *
 * 예전에는 「인식된 거래가 없습니다」가 끝이었다. 맞는 말이지만 사용자가 할 수
 * 있는 일이 없다 — 그 은행이 내장 목록에 없다는 것도, 그래서 무엇을 하면
 * 되는지도 알 방법이 없었다. 은행을 늘리는 일이 화면에서 되는 지금은 그 길을
 * 같은 자리에서 보여 준다.
 *
 * @param {File} file
 * @param {Function} retry  추가한 뒤 다시 분석 — 같은 파일을 다시 고르게 하지 않는다
 */
export function offerBankParser(file,retry){
  const host=document.getElementById('xl-preview');
  if(!host||!file||!can('excel.upload'))return;
  const name=String(file.name||'').toLowerCase();
  // SMS 백업·사진은 열이 있는 표가 아니다 — 여기서 고칠 수 있는 종류가 아니다.
  if(name.endsWith('.xml')||isImageFile(file))return;
  const box=document.createElement('div');
  box.style.cssText='margin-bottom:10px;border:1px solid #bfdbfe;background:#eff6ff;'
    +'border-radius:9px;padding:11px 13px;font-size:12px;color:#1e40af;line-height:1.7;';
  box.innerHTML='<strong>이 은행은 아직 등록돼 있지 않은 것 같습니다.</strong><br>'
    +'파일을 열어 어느 열이 날짜·내용·출금·입금인지 한 번만 고르면, 다음부터 이 은행 파일이 그대로 읽힙니다.';
  const btn=document.createElement('button');
  btn.className='btn'; btn.style.cssText='margin-top:8px;';
  btn.textContent='이 파일로 은행 추가';
  btn.addEventListener('click',()=>openBankParserWizard(file,retry));
  box.appendChild(btn);
  host.style.display='block';
  host.prepend(box);
}

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
