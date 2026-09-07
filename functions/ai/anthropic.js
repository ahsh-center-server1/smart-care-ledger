'use strict';

/**
 * Claude API 클라이언트 — **서버 전용 경계.**
 *
 * ⚠️ ANTHROPIC_API_KEY는 절대 브라우저로 나가면 안 된다. 그래서 이 파일은
 *    functions/ 안에만 있고, public/ 의 어떤 모듈도 이것을 import하지 않는다.
 *    (public/은 그대로 서빙되므로 여기에 키가 들어가면 즉시 공개된다)
 *
 * ⚠️ 키가 없으면 **크래시가 아니라 기능 없음**이다. 영수증 자동입력은 편의
 *    기능이고, 수기 입력과 엑셀 업로드는 이것 없이 완전히 동작한다. 키를 넣지
 *    않은 시설에서 앱이 죽거나 화면이 깨지면 안 된다.
 *
 * 비용 (2026-06 기준, 입력 $5 / 출력 $25 per MTok)
 *    영수증 사진 1장 ≈ 입력 1,500토큰 + 출력 500토큰 ≈ $0.02
 *    월 500장이면 약 $10. 시설 규모에서 감당 가능한 수준이지만 **공짜가 아니다**
 *    — 그래서 호출자별 레이트리밋(functions/rateLimit.js)을 함께 건다.
 */

const Anthropic = require('@anthropic-ai/sdk');

/**
 * 분석에 쓰는 모델. 값이 틀리면 런타임 400이라 상수로 못 박는다.
 * 한국 영수증은 인쇄 품질이 고르지 않고 손글씨 메모가 섞이는 경우가 있어
 * 시각 인식 품질이 결과를 좌우한다.
 */
const ANALYZE_MODEL = 'claude-opus-5';

/**
 * 정책상 거절이 났을 때 대신 답할 모델.
 * 영수증 판독에서 거절이 날 이유는 거의 없지만, 나면 사용자에게는 그냥
 * "실패"로 보인다. 시설 업무가 그것 때문에 멈추지 않게 예비 경로를 둔다.
 */
const FALLBACK_MODEL = 'claude-opus-4-8';
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';

/**
 * 추출 깊이. 영수증 판독은 기계적인 작업이라 최고치가 필요하지 않다.
 * 인식률이 부족하면 'high'로 올린다(비용도 함께 오른다).
 */
const ANALYZE_EFFORT = 'medium';

let cached = null;

/** 키가 설정돼 있는가 — 화면이 이 기능을 보여줄지 정하는 신호. */
function isAiConfigured() {
  return (process.env.ANTHROPIC_API_KEY || '').trim().length > 0;
}

/**
 * 클라이언트를 돌려준다. 키가 없으면 'ai-not-configured'를 던진다
 * (500이 아니라 안내로 바꿔 내보내기 위한 구분된 오류다).
 *
 * 인스턴스를 캐시하는 이유는 커넥션 재사용뿐 — 상태를 들고 있지 않다.
 */
function getAnthropicClient() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) throw new Error('ai-not-configured');
  if (!cached) cached = new Anthropic({ apiKey });
  return cached;
}

/** 테스트에서 캐시를 비운다. */
function resetAnthropicClientForTest() {
  cached = null;
}

module.exports = {
  ANALYZE_MODEL,
  FALLBACK_MODEL,
  FALLBACK_BETA,
  ANALYZE_EFFORT,
  isAiConfigured,
  getAnthropicClient,
  resetAnthropicClientForTest,
};
