# CLAUDE.md — Smart Care Ledger 프로젝트 총괄 문서

> 이 문서는 AI 에이전트가 프로젝트 전체 맥락을 파악하기 위한 핵심 참조 문서입니다.
> 모든 작업 전에 반드시 이 파일을 먼저 읽으세요.

---

## 1. 프로젝트 개요

**Smart Care Ledger v2.x**
사회복지사 전용 입주자 금전관리 시스템. Google Apps Script(GAS) v17에서 Firebase(Firestore + Hosting)로 마이그레이션 완료.

- **배포 URL**: https://smart-care-ledger.web.app
- **인증 방식**: Firestore `users` 컬렉션의 userId/password 직접 비교 (Firebase Auth 미사용)
- **세션**: sessionStorage 기반

---

## 2. 파일 구조

앱은 ES 모듈로 분리되어 있습니다. 프론트엔드 파일은 `public/` 하위에 있습니다.

| 파일 | 경로 | 설명 |
|---|---|---|
| `index.html` | `public/index.html` | 전체 HTML + CSS + 구조 |
| `app.js` | `public/app.js` | 전역 초기화 및 이벤트 바인딩 |
| `constants.js` | `public/constants.js` | 상수(COLS, 색상 등) 정의 |
| `state.js` | `public/state.js` | 전역 상태(S) |
| `parser-config.js` | `public/parser-config.js` | 은행별 엑셀 파서 설정 (ES 모듈, 유일한 설정) |
| `manifest.json` / `sw.js` | `public/` | PWA 매니페스트 / 서비스 워커 |
| 기능 모듈 | `public/modules/*.js` | auth, core, dashboard, transactions, report, settings, modals, permissions, fixed-items, report-actor, report-accounts(계좌 현황 계산), report-excel(엑셀 저장), report-inline-edit(칸별 제자리 수정), report-bank-photos(통장사진 창), client-picker(입주자 찾기), bank-parser-ui(은행 추가 화면), settings-permissions |
| 서비스 | `public/services/*.js` | firestore, image(이미지 압축·판독용 해상도), storage, balance(잔액 계산), excel-parser, bank-parser-guess(열 자동 추천), receipt-upload, scoped-fetch, in-query |
| 도메인 | `public/domain/*.js` | 순수 판정 — 결재 전이표, 잔액·집계 규칙, `timestamps`(시각 변환), `report-stamps`(결재 도장이 말하는 이름), `ledger-edit-window`(§6-1), `hangul-search`(초성 검색), `bank-parser`(저장된 은행 설정) |
| 유틸 | `public/utils/ui.js` | UI 유틸리티 |
| 아이콘 | `public/utils/icons.js` | 인라인 SVG 한 벌 (§7 모바일) |
| `firestore.rules` | `firestore.rules` (루트) | Firestore 보안 규칙 |

---

## 3. Firestore 컬렉션 구조

```
users:        { userId, password, name, role, team }   // team: config/teams 의 이름
clients:      { clientId, name, userIds, teamLeader, team, contact, memo }
accounts:     { accountId, clientId, label, accountNumber,
                initialBalance, initialBalanceDate, currentBalance,
                monthEndBalances: { 'YYYY-MM': 말잔 },   // 서버 전용 (§14)
                bankStatements: [{url, thumbUrl, month}] }
transactions: { trxId, clientId, accountId, date, type, category,
                subcategory, description, amountIn, amountOut,
                method, excludeFromTotals,
                receiptUrl, sortOrder, isFixed, fixedItemId,
                linkedAccountId, linkedTrxId }
categories:   { keyword, type, category, subcategory,
                clientId(optional), sortOrder }
reports:      { reportId, clientId, year, month, status, summary,
                createdAt, submittedAt/By/ByName,
                teamApprovedAt/By/ByName, centerApprovedAt/By/ByName,
                rejectedAt/By/ByName,
                staffComment, leaderComment, centerComment }
config:       { type='archive', year, archivedAt, count }
              // 'permissions' 문서: 역할별 권한 오버라이드 저장
              // 'teams' 문서: { teams:[{id,name,leaderUid,active}] } — §4-1
              // 'bankParsers' 문서: { parsers:[{key,label,DATE,DESC,…}] } — §10-1
fixedItems:   { clientId, accountId, type, day, category,
                description, amount }
budgets:      { clientId, year, categoryBudgets{...} }  // 연간 예산
excelUploads: { accId, clientId, filename, month, count, url, uploadedAt }
              // 원본 파일은 gzip 압축 저장(용량 절감), rawRows는 미저장
archive_YYYY: 마감된 거래 데이터 백업
```

> 컬렉션 상수는 `public/constants.js`의 `COLS` 참조.

---

## 4. 역할(Role) 체계

**역할은 누적되지 않는다.** 팀장은 "담당자 + 결재"가 아니다 — 검토 역할은
거래 입력·보고서 작성 권한을 아예 갖지 않는다(작성자와 결재자의 분리).

| 역할 | 할 수 있는 일 | 갖지 않는 것 |
|---|---|---|
| 입력자 | 거래 입력·수정, 본인 거래에 증빙 | 동료 거래 조회, 엑셀, 보고서, 설정 |
| 담당자 | 거래 입력·수정·자산이동, 엑셀·증빙·통장, 보고서 작성·제출·회수, 입주자별 분류·고정항목·예산, **담당 입주자의 계좌** | 결재, 시설 개설(입주자·공통분류), 변경 이력 |
| 팀장 | 보고서 1차 결재·반려, 담당 배정, 시설 개설(입주자·계좌·공통분류), **결재 전 거래 정정**(§6-1) | **거래 입력(신규)·자산이동, 보고서 작성·제출**, 변경 이력 |
| 센터장 | 팀장이 하는 일 + 최종 결재·결재 취소, 전 입주자 조회, 연도 마감 | **거래 입력(신규)·자산이동, 보고서 작성·제출**, 1차 결재 |
| 관리자(플래그) | 직원 계정 운영, 변경 이력, 감사·AI·백업 | 업무 권한 일체 — 역할과 **직교**한다 |

> 계좌 관리(`settings.account`)는 담당자부터 갖는다. **키 자체에는 범위가 없고**,
> `accounts` 규칙의 `seesClient` 가 담당 배정 밖을 막는다 — 담당자에게 주면
> 자동으로 담당 범위가 된다. `clientId` 는 불변이라 계좌를 남의 입주자에게
> 옮길 수 없고, UI 는 물리 삭제 대신 비활성을 쓴다.
>
> 변경 이력(`audit.view`)은 **감독** 권한이라 센터장과 관리자에게만 있다.
> 장부를 쓰는 사람이 서로의 수정 이력을 들여다볼 이유가 없다.

> **권한의 출처는 `public/domain/fixed-role-policy.js` 하나뿐이다.**
> 역할마다 허용 키를 나열한 **고정 정책**이고, 관리자도 바꿀 수 없다.
> `savePermissions` 는 항상 거절한다. 설정→권한 화면은 읽기 전용 안내다.
>
> 서버 사본 `functions/fixed-role-policy.cjs` 는 **생성물**이다
> (`node tools/gen-fixed-role-policy.mjs`). 손으로 고치지 말 것.
>
> 판정 근거는 **`authz/{uid}` 문서**다. 규칙·함수가 그 문서의 `role`·`enabled`·
> 담당 목록을 읽고, 같은 고정 정책으로 판정한다. 화면의 `can('key')` 도 같은
> 함수(`fixedCan`)를 쓴다 — "버튼은 보이는데 서버가 거부한다"가 생기지 않는다.
>
> ⚠️ `firestore.rules` · `storage.rules` 의 `cap()` 안에도 같은 표가 **손으로**
> 적혀 있다(규칙은 import 를 못 한다). 어긋나면 계약 게이트가 잡는다 —
> firestore 는 정확히 일치, storage 는 부분집합.
>
> ⚠️ 커스텀 토큰에는 역할이 실리지 않는다. 클레임은 발급 시점에 굳어서
> 강등·퇴사를 반영하지 못한다 — 매 호출·매 규칙 평가마다 authz 를 읽는다.
>
> `public/domain/perm-catalog.js` 는 **권한의 근거가 아니다.** 집행 지점
> 메타데이터와 키 누락 감지에만 쓰이는 표시·검증용 자료다.

### 팀 — 고르는 범위이지 권한이 아니다

`users.team` 이 자유 입력 텍스트였다. 「1팀」·「1 팀」·「일팀」이 서로 다른 팀이
되고 목록도 검증도 없었다. 이제 팀은 **`config/teams` 문서 하나**에 모여 있다
(`{ teams:[{id,name,leaderUid,active}] }`).

| 어디서 | 무엇이 달라지나 |
|---|---|
| 직원 폼 | 팀을 **목록에서 고른다**(자유 입력 아님). 목록이 비어 있으면 예전처럼 받는다 |
| 입주자 폼 | 팀을 정하면 담당 팀장이 그 팀 팀장으로 채워지고, 담당 직원 후보가 그 팀으로 좁혀진다 |
| `saveClient` | 팀이 정해진 입주자에 **그 팀이 아닌 담당**이 들어오면 거절한다 |
| 설정 → 팀 | 팀·팀장 관리(`assignments.manage`). 「직원 정보에서 가져오기」가 마이그레이션이다 |

