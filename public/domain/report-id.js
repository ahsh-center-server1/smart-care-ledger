'use strict';

export const REPORT_ID_PREFIX = 'r_';

function keyOf(clientId, year, month) {
  const cid = String(clientId || '').trim();
  const y = Number(year);
  const m = Number(month);
  if (!cid) throw new Error('reportDocId: clientId 가 비었습니다.');
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`reportDocId: 연월이 올바르지 않습니다 (${year}-${month})`);
  }
  return `${cid}\u0000${y}\u0000${m}`;
}

export async function reportDocId(clientId, year, month, cryptoApi = globalThis.crypto) {
  if (!cryptoApi || !cryptoApi.subtle) throw new Error('SHA-256을 사용할 수 없습니다.');
  const digest = await cryptoApi.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(keyOf(clientId, year, month)),
  );
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return REPORT_ID_PREFIX + encoded.slice(0, 32);
}
