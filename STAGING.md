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
npm run setup                    # 루트 + functions 를 함께 설치
                                 # (예전 postinstall 은 설치 안에서 설치를 불러
                                 #  Windows npm 11 에서 멈췄습니다 — 이제 이 한 줄입니다)

npm run emu                      # 에뮬레이터 기동 (이 터미널은 그대로 둡니다)
```

다른 터미널에서 데이터를 넣습니다.

```bash
npm run emu:seed -- --apply      # 계정·입주자·계좌·거래 시드
```

### ⚠ 시드 다음에 **권한 백필**을 해야 합니다

시드는 `users`·`clients` 만 만듭니다. 판정 근거인 `authz/{uid}` 문서는
`backfillAuthz` 콜러블이 만듭니다(배포 순서 §10-2 의 2번과 같은 단계입니다).

빠뜨리면 로그인은 되는데 **모든 결재 동작이 이렇게 거부됩니다.**

```
권한 정보가 아직 준비되지 않았습니다. 관리자에게 권한 백필을 요청하세요.
```

`center` 로 로그인한 뒤 설정에서 실행하거나, 아래 한 줄이 전부 대신합니다.

```bash
npm run emu:roundtrip            # 에뮬레이터 기동 → 시드 → 백필 → 결재 왕복 → 종료
```

`emu:roundtrip` 은 네 역할이 실제로 로그인해서 보고서를 제출·반려·재제출·
1차 결재·최종 결재·결재 취소까지 밟아 보고, 역할 분리와 단계 건너뛰기 방지도
확인합니다. CI 의 「결재 왕복」 잡이 같은 것을 돌립니다.

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

### ⚠ 폐쇄망에서 Functions 에뮬레이터가 기동하지 않을 때

증상은 이렇습니다 — 콜러블이 **전부 정상 초기화된 뒤** 마지막에 죽습니다.

```
✔  functions[asia-northeast3-applyReportTransition]: http function initialized ...
⚠  Error adding firestore function: FirebaseError: Unable to parse JSON:
   SyntaxError: Unexpected token 'r', "request bl"... is not valid JSON
