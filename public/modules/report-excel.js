/**
 * modules/report-excel.js — 보고서 엑셀 저장
 *
 * report.js 에서 떼어 왔다. test/architecture.test.mjs 가 그 파일을 "기능을
 * 더할 곳이 아니라 쪼갤 곳"이라고 적어 두었고, 주석이 지목한 갈래
 * (view / approval / excel / annual) 중 excel 쪽이다.
 *
 * 왜 이 조각이 안전한가 — 순환이 생기지 않는다
 *   여기서 보는 것은 S · 토스트 · domain/ · report-accounts.js 뿐이다.
 *   report.js 를 되부르지 않으므로 화살표가 한 방향이다.
 */

'use strict';

import { S } from '../state.js';
import { toast } from '../utils/ui.js';
import { countsInTotals } from '../domain/trx-totals.js';
import { reportStaffName } from '../domain/report-stamps.js';
import { getReportAccountRows } from './report-accounts.js';

export async function exportReportExcel(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const{clientId,year,month,trxList,accs,accountRows,report,summary}=S.reportData;
  const client=S.clients.find(c=>c.id===clientId)||{name:'-'};
  const XLSX=window.XLSX;
  if(!XLSX){toast('엑셀 라이브러리가 없습니다.','error');return;}

  // ── 스타일 헬퍼 ──
  const border={top:{style:'thin',color:{rgb:'E5E7EB'}},bottom:{style:'thin',color:{rgb:'E5E7EB'}},left:{style:'thin',color:{rgb:'E5E7EB'}},right:{style:'thin',color:{rgb:'E5E7EB'}}};
  const sTitle={font:{name:'맑은 고딕',sz:18,bold:true,color:{rgb:'111827'}},alignment:{horizontal:'left',vertical:'center'}};
  const sBrand={font:{name:'맑은 고딕',sz:9,bold:true,color:{rgb:'9CA3AF'}},alignment:{horizontal:'left',vertical:'center'}};
  const sPeriod={font:{name:'맑은 고딕',sz:11,color:{rgb:'6B7280'}},alignment:{horizontal:'left',vertical:'center'}};
  const sMetaLabel={font:{name:'맑은 고딕',sz:9,bold:true,color:{rgb:'9CA3AF'}},alignment:{horizontal:'left',vertical:'center'},fill:{fgColor:{rgb:'F9FAFB'}}};
  const sMetaValue={font:{name:'맑은 고딕',sz:12,bold:true,color:{rgb:'111827'}},alignment:{horizontal:'left',vertical:'center'},fill:{fgColor:{rgb:'F9FAFB'}}};
  const sSectionLabel={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'9CA3AF'}},alignment:{horizontal:'left',vertical:'center'}};
  const sSumIncLbl={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'16A34A'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'F0FDF4'}},border};
  const sSumIncVal={font:{name:'맑은 고딕',sz:14,bold:true,color:{rgb:'15803D'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'F0FDF4'}},border,numFmt:'#,##0"원"'};
  const sSumOutLbl={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'DC2626'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'FFF1F2'}},border};
  const sSumOutVal={font:{name:'맑은 고딕',sz:14,bold:true,color:{rgb:'B91C1C'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'FFF1F2'}},border,numFmt:'#,##0"원"'};
  const sSumBalLbl={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'2563EB'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'EFF6FF'}},border};
  const sSumBalVal={font:{name:'맑은 고딕',sz:14,bold:true,color:{rgb:'1D4ED8'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'EFF6FF'}},border,numFmt:'#,##0"원"'};
  const sThead={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'6B7280'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'F9FAFB'}},border};
  const sTd={font:{name:'맑은 고딕',sz:10,color:{rgb:'374151'}},alignment:{horizontal:'left',vertical:'center'},border};
  const sTdCtr={...sTd,alignment:{horizontal:'center',vertical:'center'}};
  const sTdNum={...sTd,alignment:{horizontal:'right',vertical:'center'},numFmt:'#,##0"원"'};
  const sTdNumIn={...sTdNum,font:{name:'맑은 고딕',sz:10,color:{rgb:'15803D'}}};
  const sTdNumOut={...sTdNum,font:{name:'맑은 고딕',sz:10,color:{rgb:'B91C1C'}}};
  const sTdPct={...sTd,alignment:{horizontal:'right',vertical:'center'},numFmt:'0"%"'};
  const sFootLbl={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'374151'}},alignment:{horizontal:'center',vertical:'center'},fill:{fgColor:{rgb:'F3F4F6'}},border};
  const sFootIn={...sTdNumIn,font:{name:'맑은 고딕',sz:11,bold:true,color:{rgb:'15803D'}},fill:{fgColor:{rgb:'F3F4F6'}}};
  const sFootOut={...sTdNumOut,font:{name:'맑은 고딕',sz:11,bold:true,color:{rgb:'B91C1C'}},fill:{fgColor:{rgb:'F3F4F6'}}};
  const sCmtLabel={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'9CA3AF'}},alignment:{horizontal:'left',vertical:'top'},fill:{fgColor:{rgb:'F9FAFB'}},border};
  const sCmtValue={font:{name:'맑은 고딕',sz:11,color:{rgb:'111827'}},alignment:{horizontal:'left',vertical:'top',wrapText:true},border};

  const ws={};
  const merges=[];
  const rows=[];
  let r=0;
  const setRow=(h)=>{rows[r]={hpt:h};};
  const set=(c,addr,style,val,fmt)=>{ws[addr]={t:typeof val==='number'?'n':'s',v:val,s:style};if(fmt)ws[addr].z=fmt;};
  const cell=(col,row)=>XLSX.utils.encode_cell({c:col,r:row});
  // 병합 범위 전체에 스타일을 채워 테두리가 끊기지 않도록 함
  // 값은 첫 셀에만, 나머지는 빈 문자열 + 동일 스타일
  const mergeCell=(c1,c2,row,style,val,fmt)=>{
    for(let cc=c1;cc<=c2;cc++){
      const addr=cell(cc,row);
      if(cc===c1){set(null,addr,style,val,fmt);}
      else {ws[addr]={t:'s',v:'',s:style};}
    }
    if(c2>c1)merges.push({s:{c:c1,r:row},e:{c:c2,r:row}});
  };
  const COLS_N=8; // 컬럼 0~7 (A~H)

  // ── 1. 타이틀 블록 ──
  mergeCell(0,COLS_N-1,r,sBrand,'CARE LEDGER');         setRow(20); r++;
  mergeCell(0,COLS_N-1,r,sTitle,'월별 금전관리 보고서');  setRow(30); r++;
  mergeCell(0,COLS_N-1,r,sPeriod,year+'년 '+month+'월 거래 내역'); setRow(20); r++;
  r++; // 공백 행

  // ── 2. 메타데이터 (입주자/기간/담당자) ──
  mergeCell(0,1,r,sMetaLabel,'입주자');
  mergeCell(2,3,r,sMetaLabel,'기간');
  mergeCell(4,COLS_N-1,r,sMetaLabel,'담당자');
  setRow(18); r++;
  mergeCell(0,1,r,sMetaValue,client.name);
  mergeCell(2,3,r,sMetaValue,year+'년 '+month+'월');
  mergeCell(4,COLS_N-1,r,sMetaValue,reportStaffName(report));
  setRow(22); r++;
  r++;

  // ── 3. 수입/지출/잔액 요약 ──
  mergeCell(0,COLS_N-1,r,sSectionLabel,'수입 / 지출 요약'); setRow(18); r++;
  // 라벨 행
  mergeCell(0,1,r,sSumIncLbl,'총 수입');
  mergeCell(2,4,r,sSumOutLbl,'총 지출');
  mergeCell(5,COLS_N-1,r,sSumBalLbl,'잔액');
  setRow(18); r++;
  // 값 행
  mergeCell(0,1,r,sSumIncVal,Number(summary.totalIn||0));
  mergeCell(2,4,r,sSumOutVal,Number(summary.totalOut||0));
  mergeCell(5,COLS_N-1,r,sSumBalVal,Number(summary.balance||0));
  setRow(28); r++;
  r++;

  // ── 4. 계좌 현황 ──
  mergeCell(0,COLS_N-1,r,sSectionLabel,'계좌 현황'); setRow(18); r++;
  mergeCell(0,2,r,sThead,'계좌');
  mergeCell(3,3,r,sThead,'전월 잔액');
  mergeCell(4,4,r,sThead,'수입');
  mergeCell(5,5,r,sThead,'지출');
  mergeCell(6,COLS_N-1,r,sThead,'현재 잔액');
  setRow(20); r++;
  (accountRows||getReportAccountRows(year,month,accs,S.reportData.allTrx)).forEach(a=>{
    mergeCell(0,2,r,sTd,a.label||'-');
    mergeCell(3,3,r,sTdNum,Number(a.prevBal||0));
    mergeCell(4,4,r,sTdNumIn,Number(a.monthlyIn||0));
    mergeCell(5,5,r,sTdNumOut,Number(a.monthlyOut||0));
    mergeCell(6,COLS_N-1,r,{...sTdNum,font:{name:'맑은 고딕',sz:11,bold:true,color:{rgb:Number(a.bal||0)>=0?'111827':'DC2626'}}},Number(a.bal||0));
    setRow(20); r++;
  });
  r++;

  // ── 5. 분류별 지출 ──
  const catKeys=Object.keys(summary.catStats||{});
  if(catKeys.length){
    mergeCell(0,COLS_N-1,r,sSectionLabel,'분류별 지출'); setRow(18); r++;
    mergeCell(0,3,r,sThead,'분류');
    mergeCell(4,6,r,sThead,'금액');
    mergeCell(7,7,r,sThead,'비율');
    setRow(20); r++;
    const sortedCatKeys=[...catKeys].sort((a,b)=>(summary.catStats[b]?.total||0)-(summary.catStats[a]?.total||0));
    sortedCatKeys.forEach(k=>{
      const v=summary.catStats[k];
      const pct=summary.totalOut>0?Math.round(v.total/summary.totalOut*100):0;
      mergeCell(0,3,r,sTd,k);
      mergeCell(4,6,r,sTdNumOut,Number(v.total||0));
      mergeCell(7,7,r,sTdPct,pct);
      setRow(20); r++;
    });
    r++;
  }

  // ── 6. 거래 내역 ──
  mergeCell(0,COLS_N-1,r,sSectionLabel,'거래 내역'); setRow(18); r++;
  mergeCell(0,1,r,sThead,'날짜');
  mergeCell(2,2,r,sThead,'분류');
  mergeCell(3,5,r,sThead,'내용');
  mergeCell(6,6,r,sThead,'수입');
  mergeCell(7,7,r,sThead,'지출');
  setRow(22); r++;
  const excelByAccount=new Map();
  (accs||[]).forEach(a=>excelByAccount.set(a.id,{account:a,items:[]}));  
  (trxList||[]).forEach(t=>{
    if(!excelByAccount.has(t.accountId))excelByAccount.set(t.accountId,{account:S.accounts.find(a=>a.id===t.accountId)||{label:'미지정 계좌'},items:[]});
    excelByAccount.get(t.accountId).items.push(t);
  });
  excelByAccount.forEach(group=>{
    if(!group.items.length)return;
    const subIn=group.items.reduce((sum,t)=>countsInTotals(t)?sum+Number(t.amountIn||0):sum,0);
    const subOut=group.items.reduce((sum,t)=>countsInTotals(t)?sum+Number(t.amountOut||0):sum,0);
    mergeCell(0,COLS_N-1,r,{...sThead,alignment:{horizontal:'left',vertical:'center'}},`🏦 ${group.account.label||'미지정 계좌'} (${group.items.length}건 · 수입 ${subIn.toLocaleString()}원 · 지출 ${subOut.toLocaleString()}원)`);
    setRow(20); r++;
    group.items.forEach(t=>{    
    mergeCell(0,1,r,sTdCtr,t.date||'');
    mergeCell(2,2,r,sTdCtr,t.category||'');
    let descTxt=t.description||'';
    if(t.type==='자산이동'){
      const srcId=Number(t.amountOut||0)>0?t.accountId:t.linkedAccountId;
      const dstId=Number(t.amountOut||0)>0?t.linkedAccountId:t.accountId;
      const src=S.accounts.find(a=>a.id===srcId)?.label||'?';
      const dst=S.accounts.find(a=>a.id===dstId)?.label||'?';
      descTxt=(descTxt?descTxt+' ':'')+'[↕이동 '+src+' → '+dst+']';
    } else if(t.type==='취소'){
      const sub=Number(t.amountIn||0)>0?'수입':'지출';
      descTxt=(descTxt?descTxt+' ':'')+'[취소('+sub+')]';
    }
    mergeCell(3,5,r,sTd,descTxt);
    const amtIn=Number(t.amountIn||0);
    const amtOut=Number(t.amountOut||0);
    mergeCell(6,6,r,amtIn>0?sTdNumIn:sTd,amtIn>0?amtIn:'');
    mergeCell(7,7,r,amtOut>0?sTdNumOut:sTd,amtOut>0?amtOut:'');
    setRow(18); r++;
    });      
  });
  // 거래내역 합계 행
  mergeCell(0,5,r,sFootLbl,'합계');
  mergeCell(6,6,r,sFootIn,Number(summary.totalIn||0));
  mergeCell(7,7,r,sFootOut,Number(summary.totalOut||0));
  setRow(22); r++;
  r++;

  // ── 7. 의견 (있을 때만) ──
  const cmts=[
    {label:'담당자 의견',value:report?.staffComment||''},
    {label:'팀장 의견',value:report?.leaderComment||''},
    {label:'센터장 의견',value:report?.centerComment||''}
  ].filter(c=>c.value);
  if(cmts.length){
    mergeCell(0,COLS_N-1,r,sSectionLabel,'의견'); setRow(18); r++;
    cmts.forEach(c=>{
      mergeCell(0,1,r,sCmtLabel,c.label);
      mergeCell(2,COLS_N-1,r,sCmtValue,c.value);
      setRow(48); r++;
    });
  }

  // ── 워크시트 설정 ──
  ws['!ref']=XLSX.utils.encode_range({s:{c:0,r:0},e:{c:COLS_N-1,r:r-1}});
  ws['!merges']=merges;
  ws['!cols']=[{wch:12},{wch:8},{wch:12},{wch:18},{wch:10},{wch:10},{wch:14},{wch:14}];
  ws['!rows']=rows;
  // 인쇄 옵션
  ws['!pageSetup']={orientation:'portrait',paperSize:9,fitToWidth:1,fitToHeight:0};
  ws['!margins']={left:0.4,right:0.4,top:0.5,bottom:0.5,header:0.3,footer:0.3};

  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,year+'년'+month+'월');
  XLSX.writeFile(wb,client.name+'_'+year+'년'+month+'월_금전관리.xlsx');
  toast('엑셀 저장 완료','success');
}
