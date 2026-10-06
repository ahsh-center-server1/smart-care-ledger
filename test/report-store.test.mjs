// test/report-store.test.mjs
//
// 보고서를 기간으로 찾을 때 **`getDoc` 을 쓰면 안 된다.**
//
// 무엇이 났나
//   화면이 표준 ID(`(입주자, 연, 월)` 해시)로 `getDoc` 을 먼저 하도록 바뀌었다.
//   그런데 예전 임의 ID 로 저장된 보고서에서는 그 문서가 **없고**, `reports`
//   규칙은 `reportViewAll` 이 없는 역할에게
//
//       cap('reportOwn') && seesClient(resource.data.get('clientId',''))
//
//   를 평가한다. 없는 문서에서는 `resource` 가 null 이라 **평가 자체가 오류**가
//   되어 거부되고, 거부는 예외로 올라오며, `loadReport` 가 그 예외를 삼킨다
//   → **보고서가 빈 화면**이 된다(계좌 현황·분류별 지출이 통째로 빈다).
//
//   센터장은 첫 항(`reportViewAll`)에서 참이라 `resource` 를 건드리지 않고
//   통과한다. 그래서 **담당자·팀장에게만** 터졌고, 단위 테스트는 전부 초록인
//   채로 브라우저 검증만 잡았다.
//
// 왜 규칙을 풀지 않았나
//   `resource == null ||` 로 완화하면 담당 밖 입주자의 보고서 **존재 여부**를
//   떠볼 수 있다 — 표준 ID 가 결정적이라 아무 입주자에 대해서나 만들어 볼 수
//   있기 때문이다. 그래서 규칙은 그대로 두고 조회 모양을 바꿨다: **문서 키
//   쿼리**는 맞는 문서가 없으면 빈 결과이고, 규칙은 돌려줄 문서마다 평가되므로
//   평가할 것이 없다. 색인도 필요 없다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../public/services/report-store.js', import.meta.url), 'utf8');
const RULES = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

test('표준 ID 조회에 getDoc 을 쓰지 않는다', () => {
  // **부르는 자리**만 본다. 주석은 왜 쓰면 안 되는지를 설명하느라 그 이름을
  // 적고 있고, 그것까지 막으면 이유를 적을 수 없다.
  // `getDocs(` 는 걸리지 않는다 — `getDoc` 뒤에 바로 `(` 가 와야 한다.
  assert.ok(!/\bgetDoc\s*\(/.test(SRC),
    'getDoc 으로 표준 ID 를 찾습니다 — 없는 문서에서 규칙이 거부하고, 보고서가 빈 화면이 됩니다');
  // 가져오지도 않는다 — 있으면 다음 사람이 쓴다.
  const destructure = SRC.slice(SRC.indexOf('const {'), SRC.indexOf('= fb()'));
  assert.ok(!/\bgetDoc\b(?!s)/.test(destructure),
    'getDoc 을 꺼내 옵니다 — 쓰지 않을 것이면 가져오지 마세요');
});

test('문서 키 쿼리도 쓰지 않는다 — 그쪽도 없는 문서에서 거부된다', () => {
  // 에뮬레이터로 확인했다: getDoc 과 마찬가지로 막힌다.
  assert.ok(!/documentId\s*\(/.test(SRC),
    '문서 키 쿼리로 표준 ID 를 찾습니다 — 없는 문서에서 똑같이 거부됩니다');
});

test('조회는 한 번이다 — 표준 ID 는 찾는 데가 아니라 고르는 데 쓴다', () => {
  assert.equal((SRC.match(/getDocs\(/g) || []).length, 1,
    '조회가 두 번이면 읽기가 늘고, 하나는 없는 문서를 건드립니다');
  assert.match(SRC, /snap\.docs\.find\(d => d\.id === canonicalId\)/,
    '표준 ID 문서를 골라 쓰지 않습니다 — 중복이 있는 달에서 화면과 서버가 다른 문서를 가리킵니다');
});

test('표준 ID 계산이 실패해도 보고서는 열린다', () => {
  // crypto.subtle 이 없는 환경에서 보고서가 통째로 안 열리면 안 된다.
  assert.match(SRC, /catch\b/,
    'reportDocId 실패를 받아 주지 않습니다');
  assert.match(SRC, /\|\| snap\.docs\[0\]/,
    '표준 ID 를 못 구했을 때의 폴백이 없습니다');
});

test('예전 임의 ID 로 저장된 보고서도 찾는다', () => {
  // 이미 저장된 보고서는 제자리에서 계속 쓴다(CLAUDE.md §10-2).
  // 이 쿼리 하나가 표준 ID 문서와 예전 문서를 **둘 다** 찾는다.
  assert.match(SRC, /where\('clientId', '==', clientId\)/);
  assert.match(SRC, /where\('year', '==', year\)/);
  assert.match(SRC, /where\('month', '==', month\)/);
});

test('규칙이 아직 없는 문서에서 resource 를 본다 — 이 우회의 전제', () => {
  // 규칙이 `resource == null` 을 허용하도록 바뀌면 이 우회는 불필요해진다.
  // 그때는 이 테스트가 먼저 실패해서 다시 보게 한다.
  const block = RULES.slice(RULES.indexOf('match /reports/{id}'));
  const read = block.slice(0, block.indexOf('allow write'));
  assert.match(read, /resource\.data\.get\('clientId'/,
    'reports 읽기 규칙이 바뀌었습니다 — report-store.js 의 우회를 다시 보세요');
  assert.ok(!/resource\s*==\s*null/.test(read),
    '규칙이 없는 문서를 허용하게 됐다면, 담당 밖 보고서의 존재 여부가 떠볼 수 있게 된 것은 아닌지 확인하세요');
});
