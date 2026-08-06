// Chain build and verify: the ordered act log in, signed epoch blocks out —
// and the reverse: blocks plus log in, a decidable verdict out.
//
// The state-transition function is not reimplemented here. Blocks are sealed
// and checked through the SAME social/replay.cjs the browser inlines and the
// host imports — one rulebook, now three readers. A verifier that recomputed
// standings with its own math would be the drift this project has already
// paid for twice.
//
// Consensus, stated honestly: there is none, and the chain does not pretend
// otherwise. The network runs one writer (HOSTING.md's one rule); that
// writer is the block producer. What the chain adds is not agreement but
// EVIDENCE — a signed, hash-linked, content-addressable trail that makes a
// rewritten history distinguishable from the history everyone replayed. The
// step that would decentralise writes is the same one HOSTING.md already
// names (content-addressed act ids); until then, mirrors and strangers hold
// the producer to its signatures.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { sha256hex, canonical, STATE_QUANTUM } from './canonical.mjs';
import { merkleRoot } from './merkle.mjs';
import { actCommitments, payloadMayDiffer } from './acts.mjs';
import { epochPackage, stateRoot } from './package.mjs';
import { sealBlock, blockHash, verifyBlockSignature, NET_ID, CHAIN_VERSION } from './block.mjs';

const SEED_ACT = { t: 'seedWorld' };

/** Load the engine bundle and the shared replay, exactly as server.mjs does,
 *  and fingerprint both files — the formula editions sealed into blocks. */
export async function loadProtocol(webappDir) {
  const require_ = createRequire(import.meta.url);
  const replayPath = join(webappDir, 'social', 'replay.cjs');
  const enginePath = join(webappDir, 'public', 'peer-engine.mjs');
  const replayMod = require_(replayPath);
  const engineMod = await import(pathToFileURL(enginePath).href);
  const R = replayMod.create(engineMod);
  return {
    R,
    engineMod,
    editions: {
      engine: sha256hex(readFileSync(enginePath)),
      replay: sha256hex(readFileSync(replayPath)),
    },
    constants: {
      theta: engineMod.THETA,
      nu: engineMod.NU,
      // the PEER curve, as written in social/replay.cjs (pinned by the
      // replay edition hash above; restated here so a block is readable
      // without the source)
      tokEpoch: 5000, tokDecay: 0.9, tokYear: 365, tokCap: 18250000,
      quantum: STATE_QUANTUM,
    },
  };
}

export function readActsFile(path) {
  const acts = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    acts.push(JSON.parse(line));
  }
  return acts;
}

export function findEpochCloses(fileActs) {
  const closes = [];
  for (let i = 0; i < fileActs.length; i++) {
    if (fileActs[i].t === 'closeEpoch') closes.push({ idx: i, epoch: fileActs[i].epoch });
  }
  return closes;
}

function replayPrefix(R, fileActs, endIdx) {
  return R.replay([SEED_ACT, ...fileActs.slice(0, endIdx + 1)]);
}

/**
 * Seal blocks for every closed epoch the existing chain has not covered.
 * Existing blocks are re-anchored cheaply (ranges, act commitments, links)
 * — a mismatch there means the log was rewritten beyond lawful redaction,
 * or sealed against a different formula edition, and the build refuses
 * rather than quietly forking.
 */
export function buildBlocks({ fileActs, R, editions, constants, key, existing = [] }) {
  const closes = findEpochCloses(fileActs);
  const { structural, payload } = actCommitments(fileActs, R.parseMentions);
  const blocks = [];
  let prev = null;
  let sealed = 0;

  for (let n = 0; n < closes.length; n++) {
    const start = n === 0 ? 0 : closes[n - 1].idx + 1;
    const end = closes[n].idx;
    const structuralSlice = structural.slice(start, end + 1);
    const payloadSlice = payload.slice(start, end + 1);

    const have = existing[n];
    if (have) {
      if (have.range.start !== start || have.range.end !== end) {
        throw new Error(`block ${n + 1}: sealed range ${have.range.start}-${have.range.end} does not match the log's epoch boundaries ${start}-${end}`);
      }
      for (let i = 0; i < structuralSlice.length; i++) {
        if (have.acts[i] !== structuralSlice[i]) {
          throw new Error(`block ${n + 1}: act ${start + i} no longer matches its sealed structural hash — the log was rewritten beyond lawful redaction, or sealed under a different formula edition`);
        }
        if (have.payloads[i] !== payloadSlice[i] && !payloadMayDiffer(fileActs[start + i])) {
          throw new Error(`block ${n + 1}: act ${start + i} payload differs from its sealed commitment and carries no redaction stamp`);
        }
      }
      if (have.prev !== prev) throw new Error(`block ${n + 1}: broken hash link`);
      blocks.push(have);
      prev = blockHash(have);
      continue;
    }

    const st = replayPrefix(R, fileActs, end);
    const pkg = epochPackage(st, closes[n].epoch);
    const block = sealBlock({
      height: n + 1,
      epoch: closes[n].epoch,
      time: fileActs[end].ts !== undefined ? fileActs[end].ts : null,
      prev,
      range: { start, end },
      acts: structuralSlice,
      actsRoot: merkleRoot(structuralSlice),
      payloads: payloadSlice,
      payloadsRoot: merkleRoot(payloadSlice),
      package: pkg,
      stateRoot: stateRoot(pkg),
      constants,
      editions,
      producer: key.pub,
    }, key.privateKey);
    blocks.push(block);
    prev = blockHash(block);
    sealed++;
  }
  return { blocks, sealed, pendingActs: closes.length ? fileActs.length - 1 - closes[closes.length - 1].idx : fileActs.length };
}