```

Functions 에뮬레이터는 **Firestore 트리거를 등록할 때**
`firebase-public.firebaseio.com` 에 접속합니다. 그 호스트가 이그레스 정책에
막히면 프록시가 JSON 이 아닌 「request blocked」를 돌려주고, 그 파싱 실패로
에뮬레이터 전체가 내려갑니다. 파서·권한과는 아무 관계가 없습니다.

트리거를 뺀 진입점으로 띄우면 콜러블은 전부 쓸 수 있습니다.

```bash
cat > functions/index.callables-only.js <<'EOF'
const all = require('./index.js');
for (const [name, fn] of Object.entries(all)) {
  const ep = fn && fn.__endpoint;
  if (ep && (ep.eventTrigger || ep.scheduleTrigger)) continue;
  exports[name] = fn;
}
EOF
# functions/package.json 의 "main" 을 잠시 이 파일로 바꾼 뒤 기동합니다.
```

> 이때 빠지는 것은 트리거 6개입니다(`syncAccountBalance` ·
> `syncAccountOnSettingsChange` · `syncStaffDirectory` · `syncCategoryDirectory` ·
> `syncSummaryVersion` · `cleanupReceiptJobs`). **잔액과 파생 명부가 자동으로
> 갱신되지 않으므로** 그 두 가지를 확인하는 시험에는 쓸 수 없습니다.
> 결재 왕복·권한 판정에는 영향이 없습니다.
>
> 끝나면 `main` 을 `index.js` 로 되돌리세요. GitHub 러너는 이그레스가 열려
> 있어 이 우회가 필요 없습니다.

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
8. 배포 후 **함수가 공개 호출 가능한지 확인합니다.** 보통 `firebase deploy`가
   알아서 열어 주지만, 막혀 있으면 브라우저에 CORS 오류로 보입니다. 바로 아래 설명.

> 3~4번까지만 하고 5~8번을 건너뛰면 화면은 뜨지만 로그인이 되지 않습니다.
> 그 경우 방법 A(에뮬레이터)를 쓰세요.
>
> **로그인이 안 될 때는 브라우저 콘솔부터 보세요.** CORS 오류가 있으면 8번,
> 화면에 `E_...` 코드가 뜨면 그 코드가 곧 원인입니다.

### 배포한 함수를 브라우저가 부를 수 있어야 한다 (CORS 오류로 보이는 것)

콘솔에 이렇게 뜨면 **함수 코드까지 가지도 못한 것**입니다.

```
Access to fetch at 'https://asia-northeast3-<project>.cloudfunctions.net/login'
has been blocked by CORS policy: Response to preflight request doesn't pass
access control check: No 'Access-Control-Allow-Origin' header is present
```

`onCall`은 CORS를 스스로 처리합니다(`cors` 기본값 `true`). 그러니 이 오류는
**우리 함수의 응답이 아닙니다.** 브라우저가 보낸 사전 요청(OPTIONS)을 구글 쪽에서
먼저 거부한 것이고, 그 거부 응답에는 CORS 헤더가 없어 브라우저가 "CORS 오류"라고
표시할 뿐입니다. 원인은 둘 중 하나입니다.

| 실제 응답 | 뜻 | 고치는 법 |
|---|---|---|
| **403** | 함수가 공개 호출 불가 상태 | 아래 `allUsers` 부여 |
| **404** | 그 이름·리전에 함수가 없다 | 배포 확인 (`--project staging`, 리전 `asia-northeast3`) |

#### 어느 쪽인지 가리기 — 터미널 없이도 됩니다

**함수 주소를 새 탭에서 그대로 엽니다.** 주소창 이동은 CORS 검사를 받지 않으므로
진짜 응답이 보입니다. 로그인 실패 안내(`E_UNREACHABLE`)에 그 주소가 함께 뜹니다.

```
https://asia-northeast3-smart-care-ledger-staging.cloudfunctions.net/login
```

| 화면에 보이는 것 | 뜻 |
|---|---|
| `Error: Forbidden` · `Your client does not have permission` | **403** — 공개 호출 불가. 아래 조치 |
| `Error: Not Found` · `Page not found` | **404** — 그 이름·리전에 함수가 없다. 배포 확인 |
| `Bad Request` · `Method Not Allowed` · JSON 오류 | 함수는 **살아 있다.** 원인은 다른 곳 |

터미널을 쓸 수 있다면 사전 요청을 직접 보내는 쪽이 더 정확합니다.

```bash
curl -i -X OPTIONS \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  https://asia-northeast3-smart-care-ledger-staging.cloudfunctions.net/login
```

`204` + `access-control-allow-origin` 이면 정상입니다.

#### 403일 때 — 공개 호출 열기

**콘솔에서 (gcloud 없이):** Google Cloud 콘솔 → **Cloud Run** → 리전
`asia-northeast3` → 서비스 `login` 클릭 → **보안(Security)** 탭 →
인증에서 **"인증되지 않은 호출 허용"** 선택 → 저장. 콜러블 6개에 각각 합니다.

**CLI로:**

```bash
PROJECT_ID=smart-care-ledger-staging
for FN in login signup approveStaff upsertStaff setStaffActive changePassword; do
  gcloud functions add-invoker-policy-binding "$FN" \
    --region=asia-northeast3 --project="$PROJECT_ID" --member=allUsers
