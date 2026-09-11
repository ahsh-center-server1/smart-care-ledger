# 보안·권한·증빙 수명주기

## 목표

- 거래 쓰기를 capability별 필드 화이트리스트로 제한한다.
- 영수증 작업을 `uploaded → analyzed → finalizing → attached → completed` 상태 기계로 실제 호출 경로에 연결한다.
- 최종 객체의 create-only 복사를 출처 metadata로 검증하고, 교체는 경로와 generation을 비교한다.
- 최종 결재와 `config/lockedMonths` 갱신을 같은 Firestore 트랜잭션으로 묶는다.
- 연도 마감을 lease 기반으로 단일 실행하고, 재압축 뒤 바뀐 generation을 보관 거래에 반영한다.
- AI 판독은 서버가 만든 job의 불변 staging 객체만 읽고, 사용자별·프로젝트별 한도를 함께 적용한다.
- 만료 job 정리는 참조 중인 최종 영수증을 보존하고 검증할 수 없는 객체를 감사 대상으로 남긴다.

## 수용 기준

1. `trx.reorder`만 가진 호출자는 `sortOrder` 외 필드를 바꿀 수 없다.
2. job 없는 파일, 만료 job, 허용하지 않은 MIME, `source` 이외 이름은 스테이징 업로드가 거부된다.
3. `uploaded` job은 서버의 업로드 확인을 거쳐야만 `analyzed`가 된다.
4. 목적지 412는 metadata가 현재 job과 일치할 때만 재사용한다.
5. 영수증 교체는 예상 경로와 예상 generation이 모두 일치해야 한다.
6. 보고서 상태와 월 잠금은 원자적으로 바뀐다.
7. 연도 마감은 동시에 하나의 lease만 보유하고, 재압축 후 새 generation을 저장한다.
8. AI 함수는 임의 브라우저 이미지 대신 현재 권한·담당 범위를 만족하는 job의 staging 파일만 판독한다.
9. 사용자별 한도 안에서도 프로젝트 전체 한도를 넘으면 AI 호출이 거부된다.
10. job TTL과 정리 작업은 거래가 참조하는 최종 영수증을 삭제하지 않는다.

## 검증

- `npm run check`
- `npm run test:contract`
- `npm run test:rules`
- 변경된 함수의 단위·경합·실패 복구 테스트

## 완료 결과

- 정적 검사·vendor 동기화·단위 테스트: 708건 통과
- 권한 계약 테스트와 ratchet: 각각 21건 통과
- Firestore·Storage Rules: 255건 통과
- 운영 배포, 운영 데이터 접근, 브라우저 에뮬레이터 QA는 수행하지 않음
