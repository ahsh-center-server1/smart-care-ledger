/**
 * constants.js — Smart Care Ledger v2
 * 전역 상수 정의 (색상, 상태값, 컬렉션명, 설정값)
 */

'use strict';

// ─────────────────────────────────────────────
// ★ 설정값 — 본인 값으로 변경하세요
// ─────────────────────────────────────────────
export const GOOGLE_OAUTH_CLIENT_ID = '731965168909-80uq0h2andcc0pnlk5knreuofq47ad9v.apps.googleusercontent.com';
export const DRIVE_FOLDER_ID        = '1Qie2S1UvKhyYpgWmWfhpUaNFrqF1cT7c';

// ─────────────────────────────────────────────
// Firestore 컬렉션명
// ─────────────────────────────────────────────
export const COLS = {
  USERS:         'users',
  CLIENTS:       'clients',
  ACCOUNTS:      'accounts',
  TRANSACTIONS:  'transactions',
  CATEGORIES:    'categories',
  REPORTS:       'reports',
  CONFIG:        'config',
  EXCEL_UPLOADS: 'excelUploads',
  BUDGETS:       'budgets',
};

// ─────────────────────────────────────────────
// 카테고리 색상
// ─────────────────────────────────────────────
export const CAT_COLORS = {
  '식비':    {bg:'#fef2f2',text:'#dc2626',dot:'#dc2626',border:'#fecaca'},
  '교통비':  {bg:'#eff6ff',text:'#2563eb',dot:'#2563eb',border:'#bfdbfe'},
  '의료비':  {bg:'#f0fdf4',text:'#16a34a',dot:'#16a34a',border:'#bbf7d0'},
  '생필품':  {bg:'#fff7ed',text:'#ea580c',dot:'#ea580c',border:'#fed7aa'},
  '여가비':  {bg:'#faf5ff',text:'#9333ea',dot:'#9333ea',border:'#e9d5ff'},
  '개인관리':{bg:'#fdf4ff',text:'#c026d3',dot:'#c026d3',border:'#f0abfc'},
  '의생활':  {bg:'#ecfdf5',text:'#059669',dot:'#059669',border:'#a7f3d0'},
  '세금공과':{bg:'#f8fafc',text:'#475569',dot:'#64748b',border:'#cbd5e1'},
  '교육비':  {bg:'#eff6ff',text:'#1d4ed8',dot:'#1d4ed8',border:'#bfdbfe'},
  '기타':    {bg:'#f8fafc',text:'#64748b',dot:'#94a3b8',border:'#e2e8f0'},
  '확인필요':{bg:'#fafaf9',text:'#78716c',dot:'#a8a29e',border:'#d6d3d1'},
  '수입':    {bg:'#f0fdf4',text:'#15803d',dot:'#15803d',border:'#bbf7d0'},
  '자산이동':{bg:'#f0f9ff',text:'#0369a1',dot:'#0ea5e9',border:'#bae6fd'},
  '취소':    {bg:'#fafafa',text:'#71717a',dot:'#a1a1aa',border:'#d4d4d8'},
};

/** 카테고리 색상 반환 (없으면 기본값) */
export function cs(cat) {
  return CAT_COLORS[cat] || {bg:'#f8fafc',text:'#475569',dot:'#94a3b8',border:'#e2e8f0'};
}

// ─────────────────────────────────────────────
// 보고서 상태
// ─────────────────────────────────────────────
export const STATUS_LABELS = {
  '':             '미저장',
  'draft':        '임시저장',
  'submitted':    '제출됨',
  'team_approved':'팀장 결재완료',
  'confirmed':    '최종 결재완료',
  'rejected':     '반려됨',
};

export const STATUS_CLASSES = {
  '':             'rs-draft',
  'draft':        'rs-draft',
  'submitted':    'rs-submitted',
  'team_approved':'rs-team',
  'confirmed':    'rs-confirmed',
  'rejected':     'rs-rejected',
};
