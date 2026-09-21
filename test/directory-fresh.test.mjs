// test/directory-fresh.test.mjs
//
// 「설정에서 분류를 고쳤는데 바로 안 바뀐다」 — 그 자리를 고정한다.
//
// 무엇이 잘못돼 있었나
//   직원·분류는 읽기를 아끼려고 **파생 명부 문서 1건**으로 읽는다
//   (`directories/staff` · `directories/categories`, services/directory.js).
//   그런데 그 명부를 다시 만드는 것은 **Firestore 트리거**이고 비동기다.
//
//     1. 사용자가 분류 이름을 고친다 → saveCategory 가 categories/{id} 를 쓴다
//     2. 화면이 곧바로 refetchCategories() 를 부른다
//     3. 그런데 트리거는 아직 안 돌았다 → 명부에는 **바뀌기 전 이름**이 있다
//     4. 화면이 옛 이름을 그린다
//
//   사용자에게는 "저장이 안 됐다"로 보인다. 그래서 다시 저장하고, 잠시 뒤
//   새로고침하면 낫는다 — 그게 더 나쁘다. 무엇이 언제 저장됐는지 확인할
//   방법이 없어진다.
//
//   요약 캐시에서 겪은 것과 **같은 부류**다(§12-1): 비동기로 다시 만들어지는
//   파생물을, 그것을 낡게 만든 쪽이 곧바로 읽는다.
//
// 고친 방식
//   `refetch*` 는 존재 이유가 "방금 쓴 것을 반영한다"이므로 명부를 건너뛰고
//   컬렉션을 직접 읽는다(`fresh`). 값은 컬렉션이 원본이라 언제나 맞고, 비용은
//   그 한 번뿐이다. 로그인·새로고침은 그대로 명부 1건으로 읽는다 — 아낄 곳은
//   거기다(로그인마다 전 역할에 걸리던 비용).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dirSrc = readFileSync(new URL('../public/services/directory.js', import.meta.url), 'utf8');
const coreSrc = readFileSync(new URL('../public/modules/core.js', import.meta.url), 'utf8');

test('명부 조회가 건너뛰기를 받아들인다', () => {
  assert.match(dirSrc, /fetchStaffDirectory\s*=\s*\(opts\)/,
    'fetchStaffDirectory 가 옵션을 받지 않습니다');
  assert.match(dirSrc, /fetchCategoryDirectory\s*=\s*\(opts\)/,
    'fetchCategoryDirectory 가 옵션을 받지 않습니다');
  assert.match(dirSrc, /if \(!opts\.fresh\)/,
    'fresh 일 때 명부 문서를 건너뛰지 않습니다');
});

test('fresh 라도 컬렉션 직접 조회는 그대로 한다 — 값이 없으면 화면이 빈다', () => {
  // 명부를 건너뛰는 것이지 조회를 건너뛰는 것이 아니다.
  const body = dirSrc.slice(dirSrc.indexOf('async function loadWithFallback'));
  const after = body.slice(body.indexOf('if (!opts.fresh)'));
  assert.match(after, /getDocs\(collection\(db, col\)\)/,
    'fresh 경로에서 컬렉션을 읽지 않습니다');
});

test('refetch* 는 명부를 건너뛴다 — 그것이 이 함수들의 존재 이유다', () => {
  for (const name of ['refetchUsers', 'refetchCategories']) {
    const line = coreSrc.split('\n').find(l => l.includes(`export const ${name}`)) || '';
    assert.match(line, /fresh:\s*true/,
      `${name} 가 낡은 명부를 읽습니다 — 방금 고친 것이 화면에 안 나옵니다`);
  }
});

test('로그인·새로고침은 여전히 명부 1건으로 읽는다 — 아낄 곳은 거기다', () => {
  // fetchBaseData() 를 인자 없이 부르는 것이 로그인 경로다. fresh 가 기본으로
  // 켜지면 로그인마다 직원 25 + 분류 60 건을 다시 읽게 된다(§12-1 의 절감이 사라진다).
  assert.match(coreSrc, /const dirOpts = \{ fresh: !!\(opts && opts\.fresh\) \}/,
    'fresh 가 명시적으로 켜질 때만 동작하는지 확인할 수 없습니다');
});

test('입주자·계좌는 이 문제가 없다 — 명부를 쓰지 않는다', () => {
  // 여기에 fresh 를 붙이면 "고쳤는데 왜 안 되지"의 원인을 엉뚱한 곳에서 찾게 된다.
  for (const name of ['refetchClients', 'refetchAccounts']) {
    const line = coreSrc.split('\n').find(l => l.includes(`export const ${name}`)) || '';
    assert.ok(!/fresh:/.test(line),
      `${name} 에 fresh 가 붙어 있습니다 — 이 둘은 명부를 읽지 않으므로 뜻이 없습니다`);
  }
  assert.match(coreSrc, /fetchInScope\(db, COLS\.CLIENTS/);
  assert.match(coreSrc, /fetchInScope\(db, COLS\.ACCOUNTS/);
});

test('명부를 다시 만드는 것이 비동기 트리거라는 전제가 아직 맞다', () => {
  // 트리거가 아니라 콜러블이 동기로 다시 만들게 되면 이 우회는 불필요해진다.
  const fns = readFileSync(new URL('../functions/directory-fns.js', import.meta.url), 'utf8');
  assert.match(fns, /onDocumentWritten/,
    '명부 재생성이 더 이상 트리거가 아니라면 refetch* 의 fresh 를 다시 보세요');
});
