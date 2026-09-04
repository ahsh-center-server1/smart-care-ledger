# Smart Care Ledger — 버그 정리 · 기능/권한 단순화 설계

## Context

Smart Care Ledger는 사회복지사가 발달장애인 입주자의 금전을 관리하는 실서비스다.
GAS v17 → Firebase 마이그레이션 후 기능이 90개 이상 쌓였고, "기능은 다 있는데
숫자가 안 맞고 버그가 계속 나오는" 상태가 되었다.

전체 코드 7,774줄과 보안 규칙·배포 설정을 모두 읽었다. 결론부터 말하면
**버그가 흩어져 있는 게 아니라 6개의 구조적 원인에서 반복 생성되고 있다.**
개별 버그를 하나씩 잡으면 끝이 없고, 원인을 없애면 수십 개가 한 번에 사라진다.

이 문서는 진단(1부)과 확정된 설계·작업 순서(2부)로 나뉜다. 코드는 수정하지 않았다.

### 확정된 방향 (사용자 결정)

| 항목 | 결정 |
|---|---|
| 인증 | **Cloud Functions 커스텀 토큰** — 현재 ID/PW 로그인 화면 유지, 서버에서 토큰 발급. **Blaze 전환 확정** |
| 권한 | **등급 4개(입력자·담당자·팀장·센터장) + `isAdmin` 플래그.** 입력자 역할 **유지 확정**, 32키 매트릭스 폐기 |
| 모바일 | **별도 구현 삭제 → 반응형 통합.** 좁은 화면에는 조회·수기입력만, 보고서·결재는 데스크톱 전용 |

---

# 1부 — 진단

## 근본 원인 6가지

| # | 원인 | 이것이 만들어낸 버그 |
|---|---|---|
| **R1** | 인증·권한이 브라우저에만 있고 DB는 인터넷 전체에 공개 | 전 데이터 유출, 평문 비밀번호 노출, 모든 `can()` 우회 |
| **R2** | 같은 일을 하는 코드가 여러 벌 (잔액 4벌, 결재 2벌, 파서 설정 2벌) | 화면마다 다른 숫자, 모바일만 결재 순서 우회, 파서 설정 무효 |
| **R3** | 식별자·타입 규칙 불일치 (`teamLeader`, 날짜, `sortOrder`) | 팀장 결재 대기 목록 **항상 0건**, 모바일 입력분 정렬 침몰 |
| **R4** | 상태 머신이 "버튼 렌더 조건"에만 있고 실행 시점 검증 없음 | 결재 단계 건너뛰기, 반려 보고서 영구 정지 |
| **R5** | 부분 로드된 캐시로 전체 계산 수행 | **잔액 영구 손상**, 엑셀 중복 오탐, 자산이동 고아 |
| **R6** | 검증 장치 없음 (`npm run lint`는 문법 검사만, 테스트 0건) | 죽은 코드 방치, 오타가 런타임까지 도달 |

---

## 🔴 즉시 대응

### S0. 데이터베이스와 스토리지가 전 세계에 공개

`firestore.rules` 전체:
```
match /{document=**} {
  allow read, write: if request.time < timestamp.date(2030, 12, 31);
}
```
`storage.rules`: `allow read, write: if true;`

프로젝트 ID는 `public/index.html`에 공개되어 있다. **로그인 없이** 가능한 일:

- `users` 컬렉션 전체 조회 → **전 직원 평문 비밀번호**
- 전 입주자 금전 기록·통장 사진·영수증·은행 원본 파일 조회·수정·**삭제**

규칙 파일 주석이 설계 의도를 명시한다 — *"세밀한 권한 제어는 app.js의 can()
함수로 처리됩니다."* → **모든 권한 검사가 클라이언트 JS**이고 개발자도구에서
전부 무력화된다. `cors.json`은 브라우저 출처만 제한할 뿐 `curl` 앞에서는 무의미하다.

**추가로** `core.js:48`이 로그인마다 `users` 전체를 `S.users`로 올리고
`app.js:727`이 `S`를 `window`에 노출한다. 즉 **입력자도 콘솔에서
`S.users.map(u=>[u.userId,u.password])` 한 줄로 관리자 비밀번호를 얻는다.**

> 발달장애인 거주시설의 개인정보 + 금융정보다. 개인정보보호법 사안이며
> 다른 모든 항목보다 우선한다.

### S1. 잔액이 조용히 손상된다 — 앱 최대의 버그

`transactions.js:539` `updateAccBalance()`:
```js
// Phase 1 최적화: Firestore 쿼리 대신 S.transactions 캐시 사용
const accTrx = S.transactions.filter(t => t.accountId === accId);
let bal = Number(acc.initialBalance || 0);
accTrx.forEach(...);
await updateDoc(accRef, { currentBalance: bal });   // ← Firestore에 영구 저장
```

`S.transactions`는 **현재 화면에 로드된 범위**만 담는다. 기본값은 당월
(`core.js:177-186`)이고, 입력자에게는 본인 작성분만 남도록 한 번 더 걸러진다
(`core.js:189`).

즉 거래를 하나만 저장·수정·삭제해도
**`currentBalance = 기초잔액 + 당월 거래`로 덮어써지고 이전 기록이 사라진다.**

더 나빠지는 5가지 경로:

| 경로 | 증상 |
|---|---|
| 모바일 입력 (`app.js:557`) | 모바일은 `S.transactions`를 **한 번도 채우지 않는다**(`M.transactions`만 씀) → **거래 하나 입력할 때마다 잔액이 기초잔액으로 리셋** |
| 데스크톱 신규 저장 (`transactions.js:432-434`) | `updateAccBalance()`가 `loadTransactions()` **앞에** 호출됨 → 방금 넣은 거래가 누락. 수정 경로는 순서가 반대라 **생성과 수정이 다른 답을 낸다** |
| 계좌 정보 편집 (`modals.js:994`) | 설정 화면엔 해당 계좌 거래가 캐시에 없음 → 잔액이 `initialBalance`로 붕괴 |
| 타 입주자 간 자산이동 (`modals.js:170-173`) | 입금 계좌가 다른 입주자 소속 → 캐시에 없음 → **입금 계좌 잔액 초기화** |
| 입력자 권한 | 본인 작성분만으로 계산한 값이 **공용 계좌 문서**에 기록됨 |

그리고 **잔액 계산식이 4벌**이라 화면마다 숫자가 다르다.

| 위치 | 계산식 |
|---|---|
| `transactions.js:539` | 기초잔액 + **당월** 거래 → Firestore에 저장 |
| `report.js:207` | 기초잔액 + 기준일~보고월말 **전체** 거래 (정확) |
| `dashboard.js:22` | 저장된 `currentBalance` (= 손상된 값) |
| `app.js:426` (모바일) | `currentBalance \|\| initialBalance` (또 다른 폴백) |

**"보고서 잔액과 대시보드 잔액이 다르다"의 정체가 이것이다.**

부수 문제: `initialBalanceDate` 경계가 `< baseDate`(기준일 당일 포함)인데 폼
안내문(`modals.js:981`)은 "기준일 **이후**"라고 적혀 있다. 기준일 당일 거래가
이중 계상된다. 기준일이 비어 있으면 필터가 아예 없어 전 기간이 합산된다.

### S2. 신규 배포 시 아무도 로그인할 수 없다 (부트스트랩 교착)

- `auth.js:141` — 회원가입은 **항상** `approved:false`, `role:'입력자'`
- `auth.js:41` — `approved===false`면 로그인 거부
- `settings.js:789` `approveStaff` — 승인하려면 **이미 로그인한** 팀장 이상 필요
- 빈 컬렉션 자동 시딩 없음. 기본 카테고리도 설정에서 수동 실행해야 함

→ 새 Firebase 프로젝트에 배포하면 **Firestore 콘솔에서 손으로 `users` 문서를
만들기 전에는 앱 진입이 불가능하다.** "초반 세팅" 문제의 핵심.

빈 상태에서 추가로 막히는 곳: 카테고리 0건 → 거래 입력 폼의 분류가 비고 규칙
추가가 항상 실패. 입주자 0건 → 대시보드 CTA가 설정으로 보내지만 비관리자에겐
등록 버튼이 숨겨져 **막다른 길**.

---

## 🟠 구조적 원인

### S3. 모바일이 데스크톱의 별도 복제본 (`app.js:366-720`, 약 355줄)

`isMobile()`이 참이면 완전히 다른 앱을 띄운다(`auth.js:91`). 같은 업무를 두 벌
구현했고 이미 어긋났다.

