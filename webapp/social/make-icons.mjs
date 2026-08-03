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

const INK = [0x13, 0x11, 0x10];   // --paper in dark mode; the app's own black
const EMBER = [0xc2, 0x4d, 0x2c]; // --ember
const PAPER = [0xf5, 0xef, 0xe6];

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

// ── the mark: a bold P, the wordmark's first letter ───────────────────────
function draw(w, h, { scale = 1, bg = INK, fg = EMBER } = {}) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { buf[i * 3] = bg[0]; buf[i * 3 + 1] = bg[1]; buf[i * 3 + 2] = bg[2]; }
  const put = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(h, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(w, Math.round(x1)); x++) {
        const i = (y * w + x) * 3;
        buf[i] = fg[0]; buf[i + 1] = fg[1]; buf[i + 2] = fg[2];
      }
    }
  };
  // P drawn from rectangles, centred, sized by `scale` against the short side
  const s = Math.min(w, h) * scale;
  const cx = w / 2, cy = h / 2;
  // Proportions matter at 32px: the counter has to stay open or the P reads as
  // a filled block with a slot cut in it.
  const L = cx - s * 0.28, T = cy - s * 0.36, B = cy + s * 0.36;
  const stem = s * 0.125, R = cx + s * 0.24, mid = cy + s * 0.06;
  put(L, T, L + stem, B);                    // stem
  put(L, T, R, T + stem);                    // top bar
  put(L, mid - stem, R, mid);                // middle bar
  put(R - stem, T, R, mid);                  // bowl's right side
  return buf;
}

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
  ['icon-maskable-512.png', 512, 0.42], // Android safe zone: mark well inside
  ['favicon-32.png', 32, 0.70],
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
  console.log('  ' + write(`splash-${w}x${h}.png`, png(w, h, draw(w, h, { scale: 0.22 }))));
}

console.log('\nwrote to', OUT);
