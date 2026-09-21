#!/usr/bin/env node
/**
 * tools/functions-budget.mjs — Cloud Functions 월 호출 수를 모델링한다.
 *
 * 왜 따로 있는가
 *   `read-budget.mjs` 는 **Firestore 읽기**를 센다. 그런데 이 앱은 쓰기의
 *   대부분이 콜러블을 지나고, 거래 한 건이 써질 때마다 **트리거가 여러 개**
 *   깨어난다. 읽기가 넉넉해도 호출 수는 다른 축이라 따로 봐야 한다.
 *
 *   특히 트리거는 **일찍 return 해도 호출로 센다.** "합계를 바꾸지 않는
 *   쓰기는 무시한다"는 최적화가 읽기는 줄이지만 호출 수는 줄이지 않는다 —
 *   이 구분을 놓치면 모델이 실제보다 낙관적으로 나온다.
 *
 * 무엇을 소스에서 읽는가
 *   거래·계좌 문서에 붙은 트리거 **개수**를 소스에서 센다. 트리거가 하나
 *   늘면 이 모델도 따라 늘어난다 — 손으로 적어 두면 늘어난 날 아무도
 *   모른다(test/functions-budget.test.mjs 가 대조한다).
 *
 * 한계 (정직하게)
 *   · 사용 습관(영수증을 몇 %에 붙이는가 등)은 **가정**이다. 인자로 바꾼다.
 *   · GB-초·vCPU-초는 평균 실행 시간 가정에 기댄다 — 호출 수보다 거칠다.
 *   · 무료 한도 숫자는 Google 가격 정책이 바꾼다. 여기 값은 2026 기준이고,
 *     여유가 두 자릿수 배수라 정책이 조금 바뀌어도 결론은 같다.
 *
 * 사용
 *   node tools/functions-budget.mjs
 *   node tools/functions-budget.mjs --staff=10 --clientsPerStaff=4 --trxPerClientMonth=90
 *   node tools/functions-budget.mjs --json
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * 이 파일은 도구이면서 **테스트가 가져다 쓰는 모듈**이기도 하다.
 * 가져오는 것만으로 화면에 표가 찍히면 테스트 출력이 뒤섞이므로,
 * 직접 실행했을 때만 찍는다.
 */
const IS_CLI = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

// ── 무료 한도 (Cloud Functions 2nd gen = Cloud Run) ──────────────
const FREE = {
  invocations: 2_000_000,
  gbSeconds: 400_000,
  cpuSeconds: 200_000,
};
/** 한도의 몇 %를 넘으면 경고할 것인가. */
const WARN_RATIO = 0.5;

// ── 인자 ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const num = (name, def) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const JSON_OUT = argv.includes('--json');

const cfg = {
  staff: num('staff', 10),
  leaders: num('leaders', 1),
  centers: num('centers', 1),
  admins: num('admins', 1),
  clientsPerStaff: num('clientsPerStaff', 4),
  trxPerClientMonth: num('trxPerClientMonth', 90),
  /** 거래 한 건이 만들어진 뒤 평균 몇 번 더 고쳐지는가(분류·증빙·순서). */
  editsPerTrx: num('editsPerTrx', 0.6),
  /** 지출 몇 %에 증빙을 붙이는가. */
  receiptRate: num('receiptRate', 0.5),
  /** 그중 몇 %를 AI 판독으로 넣는가. */
  aiReceiptRate: num('aiReceiptRate', 0.3),
  /** 1인 하루 로그인 횟수. */
  loginsPerDay: num('loginsPerDay', 2),
  /** 평균 실행 시간(초)과 메모리(GB) — GB-초 추정용. */
  avgSeconds: num('avgSeconds', 0.4),
  memoryGb: num('memoryGb', 0.25),
};

const users = cfg.staff + cfg.leaders + cfg.centers + cfg.admins;
const clients = cfg.staff * cfg.clientsPerStaff;
const trxCreates = clients * cfg.trxPerClientMonth;
const trxWrites = Math.round(trxCreates * (1 + cfg.editsPerTrx));
const receipts = Math.round(trxCreates * cfg.receiptRate);

// ── 소스에서 트리거 수를 센다 ──────────────────────────────────
const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8');

