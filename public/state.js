/**
 * state.js — Smart Care Ledger v2
 * 전역 상태 객체 S (순환 참조 방지를 위해 app.js에서 분리)
 * 모든 모듈은 이 파일에서 S를 import한다.
 */

'use strict';

export const S = {
  user: null,
  users: [], clients: [], accounts: [], categories: [],
  allClients: [], allAccounts: [],   // 비활성 포함 전체 목록 (설정 화면용)
  transactions: [], filteredTrx: [],
  trxRange: 'month',                 // S.transactions의 fetch 범위 ('month' | 'all' | {start,end})
  activeClient: null,
  sortKey: 'date', sortDir: 'asc',       // 기본 오름차순(과거→최신)
  rptSortKey: 'date', rptSortDir: 'asc', // 보고서 거래내역 정렬
  excelFile: null, excelMonth: '', excelRawRows: [], // 엑셀 업로드 임시 상태(원본 파일/미리보기)
  excelSkipped: [],  // 파싱에서 제외된 행과 이유 (조용한 삭제를 없애기 위해 화면에 표시)
  // 보고서 목록 캐시 — 결재할 때마다 reports 컬렉션 전체를 다시 읽지 않기 위한 것.
  // null이면 아직 안 읽었다는 뜻(빈 배열과 구별한다).
  reportList: null,
  rptListAllYears: false,   // true면 전체 기간, 기본은 작년부터
  // 보고서 전용 거래 캐시. 거래내역 탭의 S.transactions와 섞이면 안 된다.
  rptTrxCache: null,
  page: 1, pageSize: 100,
  trxViewMode: 'list', // 'list' | 'calendar'
  calendarYM: '',      // 달력뷰 표시 연월 (YYYY-MM, 비면 filteredTrx 기준)
  excelTemp: [],
  settings: { expCats:[], incCats:[], rules:[] },
  rptChart: null, rptTrendChart: null,
  annualCharts: {},
  reportData: null,
  driveToken: null,
  driveTokenExpiry: null,
  fixedItems: [],          // 고정항목 (활성 입주자 기준)
  allFixedItems: [],       // 고정항목 전체 (대시보드/배너 미납 알림용)
  confirmedMonths: new Set(), // 최종 결재 완료된 월 캐시
  permOverride: null,      // 기능별 최소 등급 오버라이드 (initPermissions() 로드)
  // 권한 스냅샷(authz/{uid}.caps). 보안 규칙이 읽는 값과 같은 것이라,
  // can() 이 이것을 보면 화면과 집행이 어긋나지 않는다. 백필 전이면 null.
  caps: null,
  authz: null,
  authzStatus: 'idle',
  settingsGuideOnly: false,
  leaderClientIds: [],
  // 담당 입주자 id 목록(authz/{uid}.accessibleClientIds). 보안 규칙이 범위를
  // 이것으로 판정하므로 조회도 같은 목록으로 좁힌다.
  accessibleClientIds: [],
  monthlyStats: {},        // 당월 입주자별 수입/지출 집계 { clientId: {inc, exp} }
  mandatoryUnpaid: {},     // 당월 필수 고정항목 미납 카운트 { clientId: number }
};
