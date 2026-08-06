#!/usr/bin/env node
// Seal the chain: every closed epoch in the act log becomes a signed block.
//
//   node chain/build.mjs                      # data dir: PEER_DATA_DIR or ./server-data
//   node chain/build.mjs --data DIR           # explicit data dir (acts.jsonl lives here)
//   node chain/build.mjs --export DIR         # also copy blocks + head into DIR
//                                             # (e.g. ../site/archive/chain)
//   node chain/build.mjs --rebuild            # reseal from genesis (new sigs, same roots)
//
// Incremental and refusing by default: existing blocks are re-anchored
// against the log, only new epochs are sealed, and any mismatch stops the
// build with its reason instead of publishing a fork.
//
// Chain files:
//   <data>/chain/producer.pem   the signing key — never leaves this machine
//   <data>/chain/blocks.jsonl   one canonical block per line, height order
//   <data>/chain/HEAD.json      { net, height, epoch, hash, producer }
// The export copy carries blocks and HEAD only — never the key.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonical } from './canonical.mjs';
import { loadOrCreateProducerKey } from './keys.mjs';
import { blockHash } from './block.mjs';
import { loadProtocol, readActsFile, buildBlocks } from './chain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webappDir = resolve(here, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const flag = (name) => process.argv.includes(name);

const dataDir = resolve(arg('--data') || process.env.PEER_DATA_DIR || join(webappDir, 'server-data'));
const chainDir = join(dataDir, 'chain');
const actsPath = join(dataDir, 'acts.jsonl');
const exportDir = arg('--export');

export function readBlocksFile(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function writeChain(dir, blocks) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blocks.jsonl'), blocks.map((b) => canonical(b)).join('\n') + '\n');
  const head = blocks[blocks.length - 1];
  writeFileSync(join(dir, 'HEAD.json'), canonical({
    net: head.net, height: head.height, epoch: head.epoch,
    hash: blockHash(head), producer: head.producer,
  }) + '\n');
}

async function main() {
  if (!existsSync(actsPath)) {
    console.error('no act log at ' + actsPath);
    process.exit(1);
  }
  const { R, editions, constants } = await loadProtocol(webappDir);
  const fileActs = readActsFile(actsPath);
  const existing = flag('--rebuild') ? [] : readBlocksFile(join(chainDir, 'blocks.jsonl'));
  const key = loadOrCreateProducerKey(join(chainDir, 'producer.pem'));

  const { blocks, sealed, pendingActs } = buildBlocks({ fileActs, R, editions, constants, key, existing });
  if (blocks.length === 0) {
    console.log('no closed epochs yet — nothing to seal (' + fileActs.length + ' acts pending)');
    return;
  }
  writeChain(chainDir, blocks);
  const head = blocks[blocks.length - 1];
  console.log(`chain at height ${head.height} (epoch ${head.epoch}) — ${sealed} block(s) sealed this run, ${pendingActs} act(s) await the next close`);
  console.log(`head ${blockHash(head)}`);
  console.log(`producer ${head.producer}`);

  if (exportDir) {
    const out = resolve(exportDir);
    writeChain(out, blocks);
    console.log('exported blocks + HEAD to ' + out + ' (the producer key stays home)');
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
