#!/usr/bin/env node
/**
 * tools/qa-smoke.mjs — 에뮬레이터에 뜬 실제 앱을 브라우저로 열어 역할별로 눌러본다.
 *
 * 왜 필요한가
 *   PR #7은 index.html·modals.js·report.js·settings.js·transactions.js를 크게
 *   고쳤지만 **브라우저에서 한 번도 렌더된 적이 없다**(작업 환경에서 CDN이 막혀
 *   앱을 띄울 수 없었다). 그 상태로 위에 기능을 더 쌓으면 미검증 위에 미검증을 쌓는다.
 *   외부 라이브러리를 public/vendor/로 로컬화한 뒤로는 폐쇄망에서도 앱이 뜬다.
 *
 * 로그인 처리
 *   로그인은 Cloud Functions callable(login)이 비밀번호를 검증하고 커스텀 토큰을
 *   돌려주는 구조다. 그런데 이 환경에서는 Functions 에뮬레이터가 Firestore 트리거를
 *   등록할 때 firebase-public.firebaseio.com에 접속을 시도하고, 그 호스트가 조직
 *   이그레스 정책에 막혀 에뮬레이터 전체가 기동에 실패한다.
 *
 *   그래서 callable 응답만 가로채 커스텀 토큰을 직접 만들어 넣는다. Auth 에뮬레이터는
 *   커스텀 토큰의 서명을 검증하지 않으므로 서명 없는 토큰도 받는다. **검증 대상은
 *   화면과 권한 분기이므로**(비밀번호 해시 검증은 test/*.test.mjs가 따로 본다)
 *   이 대체는 검증 범위를 좁히지 않는다.
 *
 * 사용
 *   npm run emu:qa      # auth,firestore,hosting 기동 + 시드 + 이 스크립트
 *   node tools/qa-smoke.mjs [--headed] [--role center]
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.QA_BASE_URL || 'http://127.0.0.1:5000';
const PROJECT = 'smart-care-ledger-staging';
const OUT = process.env.QA_OUT_DIR || join(process.cwd(), 'qa-artifacts');

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const ONLY_ROLE = (() => { const i = argv.indexOf('--role'); return i > -1 ? argv[i + 1] : null; })();

/** 시드(tools/seed-staging.mjs)가 만드는 계정과 같아야 한다. */
const ROLES = [
  { uid: 'center', name: '김센터', role: '센터장', isAdmin: true },
  { uid: 'leader', name: '박팀장', role: '팀장',   isAdmin: false },
  { uid: 'staff',  name: '이담당', role: '담당자', isAdmin: false },
  { uid: 'typist', name: '최입력', role: '입력자', isAdmin: false },
];

/** base64url — 커스텀 토큰 조립용. */
const b64u = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Auth 에뮬레이터가 받아들이는 커스텀 토큰.
 * 에뮬레이터는 서명을 검증하지 않으므로 서명부는 자리만 채운다.
 */
function customToken(actor) {
  const now = Math.floor(Date.now() / 1000);
  const sa = `qa-smoke@${PROJECT}.iam.gserviceaccount.com`;
  const header = { alg: 'none', typ: 'JWT' };
  const payload = {
    iss: sa,
    sub: sa,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: actor.uid,
    claims: { role: actor.role, isAdmin: actor.isAdmin },
  };
  return `${b64u(header)}.${b64u(payload)}.`;
}

