/**
 * permissions.js — Smart Care Ledger v2
 * 역할별 권한 설정 레이어
 *
 * 사용법:
 *   import { initPermissions, can, savePermissions } from './permissions.js';
 *   await initPermissions();  // 앱 시작 시 한 번
 *   if (can('trx.edit')) { ... }
 *
 * 권한 키 목록 (28개 설정 가능 + 4개 고정):
 *   내비게이션: nav.report, nav.settings, nav.staff
 *   거래내역: trx.view.all, trx.create, trx.edit, trx.delete, trx.delete.bulk,
 *             trx.reorder, trx.transfer, trx.category.edit, trx.csv
 *   엑셀·증빙: excel.upload, receipt.upload, receipt.print, bankbook.upload
 *   보고서: report.view.all, report.view.own, report.draft, report.edit,
 *           report.delete, report.recall
 *   설정: settings.staff, settings.client, settings.account, settings.fixed,
 *         settings.archive, settings.reset
 *   고정(결재): report.submit, report.approve.team, report.approve.center, report.reject
 */

'use strict';

import { S } from '../state.js';
import { fb, fdb } from '../services/firestore.js';
import { COLS } from '../constants.js';

export const DEFAULT_PERMISSIONS = {
  입력자: {
    'nav.report': false, 'nav.settings': false, 'nav.staff': false,
    'trx.view.all': false, 'trx.create': true, 'trx.edit': true,
    'trx.delete': true, 'trx.delete.bulk': false, 'trx.reorder': false,
    'trx.transfer': false, 'trx.category.edit': false, 'trx.csv': false,
    'excel.upload': false, 'receipt.upload': false, 'receipt.print': false,
    'bankbook.upload': false,
    'report.view.all': false, 'report.view.own': false, 'report.draft': false,
    'report.edit': false, 'report.delete': false, 'report.recall': false,
    'report.submit': false, 'report.approve.team': false, 'report.approve.center': false, 'report.reject': false,
    'settings.staff': false, 'settings.client': false, 'settings.account': false,
    'settings.fixed': false, 'settings.archive': false, 'settings.reset': false,
  },
  담당자: {
    'nav.report': true, 'nav.settings': true, 'nav.staff': false,
    'trx.view.all': true, 'trx.create': true, 'trx.edit': true,
    'trx.delete': true, 'trx.delete.bulk': true, 'trx.reorder': true,
    'trx.transfer': true, 'trx.category.edit': true, 'trx.csv': true,
    'excel.upload': true, 'receipt.upload': true, 'receipt.print': true,
    'bankbook.upload': true,
    'report.view.all': false, 'report.view.own': true, 'report.draft': true,
    'report.edit': true, 'report.delete': true, 'report.recall': true,
    'report.submit': true, 'report.approve.team': false, 'report.approve.center': false, 'report.reject': false,
    'settings.staff': false, 'settings.client': false, 'settings.account': false,
    'settings.fixed': true, 'settings.archive': false, 'settings.reset': false,
  },
  팀장: {
    'nav.report': true, 'nav.settings': true, 'nav.staff': true,
    'trx.view.all': true, 'trx.create': true, 'trx.edit': true,
    'trx.delete': true, 'trx.delete.bulk': true, 'trx.reorder': true,
    'trx.transfer': true, 'trx.category.edit': true, 'trx.csv': true,
    'excel.upload': true, 'receipt.upload': true, 'receipt.print': true,
    'bankbook.upload': true,
    'report.view.all': true, 'report.view.own': true, 'report.draft': true,
    'report.edit': true, 'report.delete': true, 'report.recall': true,
    'report.submit': true, 'report.approve.team': true, 'report.approve.center': false, 'report.reject': true,
    'settings.staff': true, 'settings.client': true, 'settings.account': true,
    'settings.fixed': true, 'settings.archive': false, 'settings.reset': false,
  },
  센터장: {
    'nav.report': true, 'nav.settings': true, 'nav.staff': true,
    'trx.view.all': true, 'trx.create': true, 'trx.edit': true,
    'trx.delete': true, 'trx.delete.bulk': true, 'trx.reorder': true,
    'trx.transfer': true, 'trx.category.edit': true, 'trx.csv': true,
    'excel.upload': true, 'receipt.upload': true, 'receipt.print': true,
    'bankbook.upload': true,
    'report.view.all': true, 'report.view.own': true, 'report.draft': true,
    'report.edit': true, 'report.delete': true, 'report.recall': true,
    'report.submit': true, 'report.approve.team': true, 'report.approve.center': true, 'report.reject': true,
    'settings.staff': true, 'settings.client': true, 'settings.account': true,
    'settings.fixed': true, 'settings.archive': true, 'settings.reset': false,
  },
  관리자: {
    'nav.report': true, 'nav.settings': true, 'nav.staff': true,
    'trx.view.all': true, 'trx.create': true, 'trx.edit': true,
    'trx.delete': true, 'trx.delete.bulk': true, 'trx.reorder': true,
    'trx.transfer': true, 'trx.category.edit': true, 'trx.csv': true,
    'excel.upload': true, 'receipt.upload': true, 'receipt.print': true,
    'bankbook.upload': true,
    'report.view.all': true, 'report.view.own': true, 'report.draft': true,
    'report.edit': true, 'report.delete': true, 'report.recall': true,
    'report.submit': true, 'report.approve.team': true, 'report.approve.center': true, 'report.reject': true,
    'settings.staff': true, 'settings.client': true, 'settings.account': true,
    'settings.fixed': true, 'settings.archive': true, 'settings.reset': true,
  },
};

/**
 * 앱 시작 시 한 번 호출. Firestore config/permissions 에서 권한 로드.
 * 문서 없음 또는 오류 시 DEFAULT_PERMISSIONS fallback.
 */
export async function initPermissions() {
  try {
    const { getDoc, doc } = fb();
    const snap = await getDoc(doc(fdb(), COLS.CONFIG, 'permissions'));
    if (snap.exists()) {
      const stored = snap.data();
      // DEFAULT를 기준으로 병합: Firestore에 없는 키는 DEFAULT 값 사용
      const merged = {};
      for (const role of Object.keys(DEFAULT_PERMISSIONS)) {
        merged[role] = {};
        for (const key of Object.keys(DEFAULT_PERMISSIONS[role])) {
          merged[role][key] = (stored[role] && key in stored[role])
            ? stored[role][key]
            : DEFAULT_PERMISSIONS[role][key];
        }
      }
      S.permissions = merged;
    } else {
      S.permissions = DEFAULT_PERMISSIONS;
    }
  } catch (err) {
    console.warn('권한 로드 실패, 기본값 사용:', err);
    S.permissions = DEFAULT_PERMISSIONS;
  }
}

/**
 * 현재 로그인 사용자가 해당 권한 키를 가지고 있는지 확인.
 * @param {string} key - 권한 키 (예: 'trx.edit')
 * @returns {boolean}
 */
export function can(key) {
  const role = S.user?.role;
  if (!role) return false;
  return S.permissions?.[role]?.[key] ?? DEFAULT_PERMISSIONS[role]?.[key] ?? false;
}

/**
 * 권한 설정을 Firestore에 저장하고 메모리 상태를 갱신.
 * 관리자만 호출 가능.
 * @param {Object} permissionsObj - 역할별 권한 객체
 */
export async function savePermissions(permissionsObj) {
  if (!can('settings.reset')) {
    throw new Error('권한이 없습니다');
  }
  const { setDoc, doc } = fb();
  await setDoc(doc(fdb(), COLS.CONFIG, 'permissions'), permissionsObj);
  S.permissions = permissionsObj;
}
