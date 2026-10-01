import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { FIREBASE_ENVS } from '../public/firebase-env.js';

const WORKFLOW = '.github/workflows/deploy-staging.yml';
const path = (rel) => new URL('../' + rel, import.meta.url);
const read = (rel) => readFileSync(path(rel), 'utf8');
/** 주석 줄을 뺀 본문. 「이렇게 쓰면 안 된다」를 적어 둔 주석에 걸리지 않게. */
const codeOnly = (src) => src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

const PROD_ID = FIREBASE_ENVS.prod.config.projectId;
const STAGING_ID = FIREBASE_ENVS.staging.config.projectId;

test('스테이징 배포 워크플로가 있다', () => {
  // 콘솔만 쓰는 사람에게는 Functions를 올리는 유일한 수단이다
  // (Firebase 콘솔에는 함수 배포 버튼이 없다)
  assert.ok(existsSync(path(WORKFLOW)), `${WORKFLOW}가 없습니다`);
});

test('직원 승인 수정 브랜치에서 서버 변경을 스테이징에 배포한다', () => {
  const src = codeOnly(read(WORKFLOW));
  assert.match(src, /- 'fix\/staff-single-approval-20261001'/,
    '프리뷰 브랜치가 배포 대상이 아니면 화면과 서버 버전이 달라집니다');
  assert.match(src, /- 'functions\/\*\*'/,
    '직원 승인 함수 변경이 배포를 시작하지 않습니다');
});

test('이 워크플로는 프로덕션을 절대 배포하지 않는다', () => {
  const src = read(WORKFLOW);

  // 스테이징 ID는 프로덕션 ID를 부분 문자열로 포함하므로, 그것을 지운 뒤에 찾는다
  const withoutStaging = src.split(STAGING_ID).join('«staging»');
  const hits = [...withoutStaging.matchAll(new RegExp(PROD_ID, 'g'))];
  assert.equal(hits.length, 0,
    `워크플로에 프로덕션 프로젝트 ID(${PROD_ID})가 ${hits.length}번 나옵니다`);

  assert.ok(!/--project\s+prod\b/.test(src), '워크플로에 --project prod가 있습니다');
  assert.ok(!/deploy:prod/.test(src), '워크플로가 프로덕션 배포 스크립트를 부릅니다');
});

test('배포 대상이 한 곳에 고정되어 있다', () => {
  const src = read(WORKFLOW);
  assert.match(src, new RegExp(`FIREBASE_PROJECT:\\s*${STAGING_ID}`),
    '대상 프로젝트가 env로 고정되어 있지 않습니다');

  // --project는 전부 그 변수를 써야 한다. 문자열을 직접 적으면 나중에 갈린다.
  for (const m of src.matchAll(/--project\s+(\S+)/g)) {
    assert.match(m[1], /^"?\$(\{)?FIREBASE_PROJECT/,
      `--project에 변수가 아닌 값이 들어 있습니다: ${m[1]}`);
  }
});

test('깨진 코드를 배포하지 않는다', () => {
  // check가 배포보다 뒤에 있으면 아무 의미가 없다
  const src = read(WORKFLOW);
  const check = src.indexOf('npm run check');
  const deploy = src.search(/^\s+firebase deploy/m);
  assert.ok(check > 0, '워크플로가 npm run check을 돌리지 않습니다');
  assert.ok(deploy > 0, '워크플로에서 배포 명령을 찾지 못했습니다');
  assert.ok(check < deploy, 'npm run check이 배포 뒤에 있습니다 — 검사 의미가 없습니다');
});

test('배포가 반쪽이면 실패로 끝난다', () => {
  // 예전에 겪은 것 — 배포했다고 나오는데 login이 없어 404였다.
  // 성공으로 끝나면 사람이 프리뷰에서 헤매게 된다.
  const src = read(WORKFLOW);
  assert.match(src, /functions:list/, '배포 후 함수 목록을 확인하지 않습니다');
  assert.match(src, /grep -qi 'login'/, 'login 함수 존재를 확인하지 않습니다');
  assert.match(src, /Access-Control-Request-Method/,
    '공개 호출 가능 여부(프리플라이트)를 확인하지 않습니다');
});

