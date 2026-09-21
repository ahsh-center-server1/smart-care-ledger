'use strict';

/**
 * 보고서 「자동 분석」 문장을 모델에게 쓰게 한다.
 *
 * 규칙 기반 문장(public/domain/report-summary.js)은 그대로 남는다. 키가 없거나
 * 호출이 실패하면 그쪽으로 떨어진다 — AI 는 **더 나은 문장**이지 없으면 안 되는
 * 기능이 아니다.
 *
 * ── 무엇을 보내지 않는가 ────────────────────────────────────
 *
 * 입주자 이름·거래 내용(상호명)·계좌번호를 **보내지 않는다.**
 *
 * 이 앱의 장부 주인은 발달장애인 거주시설의 입주자다. 어디서 무엇을 샀는지는
 * 그 사람의 하루가 그대로 드러나는 기록이고, 본인이 동의를 판단하기 어려운
 * 자리에 있다. 그런 기록을 문장 다듬기 편하자고 외부 API 로 보낼 이유는 없다.
 *
 * 그래서 보내는 것은 **집계뿐이다**: 분류별 금액, 전월·전전월 대비, 계좌 잔액
 * 합계, 건수, 증빙이 빠진 건수와 금액, 결제수단별 합계(고정 낱말 넷), 가장 큰
 * 지출 한 건의 금액, 거래가 있었던 날 수.
 *
 * 「더 구체적으로」는 상호명으로 가는 길이 아니었다. 결재자가 실제로 확인하려는
 * 것은 **증빙이 빠졌는가 · 잔액이 맞는가 · 이번 달만 튀는가** 셋이고, 셋 다
 * 집계로 답한다. 상호명이 있어야 쓸 수 있는 문장은 애초에 보고서에 쓸 문장이
 * 아니다("○○약국에서 3만원을 썼습니다"는 결재 문서에 들어갈 말이 아니다).
 *
 * buildReportFacts() 가 그 경계다. 화면이 보내는 값을 **통째로 펴서 넘기지
 * 않고** 필드를 하나씩 적어 숫자로 강제한다 — 펴서 넘기면 언젠가 화면 쪽에서
 * 필드가 하나 늘고, 그것이 상호명이어도 아무도 모른다. 순수 함수라 테스트가
 * "이름이 새어 나가지 않는다"를 직접 확인한다.
 */

const SYSTEM_PROMPT = [
  '당신은 사회복지시설의 금전관리 보고서를 검토하는 실무자입니다.',
  '주어진 집계 수치만 근거로 한국어 4~6문장의 간결한 분석을 씁니다.',
  '',
  '무엇을 쓰는가 — 결재자가 확인하려는 순서대로:',
  '1. 이번 달 수입·지출·차액을 한 문장으로 요약합니다.',
  '2. 전월·전전월과 견주어 눈에 띄는 변화가 있으면 어느 분류에서 났는지 적습니다.',
  '   세부품목이 주어졌으면 그 분류 안에서 무엇이 컸는지 한 가지만 덧붙입니다.',
  '3. 증빙이 빠진 지출이 있으면 건수와 금액을 적고 확인을 권합니다.',
  '4. 분류가 정해지지 않은 지출이 있으면 정리를 권합니다.',
  '5. 계좌 잔액이 전월 말에서 어떻게 움직였는지 적습니다.',
  '',
  '지켜야 할 것:',
  '- 주어진 숫자 외에는 아무것도 지어내지 않습니다. 모르는 것은 쓰지 않습니다.',
  '  (어디서 샀는지·언제 샀는지는 주어지지 않습니다 — 추측하지 마세요.',
  '   세부품목은 한 달치를 이름으로 합친 값이라 날짜도 가게도 붙일 수 없습니다.)',
  '- 해당 없는 항목은 그냥 건너뜁니다. "없습니다"를 나열하지 않습니다.',
  '- 금액은 원 단위로 쓰고 천 단위 쉼표를 넣습니다.',
  '- 사람을 평가하거나 훈계하지 않습니다("과소비", "절약이 필요합니다" 금지).',
  '  이 장부의 주인은 관리 대상이 아니라 자기 돈을 쓰는 사람입니다.',
  '  증빙·분류는 **담당자가 할 일**이지 입주자의 잘못이 아닙니다.',
  '- 머리말·꼬리말·목록 기호 없이 문장만 씁니다.',
].join('\n');

/** 모델에게 보낼 문장 길이 상한. 보고서 한 칸에 들어갈 분량이다. */
const MAX_OUTPUT_TOKENS = 500;

