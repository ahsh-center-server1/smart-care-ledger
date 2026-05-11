/**
 * modules/modals.js — Smart Care Ledger v2
 * 폼 모달: 거래 입력, 엑셀 업로드, 입주자/계좌/직원 관리, 고정항목, 통장사진, 영수증
 */

'use strict';

import { S } from '../state.js';
import { COLS, CAT_COLORS, cs } from '../constants.js';
import { toast, showConfirm, showLoading, setText, escAttr } from '../utils/ui.js';
import { fb, fdb, batchAddDocs } from '../services/firestore.js';
import { compressImage } from '../services/drive.js';
import { uploadToStorage, getImageUrl } from '../services/storage.js';
import { fetchBaseData, loadTransactions, refetchUsers, refetchClients, refetchAccounts } from './core.js';
import { saveTrx, updateAccBalance, renderHistoryTable } from './transactions.js';
import { renderManagement } from './settings.js';
import { can } from './permissions.js';

// ─────────────────────────────────────────────
// 모달
// ─────────────────────────────────────────────
export function openModal(type,data){
  document.getElementById('modal-wrap').classList.add('show');
  if(type==='trx')           renderTrxForm(data);
  if(type==='excel')         renderExcelForm();
  if(type==='receipt-upload')renderReceiptUploadForm(data?.id);
  if(type==='client')        renderClientForm(data);
  if(type==='account')       renderAccountForm(data);
  if(type==='staff')         renderStaffForm(data);
  if(type==='fixed-item')    renderFixedItemForm(data);
  if(type==='bulk-staff')    renderBulkStaffForm();
  if(type==='bulk-client')   renderBulkClientForm();
  if(type==='bulk-account')  renderBulkAccountForm();
}
export function closeModal(){
  document.getElementById('modal-wrap').classList.remove('show');
  document.getElementById('modal-body').innerHTML='';
}

