// test/receipt-extract.test.mjs
//
// 서버측 판독 계약 — **API를 호출하지 않는다.**
//
// 검증하는 것은 요청을 만들기 전에 지켜야 하는 규칙들이다:
//   · 도구 스키마가 strict 요건을 만족하는가 (아니면 런타임 400)
//   · 모델에게 날짜 계산·분류를 시키지 않는다는 계약이 프롬프트에 남아 있는가
//   · 이미지 검증이 비용을 쓰기 전에 걸러내는가
//   · 응답에서 tool_use를 못 찾았을 때 무엇이 왔는지 알 수 있는가
//
// 실제 호출은 유료이므로 테스트에서 하지 않는다. 대신 응답 파싱만 가짜
// 응답으로 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  RECEIPT_TOOL, BANKBOOK_TOOL, SYSTEM_PROMPT, MAX_IMAGE_BYTES,
  validateImage, geminiSchemaFromTool, extractToolInput,
} = require('../functions/ai/receipt-extract.js');
const ai = require('../functions/ai/gemini.js');

// ── 모델·설정 ─────────────────────────────────────────────────
test('모델 id가 상수로 고정돼 있다', () => {
  // 값이 틀리면 런타임 400이다. 기본값은 코드에 두고, 운영에서는 GEMINI_MODEL로 바꿀 수 있다.
  assert.match(ai.ANALYZE_MODEL, /^gemini-/);
});

test('키가 없으면 기능 없음이지 크래시가 아니다', () => {
  const saved = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    ai.resetGeminiClientForTest();
    assert.equal(ai.isAiConfigured(), false);
    // 구분된 오류를 던진다 — 호출부가 안내 메시지로 바꿔 내보낸다.
    assert.throws(() => ai.getGeminiClient(), /ai-not-configured/);

    process.env.GEMINI_API_KEY = '   ';   // 공백만 있는 값도 미설정으로 본다
    assert.equal(ai.isAiConfigured(), false);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
    ai.resetGeminiClientForTest();
  }
});

// ── 도구 스키마 (strict 요건) ──────────────────────────────────
for (const [name, tool] of [['extract_receipt', RECEIPT_TOOL], ['extract_bankbook', BANKBOOK_TOOL]]) {
  test(`${name}: strict 도구 요건을 만족한다`, () => {
    // strict:true 는 additionalProperties:false 와 required 를 요구한다.
    // 빠지면 요청이 400으로 거부된다.
    assert.equal(tool.strict, true, 'strict가 켜져 있어야 스키마가 강제된다');
    assert.equal(tool.name, name);
    assert.ok(tool.description && tool.description.trim());

    const s = tool.input_schema;
    assert.equal(s.type, 'object');
    assert.equal(s.additionalProperties, false);
    assert.ok(Array.isArray(s.required) && s.required.length > 0);

    // 모든 속성이 required에 들어 있어야 한다 — 빠진 필드가 undefined로
    // 오면 우리 쪽 정규화가 조용히 이상한 값을 만든다.
    const props = Object.keys(s.properties);
    assert.deepEqual(
      [...s.required].sort(), props.sort(),
      'required가 properties와 일치하지 않습니다',
    );
  });

  test(`${name}: 중첩 객체도 strict 요건을 만족한다`, () => {
    const walk = (schema, path) => {
      if (schema.type === 'object') {
        assert.equal(schema.additionalProperties, false, `${path}: additionalProperties`);
        assert.ok(Array.isArray(schema.required), `${path}: required 없음`);
        for (const [k, v] of Object.entries(schema.properties || {})) walk(v, `${path}.${k}`);
      }
      if (schema.type === 'array' && schema.items) walk(schema.items, `${path}[]`);
    };
    walk(tool.input_schema, name);
  });
}

test('영수증 도구가 필요한 필드를 모두 요구한다', () => {
  const props = Object.keys(RECEIPT_TOOL.input_schema.properties);
  for (const f of ['merchant', 'dateRaw', 'totalAmount', 'isCancellation', 'confidence']) {
    assert.ok(props.includes(f), `${f} 필드가 없다`);
  }
});

