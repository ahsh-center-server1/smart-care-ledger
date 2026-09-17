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
| 기능 모듈 | `public/modules/*.js` | auth, core, dashboard, transactions, report, settings, modals, permissions, fixed-items, report-actor, settings-permissions |
| 서비스 | `public/services/*.js` | firestore, image(이미지 압축), storage, balance(잔액 계산), excel-parser, receipt-upload, scoped-fetch, in-query |
| 유틸 | `public/utils/ui.js` | UI 유틸리티 |
| `firestore.rules` | `firestore.rules` (루트) | Firestore 보안 규칙 |

---

## 3. Firestore 컬렉션 구조

```
users:        { userId, password, name, role, team }
clients:      { clientId, name, userIds, teamLeader, contact, memo }
accounts:     { accountId, clientId, label, accountNumber,
                initialBalance, initialBalanceDate, currentBalance,
                bankStatements: [{url, thumbUrl, month}] }
transactions: { trxId, clientId, accountId, date, type, category,
                subcategory, description, amountIn, amountOut,
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
| 팀장 | 보고서 1차 결재·반려, 담당 배정, 시설 개설(입주자·계좌·공통분류) | **거래 입력·수정, 보고서 작성·제출**, 변경 이력 |
| 센터장 | 팀장이 하는 일 + 최종 결재·결재 취소, 전 입주자 조회, 연도 마감 | **거래 입력·수정, 보고서 작성·제출**, 1차 결재 |
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

`config/lockedMonths` 문서가 색인을 **두 개** 담는다. 질문이 다르다.

| 색인 | 질문 | 막는 것 | 채우는 상태 |
|---|---|---|---|
| `months` | 최종 결재가 끝났는가 | 수정 · 삭제 **둘 다** | `confirmed` |
| `submittedMonths` | 결재 절차에 올라갔는가 | **삭제만** | `submitted` · `team_approved` · `confirmed` |

한 문서에 둔 이유: 거래 쓰기 한 번당 규칙 조회가 늘지 않게 하기 위해서다.
판정은 `functions/locked-months.cjs` 한 곳이고, 화면은 같은 색인을 읽어
`core.js` 의 `trxDeleteBlockReason()` 으로 답한다 — 근거가 갈라지면 버튼은
보이는데 서버가 거부한다.

> ⚠️ **배포 시**: `submittedMonths` 는 처음에 없다. 그 상태에서는 결재 중인
> 달의 거래도 지워진다(색인이 비면 "제출된 달 없음"으로 읽힌다). 배포 뒤
> **설정 → 파생 문서 다시 만들기**(`rebuildLockedMonths`)를 눌러 백필한다.
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
  ▲                   │                          │                               │
  └─recall/revert─────┘                          │                               │
  ▲                   └───reject──▶ rejected ◀───┘                               │
  └─submit────────────────────────────┘          ◀────────────revert─────────────┘
```

| 액션 | 필요 권한 | 비고 |
|---|---|---|
| `save` | `report.draft` | 임시저장 |
| `submit` | `report.submit` | |
| `approveTeam` | `report.approve.team` + 배정 팀장 | |
| `approveCenter` | `report.approve.center` | |
| `reject` | `report.reject` + 지금 결재할 차례인 사람 | 사유 필수 |
| `recall` | 작성자(`createdBy`)+`report.recall`, 또는 팀장 이상 | |
| `revert` | 직전 단계의 결재 권한 (confirmed는 `report.revert`) | 한 단계씩 |

**전이표에 없는 동작** — 이름만 남기지 않는다. 표에 없으면 권한 검사에 닿기
전에 거부된다.

| 없는 동작 | 왜 없나 |
|---|---|
| `submitAsLeader` | 팀장은 `report.submit`을 갖지 않는다(역할 분리). 어떤 주체로도 성립하지 않아 제거했다 |
| `approveTeamProxy` | 자리가 비었다는 이유만으로 팀장 단계를 건너뛰면 2단 결재가 1단이 된다. 공석은 **정식 대행 지정**으로 푼다(절차 미구현) |
| `release` | 반려건은 작성·제출 절차로만 다시 올라간다. 담당자 부재는 담당 배정 변경으로 푼다 |

