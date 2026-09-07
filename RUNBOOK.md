# 1단계 실행 절차서 — 인증 전환 · 잔액 정정

> 운영 데이터를 건드리는 작업입니다. **배포 1 → 2 → 3 → 4 → 5 순서를 지키고,
> 각 단계의 확인 항목을 통과한 뒤 다음으로 넘어가세요.**
> 배경과 설계 근거는 `BUGFIX_PLAN.md` 「설계 6」에 있습니다.

## 0. 준비

### 0-1. Blaze 플랜 전환
Cloud Functions는 종량제(Blaze) 플랜이 필요합니다.
Firebase 콘솔 → 프로젝트 설정 → 사용량 및 결제 → 요금제 수정

이 앱 규모라면 무료 한도 안에 들어갈 가능성이 높지만, 예산 알림을 걸어두면 안전합니다.
콘솔에서 **예산 알림을 월 1만 원 정도로 설정**해 두세요.

### 0-1-b. 커스텀 토큰 서명 권한 부여 ⚠️ 빠뜨리면 배포 2에서 전원 로그인 불가

`login`은 비밀번호를 확인한 뒤 **커스텀 토큰에 서명**합니다. 서비스 계정 키 없이
도는 함수(정상입니다)는 이 서명을 IAM API에 맡기는데, 그러려면 실행 계정에
`iam.serviceAccounts.signBlob` 권한이 필요합니다.

**Cloud Functions 2세대의 기본 실행 계정에는 이 권한이 없습니다.** 1세대가 쓰던
App Engine 기본 계정에는 있었기 때문에, 2세대로 올리는 이번 전환에서 처음 걸립니다.

```bash
PROJECT_ID=smart-care-ledger
PROJECT_NUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

콘솔이라면 **IAM 및 관리자 → IAM** → `<프로젝트번호>-compute@developer.gserviceaccount.com`
→ 연필 → 역할 추가 → **서비스 계정 토큰 생성자**.

반영에 1~2분 걸립니다. 재배포는 필요 없습니다 — 권한은 실행 시점에 확인합니다.

> 이 단계를 빠뜨린 채 배포 2를 하면 **모든 로그인이 실패합니다.** 지금은 화면에
> `E_SIGNBLOB`과 조치 방법이 뜨므로 바로 알 수 있지만, 그때는 이미 사용자가
> 못 들어오는 상태입니다. **배포 1 전에 미리 해 두세요.**
>
> 배포 1 직후 스테이징에서 확인하는 방법: `STAGING.md` 참고.

### 0-1-c. 배포 직후 함수가 공개 호출 가능한지 확인

2세대 함수는 Cloud Run 서비스로 돕니다. 공개 호출이 막혀 있으면 브라우저의 사전
요청(OPTIONS)이 403으로 거부되고, 그 응답에는 CORS 헤더가 없어 **콘솔에는 "CORS
오류"로만 보입니다.** 원인을 찾기 가장 어려운 형태이므로 배포 1 직후에 확인합니다.

```bash
curl -i -X OPTIONS \
  -H "Origin: https://example.com" -H "Access-Control-Request-Method: POST" \
  https://asia-northeast3-smart-care-ledger.cloudfunctions.net/login
```

`204` + `access-control-allow-origin` 이면 정상입니다. `403`이면:

```bash
for FN in login signup approveStaff upsertStaff setStaffActive changePassword; do
  gcloud functions add-invoker-policy-binding "$FN" \
    --region=asia-northeast3 --project=smart-care-ledger --member=allUsers
done
```

> `gcloud run services`로 직접 해도 되지만 **Cloud Run 서비스 이름은 소문자**라
> `upsertstaff`처럼 적어야 합니다. 콘솔이라면 Cloud Run → 서비스 → 보안 탭 →
> "인증되지 않은 호출 허용".

`404`면 그 이름·리전에 함수가 없다는 뜻입니다 — 배포가 실제로 됐는지 보세요.

> 조직 정책 **도메인 제한 공유**(`constraints/iam.allowedPolicyMemberDomains`)가
> 켜져 있으면 `allUsers` 부여가 실패합니다. 그 경우 정책 예외가 필요합니다.
>
> 로그인 화면에는 이제 `E_UNREACHABLE`로 뜹니다.

### 0-2. 서비스 계정 키 발급
마이그레이션 스크립트가 Admin SDK로 접속하는 데 필요합니다.

Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → **새 비공개 키 생성**

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/안전한/경로/serviceAccountKey.json
```