test('날짜는 문자열로 받는다 — 모델이 날짜를 계산하면 안 된다', () => {
  // dateRaw를 date 타입이나 구조화된 객체로 받으면 모델이 연도를 채우게 되고,
  // 영수증에 연도가 없는 경우 1년 틀린 거래가 조용히 들어간다.
  assert.equal(RECEIPT_TOOL.input_schema.properties.dateRaw.type, 'string');
  const desc = RECEIPT_TOOL.input_schema.properties.dateRaw.description;
  assert.match(desc, /인쇄된 그대로|그대로/);
  assert.match(desc, /연도/, '연도를 채우지 말라는 지시가 있어야 한다');

  const row = BANKBOOK_TOOL.input_schema.properties.rows.items;
  assert.equal(row.properties.dateRaw.type, 'string');
  assert.match(row.properties.dateRaw.description, /연도/);
});

test('금액도 문자열로 받는다 — 모델이 합계를 계산하면 안 된다', () => {
  assert.equal(RECEIPT_TOOL.input_schema.properties.totalAmount.type, 'string');
  assert.match(
    RECEIPT_TOOL.input_schema.properties.totalAmount.description,
    /더해서|합계/,
  );
});

test('도구 스키마에 카테고리 필드가 없다 — 분류는 사용자 규칙이 한다', () => {
  const props = Object.keys(RECEIPT_TOOL.input_schema.properties);
  for (const banned of ['category', 'subcategory', 'type']) {
    assert.ok(!props.includes(banned), `${banned}는 모델이 정하면 안 된다`);
  }
});

test('시스템 프롬프트가 계약을 명시한다', () => {
  assert.match(SYSTEM_PROMPT, /인쇄된 것만|인쇄된 그대로/);
  assert.match(SYSTEM_PROMPT, /연도/);
  assert.match(SYSTEM_PROMPT, /분류/);
  assert.match(SYSTEM_PROMPT, /confidence/);
});

test('Gemini 구조화 출력 스키마에는 지원 대상 필드만 보낸다', () => {
  const schema = geminiSchemaFromTool(RECEIPT_TOOL);
  assert.equal(schema.type, 'object');
  assert.ok(!Object.hasOwn(schema, 'additionalProperties'));
  assert.deepEqual(schema.propertyOrdering, Object.keys(RECEIPT_TOOL.input_schema.properties));
  assert.deepEqual(schema.required, RECEIPT_TOOL.input_schema.required);
  assert.ok(!Object.hasOwn(schema.properties.items.items, 'additionalProperties'));
});

// ── 이미지 검증 (비용을 쓰기 전에 걸러낸다) ────────────────────
test('허용 형식만 통과한다', () => {
  const b64 = 'x'.repeat(100);
  assert.ok(validateImage({ base64: b64, mediaType: 'image/jpeg' }) > 0);
  assert.doesNotThrow(() => validateImage({ base64: b64, mediaType: 'image/png' }));
  assert.doesNotThrow(() => validateImage({ base64: b64, mediaType: 'image/webp' }));
  assert.throws(() => validateImage({ base64: b64, mediaType: 'application/pdf' }),
    /image-type-unsupported/);
  assert.throws(() => validateImage({ base64: b64, mediaType: 'image/heic' }),
    /image-type-unsupported/);
});

test('사진이 없으면 호출하지 않는다', () => {
  assert.throws(() => validateImage({ base64: '', mediaType: 'image/jpeg' }), /image-missing/);
  assert.throws(() => validateImage({ base64: null, mediaType: 'image/jpeg' }), /image-missing/);
  assert.throws(() => validateImage({ mediaType: 'image/jpeg' }), /image-missing/);
});

test('너무 큰 사진은 호출 전에 거부한다', () => {
  // base64는 원본의 약 4/3 — 한도를 넘는 길이를 만든다.
  const tooBig = 'x'.repeat(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100);
  assert.throws(() => validateImage({ base64: tooBig, mediaType: 'image/jpeg' }),
    /image-too-large/);
});

