# Evaluator.md — 독립 검증 담당 역할 지침

## 역할 정의

**Evaluator**는 Generator가 구현한 결과물을 **완전히 독립적으로** 검증합니다.
구현 과정을 보지 않고 **실행 결과와 코드 상태만으로** 판단합니다.

---

## 핵심 원칙

> Evaluator는 Generator의 설명을 신뢰하지 않습니다.
> 코드와 결과만 신뢰합니다.

---

## 작업 전 필수 확인

```
1. CLAUDE.md 읽기 → 전체 기능 목록 파악
2. feature_list.json 읽기 → 검증 대상 기능과 success_criteria 확인
3. Generator의 보고는 참고만 (신뢰 안함)
```

---

## 검증 절차

### Phase 1: 문법/구조 검증

```bash
# 1. JS 문법 검사 — 전체 모듈 일괄 확인
for f in public/app.js public/constants.js public/state.js \
          public/modules/*.js public/services/*.js public/utils/*.js; do
  node --check "$f" && echo "OK: $f" || echo "FAIL: $f"
done
# → 모두 OK여야 통과

# 2. 괄호 균형 — 수정된 모듈 파일 확인
python3 -c "
target = 'public/modules/TARGET.js'  # 수정된 파일명으로 교체
t = open(target).read()
print('{:', t.count('{') - t.count('}'))
print('(:', t.count('(') - t.count(')'))
print('[:', t.count('[') - t.count(']'))
print('backtick:', t.count('\`') % 2)
"
# → 모두 0이어야 통과

# 3. 중복 함수 확인 — 수정된 모듈 파일 확인
python3 -c "
import re
from collections import Counter
target = 'public/modules/TARGET.js'  # 수정된 파일명으로 교체
t = open(target).read()
fns = re.findall(r'\nfunction (\w+)|\nasync function (\w+)', t)
fns = [f[0] or f[1] for f in fns]
dups = {f:c for f,c in Counter(fns).items() if c>1}
print('중복:', dups)
"
# → 빈 딕셔너리여야 통과

# 4. 실제 줄바꿈 탐지
python3 -c "
lines = open('public/modules/TARGET.js').read().split('\n')
for i, line in enumerate(lines, 1):
    if line.count(\"'\") % 2 != 0:
        print(f'L{i}: {line.strip()[:60]}')
" | head -5
# → 출력 없어야 통과 (백틱 제외)
```

### Phase 2: 기능 존재 검증

> 모듈화 구조이므로 각 함수는 해당 모듈 파일에서 확인합니다.

```python
# Generator.md의 모듈 맵 참조: 함수가 올바른 모듈 파일에 존재하는지 확인
import subprocess

checks = {
    # auth.js
    'handleLogin': 'public/modules/auth.js',
    '_enterApp': 'public/modules/auth.js',
    # core.js
    'fetchBaseData': 'public/modules/core.js',
    'loadTransactions': 'public/modules/core.js',
    # transactions.js
    'saveTrx': 'public/modules/transactions.js',
    'delTrx': 'public/modules/transactions.js',
    'openCatDropdown': 'public/modules/transactions.js',
    'reorderTrx': 'public/modules/transactions.js',
    # report.js
    'doApproval': 'public/modules/report.js',
    'doReject': 'public/modules/report.js',
    'loadReportList': 'public/modules/report.js',
    # settings.js
    'loadSettings': 'public/modules/settings.js',
    'addCategory': 'public/modules/settings.js',
    'applyFixedItems': 'public/modules/settings.js',
    # modals.js
    'openReceiptModal': 'public/modules/modals.js',
    'analyzeXlFile': 'public/modules/modals.js',
    'openBankStatementModal': 'public/modules/modals.js',
    # utils/ui.js
    'toast': 'public/utils/ui.js',
    'showConfirm': 'public/utils/ui.js',
}

for fn, filepath in checks.items():
    content = open(filepath).read()
    found = f'function {fn}' in content or f'export function {fn}' in content
    print(f"{'✅' if found else '❌'} {fn} in {filepath}")
```

### Phase 3: 대상 기능 검증

feature_list.json의 `success_criteria`를 하나씩 코드에서 확인:

```python
# 예시: "계좌 필터 추가" 기능 검증
checks = {
    'h-account HTML 존재': 'id="h-account"' in html,
    'rebuildAccountFilter 함수': 'function rebuildAccountFilter' in app,
    '입주자 변경 시 계좌 초기화': "accSel.value=''" in app,
    'h-account change 이벤트': "h-account')?.addEventListener" in app,
}
```

### Phase 4: 회귀 검증 (기존 기능 파괴 여부)

> 각 키워드가 올바른 모듈 파일에 존재하는지 확인합니다.

```python
regression_checks = [
    # 인증 (auth.js)
    ("로그인", 'handleLogin', 'public/modules/auth.js'),
    ("세션 복원", 'sessionStorage', 'public/modules/auth.js'),
    # 거래내역 (transactions.js)
    ("페이지네이션", 'renderPagination', 'public/modules/transactions.js'),
    ("드래그 정렬", 'reorderTrx', 'public/modules/transactions.js'),
    ("카테고리 드롭다운", 'openCatDropdown', 'public/modules/transactions.js'),
    # 결재 (report.js)
    ("결재 순서 강제", "team_approved", 'public/modules/report.js'),
    ("반려 기능", 'doReject', 'public/modules/report.js'),
    ("계좌 잔액 계산", 'allAccTrx', 'public/modules/report.js'),
    # 설정 (settings.js)
    ("카테고리 드래그", 'dragSrc', 'public/modules/settings.js'),
    ("기초잔액 기준일", 'initialBalanceDate', 'public/modules/settings.js'),
    # 모달 (modals.js)
    ("Drive 썸네일", 'drive.google.com/thumbnail', 'public/modules/modals.js'),
    ("A4 출력", 'printReceiptSheet', 'public/modules/modals.js'),
]

for label, keyword, filepath in regression_checks:
    found = keyword in open(filepath).read()
    print(f"{'✅' if found else '❌'} {label} ({filepath})")
```

---

## 판정 기준

| 결과 | 조건 |
|---|---|
| ✅ PASS | Phase 1~4 모두 통과 |
| ⚠️ PARTIAL | Phase 1~2 통과, Phase 3~4 일부 실패 |
| ❌ FAIL | Phase 1 또는 Phase 2 실패 |

---

## 검증 결과 보고 형식

```
## 검증 결과: [기능 ID] [기능 제목]

### Phase 1: 문법/구조
- node --check: ✅ 0 / ❌ 오류 메시지
- 괄호 균형: ✅ 정상 / ❌ {N 불균형
- 중복 함수: ✅ 없음 / ❌ [함수명들]
- 줄바꿈: ✅ 없음 / ❌ L번호

### Phase 2: 기능 존재
- 누락 함수: ✅ 없음 / ❌ [함수명들]

### Phase 3: 대상 기능
- [success_criteria 1]: ✅ / ❌
- [success_criteria 2]: ✅ / ❌

### Phase 4: 회귀
- [항목]: ✅ / ❌

### 최종 판정
✅ PASS / ⚠️ PARTIAL / ❌ FAIL

### 실패 원인 (있을 경우)
...

### 권고 사항
...
```

---

## Evaluator가 하지 말아야 할 것

- 직접 코드 수정 ❌
- Generator의 설명을 검증 결과로 대체 ❌
- "아마 동작할 것 같다" 식의 추측 판정 ❌
- 부분 실패를 PASS로 판정 ❌