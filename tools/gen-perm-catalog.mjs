// tools/gen-perm-catalog.mjs
//
// 권한 카탈로그의 **데이터**를 functions/ 로 옮긴다.
//
// 왜 이것이 필요한가
//   카탈로그는 public/domain/perm-catalog.js 에 있고 그것이 유일한 출처다.
//   그런데 functions/ 는 **별도 배포 단위**다 — `firebase deploy --only functions`
//   는 functions/ 디렉터리만 올리므로, 런타임에 `require('../public/...')` 는
//   존재하지 않는 경로가 된다.
//
//   그렇다고 43개 항목을 손으로 옮겨 적으면 등급표가 다시 두 벌이 된다.
//   지금 고치고 있는 바로 그 문제다.
//
//   그래서 **데이터만 기계적으로 복사**한다. 판정 로직은 functions/perm-catalog.cjs
//   가 CJS로 따로 구현하고, test/perm-catalog-parity.test.mjs 가 두 구현의
//   결과를 전수 대조한다. 텍스트 비교가 아니라 **동작 비교**이므로 로직이
//   갈라지면 즉시 잡힌다.
//
// 사용
//   node tools/gen-perm-catalog.mjs           생성
//   node tools/gen-perm-catalog.mjs --check   낡았는지 검사 (CI·테스트)

'use strict';

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PERM_CATALOG, CAP_SCHEMA_VERSION, ADMIN_RANK, SELECTABLE_RANKS,
  SCOPE, ENFORCE, SERVER_ENFORCED, SERVER_ENFORCED_KEYS,
} from '../public/domain/perm-catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'functions', 'perm-catalog.data.json');

/**
 * 생성물의 형태.
 *
 * 키 순서를 정렬해 두는 이유: 카탈로그에서 항목을 옮기기만 해도 생성물이
 * 달라지면 diff 가 시끄러워지고 --check 가 헛되이 실패한다.
 */
function build() {
  const catalog = {};
  for (const key of Object.keys(PERM_CATALOG).sort()) {
    const e = PERM_CATALOG[key];
    // 판정에 쓰이는 필드만 담는다. 화면 표시용 라벨 같은 것은 서버가 쓰지 않는다.
    const out = {
      defaultRank: e.defaultRank,
      securityFloor: e.securityFloor,
      configurable: e.configurable,
      enforcement: [...e.enforcement],
    };
    if (e.resource) out.resource = e.resource;
    if (e.actions) out.actions = [...e.actions];
    if (e.scope) out.scope = e.scope;
    if (e.scopeByRank) out.scopeByRank = { ...e.scopeByRank };
    if (e.allowedFields) out.allowedFields = [...e.allowedFields];
    if (e.immutableFields) out.immutableFields = [...e.immutableFields];
    if (e.authorizeAgainst) out.authorizeAgainst = e.authorizeAgainst;
    if (e.relatedResourceChecks) out.relatedResourceChecks = e.relatedResourceChecks.map(c => ({ ...c }));
    if (e.transition) out.transition = { ...e.transition, from: [...e.transition.from] };
    catalog[key] = out;
  }

  return {
    _generated: 'tools/gen-perm-catalog.mjs — 직접 고치지 마세요. '
      + 'public/domain/perm-catalog.js 를 고치고 `npm run perm-catalog:gen` 을 돌리세요.',
    capSchemaVersion: CAP_SCHEMA_VERSION,
    adminRank: ADMIN_RANK,
    selectableRanks: [...SELECTABLE_RANKS],
    scope: { ...SCOPE },
    enforce: { ...ENFORCE },
    serverEnforced: [...SERVER_ENFORCED],
    serverEnforcedKeys: [...SERVER_ENFORCED_KEYS].sort(),
    catalog,
  };
}

const text = JSON.stringify(build(), null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch (_) { /* 없으면 빈 문자열 */ }
  if (current !== text) {
    console.error(
      'functions/perm-catalog.data.json 이 카탈로그와 다릅니다.\n'
      + '`npm run perm-catalog:gen` 을 돌리고 결과를 커밋하세요.',
    );
    process.exit(1);
  }
  console.log('perm-catalog.data.json 최신 상태입니다.');
  process.exit(0);
}

writeFileSync(OUT, text);
console.log(`생성: functions/perm-catalog.data.json (${Object.keys(build().catalog).length}개 키)`);
