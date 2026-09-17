'use strict';

/**
 * 보고서의 「자동 분석」 칸 — 문장을 만들고, 지우고, 인쇄 영역까지 맞춘다.
 *
 * report.js 에서 떼어 냈다. 그 파일은 쪼갤 목록에 있고 줄 수 예산은 줄기만
 * 한다. **modules/ 를 import 하지 않는다** — report.js 가 이 파일을 부르므로,
 * 되부르면 순환에 끼어든다(architecture.test.mjs 가 잡는다).
 */

import { S } from '../state.js';
import { toast, setText } from '../utils/ui.js';
import { ruleBasedSummary, previousMonthFacts } from '../domain/report-summary.js';

/**
 * 전월 거래. **그 입주자의 전체 거래**(allTrx)에서 뽑는다 — 예전에는
 * S.transactions 를 봤는데 그것은 기본이 당월만이라, 전월 대비 문장이 거의
 * 언제나 빠졌다(없는 것이 아니라 못 읽은 것이었다).
 */
function prevMonthTrx(reportData) {
  const { clientId, year, month, allTrx } = reportData;
  let py = year, pm = month - 1;
  if (pm === 0) { pm = 12; py -= 1; }
  const prefix = py + '-' + String(pm).padStart(2, '0');
  return (allTrx || S.transactions)
    .filter(t => t.clientId === clientId && String(t.date || '').startsWith(prefix));
}

export function generateRuleBasedSummary(reportData) {
  return ruleBasedSummary({ ...reportData, prevTrx: prevMonthTrx(reportData) });
}

export { resetSummaryPanel };

/** 지금 열린 보고서를 가리키는 표. 늦게 온 응답이 남의 보고서에 앉지 않게 한다. */
function summaryKey(){
  const rd=S.reportData;
  return rd?`${rd.clientId}|${rd.year}|${rd.month}`:'';
}

/**
 * 분석 칸을 비운다. **보고서를 새로 그릴 때마다** 부른다.
 *
 * 예전에는 비우는 곳이 없어서, 다른 입주자를 열어도 앞사람의 분석 문장이
 * 그대로 남았다. 인쇄 영역까지 남으므로 **남의 분석이 찍힌 보고서**가 결재에
 * 올라갈 수 있었다.
 */
function resetSummaryPanel(){
  setText('rpt-summary-text','조회 후 생성 버튼을 클릭하세요.');
  const t=document.getElementById('rpt-summary-print-text'); if(t)t.textContent='';
  const a=document.getElementById('rpt-summary-print-area'); if(a)a.style.display='none';
}

function showSummary(text){
  setText('rpt-summary-text',text);
  const t=document.getElementById('rpt-summary-print-text'); if(t)t.textContent=text;
  const a=document.getElementById('rpt-summary-print-area');
  if(document.getElementById('rpt-summary-print')?.checked&&a)a.style.display='block';
}

/**
 * 분석 문장을 만든다 — 먼저 모델에게, 안 되면 규칙으로.
 *
 * 모델에게 보내는 것은 **집계뿐이다.** 입주자 이름도 상호명도 보내지 않는다
 * (functions/ai/report-narrative.js 머리말에 이유).
 *
 * 규칙 기반이 사라지지 않는 것이 요점이다. 키가 없든 한도를 다 썼든 망이
 * 끊겼든, 버튼을 누르면 언제나 문장이 나온다.
 */
export async function handleGenSummary(){
  if(!S.reportData){toast('먼저 조회하세요.','error');return;}
  const rd=S.reportData, mine=summaryKey();
  const btn=document.getElementById('btn-gen-summary');
  if(btn)btn.disabled=true;
  setText('rpt-summary-text','분석 중…');
  let text='';
  try{
    const res=await window._fbFn.call('analyzeReport')({
      clientId:rd.clientId, year:rd.year, month:rd.month,
      totalIn:rd.summary.totalIn, totalOut:rd.summary.totalOut, balance:rd.summary.balance,
      count:(rd.trxList||[]).length, catStats:rd.summary.catStats,
      ...previousMonthFacts(prevMonthTrx(rd)),
    });
    text=String(res?.data?.text||'');
  }catch(_){ /* 규칙 기반으로 떨어진다 */ }
  // 그 사이 다른 보고서를 열었으면 아무것도 쓰지 않는다.
  if(mine!==summaryKey()){ if(btn)btn.disabled=false; return; }
  const viaAi=!!text;
  if(!text)text=generateRuleBasedSummary(rd);
  showSummary(text);
  if(btn)btn.disabled=false;
  toast(viaAi?'AI 분석 완료':'분석 완료 (규칙 기반)','success',2000);
}
