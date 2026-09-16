// tools/check-deps.mjs
//
// functions/ 의존성이 설치돼 있는지 확인한다.
//
// 왜 필요한가
//   이 저장소는 package.json 이 둘이다(루트 · functions/). 그런데 테스트는
//   한 벌이고, 그중 여럿이 functions/ 쪽 모듈을 require 한다 —
//   test/archive.test.mjs 는 sharp 를, test/receipt-extract.test.mjs 는
//   @google/genai 를 거쳐 간다.
//
//   그래서 새로 클론해 `npm ci && npm run check` 만 하면 테스트 4개가
//   "Cannot find module 'sharp'" 로 죽었다. 스택이 functions/package.json 을
//   가리키므로 **코드가 깨진 것처럼 보인다** — 실제로는 설치가 덜 된 것이다.
//   CI 는 functions 설치 줄이 따로 있어 초록이라, 이 차이가 로컬에서만 드러났다.
//
//   postinstall 이 정상 경로를 덮고, 이 검사는 그것이 건너뛰어졌을 때
//   (--ignore-scripts, 부분 체크아웃) 원인과 해결책을 바로 알려 준다.

'use strict';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 존재만 보지 않고 실제로 쓰는 패키지를 짚는다 — 빈 node_modules 디렉터리가
// 남아 있는 경우에도 통과시키지 않기 위해서다.
const REQUIRED = ['sharp', '@google/genai', 'firebase-functions', 'firebase-admin'];

const missing = REQUIRED.filter(
  (pkg) => !existsSync(join(ROOT, 'functions', 'node_modules', ...pkg.split('/'))),
);

if (missing.length) {
  console.error(
    `✗ functions/ 의존성이 없습니다: ${missing.join(', ')}\n\n`
    + '  테스트 일부가 functions/ 모듈을 거쳐 가므로 이대로는 "Cannot find\n'
    + '  module" 로 죽습니다. 코드 문제가 아닙니다. 아래를 실행하세요:\n\n'
    + '      npm --prefix functions ci\n',
  );
  process.exit(1);
}

console.log('✔ functions/ 의존성 확인');
