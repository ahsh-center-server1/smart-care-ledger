// tools/gen-report-workflow.mjs
//
// 결재 전이표를 functions/ 로 **기계적으로** 옮긴다.
//
// 왜 필요한가
//   전이표의 출처는 public/domain/report-workflow.js 하나다. 그런데 functions/ 는
//   별도 배포 단위라 런타임에 `require('../public/...')` 가 존재하지 않는 경로가 된다.
//
//   손으로 옮겨 적으면 표가 두 벌이 되고, 그러면 화면과 서버가 다른 규칙으로
//   결재를 판정한다 — 이 프로젝트가 권한에서 이미 겪은 일이다.
//
//   perm-catalog 는 **데이터**만 옮기고 로직은 CJS 로 다시 구현했다(동작 동등성
//   테스트가 지킨다). 여기는 그럴 수 없다 — 전이표와 판정 로직이 한 몸이고,
//   switch 문 하나가 곧 규칙이다. 그래서 원문을 그대로 옮기되 export 만 떼어 낸다.
//
//   그것이 가능하려면 원본에 import 가 없어야 한다. 그래서 권한 판정을 ctx.can 으로
//   주입받도록 만들어 뒀고, 아래에서 그 전제를 검사한다.
//
// 사용
//   node tools/gen-report-workflow.mjs           생성
//   node tools/gen-report-workflow.mjs --check   낡았는지 검사 (CI·테스트)

'use strict';

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public', 'domain', 'report-workflow.js');
const OUT = join(ROOT, 'functions', 'report-workflow.cjs');

/** 내보낼 이름들 — 원본에서 뽑는다(손으로 적으면 빠뜨린다). */
function exportedNames(src) {
  return [...src.matchAll(/^export\s+(?:const|function)\s+(\w+)/gm)].map(m => m[1]);
}

function build() {
  const src = readFileSync(SRC, 'utf8');

  // 전제: import 가 없어야 기계적 변환이 성립한다.
  const imports = [...src.matchAll(/^\s*import\s/gm)];
  if (imports.length) {
    console.error(
      'public/domain/report-workflow.js 에 import 가 있습니다.\n'
      + 'CJS 로 그대로 옮길 수 없습니다 — 의존을 ctx 로 주입받게 고치세요.',
    );
    process.exit(1);
  }

  const names = exportedNames(src);
  if (!names.length) {
    console.error('내보낼 이름을 찾지 못했습니다. 생성기를 확인하세요.');
    process.exit(1);
  }

  const body = src.replace(/^export\s+/gm, '');
  const header =
    '// 생성물 — 직접 고치지 마세요.\n'
    + '// public/domain/report-workflow.js 를 고치고 `npm run report-workflow:gen` 을 돌리세요.\n'
    + '// 원본과 이 파일이 어긋나면 화면과 서버가 다른 규칙으로 결재를 판정합니다.\n\n';
  const tail = `\nmodule.exports = { ${names.join(', ')} };\n`;

  return header + body.trimEnd() + '\n' + tail;
}

const text = build();

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch (_) { /* 없으면 빈 문자열 */ }
  if (current !== text) {
    console.error(
      'functions/report-workflow.cjs 가 원본과 다릅니다.\n'
      + '`npm run report-workflow:gen` 을 돌리고 결과를 커밋하세요.',
    );
    process.exit(1);
  }
  console.log('report-workflow.cjs 최신 상태입니다.');
  process.exit(0);
}

writeFileSync(OUT, text);
console.log(`생성: functions/report-workflow.cjs (${exportedNames(readFileSync(SRC, 'utf8')).length}개 export)`);
