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
  activeClient: null,
  sortKey: 'date', sortDir: 'asc',       // 기본 오름차순(과거→최신)
  rptSortKey: 'date', rptSortDir: 'asc', // 보고서 거래내역 정렬
  excelFile: null, excelMonth: '', excelRawRows: [], // 엑셀 원본 Drive 저장용
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
  fixedItems: [],          // 고정항목
  confirmedMonths: new Set(), // 최종 결재 완료된 월 캐시
  permissions: null,       // 역할별 권한 맵 (initPermissions() 로드)
  monthlyStats: {},        // 당월 입주자별 수입/지출 집계 { clientId: {inc, exp} }
};
