#!/usr/bin/env node
// Pack the site into a CAR — the network as one content-addressed file.
//
//   node tools/ipfs-pack.mjs                    # packs ../site → dist/peer-site.car
//   node tools/ipfs-pack.mjs --dir D --out F    # any folder, any output
//
// The CAR (Content ARchive) is the whole site — app, archive, chain — as an
// IPFS DAG with one root CID. Import it into any IPFS node and the site is
// served; pin it anywhere and it outlives every machine this project owns.
// No daemon is needed to BUILD it, and building publishes nothing: this tool
// only writes a local file and prints what its address will be.
//
// The CID is deterministic and matches what `ipfs add -r --cid-version 1`
// would mint, because the import parameters are pinned to kubo's defaults:
// fixed 256 KiB chunks, raw leaves, balanced DAG of width 174, CIDv1,
// sha2-256. Same bytes in, same CID out, on any machine — which is the whole
// point: a mirror operator can rebuild the pack from the published site and
// KNOW it is the same site, before ever fetching a byte from anyone.
//
// Directory walk is sorted, so entry order can never depend on the
// filesystem's mood. (UnixFS directories sort links themselves; the sort
// here keeps the walk — and therefore block discovery order in the CAR —
// reproducible too.)

import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { CarWriter } from '@ipld/car';
import { createReadStream, createWriteStream, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));
const webappDir = resolve(here, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const srcDir = resolve(arg('--dir') || join(webappDir, '..', 'site'));
const outPath = resolve(arg('--out') || join(webappDir, 'dist', 'peer-site.car'));

function* walk(dir, base) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, base);
    else yield { path: relative(base, p).split(sep).join('/'), disk: p, size: st.size };
  }
}

async function main() {
  const files = [...walk(srcDir, srcDir)];
  if (files.length === 0) { console.error('nothing to pack in ' + srcDir); process.exit(1); }
  const totalBytes = files.reduce((s, f) => s + f.size, 0);

  // The CAR needs every block under its EXACT cid. MemoryBlockstore's own
  // getAll() rebuilds keys as raw-codec CIDs, which would misname every
  // dag-pb node — so record the pairs as the importer writes them instead
  // (utils/persist.js hands put() whole buffers).
  class RecordingBlockstore extends MemoryBlockstore {
    pairs = [];
    put(cid, bytes, opts) {
      this.pairs.push({ cid, bytes });
      return super.put(cid, bytes, opts);
    }
  }
  const blockstore = new RecordingBlockstore();
  const source = files.map((f) => ({ path: f.path, content: createReadStream(f.disk) }));
  let root = null;
  const entries = [];
  for await (const entry of importer(source, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: 262144 }),
    layout: balanced({ maxChildrenPerNode: 174 }),
    wrapWithDirectory: true,
  })) {
    entries.push(entry);
    root = entry.cid; // the wrapping directory arrives last
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const { writer, out } = await CarWriter.create([root]);
  const sink = Readable.from(out).pipe(createWriteStream(outPath));
  // Import concurrency makes write ORDER nondeterministic even though the
  // DAG (and so the root CID) never varies. Sort and dedupe, so the .car
  // itself is byte-identical run to run — an artifact you can hash.
  const unique = new Map();
  for (const pair of blockstore.pairs) unique.set(pair.cid.toString(), pair);
  const ordered = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, p]) => p);
  let blocks = 0;
  for (const pair of ordered) {
    await writer.put(pair);
    blocks++;
  }
  await writer.close();
  await finished(sink);

  const cid = root.toString();
  console.log(`packed ${files.length} files, ${(totalBytes / 1e6).toFixed(1)} MB, ${blocks} blocks`);
  console.log(`car  ${outPath}`);
  console.log(`root ${cid}`);
  console.log('');
  console.log('to host it (any one of these):');
  console.log(`  ipfs dag import "${outPath}" && ipfs pin add ${cid}     # your own node`);
  console.log(`  upload the .car to any pinning service (Pinata, Filebase, web3.storage)`);
  console.log('then the site lives at:');
  console.log(`  https://<gateway>/ipfs/${cid}/            # any public gateway, e.g. ipfs.io`);
  console.log(`  https://${cid}.ipfs.<gateway>/            # subdomain form - preferred: it gives`);
  console.log('                                            # the app its own origin for storage');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
