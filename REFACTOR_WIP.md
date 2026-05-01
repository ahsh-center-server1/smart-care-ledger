# Smart Care Ledger 모듈화 리팩토링 — 작업 진행 지시서

> 이 문서는 작업이 중단되었을 때 **다음 세션에서 이어받기 위한** 실행 지시서다.
> 매 단계 완료마다 상단 체크박스와 "현재 상태"를 업데이트한다.

브랜치: `refactor/modularize`
경로: `C:\smart-care-ledger`

---

## 현재 상태 (LAST UPDATED)

**진행 단계: ✅ 전 단계 완료 — 아카이브됨 (2026-04-30)**
- 모듈화 리팩토링 main 브랜치 반영 완료
- app.js: ~4700줄 → 959줄 모듈 오케스트레이터로 축소
- 8개 모듈(auth/core/dashboard/transactions/report/settings/modals/permissions) + services/utils 분리
- `node --check` 전체 모듈 통과
- index.html `<script type="module" src="app.js">` 적용됨
- D001~D011 추가 기능이 모듈 구조 위에 구현 완료됨 (2026-04-13)

---

## 전체 단계 체크리스트

- [x] STEP 0 — refactor/modularize 브랜치 생성
- [x] STEP 1 — 11개 모듈 파일 생성
  - [x] constants.js
  - [x] state.js
  - [x] utils/ui.js
  - [x] services/drive.js
  - [x] services/firestore.js
  - [x] modules/auth.js
  - [x] modules/dashboard.js
  - [x] modules/transactions.js
  - [x] modules/report.js
  - [x] modules/settings.js (활성 코드로 재작성 완료)
  - [x] modules/modals.js
- [x] STEP 2 — 기존 app.js 유지 구간(ExcelParser, 코어 로직, 모바일) 읽기
- [x] STEP 3 — 새 app.js 작성 (import + 유지 구간 + window 전역 노출 + 이벤트 바인딩)
- [x] STEP 4 — 새 app.js 문법 검증 (`node --check public/app.js`)
- [x] STEP 5 — 모듈간 window 전역 참조 검증 (fetchBaseData, loadTransactions, openModal 등)
- [x] STEP 6 — index.html에 `<script type="module" src="app.js">` 로 교체
- [x] STEP 7 — 커밋
- [x] STEP 8 — 브라우저 검증 (10개 항목 체크리스트)

---

## 중요 발견사항 (원본 app.js의 숨겨진 이슈)

원본 `app.js`에는 **27개 함수가 중복 선언**되어 있었다. 이는 개발 과정에서 예전 버전이 삭제되지 않고 남은 잔재로, JS는 나중 선언을 사용하므로 실제 동작에는 문제가 없었으나 리팩토링 시 혼란의 원인이었다.

**중복 블록 위치:**
- 블록 1 (비활성): 2238-3049 (설정/모달 구 버전) + 3083-3229 (helpers 구 버전)
- 블록 2 (활성): 3249-4260 (설정/모달 신 버전 — toggleClientActive, 예산, Firebase reset 등 포함)
- 블록 3 (utils): 4736-4752 (showConfirm/toast 신 버전, 4130 줄대 구 버전과 중복)

**블록 1에만 있는 함수 (신 블록에 없음, 유지됨):**
- `confirmDelete` (2267) — settings.js에 포함됨

**블록 2에만 있는 신규 함수 (반드시 신 버전 사용):**
- `toggleClientActive`, `toggleAccountActive` — settings.js에 포함됨
- `downloadManualTemplate` (3465) — modals.js에 포함됨
- `openReceiptModal`, `closeReceiptModal` — modals.js에 포함됨
- `initBudgetSection`, `loadBudgetForm`, `saveBudget`, `executeFirebaseReset` — settings.js에 포함됨

---

## STEP 3: 새 app.js 구조 (설계)

