# 테스트 환경 — 스테이징 · 에뮬레이터

> 실데이터를 건드리지 않고 앱 전체를 눌러보기 위한 절차서입니다.
> 운영 배포 절차는 `RUNBOOK.md`, 변경 배경은 `BUGFIX_PLAN.md`를 보세요.

## 어떤 프로젝트에 붙는지는 호스트명이 정한다

빌드 단계가 없는 앱이라(ES 모듈을 그대로 서빙) 접속 대상은 **실행 시점 호스트명**으로
정합니다. 판정 규칙과 설정값은 `public/firebase-env.js` 한 곳에 있습니다.

| 접속 주소 | 붙는 곳 |
|---|---|
| `smart-care-ledger.web.app` · `.firebaseapp.com` | **프로덕션** (실데이터) |
| Vercel 프리뷰 · 스테이징 Hosting · localhost · 그 외 전부 | **스테이징** |
| 아무 주소 + `?env=emulator` | **로컬 에뮬레이터** |

**기본값이 스테이징인 것이 안전장치입니다.** 새 미리보기 URL이 생겨도 실데이터에
붙지 않습니다. 프로덕션은 `PROD_HOSTNAMES`에 적힌 호스트에서만 열립니다.

`?env=prod` / `?env=staging` / `?env=emulator`로 직접 고를 수 있고, 고른 값은 그 탭에
남습니다(새로고침해도 유지). 운영 URL은 이 값과 무관하게 언제나 프로덕션입니다.

프로덕션이 아닌 환경에서는 화면 오른쪽 위에 **주황색 표시**가 뜹니다. 스테이징을
실서비스로 착각한 채 입력하는 사고를 막는 장치이니 지우지 마세요.

---

## 방법 A — 로컬 에뮬레이터 (권장, Blaze 불필요)

Firebase 프로젝트도 결제 수단도 필요 없습니다. Firestore·Auth·Functions·Storage가
전부 로컬에서 돕니다. **Cloud Functions 로그인을 확인할 수 있는 유일한 무료 경로입니다.**

준비물: Node 20+, Java 11+ (Firestore 에뮬레이터가 씁니다), `npm i -g firebase-tools`

```bash
npm install                      # 루트 (도구 스크립트가 firebase-admin을 씁니다)
cd functions && npm install && cd ..

npm run emu                      # 에뮬레이터 기동 (이 터미널은 그대로 둡니다)
```

다른 터미널에서 데이터를 넣습니다.

```bash
npm run emu:seed -- --apply      # 계정·입주자·계좌·거래 시드
```