> ⚠️ **팀은 권한의 축이 아니다.** 누가 무엇을 보는지는 여전히 `clients.userIds` ·
> `clients.teamLeader` 의 투영본(`authz`)이 정한다. 팀을 권한 축으로 올리면
> authz · `firestore.rules` · `storage.rules` · 계약 게이트를 전부 다시 맞춰야
> 하고, 투영본이 어긋나는 순간 결재가 조용히 막힌다 — 그 고장을 이미 겪었다.
> `test/teams.test.mjs` 의 「규칙과 투영본은 팀을 모른다」가 이 선을 지킨다.
>
> 판정은 `public/domain/teams.js` 와 서버 사본 `functions/teams.cjs` 두 벌이고,
> 같은 표로 대조한다. 화면만 막으면 콜러블을 직접 부르는 경로가 남고, 서버만
> 막으면 사용자는 저장을 누른 뒤에야 안다.
>
> 팀 목록은 **고를 일이 있는 사람만 읽는다**(`assignments.manage` 또는
> `settings.staff`). 담당자·입력자는 한 건도 쓰지 않는다 — §12-1.

### 아무도 가질 수 없는 권한 — 두 부류이고 구분이 중요하다

닫혀 있는 것이 기능 누락처럼 보이지만 **의도된 것이다.** 다만 두 부류를
섞으면 안 된다. 한때 섞여 있었고, 그래서 "절차가 없어 잠시 닫은 것"이
"영원히 없는 것"처럼 굳어 **빈 배포가 기동되지 않았다**(시설 개설 권한).

`fixed-role-policy.js` 의 `FORBIDDEN_KEYS` · `PENDING_PROCEDURE_KEYS` 로
나뉘고, `deniedReason(key)` 가 `'forbidden' | 'pending' | null` 을 준다.
화면 문구도 이것으로 갈린다(`unavailableMessage`).

**영구히 없다** — 되살리려면 이 정책의 전제를 바꿔야 한다.

| 권한 | 왜 |
|---|---|
| `settings.permissions` | 정책 자체 편집 — 고정 정책의 존재 이유 |
| `lock.bypass` · `settings.reset` | 통제 우회(마감 월 편집 · 전체 초기화) |
| `report.release` | 반려건이 결재 단계를 건너뛰는 탈출구. 전이표에도 없다 |

**절차 대기** — 위험해서가 아니라 안전한 절차가 아직 없어서. 절차가 생기면 열린다.
지금 이 목록은 **비어 있다.** 지금까지 둘이 절차를 얻어 열렸다:

| 한때 닫혀 있던 것 | 무엇이 생겨서 열렸나 |
|---|---|
| `settings.client` · `settings.account` · `settings.category.common` | `saveClient` 신규 등록 + `accounts` 규칙의 담당 범위 검사 |
| `trx.delete` · `trx.delete.bulk` · `report.delete` | **제출 전에만** 삭제(아래). 권한이 아니라 상태가 막는다 |

입주자 **비활성·물리 삭제**(`setClientActive` · `deleteClient`)는 여전히 절차가
없어 콜러블이 `failed-precondition` 으로 거절한다. 등록·수정은 열려 있다.

### 삭제는 제출 전에만 — 두 번째 색인

삭제 수요는 대부분 엑셀 중복 업로드와 입력 오타이고, 둘 다 제출 전에 드러난다.
제출 뒤에 지우면 결재자가 본 숫자와 장부가 달라지므로, **회수·결재 취소로
`draft` 로 내린 뒤** 지우는 것이 정상 경로다.

`config/lockedMonths` 문서가 색인을 **세 개** 담는다. 질문이 다르다.

| 색인 | 질문 | 막는 것 | 채우는 상태 |
|---|---|---|---|
| `months` | 최종 결재가 끝났는가 | 수정 · 삭제 **둘 다**, 누구에게나 | `confirmed` |
| `approvedMonths` | 팀장 결재가 끝났는가 | **팀장의** 수정 | `team_approved` · `confirmed` |
| `submittedMonths` | 결재 절차에 올라갔는가 | **담당자·입력자의** 수정, 그리고 삭제 | `submitted` · `team_approved` · `confirmed` |

한 문서에 둔 이유: 거래 쓰기 한 번당 규칙 조회가 늘지 않게 하기 위해서다.
판정은 `functions/locked-months.cjs` 한 곳이고, 화면은 같은 색인을 읽어
`core.js` 의 `trxDeleteBlockReason()` · `trxEditBlockReason()` 으로 답한다 —
근거가 갈라지면 버튼은 보이는데 서버가 거부한다.

세 색인은 층을 이룬다(`months ⊂ approvedMonths ⊂ submittedMonths`). 깨지면
「팀장은 못 고치는데 담당자는 고칠 수 있는 달」처럼 뜻이 없는 상태가 생긴다 —
`test/locked-months.test.mjs` 가 이 포함 관계를 지킨다.

> ⚠️ **배포 시**: `submittedMonths` · `approvedMonths` 는 처음에 없다. 그 상태에서는
> 결재 중인 달의 거래도 지워지고 고쳐진다(색인이 비면 "제출된 달 없음"으로 읽힌다).
> 배포 뒤 **설정 → 파생 문서 다시 만들기**(`rebuildLockedMonths`)를 눌러 백필한다.
> 센터장(`settings.archive`) 또는 관리자(`system.backup`)가 실행할 수 있다.

> ⚠️ 닫힌 키는 반드시 둘 중 한 부류에 속해야 한다. 분류되지 않은 채 닫히면
> 화면이 이유를 말할 수 없고, 사용자는 "내 등급이 낮아서"로 읽어 상급자에게
> 요청하러 간다 — 그쪽도 못 하므로 서로 시간만 쓴다.
> `test/fixed-role-policy.test.mjs` 의 「닫힌 권한은 빠짐없이 한 부류로 분류된다」가
> 이 불변식을 지킨다(반대 방향 — 분류해 두고 실제로는 열려 있는 것 — 도 잡는다).

---

## 5. 결재 흐름

전이표는 `public/modules/report-workflow.js`의 `TRANSITIONS` 하나뿐이고,
**모든 결재 동작이 `applyReportTransition()`을 통과한다.** 버튼 표시 여부와
무관하게 실행 시점에 현재 상태를 확인하므로 단계를 건너뛸 수 없다.

```
draft ──submit──▶ submitted ──approveTeam──▶ team_approved ──approveCenter──▶ confirmed
  ▲                   │  ▲                       │                               │
  └─recall(작성자)────┘  └──────revert(팀장)─────┘                               │
  ▲                   └───reject──▶ rejected ◀───┘                               │
  └─submit────────────────────────────┘          ◀────────revert(센터장)─────────┘
```

| 액션 | 필요 권한 | 비고 |
|---|---|---|
| `save` | `report.draft` | 임시저장 |
| `submit` | `report.submit` | |
| `approveTeam` | `report.approve.team` + 배정 팀장 | |
| `approveCenter` | `report.approve.center` | |
| `reject` | `report.reject` + 지금 결재할 차례인 사람 | 사유 필수 |
| `recall` | **작성자(`createdBy`)**+`report.recall` | 팀장 결재 전까지 |
| `revert` | 직전 단계의 결재 권한 (confirmed는 `report.revert`) | 한 단계씩 |

### 회수·반려·결재 취소 — 셋이 같은 일을 하지 않게

한때 팀장 화면에 「회수」·「반려」·「수정(초안)」이 나란히 떴고, 앞의 둘은
결과가 같았다(둘 다 draft 로 내렸다). 결재자는 무엇을 눌러야 하는지 알 수 없었고,
회수로 내리면 **사유가 남지 않아** 담당자는 왜 내려왔는지 알 방법이 없었다.

| 누가 | 무엇을 | 언제 | 어디로 |
|---|---|---|---|
| 담당자 | 회수(`recall`) | 팀장 결재 전 | submitted → draft |
| 팀장 | 반려(`reject`) | 내가 결재하기 전에 오류를 봤을 때 | submitted → rejected (사유 필수) |
| 팀장 | 회수(`revert`) | 내가 결재한 뒤, 센터장 결재 전 | team_approved → submitted |
| 센터장 | 최종 결재 취소(`revert`) | 최종 결재 뒤 | confirmed → team_approved |

`submitted` 에서 `revert`(수정(초안))와 `team_approved` 에서 `recall` 은
**전이표에서 지웠다.** 앞의 것은 회수와 결과가 같고, 뒤의 것은 "되가져올 제출"이
아니라 "취소할 결재"가 있는 자리다. 팀장이 초안까지 내리려면 revert → 담당자
recall 두 걸음이고, 각 걸음의 주인이 분명하다.

**전이표에 없는 동작** — 이름만 남기지 않는다. 표에 없으면 권한 검사에 닿기
전에 거부된다.