// ── 응답 파싱 ─────────────────────────────────────────────────
test('Gemini JSON 응답에서 값을 꺼낸다', () => {
  const res = {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"merchant":"이마트"}' }] } }],
  };
  assert.deepEqual(extractToolInput(res, 'extract_receipt'), { merchant: '이마트' });
});

test('거절은 구분된 오류로 던진다', () => {
  const res = { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] };
  assert.throws(() => extractToolInput(res, 'extract_receipt'), (e) => {
    assert.equal(e.message, 'ai-analyze-refused');
    assert.equal(e.category, 'SAFETY');
    return true;
  });
});

test('JSON이 아니면 무엇이 왔는지 오류에 담는다', () => {
  // 그냥 "실패"만 남기면 원인을 알 수 없다.
  const res = {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '못 읽겠습니다' }] } }],
  };
  assert.throws(() => extractToolInput(res, 'extract_receipt'), (e) => {
    assert.equal(e.message, 'ai-analyze-invalid-output');
    assert.match(e.detail, /finishReason=STOP/);
    assert.match(e.detail, /못 읽겠습니다/);
    return true;
  });
});

test('응답 텍스트가 비어 있어도 깨지지 않는다', () => {
  assert.throws(() => extractToolInput({ candidates: [{ finishReason: 'STOP' }] }, 'extract_receipt'),
    /ai-analyze-invalid-output/);
  assert.throws(() => extractToolInput({ candidates: [] }, 'extract_receipt'),
    /ai-analyze-invalid-output/);
});

// ─────────────────────────────────────────────────────────────
// 배포 계약 — 시크릿 선언
//
// Functions v2는 함수에 선언된 시크릿만 런타임 환경에 주입한다.
// 빠뜨리면 배포본에서 process.env.GEMINI_API_KEY가 undefined가 되고,
// 기능은 "설정 안 됨"으로 **조용히 꺼진 채** 남는다 — 오류도 나지 않는다.
// 로컬 에뮬레이터에서는 .env를 읽어 동작하므로 배포 후에만 드러난다.
// ─────────────────────────────────────────────────────────────
test('AI 콜러블 세 개 모두에 시크릿이 선언돼 있다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../functions/ai-fns.js', import.meta.url), 'utf8');

  assert.match(src, /const AI_SECRETS = \{ secrets: \['GEMINI_API_KEY'\] \}/,
    'AI_SECRETS 선언을 찾을 수 없습니다');

  for (const fn of ['getAiStatus', 'analyzeReceipt', 'analyzeBankbook']) {
    const re = new RegExp(`\\b${fn} = callable\\('${fn}'[\\s\\S]*?\\n  \\}, AI_SECRETS\\);`);
    assert.match(src, re,
      `${fn}에 AI_SECRETS가 붙어 있지 않습니다 — 배포본에서 키를 읽을 수 없습니다`);
  }
});

test('callable 래퍼가 onCall 옵션을 전달한다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
  // options를 무시하면 시크릿 선언이 조용히 버려진다.
  assert.match(src, /function callable\(name, handler, options\)/);
  assert.match(src, /onCall\(options \|\| \{\}/);
});

test('키가 public/ 어디에도 없다 — 있으면 즉시 공개된다', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'vendor' || name === 'icons') continue;
        walk(p);
      } else if (/\.(js|html|css|json)$/.test(name)) files.push(p);
    }
  })(PUBLIC);

  const leaked = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Firebase 웹 설정의 공개 API key도 AIza로 시작하므로, Gemini 서버 키 이름의 노출만 본다.
    if (/GEMINI_API_KEY/.test(src)) leaked.push(`${f}: GEMINI_API_KEY 참조`);
  }
  assert.deepEqual(leaked, [],
    'public/은 그대로 서빙된다 — 키나 키 참조가 있으면 즉시 공개된다:\n  '
      + leaked.join('\n  '));
});