/** 분류는 상위 몇 개까지 보내는가. 전부 보내면 문장이 목록이 된다. */
const TOP_CATEGORIES = 6;

/**
 * 결제수단은 **고정 낱말 넷**뿐이다(public/domain/payment-method.js).
 * 자유 입력이 아니므로 이름이 새어 나갈 통로가 되지 않는다 — 그래도 화면이
 * 보내는 키를 그대로 믿지 않고 여기서 한 번 더 거른다. 경계는 이 파일이다.
 */
const PAYMENT_METHODS = ['카드', '계좌이체', '자동이체', '현금'];

/** 추이는 몇 달까지. 세 달이면 "이번 달만 튀는가"에 답할 수 있다. */
const TREND_MONTHS = 2;

/**
 * 세부품목은 상위 몇 개까지. 전부 보내면 문장이 장바구니 목록이 된다.
 *
 * ⚠️ **여기가 두 번째 관문이다.** 품목명은 결국 OCR 이 읽은 자유 텍스트라,
 * 저장 시점의 깎기(`functions/receipt-items.cjs`)를 통과한 것이라도 여기서
 * 다시 본다 — 그 깎기가 없던 시절에 저장된 거래가 남아 있고, 앞으로 규칙이
 * 느슨해질 수도 있다. 경계는 한 겹이면 언젠가 뚫린다.
 */
const TOP_ITEMS = 8;
const ITEM_NAME_MAX = 20;
const ITEM_DIGIT_RUN = /\d{4,}/;

const won = (n) => Math.round(Number(n) || 0);
const nat = (n) => Math.max(0, Math.trunc(Number(n) || 0));

/**
 * 모델에게 보낼 사실 묶음을 만든다. **이 함수가 개인정보 경계다.**
 *
 * 입력은 화면이 이미 계산해 둔 요약이다(서버가 다시 계산하면 거래를 전부
 * 읽어야 하고, 이 문장은 사람이 읽고 고치는 초안이라 그럴 값어치가 없다).
 *
 * @returns {{year:number, month:number, totalIn:number, totalOut:number,
 *            balance:number, count:number, categories:Array, previous:Object|null}}
 */
function buildReportFacts(payload) {
  const d = payload || {};
  const cats = Object.entries(d.catStats || {})
    .map(([name, v]) => ({ name: String(name), total: won(v && v.total) }))
    .filter(c => c.name && c.total !== 0)
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    .slice(0, TOP_CATEGORIES);

  const prevOut = won(d.prevTotalOut);
  const prevCats = d.prevCatStats || {};

  return {
    year: Number(d.year) || 0,
    month: Number(d.month) || 0,
    totalIn: won(d.totalIn),
    totalOut: won(d.totalOut),
    balance: won(d.balance),
    count: Number(d.count) || 0,
    // 「확인필요」는 따로 받지 않는다 — 이미 분류표 안에 있다.
    unclassified: won((d.catStats && d.catStats['확인필요'] || {}).total),
    categories: cats.map(c => ({
      분류: c.name,
      금액: c.total,
      전월: won(prevCats[c.name]),
    })),
    previous: prevOut || won(d.prevTotalIn)
      ? { totalIn: won(d.prevTotalIn), totalOut: prevOut }
      : null,

    // ── 아래는 「더 구체적으로」를 위해 늘린 것들. 전부 숫자다 ──
    //
    // 화면이 보내는 값을 **그대로 통과시키지 않는다.** 필드 이름을 하나씩
    // 적고 숫자로 강제한다. 통째로 펴서 보내면 언젠가 화면 쪽에서 필드가
    // 하나 늘고, 그것이 상호명이어도 아무도 모른다 — 경계가 경계이려면
    // 여기 적힌 것만 나가야 한다.
    receipts: {
      missingCount: nat(d.receiptMissingCount),
      missingAmount: won(d.receiptMissingAmount),
    },
    largestOut: won(d.largestOut),
    activeDays: nat(d.activeDays),
    methods: PAYMENT_METHODS
      .map(name => ({ name, total: won((d.methods || {})[name]) }))
      .filter(m => m.total > 0),
    accounts: d.accounts ? {
      count: nat(d.accounts.count),
      prevBalance: won(d.accounts.prevBalance),
      balance: won(d.accounts.balance),
    } : null,
    trend: (Array.isArray(d.trend) ? d.trend : [])
      .filter(t => t && /^\d{4}-\d{2}$/.test(String(t.ym)))
      .slice(-TREND_MONTHS)
      .map(t => ({ ym: String(t.ym), totalOut: won(t.totalOut) })),
    // 세부품목 — 「무엇이 늘었는가」에 답하는 유일한 근거. 이름으로 합쳐서
    // 오므로 어느 날 어느 가게에서 샀는지는 이미 사라져 있다.
    items: (Array.isArray(d.items) ? d.items : [])
      .map(it => ({
        name: String((it && it.name) || '').replace(/\s+/g, ' ').trim(),
        total: won(it && it.total),
        count: nat(it && it.count),
      }))
      .filter(it => it.name
        && it.total > 0
        && it.name.length <= ITEM_NAME_MAX
        && !ITEM_DIGIT_RUN.test(it.name))
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_ITEMS),
  };
}