// ─────────────────────────────────────────────
// 수기 입력 폼
// ─────────────────────────────────────────────
export function renderTrxForm(t){
  const isEdit=!!t;
  const editAmount=isEdit?(t.type==='수입'?t.amountIn:t.type==='자산이동'?t.amountOut:t.amountOut):'';
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:20px;">${isEdit?'내역 수정':'수기 입력'}</h3>
    <input type="hidden" id="f-trx-id" value="${isEdit?t.id:''}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;">
        <div><label class="label">날짜</label><input type="date" id="f-date" class="input" value="${isEdit?t.date:new Date().toISOString().split('T')[0]}"></div>
        <div><label class="label">시간 <span style="font-size:10px;color:var(--muted);">(선택)</span></label><input type="time" id="f-time" class="input" value="${isEdit?t.time||'':''}" style="width:110px;"></div>
        <div><label class="label">출금 계좌</label><select id="f-acc" class="input" style="padding:8px 12px;"></select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">구분</label><select id="f-type" class="input" style="padding:8px 12px;">
          <option value="지출"${isEdit&&t.type==='지출'?' selected':''}>지출</option>
          <option value="수입"${isEdit&&t.type==='수입'?' selected':''}>수입</option>
          <option value="자산이동"${isEdit&&t.type==='자산이동'?' selected':''}>자산이동 (계좌간 이체)</option>
          <option value="취소"${isEdit&&t.type==='취소'?' selected':''}>취소 (카드승인취소)</option>
        </select></div>
        <div><label class="label">금액</label><input type="number" id="f-amount" class="input" value="${editAmount}" placeholder="0" min="0" style="text-align:right;"></div>
      </div>
      <div id="f-to-acc-row" style="display:none;">
        <label class="label">입금 계좌 (자산이동 시)</label>
        <select id="f-to-acc" class="input" style="padding:8px 12px;width:100%;"></select>
      </div>
      <div id="f-cat-row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">분류</label><select id="f-cat" class="input" style="padding:8px 12px;"></select></div>
        <div><label class="label">내용</label><input type="text" id="f-desc" class="input" value="${isEdit?t.description||'':''}" placeholder="거래 내용"></div>
      </div>
      <div>
        <label class="label">영수증 첨부 <span style="font-size:10px;color:var(--muted);">(선택)</span></label>
        ${isEdit&&t.receiptUrl?`<div id="trx-receipt-current" style="margin-bottom:6px;"><a href="${escAttr(t.receiptUrl)}" target="_blank" style="font-size:12px;color:var(--blue);">📎 현재 첨부파일 보기</a> <button onclick="document.getElementById('trx-receipt-current').innerHTML='<span style=\\'font-size:12px;color:#dc2626;\\'>삭제됨</span>';window._trxReceiptClear=true;" style="font-size:11px;color:#dc2626;background:none;border:none;cursor:pointer;">× 삭제</button></div>`:''}
        <div id="trx-receipt-drop" style="border:2px dashed var(--border);border-radius:8px;background:var(--bg);padding:12px;text-align:center;cursor:pointer;font-size:13px;color:var(--muted);" onclick="document.getElementById('trx-receipt-file').click()">
          📎 영수증 클릭 또는 드래그
          <input type="file" id="trx-receipt-file" accept="image/*" style="display:none;">
        </div>
        <div id="trx-receipt-preview" style="display:none;margin-top:6px;font-size:12px;color:var(--green);"></div>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="f-copy-btn" class="btn" style="flex:1;padding:11px;">📋 복사하기</button>
        <button id="f-save-btn" class="btn" style="flex:1;padding:11px;">💾 저장하기</button>
      </div>
    </div>`;
  window._trxReceiptClear=false;
  const accSel=document.getElementById('f-acc');
  const toAccSel=document.getElementById('f-to-acc');
  const allAccs=S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts;
  allAccs.forEach(a=>{
    const cn=S.clients.find(c=>c.id===a.clientId)?.name||'';
    const opt=`[${cn}] ${a.label}`;
    accSel.add(new Option(opt,a.id));
    toAccSel.add(new Option(opt,a.id));
  });
  if(isEdit)accSel.value=t.accountId;
  if(isEdit&&t.linkedAccountId)toAccSel.value=t.linkedAccountId;
  const toAccRow=document.getElementById('f-to-acc-row');
  const showToAcc=()=>{const type=document.getElementById('f-type').value;if(toAccRow)toAccRow.style.display=type==='자산이동'?'block':'none';};
  showToAcc();
  updateTrxCatSel();
  if(isEdit&&t.category)document.getElementById('f-cat').value=t.category;
  document.getElementById('f-type').addEventListener('change',()=>{updateTrxCatSel();showToAcc();});
  document.getElementById('f-save-btn').addEventListener('click',async()=>{
    const accId=document.getElementById('f-acc').value;
    const amount=Number(document.getElementById('f-amount').value);
    if(!accId){toast('계좌를 선택하세요.','error');return;}
    if(!amount){toast('금액을 입력하세요.','error');return;}
    const acc=S.accounts.find(a=>a.id===accId);
    const type=document.getElementById('f-type').value;
    const date=document.getElementById('f-date').value;
    const time=document.getElementById('f-time')?.value||''; // F003
    const cat=document.getElementById('f-cat').value;
    const desc=document.getElementById('f-desc').value;
    const existId=document.getElementById('f-trx-id').value;
    if(type==='자산이동'){
      const toAccId=document.getElementById('f-to-acc').value;
      if(!toAccId){toast('입금 계좌를 선택하세요.','error');return;}
      if(toAccId===accId){toast('출금 계좌와 입금 계좌가 같습니다.','error');return;}
      const toAcc=S.accounts.find(a=>a.id===toAccId);
      closeModal();
      if(existId){
        const outData={clientId:acc.clientId,accountId:accId,date,time,type:'자산이동',category:'자산이동',description:desc,amountIn:0,amountOut:amount,receiptUrl:t.receiptUrl||'',linkedAccountId:toAccId};
        outData.id=existId; await saveTrx(outData);
        // B003: 연결 입금 거래 동기화
        if(t.linkedTrxId){
          const toAcc2=S.accounts.find(a=>a.id===toAccId);
          const{doc:d2,updateDoc:ud2}=fb();
          await ud2(d2(fdb(),COLS.TRANSACTIONS,t.linkedTrxId),{clientId:toAcc2?.clientId||acc.clientId,accountId:toAccId,date,time,description:desc,amountIn:amount,amountOut:0,linkedAccountId:accId});
          await updateAccBalance(toAccId);
          if(S.activeClient)await loadTransactions(S.activeClient);
        }
      } else {
        const{addDoc,collection,updateDoc,doc}=fb();
        const outRef=await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:acc.clientId,accountId:accId,date,time,type:'자산이동',category:'자산이동',description:desc,amountIn:0,amountOut:amount,receiptUrl:'',linkedAccountId:toAccId});
        const inRef=await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:toAcc.clientId,accountId:toAccId,date,time,type:'자산이동',category:'자산이동',description:desc,amountIn:amount,amountOut:0,receiptUrl:'',linkedAccountId:accId,linkedTrxId:outRef.id});
        await updateDoc(doc(fdb(),COLS.TRANSACTIONS,outRef.id),{linkedTrxId:inRef.id});
        await updateAccBalance(accId); await updateAccBalance(toAccId);
        if(S.activeClient===acc.clientId||S.activeClient===toAcc?.clientId)await loadTransactions(S.activeClient);
        toast('자산이동 저장됨','success');
      }
    } else {
      // 영수증 업로드 처리
      let receiptUrl=isEdit?t.receiptUrl||'':'';
      if(window._trxReceiptClear)receiptUrl='';
      const receiptFile=document.getElementById('trx-receipt-file')?.files[0];
      if(receiptFile){
        try{
          const url=await uploadToStorage(receiptFile,`receipts/${acc.clientId}/${Date.now()}_${receiptFile.name}`);
          if(url)receiptUrl=url;
        }catch(e){toast('영수증 업로드 실패: '+e.message,'error');}
      }
      const trxData={clientId:acc.clientId,accountId:accId,date,time,type,category:cat,description:desc,
        amountIn:type==='수입'?amount:0,
        amountOut:(type==='지출'||type==='취소')?amount:0,
        receiptUrl};
      if(existId)trxData.id=existId;
      closeModal(); await saveTrx(trxData);
    }
  });
  document.getElementById('f-copy-btn').addEventListener('click',async()=>{
    if(!isEdit){toast('수정 중인 거래가 없습니다.','error');return;}
    const accId=document.getElementById('f-acc').value;
    const amount=Number(document.getElementById('f-amount').value);
    if(!accId){toast('계좌를 선택하세요.','error');return;}
    if(!amount){toast('금액을 입력하세요.','error');return;}
    const acc=S.accounts.find(a=>a.id===accId);
    const type=document.getElementById('f-type').value;
    const date=document.getElementById('f-date').value||new Date().toISOString().split('T')[0];
    const time=document.getElementById('f-time')?.value||'';
    const cat=document.getElementById('f-cat').value;
    const desc=document.getElementById('f-desc').value;
    if(type==='자산이동'){
      const toAccId=document.getElementById('f-to-acc').value;
      if(!toAccId){toast('입금 계좌를 선택하세요.','error');return;}
      if(toAccId===accId){toast('출금 계좌와 입금 계좌가 같습니다.','error');return;}
      const toAcc=S.accounts.find(a=>a.id===toAccId);
      const{addDoc,collection,updateDoc,doc}=fb();
      const outRef=await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:acc.clientId,accountId:accId,date,time,type:'자산이동',category:'자산이동',description:desc,amountIn:0,amountOut:amount,receiptUrl:'',linkedAccountId:toAccId});
      const inRef=await addDoc(collection(fdb(),COLS.TRANSACTIONS),{clientId:toAcc.clientId,accountId:toAccId,date,time,type:'자산이동',category:'자산이동',description:desc,amountIn:amount,amountOut:0,receiptUrl:'',linkedAccountId:accId,linkedTrxId:outRef.id});
      await updateDoc(doc(fdb(),COLS.TRANSACTIONS,outRef.id),{linkedTrxId:inRef.id});
      await updateAccBalance(accId); await updateAccBalance(toAccId);
      if(S.activeClient===acc.clientId||S.activeClient===toAcc?.clientId)await loadTransactions(S.activeClient);
      toast('✅ 거래가 복사되었습니다.','success');
    } else {
      const trxData={clientId:acc.clientId,accountId:accId,date,time,type,category:cat,description:desc,
        amountIn:type==='수입'?amount:0,
        amountOut:(type==='지출'||type==='취소')?amount:0,
        receiptUrl:''};
      await saveTrx(trxData);
      toast('✅ 거래가 복사되었습니다.','success');
    }
  });
  // 파일 선택 미리보기
  document.getElementById('trx-receipt-file')?.addEventListener('change',function(){
    const f=this.files[0]; if(!f)return;
    const preview=document.getElementById('trx-receipt-preview');
    if(preview){preview.style.display='block';preview.textContent='📎 '+f.name+' ('+Math.round(f.size/1024)+'KB)';}
    const drop=document.getElementById('trx-receipt-drop');
    if(drop)drop.style.borderColor='var(--green)';
  });
  // 드래그앤드롭
  const dropEl=document.getElementById('trx-receipt-drop');
  if(dropEl){
    dropEl.addEventListener('dragover',e=>{e.preventDefault();dropEl.style.background='#f0fdf4';});
    dropEl.addEventListener('dragleave',()=>{dropEl.style.background='var(--bg)';});
    dropEl.addEventListener('drop',e=>{
      e.preventDefault();dropEl.style.background='var(--bg)';
      const f=e.dataTransfer.files[0]; if(!f||!f.type.startsWith('image/'))return;
      const fi=document.getElementById('trx-receipt-file');
      if(fi){
        const dt=new DataTransfer(); dt.items.add(f); fi.files=dt.files;
        fi.dispatchEvent(new Event('change'));
      }
    });
  }
}
export function updateTrxCatSel(){
  const type=document.getElementById('f-type')?.value||'지출';
  const sel=document.getElementById('f-cat');
  const catRow=document.getElementById('f-cat-row');
  if(!sel)return;
  if(type==='자산이동'||type==='취소'){
    if(catRow)catRow.style.display='none';
    sel.innerHTML='<option value="">-</option>';
    return;
  }
  if(catRow)catRow.style.display='';
  sel.innerHTML='';
  const clientId=S.activeClient||'';
  const cats=[...new Set(
    S.categories
      .filter(c=>c.keyword===''&&c.type===type&&(!c.clientId||c.clientId===clientId))
      .sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999))
      .map(c=>c.category)
  )];
  if(!cats.includes('확인필요'))cats.push('확인필요');
  cats.forEach(c=>sel.add(new Option(c,c)));
}

// ─────────────────────────────────────────────
// 엑셀 파일 업로드 폼
// ─────────────────────────────────────────────
export function renderExcelForm(){
  if(!can('excel.upload')){ toast('접근 권한이 없습니다.','error'); closeModal(); return; }
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">📂 엑셀 파일 업로드</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">계좌 선택</label><select id="xl-acc" class="input" style="padding:8px 12px;"></select></div>
      <div id="xl-drop" class="dropzone" style="cursor:pointer;">
        <input type="file" id="xl-file" accept=".xlsx,.xls,.html,.htm,.xml,.csv" style="display:none;">
        <div style="font-size:28px;margin-bottom:8px;">📊</div>
        <div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">xlsx · xls · html · xml · csv</div>
      </div>
      <div style="background:#f0fdf4;border:1px solid #a7f3d0;border-radius:8px;padding:10px 14px;font-size:12px;color:#065f46;">
        💡 은행 파일이 없으신가요? <strong>수기 입력 양식</strong>을 다운로드하여 직접 작성 후 업로드하세요.
        <button onclick="downloadManualTemplate()" style="margin-left:8px;padding:3px 10px;border-radius:6px;border:1px solid #059669;color:#059669;background:#fff;cursor:pointer;font-size:12px;">📥 양식 다운로드</button>
      </div>
      <button id="xl-btn" class="btn" style="width:100%;padding:10px;">📊 파일 분석 시작</button>
      <div id="xl-preview" style="display:none;"></div>
    </div>`;
  const accSel=document.getElementById('xl-acc');
  (S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts).forEach(a=>{
    const cn=S.clients.find(c=>c.id===a.clientId)?.name||'';
    accSel.add(new Option(`[${cn}] ${a.label}`,a.id));
  });
  const zone=document.getElementById('xl-drop'), fi=document.getElementById('xl-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
  zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');if(e.dataTransfer.files.length){fi.files=e.dataTransfer.files;onXlFileSelect();}});
  fi.addEventListener('change',onXlFileSelect);
  document.getElementById('xl-btn').addEventListener('click',analyzeXlFile);
}
export function downloadManualTemplate(){
  // CSV 형식 수기 입력 양식 생성 후 다운로드
  const today=new Date().toISOString().split('T')[0];
  const rows=[
    ['날짜','내용','지출금액','입금금액'],
    [today,'점심 식비','5000',''],
    [today,'용돈 입금','','30000'],
  ];
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const bom='\uFEFF'; // Excel 한글 깨짐 방지 BOM
  const blob=new Blob([bom+csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='수기입력_양식.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('양식 다운로드 완료. 내용 작성 후 업로드하세요.','success');
}
export function onXlFileSelect(){
  const fi=document.getElementById('xl-file'), btn=document.getElementById('xl-btn');
  if(fi.files.length){
    S.excelFile=fi.files[0]; // 원본 파일 참조 보존
    if(btn)btn.textContent=`📊 분석 시작 (${fi.files[0].name})`;
  }
}
export function analyzeXlFile(){
  const fi=document.getElementById('xl-file'); if(!fi?.files?.length){toast('파일을 선택하세요.','error');return;}
  const btn=document.getElementById('xl-btn'); btn.disabled=true; btn.textContent='분석 중...';
  const clientId=S.activeClient||'';
  // C002: 입주자별 규칙 우선, 공통 규칙 후순위로 정렬
  const parserCats=S.categories.filter(c=>c.keyword&&c.keyword!==''&&(!c.clientId||c.clientId===clientId)).sort((a,b)=>(a.clientId===clientId?0:1)-(b.clientId===clientId?0:1)).map(c=>({keyword:c.keyword,category:c.category,subcategory:c.subcategory||''}));
  ExcelParser.parseFile(fi.files[0],parserCats)
    .then(parsed=>{
      if(!parsed.length){toast('인식된 거래 데이터가 없습니다.','error');btn.disabled=false;btn.textContent='파일 분석 시작';return;}
      const existSet=new Set(S.transactions.map(t=>`${t.date}_${Math.abs(t.amountIn||0)}_${Math.abs(t.amountOut||0)}`));
      const existingMaxOrder=S.transactions.length>0?Math.max(...S.transactions.map(t=>t.sortOrder??0)):0;
      S.excelTemp=parsed.map((p,i)=>{
        const rawIn=p.in||0, rawOut=p.out||0;
        let amIn=0, amOut=0, type='지출';
        if(rawIn>0){amIn=rawIn;type='수입';}
        else if(rawOut>0){amOut=rawOut;type='지출';}
        else if(rawOut<0){amOut=rawOut;type='지출';}
        else if(rawIn<0){amOut=Math.abs(rawIn);type='취소';}
        const isDup=existSet.has(`${p.date}_${Math.abs(amIn)}_${Math.abs(amOut)}`);
        return {date:p.date,description:p.desc,amountIn:amIn,amountOut:amOut,type,category:p.cat||'확인필요',subcategory:p.sub||'',receiptUrl:'',_dup:isDup,sortOrder:existingMaxOrder+i+1};
      });
      // 원본 행 보존 (Drive 저장 + 대조용)
      S.excelRawRows=parsed.map(p=>({date:p.date,desc:p.desc,amountIn:p.in>0?p.in:0,amountOut:p.out>0?p.out:0}));
      // 가장 빈번한 연월 자동 감지
      const mCount={};parsed.forEach(p=>{const m=(p.date||'').substring(0,7);if(m)mCount[m]=(mCount[m]||0)+1;});
      S.excelMonth=Object.entries(mCount).sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
      const dupCount=S.excelTemp.filter(x=>x._dup).length;
      btn.disabled=false; btn.textContent=`분석 완료 (${S.excelTemp.length}건)`;
      if(dupCount>0)toast(`⚠️ ${dupCount}건이 기존 거래와 중복됩니다. 저장 시 자동 제외됩니다.`,'info',5000);
      renderXlPreview();
    })
    .catch(err=>{btn.disabled=false;btn.textContent='파일 분석 시작';toast('파싱 오류: '+err.message,'error');});
}
export function renderXlPreview(){
  const el=document.getElementById('xl-preview'); if(!el)return;
  if(!S.excelTemp.length){el.style.display='none';return;}
  const dupCount=S.excelTemp.filter(x=>x._dup).length;
  el.style.display='block';
  el.innerHTML=`
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
      <div style="font-size:13px;font-weight:700;color:var(--sub);">총 ${S.excelTemp.length}건 분석됨${dupCount>0?' <span style="color:#92400e;background:#fef3c7;padding:1px 7px;border-radius:5px;font-size:11px;">중복 '+dupCount+'건 저장 제외</span>':''}</div>
      <label style="font-size:12px;color:var(--muted);margin-left:auto;display:flex;align-items:center;gap:6px;">📅 업로드 연월
        <input type="month" id="xl-month-label" class="input" value="${S.excelMonth}" style="padding:4px 8px;font-size:12px;width:130px;">
      </label>
    </div>
    <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:9px;background:#f8fafc;margin-bottom:10px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead style="background:#fff;position:sticky;top:0;"><tr>
          <th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">날짜</th>
          <th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">내용</th>
          <th style="padding:7px 10px;text-align:left;font-size:11px;color:var(--muted);">분류</th>
          <th style="padding:7px 10px;text-align:right;font-size:11px;color:var(--muted);">금액</th>
          <th style="padding:7px 10px;"></th>
        </tr></thead>
        <tbody id="xl-tbody"></tbody>
      </table>
    </div>
    <button id="xl-save-btn" class="btn" style="width:100%;padding:11px;background:#10b981;">✅ 최종 저장 (Drive 자동 백업 포함)</button>`;
  const tbody=document.getElementById('xl-tbody');
  S.excelTemp.forEach((t,i)=>{
    const isIn=t.amountIn>0, amt=isIn?t.amountIn:Math.abs(t.amountOut), c=cs(t.category);
    const tr=document.createElement('tr'); tr.style.cssText='border-top:1px solid var(--border);';
    const dupBadge=t._dup?'<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:4px;margin-left:4px;">중복의심</span>':'';
    tr.style.background=t._dup?'#fffbeb':'';
    tr.innerHTML=`<td style="padding:6px 10px;font-size:12px;color:var(--sub);white-space:nowrap;">${t.date}</td><td style="padding:6px 10px;font-size:13px;color:var(--text);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${t.description}">${t.description}${dupBadge}</td><td style="padding:6px 10px;"><span style="background:${c.bg};color:${c.text};padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700;">${t.category}</span></td><td style="padding:6px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:${isIn?'#059669':t.type==='취소'?'#71717a':'#dc2626'};">${isIn?'+':''}${amt.toLocaleString()}원${t.type==='취소'?' (취소)':''}</td><td style="padding:6px 10px;text-align:center;"><button style="font-size:12px;color:#94a3b8;background:none;border:none;cursor:pointer;">✕</button></td>`;
    tr.querySelector('button').addEventListener('click',()=>removeXlItem(i));
    tbody.appendChild(tr);
  });
  document.getElementById('xl-save-btn').addEventListener('click',saveExcelData);
}
export function removeXlItem(idx){
  S.excelTemp.splice(idx,1);
  if(!S.excelTemp.length){document.getElementById('xl-preview').style.display='none';toast('모든 항목이 제거되었습니다.','info');return;}
  renderXlPreview();
}
export async function saveExcelData(){
  const accId=document.getElementById('xl-acc')?.value;
  if(!accId){toast('계좌를 선택하세요.','error');return;}
  if(!S.excelTemp.length){toast('데이터가 없습니다.','error');return;}
  const acc=S.accounts.find(a=>a.id===accId); if(!acc)return;
  const btn=document.getElementById('xl-save-btn'); if(btn){btn.disabled=true;btn.textContent='저장 중...';}
  // 중복(_dup) 행 제외하고 저장
  const toSave=S.excelTemp.filter(item=>!item._dup);
  const dupCount=S.excelTemp.length-toSave.length;
  const{addDoc,collection}=fb();
  for(const item of toSave){
    await addDoc(collection(fdb(),COLS.TRANSACTIONS),{
      clientId:acc.clientId,accountId:accId,date:item.date,type:item.type,
      category:item.category,subcategory:item.subcategory||'',
      description:item.description,amountIn:item.amountIn||0,amountOut:item.amountOut||0,
      receiptUrl:'',sortOrder:item.sortOrder??null
    });
  }
  await updateAccBalance(accId);
  const msg=dupCount>0?`${toSave.length}건 저장됨 (중복 ${dupCount}건 제외)`:toSave.length+'건 저장됨';
  toast(msg,'success'); closeModal();
  if(S.activeClient===acc.clientId)await loadTransactions(acc.clientId);
  // 엑셀 원본 Drive 업로드 + excelUploads 저장 (거래 저장 후 비동기)
  if(S.excelFile){
    const uploadFile=S.excelFile, uploadRawRows=[...S.excelRawRows];
    const uploadMonth=document.getElementById('xl-month-label')?.value||S.excelMonth;
    S.excelFile=null; S.excelRawRows=[]; S.excelMonth='';
    try{
      toast('원본 파일 업로드 중...','info',3000);
      const url=await uploadToStorage(uploadFile,`excel/${acc.clientId}/${accId}/${Date.now()}_${uploadFile.name}`);
      const{addDoc:aDoc,collection:col}=fb();
      await aDoc(col(fdb(),COLS.EXCEL_UPLOADS),{
        accId,clientId:acc.clientId,filename:uploadFile.name,
        month:uploadMonth,url,uploadedAt:new Date().toISOString().split('T')[0],
        rawRows:uploadRawRows
      });
      toast('원본 파일 저장 완료','success',2000);
    }catch(e){toast('파일 저장 실패 (거래는 정상 저장됨): '+e.message,'error',5000);}
  }
}

// ─────────────────────────────────────────────
// 증빙 업로드 모달
// ─────────────────────────────────────────────
let _receiptSelectedFile=null;
export function renderReceiptUploadForm(trxId){
  _receiptSelectedFile=null;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">📎 증빙 업로드</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px;">클릭하거나 파일을 끌어다 놓으면 Google Drive에 자동 업로드됩니다.</p>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div id="ru-drop" style="border:2px dashed var(--bm);border-radius:12px;background:#f8fafc;padding:24px 20px;text-align:center;cursor:pointer;transition:all .15s;">
        <input type="file" id="ru-file" accept="image/*,.pdf" style="display:none;">
        <div id="ru-drop-inner"><div style="font-size:28px;margin-bottom:8px;">🖼️</div><div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요</div><div style="font-size:11px;color:var(--muted);margin-top:4px;">jpg · png · gif · webp · pdf</div></div>
      </div>
      <div id="ru-preview" style="display:none;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#f8fafc;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);">
          <span id="ru-fname" style="font-size:12px;font-weight:700;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;"></span>
          <span id="ru-fsize" style="font-size:11px;color:var(--muted);flex-shrink:0;margin-left:8px;"></span>
        </div>
        <div style="text-align:center;padding:10px;">
          <img id="ru-img" style="max-width:100%;max-height:220px;border-radius:6px;display:none;" alt="미리보기">
          <div id="ru-pdf-icon" style="display:none;font-size:40px;padding:16px;">📄</div>
        </div>
      </div>
      <button id="ru-btn" class="btn" style="width:100%;padding:11px;opacity:.5;cursor:not-allowed;" disabled>파일을 먼저 선택하세요</button>
      <div id="ru-status" style="font-size:12px;color:var(--muted);text-align:center;display:none;"></div>
    </div>`;
  const zone=document.getElementById('ru-drop'), fi=document.getElementById('ru-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragenter',e=>{e.preventDefault();e.stopPropagation();});
  zone.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();zone.style.borderColor='var(--blue)';zone.style.background='#eff6ff';});
  zone.addEventListener('dragleave',e=>{e.stopPropagation();zone.style.borderColor='var(--bm)';zone.style.background='#f8fafc';});
  zone.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();zone.style.borderColor='var(--bm)';zone.style.background='#f8fafc';const file=e.dataTransfer?.files?.[0];if(file)onReceiptFileSelect(file);});
  fi.addEventListener('change',()=>{const file=fi.files?.[0];if(file)onReceiptFileSelect(file);});
  document.getElementById('ru-btn').addEventListener('click',()=>doReceiptUpload(trxId));
}
export function onReceiptFileSelect(file){
  _receiptSelectedFile=file;
  const fn=document.getElementById('ru-fname'), fs=document.getElementById('ru-fsize');
  const prev=document.getElementById('ru-preview'), img=document.getElementById('ru-img');
  const pdf=document.getElementById('ru-pdf-icon'), drop=document.getElementById('ru-drop'), btn=document.getElementById('ru-btn');
  if(fn)fn.textContent='📄 '+file.name;
  if(fs)fs.textContent=(file.size/1024).toFixed(0)+' KB';
  if(prev)prev.style.display='block';
  if(drop)drop.style.padding='12px 20px';
  const inner=document.getElementById('ru-drop-inner');
  if(inner)inner.innerHTML='<div style="font-size:12px;color:var(--muted);">다른 파일로 변경하려면 클릭하세요</div>';
  if(file.type.startsWith('image/')){
    if(pdf)pdf.style.display='none'; if(img)img.style.display='block';
    const reader=new FileReader(); reader.onload=e=>{if(img)img.src=e.target.result;}; reader.readAsDataURL(file);
  } else {if(img)img.style.display='none'; if(pdf)pdf.style.display='block';}
  if(btn){btn.disabled=false;btn.style.opacity='1';btn.style.cursor='pointer';btn.textContent='📤 업로드';}
}
export async function doReceiptUpload(trxId){
  if(!_receiptSelectedFile){toast('파일을 선택하세요.','error');return;}
  const btn=document.getElementById('ru-btn'), status=document.getElementById('ru-status');
  btn.disabled=true; btn.textContent='압축 중...';
  if(status){status.textContent='이미지 압축 중...';status.style.display='block';}
  try{
    btn.textContent='업로드 중...';
    if(status)status.textContent='Firebase Storage에 업로드 중입니다...';
    const url=await uploadToStorage(_receiptSelectedFile,`receipts/${S.activeClient||'all'}/${Date.now()}_${_receiptSelectedFile.name}`);
    const{doc,updateDoc}=fb();
    await updateDoc(doc(fdb(),COLS.TRANSACTIONS,trxId),{receiptUrl:url});
    [S.transactions,S.filteredTrx].forEach(arr=>{const t=arr.find(x=>x.id===trxId);if(t)t.receiptUrl=url;});
    toast('업로드 완료!','success'); _receiptSelectedFile=null; closeModal(); renderHistoryTable();
  }catch(e){btn.disabled=false;btn.textContent='📤 업로드';if(status)status.style.display='none';toast('업로드 실패: '+e.message,'error');}
}
export function openReceiptUpload(trxId){openModal('receipt-upload',{id:trxId});}

// ─────────────────────────────────────────────
// 영수증 미리보기 모달
// ─────────────────────────────────────────────
// 영수증 미리보기 — 드래그 가능 플로팅 패널 (거래정보 함께 표시)
export function openReceiptModal(url, trxId){
  if(!url)return;
  const trx=trxId?[...S.transactions,...(S.reportData?.trxList||[])].find(x=>x.id===trxId):null;
  const driveMatch=url.match(/\/d\/([^/?]+)/);
  const isDrive=!!driveMatch;
  const isStorage=url.includes('firebasestorage.googleapis.com');
  const isPdf=/\.pdf/i.test(decodeURIComponent(url));
  const isLocalImg=(/\.(jpg|jpeg|png|gif|webp|bmp)/i.test(url)||(isStorage&&!isPdf))&&!isDrive;
  // 기존 플로팅 패널 제거
  const existing=document.getElementById('receipt-float-panel');
  if(existing)existing.remove();
  const acc=trx?S.accounts.find(a=>a.id===trx.accountId):null;
  const trxInfoHtml=trx?`<div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px;">
    <div style="font-size:12px;font-weight:700;color:var(--sub);margin-bottom:8px;">📋 거래 정보</div>
    <div style="display:flex;flex-direction:column;gap:5px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">날짜</span><span>${trx.date||''}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">계좌</span><span>${acc?.label||'-'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">분류</span><span>${trx.category||'-'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">내용</span><span style="max-width:140px;text-align:right;word-break:break-all;">${trx.description||'-'}</span></div>
      ${trx.amountIn?`<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">수입</span><span style="color:#10b981;font-weight:700;">${Number(trx.amountIn).toLocaleString()}원</span></div>`:''}
      ${trx.amountOut?`<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">지출</span><span style="color:#ef4444;font-weight:700;">${Number(trx.amountOut).toLocaleString()}원</span></div>`:''}
    </div>
  </div>`:'';
  const panel=document.createElement('div');
  panel.id='receipt-float-panel';
  panel.style.cssText='position:fixed;right:16px;top:60px;width:300px;max-height:90vh;overflow-y:auto;background:#fff;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.18);z-index:9999;padding:16px;';
  let imgHtml='';
  if(isDrive){
    imgHtml=`<div id="rfp-loading" style="text-align:center;padding:30px 0;"><div class="spinner" style="margin:0 auto 8px;"></div><p style="font-size:12px;color:var(--muted);">불러오는 중...</p></div><img id="rfp-img" src="${getImageUrl(url,'w600')}" alt="영수증" style="display:none;max-width:100%;border-radius:8px;">`;
  } else if(isPdf){
    imgHtml=`<iframe src="${url}" style="width:100%;height:380px;border:none;border-radius:8px;background:#f8fafc;" title="PDF 미리보기"></iframe><p style="font-size:11px;color:var(--muted);margin-top:6px;text-align:center;"><a href="${url}" target="_blank" rel="noopener" style="color:var(--blue);">새 탭에서 열기</a></p>`;
  } else if(isLocalImg){
    imgHtml=`<img src="${url}" alt="영수증" style="max-width:100%;border-radius:8px;">`;
  } else {
    imgHtml=`<div style="text-align:center;padding:20px 0;font-size:32px;">📄</div>`;
  }
  panel.innerHTML=`<div id="rfp-drag-handle" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;cursor:grab;">
    <span style="font-size:14px;font-weight:700;color:var(--text);">📎 영수증 미리보기</span>
    <div style="display:flex;gap:6px;align-items:center;">
      <a href="${url}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);border:1px solid #bfdbfe;padding:3px 8px;border-radius:6px;text-decoration:none;">🔗 새탭</a>
      <button onclick="closeReceiptModal()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--muted);line-height:1;">×</button>
    </div>
  </div>${imgHtml}${trxInfoHtml}`;
  document.body.appendChild(panel);
  // 이미지 로드 이벤트
  if(isDrive){
    const img=panel.querySelector('#rfp-img'), loading=panel.querySelector('#rfp-loading');
    if(img&&loading){img.onload=()=>{loading.style.display='none';img.style.display='block';};img.onerror=()=>{loading.style.display='none';};}
  }
  // 드래그 이동
  const handle=panel.querySelector('#rfp-drag-handle');
  let ox=0,oy=0,dragging=false;
  handle.addEventListener('mousedown',e=>{dragging=true;ox=e.clientX-panel.offsetLeft;oy=e.clientY-panel.offsetTop;handle.style.cursor='grabbing';e.preventDefault();});
  document.addEventListener('mousemove',e=>{if(!dragging)return;panel.style.left=(e.clientX-ox)+'px';panel.style.top=(e.clientY-oy)+'px';panel.style.right='auto';});
  document.addEventListener('mouseup',()=>{dragging=false;handle.style.cursor='grab';});
}
export function closeReceiptModal(){
  const p=document.getElementById('receipt-float-panel');
  if(p)p.remove();
  // 기존 모달도 닫기 (하위 호환)
  document.getElementById('receipt-modal')?.classList.remove('show');
  const body=document.getElementById('receipt-body');if(body)body.innerHTML='';
}

// ─────────────────────────────────────────────
// 증빙 A4 출력
// ─────────────────────────────────────────────
export async function printReceiptSheet(){
  const clientId=S.activeClient;
  if(!clientId){toast('입주자를 선택하세요.','error');return;}
  const trxWithReceipt=S.filteredTrx.filter(t=>t.receiptUrl);
  if(!trxWithReceipt.length){toast('증빙이 있는 거래가 없습니다.','info');return;}
  const client=S.clients.find(c=>c.id===clientId)||{name:''};
  const win=window.open('','_blank');
  let cells='';
  trxWithReceipt.forEach((t,i)=>{
    const imgSrc=getImageUrl(t.receiptUrl,'w400');
    cells+='<div class="cell"><div class="cell-info">'+t.date+' · '+(t.description||'')+' · '+(t.amountOut>0?t.amountOut.toLocaleString()+'원':t.amountIn.toLocaleString()+'원')+'</div><div class="cell-img"><img src="'+imgSrc+'" onerror="this.src=\'\';this.parentElement.innerHTML=\'이미지 없음\'"></div></div>';
    if((i+1)%8===0&&i+1<trxWithReceipt.length)cells+='<div style="grid-column:1/-1;page-break-after:always;height:0;margin:0;padding:0;border:none;"></div>';
  });
  // A4(210×297mm) - 여백16mm - 제목8mm → 유효높이 약273mm, 4행이므로 행높이 약66mm, 이미지영역 약58mm
  win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>증빙 출력 — '+client.name+'</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:"Noto Sans KR",sans-serif;background:#fff;padding:8mm;}h2{font-size:12px;font-weight:700;color:#374151;margin-bottom:4mm;}.grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm;}.cell{border:1px solid #d1d5db;border-radius:3px;padding:2px;break-inside:avoid;page-break-inside:avoid;height:62mm;display:flex;flex-direction:column;overflow:hidden;}.cell-info{font-size:7.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;padding-bottom:2px;border-bottom:1px solid #f3f4f6;margin-bottom:2px;}.cell-img{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;min-height:0;}.cell-img img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;}@page{size:A4 portrait;margin:8mm;}@media print{body{padding:0;}.grid{height:calc(297mm - 16mm - 10mm);grid-template-rows:repeat(4,1fr);}}</style></head><body><h2>📎 증빙 출력 — '+client.name+' ('+trxWithReceipt.length+'건)</h2><div class="grid">'+cells+'</div><script>window.onload=()=>{window.print();};<\/script></body></html>');
  win.document.close();
}

// ─────────────────────────────────────────────
// 고정항목
// ─────────────────────────────────────────────
export async function loadFixedItems(clientId){
  if(!clientId)return;
  const{getDocs,collection,query,where}=fb();
  const snap=await getDocs(query(collection(fdb(),'fixedItems'),where('clientId','==',clientId)));
  S.fixedItems=snap.docs.map(d=>({id:d.id,...d.data()}));
}
export async function applyFixedItems(){
  const clientId=S.activeClient;
  if(!clientId){toast('입주자를 먼저 선택하세요.','error');return;}
  await loadFixedItems(clientId);
  if(!S.fixedItems.length){toast('등록된 고정항목이 없습니다. 설정에서 추가하세요.','info');return;}
  // 기본값: 이전 달
  const now=new Date();
  const prev=new Date(now.getFullYear(),now.getMonth()-1,1);
  const defaultYM=prev.getFullYear()+'-'+String(prev.getMonth()+1).padStart(2,'0');
  // 월 선택 모달
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">📌 고정항목 입력</h3>
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <label class="label">입력 대상 월</label>
        <input type="month" id="fi-month-sel" class="input" value="${defaultYM}" style="padding:8px 12px;">
      </div>
      <button id="fi-month-ok" class="btn" style="padding:11px;width:100%;">📌 이 달로 입력하기</button>
    </div>`;
  document.getElementById('modal-wrap').classList.add('show');
  document.getElementById('fi-month-ok').addEventListener('click',async()=>{
    const yearMonth=document.getElementById('fi-month-sel').value;
    if(!yearMonth){toast('월을 선택하세요.','error');return;}
    closeModal();
    const existing=S.transactions.filter(t=>(t.date||'').startsWith(yearMonth)&&t.isFixed);
    const existKeys=new Set(existing.map(t=>t.fixedItemId));
    const toAdd=S.fixedItems.filter(f=>!existKeys.has(f.id));
    if(!toAdd.length){toast(`${yearMonth} 고정항목이 이미 입력되었습니다.`,'info');return;}
    showConfirm('고정항목 입력',`${yearMonth} 기준 고정항목 ${toAdd.length}건을 입력하시겠습니까?`,async()=>{
      const{addDoc,collection}=fb();
      for(const f of toAdd){
        await addDoc(collection(fdb(),COLS.TRANSACTIONS),{
          clientId,accountId:f.accountId,
          date:f.day?yearMonth+'-'+String(f.day).padStart(2,'0'):yearMonth+'-01',
          type:f.type,category:f.category,description:f.description,
          amountIn:f.type==='수입'?Number(f.amount):0,
          amountOut:f.type==='지출'?Number(f.amount):0,
          receiptUrl:'',isFixed:true,fixedItemId:f.id
        });
      }
      toast(`${toAdd.length}건 입력 완료`,'success');
      await loadTransactions(clientId);
    },'입력');
  });
}
export async function saveFixedItem(data){
  const{addDoc,setDoc,doc,collection}=fb();
  if(data.id){const id=data.id;delete data.id;await setDoc(doc(fdb(),'fixedItems',id),data);}
  else await addDoc(collection(fdb(),'fixedItems'),data);
  toast('고정항목 저장됨','success');
}
export async function deleteFixedItem(id){
  const{doc,deleteDoc}=fb();
  await deleteDoc(doc(fdb(),'fixedItems',id));
  toast('삭제됨','success');
}

// ─────────────────────────────────────────────
// 고정항목 폼
// ─────────────────────────────────────────────
export function renderFixedItemForm(item){
  const isEdit=!!item;
  const accs=S.activeClient?S.accounts.filter(a=>a.clientId===S.activeClient):S.accounts;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">⚙️ 고정항목 ${isEdit?'수정':'등록'}</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">계좌</label><select id="fi-acc" class="input" style="padding:8px 12px;"></select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">구분</label><select id="fi-type" class="input" style="padding:8px 12px;"><option value="지출">지출</option><option value="수입">수입</option></select></div>
        <div><label class="label">매월 몇 일</label><input type="number" id="fi-day" class="input" min="1" max="31" value="${isEdit?item.day||1:1}"></div>
      </div>
      <div><label class="label">카테고리</label><select id="fi-cat" class="input" style="padding:8px 12px;"></select></div>
      <div><label class="label">내용</label><input type="text" id="fi-desc" class="input" value="${isEdit?item.description||'':''}" placeholder="예: 국민연금, 복지관 이용료"></div>
      <div><label class="label">금액</label><input type="number" id="fi-amt" class="input" value="${isEdit?item.amount||0:0}" style="text-align:right;"></div>
      <button id="fi-save" class="btn" style="width:100%;padding:11px;">💾 저장</button>
    </div>`;
  const accSel=document.getElementById('fi-acc');
  accs.forEach(a=>accSel.add(new Option(a.label,a.id)));
  if(isEdit&&item.accountId)accSel.value=item.accountId;
  const catSel=document.getElementById('fi-cat');
  const fillCats=()=>{const type=document.getElementById('fi-type').value;catSel.innerHTML='';const cats=[...new Map(S.categories.filter(c=>c.keyword===''&&c.type===type).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(c=>[c.category,c.category])).keys()];cats.forEach(c=>catSel.add(new Option(c,c)));if(isEdit&&item.category)catSel.value=item.category;};
  fillCats();
  document.getElementById('fi-type').addEventListener('change',fillCats);
  document.getElementById('fi-save').addEventListener('click',async()=>{
    const data={clientId:S.activeClient,accountId:document.getElementById('fi-acc').value,type:document.getElementById('fi-type').value,day:Number(document.getElementById('fi-day').value)||1,category:document.getElementById('fi-cat').value,description:document.getElementById('fi-desc').value,amount:Number(document.getElementById('fi-amt').value)||0};
    if(isEdit)data.id=item.id;
    await saveFixedItem(data); closeModal();
  });
}

export async function renderFixedItemsList(clientId){
  if(!clientId)return;
  await loadFixedItems(clientId);
  const el=document.getElementById('fixed-items-list'); if(!el)return;
  el.innerHTML='';
  if(!S.fixedItems.length){el.innerHTML='<div style="font-size:13px;color:var(--muted);padding:8px 0;">등록된 고정항목이 없습니다.</div>';return;}
  S.fixedItems.forEach(f=>{
    const acc=S.accounts.find(a=>a.id===f.accountId)?.label||'-';
    const div=document.createElement('div');
    div.style.cssText='display:flex;justify-content:space-between;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px 14px;';
    div.innerHTML='<div><div style="font-size:14px;font-weight:700;color:var(--text);">'+(f.description||'(이름없음)')+' <span style="font-size:12px;font-weight:400;color:var(--muted);">매월 '+(f.day||1)+'일</span></div><div style="font-size:12px;color:var(--muted);margin-top:2px;">'+acc+' · '+f.type+' · '+f.category+' · '+Number(f.amount||0).toLocaleString()+'원</div></div><div style="display:flex;gap:6px;"><button class="fi-edit-btn icon-btn" style="color:#64748b;">✏️</button><button class="fi-del-btn icon-btn" style="color:#94a3b8;">🗑️</button></div>';
    div.querySelector('.fi-edit-btn').addEventListener('click',()=>{S.activeClient=clientId;openModal('fixed-item',f);});
    div.querySelector('.fi-del-btn').addEventListener('click',()=>showConfirm('삭제','"'+f.description+'" 고정항목을 삭제하시겠습니까?',async()=>{await deleteFixedItem(f.id);renderFixedItemsList(clientId);}));
    el.appendChild(div);
  });
}

// ─────────────────────────────────────────────
// 통장 사진 다중 업로드
// ─────────────────────────────────────────────
export async function openBankStatementModal(accountId,yearParam,monthParam){
  if(!accountId){toast('계좌를 선택하세요.','error');return;}
  const acc=S.accounts.find(a=>a.id===accountId)||{label:'계좌'};
  const now=new Date(); const year=yearParam||now.getFullYear(); const month=monthParam||now.getMonth()+1;
  const mStr=String(year)+'-'+String(month).padStart(2,'0');
  document.getElementById('modal-wrap').classList.add('show');
  const body=document.getElementById('modal-body');
  const{getDoc,doc,updateDoc}=fb();
  const accRef=doc(fdb(),COLS.ACCOUNTS,accountId);
  const accSnap=await getDoc(accRef);
  const rawStmts=(accSnap.exists()?accSnap.data().bankStatements:[])||[];
  const existing=rawStmts.map(s=>typeof s==='string'?{url:s,month:''}:s);
  // C004: 연월 내림차순 정렬
  existing.sort((a,b)=>(b.month||'').localeCompare(a.month||''));
  // C005: 연월 필터 옵션 생성
  const months=[...new Set(existing.map(s=>s.month||'').filter(Boolean))].sort((a,b)=>b.localeCompare(a));
  const monthOpts='<option value="">전체</option>'+months.map(m=>'<option value="'+m+'">'+m+'</option>').join('');
  body.innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:6px;">🏦 통장 사진 관리</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:10px;">${acc.label} — 여러 장 업로드 가능</p>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
      <label class="label" style="margin:0;white-space:nowrap;">📅 업로드 연월:</label>
      <input type="month" id="bs-month" class="input" value="${mStr}" style="width:140px;padding:6px 10px;">
      <label class="label" style="margin:0;white-space:nowrap;">🔍 조회 필터:</label>
      <select id="bs-month-filter" class="input" style="width:130px;padding:6px 10px;">${monthOpts}</select>
    </div>
    <div id="bs-drop" style="border:2px dashed var(--bm);border-radius:12px;background:#f8fafc;padding:20px;text-align:center;cursor:pointer;margin-bottom:12px;">
      <input type="file" id="bs-file" accept="image/*,.pdf" multiple style="display:none;">
      <div style="font-size:24px;margin-bottom:6px;">📸</div>
      <div style="font-size:13px;font-weight:700;color:var(--sub);">클릭하거나 파일을 끌어다 놓으세요 (다중 선택 가능)</div>
      <div id="bs-status" style="font-size:12px;color:var(--blue);margin-top:6px;"></div>
    </div>
    <div id="bs-gallery" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px;"></div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">등록된 사진: <span id="bs-count">${existing.length}</span>장</div>`;
  const gallery=document.getElementById('bs-gallery');
  const renderGallery=(items)=>{
    // C004: 연월 내림차순 정렬 후 렌더링
    const sorted=[...items].sort((a,b)=>(b.month||'').localeCompare(a.month||''));
    // C005: 연월 필터 적용
    const filterVal=document.getElementById('bs-month-filter')?.value||'';
    const filtered=filterVal?sorted.filter(s=>s.month===filterVal):sorted;
    gallery.innerHTML='';
    filtered.forEach((item,i)=>{
      const url=typeof item==='string'?item:item.url;
      const mon=typeof item==='string'?'':item.month||'';
      const thumb=getImageUrl(url,'w200');
      const cell=document.createElement('div');
      cell.style.cssText='position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;';
      cell.innerHTML='<div style="font-size:10px;color:var(--muted);padding:3px 6px;background:var(--bg);text-align:center;">'+(mon||'날짜없음')+'</div><div style="aspect-ratio:3/4;"><img src="'+thumb+'" style="width:100%;height:100%;object-fit:cover;" onerror="this.src=\'\'"></div><button style="position:absolute;top:24px;right:4px;background:rgba(220,38,38,.85);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;" data-idx="'+i+'">✕</button>';
      const origIdx=existing.indexOf(item);
      cell.querySelector('button').addEventListener('click',async()=>{if(origIdx>-1)existing.splice(origIdx,1);await updateDoc(accRef,{bankStatements:[...existing]});document.getElementById('bs-count').textContent=existing.length;renderGallery(existing);});
      cell.querySelector('img').addEventListener('click',()=>openReceiptModal(url));
      gallery.appendChild(cell);
    });
  };
  document.getElementById('bs-month-filter')?.addEventListener('change',()=>renderGallery(existing));
  renderGallery([...existing]);
  const zone=document.getElementById('bs-drop'), fi=document.getElementById('bs-file');
  zone.addEventListener('click',()=>fi.click());
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.style.borderColor='var(--blue)';});
  zone.addEventListener('dragleave',()=>zone.style.borderColor='var(--bm)');
  zone.addEventListener('drop',e=>{e.preventDefault();zone.style.borderColor='var(--bm)';if(e.dataTransfer.files.length)uploadBankStatements(e.dataTransfer.files,accRef,existing,renderGallery);});
  fi.addEventListener('change',()=>{if(fi.files.length)uploadBankStatements(fi.files,accRef,existing,renderGallery);});
}
export async function renderBankStatementsList(accountId, targetEl){
  if(!accountId||!targetEl)return;
  const{getDoc,doc}=fb();
  const accSnap=await getDoc(doc(fdb(),COLS.ACCOUNTS,accountId));
  const rawStmts=(accSnap.exists()?accSnap.data().bankStatements:[])||[];
  const stmts=rawStmts.map(s=>typeof s==='string'?{url:s,month:''}:s)
    .sort((a,b)=>(b.month||'').localeCompare(a.month||''));
  targetEl.innerHTML='';
  if(!stmts.length){targetEl.innerHTML='<div style="font-size:13px;color:var(--muted);">등록된 통장사진이 없습니다.</div>';return;}
  stmts.forEach(item=>{
    const url=item.url||'';
    const mon=item.month||'';
    const thumb=getImageUrl(url,'w200');
    const cell=document.createElement('div');
    cell.style.cssText='display:inline-block;margin:4px;cursor:pointer;border:1px solid var(--border);border-radius:8px;overflow:hidden;width:100px;vertical-align:top;';
    cell.innerHTML='<div style="font-size:10px;color:var(--muted);padding:2px 4px;text-align:center;">'+(mon||'날짜없음')+'</div><img src="'+thumb+'" style="width:100%;height:130px;object-fit:cover;" onerror="this.src=\'\'">';
    cell.addEventListener('click',()=>openReceiptModal(url));
    targetEl.appendChild(cell);
  });
}
export async function uploadBankStatements(files,accRef,existing,renderGallery){
  const status=document.getElementById('bs-status');
  const total=files.length;
  const monthVal=document.getElementById('bs-month')?.value||'';
  for(let i=0;i<total;i++){
    if(status)status.textContent=`업로드 중... ${i+1}/${total}`;
    try{
      const url=await uploadToStorage(files[i],`bankbooks/${accRef.id}/${monthVal}_${Date.now()}_${files[i].name}`);
      existing.push({url,month:monthVal});
      const{updateDoc}=fb();
      await updateDoc(accRef,{bankStatements:[...existing]});
      document.getElementById('bs-count').textContent=existing.length;
      renderGallery([...existing]);
    }catch(e){toast(`${files[i].name} 업로드 실패: `+e.message,'error');}
  }
  if(status)status.textContent=`${total}장 업로드 완료!`;
  toast(`${total}장 업로드 완료!`,'success');
}

// ─────────────────────────────────────────────
// 입주자 폼
// ─────────────────────────────────────────────
export function renderClientForm(c){
  const isEdit=!!c, isAdmin=can('nav.staff');
  const teamLeaders=S.users.filter(u=>u.role==='팀장');
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'입주자 수정':'입주자 등록'}</h3>
    <input type="hidden" id="fc-id" value="${isEdit?c.id:'cli_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">성명</label><input type="text" id="fc-name" class="input" value="${isEdit?c.name:''}"></div>
      ${isAdmin?`<div><label class="label">담당 팀장</label><select id="fc-leader" class="input" style="padding:8px 12px;"><option value="">없음</option>${teamLeaders.map(u=>`<option value="${u.id}"${isEdit&&String(c.teamLeader)===String(u.id)?' selected':''}>${u.name}${u.team?' ('+u.team+')':''}</option>`).join('')}</select></div><div><label class="label">담당 직원</label><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;max-height:140px;overflow-y:auto;padding:4px;">${S.users.map(u=>{const ex=isEdit?String(c.userIds||'').split(',').map(s=>s.trim()):[];const ch=ex.includes(String(u.userId));return`<label style="display:flex;align-items:center;gap:7px;padding:7px 10px;background:${ch?'#eff6ff':'#f8fafc'};border:1px solid ${ch?'#bfdbfe':'var(--border)'};border-radius:8px;cursor:pointer;font-size:13px;"><input type="checkbox" name="fc-staff" value="${u.userId}" ${ch?'checked':''} style="accent-color:var(--blue);"> ${u.name}</label>`;}).join('')}</div></div>`:''}
      <div><label class="label">메모</label><textarea id="fc-memo" class="input" style="height:64px;resize:none;">${isEdit?c.memo||'':''}</textarea></div>
      <button id="fc-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
    </div>`;
  document.getElementById('fc-save').addEventListener('click',async()=>{
    const isAdm=can('nav.staff');
    const staffIds=isAdm?Array.from(document.querySelectorAll('input[name="fc-staff"]:checked')).map(c=>c.value).join(','):String(S.user.userId);
    const leaderId=isAdm?document.getElementById('fc-leader')?.value||'':'';
    const data={id:document.getElementById('fc-id').value,name:document.getElementById('fc-name').value,contact:isEdit?c.contact||'':'',memo:document.getElementById('fc-memo').value,userIds:staffIds,teamLeader:leaderId};
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.CLIENTS,data.id),data);
    toast('저장됨','success'); closeModal(); await refetchClients(); renderManagement();
  });
}

// ─────────────────────────────────────────────
// 계좌 폼
// ─────────────────────────────────────────────
export function renderAccountForm(a){
  const isEdit=!!a;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'계좌 수정':'계좌 등록'}</h3>
    <input type="hidden" id="fa-id" value="${isEdit?a.id:'acc_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">입주자</label><select id="fa-client" class="input" style="padding:8px 12px;"></select></div>
      <div><label class="label">계좌명 (별칭)</label><input type="text" id="fa-label" class="input" value="${isEdit?a.label||'':''}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label class="label">기초 잔액 기준일</label><input type="date" id="fa-init-date" class="input" value="${isEdit?a.initialBalanceDate||'':''}" placeholder="YYYY-MM-DD"></div>
        <div><label class="label">기초 잔액 (기준일 잔액)</label><input type="number" id="fa-init" class="input" value="${isEdit?a.initialBalance||0:0}" style="text-align:right;"></div>
      </div>
      <p style="font-size:11px;color:var(--muted);background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:8px 12px;">💡 기준일 이후의 거래내역을 기초 잔액에 합산하여 현재 잔액을 계산합니다.</p>
      <button id="fa-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
      ${isEdit?`<button id="fa-stmt-btn" class="btn-sub" style="width:100%;padding:9px;color:#0369a1;border-color:#bae6fd;margin-top:4px;">📸 통장 사진 관리 (${(a.bankStatements||[]).length}장)</button>`:''}
    </div>`;
  const sel=document.getElementById('fa-client');
  S.clients.forEach(c=>sel.add(new Option(c.name,c.id))); if(isEdit)sel.value=a.clientId;
  if(isEdit){const stmtBtn=document.getElementById('fa-stmt-btn');if(stmtBtn)stmtBtn.addEventListener('click',()=>{closeModal();openBankStatementModal(a.id);});}
  document.getElementById('fa-save').addEventListener('click',async()=>{
    const id=document.getElementById('fa-id').value, init=Number(document.getElementById('fa-init').value||0);
    const initDate=document.getElementById('fa-init-date')?.value||'';
    const data={clientId:document.getElementById('fa-client').value,label:document.getElementById('fa-label').value,accountNumber:isEdit?a.accountNumber||'':'',initialBalance:init,initialBalanceDate:initDate,currentBalance:init};
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.ACCOUNTS,id),data);
    await updateAccBalance(id);
    toast('저장됨','success'); closeModal(); await refetchAccounts(); renderManagement();
  });
}

