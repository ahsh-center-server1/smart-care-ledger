// test/created-by.test.mjs
//
// 거래를 만드는 모든 코드가 createdBy를 남기는가.
//
// 왜 이 테스트가 있는가
//   보안 규칙은 거래 생성에 **예외 없이** createdBy == 본인 uid를 요구한다:
//
//     allow create: if signedIn()
//                   && request.resource.data.get('createdBy', '') == myUid();
//
//   이 필드를 빼면 그 기능이 통째로 permission-denied가 된다. 그런데 규칙을
//   적용하기 전에는 아무 문제 없이 동작하므로, **배포 후에야 드러난다.**
//   실제로 두 곳이 그랬다:
//     · 「복사」 모달의 자산이동 분기 (addDoc 2회 + updateDoc 1회 직접 호출)
//     · 고정항목 일괄 입력 (for 루프 안 addDoc)
//   둘 다 화면에서 눌러보지 않으면 알 수 없고, 단위 테스트도 잡지 못했다.
//
//   그래서 소스를 훑는다. 새 생성 지점이 늘어나면 여기서 실패한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

/** public/ 아래 모든 .js (vendor 제외 — 우리 코드가 아니다). */
function jsFiles(dir = PUBLIC, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'vendor' || name === 'icons') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 거래 생성으로 보이는 호출을 뽑는다.
 *
 * 세 가지 형태를 본다:
 *   addDoc(..., COLS.TRANSACTIONS, ...)        — 한 건 추가
 *   batch.set(ref, { ... })                     — ref가 transactions 컬렉션
 *   batchAddDocs([{ col: COLS.TRANSACTIONS, data: { ... } }])
 *
 * 텍스트 검사이므로 완벽하지 않다. 놓치는 쪽(false negative)으로 기울여 두고,
 * 확실히 거래 생성인 형태만 잡는다 — 잘못된 실패로 이 테스트를 끄게 되는 것이
 * 더 나쁘다.
 */
function transactionCreateSites(src, file) {
  const sites = [];
  const lines = src.split('\n');
  // batch.set은 컬렉션 이름이 그 줄에 없다. 그래서 파일이 거래를 다루는지로
  // 좁힌 뒤 그 파일의 batch.set만 본다 — 이 앱에서 batch.set을 쓰는 곳은
  // 자산이동 양쪽 다리뿐이다.
  const fileTouchesTrx = src.includes('COLS.TRANSACTIONS');

  lines.forEach((line, i) => {
    const at = `${file.replace(PUBLIC, 'public/')}:${i + 1}`;

    // addDoc(...COLS.TRANSACTIONS...) — 인자가 collection(fdb(), COLS...)처럼
    // 중첩 괄호를 포함하므로 같은 줄에 둘 다 있는지로 본다.
    if (/\baddDoc\(/.test(line) && /COLS\.TRANSACTIONS/.test(line)) {
      sites.push({ at, line, kind: 'addDoc' });
    }
    // batchAddDocs / batchMixedOps의 adds 항목.
    //
    // docId가 함께 있으면 생성이 아니다 — 수정(updates)이나 삭제(deletes)의
    // 대상 지정이다. 규칙은 그쪽에 createdBy를 요구하지 않는다.
    if (/col\s*:\s*COLS\.TRANSACTIONS/.test(line) && !/docId/.test(line)) {
      sites.push({ at, line, kind: 'batchAdd' });
    }
    // 배치 안의 문서 생성.
    if (fileTouchesTrx && /\bbatch\.set\(/.test(line)) {
      sites.push({ at, line, kind: 'batch.set' });
    }
  });

  return sites;
}

/**
 * 그 생성 지점이 createdBy를 남기는가.
 *
 * 두 단계로 본다.
 *
 *  1) 호출 지점 앞 5줄 + 아래 15줄 — 데이터 객체가 인라인으로 오는 경우
 *     (addDoc(..., {…}), batchAddDocs의 map 콜백)와 바로 앞에서 필드를
 *     채우는 경우(transactions.js의 `if(!data.createdBy)…`)
 *
 *  2) 그 안에 `...변수` 스프레드가 있으면 **그 변수의 선언을 따라간다.**
 *     자산이동은 outData/inData를 위에서 조립해 batch.set에 넣으므로
 *     호출 지점 주변만 보면 놓친다. 창을 넓히는 방법도 있지만, 그러면
 *     "같은 함수 어딘가에 그 단어가 있다"는 느슨한 검사가 되어
 *     정작 잡아야 할 새 생성 지점을 통과시킨다.
 */
const WINDOW_BEFORE = 5;
const WINDOW_AFTER = 15;

/** `const foo={...}` 선언 지점부터 15줄 안에 createdBy가 있는가. */
function declarationHasCreatedBy(src, name) {
  const lines = src.split('\n');
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    if (!declRe.test(lines[i])) continue;
    if (lines.slice(i, i + 15).join('\n').includes('createdBy')) return true;
  }
  return false;
}

function hasCreatedByNear(src, siteLine) {
  const lines = src.split('\n');
  const window = lines
    .slice(Math.max(0, siteLine - 1 - WINDOW_BEFORE), siteLine - 1 + WINDOW_AFTER)
    .join('\n');
  if (window.includes('createdBy')) return true;

  // 스프레드된 변수를 한 단계 따라간다.
  for (const m of window.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
    if (declarationHasCreatedBy(src, m[1])) return true;
  }
  return false;
}

test('거래를 만드는 모든 지점이 createdBy를 남긴다', () => {
  const missing = [];

  for (const file of jsFiles()) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('COLS.TRANSACTIONS')) continue;

    for (const site of transactionCreateSites(src, file)) {
      const lineNo = Number(site.at.split(':').pop());
      if (!hasCreatedByNear(src, lineNo)) {
        missing.push(`${site.at}  (${site.kind})  ${site.line.trim().slice(0, 90)}`);
      }
    }
  }

  assert.deepEqual(missing, [],
    '거래를 만드는데 createdBy가 없습니다.\n'
    + '보안 규칙이 생성을 거부하므로 그 기능이 통째로 동작하지 않습니다:\n  '
    + missing.join('\n  '));
});

