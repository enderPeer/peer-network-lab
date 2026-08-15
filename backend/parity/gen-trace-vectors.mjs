// Act-level divergence bisector: after every log prefix [0..i], a digest of
// the CHEAP deterministic state (no standing solve, no certificate settle).
// When the Rust fold diverges from a package vector, the first index whose
// trace digest differs names the exact act to debug.
//
// The projection here is mirrored by ender-engine's trace_digest() — keep
// the two in lockstep or the bisector lies.
//
// Regenerate: node backend/parity/gen-trace-vectors.mjs   (takes ~a minute)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const webappDir = join(repo, 'webapp');
const OUT_DIR = join(here, '..', 'crates', 'ender-engine', 'tests', 'vectors');

const { loadProtocol, readActsFile } = await import(`file:///${join(webappDir, 'chain', 'chain.mjs').replace(/\\/g, '/')}`);
const { canonical, sha256hex } = await import(`file:///${join(webappDir, 'chain', 'canonical.mjs').replace(/\\/g, '/')}`);

const { R } = await loadProtocol(webappDir);
const SEED_ACT = { t: 'seedWorld' };

function projection(st) {
  const pools = {};
  for (const pid of Object.keys(st.pools || {})) {
    const p = st.pools[pid];
    pools[pid] = { resA: p.resA, resB: p.resB, totalShares: p.totalShares, swaps: p.swaps };
  }
  return {
    ledgers: st.ledgers.map((l) => ({ id: l.id, burnBal: l.burnBal, actCount: l.actCount })),
    supply: st.tokens.supply,
    bal: st.tokens.bal,
    carry: st.tokens.carry,
    epochN: st.tokens.epochN,
    epochs: st.epochHistory.length,
    pools,
    counterEdges: st.g.edges.length,
  };
}

function traceFor(actsPath, label) {
  const fileActs = readActsFile(actsPath);
  const digests = [];
  for (let i = 0; i <= fileActs.length; i++) {
    const st = R.replay([SEED_ACT, ...fileActs.slice(0, i)]);
    digests.push(sha256hex(canonical(projection(st))));
  }
  console.log(`${label}: ${fileActs.length} acts traced`);
  return digests;
}

mkdirSync(OUT_DIR, { recursive: true });
const out = {
  note: 'digest[i] = sha256(canonical(projection)) after replaying file acts [0..i); projection defined in gen-trace-vectors.mjs and mirrored by ender-engine trace_digest()',
  live: traceFor(join(webappDir, 'server-data', 'acts.jsonl'), 'live'),
  genesis0: traceFor(join(webappDir, 'server-data', 'genesis-0-final', 'acts.jsonl'), 'genesis0'),
};
writeFileSync(join(OUT_DIR, 'traces.json'), JSON.stringify(out, null, 1));
console.log('wrote traces.json');
