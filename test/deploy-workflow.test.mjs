import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { FIREBASE_ENVS } from '../public/firebase-env.js';

const WORKFLOW = '.github/workflows/deploy-staging.yml';
const path = (rel) => new URL('../' + rel, import.meta.url);
const read = (rel) => readFileSync(path(rel), 'utf8');

const PROD_ID = FIREBASE_ENVS.prod.config.projectId;
const STAGING_ID = FIREBASE_ENVS.staging.config.projectId;

test('스테이징 배포 워크플로가 있다', () => {
  // 콘솔만 쓰는 사람에게는 Functions를 올리는 유일한 수단이다
  // (Firebase 콘솔에는 함수 배포 버튼이 없다)
  assert.ok(existsSync(path(WORKFLOW)), `${WORKFLOW}가 없습니다`);
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

test('검사는 경로 필터 없이 모든 푸시에 돈다', () => {
  const src = read(CI);
  const onBlock = src.slice(src.indexOf('\non:'), src.indexOf('\nconcurrency:'));
  assert.ok(!/paths:/.test(onBlock),
    'on: 블록에 paths 필터가 있습니다 — 그 경로 밖의 변경은 검사를 받지 않습니다');
  assert.match(onBlock, /push:/, 'push에 반응하지 않습니다');
});

test('검사가 실제로 테스트를 돌린다', () => {
  const src = read(CI);
  assert.match(src, /npm run check/, 'npm run check를 부르지 않습니다');
  assert.match(src, /npm run test:rules/,
    '보안 규칙 테스트를 돌리지 않습니다 — 규칙 잠금은 되돌리기가 가장 어려운 배포 단계입니다');
});
