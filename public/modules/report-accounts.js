/**
 * modules/report-accounts.js — 보고서 「계좌 현황」 한 줄씩
 *
 * report.js 에서 떼어 왔다. 화면(renderReportView)과 엑셀 저장이 **같은
 * 숫자**를 찍어야 하는데, 이 계산이 report.js 안에 사적으로 있으면 엑셀 쪽이
 * 그것을 가져다 쓰려고 report.js 를 되불러야 하고 그 순간 순환이 생긴다.
 * 여기 두면 화살표가 양쪽 모두 한 방향이다.
 *
 * 말잔은 계좌 문서의 월말 색인을 먼저 본다 — 서버 트리거가 잔액을 다시 만들
 * 때 함께 적어 둔 값이라 추가 읽기가 없다(CLAUDE.md §12-1).
 */

'use strict';

import { calcAccountBalanceAsOf, sumIncomeExpense, monthEndBalanceOf } from '../services/balance.js';

export function getReportAccountRows(year,month,accs,allTrx){
  const mStr=`${year}-${String(month).padStart(2,'0')}`;
  const endDate=mStr+'-31';
  const prevYM=month===1?`${year-1}-12`:`${year}-${String(month-1).padStart(2,'0')}`;
  const prevEnd=prevYM+'-31';
  return (accs||[]).map(a=>{
    // 잔액은 services/balance.js 하나만 쓴다 (대시보드·설정과 값이 어긋나지 않도록)
    // 말잔은 계좌 문서의 월말 색인에서 읽는다 — 서버 트리거가 잔액을 다시
    // 만들 때 함께 적어 둔 것이라 **추가 읽기가 없다.** 색인이 없거나
    // (백필 전) 구멍이 있으면 null 이 오고, 그때만 거래를 더해 계산한다.
    const prevBal=monthEndBalanceOf(a,prevYM)??calcAccountBalanceAsOf(a,allTrx,prevEnd);
    const bal=monthEndBalanceOf(a,mStr)??calcAccountBalanceAsOf(a,allTrx,endDate);
    // 당월 수입/지출 집계 — 자산이동·취소는 제외
    const monthTrx=(allTrx||[]).filter(t=>t.accountId===a.id&&(t.date||'').startsWith(mStr));
    const {totalIn:monthlyIn,totalOut:monthlyOut}=sumIncomeExpense(monthTrx);
    return {...a,prevBal,monthlyIn,monthlyOut,bal};
  });
}