> ⚠️ 이 키는 모든 보안 규칙을 우회합니다. 저장소에 커밋하지 마세요
> (`.gitignore`에 이미 등록되어 있습니다). 작업이 끝나면 콘솔에서 삭제하세요.

### 0-3. 백업
Firebase 콘솔 → Firestore → 가져오기/내보내기 → **내보내기**로 전체 백업을
먼저 만들어 두세요. 아래 모든 절차의 최후 복구 수단입니다.

### 0-4. 의존성 설치
```bash
npm install                      # 루트 (도구 스크립트용)
cd functions && npm install      # Cloud Functions
cd ..
npm install -g firebase-tools    # 이미 있으면 생략
firebase login
```

### 0-5. ⚠️ 배포 대상은 항상 명시합니다

`.firebaserc`의 **기본 별칭은 스테이징**입니다. `--project`를 빠뜨리면 실데이터가
아니라 스테이징으로 갑니다(안전한 쪽으로 틀리게 해 둔 것입니다).

| 하려는 것 | 명령 |
|---|---|
| 프로덕션 (실데이터) | `firebase deploy ... --project prod` |
| 스테이징 | `firebase deploy ... --project staging` |
| 확인만 | `firebase projects:list` · `firebase use` |

**이 절차서의 모든 명령에는 `--project prod`가 붙어 있습니다. 지우지 마세요.**
배포 후 `firebase functions:list --project prod`로 실제로 어디에 올라갔는지
확인하는 습관을 들이세요.

---

## 배포 1 — 데이터 준비 (앱 동작은 그대로)

이 단계가 끝나도 **사용자에게는 아무 변화가 없어야 정상**입니다.

```bash
# 1. Cloud Functions 배포 (아직 아무도 호출하지 않음)
firebase deploy --only functions --project prod

# 2. 복합 인덱스 배포 (없으면 거래 조회가 실패함)
firebase deploy --only firestore:indexes --project prod
#    콘솔 → Firestore → 색인 에서 '빌드 중'이 '사용 설정됨'이 될 때까지 기다립니다.

# 3. 마이그레이션 — 먼저 드라이런으로 무엇이 바뀌는지 확인
node tools/migrate-auth.mjs
```

드라이런 출력에서 다음을 확인하세요.

- `사전 점검 통과` 가 떴는가
  - **아이디 중복**이 보고되면 여기서 멈춥니다. 콘솔에서 사람이 정리해야 합니다
    (어느 계정이 진짜인지 기계가 판단할 수 없습니다).
- `관리자가 한 명도 없습니다` 경고가 없는가
- `매핑할 수 없는 teamLeader` 목록 — 있다면 어느 입주자인지 적어두세요.
  마이그레이션 후 담당 팀장을 다시 지정해야 합니다.

문제가 없으면 반영합니다.

```bash
node tools/migrate-auth.mjs --apply
```

### ✅ 배포 1 확인
- [ ] 기존 계정으로 로그인이 **여전히 정상**인가 (아직 아무것도 안 바뀐 게 정상)
- [ ] 거래 입력·보고서 조회가 정상인가
- [ ] 콘솔에서 `users` 컬렉션에 **로그인 아이디 이름의 새 문서**가 생겼는가
- [ ] 새 문서에 `password` 필드가 **없는가**
- [ ] `userSecrets` 컬렉션이 생겼고 문서 수가 직원 수와 맞는가

---

## 배포 2 — 앱 전환

```bash
firebase deploy --only hosting --project prod
```

이 배포에 포함된 변경:

| 항목 | 내용 |
|---|---|
| 로그인 | `httpsCallable('login')` → `signInWithCustomToken`. 비밀번호가 브라우저를 거치지 않고 서버에서 검증됩니다 |
| 세션 복원 | `onAuthStateChanged` + Firestore 재조회. **F5 로그아웃이 사라지고**, sessionStorage 역할 위조도 막힙니다 |
| 직원 등록·수정·승인·재직전환 | 전부 Cloud Functions 경유 (규칙이 `users` 클라이언트 쓰기를 차단) |
| 관리자 | 역할이 아니라 `isAdmin` 체크박스로 부여 |
| 입력자 거래 조회 | `where('createdBy','==',uid)`를 쿼리에 추가 (규칙상 필수) |
| 담당 입주자 판정 | `nav.staff` → 전용 키 `client.view.all`로 분리 |