```javascript
'use strict';

// ─── 모듈 import ─────────────────────────────────
import { S } from './state.js';
import { COLS, CAT_COLORS, cs, STATUS_LABELS, STATUS_CLASSES,
         GOOGLE_OAUTH_CLIENT_ID, DRIVE_FOLDER_ID } from './constants.js';
import { toast, showConfirm, closeConfirm, setText, showLoading } from './utils/ui.js';
import { fb, fdb } from './services/firestore.js';
import { compressImage, getDriveToken, uploadToDrive } from './services/drive.js';
import * as Auth     from './modules/auth.js';
import * as Dash     from './modules/dashboard.js';
import * as Trx      from './modules/transactions.js';
import * as Rpt      from './modules/report.js';
import * as Settings from './modules/settings.js';
import * as Modals   from './modules/modals.js';

// ─── ExcelParser (유지) ─────────────────────────
// 원본 95-411 줄 복붙

// ─── Firebase ready handler (유지) ──────────────
window.onFirebaseReady = function(fbObj) { ... };

// ─── 코어 로직 (유지) ───────────────────────────
async function fetchBaseData() { ... }      // 708-733
function isConfirmedLocked() { ... }        // 735-738
async function loadTransactions() { ... }   // 740-766
function rebuildSelectors() { ... }         // 767-776
function changeView(view) { ... }           // 791-823
function switchRptSubtab(tab) { ... }       // 824-854

// ─── 모바일 뷰 (유지) ───────────────────────────
// 4365-4706 줄 복붙

// ─── window 전역 노출 (HTML onclick / 모듈간 호출용) ──
window.S = S;
window.fetchBaseData = fetchBaseData;
window.loadTransactions = loadTransactions;
window.rebuildSelectors = rebuildSelectors;
window.changeView = changeView;
// 각 모듈 함수들을 window.XXX = XXX 로 노출
window.handleLogin = Auth.handleLogin;
window.handleLogout = Auth.handleLogout;
// ... (HTML onclick에서 쓰이는 모든 함수)

// ─── 이벤트 바인딩 + DOMContentLoaded ──────────
document.addEventListener('DOMContentLoaded', () => { ... });
```

---

## STEP 3 작업 절차 (자세히)

1. 원본 app.js에서 다음 구간을 파일로 백업 (cat으로 읽어 별도 .txt에 저장하지 말고, 직접 Read로 확인):
   - ExcelParser: 95-411
   - onFirebaseReady: ~14-33
   - fetchBaseData: 708-733
   - isConfirmedLocked: 735-738
   - loadTransactions: 740-766
   - rebuildSelectors: 767-776
   - changeView: 791-823
   - switchRptSubtab: 824-854
   - 모바일: 4365-4706
   - 이벤트 바인딩들: 3125-3146, 4711-4731
2. 새 app.js 조립 (Write)
3. `node --check` 실행
4. 모듈이 참조하는 `window.XXX` 함수명 목록을 전체 grep으로 추출 → 노출 체크
5. HTML의 `onclick="..."` 함수명 모두 추출 → 노출 체크

---

## STEP 5 — window 전역 노출 체크리스트

HTML/모듈에서 참조되는 전역 함수 목록 (작업 중 업데이트):

**확인 완료:**
- (TBD)

**미확인:**
- openModal, closeModal
- handleLogin, handleLogout
- changeView, switchRptSubtab
- saveTrx, delTrx, editTrx
- confirmDelete, confirmBulkDelete
- applyFilters, applyPeriod, renderCalendarView, moveCalendar
- openCatDropdown, saveCatChange
- exportFilteredCSV
- renderDashboard, renderClientCards (별칭)
- renderReportView, loadReport, doApproval, doReject, doDeleteReport
- renderManagement, loadSettings
- addCategory, deleteCategory, addRule, deleteRule, resetCategories
- toggleClientActive, toggleAccountActive
- confirmArchive, executeArchive
- initBudgetSection, loadBudgetForm, saveBudget, executeFirebaseReset
- applyFixedItems, renderFixedItemsList
- openBankStatementModal, uploadBankStatements
- openReceiptModal, closeReceiptModal, openReceiptUpload
- downloadManualTemplate, onXlFileSelect, analyzeXlFile, saveExcelData, removeXlItem
- renderRptTrxTable, applyRptSort, reorderRptTrx
- handleGenSummary, saveComment
- loadReportList, exportReportExcel
- fetchBaseData, loadTransactions, rebuildSelectors
- S (S.* 참조용)
- fb, fdb (firestore 직접 접근용)
- uploadToDrive
- COLS

---

## STEP 8 — 브라우저 검증 체크리스트

- [x] 로그인 / 로그아웃
- [x] 대시보드 입주자 카드
- [x] 거래내역 필터/정렬/페이지
- [x] 거래 수기 입력 + 저장 + 수정 + 삭제
- [x] 엑셀 업로드 미리보기 + 저장
- [x] 보고서 생성 + 결재 흐름
- [x] 설정: 카테고리/규칙 추가/삭제
- [x] 영수증 업로드/미리보기
- [x] 고정항목 입력
- [x] 연간 통계 차트

---

## 롤백 방법

```bash
git checkout main
git branch -D refactor/modularize  # 포기 시
```

작업 중 커밋된 상태로 돌리려면:
```bash
git reset --hard HEAD  # 마지막 커밋으로
```
