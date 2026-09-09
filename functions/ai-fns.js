'use strict';

/**
 * 영수증·통장 사진 자동입력 — Claude API 콜러블.
 *
 * 모델은 **제안만** 한다 — DB에 쓰지 않고 초안을 돌려준다. 날짜 정규화,
 * 카테고리 추정, 거래 매칭은 전부 클라이언트의 순수 모듈이 결정적으로 한다
 * (public/domain/receipt.js, receipt-match.js). 이유는 그 파일들의 머리말에.
 *
 * 키가 없으면 크래시가 아니라 기능 없음이다 — getAiStatus가 false를 돌려주고
 * 화면이 버튼을 숨긴다. 수기 입력과 엑셀 업로드는 이것 없이 완전히 동작한다.
 *
 * index.js에서 헬퍼를 주입받는다. 직접 require하면 index.js와 순환이 되고
 * admin.initializeApp()이 두 번 불릴 수 있다.
 */

module.exports = function aiFns(ctx) {
  const { db, callable, requireCaller, HttpsError, logger, FieldValue, Timestamp } = ctx;

  const { isAiConfigured } = require('./ai/anthropic');
  const { extractReceipt, extractBankbook } = require('./ai/receipt-extract');
  const { consumeRateLimit } = require('./rateLimit');

  /** 호출마다 실제 비용이 든다 — 분당 20장으로 제한한다. */
  const AI_RATE = { maxAttempts: 20, windowMs: 60 * 1000 };

  /**
   * getAiStatus — 화면이 이 기능을 보여줄지 정한다.
   * 키를 노출하지 않고 "설정됐는지" 여부만 알려준다.
   */
  /**
   * 시크릿 선언. Functions v2는 여기 적힌 것만 런타임 환경에 주입한다 —
   * 빠뜨리면 배포본에서 process.env.ANTHROPIC_API_KEY가 undefined가 되고,
   * 기능은 "설정 안 됨"으로 조용히 꺼진 채 남는다.
   *
   * 키 등록:  firebase functions:secrets:set ANTHROPIC_API_KEY
   * (자세한 절차는 docs/RECEIPT-AI-SETUP.md)
   */
  const AI_SECRETS = { secrets: ['ANTHROPIC_API_KEY'] };

  const getAiStatus = callable('getAiStatus', async (request) => {
    // 권한이 없거나 백필 전이면 "설정되지 않음"으로 답한다 — 이 호출은
    // 버튼을 보일지 정하는 데 쓰이고, 거부를 던지면 화면이 오류로 멈춘다.
    try {
      const me = await requireCaller(request.auth);
      if (!me.can('receipt.upload')) return { configured: false };
    } catch (_) {
      return { configured: false };
    }
    return { configured: isAiConfigured() };
  }, AI_SECRETS);

  /** 사진 판독 공통 전처리 — 권한·한도·입력 검증. */
  async function guardImageCall(request, scope) {
    const me = await requireCaller(request.auth);
    me.require('receipt.upload', '사진 자동입력');
    if (!isAiConfigured()) {
      // failed-precondition으로 던져야 메시지가 화면까지 간다(internal은 버려진다).
      throw new HttpsError(
        'failed-precondition',
        '사진 자동입력이 설정되지 않았습니다. 직접 입력할 수 있습니다.'
      );
    }

    try {
      await consumeRateLimit(db, scope, request.auth.uid, AI_RATE);
    } catch (err) {
      if (err && err.message === 'rate-limit-exceeded') {
        const secs = Math.ceil((err.retryAfterMs || 60000) / 1000);
        throw new HttpsError(
          'resource-exhausted',
          `사진 판독을 너무 자주 요청했습니다. ${secs}초 후 다시 시도하거나 직접 입력하세요.`
        );
      }
      throw err;
    }

    const d = request.data || {};
    const base64 = String(d.imageBase64 || '');
    const mediaType = String(d.mediaType || 'image/jpeg');
    if (!base64) {
      throw new HttpsError('invalid-argument', '사진이 전달되지 않았습니다.');
    }
    return { base64, mediaType, me };
  }

  /** 판독 실패를 사용자가 읽을 수 있는 메시지로 바꾼다. 끝은 항상 직접 입력 안내. */
  function imageErrorToHttps(err) {
    const m = (err && err.message) || '';
    const MANUAL = ' 직접 입력할 수 있습니다.';
    if (m === 'ai-not-configured') {
      return new HttpsError('failed-precondition', '사진 자동입력이 설정되지 않았습니다.' + MANUAL);
    }
    if (m === 'image-missing') {
      return new HttpsError('invalid-argument', '사진이 전달되지 않았습니다.' + MANUAL);
    }
    if (m === 'image-type-unsupported') {
      return new HttpsError('invalid-argument', 'JPG·PNG·WEBP 사진만 판독할 수 있습니다.' + MANUAL);
    }
    if (m === 'image-too-large') {
      return new HttpsError('invalid-argument', '사진이 너무 큽니다.' + MANUAL);
    }
    if (m === 'ai-analyze-refused') {
      return new HttpsError('failed-precondition', '이 사진은 판독할 수 없습니다.' + MANUAL);
    }
    if (m === 'ai-analyze-invalid-output') {
      return new HttpsError('internal', '판독 결과를 해석할 수 없습니다.' + MANUAL);
    }
    return null;   // 알 수 없는 오류는 callable 래퍼가 처리한다
  }

  /**
   * analyzeReceipt — 영수증 사진 1장을 판독해 **초안**을 돌려준다.
   *
   * 돌려주는 것은 인쇄된 문자열이다(dateRaw, totalAmount…). 정규화와 매칭은
   * 클라이언트의 순수 모듈이 한다 — 그래야 재현되고 테스트된다.
   */
  const analyzeReceipt = callable('analyzeReceipt', async (request) => {
    const { base64, mediaType, me } = await guardImageCall(request, 'receipt-analyze');
    try {
      const { extracted, usage, bytes } = await extractReceipt({ base64, mediaType });

      // 감사 로그는 **메타데이터만** 남긴다. 사진·상호명·품목은 기록하지 않는다
      // — 기록 자체가 개인정보 사본이 되면 안 된다.
      await writeAiAuditLog(request, me, 'ai.receiptAnalyze', {
        clientId: String((request.data && request.data.clientId) || ''),
        byteLength: bytes,
        confidence: Number(extracted && extracted.confidence) || 0,
        inputTokens: (usage && usage.input_tokens) || 0,
        outputTokens: (usage && usage.output_tokens) || 0,
      });

      return { extracted };
    } catch (err) {
      const mapped = imageErrorToHttps(err);
      if (mapped) throw mapped;
      throw err;
    }
  }, AI_SECRETS);

  /**
   * analyzeBankbook — 통장 거래내역 사진을 판독해 줄 목록을 돌려준다.
   * 결과는 기존 엑셀 업로드의 중복검사 → 미리보기 → 저장 경로로 들어간다.
   */
  const analyzeBankbook = callable('analyzeBankbook', async (request) => {
    const { base64, mediaType, me } = await guardImageCall(request, 'bankbook-analyze');
    try {
      const { extracted, usage, bytes } = await extractBankbook({ base64, mediaType });

      await writeAiAuditLog(request, me, 'ai.receiptAnalyze', {
        clientId: String((request.data && request.data.clientId) || ''),
        byteLength: bytes,
        count: Array.isArray(extracted && extracted.rows) ? extracted.rows.length : 0,
        confidence: Number(extracted && extracted.confidence) || 0,
        inputTokens: (usage && usage.input_tokens) || 0,
        outputTokens: (usage && usage.output_tokens) || 0,
      });

      return { extracted };
    } catch (err) {
      const mapped = imageErrorToHttps(err);
      if (mapped) throw mapped;
      throw err;
    }
  }, AI_SECRETS);

  /**
   * 서버에서 감사 로그를 남긴다.
   *
   * 클라이언트 규칙은 timestamp == request.time 을 요구하지만 Admin SDK는
   * 규칙을 우회하므로 serverTimestamp를 그대로 쓴다. 기록 실패가 판독 결과를
   * 버리게 하지 않는다 — 부수 작업이다.
   */
  async function writeAiAuditLog(request, actor, action, summary) {
    try {
      const RETENTION_DAYS = 730;
      await db.collection('auditLogs').add({
        action,
        actorUid: request.auth.uid,
        // 역할은 토큰이 아니라 권한 스냅샷에서 온다. 이름은 authz 에 없으므로
        // uid 를 쓴다 — 예전에도 토큰에 name 클레임이 없어 결과는 같았다.
        actorName: String(request.auth.uid),
        actorRole: String((actor && actor.role) || ''),
        summary,
        timestamp: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + RETENTION_DAYS * 86400000),
      });
    } catch (err) {
      logger.warn('[audit] AI 기록 실패', { action, message: err && err.message });
    }
  }

  return { getAiStatus, analyzeReceipt, analyzeBankbook };
};
