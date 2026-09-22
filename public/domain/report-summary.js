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
import { PAYMENT_METHODS } from './payment-method.js';

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

/**
 * 전월 집계 — 규칙 기반 문장과 AI 페이로드가 **같은 근거**를 쓴다.
 * 두 벌이 되면 화면의 두 문장이 서로 다른 전월을 말한다.
 */
export function previousMonthFacts(prevTrx) {
  const rows = (prevTrx || []).filter(countsInTotals);
  const prevCatStats = {};
  let prevTotalIn = 0, prevTotalOut = 0;
  for (const t of rows) {
    prevTotalIn += Number(t.amountIn || 0);
    prevTotalOut += Number(t.amountOut || 0);
    if (t.type === '지출') {
      const k = t.category || '기타';
      prevCatStats[k] = (prevCatStats[k] || 0) + Number(t.amountOut || 0);
    }
  }
  return { prevTotalIn, prevTotalOut, prevCatStats };
}

/**
 * 분석 문장을 **구체적으로** 만드는 집계들.
 *
 * 왜 더 보내나
 *   예전에 보내던 것은 수입·지출·차액·건수·분류별 금액뿐이었다. 그것으로
 *   나오는 문장은 "지출이 전월 대비 12% 늘었습니다" 수준에서 멈춘다 —
 *   결재자가 보고서를 보면서 이미 아는 말이다.
 *
 *   결재자가 실제로 확인하려는 것은 따로 있다: **증빙이 빠진 건이 있는가**,
 *   **잔액이 맞는가**, **이번 달만 튀는가**. 그 셋은 전부 집계로 답할 수 있다.
 *
 * 세부품목 이름은 보내지 않는다
 *   OCR 품목은 상호명·주소·지시문을 완전히 구별할 수 없는 자유 입력이다.
 *   거래 안에는 증빙 확인용으로 남기지만 외부 분석에는 관리된 분류와 숫자
 *   집계만 보낸다.
 *
 * 무엇을 보내지 않는가 — 경계는 그대로다
 *   상호명(`description`)·입주자 이름·계좌번호·계좌 이름은 여기 한 글자도
 *   들어가지 않는다. 결제수단은 자유 입력이 아니라 고정 낱말 넷 중 하나이고,
 *   분류 이름은 시설이 정한 목록이라 개인을 가리키지 않는다(전에도 보냈다).
 *   자세한 이유는 functions/ai/report-narrative.js 머리말에 있다.
 *
 * @param {Object} rd  S.reportData (trxList · allTrx · accountRows)
 * @param {(t:Object)=>boolean} hasReceipt  증빙 판정 (services/receipt-access.js)
 */
export function extraReportFacts(rd, hasReceipt) {
  const d = rd || {};
  const counted = (d.trxList || []).filter(countsInTotals);

  // ── 증빙이 빠진 지출 ──
  // 「분실」로 표시한 것은 뺀다. 그것은 담당자가 이미 답한 것이라 결재자가
  // 다시 물을 자리가 아니다 — 여기 넣으면 문장이 매달 같은 말을 한다.
  let receiptMissingCount = 0, receiptMissingAmount = 0;
  for (const t of counted) {
    if (!Number(t.amountOut || 0)) continue;
    if (hasReceipt(t) || t.receiptMissing) continue;
    receiptMissingCount += 1;
    receiptMissingAmount += Number(t.amountOut || 0);
  }

  // ── 가장 큰 지출 한 건 (금액만) ──
  const largestOut = counted.reduce((m, t) => Math.max(m, Number(t.amountOut || 0)), 0);

  // ── 결제수단 구성 (고정 낱말) ──
  const methods = {};
  for (const t of counted) {
    const out = Number(t.amountOut || 0);
    if (!out) continue;
    // **고정 낱말 넷만** 센다. 구형 데이터에 다른 글자가 들어 있을 수 있고,
    // 그것을 그대로 담으면 자유 입력 문자열이 호출에 실려 나간다. 서버도
    // 한 번 더 거르지만(ai/report-narrative.js), 경계는 두 겹이 싸다.
    const m = String(t.method || '');
    if (!PAYMENT_METHODS.includes(m)) continue;
    methods[m] = (methods[m] || 0) + out;
  }

  // ── 계좌 잔액 합계 (계좌 이름·번호는 보내지 않는다) ──
  const rows = d.accountRows || [];
  const accounts = rows.length ? {
    count: rows.length,
    prevBalance: rows.reduce((s, a) => s + Number(a.prevBal || 0), 0),
    balance: rows.reduce((s, a) => s + Number(a.bal || 0), 0),
  } : null;

  // ── 최근 지출 추이 — 이번 달이 유독 튀는지 보려면 한 달 전으로는 모자라다 ──
  const trend = [];
  for (let back = 2; back >= 1; back--) {
    let y = Number(d.year) || 0, m = (Number(d.month) || 0) - back;
    while (m <= 0) { m += 12; y -= 1; }
    const prefix = `${y}-${String(m).padStart(2, '0')}`;
    const rowsOfMonth = (d.allTrx || [])
      .filter(t => String(t.date || '').startsWith(prefix))
      .filter(countsInTotals);
    if (!rowsOfMonth.length) continue;
    trend.push({
      ym: prefix,
      totalOut: rowsOfMonth.reduce((s, t) => s + Number(t.amountOut || 0), 0),
    });
  }

  return {
    receiptMissingCount, receiptMissingAmount,
    largestOut, methods, accounts,
    trend,
    // 며칠에 걸쳐 쓰였는가 — 하루에 몰린 달은 사람이 한 번 더 본다.
    activeDays: new Set(counted.map(t => String(t.date || '')).filter(Boolean)).size,
  };
}