### ✅ 배포 2 확인
- [ ] 각 역할(입력자·담당자·팀장·센터장) 및 관리자 플래그 계정으로 로그인되는가
- [ ] **입력자로 로그인해 거래내역이 보이는가** (쿼리가 거부되면 빈 목록 + 토스트 오류)
- [ ] 직원 등록·수정·승인·퇴사 처리가 동작하는가 (Functions 경유)
- [ ] 관리자 계정에서 설정 → 권한 탭과 전체 초기화가 여전히 보이는가
- [ ] **F5를 눌러도 로그인이 유지되는가** ← 기존 버그 해소 확인
- [ ] 개발자도구에서 `sessionStorage`를 조작해도 역할이 안 바뀌는가
- [ ] **팀장 계정에서 결재 대기 뱃지에 건수가 잡히는가**
      ← 마이그레이션 성공의 가장 좋은 신호입니다 (기존엔 항상 0건)

> 문제가 생기면 `auth.js`만 이전 버전으로 되돌리면 복구됩니다.
> 구 `users` 문서를 아직 지우지 않았기 때문입니다.

---

## 배포 3 — 잠금

**되돌리기 어려운 단계입니다.** 배포 2가 안정적으로 돌아가는 것을
하루 이상 확인한 뒤 진행하세요.

```bash
firebase deploy --only firestore:rules,storage:rules --project prod
```

### ✅ 배포 3 확인
```bash
# 로그아웃 상태에서 데이터가 새는지 직접 확인 — 거부되어야 정상
curl -s "https://firestore.googleapis.com/v1/projects/smart-care-ledger/databases/(default)/documents/users" | head -20
```
- [ ] 위 요청이 **PERMISSION_DENIED**로 거부되는가
- [ ] 입력자 계정에서 타인이 작성한 거래가 안 보이는가
- [ ] 모든 역할에서 평소 업무가 정상 동작하는가

확인이 끝나면 구 문서를 정리합니다 (문서 ID가 `usr_...` 이거나 자동 ID인 것들).
콘솔에서 직접 삭제하거나, 별도 정리 스크립트를 요청하세요.

---

## 배포 4 — 잔액 정정

**순서가 중요합니다.** 잔액 단일화 코드를 먼저 배포해야 합니다.
그렇지 않으면 재계산 직후 앱이 다시 망가뜨립니다.

이제 `currentBalance`는 **Cloud Functions 트리거가 소유**합니다.
클라이언트는 화면 표시용으로만 로컬 계산하고 Firestore에는 쓰지 않습니다.
(입력자는 보안 규칙상 계좌 전체 거래를 읽을 수 없어 클라이언트 계산이 불가능합니다)

| 트리거 | 언제 발동 | 하는 일 |
|---|---|---|
| `syncAccountBalance` | `transactions/*` 쓰기 | 해당 계좌 잔액 재계산. 계좌가 바뀐 수정이면 양쪽 모두 |
| `syncAccountOnSettingsChange` | `accounts/*`의 기초잔액·기준일 변경 | 그 계좌 잔액 재계산 (`currentBalance`만 바뀐 경우는 건너뛰어 루프 방지) |

```bash
# 1. 트리거 + 잔액 단일화 코드 배포
firebase deploy --only functions,hosting --project prod

# 2. 트리거가 실제로 도는지 먼저 확인
#    거래를 하나 저장한 뒤 로그를 본다
firebase functions:log --only syncAccountBalance --project prod
```

- [ ] 거래 저장 시 로그에 실행 기록이 남는가
- [ ] 해당 계좌 `currentBalance`가 Firestore에서 실제로 바뀌는가

트리거가 도는 것을 확인한 뒤 기존 손상분을 정정합니다.

```bash
# 3. 재계산 — 먼저 드라이런
node tools/recalc-balances.mjs
```

출력에서 확인하세요.

- **변경 대상이 많고 금액 차이가 큰 것이 정상입니다.** 그동안 손상돼 있었습니다.
- `⚠️ 기준일 경계 확인 필요` 목록이 나오면, 해당 계좌 **실제 통장과 대조**하세요.
  기초잔액이 기준일 당일 거래를 이미 포함한 값인지 판단해야 합니다.
  판단이 다르면 알려주세요 — `public/services/balance.js`의 한 줄 변경입니다.
- `기준일 없는 계좌`가 있으면 계좌 설정에서 기준일을 먼저 입력하세요.

```bash
node tools/recalc-balances.mjs --apply    # 백업 JSON을 자동 저장합니다
```

