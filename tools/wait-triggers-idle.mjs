#!/usr/bin/env node
/**
 * tools/wait-triggers-idle.mjs — Firestore 트리거가 밀린 것을 다 처리할 때까지 기다린다.
 *
 * 왜 필요한가
 *   시드는 거래를 수십 건 쓰고, 그 하나하나가 `syncSummaryVersion` 트리거를
 *   깨운다. 트리거는 **비동기**라 시드가 끝난 뒤에도 한동안 밀려서 돈다.
 *
 *   그 사이에 브라우저 검증이 시작되면 이런 일이 생긴다.
 *
 *     1. 화면이 당월 집계를 계산해 summaryCaches 에 쓴다
 *     2. 밀려 있던 트리거가 그 키의 sourceVersion 을 올린다
 *     3. 두 번째 조회가 캐시를 낡았다고 보고 **다시 계산한다**
 *
 *   그래서 「두 번째 조회는 재계산 없이 캐시로 끝난다」가 실패한다. 캐시가
 *   고장 난 것이 아니라 **아직 조용해지지 않은 것**을 잰 것이다. 실제로 CI 에서
 *   이 세 가지가 역할마다 빨갛게 떴고, 트리거를 끈 환경에서는 통과했다 —
 *   차이가 정확히 이것이었다.
 *
 *   시드 직후 한 번 기다리면 그 뒤의 측정은 안정적이다.
 *
 * 무엇을 보는가
 *   `summaryCaches` 의 sourceVersion 들이 **연속으로 같게 나오면** 조용해진 것으로
 *   본다. 잠깐 자고 넘어가는 대신 실제 상태를 보므로, 느린 러너에서도 맞고
 *   빠른 러너에서 괜히 오래 기다리지도 않는다.
 *
 *   시간이 다 되면 **실패시키지 않고** 경고만 남긴다 — 여기서 잡을 고장이
 *   아니고, 진짜 문제가 있으면 뒤따르는 검증이 제 이름으로 보고한다.
 */

import admin from 'firebase-admin';

const PROJECT = process.env.GCLOUD_PROJECT
  || process.env.FIREBASE_PROJECT
  || 'smart-care-ledger-staging';

if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const STABLE_ROUNDS = Number(process.env.SETTLE_ROUNDS || 3);   // 연속 몇 번 같아야 하는가
const INTERVAL_MS = Number(process.env.SETTLE_INTERVAL_MS || 700);
const TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS || 60000);
/** 요약 캐시가 하나도 없을 때, 「아직 시작 안 함」과 「올릴 것이 없음」을 가르는 시간. */
const EMPTY_GRACE_MS = Number(process.env.SETTLE_EMPTY_GRACE_MS || 5000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** summaryCaches 의 버전들을 한 줄 지문으로. */
async function fingerprint() {
  const snap = await db.collection('summaryCaches').get();
  return snap.docs
    .map((d) => `${d.id}:${(d.data() || {}).sourceVersion ?? ''}`)
    .sort()
    .join('|');
}

/** 이 단계는 **거들 뿐이다.** 여기서 죽으면 진짜 검증이 시작도 못 한다. */
function giveUp(reason) {
  console.warn(`⚠ 트리거가 조용해지기를 기다리지 못했습니다: ${reason}`);
  console.warn('  그대로 진행합니다 — 뒤따르는 검증이 제 이름으로 보고합니다.');
  process.exit(0);
}

const started = Date.now();
let previous = null;
let stable = 0;
let polls = 0;

while (Date.now() - started < TIMEOUT_MS) {
  let now;
  try {
    now = await fingerprint();
  } catch (err) {
    // 에뮬레이터가 아직/이미 없을 수 있다. 스택을 토하지 않는다.
    giveUp(String((err && err.message) || err).split('\n')[0]);
  }
  polls += 1;
  stable = (now === previous) ? stable + 1 : 0;
  previous = now;
  // 빈 컬렉션이 연속으로 같다고 「조용하다」고 보면 안 된다 — 트리거가 아직
  // **시작도 안 했을** 때와 구분되지 않는다. 시드가 쓴 거래는 반드시 요약
  // 버전을 올리므로, 아무것도 없으면 조금 더 기다려 본다.
  const seenSomething = previous !== '';
  const waitedEnough = Date.now() - started >= EMPTY_GRACE_MS;
  if (stable >= STABLE_ROUNDS - 1 && (seenSomething || waitedEnough)) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`✔ 트리거가 조용해졌습니다 (${secs}초 · ${polls}회 확인)`);
    process.exit(0);
  }
  await sleep(INTERVAL_MS);
}

console.warn(`⚠ ${TIMEOUT_MS / 1000}초 안에 조용해지지 않았습니다 — 그대로 진행합니다.`);
console.warn('  뒤따르는 검증이 실패하면 캐시가 아니라 이 밀림을 먼저 의심하세요.');
process.exit(0);
