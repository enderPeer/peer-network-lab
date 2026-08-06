#!/usr/bin/env node
// Verify a chain against a log you hold — measurement, not promise.
//
//   node chain/verify.mjs                          # server-data log + chain
//   node chain/verify.mjs --data DIR               # explicit data dir
//   node chain/verify.mjs --acts F --chain F       # any log against any blocks.jsonl
//                                                  # (e.g. ../site/archive/acts.jsonl
//                                                  #  and ../site/archive/chain/blocks.jsonl)
//   node chain/verify.mjs ... --producer <b64url>  # additionally pin the producer key
//
// Everything is recomputed independently through the same replay the app
// runs: structural and payload commitments per act, merkle roots, the full
// epoch package per block (prefix replay, standing solve and all), hash
// links, and signatures. Exit 0 means every check passed; anything else
// names the block and the reason.

import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProtocol, readActsFile, verifyChain } from './chain.mjs';
import { readBlocksFile } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webappDir = resolve(here, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const dataDir = resolve(arg('--data') || process.env.PEER_DATA_DIR || join(webappDir, 'server-data'));
const actsPath = resolve(arg('--acts') || join(dataDir, 'acts.jsonl'));
const chainPath = resolve(arg('--chain') || join(dataDir, 'chain', 'blocks.jsonl'));

async function main() {
  for (const [what, p] of [['act log', actsPath], ['chain', chainPath]]) {
    if (!existsSync(p)) { console.error('no ' + what + ' at ' + p); process.exit(1); }
  }
  const { R, editions } = await loadProtocol(webappDir);
  const fileActs = readActsFile(actsPath);
  const blocks = readBlocksFile(chainPath);
  if (blocks.length === 0) { console.error('chain file is empty'); process.exit(1); }

  const report = verifyChain({ fileActs, blocks, R, editions, producer: arg('--producer') });

  for (const b of report.blocks) {
    const marks = [b.ok ? 'ok' : 'FAIL'];
    if (b.tombstoned) marks.push(b.tombstoned + ' tombstoned payload(s)');
    for (const n of b.notes) marks.push(n);
    console.log(`block ${String(b.height).padStart(3)} · epoch ${b.epoch} · ${marks.join(' · ')}`);
  }
  for (const w of report.warnings) console.log('note: ' + w);
  for (const e of report.errors) console.error('fault: ' + e);
  console.log(report.ok
    ? `VERIFIED — ${report.height} block(s), every root replayed, every signature checked`
    : 'VERIFICATION FAILED');
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