### ✅ 배포 4 확인
- [ ] 표본 계좌 3개를 손으로 검산 (기초잔액 + 기준일 이후 전체 거래)
- [ ] **대시보드 · 보고서 · 설정 계좌목록 세 화면의 숫자가 일치**하는가
- [ ] 거래를 하나 저장·수정·삭제한 뒤에도 계속 일치하는가 ← 재발 확인

---

## 배포 5 — 파생 문서 백필 ⚠️ 빠뜨리면 마감 잠금이 걸리지 않습니다

이 앱은 읽기를 줄이고 권한 충돌을 피하려고 **파생 문서** 세 종류를 씁니다.
전부 Cloud Functions 트리거가 유지하는데, **트리거는 배포 이후의 변경만 봅니다.**
그래서 배포 직후에는 전부 비어 있고, 한 번 채워 줘야 합니다.

| 문서 | 없으면 어떻게 되나 | 심각도 |
|---|---|---|
| `config/lockedMonths` | **최종 결재된 달이 잠기지 않습니다.** 마감된 월의 거래를 누구나 수정·삭제할 수 있게 됩니다 | ⚠️ 정확성 |
| `directories/staff` · `directories/categories` | 로그인마다 컬렉션 전체를 읽습니다(예전과 같음). 화면은 정상 | 비용 |
| `summaryCaches/*` | 대시보드가 당월 거래를 직접 읽습니다. 화면은 정상 | 비용 |

`summaryCaches`는 백필이 필요 없습니다 — 처음 보는 사람이 계산해서 채웁니다.
나머지 둘은 관리자 콜러블로 채웁니다.

**`lockedMonths`가 정확성 문제인 점에 주의하세요.** 나머지는 안 해도 예전처럼
동작할 뿐이지만, 이것은 안 하면 **마감이 풀린 상태로 운영이 시작됩니다.**

```bash
# 브라우저에서 관리자로 로그인한 뒤 콘솔에서:
#   (또는 설정 → 시스템 → 「파생 문서 다시 만들기」 버튼)
await window._fn.call('rebuildLockedMonths')()   # → { count: 잠긴 (입주자,월) 수 }
await window._fn.call('rebuildDirectories')()    # → { staff: N, categories: M }
```

### ✅ 배포 5 확인
- [ ] `rebuildLockedMonths`의 `count`가 최종 결재 완료된 (입주자, 월) 수와 맞는가
- [ ] 마감된 달의 거래를 수정하려 하면 **거부되는가** ← 이것이 핵심
- [ ] `rebuildDirectories`의 `staff`가 직원 수와 같은가
- [ ] 로그인 후 Firestore 콘솔 → 사용량에서 읽기 수가 줄었는가

> 이 콜러블들은 **복구 도구이기도 합니다.** 트리거가 실패해 명부나 색인이
> 어긋났다고 의심되면 언제든 다시 돌리면 됩니다 — 전체를 다시 만들므로
> 여러 번 돌려도 결과가 같습니다.

---

## 비용 알림 설정 (Blaze 전환 시 함께)

Blaze는 종량제입니다. 무료 한도를 넘으면 과금되므로 알림을 걸어 둡니다.

1. [Google Cloud 콘솔 → 결제 → 예산 및 알림](https://console.cloud.google.com/billing/budgets)
2. 예산 만들기 → 이 프로젝트 선택 → 월 예산 금액 입력 (예: 10,000원)
3. 임계값 50% / 90% / 100%에 이메일 알림

현재 사용량 모델은 `node tools/read-budget.mjs`로 볼 수 있습니다
(역할별 인원 × 하루 콜드 세션 수 → 일일 읽기 추정, 무료 한도 대비 사용률).
인원이 늘면 인자를 바꿔 다시 재 보세요:

```bash
node tools/read-budget.mjs --staff=30 --clients=60 --sessions=3
```

## 문제가 생기면

| 상황 | 대응 |
|---|---|
| 배포 1 중 사전 점검 실패 | 아무것도 안 바뀝니다. 보고된 항목을 정리 후 재실행 |
| 배포 2 후 로그인 불가 | `auth.js`를 이전 버전으로 되돌려 배포. 구 문서가 살아 있어 복구됩니다 |
| 배포 3 후 접근 거부 폭주 | `firestore.rules`를 이전 버전으로 되돌려 배포 (보안은 다시 열리므로 임시로만) |
| 배포 4 후 잔액이 이상 | `accounts-backup-*.json`으로 복원. 0-3의 전체 백업도 있습니다 |

각 단계에서 막히면 **에러 메시지 전문과 스크립트 출력을 그대로** 알려주세요.
