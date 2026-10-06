# 핵심 흐름

## 영수증

`startReceiptUpload` → 브라우저 staging 업로드 → `completeReceiptUpload` → `analyzeReceipt`(서버가 staging 원본 판독) → 검토 → `finalizeReceipts` → create-only 서버 복사·metadata 검증 → Firestore 거래·job·감사로그 트랜잭션 → staging 정리

만료 job은 예약 정리 함수가 `final → staging → job` 순서로 처리한다. 거래가 참조하는 최종 객체는 보존하고, generation 또는 metadata를 검증하지 못한 객체는 삭제하지 않고 감사로그에 남긴다.

## 보고서 마감

`applyReportTransition` → 보고서 조회·전이 판정 → `config/lockedMonths` 조회 → 보고서·잠금·감사로그 원자 반영

## 연도 마감

`runArchive` → lease 선점 → 거래 복사/삭제 → 잔액 전진 → 영수증·통장사진 조건부 재압축 → generation 반영 → lease 해제 또는 완료
# 고정 역할 전환 흐름 (작성중)

직원 역할·담당 배정 → 서버 고정 정책 계산 → authz → 화면·Rules·Functions 검증.
⚠ 기존 isAdmin의 99등급 승격 및 config/permissions 오버라이드는 새 정책에 사용하지 않는다.
업무 요청 → 활성 상태 → 업무 capability → 담당 범위 → 작성자/결재 상태 → 원자 저장.
파일 작업 → job 소유권 → 상태 선점 → 파일 generation → 거래 첨부 또는 정리.
