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
 * NONZERO fill across all subpaths of one path at once.
 *
 * Nonzero and not even-odd, because this one path is both a union and a set of
 * holes: the head, the crown node and its stem overlap and must merge, while
 * the connector ports and the layering gaps must cut through. Even-odd cancels
 * every overlap alike, which welded a white notch into every joint. The holes
 * are wound the opposite way round; see social/template.html for the same
 * geometry drawn inline.
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
        // the sign is which way the edge crosses — nonzero needs it
        if (ay <= yc && by > yc) xs.push([s[a * 2] + ((yc - ay) / (by - ay)) * (s[b * 2] - s[a * 2]), 1]);
        else if (by <= yc && ay > yc) xs.push([s[a * 2] + ((yc - ay) / (by - ay)) * (s[b * 2] - s[a * 2]), -1]);
      }
    }
    xs.sort((a, b) => a[0] - b[0]);
    let wind = 0, start = 0;
    for (const [x, dir] of xs) {
      const was = wind;
      wind += dir;
      if (was === 0 && wind !== 0) start = x;
      else if (was !== 0 && wind === 0) {
        for (let px_ = Math.max(0, Math.ceil(start - 0.5)); px_ <= Math.min(w - 1, Math.floor(x - 0.5)); px_++) {
          const i = (y * w + px_) * 3;
          px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2];
        }
      }
    }
  }
}