| 항목 | 데스크톱 | 모바일 | 결과 |
|---|---|---|---|
| 결재 순서 강제 | 센터장 대행은 `leaderVacant`일 때만 (`report.js:804`) | 센터장·관리자면 **무조건** 팀장 단계 결재 (`app.js:675`) | **순서 강제가 모바일에서 무력화** |
| 결재 시각 | `toISOString()` (문자열) | `Date.now()` (숫자) | **같은 필드에 타입 2종** |
| 권한 판정 | `can()` 일부 | 역할 문자열 비교만 | 권한 설정이 **모바일에 전혀 미반영** |
| 회수·수정·삭제 | 있음 | **없음** | 잘못 제출하면 되돌릴 수 없음 |
| 정렬 | `sortOrder` 오름차순 | `date` 내림차순 | 같은 데이터가 다른 순서 |
| 신규 `sortOrder` | 작은 정수 | `Date.now()` (약 1.7e12) | **모바일 입력분은 항상 맨 아래 침몰** |
| 의견 입력 | textarea | `prompt()` | iOS PWA에서 불안정 |
| 거래 조회 | 당월 범위 쿼리 | **전체 fetch** (`app.js:453,615`) | 최적화 무효화 |
| 자산이동·취소 | 가능 | **불가** | |
| 금액 합산 | `Number()` 강제 | **없음** (`app.js:619-620`) | 문자열 금액이 섞이면 문자열 연결 |

`isMobile()`은 `width<=768 && 터치`라 **터치 노트북·태블릿 사용자가 축소판 앱에 갇힌다.**

### S4. 권한 32키가 실은 5단계 서열 하나이고, 절반은 아무 효과가 없다

`DEFAULT_PERMISSIONS` 160개 토글을 열별로 보면 **패턴이 5종뿐**이고
**모든 권한이 역할 서열에 단조증가하며 예외가 하나도 없다.**

| 패턴 | 키 수 |
|---|---|
| 전부 `true` (무의미) | 3 |
| 입력자만 `false` | 17 |
| 입력자·담당자 `false` | 7 |
| 센터장·관리자만 | 2 |
| 관리자만 | 1 |

더 나쁜 사실: **32키 중 15개는 코드에서 한 번도 읽히지 않는다.**
```
trx.create, trx.delete, trx.reorder, trx.transfer, trx.category.edit, trx.csv,
report.view.own, report.draft, report.edit, report.delete, report.submit,
report.reject, settings.staff, settings.client, settings.account
```
이 15개는 권한 화면에 **정상 동작하는 스위치처럼 표시되고 저장까지 된다.**
→ 사용자가 말한 *"설정에서 권한 체크해도 변경되는 것이 없어"*가 정확히 이것이다.

그리고 **앱의 절반이 권한 시스템을 무시한다.**
- `can()` 호출 약 38곳 vs **역할 문자열 하드코딩 21곳**
- **결재 워크플로 전체가 하드코딩이다.** `report.approve.team`/`center`는
  "목록을 보여줄지" 정하는 `report.js:1006` 한 줄에만 쓰이고, 실제 결재
  버튼(`report.js:777~833`)은 `role==='센터장'||role==='관리자'` 문자열 비교로
  동작한다 → **권한 화면에서 결재 권한을 꺼도 버튼은 그대로 작동한다.**

의미가 어긋난 사용 — `core.js:30`:
```js
const isAdmin = can('nav.staff');   // ← 이 값으로 "담당 입주자만 보기"를 결정
```
**네비게이션 메뉴 권한으로 데이터 접근 범위를 정한다.** 팀장의 `nav.staff`를
끄면 팀장이 **전 입주자를 못 보게 되는** 숨은 부작용이 난다.

추가 결함:
- `can()`이 **fail-open**이다(`permissions.js:134`). 권한 로드 실패 시 더 느슨한
  기본값으로 떨어진다. 안전 방향은 반대여야 한다.
- 실행 시점 가드가 없다. `saveTrx`·`delTrx`·`confirmBulkDelete`에 `can()`이 없고
  전부 `window`에 노출 → 콘솔에서 `delTrx(id)` 호출 가능.
- **팀장이 신규 가입자를 센터장으로 승인할 수 있다**(`settings.js:789`) — 권한 상승.
- `executeFirebaseReset`이 `config/permissions`를 함께 삭제한다(`settings.js:624`).
  반대로 `budgets`는 빠져 있어 고아 문서로 남는다.

### S5. 식별자 규칙 불일치 — 팀장 결재 대기 목록이 항상 0건

`clients` 문서의 두 필드가 **서로 다른 종류의 값**을 담는다.

| 필드 | 저장되는 값 | 근거 |
|---|---|---|
| `userIds` | **로그인 아이디** (`u.userId`) | `modals.js:951` `value="${u.userId}"` |
| `teamLeader` | **Firestore 문서 ID** (`u.id`) | `modals.js:951` `value="${u.id}"` |

게다가 CSV 일괄 등록은 컬럼명이 "담당팀장아이디"이고 사용자가 입력한
**로그인 아이디**를 그대로 `teamLeader`에 넣는다(`modals.js:1218, 1250`).
→ **같은 필드가 생성 경로에 따라 두 종류의 값을 담는다.**

결과 (`report.js:996-997`):
```js
const tlId = String(client?.teamLeader || '');            // 문서 ID
if (role==='팀장' && userId===tlId && ...) return true;   // 로그인 ID → 항상 false
```
→ **팀장 결재 대기 뱃지·목록·대시보드 배너가 언제나 0건이다.**
팀장이 보고서로 직접 찾아 들어가면 결재는 되는데(`report.js:724-728`이 양쪽 키를
모두 대조하는 방어 코드를 갖고 있음) 알림은 절대 오지 않는다. 모바일도 동일(`app.js:653`).

**게다가 `users` 문서 ID 자체가 세 가지 형태로 생성된다.**

| 생성 경로 | 문서 ID |
|---|---|
| 직원 등록 폼 (`modals.js:1006`) | `usr_${Date.now()}` |
| 직원 CSV 일괄등록 (`modals.js:1178`, `batchAddDocs`) | Firestore 자동 ID |
| 본인 회원가입 (`auth.js:140`, `addDoc`) | Firestore 자동 ID |

→ **`clients.teamLeader`에는 현재 3종류 값이 섞여 있을 수 있다** — `usr_...`,
Firestore 자동 ID, 그리고 CSV 입주자 등록이 넣은 로그인 아이디.
마이그레이션 설계(설계 6)가 이 세 가지를 모두 처리해야 한다.
`cli_${Date.now()}`·`acc_${Date.now()}`도 같은 패턴이라 동일 밀리초 생성 시 충돌 위험이 있다.

같은 종류의 불일치: **날짜**(ISO 문자열 vs epoch 숫자), **`sortOrder`**(엑셀
`maxOrder+i+1` / 모바일 `Date.now()` / 데스크톱 수기입력 **미설정** / 재정렬
`0..n` / 결측 `99999`). 캐시가 전부 `undefined`이면 신규 엑셀 행이 `1,2,3…`을
받아 **기존 전체 이력 위로 올라간다.**

### S6. 결재 상태 머신이 "버튼 표시 조건"에만 있다

`doApproval`(`report.js:837`)은 **현재 상태를 확인하지 않고 역할만 보고 전이한다.**
```js
const rules = { 담당자:{next:'submitted'}, 팀장:{next:'team_approved'},
                센터장:{next:'confirmed'}, 관리자:{next:'confirmed'} };
const update = { status: rules[role].next, ... };   // ← report.status 검사 없음
```
따라서 탭 두 개, 뒤로가기, 동시 편집, `window.doApproval('approve')` 직접 호출로
**`draft` → `confirmed` 한 번에 점프**가 가능하다. 제출자·팀장 결재란이 빈 채로
"최종 결재완료"가 되고 그 달은 잠긴다.

이어지는 결함:
- **반려 보고서가 영구 정지된다.** `rejected`를 처리하는 분기는 `role==='담당자'`
  하나뿐(`report.js:777`). 팀장이 직접 담당인 입주자의 보고서가 반려되면
  **아무도** 재제출·수정·삭제할 수 없다. 담당자 퇴사 시도 동일. 관리자에게도 해제 수단이 없다.
- **회수 기능이 죽어 있다.** 조건이 `report.createdBy === userId`인데
  (`report.js:783, 959`) 보고서 문서에 `createdBy`를 **쓰는 코드가 없다.**
  → 담당자는 자기 제출을 절대 회수할 수 없다.
