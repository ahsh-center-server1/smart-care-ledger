#!/usr/bin/env node
/**
 * PWA 아이콘 생성기 (의존성 없음 · 순수 Node)
 *
 * 외부 이미지 라이브러리(ImageMagick/sharp/canvas)가 없는 환경에서
 * Node 내장 zlib 만으로 RGBA PNG 를 직접 인코딩한다.
 *
 * 디자인: 네이비 배경 + 그린 라운드 타일 + 흰색 ₩(원화) 기호
 *   - 일반 아이콘(regular)  : 모서리 둥근 배경 (투명 코너)
 *   - 마스커블(fullbleed)   : 정사각형 풀블리드 (안전영역 안에 엠블럼)
 *
 * 출력: public/icons/*.png
 *
 * 실행: node tools/generate-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

// ── PNG 인코더 ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(cv) {
  const { w, h, data } = cv;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    const row = y * stride;
    for (let x = 0; x < stride; x++) raw[p++] = data[row + x];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── 캔버스 / 드로잉 ───────────────────────────────────────
const canvas = (w, h) => ({ w, h, data: new Uint8ClampedArray(w * h * 4) });
const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
function setOpaque(cv, x, y, c) {
  const i = (y * cv.w + x) * 4;
  cv.data[i] = c[0];
  cv.data[i + 1] = c[1];
  cv.data[i + 2] = c[2];
  cv.data[i + 3] = 255;
}
function inRoundRect(px, py, x0, y0, rw, rh, rad) {
  const x1 = x0 + rw, y1 = y0 + rh;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + rad), x1 - rad);
  const cy = Math.min(Math.max(py, y0 + rad), y1 - rad);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= rad * rad;
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// ── 팔레트 ────────────────────────────────────────────────
const NAV_TOP = [35, 48, 71];    // #233047
const NAV_BOT = [14, 22, 38];    // #0e1626
const GRN_TOP = [52, 211, 153];  // #34d399
const GRN_BOT = [5, 150, 105];   // #059669
const WHITE   = [255, 255, 255];

// ── 한 장 렌더 (슈퍼샘플 후 다운샘플 → 안티앨리어싱) ───────
function render(size, mode) {
  const SS = 4;
  const S = size * SS;
  const hi = canvas(S, S);
  const rounded = mode === 'regular';
  const bgRad = 0.225 * S;

  // 배경
  for (let y = 0; y < S; y++) {
    const col = lerp(NAV_TOP, NAV_BOT, y / S);
    for (let x = 0; x < S; x++) {
      if (rounded && !inRoundRect(x, y, 0, 0, S, S, bgRad)) continue;
      setOpaque(hi, x, y, col);
    }
  }

  // 그린 라운드 타일
  const tile = rounded ? 0.62 : 0.56;
  const tw = tile * S, th = tile * S;
  const tx = (S - tw) / 2, ty = (S - th) / 2;
  const tRad = 0.27 * tw;
  for (let y = Math.floor(ty); y < ty + th; y++) {
    const col = lerp(GRN_TOP, GRN_BOT, (y - ty) / th);
    for (let x = Math.floor(tx); x < tx + tw; x++) {
      if (inRoundRect(x, y, tx, ty, tw, th, tRad)) setOpaque(hi, x, y, col);
    }
  }

  // 흰색 ₩ (원화) 엠블럼
  const em = tw * 0.60;
  const bx = (S - em) / 2, by = (S - em) / 2;
  const M = (u, v) => [bx + u * em, by + v * em];
  const A = M(0.06, 0.12), B = M(0.30, 0.88), C = M(0.50, 0.40), D = M(0.70, 0.88), E = M(0.94, 0.12);
  const segs = [[A, B], [B, C], [C, D], [D, E]];
  const rDia = 0.115 * em / 2;
  // 가로 막대 2개 (원화 기호의 두 선)
  const barL = M(0.02, 0), barR = M(0.98, 0);
  const bars = [0.42, 0.58].map((v) => {
    const yy = by + v * em;
    return [[barL[0], yy], [barR[0], yy]];
  });
  const rBar = 0.115 * em / 2;

  const minX = Math.floor(bx - em * 0.05), maxX = Math.ceil(bx + em * 1.05);
  const minY = Math.floor(by - em * 0.05), maxY = Math.ceil(by + em * 1.05);
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      let hit = false;
      for (const [s, e] of segs) {
        if (distSeg(x, y, s[0], s[1], e[0], e[1]) <= rDia) { hit = true; break; }
      }
      if (!hit) {
        for (const [s, e] of bars) {
          if (distSeg(x, y, s[0], s[1], e[0], e[1]) <= rBar) { hit = true; break; }
        }
      }
      if (hit) setOpaque(hi, x, y, WHITE);
    }
  }

  // 다운샘플 (박스 평균)
  const out = canvas(size, size);
  const n = SS * SS;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((oy * SS + sy) * S + (ox * SS + sx)) * 4;
          const al = hi.data[i + 3];
          r += hi.data[i] * al;
          g += hi.data[i + 1] * al;
          b += hi.data[i + 2] * al;
          a += al;
        }
      }
      const oi = (oy * size + ox) * 4;
      out.data[oi]     = a ? r / a : 0;
      out.data[oi + 1] = a ? g / a : 0;
      out.data[oi + 2] = a ? b / a : 0;
      out.data[oi + 3] = a / n;
    }
  }
  return out;
}

// ── 출력 ──────────────────────────────────────────────────
const outDir = path.resolve('public/icons');
fs.mkdirSync(outDir, { recursive: true });
const jobs = [
  ['icon-192.png', 192, 'regular'],
  ['icon-512.png', 512, 'regular'],
  ['icon-maskable-192.png', 192, 'fullbleed'],
  ['icon-maskable-512.png', 512, 'fullbleed'],
  ['apple-touch-icon.png', 180, 'fullbleed'],
  ['favicon-32.png', 32, 'regular'],
  ['favicon-16.png', 16, 'regular'],
];
for (const [name, size, mode] of jobs) {
  const png = encodePNG(render(size, mode));
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`✓ ${name} (${size}×${size}, ${mode}) — ${png.length} bytes`);
}
console.log('done.');
