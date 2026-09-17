# 영수증 사진 자동입력 — 설치와 운영

영수증·통장 사진에서 날짜·금액·상호명을 읽어 거래 입력을 채워 주는 기능입니다.
**켜지 않아도 앱은 완전히 동작합니다** — 수기 입력과 엑셀 업로드는 그대로입니다.

---

## 1. 무엇이 자동이고 무엇이 아닌가

| 하는 일 | 누가 |
|---|---|
| 사진에 인쇄된 글자를 구조화해서 옮겨 적기 | Gemini (모델) |
| 날짜 해석 (`26.09.07` → `2026-09-07`) | 코드 (`public/domain/receipt.js`) |
| 금액 해석 (`12,000원` → `12000`) | 코드 |
| 분류 결정 (식비·교통비…) | **설정 화면의 자동분류 규칙** |
| 어느 거래의 증빙인지 판정 | 코드 (`public/domain/receipt-match.js`) |
| 저장 여부 최종 확인 | **사람** |

모델은 **DB에 쓰지 않습니다.** 초안을 만들고, 검토 표에서 사람이 확인한 뒤에
앱이 저장합니다. 자동 첨부는 금액이 정확히 일치하고 날짜가 3일 이내이며
후보가 하나뿐일 때만 일어납니다. 애매하면 후보를 제시하고 사람이 고릅니다.

---

## 2. 비용

| 항목 | 값 |
|---|---|
| 모델 | 기본 `gemini-3.5-flash-lite` (`GEMINI_MODEL` 환경변수로 교체 가능) |
| 사진 1장 | 실제 모델·이미지 크기·과금 등급에 따라 달라짐 |
| 월 500장 | Google AI Studio 또는 Vertex AI 콘솔의 현재 단가로 확인 |

**공짜가 아닙니다.** 그래서:
- 사용자별 레이트리밋 기본 **분당 10장** (`AI_USER_RPM`)
- 프로젝트 전체 레이트리밋 기본 **분당 30장** (`AI_PROJECT_RPM`)
- 한 번에 최대 **10장**
- 업로드 전에 1200px로 압축 (`services/image.js`) — 토큰 수를 줄입니다

운영 자료에는 입주자 개인정보와 금융 정보가 포함될 수 있습니다. 무료 등급을
실제 자료에 쓰기 전에는 Google의 현재 데이터 사용 정책과 시설 개인정보
처리방침을 확인하세요.

---

## 3. 설치

### 3-1. API 키 발급
Google AI Studio 또는 Google Cloud 콘솔에서 Gemini API 키를 만듭니다.

### 3-2. Functions 시크릿으로 넣기

**⚠️ `.env` 파일이나 `public/` 어디에도 넣지 마세요.** `public/`은 그대로
서빙되므로 키가 즉시 공개됩니다. Firebase 시크릿 관리자를 씁니다:

```bash
# 스테이징에 먼저
firebase functions:secrets:set GEMINI_API_KEY --project staging
# (프롬프트에 키를 붙여넣습니다)

# 확인
firebase functions:secrets:access GEMINI_API_KEY --project staging
```

### 3-3. 함수에 시크릿을 연결

`functions/index.js`의 `analyzeReceipt` · `analyzeBankbook` · `getAiStatus`가
이 시크릿을 읽도록 배포합니다:

```bash
firebase deploy --only functions:analyzeReceipt,functions:analyzeBankbook,functions:getAiStatus --project staging
```

> 시크릿을 설정하지 않고 배포해도 됩니다. 그 경우 `getAiStatus`가 `false`를
> 돌려주고 **화면에서 「영수증 사진」 버튼이 아예 보이지 않습니다.**
> 눌러서 실패하는 상태를 만들지 않는 것이 의도입니다.

### 3-4. 확인
1. 담당자 이상으로 로그인
2. 대시보드 또는 거래내역 툴바에 **📷 영수증 사진** 버튼이 보이는지
3. 영수증 사진 1장을 올려 값이 채워지는지
4. 설정 → 변경 이력에 `영수증 사진 분석` 기록이 남는지

---

## 4. 개인정보

- 사진은 판독을 위해 Gemini API로 전송됩니다. 시설의 개인정보 처리방침에
  이 사실이 반영되어야 합니다.
- 변경 이력에는 **메타데이터만** 남깁니다 — 사진·상호명·품목은 기록하지
  않습니다 (`writeAiAuditLog`의 summary 참조). 기록 자체가 개인정보 사본이
  되지 않게 하기 위한 것입니다.
- 판독한 사진은 기존 증빙과 같은 경로(`receipts/{clientId}/`)에 저장되며
  기존 보관·삭제 정책을 그대로 따릅니다.

---

## 5. 끄기

```bash
firebase functions:secrets:destroy GEMINI_API_KEY --project staging
firebase deploy --only functions:getAiStatus --project staging
```

키가 사라지면 버튼이 자동으로 숨습니다. 이미 저장된 거래와 증빙은 그대로
남습니다 — 일반 증빙과 구분 없이 다뤄집니다.
