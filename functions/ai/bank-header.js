'use strict';

/**
 * 은행 파일의 **헤더 글자만** 모델에게 보여 주고 어느 열이 무엇인지 묻는다.
 *
 * 무엇을 보내지 않는가 — 이것이 이 파일의 존재 이유다
 *   거래 값은 한 줄도 보내지 않는다. 날짜도, 금액도, 상호명도, 계좌번호도.
 *   보내는 것은 ⑴ 헤더 칸에 인쇄된 글자와 ⑵ 그 열의 값이 **무슨 꼴인지**
 *   (날짜/숫자/글자)라는 한 단어뿐이다. 꼴은 이미 규칙이 셌고
 *   (services/bank-parser-guess.js), 값 자체가 아니라 값에 대한 통계다.
 *
 *   이 장부의 주인은 어디서 무엇을 샀는지가 그 사람의 하루를 그대로 드러내는
 *   기록을 가진 사람이고, 본인이 동의를 판단하기 어려운 자리에 있다. 열 이름을
 *   읽는 데 그 사람의 거래가 필요하지 않다.
 *
 * 왜 AI 가 필요한가 — 규칙이 이미 추천하는데
 *   규칙은 낱말 표(`출금`·`찾으신`…)에 기대는데, 은행마다 표기가 갈린다.
 *   표에 없는 낱말이면 규칙은 **자리로** 추측하고, 그것이 틀리면 출금과 입금이
 *   뒤집힌다. 모델은 처음 보는 표기도 뜻으로 읽는다.
 *
 *   그래도 **규칙이 먼저**다. 모델은 규칙이 못 채운 자리를 메우거나 바꿔
 *   제안할 뿐이고, 최종 결정은 사람이 화면에서 고른다. 실패하면 규칙 추천이
 *   그대로 남는다 — AI 는 더 나은 추천이지 없으면 안 되는 기능이 아니다.
 */

const { ANALYZE_MODEL, getGeminiClient } = require('./gemini');

/** 열 하나를 설명하는 꼴. 규칙이 센 것 말고 다른 것은 받지 않는다. */
const KINDS = new Set(['date', 'number', 'text', 'mixed', 'empty']);

/**
 * 모델에게 보낼 것을 만든다. **경계는 이 함수 하나다.**
 *
 * 넘겨받은 객체에 거래가 함께 들어 있어도 여기서 떨어져 나간다 —
 * test/bank-parser.test.mjs 가 "값이 새어 나가지 않는다"를 직접 확인한다.
 */
function buildHeaderFacts(input) {
  const src = (input && Array.isArray(input.columns)) ? input.columns : [];
  return {
    columns: src.slice(0, 40).map((c, i) => ({
      index: Number.isInteger(c && c.index) ? c.index : i,
      label: String((c && c.label) || '').trim().slice(0, 40),
      kind: KINDS.has(c && c.kind) ? c.kind : 'text',
    })),
  };
}

const COLUMN_SCHEMA = {
  type: 'object',
  properties: {
    date: { type: 'integer', description: '거래 날짜 열의 index. 없으면 -1.' },
    description: { type: 'integer', description: '적요·거래내용·가맹점명 열의 index. 없으면 -1.' },
    withdraw: { type: 'integer', description: '출금(지출) 금액 열의 index. 없으면 -1.' },
    deposit: { type: 'integer', description: '입금 금액 열의 index. 없으면 -1.' },
    amount: { type: 'integer', description: '출금·입금이 나뉘지 않은 단일 금액 열(카드 이용금액 등)의 index. 없으면 -1.' },
    balance: { type: 'integer', description: '잔액 열의 index. 없으면 -1.' },
    cancelFlag: { type: 'integer', description: '취소 여부 표시 열의 index. 없으면 -1.' },
    confidence: { type: 'number', description: '확신도 0~1' },
  },
  propertyOrdering: ['date', 'description', 'withdraw', 'deposit', 'amount', 'balance', 'cancelFlag', 'confidence'],
  required: ['date', 'description', 'withdraw', 'deposit', 'amount', 'balance', 'cancelFlag', 'confidence'],
};

const SYSTEM_PROMPT = [
  '당신은 한국 은행·카드사의 거래내역 파일 머리글을 읽고 각 열이 무엇인지 정합니다.',
  '',
  '규칙:',
  '- 주어진 열 목록 **밖의 것을 만들지 않습니다.** index 는 주어진 값 중 하나이거나 -1 입니다.',
  '- 같은 index 를 두 자리에 쓰지 않습니다.',
  '- 출금과 입금이 따로 있으면 withdraw · deposit 을 채우고 amount 는 -1 로 둡니다.',
  '- 금액 열이 하나뿐이면(카드 이용금액 등) amount 만 채웁니다.',
  '- 잔액(잔고)은 거래 금액이 아닙니다. balance 로만 답합니다.',
  '- 확실하지 않으면 -1 과 낮은 confidence 로 답합니다. 사람이 화면에서 고칩니다.',
].join('\n');

/**
 * @param {Object} input  { columns: [{index,label,kind}] }
 * @returns {Promise<{picks:Object, usage:Object}>}
 */
async function suggestColumns(input, deps = {}) {
  const facts = buildHeaderFacts(input);
  if (!facts.columns.length) throw new Error('ai-bank-header-empty');

  const client = deps.client || getGeminiClient();
  const model = deps.model || ANALYZE_MODEL;
  const response = await client.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [{
        text: '다음은 은행 거래내역 파일의 머리글입니다. 각 열이 무엇인지 정해 주세요.\n'
          + JSON.stringify(facts, null, 1),
      }],
    }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseSchema: COLUMN_SCHEMA,
    },
  });

  const text = typeof response.text === 'function' ? response.text() : String(response.text || '');
  let picks;
  try { picks = JSON.parse(String(text).trim()); } catch (cause) {
    const err = new Error('ai-analyze-invalid-output'); err.cause = cause; throw err;
  }
  return { picks, usage: response.usageMetadata };
}

module.exports = { buildHeaderFacts, suggestColumns, COLUMN_SCHEMA, SYSTEM_PROMPT };
