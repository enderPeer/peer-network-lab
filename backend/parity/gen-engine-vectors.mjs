// Phase-2 golden vectors: the engine-parity definition of done.
//
// 1. Epoch packages: for every closeEpoch in the live log and the
//    genesis-0-final corpus, the CURRENT JS replay's epochPackage canonical
//    string + stateRoot. The Rust engine is correct exactly when it
//    reproduces every byte of every package.
// 2. Transcendentals: every distinct (fn, arg) pair the two replays
//    actually evaluate through Math.pow/exp/tanh/log, recorded bit-exactly,
//    plus a seeded synthetic sweep — the conformance set for ender-jsmath.
//
// Regenerate: node backend/parity/gen-engine-vectors.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const webappDir = join(repo, 'webapp');
const OUT_DIR = join(here, '..', 'crates', 'ender-engine', 'tests', 'vectors');

// ---- transcendental recording: patch BEFORE the engine loads ---------------

const f64bits = (x) => { const b = Buffer.alloc(8); b.writeDoubleBE(x); return b.toString('hex'); };

const recorded = new Map(); // key: fn|argbits[|argbits2] -> result bits
function wrap1(name) {
  const orig = Math[name];
  Math[name] = (x) => {
    const r = orig(x);
    recorded.set(`${name}|${f64bits(x)}`, f64bits(r));
    return r;
  };
}
const origPow = Math.pow;
Math.pow = (x, y) => {
  const r = origPow(x, y);
  recorded.set(`pow|${f64bits(x)}|${f64bits(y)}`, f64bits(r));
  return r;
};
for (const fn of ['exp', 'tanh', 'log']) wrap1(fn);
// ** operator lowers to the same pow algorithm in V8 but does NOT go through
// Math.pow — record it separately if the sources ever use it (grep says no).

// Engine loads AFTER the patch: dynamic import inside loadProtocol.
const { loadProtocol, readActsFile, findEpochCloses } = await import(`file:///${join(webappDir, 'chain', 'chain.mjs').replace(/\\/g, '/')}`);
const { epochPackage, stateRoot } = await import(`file:///${join(webappDir, 'chain', 'package.mjs').replace(/\\/g, '/')}`);
const { canonical } = await import(`file:///${join(webappDir, 'chain', 'canonical.mjs').replace(/\\/g, '/')}`);

const { R } = await loadProtocol(webappDir);
const SEED_ACT = { t: 'seedWorld' };

// ---- epoch packages per corpus ---------------------------------------------

function packagesFor(actsPath, label) {
  const fileActs = readActsFile(actsPath);
  const closes = findEpochCloses(fileActs);
  const out = [];
  for (const { idx, epoch } of closes) {
    const st = R.replay([SEED_ACT, ...fileActs.slice(0, idx + 1)]);
    const pkg = epochPackage(st, epoch);
    const canon = canonical(pkg);
    out.push({ closeIdx: idx, epoch, stateRoot: stateRoot(pkg), canonical: canon });
  }
  console.log(`${label}: ${fileActs.length} acts, ${closes.length} closes, ` +
    `${out.reduce((n, p) => n + p.canonical.length, 0)} package bytes`);
  return { acts: readFileSync(actsPath, 'utf8'), packages: out };
}

const corpora = {
  live: packagesFor(join(webappDir, 'server-data', 'acts.jsonl'), 'live'),
  genesis0: packagesFor(join(webappDir, 'server-data', 'genesis-0-final', 'acts.jsonl'), 'genesis0'),
};

// ---- synthetic transcendental sweep ----------------------------------------

// Deterministic PRNG (mulberry32) so the sweep is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5eed);
const specials = [0, -0, 1, -1, 0.5, -0.5, 1e-9, -1e-9, 1e-300, -1e-300, 1e300,
  0.9, 0.0528066, 0.1, 2, 10, Math.E, Math.PI, 745, -745, 709.78, -708.4,
  5e-324, -5e-324, 1.7976931348623157e308];
function sweep1(name, fn, domain) {
  for (const s of specials) if (domain(s)) recorded.set(`${name}|${f64bits(s)}`, f64bits(fn(s)));
  for (let i = 0; i < 3000; i++) {
    // spread across magnitudes: sign * 10^(uniform -12..3) and plain uniform
    const x = i % 2 === 0
      ? (rand() < 0.5 ? -1 : 1) * Math.pow(10, rand() * 15 - 12)
      : rand() * 20 - 10;
    if (domain(x)) recorded.set(`${name}|${f64bits(x)}`, f64bits(fn(x)));
  }
}
sweep1('exp', origExpSafe('exp'), () => true);
sweep1('tanh', origExpSafe('tanh'), () => true);
sweep1('log', origExpSafe('log'), (x) => x > 0);
function origExpSafe(name) { return Math[name]; } // already-wrapped: records itself
for (const s of specials) for (const e of specials) {
  recorded.set(`pow|${f64bits(s)}|${f64bits(e)}`, f64bits(origPow(s, e)));
}
for (let i = 0; i < 3000; i++) {
  const base = rand() * 4 - 2 + (i % 3 === 0 ? 0 : 1); // cluster near [−2..3]
  const ex = Math.floor(rand() * 30) - 5 + (i % 2 ? rand() : 0);
  recorded.set(`pow|${f64bits(base)}|${f64bits(ex)}`, f64bits(origPow(base, ex)));
}

const transcendentals = [...recorded.entries()].map(([k, result]) => {
  const parts = k.split('|');
  return parts.length === 3
    ? { fn: parts[0], a: parts[1], b: parts[2], r: result }
    : { fn: parts[0], a: parts[1], r: result };
});

// ---- write -------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'packages-live.json'), JSON.stringify(corpora.live, null, 1));
writeFileSync(join(OUT_DIR, 'packages-genesis0.json'), JSON.stringify(corpora.genesis0, null, 1));
writeFileSync(join(OUT_DIR, 'transcendentals.json'), JSON.stringify({
  note: 'fn(argBitsBE) = resultBitsBE, recorded from V8 during real replays + seeded sweep',
  vectors: transcendentals,
}, null, 1));
console.log(`transcendental vectors: ${transcendentals.length}`);
for (const [fn, n] of Object.entries(transcendentals.reduce((m, v) => ((m[v.fn] = (m[v.fn] || 0) + 1), m), {}))) {
  console.log(`  ${fn}: ${n}`);
}
