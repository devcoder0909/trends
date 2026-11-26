/**
 * Zero-dependency Open Graph 1200x630 PNG card generator & SVG favicon.
 * Uses native Web Streams CompressionStream('deflate') with a compact 5x7 font.
 */

import { FAVICON_SVG } from './logo.js';
export { FAVICON_SVG };

const FONT_5X7 = {
  ' ': [0, 0, 0, 0, 0],
  '!': [0, 0, 95, 0, 0],
  '$': [36, 42, 127, 42, 18],
  '%': [35, 19, 8, 100, 98],
  '&': [54, 73, 85, 34, 80],
  "'": [0, 0, 7, 0, 0],
  '(': [0, 28, 34, 65, 0],
  ')': [0, 65, 34, 28, 0],
  '+': [8, 8, 62, 8, 8],
  ',': [0, 80, 48, 0, 0],
  '-': [8, 8, 8, 8, 8],
  '.': [0, 96, 96, 0, 0],
  '/': [32, 16, 8, 4, 2],
  ':': [0, 54, 54, 0, 0],
  '?': [2, 1, 81, 9, 6],
  '0': [62, 81, 73, 69, 62],
  '1': [0, 66, 127, 64, 0],
  '2': [66, 97, 81, 73, 70],
  '3': [33, 65, 69, 75, 49],
  '4': [24, 20, 18, 127, 16],
  '5': [39, 69, 69, 69, 57],
  '6': [60, 74, 73, 73, 48],
  '7': [1, 113, 9, 5, 3],
  '8': [54, 73, 73, 73, 54],
  '9': [6, 73, 73, 41, 30],
  'A': [126, 17, 17, 17, 126],
  'B': [127, 73, 73, 73, 54],
  'C': [62, 65, 65, 65, 34],
  'D': [127, 65, 65, 34, 28],
  'E': [127, 73, 73, 73, 65],
  'F': [127, 9, 9, 9, 1],
  'G': [62, 65, 73, 73, 122],
  'H': [127, 8, 8, 8, 127],
  'I': [0, 65, 127, 65, 0],
  'J': [32, 64, 65, 63, 1],
  'K': [127, 8, 20, 34, 65],
  'L': [127, 64, 64, 64, 64],
  'M': [127, 2, 12, 2, 127],
  'N': [127, 4, 8, 16, 127],
  'O': [62, 65, 65, 65, 62],
  'P': [127, 9, 9, 9, 6],
  'Q': [62, 65, 81, 33, 94],
  'R': [127, 9, 25, 41, 70],
  'S': [70, 73, 73, 73, 49],
  'T': [1, 1, 127, 1, 1],
  'U': [63, 64, 64, 64, 63],
  'V': [31, 32, 64, 32, 31],
  'W': [63, 64, 56, 64, 63],
  'X': [99, 20, 8, 20, 99],
  'Y': [7, 8, 112, 8, 7],
  'Z': [97, 81, 73, 69, 67],
};

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflateZlib(raw) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const res = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(res);
}

function wrapLines(text, maxChars = 22, maxLines = 3) {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z0-9 .,'-:!&/$%?+()]/g, ' ');
  const words = clean.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      if (lines.length >= maxLines) break;
      cur = w.slice(0, maxChars);
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.length ? lines : ['TRENDING NOW'];
}

export async function generateOgPng({
  title = 'Live Factual Trend Briefings',
  category = 'Top Stories',
  siteName = 'Trending Now',
  host = 'trendingrightnow.online',
} = {}) {
  const W = 1200;
  const H = 630;
  const rowBytes = 1 + (W >> 1);
  const raw = new Uint8Array(rowBytes * H);

  const setPx = (x, y, c) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = y * rowBytes + 1 + (x >> 1);
    raw[idx] = (x & 1) ? ((raw[idx] & 0xf0) | c) : ((raw[idx] & 0x0f) | (c << 4));
  };

  const fillRect = (x0, y0, w, h, c) => {
    const x1 = Math.min(W, x0 + w);
    const y1 = Math.min(H, y0 + h);
    for (let y = Math.max(0, y0); y < y1; y++) {
      for (let x = Math.max(0, x0); x < x1; x++) setPx(x, y, c);
    }
  };

  const drawText = (str, x0, y0, scale, c) => {
    let x = x0;
    for (const ch of String(str).toUpperCase()) {
      const glyph = FONT_5X7[ch] || FONT_5X7[' '];
      for (let col = 0; col < 5; col++) {
        const bits = glyph[col];
        if (!bits) continue;
        for (let row = 0; row < 7; row++) {
          if (bits & (1 << row)) fillRect(x + col * scale, y0 + row * scale, scale, scale, c);
        }
      }
      x += 6 * scale;
    }
  };

  // Palette: 0:#202124 bg, 1:#292a2d card, 2:#3c4043 border, 3:#8ab4f8 blue, 4:#5bb974 green, 5:#e8eaed text, 6:#9aa0a6 muted, 7:#202124 dark-on-blue, 8:#02b890 teal, 9:#01585c deep teal, 10:#3be06d lime
  const palette = new Uint8Array([
    0x20, 0x21, 0x24,
    0x29, 0x2a, 0x2d,
    0x3c, 0x40, 0x43,
    0x8a, 0xb4, 0xf8,
    0x5b, 0xb9, 0x74,
    0xe8, 0xea, 0xed,
    0x9a, 0xa0, 0xa6,
    0x20, 0x21, 0x24,
    0x02, 0xb8, 0x90,
    0x01, 0x58, 0x5c,
    0x3b, 0xe0, 0x6d,
  ]);

  const fillPoly = (pts, c) => {
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    for (let y = minY; y <= maxY; y++) {
      const ix = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [x1, y1] = pts[j], [x2, y2] = pts[i];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) ix.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
      ix.sort((a, b) => a - b);
      for (let k = 0; k + 1 < ix.length; k += 2) {
        const a = Math.max(0, Math.ceil(ix[k])), b = Math.min(W - 1, Math.floor(ix[k + 1]));
        for (let x = a; x <= b; x++) setPx(x, y, c);
      }
    }
  };

  fillRect(58, 58, 1084, 514, 2);
  fillRect(60, 60, 1080, 510, 1);
  fillRect(60, 60, 1080, 8, 3);

  // Render geometric brand mark (chevron + 3D prism facets) scaled to 42px at (106, 113)
  const lp = (x, y) => [106 + x * 0.42, 113 + y * 0.42];
  fillPoly([lp(4, 51), lp(82, 10), lp(95, 22), lp(80, 76), lp(74, 80), lp(68, 65), lp(79, 28), lp(7, 54)], 10);
  fillPoly([lp(61, 45), lp(43, 86), lp(74, 80), lp(69, 65)], 8);
  fillPoly([lp(60, 45), lp(17, 90), lp(43, 86)], 9);
  drawText(siteName.slice(0, 22), 160, 121, 4, 5);

  const badge = String(category || 'News').toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 18) || 'NEWS';
  fillRect(110, 192, badge.length * 18 + 36, 42, 3);
  drawText(badge, 128, 203, 3, 7);

  const lines = wrapLines(title, 22, 3);
  lines.forEach((line, i) => drawText(line, 110, 276 + i * 72, 7, 5));

  drawText(`${host} - VERIFIED MULTI-SOURCE BRIEFING`, 110, 516, 3, 6);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 4;
  ihdr[9] = 3;

  const idat = await deflateZlib(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', palette),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ];

  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(totalLen);
  let off = 0;
  for (const part of chunks) {
    png.set(part, off);
    off += part.length;
  }
  return png;
}
