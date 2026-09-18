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
    console.debug(`[HEIC 변환] ${file.name || 'image'} → ${base}.jpg (${(blob.size/1024).toFixed(0)}KB)`);
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
          console.debug(`[압축] ${srcName}: ${(origSize/1024).toFixed(0)}KB → ${(blob.size/1024).toFixed(0)}KB (${ratio}% 감소)`);
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

// ─────────────────────────────────────────────
// 판독용 사진 — 보관용과 **다른 사진**이다
// ─────────────────────────────────────────────
//
// 왜 따로 만드는가
//   업로드 압축은 1200px · JPEG 0.78 이고, 그것은 **보관과 다운로드 대역폭**을
//   위한 값이다. 영수증처럼 글자가 큰 사진은 그 크기로도 읽힌다.
//
//   통장 거래내역은 다르다. 한 장에 스무 줄이 넘고 글자가 작으며 줄 사이 괘선이
//   흐리다. 휴대폰 사진 4000px 를 1200px 로 줄이면 한 줄 글자 높이가 40px 에서
//   12px 가 되고, 거기에 0.78 JPEG 가 숫자를 뭉갠다. **글씨가 큰 은행은 읽히고
//   빽빽한 은행은 안 읽히는** 이유가 이것이다 — 파서에 없는 은행이라서가 아니다
//   (사진 경로는 BANK_CONFIGS 를 아예 쓰지 않는다).
//
//   그래서 모델에게는 큰 쪽을 보내고, 통장 사진으로 보관하는 것은 지금처럼
//   작은 쪽을 쓴다. 보관본은 나중에 사람이 눈으로 확인하는 용도라 1200px 로 족하다.
//
// 왜 단계로 내려가는가
//   서버가 받는 크기에 상한이 있다(5MB). 한 번에 큰 값으로 만들면 큰 원본에서
//   그 상한을 넘고, 그러면 **판독 자체가 거부된다** — 작게 보내서 못 읽는 것보다
//   나쁘다. 그래서 큰 쪽부터 만들어 보고 들어가는 첫 번째를 쓴다.

/** 서버(functions/ai/receipt-extract.js)의 MAX_IMAGE_BYTES 보다 조금 낮게 잡는다. */
export const READ_MAX_BYTES = 5 * 1024 * 1024 - 192 * 1024;

/** 큰 쪽부터. 마지막은 기존 업로드 압축과 같은 값이다(그 이하로는 내려가지 않는다). */
const READ_STEPS = [[2400, 0.92], [2000, 0.88], [1600, 0.84], [1200, 0.78]];

/**
 * 판독에 보낼 사진을 만든다. 상한에 들어가는 **가장 큰** 것을 고른다.
 *
 * @param {File|Blob} file  이미 heicToJpeg 를 지난 것
 * @param {number} [limit]
 */
export async function compressForReading(file, limit = READ_MAX_BYTES) {
  let last = file;
  for (const [px, q] of READ_STEPS) {
    // compressImage 는 압축이 원본보다 커지면 원본을 그대로 돌려준다 —
    // 작은 사진에서는 첫 단계가 곧 원본이고, 그것이 가장 좋은 화질이다.
    last = await compressImage(file, px, q);
    if (approxBase64Bytes(last.size) <= limit) return last;
  }
  // 마지막 단계로도 넘치면 그대로 보낸다. 여기서 몰래 더 줄이면 "왜 안 읽히지"가
  // 되고, 서버는 "사진이 너무 큽니다"라고 정확히 말해 준다.
  return last;
}

/** base64 는 원본의 약 4/3 이다. 서버가 그 값으로 상한을 본다. */
export function approxBase64Bytes(bytes) {
  return Math.ceil(Number(bytes || 0) * 4 / 3);
}

/** 파일을 base64 본문으로. 앞의 `data:...;base64,` 는 떼고 준다. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('사진을 읽을 수 없습니다.'));
    fr.onload = () => {
      const t = String(fr.result || '');
      const i = t.indexOf(',');
      resolve(i >= 0 ? t.slice(i + 1) : t);
    };
    fr.readAsDataURL(file);
  });
}
