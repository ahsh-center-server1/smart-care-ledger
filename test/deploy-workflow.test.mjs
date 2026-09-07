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

test('시크릿이 없으면 배포 전에 멈추고 무엇이 없는지 알려준다', () => {
  const src = read(WORKFLOW);
  const guard = src.indexOf('FIREBASE_SA_STAGING 시크릿이 없습니다');
  const deploy = src.search(/^\s+firebase deploy/m);
  assert.ok(guard > 0, '시크릿 누락 안내가 없습니다');
  assert.ok(guard < deploy, '시크릿 확인이 배포 뒤에 있습니다');
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
