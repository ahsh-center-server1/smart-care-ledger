// test/bankbook-photo.test.mjs
//
// 통장 사진 판독이 **왜 어떤 은행에서만 안 되는가.**
//
// 현장에서 온 말: "기존 은행은 잘 분석되는데 몇몇 안 되는 것들이 있다. 파서에
// 없는 은행이라 그런 것 같다." 앞은 맞고 **뒤는 틀렸다** — 사진 경로는
// `BANK_CONFIGS` 를 한 번도 읽지 않는다(모델이 사진에서 직접 읽는다).
//
// 실제 원인 둘을 여기서 못 박는다.
//   ⑴ 판독용 사진이 보관용과 같은 압축(1200px·0.78)을 지났다. 영수증은 글자가
//      커서 읽히지만 통장은 한 장에 스무 줄이 넘어 숫자가 뭉개진다 —
//      **글씨가 큰 은행만 읽히는** 증상이 정확히 이것이다.
//   ⑵ 연도가 안 적힌 줄에 오늘의 연도를 넣었다. 작년 통장을 올리면 조용히
//      올해 거래가 된다(과거라 "미래면 작년" 규칙에도 안 걸린다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bankbookRowsToParsed, explicitYearOf } from '../public/domain/receipt.js';

const SRC = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── ⑴ 판독용 해상도 ────────────────────────────────────────────────

test('판독용 사진은 보관용보다 크게 만든다', () => {
  const image = SRC('../public/services/image.js');
  assert.match(image, /export async function compressForReading/);
  // 첫 단계가 업로드 압축(1200)보다 커야 한다 — 같으면 고친 것이 없다.
  const steps = image.match(/const READ_STEPS = (\[[\s\S]*?\]);/);
  assert.ok(steps, 'READ_STEPS 를 찾지 못했습니다');
  const first = Number(steps[1].match(/\[(\d+)/)[1]);
  assert.ok(first > 1200, `판독용 첫 단계가 ${first}px 입니다 — 보관용과 같으면 고친 것이 없습니다`);
});

test('통장 사진 판독은 판독용 사진을 보낸다', () => {
  const modals = SRC('../public/modules/modals.js');
  const i = modals.indexOf('export async function analyzeBankbookPhoto');
  assert.ok(i > 0);
  const body = modals.slice(i, i + 2500);
  assert.match(body, /compressForReading/, '보관용 압축본을 그대로 보내면 빽빽한 통장이 안 읽힙니다');
  assert.match(body, /imageBase64:base64/);
});

test('판독용 사진도 서버 상한 안에 들어간다', async () => {
  // 서버는 5MB 를 넘으면 판독을 거부한다. 작게 보내서 못 읽는 것보다 나쁘다.
  const { approxBase64Bytes, READ_MAX_BYTES } = await import('../public/services/image.js');
  const server = 5 * 1024 * 1024;
  assert.ok(READ_MAX_BYTES < server, '상한이 서버와 같으면 경계에서 거부된다');
  assert.equal(approxBase64Bytes(3), 4);
});

// ── ⑵ 연도 ─────────────────────────────────────────────────────────

test('연도가 적혀 있으면 읽는다', () => {
  assert.equal(explicitYearOf('2026-09-05'), 2026);
  assert.equal(explicitYearOf('26.09.05'), 2026);
  assert.equal(explicitYearOf('20260905'), 2026);
  assert.equal(explicitYearOf('2025년 9월 5일'), 2025);
  assert.equal(explicitYearOf('09-05'), null);
  assert.equal(explicitYearOf('9월 5일'), null);
  assert.equal(explicitYearOf(''), null);
});

test('연도 없는 줄은 같은 사진의 다른 줄에서 연도를 빌린다', () => {
  // 작년 통장을 올린 경우. 예전에는 09-06 이 조용히 올해가 됐다.
  const out = bankbookRowsToParsed({
    rows: [
      { dateRaw: '2025-09-05', description: '이마트', withdraw: '12,000', deposit: '' },
      { dateRaw: '09-06', description: '용돈', withdraw: '', deposit: '30,000' },
      { dateRaw: '09-07', description: 'GS25', withdraw: '3,500', deposit: '' },
    ],
  }, { today: new Date(2026, 8, 18) });

  assert.deepEqual(out.rows.map(r => r.date),
    ['2025-09-05', '2025-09-06', '2025-09-07']);
  assert.equal(out.skipped.length, 0);
});

test('연도가 한 줄도 없으면 예전대로 오늘을 기준으로 본다', () => {
  const out = bankbookRowsToParsed({
    rows: [{ dateRaw: '09-05', description: '이마트', withdraw: '12,000', deposit: '' }],
  }, { today: new Date(2026, 8, 18) });
  assert.equal(out.rows[0].date, '2026-09-05');
});

test('연도가 적힌 줄이 이기는 것은 가장 많이 나온 연도다', () => {
  const out = bankbookRowsToParsed({
    rows: [
      { dateRaw: '2025-12-30', description: 'a', withdraw: '1,000', deposit: '' },
      { dateRaw: '2026-01-02', description: 'b', withdraw: '1,000', deposit: '' },
      { dateRaw: '2026-01-03', description: 'c', withdraw: '1,000', deposit: '' },
      { dateRaw: '01-04', description: 'd', withdraw: '1,000', deposit: '' },
    ],
  }, { today: new Date(2026, 8, 18) });
  assert.equal(out.rows[3].date, '2026-01-04');
  assert.equal(out.rows[0].date, '2025-12-30', '연도가 적힌 줄은 그대로여야 합니다');
});

// ── 사진 경로는 파서 설정을 쓰지 않는다 ─────────────────────────────

test('사진 판독은 BANK_CONFIGS 를 읽지 않는다', () => {
  // 이것이 사실이 아니게 되면 위 머리말의 진단이 틀린 말이 된다.
  const receipt = SRC('../public/domain/receipt.js');
  const code = receipt.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  assert.ok(!code.includes('BANK_CONFIGS'));
  assert.ok(!code.includes('parser-config'));
});
