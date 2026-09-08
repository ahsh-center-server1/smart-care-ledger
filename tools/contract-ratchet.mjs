// tools/contract-ratchet.mjs
//
// 집행 계약 게이트의 **래칫** — 통과 개수가 줄어들면 실패한다.
//
// 왜 이것이 필요했나
//   처음에는 CI에 계약 테스트를 `continue-on-error: true`로 붙였다. 워크플로는
//   통과하지만 **체크 자체는 빨간 X로 남는다**(GitHub은 job conclusion을 그대로
//   보고한다). 영구적으로 빨간 체크는 두 가지를 망친다:
//     · 리뷰어가 빨강을 무시하도록 학습한다 — 진짜 실패도 묻힌다
//     · 감시 세션이 매 푸시마다 실패 이벤트로 깨어난다
//
//   그렇다고 검사를 빼면 마이그레이션이 끝났는지 아무도 모른다.
//
//   그래서 "지금 몇 개가 통과하는가"를 기준선으로 커밋한다. 마이그레이션
//   단계가 끝나면 기준선을 올리고, 되돌아가면 이 스크립트가 빨개진다.
//   첫날부터 진짜 게이트이면서 초록이다.
//
// 사용
//   node tools/contract-ratchet.mjs           검사 (CI)
//   node tools/contract-ratchet.mjs --update  기준선을 현재 값으로 올린다

'use strict';

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'test', 'contract', 'ratchet.json');

const res = spawnSync(
  process.execPath,
  ['--test', 'test/contract/enforcement.test.mjs'],
  { cwd: ROOT, encoding: 'utf8' },
);

const out = (res.stdout || '') + (res.stderr || '');
const num = (label) => {
  const m = out.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : null;
};

const tests = num('tests');
const pass = num('pass');
const fail = num('fail');

if (tests === null || pass === null) {
  // 테스트 파일 자체가 죽었다(문법 오류 등). 래칫으로 감출 일이 아니다.
  console.error('계약 테스트를 실행할 수 없습니다. 원본 출력:\n');
  console.error(out);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ ...baseline, minPassing: pass, total: tests }, null, 2) + '\n');
  console.log(`기준선 갱신: ${baseline.minPassing} → ${pass} / ${tests}`);
  process.exit(0);
}

// 통과한 게이트 이름 — 남은 것이 곧 남은 작업량이므로 로그에 남긴다.
const remaining = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);

console.log(`집행 계약 게이트: ${pass} / ${tests} 통과 (기준선 ${baseline.minPassing})`);
if (remaining.length) {
  console.log('\n남은 게이트:');
  for (const name of remaining) console.log(`  · ${name}`);
  console.log('\n각 게이트는 한 마이그레이션 단계에 대응한다.'
    + ' 단계를 끝내고 `node tools/contract-ratchet.mjs --update`로 기준선을 올린다.');
}

if (pass < baseline.minPassing) {
  console.error(
    `\n✗ 통과 개수가 줄었습니다: ${baseline.minPassing} → ${pass}.`
    + '\n  이미 잠근 집행 지점이 되돌아갔습니다. 위 목록에서 새로 빨개진 게이트를 찾으세요.',
  );
  process.exit(1);
}

if (pass > baseline.minPassing) {
  console.log(
    `\n✓ 게이트 ${pass - baseline.minPassing}개가 새로 통과합니다.`
    + '\n  `node tools/contract-ratchet.mjs --update`로 기준선을 올려 커밋하세요.',
  );
}

console.log(`\n(참고: 미통과 ${fail}개는 아직 마이그레이션이 남은 항목입니다.)`);