/**
 * Independent verification: recompute everything from the log and compare.
 * Every failure is attributed — link, signature, structure, payload, state,
 * or edition drift — because a discrepancy nobody can attribute is the
 * "third outcome" the canonical-publication postulate exists to remove.
 */
export function verifyChain({ fileActs, blocks, R, editions = null, producer = null }) {
  const report = { ok: true, height: blocks.length, blocks: [], errors: [], warnings: [], tombstoned: 0 };
  const fail = (msg) => { report.ok = false; report.errors.push(msg); };

  const closes = findEpochCloses(fileActs);
  const { structural, payload } = actCommitments(fileActs, R.parseMentions);
  if (blocks.length > closes.length) {
    fail(`chain has ${blocks.length} blocks but the log closes only ${closes.length} epochs`);
    return report;
  }
  if (blocks.length < closes.length) {
    report.warnings.push(`log has ${closes.length - blocks.length} closed epoch(s) not yet sealed`);
  }

  let prev = null;
  const producers = new Set();
  for (let n = 0; n < blocks.length; n++) {
    const b = blocks[n];
    const entry = { height: n + 1, epoch: b.epoch, ok: true, notes: [] };
    const bad = (msg) => { entry.ok = false; entry.notes.push(msg); fail(`block ${n + 1}: ${msg}`); };

    if (b.v !== CHAIN_VERSION || b.net !== NET_ID) bad(`unknown version/net ${b.v}/${b.net}`);
    if (b.height !== n + 1) bad(`height ${b.height}, expected ${n + 1}`);
    if (b.prev !== prev) bad('broken hash link to previous block');

    const start = n === 0 ? 0 : closes[n - 1].idx + 1;
    const end = closes[n].idx;
    if (b.range.start !== start || b.range.end !== end) {
      bad(`range ${b.range.start}-${b.range.end} does not match the log's epoch boundaries ${start}-${end}`);
    } else {
      for (let i = 0; i < end - start + 1; i++) {
        if (b.acts[i] !== structural[start + i]) { bad(`act ${start + i}: structural hash mismatch — the record itself differs`); break; }
      }
      let tomb = 0;
      for (let i = 0; i < end - start + 1; i++) {
        if (b.payloads[i] !== payload[start + i]) {
          if (payloadMayDiffer(fileActs[start + i])) tomb++;
          else { bad(`act ${start + i}: payload differs from its sealed commitment with no redaction stamp`); break; }
        }
      }
      entry.tombstoned = tomb;
      report.tombstoned += tomb;
    }
    if (merkleRoot(b.acts) !== b.actsRoot) bad('actsRoot does not match its own leaf list');
    if (merkleRoot(b.payloads) !== b.payloadsRoot) bad('payloadsRoot does not match its own leaf list');

    if (stateRoot(b.package) !== b.stateRoot) bad('stateRoot does not hash its own package');
    if (entry.ok) {
      const st = replayPrefix(R, fileActs, end);
      let pkg;
      try {
        pkg = epochPackage(st, b.epoch);
      } catch (e) {
        bad('replay does not close epoch ' + b.epoch + ' here: ' + e.message);
      }
      if (pkg) {
        const replayed = canonical(pkg);
        if (replayed !== canonical(b.package)) {
          const drift = editions && (editions.engine !== b.editions.engine || editions.replay !== b.editions.replay);
          if (drift) {
            entry.notes.push('state package differs — ATTRIBUTED to formula-edition drift (sealed under different engine/replay source)');
            report.warnings.push(`block ${n + 1}: sealed under a different formula edition; state not reproducible with current code`);
          } else {
            bad('state package does not replay: same formula editions, different result');
          }
        }
      }
    }

    if (!verifyBlockSignature(b)) bad('signature does not verify against the named producer');
    producers.add(b.producer);
    if (producer && b.producer !== producer) bad('producer is not the pinned key');

    prev = blockHash(b);
    entry.hash = prev;
    report.blocks.push(entry);
  }
  if (producers.size > 1) report.warnings.push(`more than one producer key appears in this chain (${producers.size})`);
  return report;
}