test('목록을 못 받은 것과 login 이 없는 것을 가른다', () => {
  // 예전에는 `firebase functions:list … | tee /tmp/fns.txt` 였다. 파이프라인의
  // 종료 상태는 **tee 의 것**이라(pipefail 이 없다) 목록 조회가 실패해도 0 으로
  // 넘어가고, 다음 grep 이 빈 파일을 훑어 **「login 이 없다」로 잘못 보고했다.**
  //
  // 실제로 그렇게 났다: 같은 잡에서 몇 초 전에
  // `functions[login] Successful update operation.` 과 `✔ Deploy complete!` 가
  // 찍혔는데도 배포가 반쪽인 것처럼 보였고, 배포를 의심하며 시간을 썼다.
  // 두 원인은 대응이 다르다 — 하나는 다시 배포, 하나는 다시 조회다.
  // **주석은 뺀다.** 왜 tee 를 쓰면 안 되는지 설명하느라 그 명령을 그대로
  // 적어 두었고, 그것까지 막으면 이유를 남길 수 없다.
  const src = codeOnly(read(WORKFLOW));
  assert.ok(!/functions:list[\s\S]{0,120}\|\s*tee/.test(src),
    'functions:list 를 tee 로 받습니다 — 조회 실패가 login 누락으로 둔갑합니다');
  assert.match(src, /if ! list_functions; then/,
    '목록 조회의 실패를 따로 보지 않습니다');
  assert.match(src, /배포 실패와는 다릅니다/,
    '조회 실패와 배포 실패를 가르는 문구가 없습니다');
});

test('목록 조회는 한 번 다시 시도한다 — 흔한 일시 오류다', () => {
  const src = read(WORKFLOW);
  const block = src.slice(src.indexOf('배포된 함수 확인'));
  const step = block.slice(0, block.indexOf('- name:', 10));
  assert.equal((step.match(/list_functions\b/g) || []).length >= 3, true,
    '재시도 없이 한 번만 조회합니다');
  assert.match(step, /sleep \d+/, '재시도 사이에 기다리지 않습니다');
});