/** 사실 묶음을 모델이 읽을 문장으로. JSON 그대로 주면 표를 그대로 옮겨 적는다. */
function factsToPrompt(f) {
  const lines = [
    `${f.year}년 ${f.month}월 집계입니다.`,
    `수입 합계 ${f.totalIn}원, 지출 합계 ${f.totalOut}원, 차액 ${f.balance}원, 거래 ${f.count}건.`,
  ];
  if (f.previous) {
    lines.push(`전월은 수입 ${f.previous.totalIn}원, 지출 ${f.previous.totalOut}원이었습니다.`);
  } else {
    lines.push('전월 자료는 없습니다. 전월 대비는 언급하지 마세요.');
  }
  if (f.unclassified > 0) {
    lines.push(`아직 분류가 정해지지 않은 지출이 ${f.unclassified}원 있습니다.`);
  }
  if (f.categories.length) {
    lines.push('분류별 지출(이번 달 / 전월):');
    for (const c of f.categories) {
      lines.push(`- ${c.분류}: ${c.금액}원 / ${c.전월}원`);
    }
  } else {
    lines.push('분류별 지출 내역이 없습니다.');
  }
  if (f.trend.length) {
    lines.push('그 앞 달들의 지출: ' + f.trend.map(t => `${t.ym} ${t.totalOut}원`).join(', '));
  }
  if (f.receipts.missingCount > 0) {
    lines.push(
      `증빙이 아직 붙지 않은 지출이 ${f.receipts.missingCount}건 `
      + `${f.receipts.missingAmount}원 있습니다(분실로 표시한 것은 제외).`,
    );
  } else {
    lines.push('증빙은 모두 붙어 있습니다.');
  }
  if (f.items.length) {
    lines.push('영수증에서 읽은 세부품목(이름으로 합친 것, 금액 큰 순):');
    for (const it of f.items) lines.push(`- ${it.name}: ${it.total}원 (${it.count}회)`);
  }
  if (f.largestOut > 0) lines.push(`가장 큰 지출 한 건은 ${f.largestOut}원입니다.`);
  if (f.activeDays > 0) lines.push(`거래가 있었던 날은 ${f.activeDays}일입니다.`);
  if (f.methods.length) {
    lines.push('결제수단별 지출: ' + f.methods.map(m => `${m.name} ${m.total}원`).join(', '));
  }
  if (f.accounts) {
    lines.push(
      `계좌 ${f.accounts.count}개 합계 잔액은 전월 말 ${f.accounts.prevBalance}원에서 `
      + `${f.accounts.balance}원이 되었습니다.`,
    );
  }
  lines.push('');
  lines.push('입주자 이름·상호명·주소·카드번호는 주어지지 않았습니다. 위 숫자만으로 쓰세요.');
  return lines.join('\n');
}

/**
 * 모델을 불러 문장을 받는다.
 *
 * @param {Object} deps.client   GoogleGenAI 인스턴스
 * @param {string} deps.model    모델 이름
 * @returns {Promise<{text:string, usage:Object}>}
 */
async function narrateReport(payload, deps) {
  const facts = buildReportFacts(payload);
  const client = deps.client;
  const response = await client.models.generateContent({
    model: deps.model,
    contents: [{ role: 'user', parts: [{ text: factsToPrompt(facts) }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // 보고서 문장이다. 같은 숫자에서 매번 다른 말이 나오면 결재자가 혼란스럽다.
      temperature: 0.2,
    },
  });
  const text = String(
    (response && response.text)
    || (response && response.candidates && response.candidates[0]
        && response.candidates[0].content && response.candidates[0].content.parts
        && response.candidates[0].content.parts.map(p => p.text || '').join(''))
    || '',
  ).trim();
  return { text, usage: (response && response.usageMetadata) || {} };
}

module.exports = {
  SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
  TOP_CATEGORIES,
  PAYMENT_METHODS,
  TREND_MONTHS,
  TOP_ITEMS,
  buildReportFacts,
  factsToPrompt,
  narrateReport,
};
