'use strict';

/**
 * 영수증·통장 사진에서 값을 뽑아낸다.
 *
 * 설계 원칙 — **모델은 읽기만 한다**
 *   · DB에 쓰지 않는다. 초안을 돌려주고 사람이 확인한 뒤 앱이 저장한다.
 *   · 날짜를 계산하지 않는다. 인쇄된 그대로 문자열로 돌려주고
 *     public/domain/receipt.js가 YYYY-MM-DD로 정규화한다
 *     (영수증에 연도가 없는 경우가 흔해서 모델이 추측하면 1년 틀린 거래가 된다).
 *   · 분류하지 않는다. 카테고리는 사용자가 관리하는 자동분류 규칙이 정한다.
 *   · 계산하지 않는다. 품목 합계를 스스로 더하지 말고 인쇄된 합계를 읽는다.
 *
 *   즉 모델의 역할은 「사진에 인쇄된 글자를 구조화해서 옮겨 적는 것」뿐이다.
 *   판단은 전부 코드에 있고, 그래서 재현되고 테스트된다.
 */

const {
  ANALYZE_MODEL, FALLBACK_MODEL, FALLBACK_BETA, ANALYZE_EFFORT,
  getAnthropicClient,
} = require('./anthropic');

/** 모델 호출에 허용하는 이미지 크기. 앱은 업로드 전에 1200px로 압축한다. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * 영수증 한 장 → 값 하나.
 *
 * strict: true 로 스키마를 강제한다 — 필드가 빠지거나 타입이 다르면
 * 우리 쪽 정규화가 조용히 이상한 값을 만든다.
 */
const RECEIPT_TOOL = {
  name: 'extract_receipt',
  description:
    '영수증 사진에 인쇄된 내용을 그대로 옮겨 적는다. 값을 계산하거나 추측하지 않는다.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      merchant: {
        type: 'string',
        description: '상호명(가맹점명). 인쇄된 그대로. 없으면 빈 문자열.',
      },
      dateRaw: {
        type: 'string',
        description:
          '거래 날짜를 **인쇄된 그대로**. 예: "2026-09-07", "26.09.07", '
          + '"2026년 9월 7일", "09/07". 연도가 없으면 없는 대로 둔다. '
          + '연도를 채워 넣지 말 것. 없으면 빈 문자열.',
      },
      totalAmount: {
        type: 'string',
        description:
          '결제 총액을 인쇄된 그대로(예: "12,000", "₩12,000"). 품목을 더해서 '
          + '만들지 말고 영수증에 인쇄된 합계를 읽는다. 없으면 빈 문자열.',
      },
      isCancellation: {
        type: 'boolean',
        description: '취소·환불 영수증이면 true (「승인취소」「환불」 표기).',
      },
      cardLast4: {
        type: 'string',
        description: '카드번호 끝 4자리. 없으면 빈 문자열.',
      },
      items: {
        type: 'array',
        description: '품목 목록. 읽히는 것만. 없으면 빈 배열.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            amount: { type: 'string', description: '인쇄된 그대로' },
          },
          required: ['name', 'amount'],
        },
      },
      confidence: {
        type: 'number',
        description:
          '판독 확신도 0~1. 사진이 흐리거나 잘렸거나 글자가 뭉개졌으면 낮게. '
          + '이 값이 낮으면 앱이 사람에게 확인을 요구한다.',
      },
    },
    required: [
      'merchant', 'dateRaw', 'totalAmount', 'isCancellation',
      'cardLast4', 'items', 'confidence',
    ],
  },
};

/** 통장(거래내역) 사진 → 여러 줄. */
const BANKBOOK_TOOL = {
  name: 'extract_bankbook',
  description:
    '통장 거래내역 사진의 각 줄을 그대로 옮겨 적는다. 값을 계산하지 않는다.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      rows: {
        type: 'array',
        description: '위에서 아래 순서로. 읽을 수 없는 줄은 넣지 않는다.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dateRaw: { type: 'string', description: '인쇄된 그대로. 연도를 채우지 말 것.' },
            description: { type: 'string', description: '적요·거래기록사항' },
            withdraw: { type: 'string', description: '출금액. 인쇄된 그대로. 없으면 빈 문자열.' },
            deposit: { type: 'string', description: '입금액. 인쇄된 그대로. 없으면 빈 문자열.' },
            balance: { type: 'string', description: '잔액. 인쇄된 그대로. 없으면 빈 문자열.' },
          },
          required: ['dateRaw', 'description', 'withdraw', 'deposit', 'balance'],
        },
      },
      confidence: { type: 'number', description: '판독 확신도 0~1' },
    },
    required: ['rows', 'confidence'],
  },
};