const MARK_W = 620, MARK_H = 890, MARK_OX = 10;
const MARK_INK = "M250 142C278 134 316 128 354 124C404 120 450 148 476 190C500 228 520 280 534 326C544 356 550 376 556 392C562 403 560 410 552 413C544 416 541 417 541 423C544 434 558 444 572 456C584 466 595 473 593 480C590 487 576 488 563 488C555 489 549 488 546 494C542 501 556 506 556 513C556 521 545 523 546 530C547 539 559 543 560 551C561 561 552 566 554 576C557 587 572 592 573 604C574 618 566 631 553 641C534 662 512 679 488 695C458 715 424 731 392 741C352 753 300 751 268 745L250 739ZM322.00 1.00C333.60 1.00 343.00 10.40 343.00 22.00C343.00 33.60 333.60 43.00 322.00 43.00C310.40 43.00 301.00 33.60 301.00 22.00C301.00 10.40 310.40 1.00 322.00 1.00ZM315 22L329 22L329 153L315 153ZM384.0 153.0L353.0 206.7L291.0 206.7L260.0 153.0L291.0 99.3L353.0 99.3ZM175 438L267 438L267 452L175 452ZM175.0 445.0L147.5 492.6L92.5 492.6L65.0 445.0L92.5 397.4L147.5 397.4ZM336.0 240.5L348.9 240.5L349.6 242.5L350.4 244.5L351.5 246.4L352.6 248.2L354.0 249.9L355.5 251.4L357.1 252.8L358.9 254.1L360.7 255.2L362.6 256.1L364.7 256.8L366.7 257.4L368.8 257.8L371.0 258.0L373.1 258.0L375.3 257.8L377.4 257.4L379.5 256.8L381.5 256.0L383.4 255.1L385.3 254.0L387.0 252.7L388.6 251.3L390.1 249.8L391.4 248.1L392.6 246.3L393.6 244.4L394.5 242.4L395.1 240.4L395.6 238.3L395.9 236.1L396.0 234.0L395.9 231.9L395.6 229.7L395.1 227.6L394.5 225.6L393.6 223.6L392.6 221.7L391.4 219.9L390.1 218.2L388.6 216.7L387.0 215.3L385.3 214.0L383.4 212.9L381.5 212.0L379.5 211.2L377.4 210.6L375.3 210.2L373.1 210.0L371.0 210.0L368.8 210.2L366.7 210.6L364.7 211.2L362.6 211.9L360.7 212.8L358.9 213.9L357.1 215.2L355.5 216.6L354.0 218.1L352.6 219.8L351.5 221.6L350.4 223.5L349.6 225.5L348.9 227.5L336.0 227.5ZM348.0 373.5L360.9 373.5L361.6 375.5L362.4 377.5L363.5 379.4L364.6 381.2L366.0 382.9L367.5 384.4L369.1 385.8L370.9 387.1L372.7 388.2L374.6 389.1L376.7 389.8L378.7 390.4L380.8 390.8L383.0 391.0L385.1 391.0L387.3 390.8L389.4 390.4L391.5 389.8L393.5 389.0L395.4 388.1L397.3 387.0L399.0 385.7L400.6 384.3L402.1 382.8L403.4 381.1L404.6 379.3L405.6 377.4L406.5 375.4L407.1 373.4L407.6 371.3L407.9 369.1L408.0 367.0L407.9 364.9L407.6 362.7L407.1 360.6L406.5 358.6L405.6 356.6L404.6 354.7L403.4 352.9L402.1 351.2L400.6 349.7L399.0 348.3L397.3 347.0L395.4 345.9L393.5 345.0L391.5 344.2L389.4 343.6L387.3 343.2L385.1 343.0L383.0 343.0L380.8 343.2L378.7 343.6L376.7 344.2L374.6 344.9L372.7 345.8L370.9 346.9L369.1 348.2L367.5 349.6L366.0 351.1L364.6 352.8L363.5 354.6L362.4 356.5L361.6 358.5L360.9 360.5L348.0 360.5ZM348.0 479.5L360.9 479.5L361.6 481.5L362.4 483.5L363.5 485.4L364.6 487.2L366.0 488.9L367.5 490.4L369.1 491.8L370.9 493.1L372.7 494.2L374.6 495.1L376.7 495.8L378.7 496.4L380.8 496.8L383.0 497.0L385.1 497.0L387.3 496.8L389.4 496.4L391.5 495.8L393.5 495.0L395.4 494.1L397.3 493.0L399.0 491.7L400.6 490.3L402.1 488.8L403.4 487.1L404.6 485.3L405.6 483.4L406.5 481.4L407.1 479.4L407.6 477.3L407.9 475.1L408.0 473.0L407.9 470.9L407.6 468.7L407.1 466.6L406.5 464.6L405.6 462.6L404.6 460.7L403.4 458.9L402.1 457.2L400.6 455.7L399.0 454.3L397.3 453.0L395.4 451.9L393.5 451.0L391.5 450.2L389.4 449.6L387.3 449.2L385.1 449.0L383.0 449.0L380.8 449.2L378.7 449.6L376.7 450.2L374.6 450.9L372.7 451.8L370.9 452.9L369.1 454.2L367.5 455.6L366.0 457.1L364.6 458.8L363.5 460.6L362.4 462.5L361.6 464.5L360.9 466.5L348.0 466.5ZM403.0 639.5L415.9 639.5L416.6 641.5L417.4 643.5L418.5 645.4L419.6 647.2L421.0 648.9L422.5 650.4L424.1 651.8L425.9 653.1L427.7 654.2L429.6 655.1L431.7 655.8L433.7 656.4L435.8 656.8L438.0 657.0L440.1 657.0L442.3 656.8L444.4 656.4L446.5 655.8L448.5 655.0L450.4 654.1L452.3 653.0L454.0 651.7L455.6 650.3L457.1 648.8L458.4 647.1L459.6 645.3L460.6 643.4L461.5 641.4L462.1 639.4L462.6 637.3L462.9 635.1L463.0 633.0L462.9 630.9L462.6 628.7L462.1 626.6L461.5 624.6L460.6 622.6L459.6 620.7L458.4 618.9L457.1 617.2L455.6 615.7L454.0 614.3L452.3 613.0L450.4 611.9L448.5 611.0L446.5 610.2L444.4 609.6L442.3 609.2L440.1 609.0L438.0 609.0L435.8 609.2L433.7 609.6L431.7 610.2L429.6 610.9L427.7 611.8L425.9 612.9L424.1 614.2L422.5 615.6L421.0 617.1L419.6 618.8L418.5 620.6L417.4 622.5L416.6 624.5L415.9 626.5L403.0 626.5ZM288.5 196.2L197.5 196.2L152.0 275.0L197.5 353.8L288.5 353.8L334.0 275.0ZM301.5 492.9L212.5 492.9L168.0 570.0L212.5 647.1L301.5 647.1L346.0 570.0ZM368.5 615.9L279.5 615.9L235.0 693.0L279.5 770.1L368.5 770.1L413.0 693.0Z";
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