- **도장 정리**: 전이할 때마다 도착 상태보다 뒤 단계의 결재 기록을
  `deleteField()`로 지운다. 취소된 서명이 인쇄물에 남지 않는다.
- **`createdBy`**: 보고서를 만드는 모든 경로가 기록한다. 회수 권한 판정의 근거.
- **`rejected`에서 나가는 길**: 담당자 재제출(`submit`) 하나다. 담당자가
  부재면 담당 배정을 바꿔 다른 담당자가 제출한다 — 결재 단계를 건너뛰는
  탈출구는 두지 않는다.

## 6. 거래 유형(type)

| 유형 | 수입/지출 집계 | 잔액 반영 | 비고 |
|---|---|---|---|
| 수입 | ✅ | ✅ | |
| 지출 | ✅ | ✅ | 음수 amountOut = 환불 |
| 자산이동 | ❌ 제외 | ✅ | 출금계좌 → 지출, 입금계좌 → 수입 (별도 2개 거래) |
| 취소 | ❌ 제외 | ❌ | 카드 승인취소 |

---

## 7. 구현 완료 기능 목록

### 인증/세션
- [x] ID/PW 로그인 (Firestore 직접 비교)
- [x] sessionStorage 세션 유지
- [x] 로그아웃

### 대시보드
- [x] 입주자 카드 그리드 표시
- [x] 카드 클릭 → 거래내역으로 이동

### 거래내역
- [x] 입주자/계좌/구분/증빙/기간 필터
- [x] 계좌 필터 (입주자 변경 시 자동 갱신)
- [x] 키워드(내용) 검색
- [x] 날짜 오름차순 기본 정렬
- [x] 날짜/카테고리/내용/계좌/수입/지출/증빙 컬럼 헤더 정렬 (토글)
- [x] 목록 뷰 ↔ 달력 뷰 전환
- [x] sortOrder 기반 드래그앤드롭 순서 변경 (현재 페이지 내)
- [x] 수정 후 정렬 유지 (로컬 업데이트)
- [x] 페이지네이션 (100건/페이지)
- [x] 일괄 삭제 (체크박스)
- [x] CSV 내보내기 (현재 필터 기준)
- [x] 카테고리 칩 인라인 수정 (드롭다운)
- [x] 빈 공간 클릭 시 카테고리 드롭다운 닫기
- [x] 자산이동/취소 유형 뱃지 표시

### 수기 입력
- [x] 수기 입력 폼 (날짜/계좌/유형/금액/분류/내용)
- [x] 자산이동: 출금계좌 + 입금계좌 선택 → 2개 거래 자동 생성
- [x] 취소: 카드승인취소

### 엑셀 업로드
- [x] KB국민은행/카드, NH농협은행/카드, 우리은행, 신한은행 지원
- [x] SMS XML, HTML-XLS 지원
- [x] 파일 순서 그대로 sortOrder 부여
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
- [x] 계좌 관리에서 다중 업로드 (연월 지정)
- [x] 대시보드 퀵 액션에서 통장 사진 업로드 (입주자/계좌 선택)
- [x] 사진 정렬 (연월 내림차순)
- [x] 사진 리스트 연월 필터
- [x] 보고서에서 해당 월 통장사진 조회
- [x] 클릭 시 미리보기

### 카테고리 관리
- [x] 공통 + 입주자별 전용 카테고리
- [x] sortOrder 기반 드래그앤드롭 순서 변경
- [x] 자주 사용하는 순서로 거래내역 드롭다운에 반영
- [x] 공통 + 입주자별 전용 자동분류 규칙

### 잔액 계산
- [x] initialBalance + initialBalanceDate(기준일) 기반
- [x] 기준일 이후 거래만 합산
- [x] 취소 거래 잔액 제외
- [x] 자산이동 잔액 반영

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
- [x] 자산이동/취소 집계 제외

