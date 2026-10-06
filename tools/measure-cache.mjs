#!/usr/bin/env node
/**
 * tools/measure-cache.mjs — 영속 캐시가 읽기를 실제로 줄이는가.
 *
 * 왜 재는가
 *   public/index.html 은 영속 캐시를 켜면서 "바뀌지 않은 문서는 과금되지
 *   않는다"고 적어 두었다. 그런데 앱의 읽기 24곳은 전부 getDocs() 다.
 *   getDocs 는 기본적으로 **서버 우선**이라, 캐시가 있어도 서버에 다시 묻는다.
 *   맞다면 캐시는 오프라인 대비용일 뿐 읽기를 한 건도 줄이지 않는다.
 *
 *   문서만 읽고 판단하지 않고 브라우저를 띄워 **전선 위로 오는 문서 수**를
 *   센다 — Firestore 과금 단위가 그것이기 때문이다.
 *
 * 사용
 *   firebase emulators:exec --only firestore --project cache-probe \
 *     "node tools/measure-cache.mjs"
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PROJECT = process.env.GCLOUD_PROJECT || 'cache-probe';
const EMU = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const TRX = Number(process.env.PROBE_TRX || 90);   // 입주자 1명의 한 달 거래
const PORT = 5599;
const ROOT = process.cwd();

/**
 * 프로브 전용 SDK 번들.
 *
 * 커밋된 public/vendor/firebase.js 는 **앱이 실제로 부르는 심볼만** 담는다
 * (tools/vendor.mjs). 앱은 onSnapshot 을 쓰지 않으므로 거기에 없다 —
 * 그 사실 자체가 이 측정의 출발점이다. 재보려고 커밋된 결과물을 건드리지는
 * 않고, esbuild 로 임시 번들을 하나 만들어 쓴다.
 */
const BUNDLE = process.env.PROBE_BUNDLE;

const n = (x) => Number(x).toLocaleString('ko-KR');

// ── 시드 (에뮬레이터 REST — admin SDK 불필요) ──────────────────
const base = `http://${EMU}/v1/projects/${PROJECT}/databases/(default)/documents`;