done
```

> `gcloud functions`(2세대를 아는 명령)를 씁니다. `gcloud run services`로 직접
> 할 수도 있지만 **Cloud Run 서비스 이름은 소문자**라 `upsertstaff`처럼 적어야
> 하고, 그대로 `upsertStaff`를 넣으면 "서비스 없음"이 납니다.
> 실제 이름은 `gcloud run services list --region=asia-northeast3`로 확인하세요.

> 2세대 함수는 Cloud Run 서비스로 돕니다. `firebase deploy`가 보통 공개 호출을
> 열어 주지만, 조직 정책 **도메인 제한 공유**(`constraints/iam.allowedPolicyMemberDomains`)가
> 켜져 있으면 `allUsers` 부여가 조용히 실패합니다. 회사·학교 계정으로 만든
> 프로젝트에서 흔합니다. 그 경우 정책 예외를 두거나 개인 프로젝트를 쓰세요.

#### 404일 때 — 정말 배포됐는지

Firebase 콘솔 → **Functions** 목록에 6개가 있고 리전이 `asia-northeast3`인지 봅니다.
비어 있으면 배포가 안 된 것입니다.

```bash
firebase deploy --only functions --project staging
```

배포 로그 끝에 `functions[asia-northeast3-login]` 같은 줄이 6개 나와야 합니다.

### 7번이 왜 필요한가 — 토큰 서명 권한

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

### 명령어 없이 배포하기 (GitHub Actions) ⭐ 콘솔만 쓰는 경우

> **Cloud Functions는 Firebase 콘솔에서 배포할 수 없습니다.** 콘솔의 Functions
> 탭은 이미 배포된 것을 보고·삭제만 합니다. 소스를 올리는 버튼이 없습니다.
> 그래서 콘솔만으로는 로그인 함수를 올릴 방법이 없고, 프리뷰에서 계속 404가 납니다.

저장소의 `.github/workflows/deploy-staging.yml`이 그 일을 대신합니다.
**준비는 한 번만, 전부 클릭입니다.**

#### 준비 (한 번만)

**1. 배포용 서비스 계정 만들기**

Google Cloud 콘솔 → 프로젝트를 `smart-care-ledger-staging`으로 선택 →
**IAM 및 관리자 → 서비스 계정** → **서비스 계정 만들기**
- 이름: `github-deployer`
- 역할: **소유자(Owner)**

> 소유자 권한을 주는 이유 — 함수 배포에는 Cloud Functions·Cloud Run·Artifact
> Registry·Cloud Build·Eventarc 권한이 모두 필요해서, 개별로 주면 단계가 많고
> 하나만 빠져도 실패합니다. **스테이징에는 실데이터가 없으므로** 받아들일 수 있는
> 거래입니다. **프로덕션에는 절대 이렇게 하지 마세요.**

**2. 키 내려받기**

만든 계정 클릭 → **키** 탭 → **키 추가 → 새 키 만들기 → JSON** → 파일이 내려받아집니다.

**3. GitHub에 넣기**

GitHub 저장소 → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**
- Name: `FIREBASE_SA_STAGING`
- Secret: 내려받은 JSON 파일을 **메모장으로 열어 전체 내용을 붙여넣기**

> 붙여넣은 뒤 **내려받은 파일은 삭제하세요.** 이 키는 스테이징 프로젝트의
> 모든 권한을 가집니다.

**4. 필요한 API 켜기**

Google Cloud 콘솔 → **API 및 서비스 → 라이브러리**에서 검색해 각각 **사용**:
`Cloud Functions`, `Cloud Build`, `Artifact Registry`, `Cloud Run`, `Eventarc`

(Blaze 전환 후 자동으로 켜지는 경우도 많습니다. 배포가 "API가 사용 설정되지
않았습니다"로 실패하면 그 오류 메시지에 켜는 링크가 함께 나옵니다.)

#### 돌리기

**자동** — 이 브랜치에 `functions/`나 규칙 파일이 바뀌어 올라가면 알아서 배포됩니다.
GitHub 저장소 → **Actions** 탭에서 진행 상황을 봅니다.

**직접** — Actions 탭 → 왼쪽에서 **스테이징 배포** → **Run workflow**
- `테스트 데이터도 넣기`를 켜면 역할별 계정 4개와 거래까지 만들어 줍니다.

> "Run workflow" 버튼은 워크플로 파일이 **기본 브랜치(main)에 있을 때** 나타납니다.
> 아직 병합 전이면 자동 배포(푸시 트리거)만 동작합니다.

#### 결과 읽기

작업이 끝나면 요약에 다음이 표시됩니다.

| 표시 | 뜻 |
|---|---|
| ✅ 초록 체크 | 배포 완료 + 브라우저에서 부를 수 있음까지 확인됨 |
| `login 함수가 목록에 없습니다` | 배포가 반쪽입니다. 위쪽 배포 로그를 봅니다 |
| `403 — 공개 호출 불가` | 아래 「403일 때」를 합니다 |
| `FIREBASE_SA_STAGING 시크릿이 없습니다` | 위 준비 3단계가 안 됐습니다 |
| `키가 '...' 프로젝트 것입니다` | 프로덕션 키를 넣었습니다. 스테이징에서 새로 만드세요 |

> ⚠️ **초록 체크가 곧 배포는 아닙니다.** 시크릿이 없을 때 자동 실행은 조용히
> 건너뛰도록 설계돼 있어(준비가 안 됐다는 이유로 PR이 계속 빨간불이 되지
> 않게), 전체 실행은 `success`로 표시됩니다. **실제로 배포됐는지는 잡 목록에서
> 「Functions · 규칙 · 인덱스」가 `skipped`가 아닌지로 봅니다.** 몇 초 만에
> 끝났다면 건너뛴 것입니다.
>
> 시크릿을 분명히 넣었는데도 건너뛴다면 「준비 확인」 잡의 로그를 봅니다.
> `[: too many arguments`가 보이면 시크릿 검사가 값 때문에 깨진 것입니다 —
> 시크릿을 `run` 본문에 `${{ secrets.* }}`로 직접 박으면 JSON 안의 큰따옴표가
> 셸 인용을 끊습니다. `env:`로 넘겨야 합니다
> (`test/deploy-workflow.test.mjs`의 「시크릿을 run 본문에 직접 박지 않는다」가
> 이것을 막습니다).

워크플로는 배포 전에 `npm run check`(ESLint + 테스트)를 돌립니다.
검사에서 막히면 배포는 시작되지 않습니다.

> 이 워크플로는 **스테이징만** 배포합니다. 프로덕션 프로젝트 ID가 파일에 들어가면
> 테스트(`test/deploy-workflow.test.mjs`)가 실패합니다.

### 배포 (명령어를 쓸 수 있는 경우)

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
| `E_UNREACHABLE` | 브라우저가 함수에 닿지 못했다 (403 비공개 / 404 미배포 / 네트워크) | 위 「배포한 함수를 브라우저가 부를 수 있어야 한다」 |
| `E_SIGNBLOB` | 실행 서비스 계정에 토큰 서명 권한이 없다 (**2세대 신규 프로젝트의 기본 상태**) | 위 「7번이 왜 필요한가」 |
| `E_NO_AUTH` | Authentication 미활성화 | 콘솔 → Authentication → 시작하기 |
| `E_NO_FIRESTORE` | Firestore 데이터베이스가 없다 | 콘솔 → Firestore Database → 만들기 |
| `E_FIRESTORE_PERM` | 실행 계정이 Firestore에 접근 못 한다 | `roles/datastore.user` 부여 |
| `E_BILLING` | Blaze 미전환 | 콘솔 → 사용량 및 결제 |

| 그 밖의 증상 | 원인 |
|---|---|
| "로그인 실패. 다시 시도하세요."만 뜬다 | 서버까지는 갔는데 진단되지 않은 오류다. `firebase functions:log`를 보세요 |
| 콘솔에 CORS 오류 | 함수에 닿지 못한 것이다. 위 표의 `E_UNREACHABLE` 참고 |
| `manifest.json`이 `vercel.com/sso-api`로 리다이렉트 | Vercel 배포 보호(SSO)가 켜져 있다. 로그인 자체와는 무관하지만 PWA 설치가 안 된다. Vercel → Settings → Deployment Protection |
| 콘솔에 `cdn.tailwindcss.com should not be used in production` | 예전부터 있던 경고다. 동작에는 영향 없다 |
| 대시보드가 전부 0원 | 복합 인덱스가 아직 빌드 중이다 |
| 오른쪽 위 표시가 없다 | 프로덕션에 붙어 있다. **입력하지 마세요** |
| 에뮬레이터인데 데이터가 안 보인다 | `?env=emulator` 없이 열어 스테이징 클라우드에 붙었다 |
| `npm run emu`가 Java 오류 | Firestore 에뮬레이터는 Java 11+가 필요하다 |
