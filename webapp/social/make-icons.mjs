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
const EMBER = [0xf5, 0x11, 0x06]; // the mark's red
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

// ── the mark: the network merging into a head in profile ──────────────────
// The SAME path data the app draws inline (MARK_FACE / MARK_INK / MARK_RED in
// social/template.html) and the same geometry as site/mark.svg, so the tab
// icon, the home-screen icon and the in-app logo are one drawing. Rendered at
// 4x and boxed down: the profile is all curves, and a curve at 32px is nothing
// but its antialiasing.
//
// Paths are flattened here rather than handed to a renderer because this file
// deliberately has no dependencies — it is the reason there are no binary
// blobs in the repo.
const SS = 4;
const FLAT = 20;   // segments per cubic; invisible past ~12 at these sizes

/** Absolute M/L/C/Z path data -> a list of polygons, in mark space. */
function flatten(d) {
  const t = d.match(/[MLCZ]|-?\d*\.?\d+/g) || [];
  const subs = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = null, i = 0;
  const num = () => parseFloat(t[i++]);
  while (i < t.length) {
    if (/[A-Z]/.test(t[i])) cmd = t[i++];
    if (cmd === 'M') { x = num(); y = num(); sx = x; sy = y; cur = [x, y]; subs.push(cur); cmd = 'L'; }
    else if (cmd === 'L') { x = num(); y = num(); cur.push(x, y); }
    else if (cmd === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), nx = num(), ny = num();
      const x0 = x, y0 = y;
      for (let k = 1; k <= FLAT; k++) {
        const s = k / FLAT, m = 1 - s;
        cur.push(
          m * m * m * x0 + 3 * m * m * s * x1 + 3 * m * s * s * x2 + s * s * s * nx,
          m * m * m * y0 + 3 * m * m * s * y1 + 3 * m * s * s * y2 + s * s * s * ny,
        );
      }
      x = nx; y = ny;
    } else if (cmd === 'Z') {
      // No i++ here. The Z token was already consumed by the command read at
      // the top of the loop; skipping another swallowed the following M and
      // welded every subpath onto its neighbour — which drew the head with
      // black slashes through it.
      x = sx; y = sy;
    } else i++;
  }
  return subs.filter((s) => s.length >= 6);
}

/**
 * Even-odd fill across ALL subpaths of one path at once — that is what makes
 * the connector ports and the layering gaps real holes rather than white
 * discs, so the mark drops onto any background.
 */
