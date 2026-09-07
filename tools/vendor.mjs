#!/usr/bin/env node
/**
 * tools/vendor.mjs — 외부 CDN 의존을 public/vendor/ 로 가져온다.
 *
 * 왜 필요한가
 *   앱은 Firebase SDK(gstatic), Chart.js(cdnjs), xlsx-js-style(jsdelivr),
 *   Tailwind(cdn.tailwindcss.com) 네 곳의 CDN을 런타임에 불러왔다. 그 결과:
 *
 *   1. **PWA인데 오프라인이 안 된다.** 설치형 앱으로 만들어 놓고 핵심 라이브러리를
 *      매번 외부에서 받아오면, 망이 없거나 CDN이 죽으면 앱이 아예 뜨지 않는다.
 *   2. **CI·에뮬레이터에서 화면 검증이 불가능하다.** 폐쇄망에서는 네 CDN이 모두
 *      막혀 있어 브라우저로 앱을 띄울 수 없다. 그래서 PR #7의 대규모 UI 변경이
 *      한 번도 브라우저에서 렌더된 적이 없다.
 *   3. 서드파티 4곳이 런타임 신뢰 경계에 들어온다. 금전 장부에 붙일 이유가 없다.
 *
 *   그래서 npm에서 받은 것을 public/vendor/에 넣고 결과물을 커밋한다.
 *   **서빙에는 빌드가 필요하지 않다** — 빌드 없는 배포라는 이 프로젝트의 성질을
 *   유지하면서, 의존만 로컬로 가져오는 방식이다.
 *
 * 사용
 *   npm run vendor          # 재생성 (라이브러리 버전을 올린 뒤)
 *   npm run vendor:check    # 커밋된 결과물이 최신인지 검증 (CI용)
 *
 * 결과물
 *   public/vendor/firebase.js   Firebase SDK 5개 엔트리를 하나의 ESM으로 번들
 *   public/vendor/chart.umd.js  Chart.js UMD (전역 Chart)
 *   public/vendor/xlsx.bundle.js xlsx-js-style UMD (전역 XLSX)
 *   public/vendor/VERSIONS.json 각 라이브러리의 고정 버전
 */

import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'public', 'vendor');

const CHECK = process.argv.includes('--check');

/** package.json의 exports가 './package.json'을 막아도 버전을 읽는다. */
function pkgVersion(name) {
  const p = join(ROOT, 'node_modules', name, 'package.json');
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

/**
 * Firebase SDK 번들.
 *
 * index.html이 쓰는 심볼만 재export한다 — 앱이 실제로 부르는 것만 담아
 * 번들 크기를 줄이고, 새 심볼을 쓰려면 여기에 추가하게 만들어 의존을 눈에 보이게 한다.
 *
 * ⚠️ 여기에 심볼을 추가했으면 index.html의 import 목록에도 추가해야 한다.
 *    test/vendor.test.mjs가 양쪽이 어긋나면 실패시킨다.
 */
const FIREBASE_ENTRY = `
export { initializeApp } from 'firebase/app';
export {
  getFirestore, collection, doc, getDocs, getDoc, addDoc, setDoc, updateDoc,
  deleteDoc, deleteField, query, where, orderBy, limit, startAfter, writeBatch,
  getCountFromServer, increment, runTransaction, serverTimestamp,
  connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager,
  initializeFirestore, CACHE_SIZE_UNLIMITED,
} from 'firebase/firestore';
export {
  getAuth, signInWithCustomToken, signOut, onAuthStateChanged,
  setPersistence, browserSessionPersistence, connectAuthEmulator,
} from 'firebase/auth';
export {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject,
  connectStorageEmulator,
} from 'firebase/storage';
export {
  getFunctions, httpsCallable, connectFunctionsEmulator,
} from 'firebase/functions';
`;

async function bundleFirebase() {
  const out = join(VENDOR, 'firebase.js');
  const result = await build({
    stdin: {
      contents: FIREBASE_ENTRY,
      resolveDir: ROOT,
      sourcefile: 'firebase-vendor-entry.js',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    write: !CHECK,
    outfile: out,
    banner: {
      js: `// 자동 생성 — 직접 수정하지 마세요. \`npm run vendor\`로 재생성합니다.\n`
        + `// firebase@${pkgVersion('firebase')}`,
    },
  });
  if (CHECK) {
    const built = result.outputFiles[0].text;
    if (!existsSync(out)) fail('public/vendor/firebase.js 가 없습니다');
    if (readFileSync(out, 'utf8') !== built) {
      fail('public/vendor/firebase.js 가 최신이 아닙니다 — npm run vendor 를 실행하세요');
    }
  }
  return out;
}

/** UMD 빌드는 그대로 복사하면 된다 — 번들링이 필요 없다. */
const COPIES = [
  ['chart.js',      'node_modules/chart.js/dist/chart.umd.js',          'chart.umd.js'],
  ['xlsx-js-style', 'node_modules/xlsx-js-style/dist/xlsx.bundle.js',   'xlsx.bundle.js'],
];

const problems = [];
function fail(msg) { problems.push(msg); }

async function main() {
  if (!CHECK) mkdirSync(VENDOR, { recursive: true });

  await bundleFirebase();

  for (const [, src, destName] of COPIES) {
    const from = join(ROOT, src);
    const to = join(VENDOR, destName);
    if (CHECK) {
      if (!existsSync(to)) { fail(`public/vendor/${destName} 가 없습니다`); continue; }
      if (readFileSync(to) .toString() !== readFileSync(from).toString()) {
        fail(`public/vendor/${destName} 가 최신이 아닙니다 — npm run vendor 를 실행하세요`);
      }
    } else {
      copyFileSync(from, to);
    }
  }

  const versions = {
    firebase: pkgVersion('firebase'),
    ...Object.fromEntries(COPIES.map(([name]) => [name, pkgVersion(name)])),
  };
  const versionsJson = JSON.stringify(versions, null, 2) + '\n';
  const versionsPath = join(VENDOR, 'VERSIONS.json');
  if (CHECK) {
    if (!existsSync(versionsPath) || readFileSync(versionsPath, 'utf8') !== versionsJson) {
      fail('public/vendor/VERSIONS.json 가 최신이 아닙니다 — npm run vendor 를 실행하세요');
    }
  } else {
    writeFileSync(versionsPath, versionsJson);
  }

  if (problems.length) {
    console.error('\n외부 라이브러리 결과물이 소스와 어긋납니다:\n');
    for (const p of problems) console.error('  · ' + p);
    console.error('');
    process.exit(1);
  }

  console.log(CHECK ? '✔ vendor 결과물이 최신입니다' : '✔ public/vendor/ 재생성 완료');
  for (const [k, v] of Object.entries(versions)) console.log(`  ${k} ${v}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