- **팀장 회수는 사유 없는 반려다.** `submitted`에서 회수하면 제출 기록이 삭제되고
  `draft`로 간다(`report.js:971-982`). 사유도 반려 기록도 알림도 없다.
- **결재 취소해도 결재란에 이름이 남는다.** `doRevertToDraft`(`report.js:924`)가
  상태만 바꾸고 `teamApprovedByName` 등을 지우지 않는다.
  → **취소된 서명이 인쇄물에 계속 찍힌다.** 공문서 산출물에서 그냥 넘길 수 없다.
- 마찬가지로 `doReject`는 제출 기록을, 재제출은 반려 기록을 지우지 않는다.
- **작성일이 항상 오늘이다**(`report.js:291`). 작년 보고서를 다시 인쇄하면 오늘 날짜가 찍힌다.

---

## 🟡 데이터 파손 · 조용한 실패

### S7. 엑셀 업로드가 행을 조용히 버리고, 파서 설정 파일은 아예 작동하지 않는다

**`parser-config.js` 143줄 전체가 무효다.** 세 가지 독립적 이유:
1. `index.html:61`이 **classic script**로 로드하고 `app.js`는 지연 모듈이다 →
   IIFE 실행 시점에 `window.ExcelParser`가 없어 `Object.assign` 분기를 안 탄다.
2. 주석이 약속한 폴백(`window.BANK_CONFIGS`)이 **구현되어 있지 않다.**
   classic script의 최상위 `const`는 `window` 프로퍼티가 아니다 →
   `window.BANK_CONFIGS`/`PARSER_NOISE_WORDS`/`SMS_CONFIG`는 영원히 `undefined`.
3. 은행 감지는 설정과 무관한 하드코딩 if/else 체인(`app.js:195-202`)이 먼저 돈다.

→ 파일 상단 안내문 *"BANK_CONFIGS에 추가하세요. app.js는 건드릴 필요가 없습니다"*는
**거짓이다.** 실제 값은 `app.js:48-70`의 복제본이고 두 벌이 따로 논다.

**금액 파싱** (`app.js:327-331`) — `Number(String(v).replace(/[^0-9.-]/g,''))`:
- `"(5,000)"` → `"5000"` → **+5000**. 회계식 괄호 음수가 양수가 된다.
- `"12,345-"` → `NaN` → `0` → `if(!inVal&&!outVal) continue`로 **행이 조용히 사라진다.**

**EUC-KR CSV가 항상 실패한다** (`app.js:82-88`):
```js
try { text = new TextDecoder('utf-8').decode(raw); }
catch(e) { text = new TextDecoder('euc-kr').decode(raw); }
```
`TextDecoder`는 `{fatal:true}` 없이는 **예외를 던지지 않고** U+FFFD로 치환한다 →
`catch`가 도달 불가능한 죽은 코드. 국내 은행 CSV 상당수가 EUC-KR/CP949이고
사용자는 "인식된 거래 데이터가 없습니다"만 본다. 인코딩 문제라는 힌트가 없다.

**중복 판정이 정상 데이터를 버린다** (`modals.js:372, 381, 448`) —
키가 `date_|amountIn|_|amountOut|`이고 중복은 말없이 제외된다. 4가지가 동시에 잘못됐다.
1. 비교 대상이 `S.transactions`(**당월·활성 입주자**뿐) → 2월 명세서를 9월에 올리면
   중복 0건, **같은 파일 두 번 올리면 두 벌 들어간다.**
2. `accountId`가 키에 없음 → 같은 입주자의 **다른 계좌** 동일 금액이 중복 처리
3. `description`이 키에 없음 → 같은 날 5,000원짜리 서로 다른 지출 중 **두 번째가 삭제**
4. `Math.abs` → 환불(-5,000)이 원거래(5,000)의 중복으로 삭제

사용자에겐 `중복 N건 제외`만 뜨고 **어떤 행인지 알려주지 않는다.**

**행이 사라져도 아무도 모른다.** 날짜 파싱 실패(`app.js:257`), 금액 파싱
실패(`:284`), 빈 적요(`:279`, ATM 출금에서 흔함), `합계` 포함 상호명(`:280`)이
전부 조용히 `continue`된다. 성공 건수만 표시되므로 절반이 실패해도 성공처럼 보인다.

기타: `_cleanDesc`가 노이즈 단어를 부분 문자열로 지워 `승인마트`→`마트`,
`모바일세상`→`세상`으로 상호명을 훼손한다(원본 미저장, 복구 불가).
HTML-XLS 파서는 KB 전용 하드코딩이라 타 은행은 0건이 나온다.

### S8. 자산이동이 한쪽만 남는다 (돈이 장부에서 사라짐)

- **삭제**: `scheduleTrxDeletion`(`transactions.js:463-503`)이 `linkedTrxId`를 삭제
  대상엔 넣지만, 잔액 재계산 대상(`accIds`)과 Storage 정리 대상은 `S.transactions`
  스캔으로 만든다. 상대편이 **다른 입주자**거나 **로드 범위 밖**이면 → Firestore에선
  지워지는데 **상대 계좌 잔액은 영영 갱신되지 않고** 영수증은 고아로 남는다.
- **유형 변경**: 자산이동 → 지출로 바꾸면 `linkedTrxId`가 초기화되지 않아 한쪽은
  지출, 다른 쪽은 여전히 자산이동인 짝이 남는다(`modals.js:176`).
- **지출 → 자산이동**: 상대편을 못 찾으면 토스트만 띄우고 **`자산이동`으로 저장한다**
  (`modals.js:143-166`). 출금만 있고 입금이 없는 거래 → **장부에서 돈이 증발.**
  상대편 탐색이 `S.transactions`(당월·활성 입주자)만 훑으므로 이게 기본값이다.
- **생성**이 3회 연속 쓰기이고 트랜잭션이 아니다(`modals.js:167-172`).
  `batchMixedOps`가 이미 있는데 쓰지 않는다.
- 일괄 삭제는 체크한 항목만 결재 잠금을 확인하고 뒤에 추가되는 `linkedTrxId`는
  재확인하지 않는다 → **결재 완료 월의 거래가 삭제된다.**

### S9. 설정 화면의 저장이 데이터를 지운다

**`setDoc`을 merge 없이 쓴다.**
- `renderAccountForm`(`modals.js:1000-1005`)이 쓰는 객체에 `bankStatements`와
  `active`가 없다 → **계좌 정보를 한 번 수정하면 그 계좌의 통장 사진 기록이 전부
  삭제된다**(Storage 파일은 고아). 비활성 계좌는 되살아난다.
- `renderClientForm`(`modals.js:955-961`)도 `active`를 떨어뜨린다. 게다가
  **비관리자(담당자)가 저장을 누르면** `teamLeader`가 `''`가 되고 `userIds`가
  **본인 한 명으로 교체된다**(`modals.js:956-957`). 동료 접근권이 사라지고
  `leaderVacant`가 참이 되어 결재가 센터장 대행으로 넘어간다.
  ✏️ 버튼은 관리자 전용으로 가려져 있지 않다(`settings.js:113, 136`).

**권한 검사 없는 파괴적 작업:**
- `resetCategories`(`settings.js:425`) — **권한 검사가 전혀 없다.** 설정 탭은
  담당자도 들어간다. 버튼 하나로 **전 입주자의 카테고리와 자동분류 규칙이 모두 삭제**된다.
- `executeArchive`(`settings.js:475`) — `can()` 없음. 탭 버튼만 숨겨져 있고
  `window.executeArchive`는 노출되어 있다.
- `saveBudget`(`settings.js:586`) — 검사도 확인창도 없이 기존 예산을 먼저 삭제한다.
  게다가 로드 시점과 저장 시점의 입주자 선택을 각각 읽어서, 드롭다운만 바꾸고
  저장하면 **A의 금액이 B에게 저장되고 B의 기존 예산은 삭제된다.**

**연도 마감이 원자적이지 않다**(`settings.js:503-517`): 아카이브 복사 → 기초잔액
전진 → 원본 삭제 → 이력 기록. 3단계에서 실패하면 거래가 **두 벌 존재하면서
기초잔액은 이미 반영된** 상태가 되어 잔액이 이중 계상된다. 이력이 없으니 UI는
미마감으로 보이고 재시도하면 삼중이 된다. 또 `S.accounts`(활성만)를 순회하므로
**비활성 계좌는 거래만 삭제되고 기초잔액은 전진하지 않아 1년치가 영구 증발한다.**

### S10. HTML 이스케이프 누락 — 은행 파일 하나로 저장형 XSS