const failures = [];
const notes = [];
function check(ok, label, detail) {
  if (ok) { notes.push(`  ✔ ${label}`); return true; }
  failures.push(detail ? `${label} — ${detail}` : label);
  notes.push(`  ✘ ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

async function runRole(browser, actor) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));

  // login callable만 가로챈다. 나머지(Firestore·Auth)는 실제 에뮬레이터로 나간다.
  await page.route('**/asia-northeast3/login', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          token: customToken(actor),
          user: { userId: actor.uid, name: actor.name, role: actor.role, isAdmin: actor.isAdmin },
        },
      }),
    }),
  );

  notes.push(`\n[${actor.role} / ${actor.uid}]`);

  await page.goto(`${BASE}/?env=emulator`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._fbReady === true, { timeout: 20000 })
    .catch(() => {});
  check(await page.evaluate(() => window._fbReady === true),
    'Firebase SDK가 로컬 vendor 번들에서 초기화된다');

  // 로그인 화면
  await page.waitForSelector('#login-id', { timeout: 15000 });
  check(await page.isVisible('#login-id'), '로그인 화면이 렌더된다');

  await page.fill('#login-id', actor.uid);
  await page.fill('#login-pw', 'staging1234');
  await page.click('#login-btn');

  // 앱 진입 — 대시보드
  const entered = await page.waitForSelector('#app-view', { state: 'visible', timeout: 20000 })
    .then(() => true).catch(() => false);
  if (!check(entered, '로그인 후 앱 화면으로 진입한다',
    (await page.textContent('#login-err').catch(() => '')) || '')) {
    await snap(page, actor, 'login-failed');
    await ctx.close();
    return;
  }

  await page.waitForTimeout(2500);   // 기본 데이터 로드

  const clientCards = await page.locator('.client-card').count();
  check(clientCards > 0, `대시보드에 입주자 카드가 보인다 (${clientCards}개)`);
  await snap(page, actor, 'dashboard');

  // 역할별 내비게이션 노출 — 입력자는 보고서·설정이 없어야 한다
  const navReport = await page.locator('.nav-item[data-view="report"]').isVisible().catch(() => false);
  const navSettings = await page.locator('.nav-item[data-view="settings"]').isVisible().catch(() => false);
  if (actor.role === '입력자') {
    check(!navReport && !navSettings, '입력자에게 보고서·설정 내비가 숨겨진다',
      `report=${navReport} settings=${navSettings}`);
  } else {
    check(navReport && navSettings, '보고서·설정 내비가 보인다',
      `report=${navReport} settings=${navSettings}`);
  }

  // 거래내역
  await page.locator('.client-card').first().click().catch(() => {});
  await page.waitForTimeout(2000);
  const rows = await page.locator('#history-table tbody tr, #h-tbody tr').count().catch(() => 0);
  check(await page.isVisible('#view-history'), '거래내역 화면이 열린다');
  notes.push(`    거래 행 ${rows}건`);
  await snap(page, actor, 'history');

  await checkReceiptIntake(page, actor);

  // 보고서 · 설정 (권한 있는 역할만)
  if (navReport) {
    await page.locator('.nav-item[data-view="report"]').click();
    await page.waitForTimeout(2000);
    check(await page.isVisible('#view-report'), '보고서 화면이 열린다');
    await snap(page, actor, 'report');
  }
  if (navSettings) {
    await page.locator('.nav-item[data-view="settings"]').click();
    await page.waitForTimeout(2000);
    check(await page.isVisible('#view-settings'), '설정 화면이 열린다');
    await snap(page, actor, 'settings');

    // 설정 탭을 하나씩 실제로 눌러본다 — 탭 배열과 패널이 어긋나면
    // 빈 화면이 되고, 그것은 테스트가 아니라 눌러봐야만 드러난다.
    const railTabs = await page.locator('#settings-rail .ui-settings__tab').all();
    check(railTabs.length > 0, '설정 레일에 탭이 그려진다');

    for (const tab of railTabs) {
      const key = await tab.getAttribute('data-tab');
      await tab.click();
      await page.waitForTimeout(900);

      const visible = await page.locator(`#${key}-tab-content`).isVisible().catch(() => false);
      check(visible, `설정 「${key}」 패널이 열린다`);

      // 제목이 비어 있으면 셸이 탭 정의를 못 찾은 것이다.
      const title = (await page.textContent('#settings-panel-title').catch(() => '')) || '';
      check(title.trim().length > 0, `설정 「${key}」 제목이 표시된다`);
    }
    await snap(page, actor, 'settings-last-tab');
    await checkAuditRoundTrip(page, actor);
  }

  // 콘솔·페이지 오류는 무조건 실패로 다룬다 — 예전에 화면을 못 띄웠던 원인이 여기 남는다.
  //
  // 다만 Firestore의 롱폴 스트림(Listen/channel)은 페이지·컨텍스트를 닫는 순간
  // 끊기면서 ERR_ABORTED / ERR_CONNECTION_RESET을 남긴다. 정상 종료 과정이므로
  // 이것만 제외한다. 진짜 Firestore 거부(permission-denied)는 메시지 본문이 있어
  // 아래 필터를 통과하지 못한다.
  const teardownNoise = (t) =>
    /Listen\/channel|Write\/channel/.test(t)
    || /^Failed to load resource: net::ERR_(ABORTED|CONNECTION_RESET)$/.test(t.trim());
  const fontNoise = (t) => /fonts\.(googleapis|gstatic)/.test(t);

  // Functions 에뮬레이터(5001)는 이 환경에서 띄울 수 없다 — 조직 이그레스
  // 정책이 firebase-public.firebaseio.com을 막아 트리거 등록이 실패한다.
  // 그래서 콜러블 호출은 연결 거부가 되는데, **앱이 그것을 정상적으로
  // 흡수하는지가 검증 대상**이다(기능이 숨고 나머지는 동작한다).
  // 따라서 이 요청 실패는 통과 처리하되, 몇 건이 그랬는지 보고한다.
  const fnEmulatorDown = (t) => /:5001\//.test(t)
    || /^Failed to load resource: net::ERR_CONNECTION_REFUSED$/.test(t.trim());

  const ignorable = (t) => /favicon/i.test(t) || /heic2any/i.test(t)
    || fontNoise(t) || teardownNoise(t) || fnEmulatorDown(t);

  const realConsole = consoleErrors.filter((t) => !ignorable(t));
  const realFailed = failedRequests.filter(
    (t) => !fontNoise(t) && !teardownNoise(t) && !fnEmulatorDown(t));

  const skipped = failedRequests.filter(fnEmulatorDown).length;
  if (skipped) {
    notes.push(`    (Functions 에뮬레이터 미가동으로 콜러블 ${skipped}건 실패 — `
      + '앱이 기능을 숨기고 정상 동작하는지가 검증 대상이다)');
  }

  check(pageErrors.length === 0, '처리되지 않은 JS 예외가 없다', pageErrors.join(' | '));
  check(realConsole.length === 0, '콘솔 오류가 없다', realConsole.slice(0, 3).join(' | '));
  check(realFailed.length === 0, '실패한 네트워크 요청이 없다', realFailed.slice(0, 3).join(' | '));

  await ctx.close();
}