| 없는 동작 | 왜 없나 |
|---|---|
| `submitAsLeader` | 팀장은 `report.submit`을 갖지 않는다(역할 분리). 어떤 주체로도 성립하지 않아 제거했다 |
| 팀장의 `recall` | 반려와 결과가 같으면서 사유가 남지 않는 길이었다. 결재자가 내리는 동작은 `reject` 하나다 |
| `approveTeamProxy` | 자리가 비었다는 이유만으로 팀장 단계를 건너뛰면 2단 결재가 1단이 된다. 공석은 **정식 대행 지정**으로 푼다(절차 미구현) |
| `release` | 반려건은 작성·제출 절차로만 다시 올라간다. 담당자 부재는 담당 배정 변경으로 푼다 |

- **도장 정리**: 전이할 때마다 도착 상태보다 뒤 단계의 결재 기록을
  `deleteField()`로 지운다. 취소된 서명이 인쇄물에 남지 않는다.
- **`createdBy`**: 보고서를 만드는 모든 경로가 기록한다. 회수 권한 판정의 근거.
- **문서에 찍히는 날짜는 제출일**(`submittedAt`)이다. `createdAt` 은 임시저장을
  처음 누른 시점이라 며칠 손보다 올린 보고서에서는 결재자가 본 날짜와 어긋난다.
  제출 전에는 작성일을 쓰고 **이름표도 함께 바꾼다**(`domain/timestamps.js` 의
  `reportDateLine`) — 같은 자리에 다른 뜻이 들어가는데 이름이 그대로면 속는다.
  > ⚠️ 시각은 두 모양으로 저장된다: 결재 도장은 **ISO 문자열**(전이표가 만든다),
  > `createdAt`·`archivedAt` 등은 **Firestore Timestamp**(서버가 찍는다).
  > `new Date(값)` 은 앞의 것만 처리한다 — 뒤의 것을 넣으면 조용히 Invalid Date 가
  > 되고 그 글자가 인쇄물에 남는다(실제로 그랬다). 변환은
  > `public/domain/timestamps.js` 하나이고, 화면이 직접 `new Date()` 로 감싸면
  > `test/timestamps.test.mjs` 가 실패한다.
- **`rejected`에서 나가는 길**: 담당자 재제출(`submit`) 하나다. 담당자가
  부재면 담당 배정을 바꿔 다른 담당자가 제출한다 — 결재 단계를 건너뛰는
  탈출구는 두지 않는다.

## 6. 거래 유형(type)과 「합계 제외」

**유형은 수입·지출 둘뿐이다.** 그리고 **잔액은 유형을 보지 않는다** —
모든 거래가 들어간다(`services/balance.js`). 합계에서 뺄지 말지는
`excludeFromTotals` 표시 하나가 정한다.

| | 수입/지출 집계 | 잔액 반영 |
|---|---|---|
| 수입 · 지출 | ✅ | ✅ |
| 「합계 제외」 표시 | ❌ | ✅ |

> 판정은 `public/domain/trx-totals.js`의 `countsInTotals()` **한 곳**이다.
> 예전에는 `type==='자산이동'||type==='취소'` 가 열한 곳에 손으로 적혀 있었고,
> 한 곳만 빠뜨리면 보고서 합계와 대시보드 카드가 달라졌다.

### 구형 유형 — 새로 만들 수는 없고, 읽기는 그대로

`자산이동`·`취소`는 **"합계에는 안 들어가지만 잔액에는 들어간다"는 한 가지
성질**을 말하려고 만든 유형이었다. 그 대가로 자산이동은 두 거래를 서로 링크하는
콜러블(`saveTransfer`)과 규칙 예외를 달고 있었는데, 실제로 쓰는 사람은 많지
않았다. 성질에 이름을 주니 유형은 둘로 줄고 나머지는 체크 한 칸이 됐다.

이미 저장된 것은 **고쳐 쓰지 않는다.** 결재가 끝난 달의 숫자가 배포 때문에
달라지면 안 되므로, 두 유형을 「합계 제외」와 같은 뜻으로 읽는다. 수기 입력
폼은 그런 거래를 **열었을 때만** 그 유형을 보여 준다(`legacyTypeOption`) —
목록에 없으면 select 가 「지출」로 떨어지고, 저장을 누르는 순간 짝이 있는
자산이동이 말없이 지출로 바뀐다.