/** `document: 'col/{id}'` 로 걸린 트리거를 컬렉션별로 센다. */
export function countTriggers(sources) {
  const byCollection = {};
  for (const src of sources) {
    for (const m of src.matchAll(/onDocument\w+\(\s*\{?\s*document:\s*[`'"]([^`'"]+)[`'"]/g)) {
      const col = m[1].split('/')[0];
      byCollection[col] = (byCollection[col] || 0) + 1;
    }
  }
  return byCollection;
}

const TRIGGER_SOURCES = [
  'functions/index.js',
  'functions/ledger-triggers.js',
  'functions/directory-fns.js',
  'functions/receipt-fns.js',
];
const triggers = countTriggers(TRIGGER_SOURCES.map(read));
const trxTriggers = triggers.transactions || 0;
const accountTriggers = triggers.accounts || 0;

// ── 호출 수 ────────────────────────────────────────────────────
const rows = [];
const add = (name, count, note) => rows.push({ name, count: Math.round(count), note });

add('거래 트리거', trxWrites * trxTriggers,
  `거래 쓰기 ${trxWrites.toLocaleString()} × 트리거 ${trxTriggers}개 (일찍 return 해도 호출은 센다)`);
// 잔액 트리거가 계좌 문서를 고치면 계좌 트리거가 또 깨어난다. 되돌이는 아니다
// (기준일이 안 바뀌면 즉시 return) — 그래도 호출로는 남는다.
add('계좌 트리거', trxCreates * accountTriggers,
  `잔액 갱신이 계좌 문서를 쓰면 계좌 트리거 ${accountTriggers}개가 따라 깨어난다`);
add('명부 트리거', 60, '직원·입주자 변경 — 드물다');
add('예약 정리', 24 * 30, 'cleanupReceiptJobs — 매시간');
add('로그인', users * cfg.loginsPerDay * 30, `${users}명 × 하루 ${cfg.loginsPerDay}회`);
add('증빙 업로드', receipts * 2, 'startReceiptUpload + finalizeReceipts');
add('증빙 판독', Math.round(receipts * cfg.aiReceiptRate), 'analyzeReceipt');
add('증빙 열람·정리', receipts, 'getReceiptAccessUrl · discardReceiptUploads');
add('보고서 결재', clients * 8, '저장·제출·1차·최종 + 의견');
add('보고서 분석', clients, 'analyzeReport — 달마다 한 번');
add('그 밖의 콜러블', 400, '직원·입주자·분류·팀·은행 파서 — 어림값');

const total = rows.reduce((s, r) => s + r.count, 0);
const gbSeconds = total * cfg.avgSeconds * cfg.memoryGb;
const cpuSeconds = total * cfg.avgSeconds;

// ── 출력 ───────────────────────────────────────────────────────
const pct = (v, max) => `${((v / max) * 100).toFixed(1)}%`;

export const model = { cfg, triggers, rows, total, gbSeconds, cpuSeconds, FREE };

if (!IS_CLI) {
  // 모듈로 가져온 것이다 — 값만 내주고 아무것도 찍지 않는다.
} else if (JSON_OUT) {
  console.log(JSON.stringify(model, null, 2));
} else {
  printReport();
}

function printReport() {
const line = '─'.repeat(72);
console.log('\nCloud Functions 월 호출 예산');
console.log(line);
console.log(`인원   직원 ${cfg.staff} · 팀장 ${cfg.leaders} · 센터장 ${cfg.centers} · 관리자 ${cfg.admins}  (계 ${users}명)`);
console.log(`규모   입주자 ${clients}명 · 거래 ${trxCreates.toLocaleString()}건/월 (1명당 ${cfg.trxPerClientMonth}건)`);
console.log(`트리거 거래 ${trxTriggers}개 · 계좌 ${accountTriggers}개  ← 소스에서 셈`);
console.log(line);
for (const r of rows) {
  console.log(`${r.name.padEnd(16)}${String(r.count.toLocaleString()).padStart(9)}   ${r.note}`);
}
console.log(line);
console.log(`합계            ${String(total.toLocaleString()).padStart(9)}  / 무료 ${FREE.invocations.toLocaleString()}  →  ${pct(total, FREE.invocations)}`);
console.log(`GB-초           ${String(Math.round(gbSeconds).toLocaleString()).padStart(9)}  / 무료 ${FREE.gbSeconds.toLocaleString()}  →  ${pct(gbSeconds, FREE.gbSeconds)}`);
console.log(`vCPU-초         ${String(Math.round(cpuSeconds).toLocaleString()).padStart(9)}  / 무료 ${FREE.cpuSeconds.toLocaleString()}  →  ${pct(cpuSeconds, FREE.cpuSeconds)}`);
console.log('');

const worst = Math.max(total / FREE.invocations, gbSeconds / FREE.gbSeconds, cpuSeconds / FREE.cpuSeconds);
if (worst > 1) console.log('✘ 무료 한도를 넘습니다.');
else if (worst > WARN_RATIO) console.log(`⚠ 여유가 적습니다 (가장 빡빡한 축 ${(worst * 100).toFixed(0)}%).`);
else console.log(`✔ 여유 있음 (가장 빡빡한 축 ${(worst * 100).toFixed(1)}%).`);

console.log('');
console.log('⚠ Functions v2 는 Spark(무료 요금제)로 배포할 수 없다 — Blaze 로 올려야 하고,');
console.log('  위 무료 한도는 Blaze 안에서 매달 주어지는 몫이다. 넘는 만큼만 과금된다.');
console.log('⚠ Gemini 사용량은 여기 들어 있지 않다. 별도 한도다(functions/ai/).');
console.log('');
}