async function seed() {
  for (let i = 0; i < TRX; i += 1) {
    const r = await fetch(`${base}/transactions?documentId=trx-${i}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ fields: {
        clientId: { stringValue: 'c1' },
        date: { stringValue: `2026-09-${String((i % 28) + 1).padStart(2, '0')}` },
        description: { stringValue: `거래 ${i}` },
        amountOut: { integerValue: String(1000 + i) },
      } }),
    });
    if (!r.ok) throw new Error(`시드 실패 ${r.status}: ${await r.text()}`);
  }
}

/** 문서 한 건을 바꾼다 — 재구독이 그것만 받아 오는지 보려고. */
async function touchOne() {
  const r = await fetch(`${base}/transactions/trx-0?updateMask.fieldPaths=description`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: { description: { stringValue: '고친 거래' } } }),
  });
  if (!r.ok) throw new Error(`수정 실패 ${r.status}`);
}

// ── 계수: 크롬 개발자 프로토콜로 **받은 바이트**를 센다 ─────────
//
// 과금 단위는 서버가 돌려준 문서 수지만, 우리가 알고 싶은 것은 "다시 다 보냈나,
// 거의 안 보냈나" 다. 바이트는 문서 수에 비례하므로 그 질문에 답한다.
//
// 앞서 두 가지를 시도했다가 버렸다.
//   · 페이지에서 XHR·fetch 를 감싸기 → 같은 스트림을 두 번 세어 90 과 180 을 오갔다
//   · 계수 프록시를 앞에 세우기 → 출처가 달라져 CORS 에 막히고, 이 컨테이너의
//     HTTPS 프록시가 루프백까지 터널로 보내 인증서 오류로 죽었다
// CDP 는 브라우저가 이미 세고 있는 값을 읽는 것이라 둘 다 없다.
const FS_RE = /\/google\.firestore\.v1\.Firestore\//;

function makeCounter(cdp) {
  const fsReq = new Set();
  let bytes = 0;
  cdp.on('Network.requestWillBeSent', (e) => { if (FS_RE.test(e.request.url)) fsReq.add(e.requestId); });
  cdp.on('Network.dataReceived', (e) => { if (fsReq.has(e.requestId)) bytes += e.dataLength; });
  return { read: () => bytes, reset: () => { bytes = 0; } };
}

// ── 정적 서버 (IndexedDB 는 출처가 같아야 새로고침을 넘어 남는다) ──
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
function serve() {
  const srv = createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const file = path === '/' ? join(ROOT, 'tools/cache-probe/index.html')
      : path === '/sdk.js' ? BUNDLE
      : join(ROOT, 'tools/cache-probe', path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      if (!/favicon/.test(path)) console.log('  [404]', path, '→', file);
      res.writeHead(404); res.end('nope');
    }
  });
  return new Promise((ok) => srv.listen(PORT, '127.0.0.1', () => ok(srv)));
}

// ── 측정 ──────────────────────────────────────────────────────
const rows = [];
function record(label, bytes, note) { rows.push({ label, bytes, note }); }
/** 스트림이 조금 늦게 닫히므로 계수가 안정될 때까지 기다린다. */
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

async function openProbe(page) {
  await page.goto(`http://127.0.0.1:${PORT}/?project=${PROJECT}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
}

async function main() {
  console.log(`시드 중 — 거래 ${TRX}건…`);
  await seed();
  const srv = await serve();

  // 영속 컨텍스트: 새로고침·재기동을 넘어 IndexedDB 가 남는다(실사용과 같다).
  const profile = mkdtempSync(join(tmpdir(), 'cache-probe-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    args: ['--no-sandbox'],
    // 컨테이너에 미리 설치된 Chromium — playwright install 을 돌리지 않는다(qa-smoke 와 같다).
    executablePath: process.env.QA_CHROMIUM || '/opt/pw-browsers/chromium',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const counter = makeCounter(cdp);
  const browserErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 프로브 페이지에 아이콘이 없어서 나는 404 는 측정과 무관하다. 크로미움이
    // 남기는 문구에는 favicon 이라는 말이 없으므로 요청 쪽에서 걸러 둔다.
    if (/favicon/.test(t) || /404/.test(t)) return;
    browserErrors.push(t);
    console.log('  [브라우저오류]', t.slice(0, 200));
  });
  page.on('pageerror', (e) => console.log('  [페이지오류]', e.message));

  // ── A. getDocs — 지금 앱이 쓰는 방식 ──
  await openProbe(page);
  counter.reset();
  let r = await page.evaluate(() => window.probe.once());
  await settle();
  record('A1  getDocs — 첫 조회', counter.read(),
    `${r.size}건 · fromCache=${r.fromCache}`);

  counter.reset();
  r = await page.evaluate(() => window.probe.once());
  await settle();
  record('A2  getDocs — 같은 세션에서 다시', counter.read(),
    `${r.size}건 · fromCache=${r.fromCache}`);

  await openProbe(page);                        // 새로고침 = 새 세션
  counter.reset();
  r = await page.evaluate(() => window.probe.once());
  await settle();
  record('A3  getDocs — 새로고침 뒤', counter.read(),
    `${r.size}건 · fromCache=${r.fromCache}`);

  // ── B. onSnapshot — 제안하는 방식 ──
  await openProbe(page);
  counter.reset();
  r = await page.evaluate(() => window.probe.listen());
  await settle();
  record('B1  onSnapshot — 첫 구독', counter.read(),
    `${r.synced.size}건 · 첫 스냅숏 fromCache=${r.first.fromCache}`);

  await page.evaluate(() => window.probe.stop());
  counter.reset();
  r = await page.evaluate(() => window.probe.listen());
  await settle();
  record('B2  onSnapshot — 해제 후 재구독', counter.read(),
    `${r.synced.size}건 · 변경 ${r.synced.changes}건`);
  await page.evaluate(() => window.probe.stop());

  await openProbe(page);                        // 새로고침 = 새 세션
  counter.reset();
  r = await page.evaluate(() => window.probe.listen());
  await settle();
  record('B3  onSnapshot — 새로고침 뒤', counter.read(),
    `${r.synced.size}건 · 첫 스냅숏 fromCache=${r.first.fromCache}`);
  await page.evaluate(() => window.probe.stop());

  // ── C. 한 건만 바뀐 뒤 ──
  await touchOne();
  await openProbe(page);
  counter.reset();
  r = await page.evaluate(() => window.probe.listen());
  await settle();
  record('C   onSnapshot — 1건 바뀐 뒤 새로고침', counter.read(),
    `${r.synced.size}건 · 변경 ${r.synced.changes}건`);

  await ctx.close();
  srv.close();

  // ── 출력 ──
  console.log(`\n영속 캐시 실측 — 거래 ${n(TRX)}건 (서버에서 받은 바이트)`);
  console.log('─'.repeat(72));
  for (const x of rows) {
    console.log(x.label.padEnd(34) + (n(x.bytes) + 'B').padStart(11) + '   ' + x.note);
  }
  console.log('─'.repeat(72));

  const get = (k) => rows.find((x) => x.label.startsWith(k)).bytes;
  const reGet = get('A3'), reListen = get('B3'), changed = get('C');
  if (browserErrors.length) {
    console.log('\n✘ 브라우저에서 막힌 요청이 있다 — 이 숫자는 믿을 수 없다.');
    process.exitCode = 1;
  }
  console.log('\n새 세션에서 같은 자료를 다시 볼 때 (받은 바이트)');
  console.log(`  getDocs      ${n(reGet)}B`);
  console.log(`  onSnapshot   ${n(reListen)}B   →  ${reGet ? Math.round((1 - reListen / reGet) * 100) : 0}% 절감`);
  console.log(`  1건 바뀐 뒤  ${n(changed)}B`);
  console.log(`\n기준: 콜드 조회 1회 = ${n(get('A1'))}B (거래 ${n(TRX)}건)`);
  return rows;
}

main().catch((e) => { console.error(e); process.exit(1); });