// ─────────────────────────────────────────────
// 직원 폼
// ─────────────────────────────────────────────
export function renderStaffForm(u){
  const isEdit=!!u;
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">${isEdit?'직원 수정':'직원 등록'}</h3>
    <input type="hidden" id="fs-id" value="${isEdit?u.id:'usr_'+Date.now()}">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label class="label">이름</label><input type="text" id="fs-name" class="input" value="${isEdit?u.name||'':''}"></div>
      <div><label class="label">아이디</label><input type="text" id="fs-uid" class="input" value="${isEdit?u.userId||'':''}" ${isEdit?'readonly':''}></div>
      <div><label class="label">비밀번호</label><input type="password" id="fs-pw" class="input" placeholder="${isEdit?'변경 시만 입력':''}"></div>
      <div><label class="label">역할</label><select id="fs-role" class="input" style="padding:8px 12px;"><option value="입력자"${isEdit&&u.role==='입력자'?' selected':''}>입력자 (수기입력 전용)</option><option value="담당자"${isEdit&&u.role==='담당자'?' selected':''}>담당자</option><option value="팀장"${isEdit&&u.role==='팀장'?' selected':''}>팀장</option><option value="센터장"${isEdit&&u.role==='센터장'?' selected':''}>센터장</option><option value="관리자"${isEdit&&u.role==='관리자'?' selected':''}>관리자</option></select></div>
      <div><label class="label">팀</label><input type="text" id="fs-team" class="input" value="${isEdit?u.team||'':''}"></div>
      <button id="fs-save" class="btn" style="width:100%;padding:11px;">💾 저장 완료</button>
    </div>`;
  document.getElementById('fs-save').addEventListener('click',async()=>{
    const id=document.getElementById('fs-id').value;
    const pw=document.getElementById('fs-pw').value;
    const data={userId:document.getElementById('fs-uid').value,name:document.getElementById('fs-name').value,role:document.getElementById('fs-role').value,team:document.getElementById('fs-team').value};
    if(pw)data.password=pw;
    const{doc,setDoc}=fb();
    await setDoc(doc(fdb(),COLS.USERS,id),data);
    toast('저장됨','success'); closeModal(); await refetchUsers(); renderManagement();
  });
}

// ═══════════════════════════════════════════════
// 엑셀 일괄 등록 공통 헬퍼
// ═══════════════════════════════════════════════

/** SheetJS로 단일 시트 엑셀 양식 다운로드 */
function downloadBulkTemplate(headers, exampleRows, filename){
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.aoa_to_sheet([headers,...exampleRows]);
  // 헤더 행 너비 자동 조정
  ws['!cols']=headers.map(h=>({wch:Math.max(h.length*2,12)}));
  XLSX.utils.book_append_sheet(wb,ws,'데이터');
  XLSX.writeFile(wb,filename);
  toast('양식 다운로드 완료. 작성 후 업로드하세요.','success');
}

/** 엑셀 날짜 시리얼 → 'YYYY-MM-DD' 변환 */
function xlDateToStr(raw){
  if(typeof raw==='number'){
    const d=new Date(Math.round((raw-25569)*86400*1000));
    return d.toISOString().split('T')[0];
  }
  return String(raw||'').trim();
}

/** 파일을 파싱하여 행 배열 반환 (Promise) */
function parseXlFile(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        const wb=XLSX.read(e.target.result,{type:'array',cellDates:false});
        const ws=wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(ws,{header:1,defval:''}));
      }catch(err){reject(err);}
    };
    reader.onerror=()=>reject(new Error('파일 읽기 오류'));
    reader.readAsArrayBuffer(file);
  });
}

/** 미리보기 테이블 렌더링 */
function renderBulkTable(container,rows,cols){
  if(!rows.length){container.innerHTML='<div style="padding:16px;font-size:13px;color:var(--muted);text-align:center;">데이터 없음</div>';return;}
  const thead=cols.map(c=>`<th style="padding:6px 10px;font-size:11px;font-weight:700;color:var(--muted);text-align:left;white-space:nowrap;">${c.label}</th>`).join('');
  const tbody=rows.map(row=>{
    const hasErr=row._errors.length>0;
    const cells=cols.map(c=>`<td style="padding:6px 10px;font-size:12px;color:${hasErr?'#dc2626':'var(--text)'};">${c.mask?'••••':escAttr(String(row[c.key]||''))}</td>`).join('');
    const errCell=hasErr?`<td style="padding:6px 10px;font-size:11px;color:#dc2626;">${row._errors.join(', ')}</td>`:'<td></td>';
    return`<tr style="${hasErr?'background:#fef2f2;':''}border-top:1px solid var(--border);">${cells}${errCell}</tr>`;
  }).join('');
  container.innerHTML=`<table style="width:100%;border-collapse:collapse;"><thead style="background:#f8fafc;position:sticky;top:0;"><tr>${thead}<th style="padding:6px 10px;font-size:11px;font-weight:700;color:#dc2626;">오류</th></tr></thead><tbody>${tbody}</tbody></table>`;
}

/** 일괄 등록 모달 공통 외형 렌더링 */
function renderBulkModal(title,desc,templateBtn,previewId){
  document.getElementById('modal-body').innerHTML=`
    <h3 style="font-size:17px;font-weight:900;color:var(--text);margin-bottom:14px;">${title}</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;font-size:13px;color:#1e40af;">
        💡 ${desc}<br><button id="bulk-tpl-btn" class="btn-sub" style="margin-top:8px;font-size:12px;padding:5px 12px;color:#2563eb;border-color:#bfdbfe;">📥 양식 다운로드</button>
      </div>
      <div id="bulk-drop" style="border:2px dashed #cbd5e1;border-radius:12px;padding:28px;text-align:center;cursor:pointer;background:#f8fafc;">
        <input type="file" id="bulk-file" accept=".xlsx,.xls" style="display:none;">
        <div style="font-size:24px;margin-bottom:8px;">📊</div>
        <div style="font-size:13px;color:var(--text);font-weight:700;">클릭하거나 파일을 끌어다 놓으세요</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">xlsx · xls</div>
      </div>
      <div id="${previewId}" style="display:none;flex-direction:column;gap:10px;"></div>
    </div>`;
  // 드롭존 이벤트
  const drop=document.getElementById('bulk-drop');
  const fileInput=document.getElementById('bulk-file');
  drop.addEventListener('click',()=>fileInput.click());
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.style.background='#eff6ff';});
  drop.addEventListener('dragleave',()=>{drop.style.background='#f8fafc';});
  drop.addEventListener('drop',e=>{e.preventDefault();drop.style.background='#f8fafc';const f=e.dataTransfer.files[0];if(f){try{const dt=new DataTransfer();dt.items.add(f);fileInput.files=dt.files;}catch(_){}fileInput.dispatchEvent(new Event('change'));}});
  // 양식 다운로드
  document.getElementById('bulk-tpl-btn').addEventListener('click',templateBtn);
}

// ═══════════════════════════════════════════════
// 직원 일괄 등록
// ═══════════════════════════════════════════════
export function renderBulkStaffForm(){
  renderBulkModal(
    '👤 직원 일괄 등록',
    '양식을 다운로드하여 직원 정보를 작성한 후 업로드하세요.',
    ()=>downloadBulkTemplate(
      ['이름','아이디','비밀번호','역할','팀'],
      [['홍길동','hong','pass123','담당자','1팀'],['이순신','lee','pass456','입력자','2팀']],
      '직원_일괄등록_양식.xlsx'
    ),
    'bulk-staff-preview'
  );
  document.getElementById('bulk-file').addEventListener('change',async e=>{
    const f=e.target.files[0]; if(!f)return;
    try{
      const rows=await parseXlFile(f);
      const parsed=parseStaffRows(rows);
      renderBulkStaffPreview(parsed);
    }catch(err){toast('파일 파싱 오류: '+err.message,'error');}
  });
}

function parseStaffRows(rows){
  if(rows.length<2)return[];
  const h=rows[0].map(v=>String(v).trim());
  const idx={name:h.findIndex(v=>v.includes('이름')),userId:h.findIndex(v=>v.includes('아이디')),password:h.findIndex(v=>v.includes('비밀번호')||v.includes('패스워드')),role:h.findIndex(v=>v.includes('역할')),team:h.findIndex(v=>v.includes('팀'))};
  const validRoles=['담당자','팀장','센터장','관리자','입력자'];
  const existIds=new Set(S.users.map(u=>u.userId));
  const seenIds=new Set();
  return rows.slice(1).map((row,i)=>{
    const name=String(row[idx.name]||'').trim();
    const userId=String(row[idx.userId]||'').trim();
    const password=String(row[idx.password]||'').trim();
    const role=String(row[idx.role]||'').trim();
    const team=String(row[idx.team]||'').trim();
    const errs=[];
    if(!name)errs.push('이름 필수');
    if(!userId)errs.push('아이디 필수');
    else if(existIds.has(userId))errs.push('이미 존재하는 아이디');
    else if(seenIds.has(userId))errs.push('중복 아이디');
    if(userId)seenIds.add(userId);
    if(!password)errs.push('비밀번호 필수');
    if(!role)errs.push('역할 필수');
    else if(!validRoles.includes(role))errs.push(`역할 오류(${validRoles.join('/')})`);
    return{_row:i+2,name,userId,password,role,team,_errors:errs};
  }).filter(r=>r.name||r.userId);
}

function renderBulkStaffPreview(parsed){
  const pv=document.getElementById('bulk-staff-preview');
  pv.style.display='flex';
  const validCount=parsed.filter(r=>r._errors.length===0).length;
  const errCount=parsed.filter(r=>r._errors.length>0).length;
  pv.innerHTML=`
    <div style="font-size:13px;font-weight:700;color:var(--text);">미리보기 — 총 ${parsed.length}행 (유효 ${validCount}건 / 오류 ${errCount}건)</div>
    ${errCount?`<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:12px;color:#92400e;">⚠️ 오류 행은 저장에서 제외됩니다. 빨간 행을 확인하세요.</div>`:''}
    <div id="bulk-staff-table" style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>
    <button id="bulk-staff-save" class="btn" style="width:100%;padding:11px;" ${validCount===0?'disabled':''}>✅ ${validCount}명 일괄 저장</button>`;
  renderBulkTable(document.getElementById('bulk-staff-table'),parsed,[
    {key:'name',label:'이름'},{key:'userId',label:'아이디'},{key:'password',label:'비밀번호',mask:true},{key:'role',label:'역할'},{key:'team',label:'팀'},
  ]);
  document.getElementById('bulk-staff-save').addEventListener('click',()=>saveBulkStaff(parsed));
}

async function saveBulkStaff(parsed){
  const btn=document.getElementById('bulk-staff-save');
  btn.disabled=true; btn.textContent='저장 중...';
  try{
    const valid=parsed.filter(r=>r._errors.length===0);
    const adds=valid.map(s=>({col:COLS.USERS,data:{userId:s.userId,name:s.name,password:s.password,role:s.role,team:s.team||'',approved:true}}));
    await batchAddDocs(adds);
    toast(`직원 ${valid.length}명 등록 완료`,'success',4000);
    closeModal(); await refetchUsers(); renderManagement();
  }catch(e){toast('저장 오류: '+e.message,'error');btn.disabled=false;btn.textContent='✅ 일괄 저장';}
}

// ═══════════════════════════════════════════════
// 입주자 일괄 등록
// ═══════════════════════════════════════════════
export function renderBulkClientForm(){
  renderBulkModal(
    '🏠 입주자 일괄 등록',
    '양식을 다운로드하여 입주자 정보를 작성한 후 업로드하세요.',
    ()=>downloadBulkTemplate(
      ['이름','담당직원아이디','담당팀장아이디','메모'],
      [['김입주','hong,lee','leader1','특이사항 없음'],['이입주','hong','','']],
      '입주자_일괄등록_양식.xlsx'
    ),
    'bulk-client-preview'
  );
  document.getElementById('bulk-file').addEventListener('change',async e=>{
    const f=e.target.files[0]; if(!f)return;
    try{
      const rows=await parseXlFile(f);
      const parsed=parseClientRows(rows);
      renderBulkClientPreview(parsed);
    }catch(err){toast('파일 파싱 오류: '+err.message,'error');}
  });
}

function parseClientRows(rows){
  if(rows.length<2)return[];
  const h=rows[0].map(v=>String(v).trim());
  const idx={name:h.findIndex(v=>v.includes('이름')),userIds:h.findIndex(v=>v.includes('담당직원')),teamLeader:h.findIndex(v=>v.includes('팀장')),memo:h.findIndex(v=>v.includes('메모'))};
  const existNames=new Set((S.allClients||S.clients).map(c=>c.name));
  const seenNames=new Set();
  return rows.slice(1).map((row,i)=>{
    const name=String(row[idx.name]||'').trim();
    const userIds=String(row[idx.userIds]||'').trim();
    const teamLeader=String(row[idx.teamLeader]||'').trim();
    const memo=String(row[idx.memo]||'').trim();
    const errs=[];
    if(!name)errs.push('이름 필수');
    else if(existNames.has(name))errs.push('이미 존재하는 입주자');
    else if(seenNames.has(name))errs.push('중복 이름');
    if(name)seenNames.add(name);
    return{_row:i+2,name,userIds,teamLeader,memo,_errors:errs};
  }).filter(r=>r.name);
}

function renderBulkClientPreview(parsed){
  const pv=document.getElementById('bulk-client-preview');
  pv.style.display='flex';
  const validCount=parsed.filter(r=>r._errors.length===0).length;
  const errCount=parsed.filter(r=>r._errors.length>0).length;
  pv.innerHTML=`
    <div style="font-size:13px;font-weight:700;color:var(--text);">미리보기 — 총 ${parsed.length}행 (유효 ${validCount}건 / 오류 ${errCount}건)</div>
    ${errCount?`<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:12px;color:#92400e;">⚠️ 오류 행은 저장에서 제외됩니다.</div>`:''}
    <div id="bulk-client-table" style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>
    <button id="bulk-client-save" class="btn" style="width:100%;padding:11px;" ${validCount===0?'disabled':''}>✅ ${validCount}명 일괄 저장</button>`;
  renderBulkTable(document.getElementById('bulk-client-table'),parsed,[
    {key:'name',label:'이름'},{key:'userIds',label:'담당직원아이디'},{key:'teamLeader',label:'담당팀장아이디'},{key:'memo',label:'메모'},
  ]);
  document.getElementById('bulk-client-save').addEventListener('click',()=>saveBulkClients(parsed));
}

async function saveBulkClients(parsed){
  const btn=document.getElementById('bulk-client-save');
  btn.disabled=true; btn.textContent='저장 중...';
  try{
    const valid=parsed.filter(r=>r._errors.length===0);
    const adds=valid.map(c=>({col:COLS.CLIENTS,data:{name:c.name,userIds:c.userIds||'',teamLeader:c.teamLeader||'',memo:c.memo||'',contact:'',active:true}}));
    await batchAddDocs(adds);
    toast(`입주자 ${valid.length}명 등록 완료`,'success',4000);
    closeModal(); await refetchClients(); renderManagement();
  }catch(e){toast('저장 오류: '+e.message,'error');btn.disabled=false;btn.textContent='✅ 일괄 저장';}
}

// ═══════════════════════════════════════════════
// 계좌 일괄 등록
// ═══════════════════════════════════════════════
export function renderBulkAccountForm(){
  renderBulkModal(
    '🏦 계좌 일괄 등록',
    '입주자이름은 시스템에 등록된 이름과 정확히 일치해야 합니다.',
    ()=>downloadBulkTemplate(
      ['입주자이름','계좌명','초기잔액','기준일'],
      [['김입주','생활비통장','500000','2025-01-01'],['이입주','용돈계좌','200000','2025-01-01']],
      '계좌_일괄등록_양식.xlsx'
    ),
    'bulk-account-preview'
  );
  document.getElementById('bulk-file').addEventListener('change',async e=>{
    const f=e.target.files[0]; if(!f)return;
    try{
      const rows=await parseXlFile(f);
      const parsed=parseAccountRows(rows);
      renderBulkAccountPreview(parsed);
    }catch(err){toast('파일 파싱 오류: '+err.message,'error');}
  });
}

function parseAccountRows(rows){
  if(rows.length<2)return[];
  const h=rows[0].map(v=>String(v).trim());
  const idx={clientName:h.findIndex(v=>v.includes('입주자')),label:h.findIndex(v=>v.includes('계좌명')),balance:h.findIndex(v=>v.includes('잔액')),date:h.findIndex(v=>v.includes('기준일'))};
  const clientMap=Object.fromEntries((S.allClients||S.clients).map(c=>[c.name,c.id]));
  return rows.slice(1).map((row,i)=>{
    const clientName=String(row[idx.clientName]||'').trim();
    const label=String(row[idx.label]||'').trim();
    const balance=Number(String(row[idx.balance]||'0').replace(/,/g,''))||0;
    const date=xlDateToStr(row[idx.date]);
    const errs=[];
    if(!clientName)errs.push('입주자이름 필수');
    else if(!clientMap[clientName])errs.push('등록된 입주자 없음');
    if(!label)errs.push('계좌명 필수');
    if(!date)errs.push('기준일 필수');
    else if(!/^\d{4}-\d{2}-\d{2}$/.test(date))errs.push('기준일 형식 오류(YYYY-MM-DD)');
    return{_row:i+2,clientName,label,balance,date,clientId:clientMap[clientName]||'',_errors:errs};
  }).filter(r=>r.clientName||r.label);
}

function renderBulkAccountPreview(parsed){
  const pv=document.getElementById('bulk-account-preview');
  pv.style.display='flex';
  const validCount=parsed.filter(r=>r._errors.length===0).length;
  const errCount=parsed.filter(r=>r._errors.length>0).length;
  pv.innerHTML=`
    <div style="font-size:13px;font-weight:700;color:var(--text);">미리보기 — 총 ${parsed.length}행 (유효 ${validCount}건 / 오류 ${errCount}건)</div>
    ${errCount?`<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:12px;color:#92400e;">⚠️ 오류 행은 저장에서 제외됩니다.</div>`:''}
    <div id="bulk-account-table" style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>
    <button id="bulk-account-save" class="btn" style="width:100%;padding:11px;" ${validCount===0?'disabled':''}>✅ ${validCount}개 일괄 저장</button>`;
  renderBulkTable(document.getElementById('bulk-account-table'),parsed,[
    {key:'clientName',label:'입주자이름'},{key:'label',label:'계좌명'},{key:'balance',label:'초기잔액'},{key:'date',label:'기준일'},
  ]);
  document.getElementById('bulk-account-save').addEventListener('click',()=>saveBulkAccounts(parsed));
}

async function saveBulkAccounts(parsed){
  const btn=document.getElementById('bulk-account-save');
  btn.disabled=true; btn.textContent='저장 중...';
  try{
    const valid=parsed.filter(r=>r._errors.length===0&&r.clientId);
    const adds=valid.map(a=>({col:COLS.ACCOUNTS,data:{clientId:a.clientId,label:a.label,accountNumber:'',initialBalance:a.balance,initialBalanceDate:a.date,currentBalance:a.balance,active:true}}));
    await batchAddDocs(adds);
    toast(`계좌 ${valid.length}개 등록 완료`,'success',4000);
    closeModal(); await refetchAccounts(); renderManagement();
  }catch(e){toast('저장 오류: '+e.message,'error');btn.disabled=false;btn.textContent='✅ 일괄 저장';}
}
