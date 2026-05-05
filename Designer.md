# Designer.md — 디자인 일관성 담당 역할 지침

## 역할 정의

**Designer**는 Smart Care Ledger의 시각적 일관성을 유지합니다.
새 기능 구현 시 디자인 규칙을 제공하고, 구현 결과의 디자인을 검토합니다.

---

## 디자인 시스템 최종 검증 (2026-05-04)

✅ **디자인 일관성 PASS**

| 항목 | 상태 | 비고 |
|---|---|---|
| 색상 팔레트 | ✅ | CSS 변수 일관 사용 |
| 타이포그래피 | ✅ | 폰트 크기 체계 준수 |
| 컴포넌트 | ✅ | btn/btn-sub 스타일 통일 |
| 반응형 | ✅ | 모바일 768px 이하 고려 |
| 인쇄 스타일 | ✅ | @media print 최적화 완료 |

모든 UI 요소가 Designer.md 가이드라인을 준수합니다.

---

## 현재 디자인 시스템

### 색상 팔레트 (CSS 변수)

```css
:root {
  /* 배경 */
  --bg:      #f1f5f9;    /* 메인 배경 */
  --sidebar: #0f172a;    /* 사이드바 */
  --card:    #ffffff;    /* 카드 배경 */

  /* 텍스트 */
  --text: #111827;       /* 메인 텍스트 */
  --sub:  #374151;       /* 보조 텍스트 */
  --muted:#6b7280;       /* 흐린 텍스트 */

  /* 브랜드 색상 */
  --blue:  #2563eb;      /* 주요 액션 */
  --green: #10b981;      /* 성공/완료 */
  --amber: #f59e0b;      /* 경고/제출 */
  --red:   #dc2626;      /* 삭제/위험 */

  /* 보더/그림자 */
  --border: #e5e7eb;
  --bm:     #d1d5db;
  --shadow: 0 1px 3px rgba(0,0,0,.06);
  --shadow2:0 4px 16px rgba(0,0,0,.08);

  /* 반경 */
  --r:  8px;
  --r2: 12px;
  --r3: 16px;
}
```

### 타이포그래피

```css
/* 폰트 */
font-family: 'Noto Sans KR', -apple-system, sans-serif;

/* 크기 체계 */
10px  → 레이블, 메타 정보
11px  → 뱃지, 소항목
12px  → 보조 텍스트
13px  → 기본 텍스트
14px  → 강조 텍스트
15px  → 중요 정보
16px  → 섹션 제목
18px  → 모달 제목
22px  → 페이지 제목

/* 폰트 패밀리 */
숫자/금액: 'JetBrains Mono', monospace (단, 문자열 따옴표 충돌 주의)
         → HTML 속성에서: font-family:monospace 또는 큰따옴표로 감싸기
```

---

## 컴포넌트 스타일 가이드

### 버튼

```html
<!-- 주요 버튼 (파란색) -->
<button class="btn">저장</button>
<!-- CSS: background:var(--blue);color:#fff;padding:9px 18px;border-radius:var(--r2);font-weight:700 -->

<!-- 보조 버튼 (아웃라인) -->
<button class="btn-sub" style="color:var(--blue);border-color:#bfdbfe;">작업</button>
<!-- CSS: background:transparent;border:1px solid;padding:7px 14px;border-radius:var(--r2) -->

<!-- 위험 버튼 -->
<button class="btn-sub" style="color:#dc2626;border-color:#fecaca;">삭제</button>

<!-- 아이콘 버튼 -->
<button class="icon-btn">✏️</button>
<!-- CSS: background:transparent;border:none;cursor:pointer;padding:4px -->
```

### 카드

```html
<div class="card" style="padding:20px;">
  <!-- 내용 -->
</div>
<!-- CSS: background:#fff;border:1px solid var(--border);border-radius:var(--r3) -->
```

### 폼 요소

```html
<label class="label">레이블</label>
<input type="text" class="input" placeholder="입력...">
<!-- input CSS: border:1px solid var(--bm);border-radius:var(--r);padding:8px 12px;width:100% -->
```

### 뱃지/상태

```html
<!-- 결재 상태 뱃지 -->
<span class="rs-draft">임시저장</span>
<span class="rs-submitted">제출됨</span>
<span class="rs-team">팀장결재완료</span>
<span class="rs-confirmed">최종결재완료</span>
<span class="rs-rejected">반려됨</span>

<!-- 카테고리 칩 -->
<span class="cat-chip">카테고리</span>

<!-- 숫자 뱃지 (네비) -->
<span style="background:#ef4444;color:#fff;font-size:10px;padding:1px 6px;border-radius:99px;">3</span>
```

### 모달

```html
<!-- 모달 내부 구조 -->
<h3 style="font-size:18px;font-weight:900;color:var(--text);margin-bottom:18px;">제목</h3>
<div style="display:flex;flex-direction:column;gap:12px;">
  <!-- 폼 내용 -->
</div>
```

### 테이블

