// Builds the self-contained social sandbox page:
//   1. esbuild-bundles the engine as an IIFE global (PeerEngine)
//   2. inlines it into template.html at the /*__ENGINE__*/ marker
//   3. inlines social/replay.cjs at /*__REPLAY__*/ — the SAME file the host
//      imports, so the page and the bot API can never disagree about state
//   4. emits public/peer-engine.mjs, the engine as a Node module for the host
// Usage: node social/assemble.mjs [outFile]
import { build, transform } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, '../public/peer-social-preview.html'));

const bundle = await build({
  entryPoints: [resolve(here, '../src/engine/bundle-entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'PeerEngine',
  minify: true,
  write: false,
});
const engine = bundle.outputFiles[0].text;
if (engine.includes('</script')) throw new Error('engine bundle contains </script — cannot inline');

// The host needs the engine too (for the bot API's server-side replay). Same
// sources, Node target — one engine, two consumers.
const nodeBundle = await build({
  entryPoints: [resolve(here, '../src/engine/bundle-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const enginePath = resolve(here, '../public/peer-engine.mjs');
mkdirSync(dirname(enginePath), { recursive: true });
writeFileSync(enginePath, nodeBundle.outputFiles[0].text, 'utf8');

// .cjs so the host can require() it unambiguously (this package is type:module);
// the page just inlines its text, so the extension is irrelevant there. It is
// minified for the page exactly as the engine is — the readable source is the
// file itself, and every visitor was paying for its comments over the wire.
// transform(), not build(): build() sees module.exports, decides the file is
// CommonJS and wraps it in its own module scope — which makes the UMD take the
// CJS branch and never publish window.PeerReplay. transform() only minifies.
const replaySrc = readFileSync(resolve(here, 'replay.cjs'), 'utf8');
const replayMin = await transform(replaySrc, { minify: true, loader: 'js' });
const replay = replayMin.code;
if (!/PeerReplay/.test(replay)) throw new Error('minified replay lost its global — the page would not boot');
if (replay.includes('</script')) throw new Error('replay bundle contains </script — cannot inline');

const template = readFileSync(resolve(here, 'template.html'), 'utf8');
if (!template.includes('/*__ENGINE__*/')) throw new Error('template marker missing');
if (!template.includes('/*__REPLAY__*/')) throw new Error('replay marker missing');

// A COMPLETE document, head included. It used to emit body content only and
// rely on the host wrapping it at request time — which meant the copy served
// from GitHub Pages had no <head> and therefore no viewport meta at all, so
// Safari laid it out at ~980px and scaled the whole app down on every phone.
// The stable public address was the one that suffered most from that.
//
// iOS needs more than the manifest: it takes its home-screen icon from
// apple-touch-icon, its title from apple-mobile-web-app-title, and shows a
// white flash on launch unless every splash size is declared with an exact
// media query. `viewport-fit=cover` plus safe-area insets is what keeps the
// layout clear of the notch and the home indicator.
const splashes = [
  [1290, 2796, 430, 932, 3], [1179, 2556, 393, 852, 3], [1284, 2778, 428, 926, 3],
  [1170, 2532, 390, 844, 3], [1125, 2436, 375, 812, 3], [1242, 2688, 414, 896, 3],
  [828, 1792, 414, 896, 2], [1242, 2208, 414, 736, 3], [750, 1334, 375, 667, 2],
  [1536, 2048, 768, 1024, 2], [1668, 2388, 834, 1194, 2], [2048, 2732, 1024, 1366, 2],
];
const splashLinks = splashes.map(([w, h, cw, ch, r]) =>
  `<link rel="apple-touch-startup-image" href="icons/splash-${w}x${h}.png" media="(device-width:${cw}px) and (device-height:${ch}px) and (-webkit-device-pixel-ratio:${r}) and (orientation:portrait)">`,
).join('\n');

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#131110">
<meta name="description" content="A social network whose feed is mathematics you can check. Influence is commitment, not attention.">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Peer">
<meta name="format-detection" content="telephone=no">
${splashLinks}
</head>
<body>`;

const tail = `
<script>
// Registered only where it can work: a service worker needs a secure context,
// and file:// or a plain-http tunnel would just throw on every load.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
}
</script>
</body>
</html>`;

const page = head + template
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__REPLAY__*/', () => replay) + tail;

// Refuse to emit a page whose script does not parse.
//
// This build only ever concatenated text, so a single missing bracket produced
// a perfectly valid-looking file that rendered a blank screen — and it shipped,
// because everything checked afterwards was server-side: the tests never load
// the page, and the APIs answer fine while the app is dead. The failure was
// silent in every direction until someone opened it in a browser.
//
// One parse of each <script> block costs milliseconds and turns that class of
// mistake into a failed build with a line number.
for (const [i, block] of page.split('<script>').slice(1).entries()) {
  const body = block.split('</script>')[0];
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
  } catch (e) {
    console.error(`\nBUILD FAILED — script block ${i} does not parse: ${e.message}`);
    console.error('Nothing was written. The page would have rendered blank.\n');
    process.exit(1);
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page, 'utf8');
console.log('wrote', out, '(engine', engine.length, '+ replay', replay.length,
  'bytes; replay source', replaySrc.length, '→', replay.length, ')');
console.log('wrote', enginePath, '(node engine', nodeBundle.outputFiles[0].text.length, 'bytes)');
