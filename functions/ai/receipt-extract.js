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
  ANALYZE_MODEL,
  getGeminiClient,
} = require('./gemini');

/** 모델 호출에 허용하는 이미지 크기. 앱은 업로드 전에 1200px로 압축한다. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 판독할 수 있는 형식. **Storage 가 받는 형식의 부분집합이어야 한다**
 * (storage.rules 의 receiptTypeOk). 여기에만 있는 형식은 업로드될 수 없으므로
 * 영원히 죽은 항목이다 — 실제로 image/gif 가 그랬다.
 *   대조 테스트: test/receipt-extract.test.mjs
 */
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * 업로드는 되지만 모델에 그대로 넘길 수 없는 형식.
 *
 * 앱은 iPhone HEIC 를 업로드 전에 JPEG 로 바꾸지만, 변환은 CDN 에서 받아 오는
 * heic2any 에 달려 있고 **실패하면 원본을 그대로 올린다**(image.js). 그러면
 * 파일은 Storage 에 남고 판독만 실패한다. 그 경우 "JPG·PNG·WEBP 만 됩니다"는
 * 맞는 말이지만 아이폰 사용자에게는 무엇을 하라는 건지 알려 주지 못한다.
 */
const CONVERTIBLE_MEDIA = new Set(['image/heic', 'image/heif']);

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

function geminiSchemaFromTool(tool) {
  const strip = (schema) => {
    if (!schema || typeof schema !== 'object') return schema;
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'additionalProperties' || key === 'strict') continue;
      if (key === 'properties') {
        out.properties = Object.fromEntries(
          Object.entries(value || {}).map(([k, v]) => [k, strip(v)]),
        );
        out.propertyOrdering = Object.keys(value || {});
        continue;
      }
      if (key === 'items') {
        out.items = strip(value);
        continue;
      }
      out[key] = value;
    }
    return out;
  };
  return strip(tool.input_schema);
}

function geminiText(response) {
  if (typeof response.text === 'string') return response.text;
  if (typeof response.text === 'function') return response.text();
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('');
}

/** Gemini 구조화 출력 JSON을 꺼낸다. 없으면 무엇이 왔는지 알 수 있게 오류에 담는다. */
function extractToolInput(response, toolName) {
  const blockReason = response.promptFeedback && response.promptFeedback.blockReason;
  const finishReason = response.candidates?.[0]?.finishReason;
  if (blockReason || ['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION'].includes(finishReason)) {
    const err = new Error('ai-analyze-refused');
    err.category = blockReason || finishReason;
    throw err;
  }

  const text = geminiText(response).trim();
  if (!text) {
    const err = new Error('ai-analyze-invalid-output');
    err.detail = `tool=${toolName} finishReason=${finishReason || '(없음)'} text=(없음)`;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    const err = new Error('ai-analyze-invalid-output');
    err.detail = `tool=${toolName} finishReason=${finishReason || '(없음)'} text=${text.slice(0, 200)}`;
    err.cause = cause;
    throw err;
  }
}

/** 이미지 입력 검증. 모델 호출 전에 걸러 비용을 쓰지 않는다. */
function validateImage({ base64, mediaType }) {
  if (!base64 || typeof base64 !== 'string') throw new Error('image-missing');
  if (CONVERTIBLE_MEDIA.has(mediaType)) throw new Error('image-type-heic');
  if (!ALLOWED_MEDIA.has(mediaType)) throw new Error('image-type-unsupported');
  // base64는 원본의 약 4/3 크기다.
  const approxBytes = Math.floor(base64.length * 3 / 4);
  if (approxBytes > MAX_IMAGE_BYTES) throw new Error('image-too-large');
  return approxBytes;
}

/**
 * 공급자가 호출을 거절했을 때 우리 오류 이름으로 바꾼다.
 *
 * 여기서 걸러 내지 않으면 원래 오류가 그대로 올라가고, imageErrorToHttps 가
 * 모르는 오류이므로 callable 래퍼가 **맨 500**으로 만든다. 화면에는
 * 「Internal Server Error」만 뜨고 사용자는 무엇을 해야 할지 알 수 없다 —
 * 나머지 실패는 전부 "직접 입력할 수 있습니다"로 끝나는데 이 경로만 그랬다.
 * 키를 처음 넣은 날 실제로 그렇게 드러났다.
 *
 * 상태 코드만 보지 않는다. Gemini 는 잘못된 키를 400(INVALID_ARGUMENT)으로도
 * 돌려주므로 본문도 함께 본다.
 */
function providerError(cause) {
  const status = Number((cause && (cause.status ?? cause.code)) || 0);
  const text = String((cause && cause.message) || '');
  const named = (name) => {
    const err = new Error(name);
    err.cause = cause;
    return err;
  };

  if (status === 401 || status === 403
      || /API[_ ]?KEY[_ ]?INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) {
    return named('ai-key-rejected');
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text)) {
    return named('ai-quota-exceeded');
  }
  if (status >= 500 || /UNAVAILABLE|DEADLINE_EXCEEDED|fetch failed|ECONN|ETIMEDOUT/i.test(text)) {
    return named('ai-provider-unavailable');
  }
  return null;
}

/** 공통 호출부. */
async function callWithTool({ base64, mediaType, tool, userText }) {
  const client = getGeminiClient();

  let response;
  try {
    response = await client.models.generateContent({
      model: ANALYZE_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mediaType, data: base64 } },
          { text: userText },
        ],
      }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: geminiSchemaFromTool(tool),
      },
    });
  } catch (cause) {
    throw providerError(cause) || cause;
  }

  return { input: extractToolInput(response, tool.name), usage: response.usageMetadata };
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
  CONVERTIBLE_MEDIA,
  validateImage,
  geminiSchemaFromTool,
  extractToolInput,
  providerError,
  extractReceipt,
  extractBankbook,
};
