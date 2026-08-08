// Anchoring this chain into Bitcoin itself, for nothing.
//
// The epoch chain proves internal consistency: every act commitment, every
// merkle root, every signature. What it cannot prove on its own is WHEN — a
// producer holding the key could seal sixty blocks this afternoon and date
// them last month, and nothing inside the chain would contradict it.
//
// OpenTimestamps fixes exactly that, and it is the one Bitcoin integration
// available here with no money and no key. Public calendar servers collect
// hashes, batch thousands of them into one merkle tree, and publish the root
// in a real Bitcoin transaction — paying the fee themselves. What comes back
// is a proof that your hash was included, which anyone can verify against
// the Bitcoin blockchain forever, with no account, no API key and no trust
// in this host or in the calendars.
//
// So: the token cannot be on Bitcoin without money, but the RECORD can, and
// the record is the part that actually matters. A block hash anchored at
// height H is a claim no one can backdate, including the operator.
//
//   node chain/timestamp.mjs stamp          # anchor the current chain head
//   node chain/timestamp.mjs list           # what has been anchored
//
// Proofs land in server-data/chain/stamps/<blockhash>.ots — the standard
// format, so `ots verify <file>` from the reference client checks them with
// nothing of ours involved. That is deliberate: a proof only this codebase
// can read would be worth very little.
//
// Zero dependencies. The submission protocol is a plain POST of 32 bytes.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(process.env.PEER_DATA_DIR || join(here, '..', 'server-data'));
const CHAIN_DIR = join(DATA, 'chain');
const STAMP_DIR = join(CHAIN_DIR, 'stamps');

// The public calendars. All five are submitted to, and any ONE of them
// landing is enough — they are independent operators, and the point of
// asking several is that no single one can decide your record is untimed.
const CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
  'https://finney.calendar.eternitywall.com',
];

/**
 * The chain tip: its height and its HASH.
 *
 * A block does not carry its own hash — `prev` chains backward and the tip's
 * hash is derived — so it is recomputed here with the same blockHash() the
 * chain and the verifier use. Reading it out of HEAD.json instead would
 * anchor whatever that file happened to say; recomputing anchors the block.
 */
export async function chainHead() {
  const f = join(CHAIN_DIR, 'blocks.jsonl');
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const block = JSON.parse(lines[lines.length - 1]);
  const { blockHash } = await import('./block.mjs');
  return { block, height: block.height, hash: blockHash(block) };
}

/**
 * Submit one 32-byte digest to the calendars.
 *
 * OpenTimestamps' submission endpoint takes the raw digest as the request
 * body and answers with a serialised timestamp — the path from your digest
 * up to whatever the calendar will later publish. It is stored verbatim: a
 * proof this code reinterpreted would be a proof about this code.
 */
export async function submit(digest) {
  if (!(digest instanceof Buffer) || digest.length !== 32) throw new Error('digest must be 32 bytes');
  const got = [];
  await Promise.all(CALENDARS.map(async (base) => {
    try {
      const r = await fetch(base + '/digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/vnd.opentimestamps.v1' },
        body: digest,
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) { got.push({ calendar: base, ok: false, why: 'HTTP ' + r.status }); return; }
      const proof = Buffer.from(await r.arrayBuffer());
      if (!proof.length) { got.push({ calendar: base, ok: false, why: 'empty proof' }); return; }
      got.push({ calendar: base, ok: true, proof });
    } catch (e) {
      got.push({ calendar: base, ok: false, why: String(e.message || e).slice(0, 60) });
    }
  }));
  return got;
}

/**
 * Anchor the chain head.
 *
 * The digest is sha256 of the block's own hash string — not of the whole
 * block. The block hash already commits to every root inside it, so
 * anchoring the hash anchors the block, and doing it this way means anyone
 * can recompute the digest from the published chain without holding our
 * files.
 */
export async function stampHead() {
  const head = await chainHead();
  if (!head) return { ok: false, why: 'no block has been sealed yet — nothing to anchor' };
  const digest = createHash('sha256').update(head.hash, 'utf8').digest();
  mkdirSync(STAMP_DIR, { recursive: true });

  const results = await submit(digest);
  const good = results.filter((r) => r.ok);
  if (!good.length) {
    return { ok: false, height: head.height, why: 'no calendar answered', tried: results.map((r) => r.calendar) };
  }
  // One file per calendar: independent proofs, independently verifiable, and
  // one calendar going out of business later does not take the others with
  // it. That redundancy is the whole reason for asking five.
  const written = [];
  for (const g of good) {
    const name = head.hash.slice(0, 16) + '.' + new URL(g.calendar).hostname.split('.')[0] + '.ots';
    writeFileSync(join(STAMP_DIR, name), g.proof);
    written.push(name);
  }
  const meta = {
    height: head.height, blockHash: head.hash, digest: digest.toString('hex'),
    submittedAt: new Date().toISOString(),
    calendars: good.map((g) => g.calendar),
    failed: results.filter((r) => !r.ok).map((r) => ({ calendar: r.calendar, why: r.why })),
    note: 'A calendar proof becomes a Bitcoin attestation once the calendar publishes its next batch — usually within hours. Upgrade and verify with the reference client: `ots upgrade <file>` then `ots verify <file>`.',
  };
  writeFileSync(join(STAMP_DIR, head.hash.slice(0, 16) + '.json'), JSON.stringify(meta, null, 2));
  return { ok: true, ...meta, files: written };
}

/** Everything anchored so far, newest first. */
export function listStamps() {
  if (!existsSync(STAMP_DIR)) return [];
  return readdirSync(STAMP_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(join(STAMP_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.height - a.height);
}

if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) {
  const cmd = process.argv[2] || 'stamp';
  if (cmd === 'list') {
    const all = listStamps();
    if (!all.length) console.log('nothing anchored yet');
    for (const s of all) console.log(`block ${s.height}  ${s.blockHash.slice(0, 16)}…  ${s.submittedAt}  ${s.calendars.length} calendar(s)`);
  } else {
    const out = await stampHead();
    if (!out.ok) { console.error('not anchored: ' + out.why); process.exit(1); }
    console.log(`anchored block ${out.height} (${out.blockHash.slice(0, 16)}…) into Bitcoin via ${out.calendars.length} calendar(s)`);
    for (const c of out.calendars) console.log('  ' + c);
    for (const f of out.failed) console.log('  (no answer: ' + f.calendar + ' — ' + f.why + ')');
    console.log('proofs: ' + join(STAMP_DIR, ''));
    console.log('verify with the reference client: ots upgrade <file> && ots verify <file>');
  }
}
