#!/usr/bin/env node
// Merge a diverged fork tail into the canonical log — the operator's tool
// for healing a partition that wrote on both sides.
//
//   node chain/merge.mjs --base acts.jsonl --fork fork.jsonl --out merged.jsonl
//   node chain/merge.mjs --base ... --fork ... --apply     # rewrite the base
//                                                          # log in place,
//                                                          # backup first
//   optional: --base-chain blocks.jsonl --fork-chain blocks.jsonl
//             refuse the merge unless the fork's SEALED chain is a prefix of
//             the base's (a diverged sealed history is two signed records —
//             a person chooses, not this tool)
//
// The merge itself is chain/reconcile.mjs and is deterministic: anyone
// holding both inputs can rerun it and must get byte-identical output. The
// report says what was appended, what was dropped and why, which extra
// epoch closes were carried over, and which media blobs the base host still
// needs to fetch before those posts render.

import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProtocol } from './chain.mjs';
import { reconcile, forkChainMergeable, readJsonl, writeJsonl } from './reconcile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webappDir = resolve(here, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const flag = (name) => process.argv.includes(name);

async function main() {
  const basePath = arg('--base'), forkPath = arg('--fork');
  if (!basePath || !forkPath) {
    console.error('usage: node chain/merge.mjs --base acts.jsonl --fork fork.jsonl (--out merged.jsonl | --apply)');
    process.exit(1);
  }
  const outPath = arg('--out');
  if (!outPath && !flag('--apply')) {
    console.error('say where the result goes: --out <file>, or --apply to rewrite the base log (with backup)');
    process.exit(1);
  }

  const baseChain = arg('--base-chain'), forkChain = arg('--fork-chain');
  if (forkChain && existsSync(forkChain)) {
    const fb = readJsonl(forkChain);
    const bb = baseChain && existsSync(baseChain) ? readJsonl(baseChain) : [];
    if (!forkChainMergeable(bb, fb)) {
      console.error('REFUSED: the fork sealed epoch blocks the base chain does not contain.');
      console.error('Two signed histories exist. Verify both (chain/verify.mjs), decide which record');
      console.error('stands, and merge the OTHER side\'s tail into it — this tool will not pick.');
      process.exit(2);
    }
  }

  const { R } = await loadProtocol(webappDir);
  const baseActs = readJsonl(resolve(basePath));
  const forkActs = readJsonl(resolve(forkPath));
  const { merged, report } = reconcile({ baseActs, forkActs, R });

  console.log(`shared prefix ${report.prefix} acts · base tail ${report.baseTail} · fork tail ${report.forkTail}`);
  console.log(`appended ${report.appended}, dropped ${report.dropped.length}, effect lost ${report.effectLost.length}`
    + (report.closeEpochs ? `, ${report.closeEpochs} extra epoch close(s) carried over — each mints PEER` : ''));
  for (const d of report.dropped) console.log(`  dropped [${d.fileIdx}] ${d.t}: ${d.reason}`);
  for (const e of report.effectLost) console.log(`  effect lost [${e.fileIdx}] ${e.t} (was ${e.minted} on the fork)`);
  if (report.mediaNeeded.length) {
    console.log(`media to carry over from the fork host (${report.mediaNeeded.length} blob(s)):`);
    for (const h of report.mediaNeeded) console.log('  ' + h);
  }

  if (flag('--apply')) {
    const bak = resolve(basePath) + '.pre-merge.bak';
    copyFileSync(resolve(basePath), bak);
    writeJsonl(resolve(basePath), merged);
    console.log(`applied: ${merged.length} acts in ${basePath} (backup at ${bak})`);
    console.log('restart the host so it re-reads the log, then re-run chain/build.mjs to seal.');
  } else {
    writeJsonl(resolve(outPath), merged);
    console.log(`wrote ${merged.length} acts to ${outPath}`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