const SYSTEM_PROMPT = [
  '당신은 한국 사회복지시설의 금전관리 장부에 들어갈 영수증·통장 사진을 판독합니다.',
  '',
  '규칙:',
  '- 사진에 **인쇄된 것만** 옮겨 적습니다. 보이지 않는 값은 빈 문자열로 둡니다.',
  '- 날짜는 인쇄된 형태 그대로 둡니다. 연도가 없으면 채워 넣지 않습니다.',
  '- 금액은 인쇄된 합계를 읽습니다. 품목을 더해서 만들지 않습니다.',
  '- 분류(식비·교통비 등)를 판단하지 않습니다. 그것은 앱이 정합니다.',
  '- 흐릿하거나 잘려서 확실하지 않으면 confidence를 낮게 줍니다. 추측해서',
  '  채우는 것보다 낮은 확신도를 주는 것이 낫습니다 — 사람이 확인합니다.',
].join('\n');

/** tool_use 블록을 꺼낸다. 없으면 무엇이 왔는지 알 수 있게 오류에 담는다. */
function extractToolInput(response, toolName) {
  if (response.stop_reason === 'refusal') {
    const err = new Error('ai-analyze-refused');
    err.category = response.stop_details && response.stop_details.category;
    throw err;
  }
  const block = (response.content || []).find(
    (b) => b.type === 'tool_use' && b.name === toolName,
  );
  if (!block) {
    const kinds = (response.content || []).map((b) => b.type).join(',') || '(없음)';
    const err = new Error('ai-analyze-invalid-output');
    err.detail = `stop_reason=${response.stop_reason} content=[${kinds}]`;
    throw err;
  }
  return block.input;
}

/** 이미지 입력 검증. 모델 호출 전에 걸러 비용을 쓰지 않는다. */
function validateImage({ base64, mediaType }) {
  if (!base64 || typeof base64 !== 'string') throw new Error('image-missing');
  if (!ALLOWED_MEDIA.has(mediaType)) throw new Error('image-type-unsupported');
  // base64는 원본의 약 4/3 크기다.
  const approxBytes = Math.floor(base64.length * 3 / 4);
  if (approxBytes > MAX_IMAGE_BYTES) throw new Error('image-too-large');
  return approxBytes;
}

/** 공통 호출부. */
async function callWithTool({ base64, mediaType, tool, userText }) {
  const client = getAnthropicClient();

  const response = await client.beta.messages.create({
    model: ANALYZE_MODEL,
    max_tokens: 8000,
    // 정책상 거절 시 예비 모델이 같은 호출 안에서 이어받는다.
    betas: [FALLBACK_BETA],
    fallbacks: [{ model: FALLBACK_MODEL }],
    system: SYSTEM_PROMPT,
    output_config: { effort: ANALYZE_EFFORT },
    tools: [tool],
    // 반드시 이 도구로만 답하게 한다 — 자유 서술이 오면 파싱할 것이 없다.
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: userText },
      ],
    }],
  });

  return { input: extractToolInput(response, tool.name), usage: response.usage };
}

/**
 * 영수증 한 장을 판독한다.
 * @returns {{extracted:Object, usage:Object, bytes:number}}
 */
async function extractReceipt({ base64, mediaType }) {
  const bytes = validateImage({ base64, mediaType });
  const { input, usage } = await callWithTool({
    base64, mediaType, tool: RECEIPT_TOOL,
    userText: '이 영수증의 내용을 extract_receipt 도구로 옮겨 적어 주세요.',
  });
  return { extracted: input, usage, bytes };
}

/**
 * 통장 거래내역 사진을 판독한다.
 * @returns {{extracted:Object, usage:Object, bytes:number}}
 */
async function extractBankbook({ base64, mediaType }) {
  const bytes = validateImage({ base64, mediaType });
  const { input, usage } = await callWithTool({
    base64, mediaType, tool: BANKBOOK_TOOL,
    userText: '이 통장 거래내역의 각 줄을 extract_bankbook 도구로 옮겨 적어 주세요.',
  });
  return { extracted: input, usage, bytes };
}

module.exports = {
  RECEIPT_TOOL,
  BANKBOOK_TOOL,
  SYSTEM_PROMPT,
  MAX_IMAGE_BYTES,
  ALLOWED_MEDIA,
  validateImage,
  extractToolInput,
  extractReceipt,
  extractBankbook,
};
