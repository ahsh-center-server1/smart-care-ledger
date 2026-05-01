# Generator.md — 코드 구현 담당 역할 지침

## 역할 정의

**Generator**는 `feature_list.json`에서 `pending` 상태의 기능을 하나씩 선택하여 구현하고, 자체 검증 후 상태를 `done` 또는 `failed`로 업데이트하는 역할입니다.

---

## 작업 전 필수 확인

```
1. CLAUDE.md 읽기 → 프로젝트 전체 구조 파악
2. feature_list.json 읽기 → 구현할 기능 선택 (priority 순)
3. Designer.md 읽기 → 디자인 규칙 확인
4. 아래 모듈 맵 참조 → 수정할 파일 특정
5. 대상 모듈 파일 현재 상태 확인 → Read 도구로 관련 코드 읽기
```

---

## 모듈 맵 (기능 영역 → 수정 파일)

> 모놀리식 app.js가 아닌 해당 모듈 파일을 수정합니다.

| 기능 영역 | 수정 파일 |
|---|---|
| 로그인/세션/역할 | `public/modules/auth.js` |
| 권한 체크 (can()) | `public/modules/permissions.js` |
| fetchBaseData, isConfirmedLocked, loadTransactions | `public/modules/core.js` |
| 대시보드 카드 렌더링 | `public/modules/dashboard.js` |
| 거래내역 CRUD, 필터, 정렬, 드래그 | `public/modules/transactions.js` |
| 보고서 생성, 결재, 엑셀/인쇄 | `public/modules/report.js` |
| 설정 (직원/입주자/계좌/카테고리/규칙/고정항목/예산/아카이브) | `public/modules/settings.js` |
| 모달 (영수증/은행명세/수기입력/엑셀업로드) | `public/modules/modals.js` |
| Firestore 초기화 (fb, fdb) | `public/services/firestore.js` |
| Google Drive 업로드/압축 | `public/services/drive.js` |
| toast, showConfirm, setText, showLoading | `public/utils/ui.js` |
| 상수 (COLS, CAT_COLORS, STATUS_*) | `public/constants.js` |
| 전역 상태 (S 객체) | `public/state.js` |
| ExcelParser, 이벤트 바인딩, window 전역 노출 | `public/app.js` |
| HTML 구조/CSS | `public/index.html` |

---

## 구현 절차

```
Step 1: feature_list.json에서 pending 중 가장 높은 priority 선택
Step 2: 해당 기능의 description, success_criteria, notes 정독
Step 3: 의존성(dependencies) 확인 → 모두 done인지 확인
Step 4: 현재 관련 코드 분석 (view 도구 사용)
Step 5: 구현
Step 6: 자체 검증 (아래 체크리스트)
Step 7: feature_list.json 상태 업데이트
Step 8: 결과 보고
```

---

## 필수 자체 검증 체크리스트

구현 후 반드시 아래를 확인합니다:

```bash
# 1. 문법 검사 — 수정한 모듈 파일 전체 확인
for f in public/app.js public/constants.js public/state.js \
          public/modules/*.js public/services/*.js public/utils/*.js; do
  node --check "$f" && echo "OK: $f" || echo "FAIL: $f"
done
# → 모두 OK여야 통과

# 2. 괄호 균형 (수정한 파일만)
python3 -c "
t = open('public/modules/TARGET.js').read()
print('{:', t.count('{') - t.count('}'))
print('(:', t.count('(') - t.count(')'))
print('[:', t.count('[') - t.count(']'))
print('backtick:', t.count('\`') % 2)
"
# → 모두 0이어야 통과

# 3. 중복 함수 없음 (수정한 파일 내)
grep -c "function 함수명" public/modules/TARGET.js  # 1이어야 함

# 4. 실제 줄바꿈 문자 없음
# 단일따옴표 문자열 내 실제 \n 없음

# 5. 기존 기능 키워드 유지
# 이전에 구현된 주요 함수명이 여전히 존재하는지 확인
```

---

## 코드 작성 규칙

### 파일 수정 시

1. **항상 현재 코드를 먼저 읽는다** (`view` 도구)
2. **정밀 패치 방식 사용** — 전체 재작성 금지
3. **python replace 방식** — 정확한 문자열 매칭
4. **인덱스 기반 교체 최소화** — 파일 손상 위험

### 금지 사항

```python
# ❌ 금지: 인덱스 기반으로 파일 앞뒤를 다시 붙이는 방식
content = content[:start] + new_block + content[end:]
# → 파일 크기가 예상보다 줄거나 늘 수 있음

# ✅ 권장: 정확한 문자열 replace
content = content.replace(old_exact_string, new_string, 1)
```

### 문자열 내 특수문자

```javascript
// ❌ 단일따옴표 문자열 내 실제 줄바꿈
'메시지 첫 줄
두 번째 줄'

// ✅ 이스케이프 처리
'메시지 첫 줄\n두 번째 줄'

// ❌ 단일따옴표 문자열 내 단일따옴표
'font-family: 'JetBrains Mono''

// ✅ 폰트명 따옴표 제거 또는 이스케이프
'font-family: JetBrains Mono, monospace'
```

---

## 구현 패턴

### HTML 추가

```python
# 정확한 위치 앞/뒤에 삽입
old = '<!-- 기존 마커 -->'
new = '<!-- 새 내용 -->\n<!-- 기존 마커 -->'
content = content.replace(old, new, 1)
```

### JS 함수 추가

```python
# 기존 함수 뒤에 삽입
old = 'function existingFn() { ... }'
new = old + '\n\nfunction newFn() { ... }'
```

### JS 함수 수정

```python
# 함수 전체를 정확하게 replace
old_fn = '''function targetFn() {
  old_body
}'''
new_fn = '''function targetFn() {
  new_body
}'''
content = content.replace(old_fn, new_fn, 1)
```

---

## feature_list.json 상태 업데이트

```json
// 성공 시
{
  "status": "done",
  "completed_at": "YYYY-MM-DD",
  "notes": "구현 완료. 변경된 내용 요약."
}

// 실패 시
{
  "status": "failed",
  "notes": "실패 원인 설명. 다음 시도 시 주의사항."
}
```

---

## 결과 보고 형식

```
## 구현 완료: [기능 ID] [기능 제목]

### 변경 파일
- `app.js`: [변경 내용 요약]
- `index.html`: [변경 내용 요약]

### 자체 검증 결과
- ✅ node --check: 0
- ✅ 괄호 균형: 정상
- ✅ 중복 함수: 없음
- ✅ 기존 기능: [핵심 함수명들] 존재 확인

### Evaluator 검증 요청
다음 항목을 확인해 주세요:
1. [success_criteria 1]
2. [success_criteria 2]
```

---

## Generator가 하지 말아야 할 것

- feature_list.json에 없는 기능 임의 추가 ❌
- 한 번에 여러 기능 동시 구현 ❌ (하나씩 순서대로)
- 검증 없이 완료 처리 ❌
- 디자인 임의 변경 ❌ (Designer.md 준수)
- 기존 함수 삭제 ❌ (명시적 요청 없는 한)