> ⚠️ **취소가 이제 잔액에 반영된다.** 예전에는 건너뛰었다("카드 승인이
> 취소됐으니 돈이 안 나갔다"). 그런데 현장에서 더 흔한 것은 이미 빠져나간
> 돈이 돌아오는 경우였고, 그때는 통장 잔액과 장부가 그 금액만큼 어긋났다.
> **기존 취소 거래가 있는 계좌는 잔액이 달라진다** — 배포 뒤
> `node tools/recalc-balances.mjs`(먼저 드라이런)로 `currentBalance` 를
> 다시 만든다.

## 6-1. 장부를 고칠 수 있는 창 — 「내가 결재하기 전까지」

결재는 **"그 시점의 숫자를 내가 봤다"는 서명**이다. 서명한 뒤에 장부가 바뀌면
서명이 가리키는 대상이 사라진다. 반대로 아직 서명하지 않은 사람은 지금 보고 있는
것을 고칠 수 있어야 한다 — 그러지 않으면 오타 하나에도 반려하고 담당자를
기다렸다가 다시 결재하는 왕복이 생긴다.

| 역할 | 고칠 수 있는 동안 | 닫히는 순간 |
|---|---|---|
| 입력자 · 담당자 | `draft` · `rejected` | 제출 |
| 팀장 | `draft` · `rejected` · `submitted` | 팀장 결재 |
| 센터장 | 최종 결재 전 전부 | 최종 결재 |

닫힌 뒤에 고치려면 **회수·반려·결재 취소로 상태를 되돌린다**(§5). 문구도 그것을
말한다 — 못 한다는 말만 남기면 사용자가 다음에 할 일을 모른다.

- 판정은 `public/domain/ledger-edit-window.js` 하나이고, 규칙의
  `editableStage()` 가 같은 표를 손으로 들고 있다(규칙은 import 를 못 한다).
  `test/ledger-edit-window.test.mjs` 가 둘을 대조한다.
- 근거는 §4의 **세 색인**이다. 규칙은 거래를 쓸 때 그 달의 보고서를 찾아 읽을 수
  없다 — 쓰기 한 번마다 조회가 늘고, 애초에 쿼리를 못 한다.
- 그래서 **팀장·센터장에게 `trx.edit` 이 있다.** 「작성자와 결재자의 분리」가
  막는 것은 *내가 쓴 것을 내가 결재하는 것*이고, 서명 전 숫자를 고치는 것은 결재가
  아니라 검토다. `trx.create` · `trx.transfer` · `report.submit` 은 여전히 없다 —
  오타를 고치는 것과 없는 거래를 만들어 넣는 것은 다른 일이다.
- 보고서 표에서 **누른 칸이 곧 고치는 칸이다.** 한 칸 고치려고 폼을 띄우면 눈은
  고칠 곳을 다시 찾고 손은 저장까지 세 번을 더 누른다.

  | 누른 곳 | 무엇이 열리나 | 어디에 |
  |---|---|---|
  | 날짜 · 내용 · 수입 · 지출 | **그 자리가 입력칸**이 된다 | `report-inline-edit.js` |
  | 분류 | 인라인 드롭다운(거래내역 탭과 **같은 것**) | `openCatDropdownUI` |
  | 증빙 오른쪽 「수정」 | 수기 입력 폼 — 여러 칸을 함께 고칠 때 | `openTrxFromReport` |

  인라인 입력칸의 규칙: **Enter 만 저장**이고, Esc 와 칸 이탈(blur)은 취소다. 표를
  정리하다 보면 다음 칸을 누르거나 눈이 다른 줄로 가는 일이 잦은데, 그때마다 손대던
  값이 저장되면 무엇이 언제 바뀌었는지 셀 수 없다 — 고치려던 것을 놓치면 다시 누르면
  되지만 안 고치려던 것이 저장되면 되돌릴 방법이 없다. **거부되면 원래 보이던
  것을 그대로 되돌린다** — 입력칸이 남아 있으면 고쳐진 줄 알고 넘어간다. 편집 중인
  칸은 하나뿐이고(둘이면 어느 쪽이 저장될지 모른다), 여는 동안 그 줄의 드래그를
  끈다(끌 수 있는 줄 안에서는 글자를 마우스로 고를 수 없다).

  무엇을 보낼지는 `fieldPatch()` 하나가 정한다 — **바뀐 칸과 판정에 필요한 것만.**
  금액을 고치면 반대쪽을 비우고 유형을 맞추지만, 구형 유형(자산이동·취소)은
  건드리지 않는다(§6). 저장은 언제나 `saveTrx` 하나를 지나므로 잠금·권한·잔액
  갱신이 폼으로 고칠 때와 똑같다.

  「수정」 버튼 칸은 **화면 전용 열**이다(`no-print`) — 인쇄물의 칸을 뺏지 않는다.
  hover 는 줄 전체에 밑줄(어느 줄을 보고 있는지), 고칠 수 있는 칸에는 진한 배경.
  손가락 커서는 그 칸에만 준다 — 줄 전체에 주면 못 고치는 칸도 눌러 보게 된다.

  드롭다운은 `openCatDropdownUI` 하나를 쓴다. 다만 **같은 거래가 두 화면에 동시에
  있을 수 있어**(거래내역 탭과 보고서) 칸 id 를 부르는 쪽이 정한다 — `dd-<trxId>`
  로 고정하면 보고서에서 누른 드롭다운이 숨어 있는 탭에서 열린다.
  `saveCatChange` 는 `trx.category.edit` **또는** `trx.edit` 을 본다: 규칙은 바뀐
  필드가 분류뿐이면 `trxEdit` 으로 통과시키므로, 앞의 키만 보면 검토 역할에게
  서버는 허용하는데 화면이 먼저 거부한다.

  저장하면 열려 있는 보고서가 스스로 다시 그린다 — 신호는 **모든 거래 쓰기가
  지나는 자리**(`invalidateReportTrxCache`)에서 온다. 저장하는 쪽마다 콜백을 꿰면
  언젠가 한 곳을 빠뜨린다. 다시 그릴 때는 **보던 자리를 지킨다**
  (`reloadReportKeepingScroll`) — 한 줄 고칠 때마다 맨 위로 튀면 스무 줄짜리
  보고서를 정리하는 동안 스무 번을 도로 내려와야 한다. 스크롤은 창이 아니라
  `main` 이 한다.

### 결제수단(`method`)

분류(무엇에 썼나)와 **다른 축**이다. 통장 적요에서 읽어
`카드 · 계좌이체 · 자동이체 · 현금` 중 하나를 붙이고, 모르면 비워 둔다.
판정은 `public/domain/payment-method.js` 하나이고, **`NOISE_WORDS` 로 다듬기
전의 원문**(`descRaw`)에서 한다 — 다듬으면서 지우는 단어들
(`체크카드`·`일시불`·`승인`·`전자금융`·`CD이체`)이 정확히 그 단서다.

---

## 7. 구현 완료 기능 목록

### 인증/세션
- [x] ID/PW 로그인 (Firestore 직접 비교)
- [x] sessionStorage 세션 유지
- [x] 로그아웃

### 대시보드
- [x] 입주자 카드 그리드 표시
- [x] 카드 클릭 → 거래내역으로 이동
- [x] 당월 집계(수입/지출·미분류·고정항목 미납)는 **거래를 쓰는 역할만** 읽는다

> 카드의 당월 숫자는 장부를 쓰는 사람이 오늘 무엇을 더 해야 하는지 보는 값이다.
> 팀장·센터장은 거래를 입력하지 않으므로(§4 작성자와 결재자의 분리) 읽지 않는다 —
> 결재할 숫자는 보고서에서 본다. `core.js` 가 `can('trx.create')` 로 막는다.
>
> 읽기로도 이것이 센터장 한 세션에서 가장 큰 항목이었다(전 입주자의 요약 캐시 +
> 낡은 것의 재계산). `node tools/read-budget.mjs` 로 모델을 볼 수 있다.
>
> ⚠️ 읽지 않았으면 `S.monthlyStats` 는 `{}` 가 아니라 **`null`** 이다. 빈 객체로
> 두면 카드가 「당월 거래 없음」이라고 적어 **읽지 않은 것을 0으로 보고한다** —
> 절약이 거짓말이 된다. `test/read-budget.test.mjs` 가 이 둘을 함께 지킨다.

### 거래내역
- [x] 입주자 **찾기**(목록 아님) — 이름·팀·담당자로, 초성 포함. 줄마다 팀·담당
      직원을 함께 적어 동명이인을 가른다 (`modules/client-picker.js`)

> ⚠️ 피커는 **범위를 스스로 판정하지 않는다.** 목록은 `S.clients` 그대로이고,
> 그것은 `myScope()` 가 authz(담당 배정)로 이미 좁힌 것이다 — 규칙이 보는 것과
> 같은 근거다. 여기서 또 거르면 근거가 두 벌이 되고, 어긋나는 순간 「화면에는
> 있는데 열면 거부당하는 입주자」가 생긴다. 값의 근거도 여전히 숨은 `<select>` 다
> (대시보드 카드가 그것을 직접 넣는다) — 고르면 `change` 를 쏘아 기존 경로를 탄다.

- [x] 계좌/구분/증빙/기간 필터
- [x] 계좌 필터 (입주자 변경 시 자동 갱신)
- [x] 키워드(내용) 검색 — **초성으로도 찾는다**(「ㄱㅂ」→ 김밥천국, `domain/hangul-search.js`)
- [x] 장부 순서 정렬: **날짜 → 그 날 안의 순서(sortOrder) → 시각**
- [x] 날짜/카테고리/내용/계좌/수입/지출/증빙 컬럼 헤더 정렬 (토글)
- [x] 목록 뷰 ↔ 달력 뷰 전환
- [x] 드래그앤드롭 순서 변경 (**그 날 안에서만** — domain/trx-order.js)
- [x] 수정 후 정렬 유지 (로컬 업데이트)
- [x] 페이지네이션 (100건/페이지)
- [x] 일괄 삭제 (체크박스)
- [x] CSV 내보내기 (현재 필터 기준)
- [x] 카테고리 칩 인라인 수정 (드롭다운)
- [x] 빈 공간 클릭 시 카테고리 드롭다운 닫기
- [x] 결제수단·「합계 제외」 뱃지 표시 (구형 자산이동/취소 뱃지도 그대로)

### 수기 입력
- [x] 수기 입력 폼 (날짜/계좌/유형/금액/분류/내용)
- [x] 「합계에서 제외」 체크 (계좌 간 이동·승인취소 등 — 잔액에는 반영)
- [x] 결제수단 선택 (비워 두면 내용에서 읽음)
- [x] 구형 자산이동·취소는 **그 거래를 열었을 때만** 유형이 보인다 (새로 만들 수 없음)

### 엑셀 업로드
- [x] KB국민은행/카드, NH농협은행/카드, 우리은행, 신한은행 지원
- [x] **그 밖의 은행은 화면에서 추가한다** — 설정 → 시스템 → 은행 파서, 또는
      업로드가 실패한 자리의 「이 파일로 은행 추가」. 열 추천은 규칙이 먼저 하고
      「AI 추천」이 그 위에 얹는다(보내는 것은 머리글 글자뿐). §10-1
- [x] SMS XML, HTML-XLS 지원
- [x] 파일 순서 그대로 sortOrder 부여 (날짜마다 그 날의 다음 자리부터)
- [x] 음수 지출 → 지출에서 음수 처리 (잔액 반영)
- [x] 중복 경고 (날짜+금액 비교, 중복의심 뱃지)
- [x] 입주자별 자동 분류 규칙 (우선) + 공통 규칙 매칭
- [x] 미리보기에서 행 삭제 가능
- [x] 수동 입력 템플릿 다운로드 (은행 파일 없을 때)

### 증빙 관리
- [x] 이미지 업로드 (Firebase Storage, 압축: max 1200px, JPEG 0.78)
- [x] 드래그앤드롭 파일 선택
- [x] 미리보기 (Firebase Storage 다운로드 URL 직접 사용, 구형 Drive URL은 썸네일 API로 호환)
- [x] 영수증 A4 일괄 출력 (2열×4행 격자)

### 통장 사진
- [x] 사진에서 거래내역 판독 → 엑셀과 **같은 경로**(중복검사 → 미리보기 → 저장).
      판독용 사진은 보관용보다 크게 보내고, 연도 없는 줄은 같은 사진의 다른 줄에서
      연도를 빌린다 — §10-1-1
- [x] 계좌 관리에서 다중 업로드 (연월 지정)
- [x] 대시보드 퀵 액션에서 통장 사진 업로드 (입주자/계좌 선택)
- [x] 사진 정렬 (연월 내림차순)
- [x] 사진 리스트 연월 필터
- [x] 보고서에서 해당 월 통장사진 조회
- [x] 클릭 시 미리보기

### 카테고리 관리
- [x] 공통 + 입주자별 전용 카테고리
- [x] 드래그앤드롭 순서 변경 (그 날 안에서만)
- [x] 자주 사용하는 순서로 거래내역 드롭다운에 반영
- [x] 공통 + 입주자별 전용 자동분류 규칙

### 잔액 계산
- [x] initialBalance + initialBalanceDate(기준일) 기반
- [x] 기준일 이후 거래만 합산
- [x] **모든 거래가 잔액에 들어간다** — 유형을 보지 않는다 (§6 참고)
- [x] 「합계 제외」 거래도 잔액에는 반영 (그것이 이 표시의 존재 이유)

### 고정항목
- [x] 입주자별 등록 (계좌, 유형, 매월 몇 일, 카테고리, 내용, 금액)
- [x] "고정항목 입력" 버튼 → 이번 달 일괄 입력
- [x] 월별 중복 방지 (fixedItemId 기준)

### 연간 통계 (보고서 → 연간 통계 서브탭)
- [x] 연간 수입/지출/잔액 요약
- [x] 월별 수입/지출 막대 차트
- [x] 카테고리 순위
- [x] 월별 상세 테이블
- [x] 예산 대비 실적 (budgets 컬렉션 기반)
- [x] 「합계 제외」 거래는 집계에서 제외 (domain/trx-totals.js)

### 보고서
- [x] 팀별 결재 흐름 (담당자→팀장→센터장)
- [x] 결재 순서 강제 (팀장 → 센터장)
- [x] 팀장/센터장 결재 대기 목록 (네비 뱃지 포함)
- [x] 반려/수정(초안)/삭제 기능
- [x] 담당자 제출 회수(recall) — 팀장 결재 전
- [x] 의견란 (담당자/팀장/센터장 각각) — **자동 저장**. 칸을 떠날 때 저장하고,
      결재 버튼은 저장되지 않은 초안을 전이에 함께 실어 보낸다(저장을 누르지 않고
      결재해서 글이 사라지던 자리)
- [x] 결재란은 **이름만** 찍는다 — 도장 자리라 날짜까지 넣으면 두 줄이 되어
      빽빽해진다. 값은 결재한 순간 문서에 박힌 것이라 담당·팀장이 바뀌어도 과거
      문서는 그대로다 (`domain/report-stamps.js`). 날짜 변환 자체는
      `domain/timestamps.js` 하나가 한다
- [x] 보고서 표에서 직접 수정 — **날짜·내용·수입·지출은 그 칸이 입력칸**, 분류는
      드롭다운, 전체는 증빙 오른쪽 「수정」. 고쳐도 화면은 제자리. 내가 결재하기
      전까지만(§6-1)
- [x] 계좌 현황: 기초잔액+기준일이후~보고서월말 거래 직접 계산
- [x] 분류별 지출: 비율순 정렬 + 바 시각화 (원차트 제거)
- [x] 월별 추이 차트 (최근 6개월) *삭제해도 될 듯(한눈에 안보임)
- [x] 해당 월 통장사진 표시 섹션
- [x] 규칙 기반 자동 분석
- [x] 엑셀 저장
- [x] 인쇄/PDF (A4). 표 글자 10px · 섹션 여백 최소 — 결재 문서는 **한 장에 들어가는
      것이 목표**다. 거래 50건이 4쪽으로 나오던 원인은 글자 크기가 아니라
      `page-break-inside:avoid` 였다: 모든 섹션에 걸려 있어서 브라우저가 거래
      내역을 통째로 다음 쪽으로 밀고, 거기서도 안 들어가니 결국 쪼갰다 — 밀기
      전 쪽의 남은 절반이 빈 채로 인쇄됐다. 거래 내역만 예외로 두고(쪽을 넘어
      이어진다), 줄 하나는 여전히 쪼개지 않으며, 둘째 쪽부터 표 머리를 다시
      찍는다(`thead{display:table-header-group}`). `test/report-print.test.mjs`
- [x] 드래그앤드롭 순서 변경 (**그 날 안에서만** — domain/trx-order.js)
- [x] 거래내역 자동 정렬: sortOrder 기준 → 날짜/시간 오름차순
- [x] 컬럼 헤더 정렬 (rptSortKey)

### 설정 (관리 통합)
- [x] 직원/입주자/계좌 관리 (설정 탭으로 통합)
- [x] 담당 직원 고르기: 검색(초성 포함) · 팀별 묶음 · 고른 사람 요약 (`modules/staff-picker.js`)

> ⚠️ 피커는 **지정된 퇴직자를 목록에 남긴다.** 예전에는 `active !== false` 로
> 먼저 걸렀는데, 저장은 「체크된 것 전부」를 보내므로 담당자가 퇴직 처리되면
> 입주자 이름만 고치고 저장해도 **그 배정이 조용히 지워졌다.** 같은 이유로
> 검색은 보이고 안 보이고만 정하고 목록에서 빼지 않는다.

- [x] 공통/입주자별 카테고리 관리 (관리 대상/지출/수입/규칙 서브탭)
- [x] 카테고리 드래그 순서 변경
- [x] 공통/입주자별 자동분류 규칙 관리
- [x] 고정항목 관리
- [x] 연간 예산 관리
- [x] 은행 파서 관리 (설정 → 시스템 → 은행 파서, `excel.upload`)
- [x] 데이터 초기화/마감 (센터장·관리자, Firebase 전체 초기화는 관리자)
- [x] 역할별 권한 커스터마이징 (관리자)

### 접근성/플랫폼
- [x] PWA (크롬/엣지 설치형 앱, manifest.json + sw.js)
- [x] 모바일 하단 네비게이션 + 반응형 UI

### 모바일 — 세 자리 네비와 「＋ 기록」

휴대폰에서 이 앱으로 하는 일은 거의 전부 **기록을 남기는 일**이다(영수증 사진,
통장 사진, 수기 입력). 그런데 하단 네비는 데스크톱 사이드바를 그대로 줄인 네
칸이었고 정작 그 행동이 없었다 — 대시보드로 가서 퀵 액션 일곱 개 중 골라야 했다.

```
담당(대시보드)   ＋ 기록   내역(거래내역)        설정은 헤더 · 보고서는 PC 전용
```

- `＋` 가 여는 시트는 `public/modules/mobile-record.js` 의 `RECORD_ACTIONS` 하나다.
  목록은 열 때마다 `can()` 으로 고르고, **고를 것이 없는 역할(팀장·센터장)에게는
  버튼 자체가 뜨지 않는다.**
- 퀵 액션(`#dashboard-actions`)은 휴대폰에서 감춘다. **감추기만 하면 파일
  업로드처럼 다른 길이 없는 것이 사라지므로**, 시트·네비·헤더가 퀵 액션을 전부
  덮는지 `test/mobile-record.test.mjs` 가 대조한다.
- 영수증은 촬영(`capture=environment`)과 불러오기가 **같은 file input** 을 쓴다.
  촬영 뒤 `capture` 를 지우지 않으면 불러오기에서도 카메라가 뜬다.

> 권한·화면폭으로 감추는 것은 인라인 `style.display` 가 아니라 `.perm-hidden`
> 클래스로 한다. 인라인은 미디어 쿼리를 이겨서, 휴대폰 전용 버튼이 데스크톱에도
> 나온다.

### 아이콘 — 이모지를 걷어낸 이유

📊📜📑⚙️ 가 촌스러워 보이는 이유는 취향이 아니라 **OS마다 다른 그림을 그리기
때문**이다. 굵기도 색도 기기마다 달라 한 화면에서 통일감이 생길 수 없다.

`public/utils/icons.js` 한 벌(24×24 · 선만 · 굵기 1.5 · `currentColor`)로 바꿨다.
정적 HTML 은 `<span data-icon="pen">` 에 `hydrateIcons()` 가 채우고, 만들어 내는
HTML 은 `iconSvg('pen')` 을 쓴다. 아이콘 **폰트**는 쓰지 않는다 — 네트워크에서
받아야 해서 PWA 를 오프라인으로 열면 네모가 뜬다.

---

## 8. 프로젝트 현황 (2026-07-01)

### 개발 완료 상태
- **전체 기능**: 기본 90개 + 이후 UX/플랫폼 개선 다수 완료
- **Firebase 최적화**: 4단계 완료 (Phase 1-4, 배치 처리 + 로컬 캐싱 + 부분 갱신)
- **Production Ready**: 모든 핵심 기능 완료, Firebase 무료 할당량 관리 최적화
- **최근 변경사항** (main 기준):
  - 061e38a: 대시보드에 통장 사진 업로드 퀵 액션 추가
  - 2f12bd7: PWA(크롬 설치형 앱) 지원 추가
  - 07c80dd: 보고서/거래내역 UX 개선 및 엑셀 출력 디자인 통일
  - de3bb22: UI/UX 개선 및 모바일 네비게이션
  - d354960: Firebase 읽기 최적화 Phase 4 — 부분 갱신 + 캐시 활용 + 당월 기본
  - c07463d: asktrust.kr 스타일 디자인 리뉴얼 (스카이블루 강조 + 로그인 리뉴얼)
  - 1262c1c: Firebase 무료 할당량 관리 최적화 (Phase 1-3) — 일일 읽기 52% 감소

### 성능 개선 결과
- **읽기 호출**: 32,000/일 → 15,500/일 (52% 감소)
- **할당량 사용률**: 64% → 31% (33% 여유 확보)
- **지원 사용자**: 100명 → 600명 (6배 확장 가능)
- **배포 상태**: ✅ Firebase Hosting 배포 완료

### 다음 단계
- 모니터링: 48시간 Firebase 메트릭 확인
- 추가 최적화: 필요시 Cloud Functions 검토 (1000+ 사용자 대비)

---

## 9. 알려진 미완성/버그 목록

> 모두 완료됨. Feature_list.json의 "done": 90 참조

---

## 10. 핵심 설정값

Firebase 설정은 `public/firebase-env.js`에 있고, **어느 프로젝트에 붙을지는 실행 시점
호스트명이 정한다.** 파일 업로드는 Firebase Storage(`services/storage.js`)를 사용한다.
(Google Drive 업로드는 더 이상 사용하지 않음 — 구형 Drive URL 표시 호환만
`getImageUrl`에 남아 있음.)

| 접속 주소 | 붙는 곳 |
|---|---|
| `smart-care-ledger.web.app` · `.firebaseapp.com` | 프로덕션 (실데이터) |
| 그 외 전부 (Vercel 프리뷰 · localhost · 스테이징 Hosting) | 스테이징 |
| 아무 주소 + `?env=emulator` | 로컬 에뮬레이터 |

```javascript
// public/index.html — 설정을 직접 쓰지 않는다
const env = pickFirebaseEnv(location, window.sessionStorage);
const app = initializeApp(env.config);
```

**기본값이 스테이징인 것이 안전장치다.** 새 미리보기 URL이 생겨도 실데이터에 붙지
않는다. 프로덕션은 `PROD_HOSTNAMES`에 적힌 호스트에서만 열린다.
프로덕션이 아니면 화면 오른쪽 위에 주황색 표시가 뜬다.

테스트 환경 구축·시드·확인 절차는 **`STAGING.md`** 참고.

---

## 10-1. 은행 추가 — 화면에서 한다 (배포가 필요하지 않다)

**기본 경로는 화면이다.** 설정 → 시스템 → **은행 파서**, 또는 엑셀 업로드가
실패했을 때 그 자리에 뜨는 **「이 파일로 은행 추가」**. 그 은행 파일을 하나
고르면 머리글과 값 다섯 줄이 뜨고, 각 열이 날짜·내용·출금·입금 중 무엇인지
고른 뒤 저장한다. 저장은 `config/bankParsers` 문서 하나에 들어간다
(팀 목록과 같은 방식 — 서버 콜러블만 쓴다).

| 어디서 | 무엇이 |
|---|---|
| `public/domain/bank-parser.js` | 저장된 설정의 정리·검증·병합 (순수, 서버 사본 `functions/bank-parser.cjs`) |
| `public/services/bank-parser-guess.js` | **규칙 기반** 열 추천 — 값의 생김새(날짜꼴·금액꼴)와 머리글 낱말 |
| `public/modules/bank-parser-ui.js` | 고르는 화면(떠 있는 창) + 설정 목록 |
| `saveBankParser` · `deleteBankParser` | 저장·삭제 콜러블. 권한은 **`excel.upload`** |
| `suggestBankParser` | 「✨ AI 추천」. 보내는 것은 **머리글 글자와 열의 꼴뿐** |

> **왜 담당자가 은행을 추가하는가.** 파일을 가진 사람만이 어느 열이 출금인지
> 볼 수 있다. 팀장 쪽에 두면 "개발자를 부르는 일"이 "팀장을 부르는 일"이 될
> 뿐이고, 정작 팀장은 엑셀을 올리지 않아 그 파일을 열어 본 적이 없다. 위험도
> 낮다 — 이 설정이 정하는 것은 **파일을 어떻게 읽는가**뿐이고, 읽은 결과는
> 여전히 미리보기에서 사람이 확인한 뒤에야 저장된다.

> ⚠️ **저장분은 언제나 내장 설정 뒤에서 판정된다.** 판정은 위에서부터 먼저
> 맞는 것을 택하므로, 앞에 두면 사용자가 만든 느슨한 설정 하나가 이미 잘 되던
> 은행을 가로챈다. 뒤에 두면 최악의 경우가 "아직 안 되던 파일이 여전히 안 됨"
> 이다. 키에 `USER_` 접두어를 붙여 내장 키와 겹칠 수도 없게 했다.
> `test/bank-parser.test.mjs` 가 이 순서를 지킨다.

> ⚠️ 고른 열은 번호가 아니라 **머리글 글자**로 저장한다. 번호로 담으면 은행이
> 열 하나를 끼워 넣는 순간 전부 어긋나고, 그때 사용자는 "어제까지 되던 것"이
> 왜 안 되는지 알 수 없다.

**AI 추천이 하는 일과 안 하는 일.** 규칙이 먼저 추천하고, AI 는 그 위에 얹는
선택지다. 규칙은 낱말 표(`출금`·`찾으신`…)에 기대는데 은행마다 표기가 갈리고,
표에 없는 낱말이면 규칙은 자리로 추측한다 — 그게 틀리면 출금과 입금이 뒤집힌다.
모델은 처음 보는 표기도 뜻으로 읽는다. 다만 **거래는 한 줄도 보내지 않는다**:
경계는 `functions/ai/bank-header.js` 의 `buildHeaderFacts()` 하나이고,
테스트가 "값이 새어 나가지 않는다"를 직접 확인한다. 실패해도 규칙 추천이
화면에 그대로 남으므로 버튼을 눌러도 화면이 멈추지 않는다.

### 소스에 직접 넣는 길 (내장 은행)

`public/parser-config.js`의 `BANK_CONFIGS`에 항목 하나를 추가한다. 전국 어디서나
쓰는 은행처럼 **모든 시설에 기본으로 들어가야 하는 것**만 여기 둔다.

```javascript
HANA_BANK: {
  DATE:'거래일시', DESC:'내용', WITHDRAW:'출금', DEPOSIT:'입금',
  MATCH: [['거래일시'], ['출금','입금']],   // 생략 가능(DATE+WITHDRAW로 자동 판정)
},
```

- `MATCH`는 바깥 배열이 AND, 안쪽이 OR.
- 순서가 중요하다 — 위에서부터 먼저 맞는 설정이 채택되므로 더 구체적인 것을 위에 둔다.
- 추가한 뒤 `test/excel-parser.test.mjs`의 `HEADERS`에도 헤더 예시를 넣는다
  (넣지 않으면 "헤더 목록과 설정 목록이 일치한다" 테스트가 실패한다).

파싱에서 제외된 행은 미리보기에 행 번호·이유·원문과 함께 표시된다.
"인식된 거래가 없습니다"만 뜨면 그 목록이 원인을 알려준다.

---

## 10-1-1. 통장 사진 판독 — 안 읽히는 이유는 파서가 아니다

**사진 경로는 `BANK_CONFIGS` 를 한 번도 읽지 않는다.** 모델이 사진에서 직접
읽고(`analyzeBankbook`), 그 결과를 `bankbookRowsToParsed` 가 엑셀 파서의 행
모양으로 바꿔 **같은 저장 경로**에 태운다. 그래서 "파서에 없는 은행이라
안 읽힌다"는 성립하지 않는다. 실제 원인은 둘이었다.

| 원인 | 증상 | 고친 것 |
|---|---|---|
| 판독용 사진이 **보관용 압축**(1200px·0.78)을 지났다 | 글씨가 큰 은행은 읽히고 빽빽한 은행만 안 읽힌다 | `compressForReading` — 서버 상한(5MB) 안에 드는 **가장 큰** 것을 보낸다(2400→1200 단계). 통장으로 보관하는 사진은 그대로 1200px |
| 연도 없는 줄(`09-05`)에 **오늘의 연도**를 넣었다 | 작년 통장을 올리면 조용히 올해 거래가 된다 | 같은 사진의 **다른 줄에서 연도를 빌린다**(`explicitYearOf` → 가장 많이 나온 연도). 한 줄도 없으면 예전대로 오늘 기준 |

영수증이 같은 압축으로 잘 읽히던 것이 오해를 키웠다. 영수증은 한 장에 열 줄이고
글자가 크다. 통장은 스무 줄이 넘고 글자가 작으며 괘선이 흐리다 — 4000px 사진을
1200px 로 줄이면 한 줄 글자 높이가 40px 에서 12px 가 되고, 거기에 0.78 JPEG 가
숫자를 뭉갠다.

`test/bankbook-photo.test.mjs` 가 이 둘을 지킨다(판독용이 보관용보다 큰지,
연도를 이웃 줄에서 빌리는지).

> 남은 한계: **한 번에 한 장**이다. 통장 펼침면은 두 장으로 찍히는데 지금은 첫
> 장만 읽는다. 두 번 나눠 올리면 둘 다 들어간다(중복 판정이 겹친 줄을 잡는다).

---

## 10-2. 서버가 하는 일 — 브라우저가 더 이상 쓰지 못하는 것

보안 규칙이 카탈로그를 따르게 되면서, 브라우저가 직접 쓰던 것 중 여럿이
Cloud Functions 콜러블로 옮겨 갔다. 규칙은 문서 하나만 보므로 **순서·짝·
교차 문서 정합성**을 강제할 수 없기 때문이다.

| 하는 일 | 콜러블 | 브라우저에서 왜 안 되나 |
|---|---|---|
| 직원 등록·승인·재직·삭제 | `upsertStaff` · `approveStaff` · `setStaffActive` · `deleteStaff` | `users` 와 `authz` 를 한 트랜잭션에서 써야 한다 |
| 비밀번호 분실 처리 | `requestPasswordReset` · `approvePasswordReset` | 임시 비밀번호는 서버가 만들고 해시로만 저장한다. **결재에 닿는 계정은 2인** |
| 권한 등급표 저장 | `savePermissions` | 등급표와 전 직원 caps 를 함께 고쳐야 한다 |
| 입주자 저장 | `saveClient` | 담당 배정과 투영본(`authz` · `clientAccess`)이 한 트랜잭션이어야 한다 |
| 보고서 결재 | `applyReportTransition` · `saveReportComment` · `deleteReport` | 전이표가 순서를 강제해야 한다 |
| 영수증 최종화 | `startReceiptUpload` · `finalizeReceipts` | 최종 경로 덮어쓰기 금지, generation 기록 |
| 분류 이름·색상 | `saveCategory` | 이름을 바꾸면 거래가 따라와야 하는데, 공통 분류를 관리하는 팀장·센터장은 `trx.edit` 을 갖지 않는다 |
| 자산이동 | `saveTransfer` | 상대편 조회까지 트랜잭션 안이어야 한다 |
| 연도 마감 | `runArchive` | 잠긴 달의 삭제 + generation 사전조건 |
| 팀 목록 저장 | `saveTeams` | `config` 쓰기는 규칙이 아무에게도 열지 않는다(서버 전용) |
| 은행 파서 저장·삭제 | `saveBankParser` · `deleteBankParser` | 같은 이유로 서버 전용. 문서를 통째로 받지 않고 **한 항목만** 더하거나 지운다 — 두 사람이 동시에 추가하면 나중 사람이 앞사람 설정을 지운다 |
| 은행 열 추천 | `suggestBankParser` | Gemini 키는 서버에만 있다. 보내는 것은 **머리글 글자와 열의 꼴뿐** — §10-1 |
| 권한 백필 | `backfillAuthz` | 배포 후 **가장 먼저** 돌려야 한다 |
| 보고서 분석 문장 | `analyzeReport` | Gemini 키는 서버에만 있다. 보내는 것은 **집계뿐** — 아래 |

### 비밀번호 분실 — 관리자가 발급하되 결재자는 2인

계정에 이메일이 없으므로(users: userId·name·role·team) 재설정 링크를 보낼 곳이
없다. 사람이 발급하는 수밖에 없는데, 그러면 **관리자 자격이 결재 권한으로
번진다** — 관리자가 센터장의 비밀번호를 발급하면 잠시 센터장이 되어 결재할 수
있고, 「관리자는 업무 권한과 직교한다」는 전제가 무너진다.

그래서 구멍을 결재에 닿지 않는 자리로 한정한다.

| 대상 | 절차 |
|---|---|
| 입력자 · 담당자 | 관리자가 바로 발급 |
| 팀장 · 센터장 · 관리자 | **다른** 관리자가 한 번 더 승인해야 발급 |

임시 비밀번호는 서버가 만들고(사람이 고르면 "0000" 이 된다) 해시로만 저장하며,
응답에 한 번만 실려 나간다. 받은 사람은 **첫 로그인에 반드시 바꾼다**
(`mustChangePassword`) — 바꾸기 전에는 앱을 쓸 수 없으므로 발급한 사람이 그
계정으로 조용히 일할 수 없다. 유효 시간이 지나면 다시 받아야 한다.

발급은 감사 기록에 남는다(`staff.passwordReset`, 요청자와 승인자 모두).
`passwordResets` 컬렉션은 규칙이 브라우저 접근을 전면 차단한다 — 읽을 수 있으면
요청자를 보고 "내가 아닌 사람"을 골라 2인을 흉내 낼 수 있다.

### 보고서 AI 분석 — 무엇을 보내지 않는가

「✨ 생성」은 먼저 `analyzeReport` 를 부르고, 실패하면 규칙 기반 문장
(`public/domain/report-summary.js`)으로 떨어진다. **키가 없든 한도를 다 썼든
망이 끊겼든 버튼을 누르면 언제나 문장이 나온다** — AI 는 더 나은 문장이지
없으면 안 되는 기능이 아니다.

모델에게 보내는 것은 **집계뿐이다.** 입주자 이름·거래 내용(상호명)·계좌번호는
보내지 않는다. 이 장부의 주인은 어디서 무엇을 샀는지가 그 사람의 하루를
그대로 드러내는 기록을 가진 사람이고, 본인이 동의를 판단하기 어려운 자리에
있다. 경계는 `functions/ai/report-narrative.js` 의 `buildReportFacts()` 하나이고,
`test/report-narrative.test.mjs` 가 "이름이 새어 나가지 않는다"를 직접 확인한다.

> 늦게 온 응답은 버린다. AI 호출은 몇 초가 걸리고, 그 사이 다른 입주자를 열면
> 남의 보고서에 그 문장이 찍힌다 — 규칙 기반일 때는 동기라서 없던 위험이다.
> 보고서를 새로 그릴 때마다 분석 칸을 비우는 것도 같은 이유다(인쇄 영역까지).

### 배포 순서 (어기면 전원이 막힌다)

```
1. functions 배포      — 새 콜러블과 signup 의 authz 생성이 올라간다
2. backfillAuthz 실행  — 전 직원의 authz/{uid} 를 만든다 (관리자 로그인 후)
3. rules 배포          — 규칙이 authz 를 읽기 시작한다
```

2번을 건너뛰고 3번을 하면 **모든 사용자가 차단된다**(authz 문서가 없어 규칙
평가가 실패한다 — fail-closed). 반대 순서로 되돌릴 수는 있지만, 그 사이
운영이 멈춘다.

`backfillAuthz` 는 caps 가 아니라 `users.isAdmin` 으로 판정하므로 백필 전에도
관리자가 실행할 수 있다. 첫 관리자 계정은 `signup` 이 authz 를 함께 만든다.

### 복합 인덱스 — 에뮬레이터가 잡아 주지 않는 유일한 부류

같음(`==`·`in`)과 범위(`>=`·`<=`)를 함께 거는 쿼리는 복합 인덱스를 요구한다.
없으면 쿼리가 **통째로** 실패한다. 그런데 **에뮬레이터는 인덱스를 자동으로
만든다** — 로컬·규칙 테스트·CI 가 전부 초록인 채 배포되고, 실서비스에서 그
쿼리를 타는 **역할에게만** 터진다.

실제로 그렇게 났다: 팀장은 `report.view.all` 이 없어 담당 범위로 좁힌
`clientId in + year >=` 를 타는데 그 인덱스가 없어 보고서 탭이 열리지 않았다.
센터장은 전체 조회라 멀쩡했고, 담당자는 그 달 보고서를 잘 보고 있었다.

`test/firestore-indexes.test.mjs` 가 소스에서 쿼리 모양을 읽어
`firestore.indexes.json` 과 대조한다. 조건에 따라 절이 달라지는 곳
(`...scope`)은 **분기마다 따로** 센다 — 합쳐 보면 좁은 쪽 분기의 누락을 놓친다.

> 화면에는 영문 원문 대신 사람 말이 나간다(`missingIndexMessage`). 콘솔 생성
> 링크는 `console.error` 로 보낸다 — 링크가 필요한 사람은 토스트를 보는 사람이
> 아니다.

### 집행 계약 게이트

`npm run test:contract` — 네 집행 지점(Functions · Firestore Rules ·
Storage Rules · 브라우저)이 정책을 실제로 따르는지 23개 항목으로 확인한다.
`npm run test:contract:ratchet` 은 통과 개수를 `test/contract/ratchet.json`
기준선과 대조한다(CI). 현재 23/23이므로 이제부터는 **회귀만** 잡는다.

---

## 11. 코드 작성 규칙

1. **함수 중복 절대 금지** — ESLint `no-redeclare`/`no-func-assign`이 잡아준다
2. **괄호 균형 항상 검증** — `{ = }` `( = )` `[ = ]`
3. **문자열 내 실제 줄바꿈 금지** — `\n` 이스케이프 사용
4. **수정 후 `npm run check` 실행** — ESLint + 단위 테스트 (규칙은 `npm run test:rules`)
   - `onclick="fn(...)"`로 부르는 함수는 `app.js`의 전역 등록 목록에도 넣어야 한다
     (빠뜨리면 `test/globals.test.mjs`가 실패한다)
5. **인덱스 기반 교체 시 주의** — 파일 크기 확인 후 진행
6. **패치 방식 권장** — 전체 파일 재작성보다 정밀 패치

---

## 12. 배포

### 배포 명령어

**배포 대상은 항상 명시한다.** `.firebaserc`의 기본 별칭은 **스테이징**이라,
`--project`를 빠뜨리면 실데이터가 아니라 스테이징으로 간다(안전한 쪽으로 틀림).

```bash
npm run deploy:prod        # 프로덕션 (firebase deploy --project prod)
npm run deploy:staging     # 스테이징
```

### 배포 파일
`public/` 폴더의 다음 파일들이 배포됩니다:
- `index.html` — 메인 HTML + CSS
- `app.js` — 전역 초기화 및 이벤트 바인딩
- `modules/*.js` — 기능별 모듈 (auth, core, dashboard, transactions, report, settings, modals, permissions)
- `services/*.js` — firestore, image(이미지 압축), storage, balance, excel-parser
- `utils/ui.js` — UI 유틸리티 함수
- `constants.js` — 상수 정의
- `state.js` — 전역 상태
- `parser-config.js` — 엑셀 파서 설정 (ES 모듈)
- `manifest.json`, `sw.js`, `icons/` — PWA 매니페스트/서비스 워커/아이콘
- `firestore.rules` — Firestore 보안 규칙 (루트)

### 배포 URL
https://smart-care-ledger.web.app

### 배포 체크리스트
- [ ] 로컬 테스트 완료 (`firebase serve`)
- [ ] `npm run check` 통과 (ESLint + 단위 테스트)
- [ ] git 커밋 완료
- [ ] `firebase deploy` 실행
- [ ] 배포된 앱 확인

---

## 12-1. 읽기 비용 — 월초가 한도를 정한다

이 장부의 일은 **1~10일에 몰린다.** 지난달을 정리해서 보고서를 올린다.
그래서 평상시 세션이 아니라 그 열흘이 무료 한도(하루 읽기 5만)를 정한다.

`node tools/read-budget.mjs` 가 모델을 출력하고, 코드가 아래 넷 중 하나라도
어기면 **모델과 코드가 어긋난다고 알리며 실패한다**(CI에 걸 수 있다).

| 지키는 것 | 어기면 |
|---|---|
| 기본 조회 범위를 달력이 정한다 (`defaultTrxRange`) | 월초에 지난달을 다시 조회 — 마감 비용 두 배 |
| 거래 생성 뒤 로컬에 끼워 넣는다 | 수기 입력 한 건마다 월 전체 재조회 |
| 보고서 캐시는 **쓰기가** 버린다 | 보고서를 열 때마다 다시 읽는다 |
| 보고서는 두 달만 읽는다 (월말 색인) | 전체 이력 — 해가 갈수록 비싸진다 |

### 영속 캐시는 읽기를 줄이지 않는다 — 재 봤다

`public/index.html` 은 영속 캐시를 켜면서 "바뀌지 않은 문서는 과금되지 않는다"고
적어 두었다. **이 앱에서는 사실이 아니다.**

앱의 읽기는 전부 `getDocs` 인데, `getDocs` 는 온라인이면 언제나 서버 동기화를
기다린다(SDK 의 `waitForSyncWhenOnline`). 캐시에 같은 문서가 그대로 있어도 서버에
다시 묻고, 그 응답이 과금된다.

`node tools/measure-cache.mjs` 가 브라우저를 띄워 **서버에서 받은 바이트**를 센다
(에뮬레이터 · 거래 90건):

| | 받은 바이트 |
|---|---|
| getDocs 첫 조회 | 34,926B |
| getDocs 같은 세션에서 다시 | 35,073B |
| getDocs 새로고침 뒤 | 35,031B |

세 번 다 같다 — **절감 0%.** 캐시가 실제로 해 주는 일은 망이 끊겼을 때 버티는
것이다(그때 `getDocs` 가 캐시로 떨어져 화면이 비지 않는다).

> ⚠️ 같은 도구로 `onSnapshot` 재구독도 재 봤고 역시 전량을 다시 받았다. 다만
> **이것은 결론이 아니다** — 에뮬레이터는 재개 토큰으로 델타만 보내는 백엔드
> 최적화를 구현하지 않는다(클라이언트는 토큰을 보냈다). 실제로 줄어드는지는
> 스테이징(진짜 백엔드)에서 Firebase 콘솔의 읽기 카운터로 재야 답이 나온다.
> 그 전에는 "listener 로 바꾸면 읽기가 준다"고 말하지 말 것.

### 월말 잔액 색인 (`accounts.monthEndBalances`)

보고서 「계좌 현황」의 전월 말·당월 말 잔액은 기준일부터의 누적이라, 예전에는
그 두 숫자를 구하려고 **그 입주자의 전체 이력**을 읽었다. 보고서를 열 때마다,
그리고 해가 갈수록 더 — 쓰지도 않는데 비용만 자란다.

이제 계좌 문서가 `{ 'YYYY-MM': 말잔 }` 을 들고 있다. `syncAccountBalance`
트리거가 `currentBalance` 를 다시 만들 때 **같은 거래 목록에서** 함께 적으므로
추가 읽기가 없고, 색인은 로그인할 때 계좌와 함께 이미 온다.

- 만드는 곳은 `buildMonthEndBalances()` 하나다 (`services/balance.js` +
  서버 사본 `functions/balance.cjs` — 값이 어긋나면 테스트가 잡는다).
- 기준일의 달부터 마지막 거래의 달까지 **빠짐없이** 적는다. 거래 없는 달도
  앞 달 값으로 채운다 — 빈칸이 "거래가 없었다"인지 "계산하지 않았다"인지
  구분되지 않으면 폴백 판정을 할 수 없다.
- `monthEndBalanceOf()` 는 **모르면 `null`** 을 준다. 0으로 답하면 백필 전
  계좌의 결재 문서에 「잔액 0원」이 그대로 인쇄된다. 보고서는 계좌 **전부**가
  두 달을 다 알 때만 창을 좁히고, 하나라도 모르면 예전처럼 전체를 읽는다.
- 규칙이 브라우저 쓰기를 막는다(생성 시 금지, 수정 시 불변). 트리거는 Admin
  SDK 라 규칙을 지나지 않으므로 갱신은 계속 된다.

> ⚠️ **배포 뒤 백필**: 색인은 그 계좌에 거래가 쓰일 때 채워진다. 배포 직후
> 조용한 계좌는 비어 있고, 보고서는 그 계좌 때문에 전체 이력으로 떨어진다
> (값은 맞지만 비용이 예전과 같다 — 화면으로는 티가 나지 않는다).
>
> 채우는 길은 둘이다. **설정 → 데이터 → 「💰 잔액 색인 다시 만들기」**
> (`rebuildBalances` 콜러블, 센터장·관리자)와 `node tools/recalc-balances.mjs`.
> 이 시스템을 운영하는 사람은 사회복지사라, 터미널만 두면 배포마다 개발자를
> 불러야 하고 결국 아무도 안 누른다 — 버튼이 기본 경로다. 스크립트는 드라이런과
> 백업이 있어 **첫 배포의 잔액 정정**처럼 금액이 달라지는 작업에 쓴다.
>
> 버튼은 색인이 **없는** 계좌만 골라 20개씩 돈다. 멱등하고 이어서 누를 수 있다 —
> 계좌당 그 계좌의 거래를 전부 읽으므로 이미 끝난 것을 또 읽으면 안 된다.

---

## 13. Storage 용량 관리 정책 (Firebase 무료 한도 대응)

> 무료(Spark) 한도: Storage 저장 5GB · 다운로드 1GB/일 · 업로드 2만/일 · 다운로드 5만/일

핵심 로직은 `public/services/storage.js`에 있음.

| 정책 | 구현 위치 | 설명 |
|---|---|---|
| 업로드 전 이미지 압축 | `image.js` `compressImage` | 1200px / JPEG 0.78 |
| 업로드 크기 상한 | `storage.js` `validateUploadSize` | 이미지·HEIC 15MB / 기타(PDF) 8MB, 초과 시 예외 |
| HEIC→JPEG 변환 | `image.js` `heicToJpeg` | iPhone HEIC 업로드 시 heic2any(CDN 지연 로드)로 JPEG 변환 후 압축, 실패 시 원본 유지 |
| 삭제 시 파일 정리 | `deleteFromStorage` / `deleteManyFromStorage` | 거래·영수증·통장사진 삭제, 전체 초기화 시 Storage 객체까지 삭제 (고아 파일 방지) |
| 연도 마감 시 재압축 보관 | `functions/archive-fns.js runArchive` | 해당 연도 영수증·통장사진을 900px/60 으로 재압축(덮어쓰기), **삭제하지 않음**. 서버가 `ifGenerationMatch` 로 **읽은 그 객체일 때만** 덮어쓴다 — 브라우저 판은 동시 교체를 조용히 뭉갰다. sharp 가 없으면 건너뛴다(best-effort) |
| 목록용 썸네일 | `uploadImageWithThumb` | 통장사진 업로드 시 320px 썸네일 동시 생성 → 갤러리/보고서 목록은 `thumbUrl` 사용 (다운로드 대역폭 절감) |
| 엑셀 원본 gzip 저장 | `storage.js` `uploadExcelOriginal` | 원본은 유지하되 gzip 압축 저장(다운로드 시 원본 복원), 중복 rawRows는 미저장 |

### CORS 설정 (연도 마감 재압축에 필요)

재압축은 브라우저에서 저장된 이미지를 다시 읽어야 하므로 버킷 CORS 허용이 필요하다.
설정하지 않으면 마감은 정상 진행되지만 이미지 재압축만 건너뛴다(best-effort).

```bash
gsutil cors set cors.json gs://smart-care-ledger.firebasestorage.app
```

> `cors.json`은 프로젝트 루트에 있으며 배포 대상은 아님(운영 1회 적용).