이스케이프 헬퍼는 `escAttr` 하나뿐이고 **텍스트용 헬퍼가 없다.**
`innerHTML`에 사용자 입력을 그대로 넣는 곳이 **32곳 이상**이다.

가장 위험한 경로: **거래 내용(`description`)은 엑셀 업로드의 가맹점명 칸에서 온다.**
```js
// transactions.js:162
<td class="trx-edit" title="${t.description||''}">${t.description||''}${typeTag}</td>
// modals.js:427 — 저장 전 "분석" 단계에서 이미 실행됨
<td title="${t.description}">${t.description}${dupBadge}</td>
```
→ 공격자는 계정이 필요 없다. **조작된 은행 명세서 파일을 사회복지사에게 건네주면**
분석 버튼을 누르는 순간 실행된다. DB가 공개(S0)이므로 값을 직접 심을 수도 있다.

그 외: 보고서 의견(`app.js:646-648`), 입주자 이름·메모, 직원 이름, 계좌 라벨,
영수증 인쇄 창(`document.write`), `toast()`(`ui.js:53`, 예외 메시지·파일명이 들어옴),
`emptyState()`의 `ctaAction`(`onclick`에 직접 주입).

`escAttr`도 만능이 아니다. 대부분 호출부가 `onclick="fn('${escAttr(id)}')"` 형태인데
HTML 파서가 `&#39;`를 `'`로 되돌린 **뒤에** JS가 컴파일되므로 **JS 문자열 문맥에서는
따옴표 이스케이프가 무력화된다.**

---

## 🟡 성능 · 안정성

"읽기 최적화 Phase 1-4"가 **잘못된 곳에 적용된** 결과다 — 캐시를 아끼려다 S1 잔액
손상과 S7 중복 오탐을 만들었고, 정작 큰 낭비는 남아 있다.

| 위치 | 문제 |
|---|---|
| `report.js:1028` | **결재 버튼을 누를 때마다 `reports` 컬렉션 전체를 읽는다.** 입주자 30명 × 36개월 = 클릭 1회당 약 1,080 문서 |
| `report.js:45` | 보고서 렌더마다 해당 입주자 **전체 거래 이력**을 읽는다(날짜 범위 없음) |
| `report.js:37-51` | 이 캐시가 거래내역 탭과 공유된다. 보고서를 열면 `S.trxRange`가 `'all'`로 바뀌고 거래내역 탭 데이터가 조용히 교체된다 |
| `core.js:123` | `fixedItems` **컬렉션 전체**를 매번 읽는다 |
| `core.js:98-103` | 입주자 31명부터 `in` 절 한계를 넘어 **조직 전체 당월 거래**를 읽는다 |
| 3중 조회 | `reports`를 서로 다른 3곳에서 각각 읽고 `confirmedMonths`를 두 번 계산한다 |
| `app.js:963-964` | `h-start`/`h-end`가 `input`·`change` **양쪽에 바인딩**되어 필터가 2번 실행 |
| `transactions.js:78-83` | 날짜 칸에 연도를 타이핑하는 중간값(`0002-01-01`)이 범위 확장 조건을 만족해 **키 입력마다 전체 이력 조회가 발사된다** |
| `core.js:161` | `loadTransactions`에 재진입 가드가 없다. 늦게 끝난 응답이 이긴다 |
| `firestore.indexes.json` | **비어 있다.** `where('clientId','==') + where('date','>=','<=')`는 복합 인덱스가 필요하다. 운영 프로젝트는 콘솔에서 수동 생성했을 가능성이 크고, 그렇다면 **새 프로젝트 배포 시 거래 조회가 통째로 실패**한다. `core.js:133`이 예외를 삼켜 대시보드는 조용히 0원을 표시한다 |
| `firebase.json` | HTML·JS에 `Cache-Control`이 없다. 기본 1시간 캐시 + 버전 쿼리 없음 → 배포 후 최대 1시간 동안 **새 HTML과 낡은 모듈 JS가 섞일 수 있다** |

**메모리 누수**: `openReceiptModal`(`modals.js:615-616`)이 호출마다 `document`에
`mousemove`/`mouseup` 리스너 2개를 붙이는데 `closeReceiptModal`은 패널 엘리먼트만
제거한다. 영수증 50번 열면 살아 있는 핸들러 100개가 분리된 DOM을 붙잡는다.
`openBankStatementsForApproval`(`report.js:612-614`), `initSettingsTabs`
(`settings.js:748`, `dataset.bound` 가드 없음)도 같은 패턴.

### S11. 페이지네이션 · 정렬 · 드래그가 서로 어긋난다

- **`applyFilters`에 `S.page=1`이 없다.** 5페이지에서 결과를 3건으로 좁히면
  `slice(400,3)` → **빈 표**가 뜨고 카운터는 `총 3건 (401–3)`. 페이지 버튼도
  사라져(`pages<=1`) **1페이지로 돌아갈 방법이 없다.**
- **드래그 재정렬이 현재 정렬 기준으로 번호를 다시 매긴다**(`transactions.js:576-605`).
  금액순 정렬 상태에서 한 행을 드래그하면 **그 페이지 전체가 금액순으로 영구 저장된다.**
- 재정렬 후 `applyFilters()`를 호출하지 않아 다음 필터 입력·저장 시 **원래대로 되돌아간다.**
- 재정렬은 이동한 행만 결재 잠금을 확인하고 같은 페이지의 다른 행은 무관하게 덮어쓴다.
- 헤더는 10칸인데 빈 상태 행은 `colspan="9"`. `data-sort="receiptUrl"`은 URL 문자열로
  정렬한다(사실상 무작위). 같은 `<th>`에 `style`이 두 번 있어 두 번째가 무시된다(`index.html:567`).

### S12. 세션 복원이 완전히 깨져 있다 — 새로고침하면 무조건 로그아웃

`app.js:338-353`:
```js
const { auth } = window._fbAuth || {};
if (auth && !auth.currentUser) { sessionStorage.removeItem('scl_user'); throw ...; }
```
`index.html:44,49`가 진짜 `auth` 객체를 넣어두지만 이 앱은 Firebase Auth를 쓰지
않아 `signInWithCustomToken`을 **어디서도 호출하지 않는다**(호출부 0건).
→ `auth`는 항상 truthy, `currentUser`는 항상 null → **조건이 언제나 참** →
**F5를 누르면 반드시 로그인 화면으로 돌아간다.**

동시에 이 가드를 없애면 반대 문제가 드러난다. `S.user`는
`JSON.parse(sessionStorage)`를 **검증 없이 신뢰**하므로 개발자도구에서
`role:'관리자'`로 고치고 새로고침하면 관리자가 된다. 두 가지를 함께 고쳐야 한다.

또한 로그인 이후 `active`·`approved`·`role`을 **다시 확인하지 않는다.** 퇴사 처리된
직원은 탭을 닫기 전까지 전 권한을 유지한다 — `active===false` 검사를 추가한 커밋이
막으려던 바로 그 상황이다. 로그아웃도 `S.users`(비밀번호 포함), `S.allClients`,
`S.confirmedMonths`를 지우지 않아 공용 PC에서 다음 사용자에게 남는다.

### S13. 검증 장치가 없다

- `npm run lint`는 `node --check`를 도는 **문법 검사**다. 오타난 함수명, 없는 변수,
  잘못된 전역 참조를 전혀 못 잡는다. 테스트 0건.
- 앱은 **전역 158개**에 의존한다(`app.js:725-857`). HTML `onclick`이 이름을 문자열로
  참조하므로 하나만 어긋나도 런타임에 조용히 죽는다. (현재 누락 0건이지만 지켜주는 장치가 없다.)
- 모듈이 `import` 없이 `window` 경유로 서로를 부른다. `transactions.js:210`이
  `openReceiptModal`을 호출하는데 import 목록에 없다.
- **죽은 코드**: `services/firestore.js`의 CRUD 래퍼 **26개 전부 호출부 0건**(약 120줄).
  파일 주석은 *"모든 모듈은 이 파일을 통한다"*지만 62곳이 `fb()`를 직접 쓴다.
  그 외 `parser-config.js` 전체, `renderTrendChart`, `confirmDelete`(직원·입주자·계좌
  **삭제 UI가 아예 없다**), `skeleton()`, `S.rptChart`, `S.excelRawRows`, 미사용 import 다수.
- `Planner.md`(90/90 완료), `Evaluator.md`("보안 ✅ PASS")가 위 내용을 하나도 반영하지
  못한다. 검증 절차가 `node --check`와 문자열 grep이라 보안 경계를 본 적이 없다.

---