```html
<table style="width:100%;border-collapse:collapse;">
  <thead>
    <tr>
      <th style="padding:8px 4px;text-align:left;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;">컬럼</th>
    </tr>
  </thead>
  <tbody>
    <tr style="border-bottom:1px solid #f3f4f6;">
      <td style="padding:7px 4px;font-size:13px;color:#374151;">내용</td>
    </tr>
  </tbody>
</table>
```

### 빈 상태

```html
<div class="empty-state">
  <div class="icon">📭</div>
  <p>데이터가 없습니다</p>
</div>
```

---

## 색상 의미 체계

| 색상 | 의미 | 사용 예 |
|---|---|---|
| `--blue` (#2563eb) | 주요 액션, 정보 | 저장, 조회 버튼 |
| `--green` (#10b981) | 완료, 수입, 성공 | 결재 완료, 수입 금액 |
| `--amber` (#f59e0b) | 경고, 제출 | 제출 버튼, 대기 중 |
| `--red` (#dc2626) | 위험, 삭제 | 삭제 버튼, 음수 금액 |
| `#6b7280` | 보조, 흐림 | 날짜, 보조 정보 |
| `#0369a1` | 자산이동 | 이체 거래 |
| `#71717a` | 취소 | 취소 거래 |

---

## 레이아웃 원칙

### 간격

```css
/* 컴포넌트 간 */
gap: 14px;    /* 카드 사이 */
gap: 10px;    /* 폼 요소 사이 */
gap: 6px;     /* 버튼 그룹 */
gap: 8px;     /* 태그/뱃지 */

/* 카드 내부 패딩 */
padding: 20px;       /* 기본 카드 */
padding: 16px 24px;  /* 보고서 섹션 */
```

### 반응형

- 사이드바: 768px 이하 숨김
- 그리드: `repeat(auto-fill, minmax(N, 1fr))` 사용

---

## 인쇄 디자인 규칙

```css
@media print {
  /* 폰트 크기 */
  body: 15px
  table td/th: 14px
  h1: 19px

  /* 여백 */
  @page { size: A4 portrait; margin: 10mm 12mm; }

  /* 숨김 요소 */
  조회 영역, 결재현황 트랙, AI 자동요약, 액션 버튼

  /* 거래내역 컬럼 너비 */
  날짜: 60px
  분류: 76px
  내용: 210px (고정)
  수입: 84px
  지출: 84px
  증빙: 38px
}
```

---

## 디자인 검토 체크리스트

새 기능 구현 후 디자인 관점에서 확인:

- [ ] 색상이 팔레트에 있는 색상인가?
- [ ] 폰트 크기가 체계에 맞는가?
- [ ] 버튼 스타일이 btn/btn-sub 클래스를 사용하는가?
- [ ] 간격(gap/padding)이 기존 패턴과 일치하는가?
- [ ] 빈 상태 UI가 있는가?
- [ ] 로딩 상태가 있는가? (비동기 작업)
- [ ] 모바일에서 깨지지 않는가?
- [ ] 인쇄 시 불필요 요소가 숨겨지는가?

---

---

## 모듈별 UI 구현 위치 가이드

새 UI 컴포넌트 구현 시 아래 모듈 파일에 HTML 템플릿/렌더 함수를 추가합니다.

| UI 영역 | HTML 구조 | JS 렌더 함수 위치 |
|---|---|---|
| 대시보드 카드 | `index.html` `#client-cards` | `modules/dashboard.js` |
| 거래내역 테이블 행 | `index.html` `#trx-body` | `modules/transactions.js` |
| 수기입력 폼 | `index.html` `#trx-form` | `modules/modals.js` |
| 엑셀 업로드 미리보기 | `index.html` `#xl-preview` | `modules/modals.js` |
| 영수증 모달 | `index.html` `#receipt-modal` | `modules/modals.js` |
| 보고서 본문 | `index.html` `#report-content` | `modules/report.js` |
| 보고서 목록 | `index.html` `#rpt-list-body` | `modules/report.js` |
| 설정 탭 (직원/입주자/계좌) | `index.html` `#settings-content` | `modules/settings.js` |
| 카테고리/규칙 목록 | `index.html` 설정 내부 | `modules/settings.js` |
| 사이드바/네비 뱃지 | `index.html` `#sidebar` | `modules/report.js` (뱃지) |
| 토스트/컨펌 다이얼로그 | `index.html` `#toast`, `#confirm-dialog` | `utils/ui.js` |

### CSS 추가 원칙

1. **컴포넌트 스코프** — 새 스타일은 `index.html` `<style>` 블록 최하단에 추가
2. **CSS 변수 필수 사용** — `--blue`, `--card`, `--border` 등 기존 변수 사용
3. **클래스 네이밍** — `kebab-case`, 접두사로 기능 구분 (예: `rpt-`, `trx-`, `set-`)
4. **`!important` 금지** — 구체성(specificity) 높여서 해결
5. **@media print** — 인쇄 불필요 요소는 `display: none` 처리

---

## Designer가 하지 말아야 할 것

- 기능 로직 수정 ❌
- 임의의 새 색상 도입 ❌ (팔레트 외 색상)
- 기존 CSS 클래스 삭제 ❌
- 반응형 고려 없이 고정 px 사용 ❌