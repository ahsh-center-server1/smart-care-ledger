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
 * 그래서 보내는 것은 **집계뿐이다**: 분류별 금액, 전월 대비, 잔액, 건수.
 * 보고서에 필요한 문장("의료비가 전월 대비 40% 늘었습니다")은 이것만으로
 * 나온다 — 상호명이 있어야 쓸 수 있는 문장은 애초에 보고서에 쓸 문장이 아니다.
 *
 * buildReportFacts() 가 그 경계다. 순수 함수라 테스트가 "이름이 새어 나가지
 * 않는다"를 직접 확인한다.
 */

const SYSTEM_PROMPT = [
  '당신은 사회복지시설의 금전관리 보고서를 검토하는 실무자입니다.',
  '주어진 집계 수치만 근거로 한국어 3~5문장의 간결한 분석을 씁니다.',
  '',
  '지켜야 할 것:',
  '- 주어진 숫자 외에는 아무것도 지어내지 않습니다. 모르는 것은 쓰지 않습니다.',
  '- 금액은 원 단위로 쓰고 천 단위 쉼표를 넣습니다.',
  '- 사람을 평가하거나 훈계하지 않습니다("과소비", "절약이 필요합니다" 금지).',
  '  이 장부의 주인은 관리 대상이 아니라 자기 돈을 쓰는 사람입니다.',
  '- 눈에 띄는 변화가 있으면 사실만 적고, 확인이 필요하면 확인을 권합니다.',
  '- 머리말·꼬리말·목록 기호 없이 문장만 씁니다.',
].join('\n');

/** 모델에게 보낼 문장 길이 상한. 보고서 한 칸에 들어갈 분량이다. */
const MAX_OUTPUT_TOKENS = 500;

/** 분류는 상위 몇 개까지 보내는가. 전부 보내면 문장이 목록이 된다. */
const TOP_CATEGORIES = 6;

const won = (n) => Math.round(Number(n) || 0);

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
  buildReportFacts,
  factsToPrompt,
  narrateReport,
};
