// Generates the PWA raster assets. iOS will not take an SVG for a home-screen
// icon and needs its splash screens as real bitmaps at exact device sizes, so
// they are drawn here rather than hand-made: no binary blobs in the repo, and
// changing the mark means changing eight lines.
//
//   node social/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../site/icons');
mkdirSync(OUT, { recursive: true });

const INK = [0x12, 0x10, 0x0b];   // --paper in dark mode; the app's own black
const EMBER = [0xe8, 0x64, 0x1b]; // --ember
const BRASS = [0xc9, 0xb5, 0x93]; // --brass, the insignia's tan
const PAPER = [0xf5, 0xed, 0xd8];

// ── minimal PNG writer (RGB, no alpha, filter 0) ──────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the mark: the winged insignia ─────────────────────────────────────────
// Same geometry as the .brandmark SVG in template.html, in a 240-unit box, so
// the tab icon and the wordmark are one drawing. Rendered at 3x and boxed down
// because a diagonal at 32px is nothing but its antialiasing.
const SS = 3;

/** Even-odd scanline fill of a polygon given as [x, y, x, y, …] in 240-space. */
function poly(px, w, h, unit, ox, oy, pts, col) {
  const X = (i) => pts[i * 2] * unit + ox, Y = (i) => pts[i * 2 + 1] * unit + oy;
  const n = pts.length / 2;
  let y0 = h, y1 = 0;
  for (let i = 0; i < n; i++) { y0 = Math.min(y0, Y(i)); y1 = Math.max(y1, Y(i)); }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ay = Y(i), by = Y(j);
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(X(i) + ((yc - ay) / (by - ay)) * (X(j) - X(i)));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) {
        const i = (y * w + x) * 3;
        px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2];
      }
    }
  }
}

/** Filled ring (annulus) — the badge's outer circle. */
function ring(px, w, h, unit, ox, oy, cx, cy, r, sw, col) {
  const RO = (r + sw / 2) * unit, RI = (r - sw / 2) * unit;
  const CX = cx * unit + ox, CY = cy * unit + oy;
  for (let y = Math.max(0, Math.floor(CY - RO)); y <= Math.min(h - 1, Math.ceil(CY + RO)); y++) {
    for (let x = Math.max(0, Math.floor(CX - RO)); x <= Math.min(w - 1, Math.ceil(CX + RO)); x++) {
      const d = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
      if (d <= RO && d >= RI) { const i = (y * w + x) * 3; px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; }
    }
  }
}

/** A diamond of the given half-extent, as a polygon. */
const dia = (k) => [120, 120 - 64 * k, 120 + 72 * k, 120, 120, 120 + 64 * k, 120 - 72 * k, 120];

function drawMark(w, h, { scale = 1, bg = INK } = {}) {
  const W = w * SS, H = h * SS;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2]; }
  const unit = (Math.min(W, H) * scale) / 240;
  const ox = (W - 240 * unit) / 2, oy = (H - 240 * unit) / 2;
  const fill = (pts, col) => poly(px, W, H, unit, ox, oy, pts, col);
  const small = Math.min(w, h) < 64; // wings become mush below this

  ring(px, W, H, unit, ox, oy, 120, 120, 76, 9, BRASS);
  if (!small) {
    // wings, with the black separation the badge draws between feathers
    [[158, 96, 236, 88, 222, 104, 166, 106], [166, 114, 228, 110, 216, 126, 172, 124],
     [172, 132, 210, 132, 200, 146, 176, 141], [82, 96, 4, 88, 18, 104, 74, 106],
     [74, 114, 12, 110, 24, 126, 68, 124], [68, 132, 30, 132, 40, 146, 64, 141]].forEach(function (p) {
      fill(p, BRASS);
    });
  }
  // diamond: black bed, then the tan rule, then the field back to black
  fill(dia(1.12), bg); fill(dia(1.05), BRASS); fill(dia(0.93), bg);
  // the spear and its shard, in ember
  fill([120, 14, 136, 52, 104, 52], EMBER);
  fill([106, 56, 134, 56, 140, 70, 140, 172, 134, 186, 106, 186, 100, 172, 100, 70], EMBER);
  fill([120, 226, 104, 190, 136, 190], EMBER);
  // No monogram here on purpose: at 32px the stencil letters collapse into
  // noise, and a smudge reads worse than a clean shard. The in-app SVG mark
  // keeps them, because there they are legible.

  // box-downsample the supersampled buffer
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 3;
          r += px[i]; g += px[i + 1]; b += px[i + 2];
        }
      }
      const o = (y * w + x) * 3, n = SS * SS;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}
const draw = (w, h, opt) => drawMark(w, h, opt || {});

const write = (name, buf) => {
  writeFileSync(join(OUT, name), buf);
  return `${name} ${(buf.length / 1024).toFixed(1)}KB`;
};

// ── icons ─────────────────────────────────────────────────────────────────
// apple-touch-icon must be opaque and full-bleed: iOS applies its own mask and
// a transparent or pre-rounded icon comes out wrong.
const icons = [
  ['icon-180.png', 180, 0.62], // iPhone home screen
  ['icon-167.png', 167, 0.62], // iPad Pro
  ['icon-152.png', 152, 0.62], // iPad
  ['icon-192.png', 192, 0.62], // manifest
  ['icon-512.png', 512, 0.62], // manifest
  ['icon-maskable-512.png', 512, 0.52], // Android safe zone: mark well inside
  ['icon-maskable-192.png', 192, 0.52], // Android launchers mostly ask for 192
  ['favicon-32.png', 32, 0.86],
];
console.log('icons:');
for (const [name, size, scale] of icons) {
  console.log('  ' + write(name, png(size, size, draw(size, size, { scale }))));
}

// ── iOS splash screens ────────────────────────────────────────────────────
// Without these a standalone launch shows a white flash. They must match the
// device's pixel size exactly or iOS ignores them.
const splashes = [
  [1290, 2796], [1179, 2556], [1284, 2778], [1170, 2532],
  [1125, 2436], [1242, 2688], [828, 1792], [1242, 2208], [750, 1334],
  [1536, 2048], [1668, 2388], [2048, 2732], // iPad
];
console.log('\nsplash screens:');
for (const [w, h] of splashes) {
  console.log('  ' + write(`splash-${w}x${h}.png`, png(w, h, draw(w, h, { scale: 0.30 }))));
}

console.log('\nwrote to', OUT);
