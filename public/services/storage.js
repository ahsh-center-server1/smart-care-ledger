/**
 * services/storage.js — Smart Care Ledger v2
 * Firebase Storage 파일 업로드 서비스
 */

'use strict';

import { compressImage } from './drive.js';

/** Firebase Storage에 파일 업로드 → 공개 다운로드 URL 반환 */
export async function uploadToStorage(file, path) {
  const uploadFile = await compressImage(file);
  const { storage, ref, uploadBytes, getDownloadURL } = window._fb;
  const storageRef = ref(storage, path);
  const snapshot = await uploadBytes(storageRef, uploadFile);
  return await getDownloadURL(snapshot.ref);
}

/**
 * URL 유형에 따라 표시용 이미지 URL 반환
 * - Drive URL (구형 데이터): Drive 썸네일 API로 변환
 * - Firebase Storage URL: 그대로 반환
 */
export function getImageUrl(url, sz = 'w800') {
  if (!url) return '';
  const m = url.match(/\/file\/d\/([^/]+)\//);
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=${sz}`;
  return url;
}
