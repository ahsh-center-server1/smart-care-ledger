/**
 * services/image.js — Smart Care Ledger v2
 * 이미지 압축 유틸리티 (업로드 전 리사이즈/JPEG 압축)
 */

'use strict';

// ─────────────────────────────────────────────
// HEIC/HEIF → JPEG 변환
//  브라우저(크롬/엣지 등)는 HEIC를 canvas로 디코딩하지 못해 원본이 그대로
//  저장된다. heic2any(libheif WASM)를 "HEIC 업로드 시에만" 지연 로드해 JPEG로
//  변환한 뒤 일반 압축 경로를 태운다. 로드/변환 실패 시 원본을 그대로 사용(무해).
// ─────────────────────────────────────────────
const HEIC2ANY_SRC = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
let _heic2anyPromise = null;
function loadHeic2any() {
  if (_heic2anyPromise) return _heic2anyPromise;
  _heic2anyPromise = new Promise((resolve, reject) => {
    if (window.heic2any) { resolve(window.heic2any); return; }
    const s = document.createElement('script');
    s.src = HEIC2ANY_SRC; s.async = true;
    s.onload = () => window.heic2any ? resolve(window.heic2any) : reject(new Error('heic2any 미로드'));
    s.onerror = () => { _heic2anyPromise = null; reject(new Error('heic2any 스크립트 로드 실패')); };
    document.head.appendChild(s);
  });
  return _heic2anyPromise;
}

/** HEIC/HEIF면 JPEG로 변환해 반환, 그 외에는 원본 그대로 반환 */
export async function heicToJpeg(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const isHeic = type.includes('heic') || type.includes('heif') || /\.(heic|heif)$/.test(name);
  if (!isHeic) return file;
  try {
    const heic2any = await loadHeic2any();
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
    const blob = Array.isArray(out) ? out[0] : out;
    if (!blob || !blob.size) return file;
    const base = (file.name || 'image').replace(/\.[^.]+$/, '');
    console.log(`[HEIC 변환] ${file.name || 'image'} → ${base}.jpg (${(blob.size/1024).toFixed(0)}KB)`);
    return new File([blob], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  } catch (e) {
    console.warn('HEIC 변환 실패, 원본 사용:', e.message);
    return file;
  }
}

/**
 * 이미지 파일을 Canvas로 압축
 * - HEIC/HEIF는 먼저 JPEG로 변환 (브라우저가 직접 디코딩하지 못함)
 * - 최대 너비/높이: 1200px (초과 시 비율 유지하며 축소)
 * - JPEG 품질: 0.78 (육안으로 거의 차이 없음, 용량 약 80~90% 감소)
 * - PDF, GIF 등 비이미지 파일은 그대로 반환
 */
export async function compressImage(file, maxPx=1200, quality=0.78) {
  // HEIC/HEIF → JPEG 선변환 (변환 실패 시 원본 유지)
  file = await heicToJpeg(file);
  return new Promise((resolve) => {
    // 이미지가 아니거나 GIF면 압축 없이 그대로 반환
    if (!file.type.startsWith('image/') || file.type === 'image/gif') {
      resolve(file); return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        // 원본 크기 확인
        let w = img.naturalWidth, h = img.naturalHeight;
        const origSize = file.size;

        // 최대 크기 초과 시 비율 유지하며 축소
        if (w > maxPx || h > maxPx) {
          if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else        { w = Math.round(w * maxPx / h); h = maxPx; }
        }

        // Canvas에 그려서 압축
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        // 흰 배경 (PNG 투명도 → JPEG 변환 시 검게 되는 문제 방지)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(blob => {
          if (!blob) { resolve(file); return; }
          // 압축 후가 더 크면 원본 반환 (매우 작은 파일의 경우)
          if (blob.size >= origSize) { resolve(file); return; }
          // 압축된 Blob을 File 객체로 변환 (확장자는 jpg로 통일)
          // Blob 입력(재압축 등 file.name 없음)도 안전하게 처리
          const srcName = file.name || 'image.jpg';
          const baseName = srcName.replace(/\.[^.]+$/, '');
          const compressed = new File([blob], baseName + '_compressed.jpg', {
            type: 'image/jpeg', lastModified: Date.now()
          });
          const ratio = Math.round((1 - blob.size/origSize) * 100);
          console.log(`[압축] ${srcName}: ${(origSize/1024).toFixed(0)}KB → ${(blob.size/1024).toFixed(0)}KB (${ratio}% 감소)`);
          resolve(compressed);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file); // 이미지 로드 실패 시 원본 반환
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}
