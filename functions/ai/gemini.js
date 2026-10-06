'use strict';

/**
 * Gemini API 클라이언트 — 서버 전용 경계.
 *
 * GEMINI_API_KEY는 브라우저로 나가면 안 된다. 이 파일은 functions/ 안에만 있고,
 * public/ 의 어떤 모듈도 import하지 않는다.
 *
 * 키가 없으면 크래시가 아니라 기능 없음이다. 사진 자동입력은 편의 기능이고,
 * 수기 입력과 엑셀 업로드는 이것 없이 완전히 동작한다.
 */

const { GoogleGenAI } = require('@google/genai');

/**
 * 기본 모델. 운영에서는 GEMINI_MODEL 환경변수로 바꿀 수 있다.
 *
 * ⚠️ 모델은 **은퇴한다.** gemini-2.5-flash-lite 는 신규 사용자에게 닫혔고,
 * 그때 API 가 404 NOT_FOUND 를 돌려줬다("no longer available to new users").
 * 키 문제로 보이지만 키는 멀쩡하다 — 배포된 지 한참 뒤에 갑자기 드러난다.
 * 그래서 providerError 가 404 를 따로 분류한다(receipt-extract.js).
 */
const ANALYZE_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

let cached = null;

function isAiConfigured() {
  return (process.env.GEMINI_API_KEY || '').trim().length > 0;
}

function getGeminiClient() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('ai-not-configured');
  if (!cached) cached = new GoogleGenAI({ apiKey });
  return cached;
}

function resetGeminiClientForTest() {
  cached = null;
}

module.exports = {
  ANALYZE_MODEL,
  isAiConfigured,
  getGeminiClient,
  resetGeminiClientForTest,
};