### 보고서
- [x] 팀별 결재 흐름 (담당자→팀장→센터장)
- [x] 결재 순서 강제 (팀장 → 센터장)
- [x] 팀장/센터장 결재 대기 목록 (네비 뱃지 포함)
- [x] 반려/수정(초안)/삭제 기능
- [x] 담당자 제출 회수(recall) — 팀장 결재 전
- [x] 의견란 (담당자/팀장/센터장 각각)
- [x] 계좌 현황: 기초잔액+기준일이후~보고서월말 거래 직접 계산
- [x] 분류별 지출: 비율순 정렬 + 바 시각화 (원차트 제거)
- [x] 월별 추이 차트 (최근 6개월) *삭제해도 될 듯(한눈에 안보임)
- [x] 해당 월 통장사진 표시 섹션
- [x] 규칙 기반 자동 분석
- [x] 엑셀 저장
- [x] 인쇄/PDF (A4, 글씨 15px)
- [x] sortOrder 기반 드래그앤드롭 순서 변경 (현재 페이지 내)
- [x] 거래내역 자동 정렬: sortOrder 기준 → 날짜/시간 오름차순
- [x] 컬럼 헤더 정렬 (rptSortKey)

### 설정 (관리 통합)
- [x] 직원/입주자/계좌 관리 (설정 탭으로 통합)
- [x] 공통/입주자별 카테고리 관리 (관리 대상/지출/수입/규칙 서브탭)
- [x] 카테고리 드래그 순서 변경
- [x] 공통/입주자별 자동분류 규칙 관리
- [x] 고정항목 관리
- [x] 연간 예산 관리
- [x] 데이터 초기화/마감 (센터장·관리자, Firebase 전체 초기화는 관리자)
- [x] 역할별 권한 커스터마이징 (관리자)

### 접근성/플랫폼
- [x] PWA (크롬/엣지 설치형 앱, manifest.json + sw.js)
- [x] 모바일 하단 네비게이션 + 반응형 UI

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

## 10-1. 엑셀 파서에 은행 추가하기

`public/parser-config.js`의 `BANK_CONFIGS`에 항목 하나를 추가하면 끝이다.
다른 파일은 건드리지 않는다.

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

## 10-2. 서버가 하는 일 — 브라우저가 더 이상 쓰지 못하는 것

보안 규칙이 카탈로그를 따르게 되면서, 브라우저가 직접 쓰던 것 중 여럿이
Cloud Functions 콜러블로 옮겨 갔다. 규칙은 문서 하나만 보므로 **순서·짝·
교차 문서 정합성**을 강제할 수 없기 때문이다.

| 하는 일 | 콜러블 | 브라우저에서 왜 안 되나 |
|---|---|---|
| 직원 등록·승인·재직·삭제 | `upsertStaff` · `approveStaff` · `setStaffActive` · `deleteStaff` | `users` 와 `authz` 를 한 트랜잭션에서 써야 한다 |
| 권한 등급표 저장 | `savePermissions` | 등급표와 전 직원 caps 를 함께 고쳐야 한다 |
| 입주자 저장 | `saveClient` | 담당 배정과 투영본(`authz` · `clientAccess`)이 한 트랜잭션이어야 한다 |
| 보고서 결재 | `applyReportTransition` · `saveReportComment` · `deleteReport` | 전이표가 순서를 강제해야 한다 |
| 영수증 최종화 | `startReceiptUpload` · `finalizeReceipts` | 최종 경로 덮어쓰기 금지, generation 기록 |
| 분류 이름·색상 | `saveCategory` | 이름을 바꾸면 거래가 따라와야 하는데, 공통 분류를 관리하는 팀장·센터장은 `trx.edit` 을 갖지 않는다 |
| 자산이동 | `saveTransfer` | 상대편 조회까지 트랜잭션 안이어야 한다 |
| 연도 마감 | `runArchive` | 잠긴 달의 삭제 + generation 사전조건 |
| 권한 백필 | `backfillAuthz` | 배포 후 **가장 먼저** 돌려야 한다 |

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