// public/modules/settings-nav.js
//
// 설정 화면의 정보구조 — **탭 목록이 데이터다.**
//
// 왜 이렇게 바꾸는가
//   기존에는 탭 버튼 6개가 index.html에 하드코딩돼 있고, 권한 검사는
//   switchSettingsTab 안의 if 문 두 개로 특정 탭 이름을 직접 비교했다.
//   그래서 탭을 하나 추가하려면 (1) HTML에 버튼, (2) HTML에 패널 div,
//   (3) 권한 if 문, (4) 활성화 클래스 토글 — 네 곳을 손대야 하고
//   빠뜨린 곳은 조용히 어긋난다.
//
//   또 가로 탭은 개수가 늘면 무너진다. 「개요」와 「감사」를 더하면 8개가 되어
//   좁은 화면에서 가로 스크롤이 생기고, 40~60대 사용자에게는 특히 찾기 어렵다.
//
//   그래서 배열 하나가 **데스크톱 사이드 레일 + 모바일 select + 패널 표시**를
//   모두 구동하게 한다. 탭 추가는 배열에 한 줄 + 패널 div 하나다.
//
// 권한
//   각 탭이 요구하는 권한 키를 `perm`에 적는다. 화면에서 안 보이는 것과
//   눌러도 안 되는 것이 같은 근거를 쓰므로 어긋날 수 없다.
//   perm이 없으면 설정 화면에 들어온 사람 전원에게 보인다.

'use strict';

import { can } from './permissions.js';
import { S } from '../state.js';

/**
 * 설정 탭 정의.
 *
 * key   — 패널 요소 id의 접두어 (`${key}-tab-content`)
 * label — 레일·select에 보이는 이름
 * icon  — utils/icons.js 의 아이콘 이름. 이모지를 쓰지 않는 이유는 그 파일 머리말에
 * perm  — 필요한 권한 키 (없으면 전원)
 * desc  — 패널 상단 한 줄 설명. "이 화면이 무엇을 하는 곳인지"를 말한다.
 */
export const SETTINGS_TABS = [
  {
    key: 'overview', label: '개요', icon: 'report',
    desc: '지금 손봐야 할 것들을 모아 보여줍니다.',
  },
  {
    key: 'list', label: '직원·입주자·계좌', icon: 'people',
    desc: '직원 계정, 입주자, 계좌를 등록하고 관리합니다.',
  },
  {
    key: 'team', label: '팀', icon: 'people',
    perm: 'assignments.manage',
    desc: '팀을 만들고 팀장을 지정합니다. 입주자에 팀을 정하면 담당 후보가 그 팀으로 좁혀집니다.',
  },
  {
    key: 'category', label: '카테고리·자동분류', icon: 'copy',
    desc: '지출·수입 분류와 엑셀 업로드 시 자동분류 규칙을 관리합니다.',
  },
  {
    key: 'fixed', label: '고정 수입/지출', icon: 'refresh',
    perm: 'settings.fixed',
    desc: '매월 같은 날 반복되는 항목을 등록해 두면 한 번에 입력할 수 있습니다.',
  },
  {
    key: 'budget', label: '예산 관리', icon: 'coin',
    perm: 'settings.budget',
    desc: '입주자별 연간 예산을 정하면 보고서에서 실적과 비교됩니다.',
  },
  {
    key: 'bankparser', label: '은행 파서', icon: 'book',
    perm: 'excel.upload',
    desc: '내장돼 있지 않은 은행의 거래내역 파일을 읽게 합니다. 은행이 늘어도 배포가 필요하지 않습니다.',
  },
  {
    key: 'audit', label: '변경 이력', icon: 'list',
    perm: 'audit.view',
    desc: '누가 무엇을 언제 바꿨는지 기록입니다.',
  },
  {
    key: 'archive', label: '데이터 마감', icon: 'archive',
    perm: 'settings.archive',
    desc: '연도를 마감해 거래를 보관하고, 다음 해 기초잔액을 넘깁니다.',
  },
  {
    key: 'permissions', label: '내 역할 안내', icon: 'key',
    desc: '내 업무 역할과 담당 범위, 역할별 업무를 확인합니다. 권한은 이 화면에서 변경하지 않습니다.',
  },
];

/**
 * 4분류. 탭이 8개를 넘으면 평평한 목록에서는 원하는 것을 찾기 어렵다.
 * 그룹 안이 전부 권한에 걸려 비면 그룹째로 그리지 않는다.
 */
export const SETTINGS_GROUPS = [
  { label: '현황',   items: ['overview'] },
  { label: '운영',   items: ['list', 'team', 'category'] },
  { label: '정산',   items: ['fixed', 'budget'] },
  { label: '시스템', items: ['bankparser', 'audit', 'archive', 'permissions'] },
];

/** key → 탭 정의 (파생) */
export const SETTINGS_TAB_BY_KEY = Object.fromEntries(
  SETTINGS_TABS.map(t => [t.key, t]),
);

export function isKnownSettingsTab(key) {
  return Object.prototype.hasOwnProperty.call(SETTINGS_TAB_BY_KEY, key);
}

/** 현재 사용자가 이 탭을 볼 수 있는가. */
export function canSeeSettingsTab(key) {
  const tab = SETTINGS_TAB_BY_KEY[key];
  if (!tab) return false;
  if (key !== 'permissions' && (S.settingsGuideOnly || !can('nav.settings'))) return false;
  return !tab.perm || can(tab.perm);
}

/** 볼 수 있는 탭만. */
export function visibleSettingsTabs() {
  return SETTINGS_TABS.filter(t => canSeeSettingsTab(t.key));
}

/**
 * 처음 열 때 보여줄 탭.
 *
 * 저장값을 **현재 권한으로 다시 검사한다** — 역할이 강등됐거나 권한 등급표가
 * 바뀌었을 때 저장된 관리자 탭이 그대로 열리면 안 된다.
 */
export function initialSettingsTab(stored) {
  if (stored && canSeeSettingsTab(stored)) return stored;
  const first = visibleSettingsTabs()[0];
  return first ? first.key : null;
}