/**
 * 영수증 사진 자동입력 화면이 렌더되는지 확인한다.
 *
 * 이 환경에서는 Functions 에뮬레이터를 띄울 수 없어(조직 이그레스 정책이
 * firebase-public.firebaseio.com을 막는다) 실제 판독은 호출할 수 없다.
 * 그래서 검증 범위는 **화면이 뜨고 필수 요소가 있는지**까지다 —
 * 판독 계약과 정규화·매칭은 단위 테스트가 전수로 본다.
 *
 * 진입 버튼은 서버에 API 키가 없으면 숨으므로(정상 동작), 여기서는
 * 모달을 직접 열어 폼만 확인한다.
 */
async function checkReceiptIntake(page, actor) {
  if (!['담당자', '팀장', '센터장', '관리자'].includes(actor.role)) return;

  const opened = await page.evaluate(() => {
    try { window.openModal('receipt-intake'); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  if (!check(opened.ok, '영수증 사진 입력 화면이 열린다', opened.error)) return;

  await page.waitForTimeout(600);
  check(await page.locator('#ri-drop').isVisible().catch(() => false),
    '사진 드롭 영역이 보인다');
  check(await page.locator('#ri-client').isVisible().catch(() => false),
    '입주자 선택이 보인다');
  check(await page.locator('#ri-account').isVisible().catch(() => false),
    '계좌 선택이 보인다');

  // 입주자를 고르면 그 사람의 계좌만 채워져야 한다.
  const accCount = await page.evaluate(() => {
    const c = document.getElementById('ri-client');
    const a = document.getElementById('ri-account');
    if (!c || !a || c.options.length < 2) return -1;
    c.selectedIndex = 1;
    c.dispatchEvent(new Event('change'));
    return a.options.length;
  });
  check(accCount > 1, '입주자를 고르면 계좌 목록이 채워진다', `옵션 ${accCount}개`);

  // 저장 버튼은 판독된 항목이 없으면 눌릴 수 없어야 한다.
  check(await page.locator('#ri-save').isDisabled().catch(() => false),
    '판독 전에는 저장이 잠겨 있다');

  await snap(page, actor, 'receipt-intake');
  await page.evaluate(() => window.closeModal());
  await page.waitForTimeout(300);
}

/**
 * 변경 이력 쓰기→규칙→읽기를 한 번에 확인한다.
 *
 * 규칙이 actorUid·timestamp·expireAt을 검사하므로, 이 왕복이 통과하면
 * 앱이 만드는 기록 형태가 규칙과 맞다는 뜻이다. 형태가 어긋나면
 * 조용히 permission-denied가 되고 이력만 비어 있게 된다 —
 * 사용자는 알 수 없고 단위 테스트도 잡지 못하는 조합이다.
 */
async function checkAuditRoundTrip(page, actor) {
  // 팀장 이상만 조회 권한이 있다(audit.view = 등급 3).
  const canRead = ['팀장', '센터장', '관리자'].includes(actor.role);
  if (!canRead) return;

  const result = await page.evaluate(async () => {
    try {
      const { auditLog, fetchRecentAuditLogs } = await import('./services/audit.js');
      await auditLog('login.success', { summary: { target: 'qa-smoke' } });
      const rows = await fetchRecentAuditLogs(10);
      return { ok: true, count: rows.length, first: rows[0] ? rows[0].action : null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  if (!check(result.ok, '변경 이력을 쓰고 다시 읽을 수 있다', result.error)) return;
  check(result.count > 0, '기록이 조회된다');
  check(result.first === 'login.success', '방금 쓴 기록이 가장 위에 온다',
    `첫 기록=${result.first}`);

  // 화면에도 실제로 그려지는지 확인한다.
  await page.locator('#settings-rail .ui-settings__tab[data-tab="audit"]').click();
  await page.waitForTimeout(1200);
  const rows = await page.locator('#audit-tab-content .ui-log__row').count().catch(() => 0);
  check(rows > 0, '변경 이력 화면에 기록이 표시된다', `행 ${rows}개`);
  await snap(page, actor, 'settings-audit');
}

async function snap(page, actor, label) {
  try {
    await page.screenshot({ path: join(OUT, `${actor.uid}-${label}.png`), fullPage: false });
  } catch { /* 스크린샷 실패가 검증을 막지는 않는다 */ }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: !HEADED,
    // 컨테이너에 미리 설치된 Chromium을 쓴다 — playwright install을 돌리지 않는다.
    executablePath: process.env.QA_CHROMIUM || '/opt/pw-browsers/chromium',
  });
  try {
    for (const actor of ROLES) {
      if (ONLY_ROLE && actor.uid !== ONLY_ROLE) continue;
      await runRole(browser, actor);
    }
  } finally {
    await browser.close();
  }

  console.log(notes.join('\n'));
  writeFileSync(join(OUT, 'summary.txt'), notes.join('\n') + '\n');

  if (failures.length) {
    console.error(`\n✘ 화면 검증 실패 ${failures.length}건\n`);
    for (const f of failures) console.error('  · ' + f);
    process.exit(1);
  }
  console.log(`\n✔ 역할별 화면 검증 통과 — 스크린샷: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
