// public/domain/report-summary.js
//
// 보고서의 「자동 분석」 문장 — 규칙 기반. 순수 함수다.
//
// 왜 domain/ 인가
//   모델이 아니라 규칙이 쓴다. 규칙은 읽어서 검증할 수 있어야 하고, 이 문장은
//   결재 서류에 인쇄되어 나간다. DOM·Firestore를 모르게 두면 Node에서 그대로
//   시험할 수 있고, 숫자가 틀린 문장이 나가는 일을 테스트가 막는다.
//
// 전월 비교는 호출부가 넘긴다
//   예전에는 이 안에서 S.transactions 를 뒤졌는데, 그것은 기본이 **당월만**이라
//   전월 거래가 언제나 비어 있었다. 그래서 "전월 대비" 문장이 거의 나오지
//   않았다 — 변화가 없어서가 아니라 못 읽어서였다.

'use strict';

import { countsInTotals } from './trx-totals.js';

export function ruleBasedSummary(reportData) {
  const { year, month, trxList, summary } = reportData;
  const { totalOut, balance } = summary;
  const catStats = summary.catStats || {};
  const fmt = n => Number(n).toLocaleString();

  // 전월은 호출부가 넘긴다 — 이 파일은 Firestore도 전역 상태도 모른다.
  // 합계에서 빼는 기준은 집계와 같아야 한다(domain/trx-totals.js).
  const prevTrxList = (reportData.prevTrx || []).filter(countsInTotals);
  const prevOut   = prevTrxList.reduce((s,t)=>s+Number(t.amountOut||0),0);
  const prevCat   = {};
  prevTrxList.forEach(t=>{ if(t.type==='지출'){const k=t.category||'기타'; prevCat[k]=(prevCat[k]||0)+Number(t.amountOut||0);} });

  // 카테고리 순위
  const catKeys = Object.keys(catStats).sort((a,b)=>catStats[b].total-catStats[a].total);
  const top1    = catKeys[0], top2=catKeys[1], top3=catKeys[2];
  const top1Pct = totalOut>0?Math.round(catStats[top1]?.total/totalOut*100):0;

  // 문장 구성
  const lines = [];

  // ① 기본 요약
  if (totalOut > 0) {
    lines.push(`${year}년 ${month}월 총 지출은 ${fmt(totalOut)}원입니다.`);
  } else {
    lines.push(`${year}년 ${month}월 지출 내역이 없습니다.`);
  }

  // ② 주요 지출 카테고리
  if (top1) {
    let catSummary = `주요 지출 항목은 ${top1}(${fmt(catStats[top1].total)}원, ${top1Pct}%)`;
    if (top2) catSummary += `, ${top2}(${fmt(catStats[top2].total)}원)`;
    if (top3) catSummary += `, ${top3}(${fmt(catStats[top3].total)}원)`;
    catSummary += ' 순이었습니다.';
    lines.push(catSummary);
  }

  // ③ 전월 대비
  if (prevOut > 0 && totalOut > 0) {
    const diff = totalOut - prevOut;
    const pct  = Math.abs(Math.round(diff/prevOut*100));
    if (diff > 0)      lines.push(`전월 대비 지출이 ${fmt(diff)}원(${pct}%) 증가하였습니다.`);
    else if (diff < 0) lines.push(`전월 대비 지출이 ${fmt(Math.abs(diff))}원(${pct}%) 감소하였습니다.`);
    else               lines.push(`전월과 지출 규모가 동일합니다.`);

    // 카테고리별 전월 대비 특이사항
    const notable = catKeys.find(k => {
      const cur=catStats[k]?.total||0, prev=prevCat[k]||0;
      if (!prev) return cur>50000;
      return Math.abs(cur-prev)/prev > 0.3 && Math.abs(cur-prev) > 20000;
    });
    if (notable) {
      const cur=catStats[notable].total, prev=prevCat[notable]||0;
      const notablePct = prev>0?Math.abs(Math.round((cur-prev)/prev*100)):100;
      if (cur>prev) lines.push(`특히 ${notable} 항목이 전월 대비 ${notablePct}% 증가하였습니다.`);
      else          lines.push(`${notable} 항목은 전월 대비 ${notablePct}% 감소하였습니다.`);
    }
  }

  // ④ 잔액 상태
  if (balance >= 0) {
    lines.push(`이달 잔액은 ${fmt(balance)}원입니다.`);
  } else {
    lines.push(`이달 잔액이 ${fmt(Math.abs(balance))}원 부족합니다. 지출 관리가 필요합니다.`);
  }

  // ⑤ 확인필요 항목
  const uncat = catStats['확인필요']?.total||0;
  if (uncat > 0) {
    lines.push(`미분류(확인필요) 항목이 ${fmt(uncat)}원 있습니다. 카테고리 확인이 필요합니다.`);
  }

  // ⑥ 10만원 초과 단건 지출 상위 3건
  const bigTrx=(trxList||[])
    .filter(t=>countsInTotals(t)&&Number(t.amountOut||0)>=100000)
    .sort((a,b)=>Number(b.amountOut||0)-Number(a.amountOut||0))
    .slice(0,3);
  if(bigTrx.length){
    const items=bigTrx.map(t=>`${t.description||'(내용없음)'}(${fmt(t.amountOut)}원)`).join(', ');
    lines.push(`10만원 이상 단건 지출 상위 ${bigTrx.length}건: ${items}.`);
  }

  return lines.join(' ');
}