test('자격증명을 저장소나 로그에 남기지 않는다', () => {
  const src = read(WORKFLOW);
  // 워크스페이스에 쓰면 다음 스텝의 액션이 업로드할 수 있다 → 홈에 둔다
  assert.match(src, /\$HOME\/sa\.json/, '서비스 계정 키를 홈 밖에 두고 있습니다');
  assert.ok(!/\$\{\{\s*github\.workspace\s*\}\}\/sa\.json/.test(src),
    '서비스 계정 키를 워크스페이스에 쓰고 있습니다');
  assert.match(src, /rm -f "\$HOME\/sa\.json"/, '작업 후 키를 지우지 않습니다');
  assert.match(src, /if: always\(\)/, '실패해도 키를 지우도록 되어 있지 않습니다');
  // 시크릿을 echo하면 마스킹돼도 습관이 나쁘다 — printf로 파일에만 쓴다
  assert.ok(!/echo\s+"?\$SA_JSON/.test(src), '시크릿을 echo하고 있습니다');
});

test('시크릿을 run 본문에 직접 박지 않는다', () => {
  // 실제로 겪은 일 — 시크릿을 등록했는데도 배포가 조용히 건너뛰어졌다.
  //
  //   if [ -n "${{ secrets.FIREBASE_SA_STAGING }}" ]; then
  //
  // ${{ }}는 **값을 스크립트 텍스트로 치환**한다. 서비스 계정 JSON에는
  // 큰따옴표와 줄바꿈이 있으므로 인용이 중간에 끊겨 `[: too many arguments`로
  // 죽고, if 조건의 실패는 무시되어 "시크릿이 없다"는 가지로 흘렀다.
  // 로그에서도 값은 ***로 가려져 원인이 보이지 않는다.
  //
  // env: 로 넘기면 값은 셸 변수에만 들어가고 문법을 건드리지 않는다.
  const src = read(WORKFLOW);
  const runBlocks = [...src.matchAll(/^(\s+)run: \|\n((?:\1\s.*\n|\n)*)/gm)];
  assert.ok(runBlocks.length > 0, 'run 블록을 찾지 못했습니다');
  for (const m of runBlocks) {
    assert.ok(!/\$\{\{\s*secrets\./.test(m[2]),
      'run 스크립트 안에서 시크릿을 ${{ secrets.* }}로 직접 참조합니다 — env로 넘기세요');
  }
});

test('시크릿이 없으면 배포에 들어가지 않는다', () => {
  const src = read(WORKFLOW);
  assert.match(src, /needs: preflight/, '배포가 준비 확인에 의존하지 않습니다');
  assert.match(src, /if: needs\.preflight\.outputs\.ready == 'true'/,
    '준비되지 않았을 때 배포를 막는 조건이 없습니다');

  const guard = src.indexOf('FIREBASE_SA_STAGING');
  const deploy = src.search(/^\s+firebase deploy/m);
  assert.ok(guard > 0 && guard < deploy, '시크릿 확인이 배포 뒤에 있습니다');
});

test('준비가 안 된 것 때문에 PR이 빨간불이 되지 않는다', () => {
  // 준비가 안 됐다는 이유로 계속 실패하면 나중에 진짜 실패를 가린다.
  // 자동 실행(push)은 건너뛰고, 사람이 직접 누른 실행만 실패로 알려준다.
  const src = read(WORKFLOW);
  assert.match(src, /ready=false/, '건너뛰기 경로가 없습니다');
  assert.match(src, /github\.event_name.*workflow_dispatch/s,
    '직접 실행과 자동 실행을 구분하지 않습니다');

  // 자동 실행에서 exit 1로 끝나면 안 된다 —
  // ready=false를 쓴 다음의 exit 1은 workflow_dispatch 조건 안에만 있어야 한다
  const skip = src.slice(src.indexOf('ready=false'));
  const firstExit = skip.indexOf('exit 1');
  assert.ok(firstExit > 0, '직접 실행 시 실패시키는 경로가 없습니다');
  const beforeExit = skip.slice(0, firstExit);
  assert.match(beforeExit, /workflow_dispatch/,
    'exit 1이 workflow_dispatch 조건 밖에 있습니다 — 자동 실행도 실패합니다');
});

test('건너뛸 때 무엇을 해야 하는지 요약에 남긴다', () => {
  // 사람이 로그를 뒤지지 않고도 다음에 할 일을 알 수 있어야 한다
  const src = read(WORKFLOW);
  const skip = src.slice(src.indexOf('ready=false'), src.indexOf('needs: preflight'));
  assert.match(skip, /GITHUB_STEP_SUMMARY/, '건너뛴 이유를 요약에 쓰지 않습니다');
  assert.match(skip, /STAGING\.md/, '어디를 보라는 안내가 없습니다');
});

test('문서에 명령어 없이 배포하는 절차가 있다', () => {
  // 이 워크플로는 사람이 시크릿을 넣어야 처음 돌아간다.
  // 그 절차가 없으면 워크플로만 있고 아무도 못 쓴다.
  const doc = read('STAGING.md');
  assert.match(doc, /명령어 없이/, 'STAGING.md에 명령어 없이 배포하는 절차가 없습니다');
  assert.match(doc, /FIREBASE_SA_STAGING/, '시크릿 이름이 문서에 없습니다');
  assert.match(doc, /콘솔에서 배포할 수 없/,
    'Functions를 콘솔에서 배포할 수 없다는 사실이 문서에 없습니다');
});

// ─────────────────────────────────────────────────────────────
// 검사 워크플로 — 초록불이 실제로 검사를 뜻하는가
//
// 이 저장소는 한동안 **테스트가 한 줄도 돌지 않는데 PR이 초록불**이었다.
// `npm run check`가 배포 잡 안에 있었고, 그 잡은 FIREBASE_SA_STAGING 시크릿이
// 있을 때만 돌았기 때문이다. 시크릿이 없으니 「준비 확인」에서 조용히 끝나고
// 성공으로 표시됐다. 게다가 그 워크플로는 functions·규칙·인덱스가 바뀔 때만
// 돌아서, public/만 고친 커밋은 아무 검사도 받지 않았다.
//
// 아래 세 가지가 그 상태로 되돌아가는 것을 막는다.
// ─────────────────────────────────────────────────────────────
const CI = '.github/workflows/ci.yml';

test('검사 워크플로가 있다', () => {
  assert.ok(existsSync(path(CI)), `${CI}가 없습니다`);
});

test('검사는 시크릿에 걸려 있지 않다', () => {
  // 시크릿이 없어서 건너뛴 것과 검사가 통과한 것은 화면에서 똑같이 보인다.
  const src = read(CI);
  assert.ok(!/secrets\./.test(src),
    '검사 워크플로가 시크릿을 참조합니다 — 시크릿이 없는 환경에서 조용히 건너뛰게 됩니다');
  assert.ok(!/needs\.\w+\.outputs\.ready/.test(src),
    '검사 워크플로에 준비 확인 게이트가 있습니다');
});

test('검사는 경로 필터 없이 PR의 모든 커밋에 돈다', () => {
  const src = read(CI);
  const onBlock = src.slice(src.indexOf('\non:'), src.indexOf('\nconcurrency:'));
  assert.ok(!/paths:/.test(onBlock),
    'on: 블록에 paths 필터가 있습니다 — 그 경로 밖의 변경은 검사를 받지 않습니다');
  // pull_request가 핵심이다. 이것이 있어야 PR에 올라오는 모든 커밋이 검사를 받는다.
  assert.match(onBlock, /pull_request:/, 'pull_request에 반응하지 않습니다');
  assert.match(onBlock, /push:/, '머지된 뒤 기본 브랜치를 검사하지 않습니다');
});

test('검사가 functions/ 의존성도 설치한다', () => {
  // functions/는 별도 package.json이다. 루트 npm ci는 그것을 설치하지 않는다.
  // test/receipt-extract.test.mjs가 functions/ai/*를 require하므로, 이 설치가
  // 빠지면 Functions 전용 AI SDK 의존성을 찾지 못한다.
  //
  // 로컬에서는 이미 설치돼 있어 드러나지 않는다 — 첫 CI 실행에서 잡힌 실패다.
  const src = read(CI);
  assert.match(src, /working-directory:\s*functions/,
    '검사 워크플로가 functions/ 의존성을 설치하지 않습니다');
});

test('규칙 잡의 JDK가 firebase-tools 요구 버전 이상이다', () => {
  // firebase-tools는 JDK 21 이상을 요구한다. 17이면 에뮬레이터가 뜨지 않고
  // "no longer supports Java version before 21"로 죽는다(첫 CI 실행에서 잡혔다).
  const src = read(CI);
  const m = src.match(/java-version:\s*'(\d+)'/);
  assert.ok(m, 'java-version이 지정돼 있지 않습니다');
  assert.ok(Number(m[1]) >= 21,
    `java-version이 ${m[1]}입니다 — firebase-tools는 21 이상을 요구합니다`);
});

test('GitHub Actions가 Node 24 기반 메이저를 사용한다', () => {
  const ci = read(CI);
  const deploy = read(WORKFLOW);

  for (const [name, src] of [['검사', ci], ['스테이징 배포', deploy]]) {
    assert.ok(!/actions\/(?:checkout|setup-node)@v4\b/.test(src),
      name + ' 워크플로에 Node 20 기반 v4 액션이 남아 있습니다');
    assert.match(src, /actions\/checkout@v7\b/,
      name + ' 워크플로가 checkout v7을 사용하지 않습니다');
    assert.match(src, /actions\/setup-node@v7\b/,
      name + ' 워크플로가 setup-node v7을 사용하지 않습니다');
  }

  assert.match(ci, /actions\/setup-java@v6\b/,
    '검사 워크플로가 Node 24 기반 setup-java v6을 사용하지 않습니다');
});

test('CI와 Functions 런타임이 Node 22로 일치한다', () => {
  const workflows = [read(CI), read(WORKFLOW)];
  for (const src of workflows) {
    const versions = [...src.matchAll(/node-version:\s*['"]?(\d+)/g)]
      .map((match) => match[1]);
    assert.ok(versions.length > 0, '워크플로에 node-version이 없습니다');
    assert.deepEqual([...new Set(versions)], ['22'],
      '워크플로 Node 버전이 22로 통일되지 않았습니다: ' + versions.join(', '));
  }

  const functionsPackage = JSON.parse(read('functions/package.json'));
  const functionsLock = JSON.parse(read('functions/package-lock.json'));
  const firebase = JSON.parse(read('firebase.json'));
  assert.equal(functionsPackage.engines?.node, '22',
    'functions/package.json의 런타임이 Node 22가 아닙니다');
  assert.equal(functionsLock.packages?.['']?.engines?.node, '22',
    'functions/package-lock.json의 런타임이 Node 22와 맞지 않습니다');
  assert.ok(firebase.functions.every((entry) => entry.runtime === 'nodejs22'),
    'firebase.json의 Functions 런타임이 nodejs22가 아닙니다');
  assert.match(read(WORKFLOW), /firebase-tools@15\.29\.0\b/,
    '스테이징 배포 CLI가 검증된 Firebase Tools 버전으로 고정되지 않았습니다');
});

test('검사가 실제로 테스트를 돌린다', () => {
  const src = read(CI);
  assert.match(src, /npm run check/, 'npm run check를 부르지 않습니다');
  assert.match(src, /npm run test:rules/,
    '보안 규칙 테스트를 돌리지 않습니다 — 규칙 잠금은 되돌리기가 가장 어려운 배포 단계입니다');
});
