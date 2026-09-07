/**
 * Smart Care Ledger — Service Worker (PWA)
 *
 * 전략
 *  - 동일 출처(same-origin) GET 요청만 가로챈다.
 *      · network-first: 온라인이면 항상 최신 코드/HTML 을 받고, 받은 응답을 캐시에 갱신.
 *      · 오프라인이면 캐시로 폴백(앱 셸). 네비게이션 실패 시 index.html 반환.
 *  - 교차 출처(Firestore / Auth / Storage / Google Drive / CDN / 폰트)는
 *    가로채지 않고 네트워크로 그대로 흘려보낸다. (인증·실시간 데이터 보호)
 *  - 비 GET(POST/PUT 등)도 가로채지 않는다.
 *
 * 버전 갱신: CACHE_VERSION 을 올리면 activate 단계에서 이전 캐시를 정리한다.
 */
'use strict';

const CACHE_VERSION = 'scl-v3';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;

// 오프라인 폴백을 위해 미리 캐시할 앱 셸 (동일 출처 정적 자원)
//
// ⚠️ 여기서 빠진 모듈이 있으면 그 모듈만 오프라인에서 로드 실패해 앱이 조용히 깨진다.
//    ES 모듈은 하나만 못 받아도 그래프 전체가 죽는다.
//    test/sw.test.mjs 가 public/ 의 실제 파일 목록과 이 배열을 대조해 누락을 잡는다.
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/state.js',
  '/constants.js',
  '/parser-config.js',
  '/firebase-env.js',
  // 스타일시트가 빠지면 오프라인에서 스타일 없는 화면이 뜬다(앱은 돌지만 못 쓴다).
  '/styles/tokens.css',
  '/styles/components.css',
  '/utils/ui.js',
  '/services/balance.js',
  '/services/excel-parser.js',
  '/services/firestore.js',
  '/services/fn-errors.js',
  '/services/in-query.js',
  '/domain/action-items.js',
  '/services/image.js',
  '/services/storage.js',
  '/modules/auth.js',
  '/modules/core.js',
  '/modules/dashboard.js',
  '/modules/font-scale.js',
  '/modules/modals.js',
  '/modules/permissions.js',
  '/modules/report.js',
  '/modules/report-workflow.js',
  '/modules/settings.js',
  '/modules/settings-nav.js',
  '/modules/settings-overview.js',
  '/modules/settings-shell.js',
  '/modules/setup.js',
  '/modules/transactions.js',
  // 외부 라이브러리를 로컬로 가져왔으므로 이제 오프라인에서도 앱이 뜬다.
  // 예전에는 Firebase SDK·Chart.js·xlsx를 CDN에서 받아 망이 없으면 PWA가 아예 죽었다.
  '/vendor/firebase.js',
  '/vendor/chart.umd.js',
  '/vendor/xlsx.bundle.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // 개별 add 로 실패해도 설치는 계속 진행 (network-first 가 이후 보충)
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // 쓰기 요청은 통과
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // 교차 출처는 통과 (Firestore/CDN/Drive 등)
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok && fresh.type === 'basic') {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (_) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
    }
    return Response.error();
  }
}

// 새 버전 즉시 적용 트리거 (페이지에서 postMessage 로 호출 가능)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