test('규칙이 실제로 createdBy를 요구한다 — 이 테스트의 전제', () => {
  // 규칙에서 그 조건이 사라지면 위 테스트는 지킬 이유가 없는 규약이 된다.
  // 전제가 바뀌면 여기서 먼저 실패해 같이 정리하게 한다.
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const trxBlock = rules.split('match /transactions/')[1] || '';
  assert.match(
    trxBlock,
    /allow create:[\s\S]*?createdBy[\s\S]*?myUid\(\)/,
    'firestore.rules의 transactions create가 createdBy를 검사하지 않습니다',
  );
});

test('거래 생성 지점을 실제로 찾아낸다 — 검사기 자체의 확인', () => {
  // 정규식이 아무것도 못 잡으면 이 파일은 항상 통과하는 빈 테스트가 된다.
  // 그것이 가장 위험한 실패 방식이므로 최소 개수를 요구한다.
  //
  // 숫자가 6에서 3으로 내려왔다. 검사기가 놓치기 시작해서가 아니라,
  // 자산이동·영수증 자동입력이 서버 콜러블로 옮겨 가 **브라우저에 남은
  // 생성 지점이 실제로 줄었기** 때문이다. 아래 서버 쪽 검사가 그 몫을 받는다.
  let found = 0;
  for (const file of jsFiles()) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('COLS.TRANSACTIONS')) continue;
    found += transactionCreateSites(src, file).length;
  }
  assert.ok(found >= 3,
    `거래 생성 지점을 ${found}개만 찾았습니다 — 검사기가 형태를 놓치고 있습니다`);
});

test('서버가 만드는 거래도 createdBy를 남긴다 — 그리고 서버가 정한다', () => {
  // 브라우저 쪽 검사는 "필드를 빠뜨리지 않았는가"를 본다. 서버는 한 걸음 더
  // 나아가야 한다: 값을 **클라이언트가 보낼 수 없어야** 한다. 보낼 수 있으면
  // 남의 이름으로 거래를 만들어 그 사람의 회수·수정 권한을 빌릴 수 있다.
  //
  // 거래 문서를 만드는 자리는 금액 필드로 알아본다 — tx.set 이든 스프레드든
  // 형태와 무관하게 잡힌다.
  const { readdirSync: rd, readFileSync: rf } = require('node:fs');
  const FN = fileURLToPath(new URL('../functions/', import.meta.url));

  const sites = [];
  for (const name of rd(FN).filter(n => /\.(js|cjs)$/.test(n))) {
    const src = rf(join(FN, name), 'utf8');
    for (const m of src.matchAll(/amountOut:/g)) {
      sites.push({ name, near: src.slice(Math.max(0, m.index - 400), m.index + 400) });
    }
  }
  assert.ok(sites.length >= 3, `서버 거래 생성 지점을 ${sites.length}개만 찾았습니다`);

  // 값이 서버에서 온다 — auth.uid 또는 호출자 객체(me.uid).
  // 기존 작성자를 지키는 형태(`existing.createdBy || me.uid`)도 서버 값이다.
  const bad = sites.filter(s => !/createdBy:[^,\n]*\b(auth\.uid|me\.uid)\b/.test(s.near));
  assert.deepEqual(
    bad.map(s => s.name), [],
    'createdBy 를 서버가 정하지 않는 거래 생성 지점이 있습니다: ' + bad.map(s => s.name).join(', '),
  );
});
