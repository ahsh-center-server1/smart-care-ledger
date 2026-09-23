# 배포 런타임

버전: 1.0.0

## 목표

- GitHub Actions는 Node 24 기반 공식 메이저를 사용한다.
- CI와 스테이징 배포는 Node 22에서 실행한다.
- Cloud Functions 런타임은 `nodejs22`로 고정한다.
- 배포 CLI 버전은 루트 개발 의존성과 맞춘다.

## 구성

- `actions/checkout@v7`
- `actions/setup-node@v7`
- `actions/setup-java@v6`
- `node-version: '22'`
- `functions/package.json`의 `engines.node: "22"`
- `firebase.json`의 `runtime: "nodejs22"`
- `firebase-tools@15.29.0`

## 검증

- `test/deploy-workflow.test.mjs`
- Node 22 전체 단위 테스트
- GitHub Actions 검사
- 스테이징 Functions 배포와 공개 호출 확인

## 변경 이력

- v1.0.0: Actions Node 24 호환 메이저 확인, CI·Functions Node 22 전환