# 2부 — 확정 설계

## 설계 1: 인증 (Cloud Functions 커스텀 토큰)

로그인 화면과 사용법은 그대로 두고, 검증만 서버로 옮긴다.

```
[브라우저] 아이디/비밀번호 입력
    ↓ httpsCallable('login', {userId, password})
[Cloud Function]  ← Admin SDK (규칙 우회)
    1. userSecrets/{userId} 에서 해시 조회 → bcrypt/scrypt 비교
    2. approved / active 확인
    3. 커스텀 클레임 부여: { role, isAdmin, uid }
    4. createCustomToken(userId, claims) 반환
    ↓
[브라우저] signInWithCustomToken(token)   ← index.html:49에 이미 import됨
    ↓ 이후 모든 Firestore 요청에 request.auth 존재
```

**필요한 Cloud Functions (4개, 리전 `asia-northeast3`)**

| 함수 | 역할 |
|---|---|
| `login` | 비밀번호 검증 + `approved`·`active` 확인 + 커스텀 토큰 발급 |
| `signup` | 가입 신청 (해시 저장, `approved:false`). **`users`가 비어 있으면 첫 계정을 `관리자`+`approved:true`로** → S2 부트스트랩 교착 해소 |
| `approveStaff` | 승인 + 역할 부여 (**호출자 등급 이하만** 부여 가능 → S4 권한 상승 차단) |
| `changePassword` | 본인 또는 관리자의 비밀번호 변경 |

**데이터 모델 변경**

```
users/{userId}         // 문서 ID = 로그인 아이디 (S5 해소)
  { name, role, isAdmin, team, approved, active }   // ← password 없음
userSecrets/{userId}   // 규칙: allow read, write: if false (Functions 전용)
  { passwordHash, algo, updatedAt }
```

`userId`를 문서 ID로 올리면 S5(식별자 혼선), 로그인 시 `docs[0]` 임의 선택,
동시 가입 중복이 **동시에 해소된다.** `clients.teamLeader`와 `clients.userIds`가
같은 키 공간을 쓰게 되어 **팀장 결재 대기 목록이 살아난다.**

**보안 규칙 스케치** (`role`·`isAdmin`은 토큰 클레임에서 읽음)

```js
function rank() {
  return { '입력자':1, '담당자':2, '팀장':3, '센터장':4 }[request.auth.token.role];
}
function isAdmin()  { return request.auth.token.isAdmin == true; }
function signedIn() { return request.auth != null; }

match /userSecrets/{d}  { allow read, write: if false; }        // Functions 전용
match /users/{uid} {
  allow read:  if signedIn() && (uid == request.auth.uid || rank() >= 3);
  allow write: if false;                                        // Functions 전용
}
match /transactions/{t} {
  // 입력자는 본인이 작성한 거래만
  allow read:   if signedIn() && (rank() >= 2 || resource.data.createdBy == request.auth.uid);
  allow create: if signedIn() && request.resource.data.createdBy == request.auth.uid;
  allow update, delete: if signedIn() && (rank() >= 2 || resource.data.createdBy == request.auth.uid);
}
match /reports/{r}   { allow read: if signedIn() && rank() >= 2;
                       allow write: if signedIn() && rank() >= 2; }
match /clients/{c}   { allow read: if signedIn();
                       allow write: if signedIn() && rank() >= 3; }
match /accounts/{a}  { allow read: if signedIn();
                       allow write: if signedIn() && rank() >= 3; }
match /categories/{c}{ allow read: if signedIn();
                       allow write: if signedIn() && rank() >= 2; }
match /config/{d}    { allow read: if signedIn(); allow write: if isAdmin(); }
match /budgets/{b}   { allow read: if signedIn(); allow write: if signedIn() && rank() >= 3; }
```
Storage도 동일하게 `request.auth != null`로 잠근다.

> **전제**: Cloud Functions는 **Blaze(종량제) 플랜**이 필요하다. 이 규모에서는
> 무료 할당량 안에 들어갈 가능성이 높지만 결제 수단 등록이 선행되어야 한다.

## 설계 2: 권한 (등급 4개 + 관리자 플래그)

32키 매트릭스와 160개 체크박스를 폐기하고 **단조 서열 하나**로 바꾼다.

```js
// permissions.js — 전체가 이 정도 크기로 줄어든다
const ROLE_RANK = { 입력자:1, 담당자:2, 팀장:3, 센터장:4 };

const MIN_RANK = {
  // 입력자 이상 — 담당 입주자 + 본인 작성분 한정
  'trx.view.own':1, 'trx.create':1, 'trx.edit.own':1, 'trx.delete.own':1,
  // 담당자 이상
  'trx.view.all':2, 'trx.edit.all':2, 'trx.delete.bulk':2, 'trx.reorder':2,
  'trx.transfer':2, 'trx.category.edit':2, 'trx.csv':2,
  'excel.upload':2, 'receipt.upload':2, 'receipt.print':2, 'bankbook.upload':2,
  'nav.report':2, 'nav.settings':2, 'report.own':2, 'report.submit':2,
  'report.recall':2, 'settings.fixed':2, 'settings.budget':2,
  // 팀장 이상
  'nav.staff':3, 'client.view.all':3, 'report.view.all':3,
  'report.approve.team':3, 'report.reject':3,
  'settings.client':3, 'settings.account':3, 'settings.category.common':3,
  // 센터장 이상
  'report.approve.center':4, 'report.revert':4, 'settings.archive':4,
};

export function can(key) {
  if (S.user?.isAdmin) return true;                   // 관리자 플래그 = 전권
  const rank = ROLE_RANK[S.user?.role];
  if (!rank || !(key in MIN_RANK)) return false;      // ← fail-closed (S4 수정)
  return rank >= (S.permOverride?.[key] ?? MIN_RANK[key]);
}
```

**핵심 변경점**

| 항목 | 이전 | 이후 |
|---|---|---|
| 설정 UI | 체크박스 160개 (**15개는 무반응**) | 키별 등급 드롭다운 약 30개, **전부 실제 동작** |
| 관리자 | 5번째 역할 (센터장과 1개 키만 차이) | `users.isAdmin` **플래그** — 역할과 직교 |
| `can()` 실패 시 | fail-**open** (더 느슨한 기본값) | fail-**closed** |
| 결재 버튼 | 역할 문자열 하드코딩 21곳 | 전부 `can()` 경유 |
| 서버 검증 | 없음 | 동일 등급표를 보안 규칙이 재검증 |

**입력자 권한 확정** (요청하신 내용)

| 화면 | 입력자에게 보이는 것 |
|---|---|
| 대시보드 | **담당 입주자 카드만** (`clients.userIds`에 본인 포함된 것) |
| 거래내역 | **담당 입주자 & 본인이 작성한 거래만** 열람 |
| 거래 입력 | **수기 입력만** 가능 (엑셀 업로드 ✕, 자산이동 ✕, 취소 ✕) |
| 수정·삭제 | **본인이 작성한 거래만** |
| 보고서 탭 | 숨김 |
| 설정 탭 | 숨김 |
| 증빙 출력 · CSV · 통장사진 · 일괄삭제 · 달력뷰 · 드래그 정렬 | 전부 숨김 |

> 이 범위 제한은 **보안 규칙에서도 강제**된다(위 `transactions` 규칙 참조).
> 지금처럼 화면에서만 숨기는 방식이 아니라 서버가 거부한다.

**입력자와 잔액의 관계 (중요)** — 현재는 입력자가 거래를 저장하면 본인 작성분만으로
계산한 잔액이 공용 계좌에 기록된다(S1). 설계 3의 잔액 단일화가 이를 해소한다.
입력자는 잔액 계산에 필요한 전체 거래를 읽을 수 없으므로, **`currentBalance` 갱신은
Cloud Function으로 옮기거나**(권장) 입력자 저장 시에는 갱신을 건너뛰고 서버 측
트리거에 맡긴다.

**`nav.staff`로 데이터 범위를 정하던 문제**(S4)는 전용 키 `client.view.all`로 분리한다.
`core.js:30`이 이 키를 쓰면 팀장의 메뉴 표시를 꺼도 데이터가 사라지지 않는다.

## 설계 3: 잔액 단일화

순수 함수 하나로 통일하고, 나머지 3벌을 전부 이 함수 호출로 교체한다.

```js
// services/balance.js (신규)
export function calcAccountBalance(account, transactions) {
  const base = account.initialBalanceDate || '';
  return transactions.reduce((bal, t) => {
    if (t.accountId !== account.id)        return bal;
    if (base && (t.date || '') <= base)    return bal;   // 기준일 당일 제외 (안내문과 일치)
    if (t.type === '취소')                  return bal;
    return bal + Number(t.amountIn || 0) - Number(t.amountOut || 0);
  }, Number(account.initialBalance || 0));
}
```

