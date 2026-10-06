'use strict';

import { fb, fdb } from './firestore.js';
import { COLS } from '../constants.js';
import { matchReceipt, DATE_TOLERANCE_DAYS } from '../domain/receipt-match.js';

let aiAvailability = null;

export async function getAiAvailability() {
  if (aiAvailability) return aiAvailability;
  try {
    const res = await window._fbFn.call('getAiStatus')({});
    aiAvailability = (res && res.data && res.data.configured)
      ? { state: 'ready', message: '' }
      : { state: 'missing', message: 'AI 공급자 설정이 필요합니다.' };
  } catch (error) {
    aiAvailability = {
      state: 'error',
      message: 'AI 상태를 확인하지 못했습니다. Functions 배포와 연결 상태를 확인하세요.',
    };
  }
  return aiAvailability;
}

function shiftedDate(date, days) {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) return '';
  return new Date(time + days * 86400000).toISOString().slice(0, 10);
}

async function candidates(clientId, date, fallback) {
  const start = shiftedDate(date, -DATE_TOLERANCE_DAYS);
  const end = shiftedDate(date, DATE_TOLERANCE_DAYS);
  if (!start || !end) return (fallback || []).filter(t => t.clientId === clientId);
  const { collection, query, where, getDocs } = fb();
  const snap = await getDocs(query(
    collection(fdb(), COLS.TRANSACTIONS),
    where('clientId', '==', clientId),
    where('date', '>=', start),
    where('date', '<=', end),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function rematchReceiptRow(row, fallbackTransactions, noiseWords) {
  const list = await candidates(row.clientId, row.draft && row.draft.date, fallbackTransactions);
  const match = matchReceipt(row.draft, list, { noiseWords });
  row.matches = match.matches;
  row.decision = match.decision;
  row.target = match.decision === 'auto' ? match.autoMatch.trx.id
    : match.decision === 'choose' ? ''
    : 'new';
  row.saveError = '';
}

export function friendlyReceiptError(error) {
  return String((error && error.message) || error || '')
    || '판독에 실패했습니다. 직접 입력할 수 있습니다.';
}
