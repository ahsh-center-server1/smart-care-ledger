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
| `parser-config.js` | `public/parser-config.js` | 은행별 엑셀 파서 설정 |
| `manifest.json` / `sw.js` | `public/` | PWA 매니페스트 / 서비스 워커 |
| 기능 모듈 | `public/modules/*.js` | auth, core, dashboard, transactions, report, settings, modals, permissions |
| 서비스 | `public/services/*.js` | firestore, image(이미지 압축), storage |
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

| 역할 | 권한 |
|---|---|
| 입력자 | 거래 입력/수정 전용 (엑셀·증빙·보고서·설정 불가) |
| 담당자 | 거래 입력/수정 + 엑셀/증빙, 보고서 작성·제출·회수 |
| 팀장 | 담당자 권한 + 보고서 결재(1차)/반려/수정/삭제 + 설정(직원/입주자/계좌) |
| 센터장 | 팀장 권한 + 최종 결재(2차)/반려/수정/삭제 + 데이터 마감 |
| 관리자 | 모든 권한 + 역할별 권한 관리 + 전체 초기화 |

> 권한은 `public/modules/permissions.js`의 `DEFAULT_PERMISSIONS`가 기본값이며,
> `config/permissions` 문서로 역할별 오버라이드 가능(관리자, 설정→권한 탭).
> 권한 판정은 `can('key')` 헬퍼로 수행.

---

## 5. 결재 흐름

```
draft → submitted(담당자 제출) → team_approved(팀장 결재) → confirmed(센터장 최종)
                                    ↑                           ↓                           ↓
                                 rejected(반려) ←←←←←←←←←←←←←←←←
```

- **순서 강제**: 팀장 결재 완료 후에만 센터장 결재 가능
- **팀장 직접 담당**: 담당자 없음 + `userIds`에 포함 + `teamLeader`가 본인 → 제출+팀장결재 동시 처리
- **반려 후**: 담당자가 의견 수정 후 재제출 가능
- **회수(recall)**: 팀장 결재 전(submitted) 상태면 담당자 본인이 draft로 회수 가능 (`report.recall`)

---

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

Firebase 설정(`firebaseConfig`)은 `public/index.html`에 정의되어 있으며, 파일
업로드는 Firebase Storage(`services/storage.js`)를 사용한다. (Google Drive 업로드는
더 이상 사용하지 않음 — 구형 Drive URL 표시 호환만 `getImageUrl`에 남아 있음.)

```javascript
// public/index.html
const firebaseConfig = { apiKey, authDomain, projectId,
  storageBucket: 'smart-care-ledger.firebasestorage.app', ... };
```

---

## 11. 코드 작성 규칙

1. **함수 중복 절대 금지** — 수정 전 `grep -n "function 함수명"` 확인
2. **괄호 균형 항상 검증** — `{ = }` `( = )` `[ = ]`
3. **문자열 내 실제 줄바꿈 금지** — `\n` 이스케이프 사용
4. **수정 후 `node --check` 실행** — 문법 오류 확인
5. **인덱스 기반 교체 시 주의** — 파일 크기 확인 후 진행
6. **패치 방식 권장** — 전체 파일 재작성보다 정밀 패치

---

## 12. 배포

### 배포 명령어
```bash
firebase deploy
```

### 배포 파일
`public/` 폴더의 다음 파일들이 배포됩니다:
- `index.html` — 메인 HTML + CSS
- `app.js` — 전역 초기화 및 이벤트 바인딩
- `modules/*.js` — 기능별 모듈 (auth, core, dashboard, transactions, report, settings, modals, permissions)
- `services/*.js` — firestore, image(이미지 압축), storage
- `utils/ui.js` — UI 유틸리티 함수
- `constants.js` — 상수 정의
- `state.js` — 전역 상태
- `parser-config.js` — 엑셀 파서 설정
- `manifest.json`, `sw.js`, `icons/` — PWA 매니페스트/서비스 워커/아이콘
- `firestore.rules` — Firestore 보안 규칙 (루트)

### 배포 URL
https://smart-care-ledger.web.app

### 배포 체크리스트
- [ ] 로컬 테스트 완료 (`firebase serve`)
- [ ] `node --check` 모든 모듈 통과 (`npm run lint`)
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
| 연도 마감 시 재압축 보관 | `recompressStorageImage` + `settings.js executeArchive` | 해당 연도 영수증·통장사진을 900px/0.6으로 재압축(덮어쓰기), **삭제하지 않음** |
| 목록용 썸네일 | `uploadImageWithThumb` | 통장사진 업로드 시 320px 썸네일 동시 생성 → 갤러리/보고서 목록은 `thumbUrl` 사용 (다운로드 대역폭 절감) |
| 엑셀 원본 gzip 저장 | `storage.js` `uploadExcelOriginal` | 원본은 유지하되 gzip 압축 저장(다운로드 시 원본 복원), 중복 rawRows는 미저장 |

### CORS 설정 (연도 마감 재압축에 필요)

재압축은 브라우저에서 저장된 이미지를 다시 읽어야 하므로 버킷 CORS 허용이 필요하다.
설정하지 않으면 마감은 정상 진행되지만 이미지 재압축만 건너뛴다(best-effort).

```bash
gsutil cors set cors.json gs://smart-care-ledger.firebasestorage.app
```

> `cors.json`은 프로젝트 루트에 있으며 배포 대상은 아님(운영 1회 적용).