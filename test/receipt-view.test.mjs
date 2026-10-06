// test/receipt-view.test.mjs
//
// 증빙 미리보기가 무엇으로 그릴지 정하는 판정.
//
// 이 판정은 한동안 openReceiptModal 안에 인라인으로 있었고, **URL 문자열로
// 종류를 추측**했다. 증빙이 경로 기반으로 바뀌면서 열람 주소가 V4 서명 URL이
// 되자 전부 빗나갔다:
//
//   · 최종 경로는 uploadId 에서 결정적으로 나오므로 **확장자가 없다**
//   · 서명 URL 호스트는 storage.googleapis.com — firebasestorage 가 아니다
//
// 그래서 이미지인데 drive·pdf·image 가 모두 false 가 되어 📄 아이콘만 떴다.
// "스토리지에는 저장됐는데 미리보기가 전혀 안 된다"가 이것이다.
//
// 이제 서버가 contentType 을 함께 내려주고, 판정은 그것만 본다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { receiptViewKind, hasReceipt } from '../public/services/receipt-access.js';

const SIGNED = 'https://storage.googleapis.com/bucket-name/receipts/c1/abc12345'
  + '?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef';

test('확장자 없는 서명 URL도 contentType 으로 이미지로 판정한다', () => {
  // 고치기 전에는 여기서 'other' 가 나와 📄 아이콘만 떴다.
  assert.equal(receiptViewKind(SIGNED, 'image/jpeg'), 'image');
  assert.equal(receiptViewKind(SIGNED, 'image/png'), 'image');
  assert.equal(receiptViewKind(SIGNED, 'image/webp'), 'image');
});

test('PDF 증빙은 contentType 으로 갈린다', () => {
  assert.equal(receiptViewKind(SIGNED, 'application/pdf'), 'pdf');
});

test('contentType 이 URL 모양을 이긴다', () => {
  // 경로에 .pdf 가 들어 있어도 실제가 이미지면 이미지다. 반대도 마찬가지.
  const looksPdf = 'https://storage.googleapis.com/b/receipts/c1/report.pdf.bin?X-Goog-Signature=x';
  assert.equal(receiptViewKind(looksPdf, 'image/jpeg'), 'image');
  const looksJpg = 'https://storage.googleapis.com/b/receipts/c1/scan.jpg?X-Goog-Signature=x';
  assert.equal(receiptViewKind(looksJpg, 'application/pdf'), 'pdf');
});

test('모르는 contentType 은 이미지인 척하지 않는다', () => {
  // 깨진 <img> 를 보여주느니 문서 아이콘이 낫다.
  assert.equal(receiptViewKind(SIGNED, 'application/octet-stream'), 'other');
});

test('구형 Drive URL은 contentType 과 무관하게 Drive 로 본다', () => {
  // Drive 는 썸네일 API 로 바꿔야 열린다 — 별도 경로다.
  const drive = 'https://drive.google.com/file/d/1AbCdEf/view';
  assert.equal(receiptViewKind(drive, ''), 'drive');
  assert.equal(receiptViewKind(drive, 'image/jpeg'), 'drive');
});

test('contentType 이 없으면 구형 데이터로 보고 URL 모양으로 되돌아간다', () => {
  // 거래에 URL 이 직접 박혀 있던 시절 데이터에는 종류 정보가 없다.
  assert.equal(
    receiptViewKind('https://firebasestorage.googleapis.com/v0/b/x/o/y?alt=media', ''),
    'image');
  assert.equal(receiptViewKind('https://example.com/a/b/scan.JPG', ''), 'image');
  assert.equal(receiptViewKind('https://example.com/a/b/doc.pdf', ''), 'pdf');
  assert.equal(receiptViewKind('https://example.com/a/b/thing', ''), 'other');
});

test('URL 이 없으면 아무것도 그리지 않는다', () => {
  assert.equal(receiptViewKind('', 'image/jpeg'), 'other');
  assert.equal(receiptViewKind(null, ''), 'other');
  assert.equal(receiptViewKind(undefined, undefined), 'other');
});

test('hasReceipt 는 경로와 구형 URL 을 모두 본다', () => {
  assert.equal(hasReceipt({ receiptPath: 'receipts/c1/a' }), true);
  assert.equal(hasReceipt({ receiptUrl: 'https://example.com/x.jpg' }), true);
  assert.equal(hasReceipt({}), false);
  assert.equal(hasReceipt(null), false);
});

// ─────────────────────────────────────────────────────────────
// 엑셀 자리에 들어온 사진
//
// 드롭 존은 input 의 accept 를 우회한다(dataTransfer.files 를 그대로 넣는다).
// 사진이 엑셀 파서로 가면 "지원하지 않는 형식이거나 헤더를 찾지 못했습니다"가
// 뜨는데, **바로 옆에 통장 사진 판독 경로가 있으므로** 사실도 아니고 무엇을
// 하라는 안내도 아니다.
// ─────────────────────────────────────────────────────────────
import { isImageFile } from '../public/modules/modals.js';

test('사진을 엑셀 파일과 구분한다', () => {
  assert.equal(isImageFile({ name: 'a.jpg', type: 'image/jpeg' }), true);
  assert.equal(isImageFile({ name: 'scan.PNG', type: 'image/png' }), true);
  assert.equal(isImageFile({ name: '거래내역.xlsx', type: '' }), false);
  assert.equal(isImageFile({ name: 'a.csv', type: 'text/csv' }), false);
  assert.equal(isImageFile(null), false);
});

test('type 이 비어 오는 HEIC 도 사진으로 본다', () => {
  // 아이폰 HEIC 는 브라우저에 따라 type 이 빈 문자열로 온다. type 만 보면
  // 사진인데 엑셀 파서로 넘어가 엉뚱한 오류가 난다.
  assert.equal(isImageFile({ name: 'IMG_1234.HEIC', type: '' }), true);
  assert.equal(isImageFile({ name: 'IMG_1234.heif', type: '' }), true);
});