브라우저에서 **http://localhost:5000/?env=emulator** 를 엽니다.
(에뮬레이터 UI는 http://localhost:4000)

| 아이디 | 이름 | 역할 |
|---|---|---|
| `center` | 김센터 | 센터장 + 관리자 |
| `leader` | 박팀장 | 팀장 |
| `staff` | 이담당 | 담당자 |
| `typist` | 최입력 | 입력자 |

비밀번호는 모두 `staging1234` (`--password`로 바꿀 수 있습니다).

> `?env=emulator`를 빼먹으면 스테이징 **클라우드** 프로젝트에 붙습니다.
> 오른쪽 위 표시에 `에뮬레이터`인지 `스테이징`인지 나옵니다.

에뮬레이터 데이터는 종료하면 사라집니다. 유지하려면
`firebase emulators:start --project staging --import ./.emu --export-on-exit`.

---

## 방법 B — 스테이징 Firebase 프로젝트

Vercel 프리뷰 URL처럼 **실제로 배포된 주소**에서 확인해야 할 때 씁니다.
보안 규칙이 진짜 Firebase 위에서 도는지 보는 것도 여기서만 가능합니다.

### 최초 1회 (사람이 콘솔에서)

1. 새 프로젝트 생성 — ID를 `.firebaserc`의 `staging` 별칭과 맞춥니다
   (현재 `smart-care-ledger-staging`).
2. 웹 앱 등록 → 발급된 설정을 `public/firebase-env.js`의 `FIREBASE_ENVS.staging.config`에
   반영합니다. (테스트가 프로덕션 값과 겹치면 실패시킵니다.)
3. Firestore 활성화 — 리전은 프로덕션과 같은 **`asia-northeast3`(서울)**.
4. Storage 활성화.
5. **Authentication → 시작하기**를 눌러 활성화합니다. 로그인 제공업체는 켤 필요가
   없습니다(커스텀 토큰만 씁니다). 이걸 빼먹으면 로그인이 `auth/configuration-not-found`로 실패합니다.
6. **Blaze(종량제) 플랜으로 전환합니다.** 이 앱의 로그인은 Cloud Functions를 거치므로
   Functions 없이는 아무도 로그인할 수 없습니다. 스테이징은 호출량이 거의 없어
   무료 한도 안에 머물지만, 예산 알림을 걸어두면 안전합니다.
7. **함수 실행 서비스 계정에 "서비스 계정 토큰 생성자" 역할을 부여합니다.**
   ← 콘솔에서 잊기 가장 쉬운 단계입니다. 아래 설명 참고.

> 3~4번까지만 하고 5~7번을 건너뛰면 화면은 뜨지만 로그인이 되지 않습니다.
> 그 경우 방법 A(에뮬레이터)를 쓰세요.

### 7번이 왜 필요한가 — 로그인이 `INTERNAL`로 실패하는 원인

`login` 함수는 비밀번호를 확인한 뒤 **커스텀 토큰에 서명**해야 합니다. 서비스 계정
키 없이 도는 함수(정상입니다)는 이 서명을 IAM API(`iamcredentials...:signBlob`)에
맡기는데, 그러려면 실행 계정에 `iam.serviceAccounts.signBlob` 권한이 있어야 합니다.

**Cloud Functions 2세대의 기본 실행 계정에는 이 권한이 없습니다.** 1세대가 쓰던
App Engine 기본 계정에는 있었기 때문에, 2세대로 만든 새 프로젝트에서만 걸립니다.
Blaze도 켜고 Authentication도 켰는데 로그인만 안 되는 상태가 이것입니다.

콘솔에서: **IAM 및 관리자 → IAM** → `<프로젝트번호>-compute@developer.gserviceaccount.com`
→ 연필 → 역할 추가 → **서비스 계정 토큰 생성자**

또는 CLI로:

```bash
PROJECT_ID=smart-care-ledger-staging
PROJECT_NUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

반영에 1~2분 걸립니다. 그 뒤 다시 로그인해 보세요. **함수를 다시 배포할 필요는
없습니다** — 권한은 실행 시점에 확인합니다.

> 이제 이 상태에서 로그인하면 화면에 `E_SIGNBLOB`과 무엇을 해야 하는지가 뜹니다.
> 예전에는 "로그인 실패. 다시 시도하세요."만 나와 단서가 없었습니다.

### 배포

```bash
cd functions && npm install && cd ..

firebase deploy --project staging                      # 전부
npm run deploy:staging:rules                           # 규칙·인덱스·Storage만
```

인덱스는 콘솔 → Firestore → 색인에서 **'빌드 중'이 '사용 설정됨'이 될 때까지** 기다립니다.
빌드 전에는 거래 조회가 실패하고 대시보드가 0원으로 보입니다.

### 데이터 넣기

두 가지 방법이 있습니다.

**① 회원가입 (스크립트 불필요)** — `users`가 비어 있으면 `signup`이 첫 계정을
**관리자 + 승인완료**로 만듭니다. 로그인 화면에서 가입하면 바로 들어갑니다.
그 다음은 설정 → 초기 설정 마법사가 분류·입주자·계좌를 안내합니다.

> 스테이징 브랜치 문서에 있던 *"Firestore 콘솔에서 users 문서를 직접 만들라"*는
> 이제 통하지 않습니다. 비밀번호는 `userSecrets`의 scrypt 해시로만 검증하므로
> 평문 `password` 필드가 있는 문서로는 로그인되지 않습니다.

**② 시드 스크립트** — 역할별 계정 4개와 거래 데이터를 한 번에 만듭니다.
권한·결재·잔액을 확인하려면 이쪽이 빠릅니다.

```bash
# 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성
export GOOGLE_APPLICATION_CREDENTIALS=/안전한/경로/staging-key.json

node tools/seed-staging.mjs                 # 드라이런 — 무엇이 생길지만 출력
node tools/seed-staging.mjs --apply         # 실제 생성
node tools/seed-staging.mjs --apply --wipe  # 기존 데이터를 지우고 새로
```

> 이 스크립트는 **프로덕션 프로젝트 ID를 거부합니다.** 스테이징 키를 쓰세요.
> 서비스 계정 키는 커밋하지 마세요(`.gitignore`에 등록되어 있습니다).

---

## 규칙·인덱스를 고쳤을 때의 순서

`firestore.rules` / `firestore.indexes.json` / `storage.rules`는 브랜치별로 분리되지
않습니다(백엔드는 하나입니다). 그래서 프로덕션에 바로 올리지 않습니다.

1. 브랜치에서 규칙을 고친다
2. `npm run deploy:staging:rules`
3. 프리뷰 URL(또는 `?env=staging`)에서 확인 — 특히 **역할별로** 각각 로그인해서
4. 통과하면 `firebase deploy --only firestore:rules,firestore:indexes,storage`
5. 병합

---

## 무엇을 확인하면 되는지

시드 데이터는 이 앱에서 실제로 틀렸던 것들을 확인할 수 있게 구성돼 있습니다.

| 확인 | 방법 | 통과 기준 |
|---|---|---|
| 입력자 범위 제한 | `typist`로 로그인 | 입주자 1명(홍길동)만, 본인이 쓴 거래 2건만. 보고서·설정 탭 없음 |
| 잔액 일치 | 대시보드 · 보고서 · 설정 계좌 목록 | 세 곳의 숫자가 같다 |
| 기준일 경계 | 계좌 "생활비 통장" | 기초 500,000원 + 기준일 **다음날부터**의 합계 |
| 취소 거래 | 승인취소 25,000원 | 잔액·집계 모두에서 빠져 있다 |
| 환불 | 마트 반품 −8,500원 | 잔액이 8,500원 늘어난다 |
| 자산이동 | 생활비 −100,000 / 저축 +100,000 | 두 계좌 모두 반영. 한쪽만 지우면 막힌다 |
| 결재 흐름 | `staff` 제출 → `leader` 결재 → `center` 최종 | 단계를 건너뛸 수 없다 |
| 결재 대기 알림 | `staff` 제출 후 `leader`로 로그인 | 네비 뱃지에 건수가 잡힌다 |
| 세션 유지 | 로그인 후 F5 | 로그인 화면으로 돌아가지 않는다 |
| 권한 위조 차단 | 개발자도구에서 `sessionStorage` 조작 후 F5 | 역할이 바뀌지 않는다 |
| 규칙 차단 | 로그아웃 상태로 Firestore REST 호출 | 거부된다 |

---

## 자주 막히는 곳

화면에 `E_...` 코드가 뜨면 그 줄이 곧 원인입니다. 더 자세한 내용은
`firebase functions:log --project staging` 에 남습니다.

| 화면에 뜨는 것 | 원인 | 고치는 법 |
|---|---|---|
| `E_SIGNBLOB` | 실행 서비스 계정에 토큰 서명 권한이 없다 (**2세대 신규 프로젝트의 기본 상태**) | 위 「7번이 왜 필요한가」 |
| `E_NO_AUTH` | Authentication 미활성화 | 콘솔 → Authentication → 시작하기 |
| `E_NO_FIRESTORE` | Firestore 데이터베이스가 없다 | 콘솔 → Firestore Database → 만들기 |
| `E_FIRESTORE_PERM` | 실행 계정이 Firestore에 접근 못 한다 | `roles/datastore.user` 부여 |
| `E_BILLING` | Blaze 미전환 | 콘솔 → 사용량 및 결제 |

| 그 밖의 증상 | 원인 |
|---|---|
| "로그인 실패. 다시 시도하세요."만 뜬다 | 진단되지 않은 오류다. `firebase functions:log`를 보세요 |
| 로그인 요청이 아예 안 나간다 | Functions가 배포되지 않았거나(스테이징) 에뮬레이터가 안 떠 있다 |
| 대시보드가 전부 0원 | 복합 인덱스가 아직 빌드 중이다 |
| 오른쪽 위 표시가 없다 | 프로덕션에 붙어 있다. **입력하지 마세요** |
| 에뮬레이터인데 데이터가 안 보인다 | `?env=emulator` 없이 열어 스테이징 클라우드에 붙었다 |
| `npm run emu`가 Java 오류 | Firestore 에뮬레이터는 Java 11+가 필요하다 |
