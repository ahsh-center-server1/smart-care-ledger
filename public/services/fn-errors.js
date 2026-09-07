/**
 * fn-errors.js — Cloud Functions 호출 오류를 사용자 문장으로 바꾼다.
 *
 * 왜 따로 있는가 — **브라우저는 "서버가 오류를 냈다"와 "서버에 닿지도 못했다"를
 * 구분해 주지 않는다.** Firebase SDK는 fetch가 실패하면(CORS 차단, 네트워크 단절,
 * 함수 미배포) 그것도 `internal`로 보고한다. 그래서 로그인 화면에는 두 경우 모두
 * "로그인 실패. 다시 시도하세요."만 떴고, 원인이 서버 안에 있는지 밖에 있는지조차
 * 알 수 없었다.
 *
 * 구분 방법 — 서버(`functions/index.js`의 `callable()` 래퍼)는 어떤 경로로도
 * **빈 메시지나 'internal'이라는 메시지를 보내지 않는다.** 항상 한국어 문장을 담는다.
 * 따라서 코드가 internal인데 메시지가 비었거나 'internal' 그대로면, 그것은 서버가
 * 만든 응답이 아니라 SDK가 전송 실패를 채워 넣은 값이다.
 *
 * DOM도 Firebase도 모르는 순수 모듈이다 — 테스트가 있다.
 */

'use strict';

/** 전송 자체가 실패했을 때 보여줄 안내 */
export const UNREACHABLE_MESSAGE =
  '서버에 연결하지 못했습니다. 로그인 기능(Cloud Functions)이 배포되지 않았거나, ' +
  '외부 호출이 차단되어 있을 수 있습니다. 관리자에게 문의하세요. (E_UNREACHABLE)';

/** SDK가 코드 앞에 붙이는 접두사를 떼어 낸다 (`functions/internal` → `internal`) */
function bareCode(code) {
  const c = String(code || '');
  const i = c.indexOf('/');
  return (i >= 0 ? c.slice(i + 1) : c).toLowerCase();
}

/**
 * 함수 호출 오류가 "서버에 닿지 못한 것"인가?
 *
 * 서버가 실제로 던진 internal은 항상 우리가 쓴 문장을 달고 온다.
 * 메시지가 비었거나 'internal' 그대로면 SDK가 전송 실패를 채운 것이다.
 */
export function isUnreachable(e) {
  if (!e) return false;
  if (bareCode(e.code) !== 'internal') return false;
  const msg = String(e.message || '').trim().toLowerCase();
  return msg === '' || msg === 'internal';
}

/**
 * 사용자에게 보여줄 메시지를 고른다.
 *
 * - 전송 실패 → 무엇이 잘못됐는지 알려 준다 (예전에는 fallback에 묻혔다)
 * - 서버가 만든 메시지 → 그대로 (설정 오류 진단 E_... 이 여기로 온다)
 * - 그 외 → 호출부가 준 fallback
 */
export function fnErrorMessage(e, fallback) {
  if (isUnreachable(e)) return UNREACHABLE_MESSAGE;
  if (e && typeof e.message === 'string' && e.message && bareCode(e.code) !== 'internal') {
    return e.message;
  }
  return fallback;
}