**규칙**
1. `updateAccBalance`가 **`S.transactions`(부분 로드)를 쓰는 것을 금지**한다.
   해당 계좌의 전체 거래를 별도 조회하거나, Cloud Function 트리거로 서버에서 계산한다.
2. `saveTrx`의 호출 순서를 뒤집는다 — `loadTransactions` → `updateAccBalance`.
3. `currentBalance`는 **표시용 캐시로 강등**한다. 대시보드·보고서·설정 모두 같은
   함수를 쓰므로 값이 어긋날 수 없다.
4. 기준일 경계를 `> baseDate`로 확정하고 폼 안내문(`modals.js:981`)과 일치시킨다.
5. **일회성 마이그레이션 스크립트**로 이미 손상된 전 계좌 `currentBalance`를 재계산한다.

`report.js:207`의 로직이 이미 정답에 가까우므로 이를 추출해 재사용한다.

## 설계 4: 모바일 (반응형 통합 + 기능 축소)

`app.js:366-720`의 별도 구현(약 355줄)을 **삭제**하고, 기존 데스크톱 화면 하나를
반응형으로 만든다. 좁은 화면에서는 기능을 줄인다.

| 화면 폭 | 노출되는 탭 |
|---|---|
| 넓음 (데스크톱) | 대시보드 · 거래내역 · 보고서 · 설정 |
| 좁음 (휴대폰) | **대시보드 · 거래내역(조회) · 수기입력** |

- 보고서·설정 탭은 좁은 화면에서 숨기고, 직접 접근 시 *"보고서와 결재는 PC에서
  이용해 주세요"* 안내를 띄운다.
- 거래내역 표는 좁은 화면에서 **CSS만으로 카드 레이아웃**으로 전환한다
  (별도 렌더 함수를 만들지 않는다 — 그게 지금의 문제다).
- `isMobile()`의 JS 분기를 제거하고 **CSS 미디어 쿼리 + `can()`**만 쓴다.
  → 폭이 바뀌어도 같은 데이터·같은 로직이므로 **어긋날 수가 없다.**

**이 한 번의 작업으로 S3 표의 10개 불일치가 전부 사라진다** — 결재 순서 우회,
날짜 타입 2종, 권한 무시, 정렬 역전, `sortOrder` 침몰, 회수 불가, 금액 문자열 연결,
그리고 **모바일발 잔액 리셋**까지.

## 설계 5: 결재 상태 머신

허용 전이표 하나를 두고 **모든 경로가 실행 시점에** 이를 통과하게 한다.

```js
const TRANSITIONS = {
  draft:         { submit:'submitted' },
  submitted:     { approveTeam:'team_approved', reject:'rejected', recall:'draft' },
  team_approved: { approveCenter:'confirmed', reject:'rejected', revert:'submitted' },
  confirmed:     { revert:'team_approved' },
  rejected:      { submit:'submitted', discard:'draft' },   // ← 관리자 해제 경로 추가
};
```
현재 상태가 표에 없으면 **거부한다. 버튼 표시 여부와 무관하게.**

추가로:
- **전이 시 이후 단계의 도장을 반드시 지운다.** 결재 취소·반려·재제출 모두
  `deleteField()`로 정리 → **취소된 서명이 인쇄물에 남지 않는다.**
- 보고서 생성 시 **`createdBy`를 기록**한다 → 담당자 회수 기능이 살아난다.
- 팀장 회수는 **사유 필수 반려**로 통합하거나 별도 감사 기록을 남긴다.
- `rejected`에서 담당자가 부재해도 **관리자가 해제**할 수 있게 한다.
- 작성일을 `report.createdAt`에서 읽는다(`report.js:291`).

## 설계 6: 마이그레이션 절차 (라이브 데이터)

1단계는 **운영 중인 데이터의 문서 ID와 비밀번호 저장 방식을 바꾼다.** 한 번에
배포하면 사용 중인 직원이 전부 끊긴다. **확장 → 이전 → 축소** 3배포로 나눈다.

### 배포 1 — 데이터 준비 (앱 동작 변화 **없음**)

Cloud Functions를 올려두되 **아무도 호출하지 않는다.** 규칙도 아직 열어둔다.
기존 앱은 평소대로 동작한다.

마이그레이션 스크립트(Admin SDK, 규칙 우회)를 **사전 점검 → 실행** 순으로 돌린다.

**사전 점검 (실패 시 중단하고 리포트만 출력)**
- `userId` **중복 검사** — 중복이 있으면 새 문서 ID가 충돌한다. S12에서 확인한
  대로 회원가입 중복 검사가 비원자적이라 실제로 존재할 수 있다. **사람이 먼저 정리해야 한다.**
- `userId`가 비었거나 문서 ID로 못 쓰는 문자(`/`)를 포함한 계정
- `clients.teamLeader` 중 매핑 불가 값

**실행**
1. `users/{구ID}` → `users/{userId}` 복사. **구 문서는 지우지 않는다**(롤백용)
2. `userSecrets/{userId}` 생성 — 기존 평문에서 `passwordHash` 산출 (bcrypt/scrypt)
3. 신규 `users/{userId}`에서 `password` 필드 **제거**
4. `isAdmin = (role === '관리자')` 부여, `role === '관리자'`였던 계정은 `role`을 `센터장`으로 하향
5. `clients.teamLeader` 정규화 — 구ID→userId 매핑표로 **3종류 값 모두** 처리
   (`usr_...` / 자동 ID / 이미 로그인 ID인 값). 매핑 실패 시 `''`로 비우고 **리포트에 명시**
6. 검증 리포트 출력: 이전 계정 수, 매핑 실패 목록, `teamLeader`가 빈 입주자 목록

> `clients.userIds`는 **이미 로그인 아이디**를 담고 있어 손대지 않는다. 이것이
> 두 필드를 같은 키 공간으로 맞추는 지점이고, **팀장 결재 대기 목록이 여기서 살아난다.**

### 배포 2 — 앱 전환

- `auth.js` 로그인을 `httpsCallable('login')` → `signInWithCustomToken`으로 교체
- 세션 복원을 `onAuthStateChanged`로 교체 → **S12(F5 로그아웃)와 sessionStorage
  역할 위조가 동시에 해소된다.** `scl_user` 신뢰 코드 제거
- `S.user.id`를 없앤다 (`userId`가 곧 문서 ID) → `core.js:68`·`report.js:725`의
  반복 조회 삭제
- **실사용자 로그인 확인 후 다음 단계로.** 문제가 생기면 배포 1 상태로 롤백 가능
  (구 `users/{구ID}` 문서가 살아 있음)

### 배포 3 — 잠금

- `firestore.rules` / `storage.rules` 적용
- 구 `users/{구ID}` 문서 삭제
- 이 시점부터 **비인증 접근이 차단된다**

### 배포 4 — 잔액 정정

- `services/balance.js` 도입 + 호출부 4곳 교체 → **새 손상이 멈춘다**
- 그 **다음에** 재계산 스크립트로 전 계좌 `currentBalance`를 바로잡는다
  (순서를 바꾸면 재계산 직후 다시 망가진다)
- 재계산 전 `accounts` 컬렉션을 백업해 둔다

### 토큰과 역할 변경

`createCustomToken(userId, { role, isAdmin })`으로 클레임을 토큰에 실으면
규칙에서 `request.auth.token.role`로 읽을 수 있다. 다만 **클레임이 토큰에 고정되므로
역할 변경은 재로그인 후 반영된다.** 이 앱에서 역할 변경은 드물어 수용 가능하다.
즉시 반영이 필요하면 `admin.auth().setCustomUserClaims()` + 클라이언트
`getIdToken(true)` 조합으로 바꾼다.

퇴사 처리(`active:false`)는 **ID 토큰 만료(기본 1시간)까지 유효**하다. 지금은
"탭 닫을 때까지 무제한"이므로 큰 개선이지만, 즉시 차단이 필요하면 민감한 쓰기
규칙에 `get(/databases/$(database)/documents/users/$(request.auth.uid)).data.active == true`를 추가한다(읽기 1회 비용).

### 기타

- Functions 리전을 Firestore와 같은 **`asia-northeast3`(서울)** 로 배포하고
  클라이언트 `httpsCallable`에도 같은 리전을 지정한다.
