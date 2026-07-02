/**
 * services/storage.js — Smart Care Ledger v2
 * Firebase Storage 파일 업로드/삭제/재압축 서비스
 *
 * 용량 관리 정책 (Firebase 무료 한도 대응):
 *  - 업로드 전 이미지 압축(1200px/JPEG 0.78) + 크기 상한 검증
 *  - 삭제 시 Storage 객체도 함께 삭제(고아 파일 방지)
 *  - 연도 마감 시 아카이브용 저해상도 재압축으로 공간 확보
 *  - 목록/갤러리용 소형 썸네일 동시 생성(다운로드 대역폭 절감)
 */

'use strict';

import { compressImage, heicToJpeg } from './image.js';

const MB = 1024 * 1024;

/** Firebase Storage 다운로드 URL 여부 (Drive/기타 URL 제외) */
export function isStorageUrl(url) {
  return typeof url === 'string' && /firebasestorage/.test(url);
}

/**
 * 업로드 전 파일 크기 상한 검증 (초과 시 예외)
 *  - 이미지/HEIC(업로드 시 JPEG로 변환·압축): 15MB
 *  - 기타(PDF 등, 비압축): 8MB
 */
export function validateUploadSize(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const isHeic = type.includes('heic') || type.includes('heif') || /\.(heic|heif)$/.test(name);
  const isImg = type.startsWith('image/') || isHeic; // HEIC도 JPEG로 변환되므로 이미지로 취급
  const cap = isImg ? 15 * MB : 8 * MB;
  const label = isImg ? '이미지' : '파일';
  if (file.size > cap) {
    throw new Error(`${label} 용량이 너무 큽니다 (${(file.size / MB).toFixed(1)}MB). 최대 ${Math.round(cap / MB)}MB까지 업로드할 수 있습니다.`);
  }
}

/** 소형 썸네일 Blob 생성 (이미지가 아니거나 축소 실패 시 null) */
export async function makeThumbnail(file, maxPx = 320, quality = 0.55) {
  const thumb = await compressImage(file, maxPx, quality);
  return (thumb && thumb !== file) ? thumb : null;
}

/** Firebase Storage에 파일 업로드 → 공개 다운로드 URL 반환 */
export async function uploadToStorage(file, path) {
  validateUploadSize(file);
  const uploadFile = await compressImage(file);
  const { storage, ref, uploadBytes, getDownloadURL } = window._fb;
  const storageRef = ref(storage, path);
  const snapshot = await uploadBytes(storageRef, uploadFile);
  return await getDownloadURL(snapshot.ref);
}

/**
 * 이미지 업로드 + 목록용 썸네일 동시 생성
 * @returns {{url:string, thumbUrl:string}}
 */
export async function uploadImageWithThumb(file, path) {
  validateUploadSize(file);
  file = await heicToJpeg(file); // HEIC는 1회만 변환 후 원본/썸네일에 공용
  const { storage, ref, uploadBytes, getDownloadURL } = window._fb;
  const main = await compressImage(file);
  const mainRef = ref(storage, path);
  await uploadBytes(mainRef, main);
  const url = await getDownloadURL(mainRef);
  let thumbUrl = '';
  try {
    const thumb = await makeThumbnail(file);
    if (thumb) {
      const thumbRef = ref(storage, path + '.thumb.jpg');
      await uploadBytes(thumbRef, thumb);
      thumbUrl = await getDownloadURL(thumbRef);
    }
  } catch (e) { console.warn('썸네일 생성 건너뜀:', e.message); }
  return { url, thumbUrl };
}

/**
 * 엑셀 원본 파일 업로드 (원본 보관 + 저장 용량 절감)
 * - gzip 지원 시 압축해 저장(저장 용량 감소), contentEncoding으로 다운로드 시 원본 복원
 * - 압축이 이득이 없거나 미지원 브라우저면 원본 그대로 업로드
 * @returns {Promise<string>} 다운로드 URL
 */
export async function uploadExcelOriginal(file, path) {
  validateUploadSize(file);
  const { storage, ref, uploadBytes, getDownloadURL } = window._fb;
  const contentType = file.type || 'application/octet-stream';
  let data = file;
  let metadata = { contentType };
  try {
    if (typeof CompressionStream !== 'undefined' && file.stream) {
      const gz = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      if (gz.size > 0 && gz.size < file.size) {
        data = gz;
        // contentEncoding: 다운로드 시 브라우저가 자동 해제 → 원본 그대로 복원
        metadata = {
          contentType,
          contentEncoding: 'gzip',
          contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name || 'excel')}`
        };
      }
    }
  } catch (e) { console.warn('엑셀 gzip 압축 건너뜀(원본 저장):', e.message); data = file; metadata = { contentType }; }
  const objRef = ref(storage, path);
  await uploadBytes(objRef, data, metadata);
  return await getDownloadURL(objRef);
}

/**
 * Storage 객체 삭제 (best-effort)
 * - Firebase Storage URL이 아니면(구형 Drive URL/빈 값) 무시
 * - 이미 없는 객체 등 오류는 조용히 무시
 */
export async function deleteFromStorage(url) {
  if (!isStorageUrl(url)) return;
  try {
    const { storage, ref, deleteObject } = window._fb;
    await deleteObject(ref(storage, url));
  } catch (e) {
    if (e?.code !== 'storage/object-not-found') console.warn('Storage 삭제 건너뜀:', e.message);
  }
}

/** URL 배열을 한 번에 삭제 (썸네일 등 포함, best-effort) */
export async function deleteManyFromStorage(urls) {
  const targets = (urls || []).filter(isStorageUrl);
  await Promise.allSettled(targets.map(u => deleteFromStorage(u)));
}

/**
 * 저장된 이미지를 저해상도로 재압축하여 같은 경로에 덮어쓴다 (아카이브용, best-effort)
 * - Firebase Storage 이미지가 아니거나, 재압축 효과가 없으면 null 반환(원본 유지)
 * - 재압축을 위해 브라우저에서 이미지를 다시 읽으므로 버킷 CORS 설정 필요(cors.json)
 * @returns {Promise<string|null>} 새 다운로드 URL 또는 null
 */
export async function recompressStorageImage(url, maxPx = 900, quality = 0.6) {
  if (!isStorageUrl(url)) return null;
  try {
    const { storage, ref, uploadBytes, getDownloadURL } = window._fb;
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null; // PDF 등은 대상 아님
    const recompressed = await compressImage(blob, maxPx, quality);
    if (recompressed === blob || recompressed.size >= blob.size) return null; // 효과 없음
    const objRef = ref(storage, url);          // 기존 객체 참조
    await uploadBytes(objRef, recompressed);   // 동일 경로 덮어쓰기
    return await getDownloadURL(objRef);       // 새 토큰이 포함된 URL
  } catch (e) {
    console.warn('아카이브 재압축 건너뜀:', e.message);
    return null;
  }
}

/**
 * URL 유형에 따라 표시용 이미지 URL 반환
 * - Drive URL (구형 데이터): Drive 썸네일 API로 변환
 * - Firebase Storage URL: 그대로 반환 (썸네일은 호출부에서 thumbUrl 전달)
 */
export function getImageUrl(url, sz = 'w800') {
  if (!url) return '';
  const m = url.match(/\/file\/d\/([^/]+)\//);
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=${sz}`;
  return url;
}
