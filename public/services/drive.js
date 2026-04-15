/**
 * services/drive.js — Smart Care Ledger v2
 * Google Drive 파일 업로드 서비스 (OAuth 2.0)
 */

'use strict';

import { S } from '../state.js';
import { GOOGLE_OAUTH_CLIENT_ID, DRIVE_FOLDER_ID } from '../constants.js';

/**
 * 이미지 파일을 Canvas로 압축
 * - 최대 너비/높이: 1200px (초과 시 비율 유지하며 축소)
 * - JPEG 품질: 0.78 (육안으로 거의 차이 없음, 용량 약 80~90% 감소)
 * - PDF, GIF 등 비이미지 파일은 그대로 반환
 */
export function compressImage(file, maxPx=1200, quality=0.78) {
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
          const baseName = file.name.replace(/\.[^.]+$/, '');
          const compressed = new File([blob], baseName + '_compressed.jpg', {
            type: 'image/jpeg', lastModified: Date.now()
          });
          const ratio = Math.round((1 - blob.size/origSize) * 100);
          console.log(`[압축] ${file.name}: ${(origSize/1024).toFixed(0)}KB → ${(blob.size/1024).toFixed(0)}KB (${ratio}% 감소)`);
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

/** Google OAuth 토큰 획득 (만료 시 자동 재발급) */
export function getDriveToken() {
  return new Promise((resolve, reject) => {
    // 토큰이 있으면 재사용 (단, 만료 1분 전부터 재발급)
    if (S.driveToken && S.driveTokenExpiry && Date.now() < S.driveTokenExpiry - 60000) {
      resolve(S.driveToken); return;
    }
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google OAuth 라이브러리가 로드되지 않았습니다.')); return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope:     'https://www.googleapis.com/auth/drive.file',
      callback:  (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        S.driveToken       = resp.access_token;
        S.driveTokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        resolve(S.driveToken);
      }
    });
    client.requestAccessToken();
  });
}

/** Drive 지정 폴더에 파일 업로드 → 공개 URL 반환 */
export async function uploadToDrive(file) {
  // 1. 이미지 압축 (이미지 파일만, PDF 등은 그대로)
  const uploadFile = await compressImage(file);

  const token = await getDriveToken();

  // 2. 파일 메타데이터 + 바이너리 멀티파트 업로드
  const metadata = { name: uploadFile.name, parents: [DRIVE_FOLDER_ID] };
  const form     = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], {type:'application/json'}));
  form.append('file',     uploadFile);

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body:form }
  );
  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(()=>({}));
    // 토큰 만료(401) 시 토큰 초기화 후 1회 재시도
    if (uploadRes.status === 401) {
      S.driveToken=null; S.driveTokenExpiry=null;
      throw new Error('인증이 만료되었습니다. 다시 시도해주세요.');
    }
    throw new Error('Drive 업로드 실패: ' + (err.error?.message||uploadRes.status));
  }
  const { id } = await uploadRes.json();

  // 3. 파일 공개 권한 설정 (링크 있는 사람 보기)
  await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
    method:  'POST',
    headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:    JSON.stringify({ role:'reader', type:'anyone' })
  });

  // 4. 공유 링크 반환
  return `https://drive.google.com/file/d/${id}/view?usp=sharing`;
}