- `bootstrap`은 별도 함수 대신 **`signup` 안에서 처리한다** — `users`가 완전히
  비어 있을 때만 첫 계정을 `관리자 + approved:true`로 만들고 로그를 남긴다.
- 기존 `config/permissions` 문서는 **형식이 달라졌으므로 폐기하고 새로 만든다**
  (어차피 15개 키가 무반응이었다).

---

## 작업 순서

각 단계는 독립 배포 가능하다. **위에서부터** 진행한다.

### 1단계 — 데이터 보호 (지금)

설계 6의 4배포로 나눠 진행한다. 실행 절차와 단계별 확인 항목은 저장소의
`RUNBOOK.md`에 있다.

| # | 작업 | 배포 | 대상 | 상태 |
|---|---|---|---|---|
| 1 | Cloud Functions 4개 (`login`·`signup`+부트스트랩·`approveStaff`·`changePassword`) | 1 | `functions/` | ✅ 코드 완료 |
| 2 | 마이그레이션 스크립트 (사전 점검 + 실행 + 리포트) | 1 | `tools/migrate-auth.mjs` | ✅ 코드 완료 |
| 3 | 로그인·세션을 커스텀 토큰 / `onAuthStateChanged`로 교체 | 2 | `auth.js`, `app.js:338` | ✅ 코드 완료 |
| 4 | `firestore.rules` / `storage.rules` 잠그기, 구 문서 삭제 | 3 | 규칙 2개 | ✅ 코드 완료 |
| 5 | **잔액 단일화** (`calcAccountBalance` 도입) | 4 | `services/balance.js` | ✅ 코드 완료 (트리거가 소유) |
| 6 | **손상된 `currentBalance` 전량 재계산** | 4 | `tools/recalc-balances.mjs` | ✅ 코드 완료 |
| 7 | 복합 인덱스를 저장소에 기록 | 아무 때나 | `firestore.indexes.json` | ✅ 완료 (4개) |
| 8 | `escHtml()` 추가 + `innerHTML` 삽입 32곳 정리 | 아무 때나 | `utils/ui.js`, 전 모듈 | ⬜ 미착수 |

2번이 S5(팀장 결재 알림 0건)를, 3번이 S12(F5 로그아웃 + 역할 위조)를 함께 해소한다.
8번은 S0을 고치기 전까지 실질적 공격 경로이므로 1단계에 둔다.

**설계에서 바뀐 점 — `currentBalance`를 서버가 소유한다**

원래는 클라이언트 `updateAccBalance`가 계좌 전체 거래를 조회해 계산하는 안이었다.
그런데 **입력자는 보안 규칙상 타인이 작성한 거래를 읽을 수 없어** 클라이언트에서
올바른 계산이 원천적으로 불가능하다. 따라서 Cloud Functions 트리거로 옮겼다.

| 트리거 | 발동 | 하는 일 |
|---|---|---|
| `syncAccountBalance` | `transactions/*` 쓰기 | 해당 계좌(들) 재계산. 계좌가 바뀐 수정이면 양쪽 모두 |
| `syncAccountOnSettingsChange` | `accounts/*`의 기초잔액·기준일 변경 | 그 계좌 재계산. `currentBalance`만 바뀐 경우는 건너뛰어 루프 방지 |

클라이언트 `updateAccBalance`는 로컬 캐시만 갱신하는 낙관적 업데이트로 축소했고
Firestore 쓰기를 없앴다. 계산식이 브라우저(ESM)·서버(CJS) 두 파일로 존재하므로,
계좌 5종 × 거래 13종 = 65개 조합을 양쪽에 통과시켜 값이 같은지 검증하는
테스트를 넣었다(한쪽만 고치면 실패한다).

**배포 2에서 추가로 필요해진 것** — `users` 쓰기가 규칙에 막히므로 Functions 2개를 더 만들었다
- `upsertStaff` — 직원 등록·수정·비밀번호 변경 (단건·일괄 공용)
- `setStaffActive` — 재직·퇴사 전환. 마지막 관리자 비활성화를 서버에서 차단
- 관리자는 역할 select에서 빠지고 `isAdmin` 체크박스가 됐다.
  `can()`이 `isAdmin`을 인정하도록 고쳤다 — 없으면 마이그레이션 후 관리자가
  `settings.reset` 같은 전용 키를 전부 잃는다.

**시작 전 확인 사항**
- Firebase 프로젝트를 **Blaze 플랜으로 전환** (결제 수단 등록) — 전환 가능 확인됨
- `userId` 중복 계정이 있으면 **사람이 먼저 정리** (스크립트가 목록을 뽑아준다)
- `balance.js`의 기준일 경계 해석을 실제 통장 1건과 대조 (다르면 한 줄 변경)

### 2단계 — 신규 세팅이 되게 만들기

부트스트랩(`signup` 내 첫 계정 = 관리자)과 세션 재검증은 **1단계에서 이미 처리된다.**
여기서는 첫 로그인 이후 실제로 쓸 수 있게 만드는 부분만 남는다.

| # | 작업 | 대상 |
|---|---|---|
| 9 | 첫 로그인 시 기본 카테고리 자동 시딩 (빈 컬렉션 감지) | `settings.js:425` 로직 재사용 |
| 10 | 초기 설정 마법사 (관리자 → 입주자 → 계좌 → 기초잔액 → 카테고리) | 신규 |
| 11 | 빈 상태 막다른 길 수정 — 대시보드 CTA가 등록 권한 없는 사용자를 설정으로 보내는 문제 | `dashboard.js:16` |

### 3단계 — 모바일 통합 (설계 4)

| # | 작업 | 대상 |
|---|---|---|
| 12 | `app.js:366-720` 삭제 | `app.js` (약 355줄 감소) |
| 13 | 거래내역 표 → 좁은 화면 카드 레이아웃 (CSS) | `index.html` |
| 14 | 좁은 화면에서 보고서·설정 탭 숨김 + 안내 | `index.html`, `core.js:217` |
| 15 | `isMobile()` 분기 제거 | `auth.js:91`, `app.js` |

### 4단계 — 권한 교체 (설계 2)

| # | 작업 | 대상 |
|---|---|---|
| 16 | `permissions.js`를 등급표 방식으로 전면 교체 | `permissions.js` (149줄 → 약 50줄) |
| 17 | `users.isAdmin` 추가, 관리자 역할 데이터 마이그레이션 | `users`, `modals.js:1011` |
| 18 | 하드코딩 역할 비교 21곳을 `can()`으로 교체 | `report.js`, `core.js:150`, `app.js` |
| 19 | `core.js:30`을 `client.view.all`로 교체 | `core.js:30` |
| 20 | 실행 시점 가드 추가 (`saveTrx`·`delTrx`·`confirmBulkDelete` 등) | `transactions.js` |
| 21 | 권한 설정 UI를 등급 드롭다운으로 | `settings.js` 권한 탭 |
| 22 | 입력자 화면 축소 (위 표대로) | `auth.js:72-87`, `transactions.js` |

### 5단계 — 결재 흐름 (설계 5)

| # | 작업 | 대상 |
|---|---|---|
| 23 | 전이표 도입 + 실행 시점 검증 | `report.js:837` |
| 24 | 전이 시 이후 단계 도장 정리 | `report.js:891, 924` |
| 25 | 보고서에 `createdBy` 기록 → 회수 되살리기 | `report.js` 전 쓰기 경로 |
| 26 | `rejected` 탈출 경로 보장 (관리자 해제) | `report.js:777-833` |
| 27 | 작성일을 `createdAt`에서 읽기 | `report.js:291` |

### 6단계 — 파서 · 설정 화면 파손 수정

| # | 작업 | 대상 |
|---|---|---|
| 28 | `parser-config.js`를 ES 모듈로 전환(또는 삭제하고 `app.js`로 일원화) | `parser-config.js`, `index.html:61` |
| 29 | `toNumSigned` 괄호 음수·후행 마이너스 처리 | `app.js:327` |
| 30 | CSV 인코딩 감지 (`{fatal:true}` 후 EUC-KR 폴백) | `app.js:82-88` |
| 31 | 중복 키에 `accountId`·`description` 추가, 비교 대상을 해당 월 전체로 | `modals.js:372` |
| 32 | **파싱 실패·제외 행을 미리보기에 표시** (조용한 삭제 금지) | `modals.js:390-460` |
| 33 | 계좌·입주자 저장을 `setDoc` → `updateDoc`/merge로 | `modals.js:961, 1005` |
| 34 | `resetCategories`·`executeArchive`·`saveBudget`에 권한 검사 추가 | `settings.js` |
| 35 | 연도 마감을 배치 1건으로 원자화 + 비활성 계좌 포함 | `settings.js:475-522` |
| 36 | 자산이동 생성·삭제·유형변경 원자화, 한쪽만 남는 상태 금지 | `modals.js:143-176`, `transactions.js:463` |