function fillPath(px, w, h, d, unit, ox, oy, col) {
  const subs = flatten(d).map((s) => {
    const o = [];
    for (let k = 0; k < s.length; k += 2) o.push(s[k] * unit + ox, s[k + 1] * unit + oy);
    return o;
  });
  let y0 = Infinity, y1 = -Infinity;
  for (const s of subs) for (let k = 1; k < s.length; k += 2) { y0 = Math.min(y0, s[k]); y1 = Math.max(y1, s[k]); }
  if (!isFinite(y0)) return;
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
    const yc = y + 0.5, xs = [];
    for (const s of subs) {
      const n = s.length / 2;
      for (let a = 0; a < n; a++) {
        const b = (a + 1) % n, ay = s[a * 2 + 1], by = s[b * 2 + 1];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(s[a * 2] + ((yc - ay) / (by - ay)) * (s[b * 2] - s[a * 2]));
      }
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

const MARK_W = 620, MARK_H = 890, MARK_OX = 10;
const MARK_FACE = "M250 116C288 100 330 96 366 104C408 113 438 138 456 172C476 209 490 253 502 302C510 336 516 366 522 388C527 404 538 412 546 420C552 426 550 432 542 434C534 436 530 438 530 445C530 452 540 456 550 466C566 482 588 500 592 512C596 522 588 528 574 529C562 530 552 528 546 534C540 541 556 547 554 556C552 566 540 566 542 575C544 585 560 588 561 601C562 614 552 620 558 632C564 645 570 656 564 672C556 692 528 706 494 708C452 711 408 700 374 678C340 656 300 636 272 626L250 622ZM336.0 208.5L370.2 208.5L370.9 206.4L371.8 204.4L373.0 202.5L374.2 200.7L375.7 199.0L377.3 197.4L379.0 196.0L380.8 194.8L382.7 193.7L384.7 192.8L386.8 192.1L389.0 191.5L391.2 191.2L393.4 191.0L395.6 191.1L397.8 191.3L400.0 191.7L402.1 192.3L404.2 193.2L406.1 194.1L408.0 195.3L409.8 196.6L411.5 198.1L413.0 199.7L414.3 201.5L415.5 203.3L416.6 205.3L417.4 207.3L418.1 209.4L418.6 211.6L418.9 213.8L419.0 216.0L418.9 218.2L418.6 220.4L418.1 222.6L417.4 224.7L416.6 226.7L415.5 228.7L414.3 230.5L413.0 232.3L411.5 233.9L409.8 235.4L408.0 236.7L406.1 237.9L404.2 238.8L402.1 239.7L400.0 240.3L397.8 240.7L395.6 240.9L393.4 241.0L391.2 240.8L389.0 240.5L386.8 239.9L384.7 239.2L382.7 238.3L380.8 237.2L379.0 236.0L377.3 234.6L375.7 233.0L374.2 231.3L373.0 229.5L371.8 227.6L370.9 225.6L370.2 223.5L336.0 223.5ZM334.0 322.5L368.2 322.5L368.9 320.4L369.8 318.4L371.0 316.5L372.2 314.7L373.7 313.0L375.3 311.4L377.0 310.0L378.8 308.8L380.7 307.7L382.7 306.8L384.8 306.1L387.0 305.5L389.2 305.2L391.4 305.0L393.6 305.1L395.8 305.3L398.0 305.7L400.1 306.3L402.2 307.2L404.1 308.1L406.0 309.3L407.8 310.6L409.5 312.1L411.0 313.7L412.3 315.5L413.5 317.3L414.6 319.3L415.4 321.3L416.1 323.4L416.6 325.6L416.9 327.8L417.0 330.0L416.9 332.2L416.6 334.4L416.1 336.6L415.4 338.7L414.6 340.7L413.5 342.7L412.3 344.5L411.0 346.3L409.5 347.9L407.8 349.4L406.0 350.7L404.1 351.9L402.2 352.8L400.1 353.7L398.0 354.3L395.8 354.7L393.6 354.9L391.4 355.0L389.2 354.8L387.0 354.5L384.8 353.9L382.7 353.2L380.7 352.3L378.8 351.2L377.0 350.0L375.3 348.6L373.7 347.0L372.2 345.3L371.0 343.5L369.8 341.6L368.9 339.6L368.2 337.5L334.0 337.5ZM338.0 444.5L372.2 444.5L372.9 442.4L373.8 440.4L375.0 438.5L376.2 436.7L377.7 435.0L379.3 433.4L381.0 432.0L382.8 430.8L384.7 429.7L386.7 428.8L388.8 428.1L391.0 427.5L393.2 427.2L395.4 427.0L397.6 427.1L399.8 427.3L402.0 427.7L404.1 428.3L406.2 429.2L408.1 430.1L410.0 431.3L411.8 432.6L413.5 434.1L415.0 435.7L416.3 437.5L417.5 439.3L418.6 441.3L419.4 443.3L420.1 445.4L420.6 447.6L420.9 449.8L421.0 452.0L420.9 454.2L420.6 456.4L420.1 458.6L419.4 460.7L418.6 462.7L417.5 464.7L416.3 466.5L415.0 468.3L413.5 469.9L411.8 471.4L410.0 472.7L408.1 473.9L406.2 474.8L404.1 475.7L402.0 476.3L399.8 476.7L397.6 476.9L395.4 477.0L393.2 476.8L391.0 476.5L388.8 475.9L386.7 475.2L384.7 474.3L382.8 473.2L381.0 472.0L379.3 470.6L377.7 469.0L376.2 467.3L375.0 465.5L373.8 463.6L372.9 461.6L372.2 459.5L338.0 459.5ZM394.0 598.5L428.2 598.5L428.9 596.4L429.8 594.4L431.0 592.5L432.2 590.7L433.7 589.0L435.3 587.4L437.0 586.0L438.8 584.8L440.7 583.7L442.7 582.8L444.8 582.1L447.0 581.5L449.2 581.2L451.4 581.0L453.6 581.1L455.8 581.3L458.0 581.7L460.1 582.3L462.2 583.2L464.1 584.1L466.0 585.3L467.8 586.6L469.5 588.1L471.0 589.7L472.3 591.5L473.5 593.3L474.6 595.3L475.4 597.3L476.1 599.4L476.6 601.6L476.9 603.8L477.0 606.0L476.9 608.2L476.6 610.4L476.1 612.6L475.4 614.7L474.6 616.7L473.5 618.7L472.3 620.5L471.0 622.3L469.5 623.9L467.8 625.4L466.0 626.7L464.1 627.9L462.2 628.8L460.1 629.7L458.0 630.3L455.8 630.7L453.6 630.9L451.4 631.0L449.2 630.8L447.0 630.5L444.8 629.9L442.7 629.2L440.7 628.3L438.8 627.2L437.0 626.0L435.3 624.6L433.7 623.0L432.2 621.3L431.0 619.5L429.8 617.6L428.9 615.6L428.2 613.5L394.0 613.5ZM334.0 275.0L288.5 353.8L197.5 353.8L152.0 275.0L197.5 196.2L288.5 196.2ZM346.0 570.0L301.5 647.1L212.5 647.1L168.0 570.0L212.5 492.9L301.5 492.9ZM413.0 693.0L368.5 770.1L279.5 770.1L235.0 693.0L279.5 615.9L368.5 615.9Z";
const MARK_INK = "M322.00 1.00C333.60 1.00 343.00 10.40 343.00 22.00C343.00 33.60 333.60 43.00 322.00 43.00C310.40 43.00 301.00 33.60 301.00 22.00C301.00 10.40 310.40 1.00 322.00 1.00ZM315 22L329 22L329 153L315 153ZM384.0 153.0L353.0 206.7L291.0 206.7L260.0 153.0L291.0 99.3L353.0 99.3ZM175 438L267 438L267 452L175 452ZM175.0 445.0L147.5 492.6L92.5 492.6L65.0 445.0L92.5 397.4L147.5 397.4Z";
const MARK_RED = "M195.0 155.0L175.0 189.6L135.0 189.6L115.0 155.0L135.0 120.4L175.0 120.4ZM125 268L167 268L167 282L125 282ZM125.0 275.0L104.0 311.4L62.0 311.4L41.0 275.0L62.0 238.6L104.0 238.6ZM323.0 275.0L283.0 344.3L203.0 344.3L163.0 275.0L203.0 205.7L283.0 205.7ZM77 563L184 563L184 577L77 577ZM77.0 570.0L56.0 606.4L14.0 606.4L-7.0 570.0L14.0 533.6L56.0 533.6ZM335.0 570.0L296.0 637.5L218.0 637.5L179.0 570.0L218.0 502.5L296.0 502.5ZM209.0 705.0L185.5 745.7L138.5 745.7L115.0 705.0L138.5 664.3L185.5 664.3ZM402.0 693.0L363.0 760.5L285.0 760.5L246.0 693.0L285.0 625.5L363.0 625.5ZM317 693L331 693L331 863L317 863ZM324.00 842.00C335.60 842.00 345.00 851.40 345.00 863.00C345.00 874.60 335.60 884.00 324.00 884.00C312.40 884.00 303.00 874.60 303.00 863.00C303.00 851.40 312.40 842.00 324.00 842.00Z";

const MARK_FACE_PLAIN = "M250 116C288 100 330 96 366 104C408 113 438 138 456 172C476 209 490 253 502 302C510 336 516 366 522 388C527 404 538 412 546 420C552 426 550 432 542 434C534 436 530 438 530 445C530 452 540 456 550 466C566 482 588 500 592 512C596 522 588 528 574 529C562 530 552 528 546 534C540 541 556 547 554 556C552 566 540 566 542 575C544 585 560 588 561 601C562 614 552 620 558 632C564 645 570 656 564 672C556 692 528 706 494 708C452 711 408 700 374 678C340 656 300 636 272 626L250 622Z";
const MARK_RED_BIG = "M323.0 275.0L283.0 344.3L203.0 344.3L163.0 275.0L203.0 205.7L283.0 205.7ZM335.0 570.0L296.0 637.5L218.0 637.5L179.0 570.0L218.0 502.5L296.0 502.5ZM402.0 693.0L363.0 760.5L285.0 760.5L246.0 693.0L285.0 625.5L363.0 625.5Z";

function drawMark(w, h, { scale = 1, bg = INK, ink = PAPER } = {}) {
  const W = w * SS, H = h * SS;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2]; }
  // fit the portrait mark inside the box, then scale by the caller's factor
  const unit = Math.min(W / MARK_W, H / MARK_H) * scale;
  const ox = (W - MARK_W * unit) / 2 + MARK_OX * unit;
  const oy = (H - MARK_H * unit) / 2;
  // Below 64px the ports, the stems and the small hexagons collapse into
  // noise, and a smudge reads worse than a clean shape — so the small sizes
  // get the silhouette and its three largest nodes, nothing else.
  if (Math.min(w, h) < 64) {
    fillPath(px, W, H, MARK_FACE_PLAIN, unit, ox, oy, ink);
    fillPath(px, W, H, MARK_RED_BIG, unit, ox, oy, EMBER);
  } else {
    fillPath(px, W, H, MARK_FACE, unit, ox, oy, ink);
    fillPath(px, W, H, MARK_INK, unit, ox, oy, ink);
    fillPath(px, W, H, MARK_RED, unit, ox, oy, EMBER);
  }
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