### 7단계 — 성능 · 재발 방지

| # | 작업 | 대상 |
|---|---|---|
| 37 | `loadReportList`를 연도·상태 범위로 축소 | `report.js:1028` |
| 38 | 보고서 캐시를 거래내역 탭과 분리 | `report.js:37-51` |
| 39 | `h-start`/`h-end` 이중 바인딩 제거, 날짜는 `change`만 | `app.js:963-964` |
| 40 | `loadTransactions` 재진입 가드 | `core.js:161` |
| 41 | `applyFilters`에 `S.page=1` 추가 | `transactions.js:70` |
| 42 | 드래그 재정렬을 `sortOrder` 정렬 상태에서만 허용 | `transactions.js:576` |
| 43 | 리스너 누수 3곳 정리 (영수증·통장·설정 탭) | `modals.js:615`, `report.js:612`, `settings.js:748` |
| 44 | `firebase.json`에 HTML/JS `Cache-Control` 추가 | `firebase.json` |
| 45 | ESLint(`no-undef`, `no-unused-vars`) 도입, `lint.js` 대체 | `package.json` |
| 46 | 죽은 코드 삭제 (`services/firestore.js` 래퍼 26개 등) | 여러 파일 |
| 47 | 잔액·엑셀 파서 순수 함수 단위 테스트 | 신규 `test/` |
| 48 | 전역 158개 축소 — `onclick` 문자열 → 이벤트 위임 | `app.js:725-857` |

45번은 **전역 158개의 이름 오타를 배포 전에 잡아주는 유일한 장치**다.

---

## 검증 방법

### 지금 바로 확인 가능 (코드 수정 없이)

```bash
cat firestore.rules storage.rules                            # S0 — 전체 공개
cat firestore.indexes.json                                   # S6 — 비어 있음
npm run lint                                                 # S13 — 문법만 검사
grep -rn "role==='" public/ --include=*.js | wc -l           # S4 — 하드코딩 21곳
grep -rn "can('trx.create')" public/ | wc -l                 # S4 — 0건 (죽은 키)
grep -rn "createdBy" public/modules/report.js                # S6 — 읽기만, 쓰기 0건
grep -n "value=\"\${u.id}\"\|value=\"\${u.userId}\"" public/modules/modals.js   # S5 — 키 공간 2종
```

### 배포본에서 재현 (https://smart-care-ledger.web.app)

1. **S1 잔액 손상** — 지난달 거래가 있는 계좌의 대시보드 잔액을 적어둔다. 당월 거래를
   하나 수정·저장한다. 잔액이 **기초잔액 + 당월 합계**로 바뀌는지 확인. 같은 계좌의
   보고서 잔액과 비교하면 값이 다르다.
2. **S1 모바일 리셋** — 휴대폰에서 거래를 하나 입력한다. 해당 계좌 잔액이
   **기초잔액으로 리셋**되는지 확인.
3. **S12 세션** — 로그인 후 F5. 로그인 화면으로 돌아가는지 확인.
4. **S3 결재 우회** — 센터장 계정으로 휴대폰 접속. 팀장 미결재(`submitted`) 보고서에
   **"팀장 결재" 버튼이 뜨는지** 확인. 데스크톱에서는 팀장 공석일 때만 떠야 한다.
5. **S5 결재 알림** — 팀장 계정 로그인. 담당 입주자의 제출된 보고서가 있어도
   **결재 대기 뱃지가 0인지** 확인.
6. **S7 엑셀 중복** — 같은 명세서를 두 번 업로드. 경고 없이 **두 벌 저장되는지** 확인.
7. **S9 통장사진 삭제** — 통장 사진이 있는 계좌를 설정에서 열고 라벨만 바꿔 저장.
   **사진 목록이 사라지는지** 확인.
8. **S11 빈 표** — 거래를 5페이지까지 넘긴 뒤 검색어로 결과를 3건 이하로 좁힌다.
   **빈 표 + `총 3건 (401–3)`** 과 1페이지 복귀 불가를 확인.
9. **S2 부트스트랩** — 새 Firebase 프로젝트에 배포 후 회원가입만으로 로그인되는지 확인
   (되지 않아야 정상 재현).

### 마이그레이션 검증 (1단계 전용)

배포마다 다음을 통과해야 다음 배포로 넘어간다.

**배포 1 이후** — 앱은 평소대로 동작해야 한다(아직 아무것도 바뀌지 않음)
- 기존 계정으로 로그인·거래 입력·보고서 조회가 **전부 정상**인지
- 스크립트 리포트에 `userId` 중복 **0건**, `teamLeader` 매핑 실패 **0건**
- `users/{userId}` 신규 문서 수 == 구 문서 수, `userSecrets` 수도 동일
- 신규 `users` 문서에 `password` 필드가 **없는지**

**배포 2 이후**
- 각 역할 계정으로 로그인 → 커스텀 토큰 발급 확인
- **F5를 눌러도 로그인이 유지되는지** (S12 해소 확인)
- 개발자도구에서 `sessionStorage`를 조작해도 **역할이 바뀌지 않는지**
- **팀장 계정에서 결재 대기 뱃지에 건수가 잡히는지** (S5 해소 확인 — 이 항목이
  마이그레이션 성공의 가장 좋은 신호다)
- 문제 발생 시 → `auth.js`만 되돌리면 구 문서로 롤백된다

**배포 3 이후**
- 로그아웃 상태에서 Firestore REST로 `users` 조회 → **거부**
- 입력자 토큰으로 타인 작성 거래 조회 → **거부**
- Storage 객체를 비인증 `curl`로 요청 → **거부**

**배포 4 이후**
- 재계산 전후 `accounts` 백업을 비교해 **변화량이 설명 가능한지** 확인
  (많은 계좌가 크게 바뀌는 것이 정상 — 손상돼 있었으므로)
- 표본 계좌 3개를 손으로 검산: 기초잔액 + 기준일 이후 전체 거래 합
- 대시보드·보고서·설정 계좌 목록 **3곳 숫자 일치**

### 수정 후 회귀 확인

- **보안**: 로그아웃 상태에서 Firestore REST로 `users` 조회 → **거부**.
  입력자 계정 토큰으로 타인 작성 거래 조회 → **거부**. 콘솔에서 `delTrx(...)` 직접 호출 → **거부**
- **잔액**: 대시보드 · 보고서 · 설정 계좌 목록 **3곳의 숫자가 일치.**
  거래 저장·수정·삭제·엑셀 업로드·일괄삭제·자산이동·연도 마감 후에도 유지
- **결재**: 담당자 제출 → 팀장 결재 → 센터장 최종. 단계 건너뛰기 **차단**.
  결재 취소 후 인쇄물에 **이전 결재자 이름이 남지 않는지**. 반려 보고서를 관리자가 해제 가능한지
- **결재 알림**: 팀장 로그인 시 담당 입주자의 제출 보고서가 뱃지에 잡히는지
- **권한**: 관리자가 등급을 바꾸면 **결재 버튼을 포함해** 모든 화면에 반영되는지.
  입력자 계정에서 보고서·설정·엑셀이 보이지 않고, 담당 입주자·본인 작성분만 보이는지
- **모바일**: 좁은 화면에서 조회·수기입력만 노출되고, 넓은 화면과 **같은 잔액·같은 정렬**이 나오는지
- **엑셀**: EUC-KR CSV 인식, `(5,000)` 음수 인식, 같은 파일 재업로드 시 전건 중복 감지,
  제외된 행이 미리보기에 표시되는지
- `npm run lint` (ESLint 도입 후) 무경고, 단위 테스트 통과

---

## 규모 요약

| 항목 | 현재 | 이후 |
|---|---|---|
| 프론트엔드 | 7,774줄 | 약 6,900줄 (모바일 355 + 죽은 코드 500 감소) |
| 신규 | — | `functions/` 약 250줄, `services/balance.js` 약 40줄, `test/` |
| 권한 설정 | 체크박스 160개 (15키 무반응) | 등급 드롭다운 약 30개, 전부 동작 |
| 잔액 계산식 | 4벌 | **1벌** |
| 결재 구현 | 2벌 (데스크톱·모바일) | **1벌** |
| 권한 판정 | `can()` 38곳 + 하드코딩 21곳 | **`can()` 단일 + 서버 규칙 재검증** |
