/**
 * The epoch chain: signed blocks over the act log, one per closeEpoch.
 *
 * What must hold, in order of importance:
 *
 * 1. The chain is a PUBLICATION, not an authority — every root replays from
 *    the log through the same replay.cjs everything else runs, and a verifier
 *    that disagrees can say exactly why (link, signature, structure, payload,
 *    state, or edition drift). No third outcome.
 * 2. Sealing is deterministic to the byte: same log, same key, same blocks.
 *    Anything less and two honest builders publish two "chains".
 * 3. Lawful redaction — the tombstone path that blanks payload bytes in
 *    place — does NOT break sealed blocks. Deletion already promises to be
 *    scoring-neutral; here that promise extends to chain-neutral: structure
 *    and state still verify, and the sealed payload hash survives as the
 *    retained commitment residue.
 * 4. Everything else — a changed parameter, a reordered log, a forged
 *    signature, an edited balance — fails loudly and names its block.
 */
import { describe, it, expect } from 'vitest';
import { seed } from './helpers/world';
import { R, build, verify, newKey, blockMod, canonicalMod, type Block } from './helpers/chain';

/** seed() without its seedWorld line: chain code prepends its own. */
function fileSeed(...names: string[]) {
  return seed(...names).slice(1) as Record<string, unknown>[];
}
function world(...names: string[]) {
  const acts = fileSeed(...names);
  // A proven Bitcoin burn each: token weight comes from destroyed value now,
  // not from the faucet, so a fixture that only faucets distributes nothing
  // and these sealing tests would have no economy to seal.
  for (const n of names) {
    const txid = (n + ':chain').split('').map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('').slice(0, 64).padEnd(64, 'c');
    acts.push({ t: 'btcBurn', id: 'u_' + n, txid, sats: 1000, addr: 'bc1qdead' });
  }
  return acts;
}
const post = (who: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ t: 'post', author: 'u_' + who, text, a: 0.8, ...extra });
const like = (who: string, cid: string) => ({ t: 'opinion', author: 'u_' + who, target: cid, p: 0.8, r: 0.8 });
const close = (epoch: number) => ({ t: 'closeEpoch', epoch, ts: 1700000000000 + epoch });

const clone = (acts: Record<string, unknown>[]) => acts.map((a) => ({ ...a }));

describe('sealing', () => {
  it('seals one linked, signed block per closeEpoch and verifies clean', () => {
    const acts = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), like('bo', 'c1'), close(1),
      post('bo', 'Q', { rmen: [] }), like('al', 'c2'), close(2)];
    const { blocks, sealed, pendingActs } = build(acts);
    expect(sealed).toBe(2);
    expect(pendingActs).toBe(0);
    expect(blocks[0].height).toBe(1);
    expect(blocks[0].prev).toBeNull();
    expect(blocks[1].prev).toBe(blockMod.blockHash(blocks[0]));
    expect(blocks[1].range.start).toBe(blocks[0].range.end + 1);
    for (const b of blocks) expect(blockMod.verifyBlockSignature(b)).toBe(true);

    const report = verify(acts, blocks);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.height).toBe(2);
  });

  it('is deterministic to the byte: same log, same key, same blocks', () => {
    const acts = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), like('bo', 'c1'), close(1)];
    const key = newKey();
    const one = build(clone(acts), key).blocks;
    const two = build(clone(acts), key).blocks;
    expect(one.map((b) => canonicalMod.canonical(b))).toEqual(two.map((b) => canonicalMod.canonical(b)));
  });

  it('builds incrementally: sealed blocks are reused verbatim, only new epochs are signed', () => {
    const key = newKey();
    const first = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), like('bo', 'c1'), close(1)];
    const chain1 = build(first, key).blocks;
    const extended = [...clone(first), post('bo', 'Q', { rmen: [] }), close(2)];
    const { blocks, sealed } = build(extended, key, chain1);
    expect(sealed).toBe(1);
    expect(canonicalMod.canonical(blocks[0])).toBe(canonicalMod.canonical(chain1[0]));
    expect(verify(extended, blocks).ok).toBe(true);
  });

  it('a log with closed epochs the chain has not sealed is a warning, not a fault', () => {
    const acts = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), close(1), close(2)];
    const { blocks } = build(acts.slice(0, -1));
    const report = verify(acts, blocks);
    expect(report.ok).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/not yet sealed/);
  });
});

describe('the economic layer, sealed', () => {
  it('commits the epoch package: mint, distribution, ledgers, standing, certificate', () => {
    const acts = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), like('bo', 'c1'), close(1)];
    const { blocks } = build(acts);
    const pkg = blocks[0].package;
    expect(pkg.epoch).toBe(1);
    expect(pkg.tokens.supply.PEER).toBe(5000);
    expect(pkg.tokens.dist[0].to.u_al).toBe(5000);       // engagement pays the creator
    expect(pkg.tokens.bal.PEER.u_al).toBe(5000);
    expect(pkg.certificate.epoch).toBe(1);
    expect(typeof pkg.certificate.stamp).toBe('number'); // the deferred solve settled at seal
    expect(pkg.ledgers.map((l: { id: string }) => l.id)).toContain('u_al');
    expect(Object.keys(pkg.standing).length).toBeGreaterThan(0);
    expect(blocks[0].stateRoot).toBe(hashOf(pkg)); // the root hashes exactly its package
  });

  it('seals pools and later balances into later blocks', () => {
    const acts = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), like('bo', 'c1'), close(1),
      { t: 'assetCreate', author: 'u_al', sym: 'TBTC', name: 'test unit', supply: 0.01 },
      { t: 'poolCreate', author: 'u_al', symA: 'PEER', symB: 'TBTC', amtA: 100, amtB: 0.005 },
      close(2)];
    const { blocks } = build(acts);
    expect(Object.keys(blocks[0].package.pools)).toHaveLength(0);
    const pool = blocks[1].package.pools['PEER/TBTC'];
    expect(pool).toBeDefined();
    expect(pool.resA).toBe(100);
    expect(pool.resB).toBe(0.005);
    expect(verify(acts, blocks).ok).toBe(true);
  });
});

describe('lawful redaction — chain-neutral by construction', () => {
  it('a sealed post deleted later still verifies: structure holds, payload becomes residue, state replays', () => {
    // '@bo' and no rmen: the seal must materialise resolved mentions exactly
    // the way redaction will, or this test's second half cannot pass.
    const acts = [...world('al', 'bo'), post('al', 'hey @bo look', {}), like('bo', 'c1'), close(1)];
    const { blocks } = build(acts);

    // the server's redactPostAct, verbatim: stamp rmen, blank text, drop
    // media, stamp redacted — in place, same line count
    const redacted = clone(acts);
    const idx = redacted.findIndex((a) => a.t === 'post');
    const handles: Record<string, string> = { alice: 'Alice', bob: 'Bob', carol: 'Carol', dave: 'Dave', u_al: 'al', u_bo: 'bo' };
    redacted[idx] = { ...redacted[idx], rmen: R.parseMentions(String(redacted[idx].text), handles), text: '', redacted: true };
    delete redacted[idx].media;

    const report = verify(redacted, blocks);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tombstoned).toBe(1); // the sealed payload hash survives as residue
  });

  it('a payload change WITHOUT the redaction stamp is tampering, not deletion', () => {
    const acts = [...world('al', 'bo'), post('al', 'original', { rmen: [] }), like('bo', 'c1'), close(1)];
    const { blocks } = build(acts);
    const forged = clone(acts);
    const idx = forged.findIndex((a) => a.t === 'post');
    forged[idx] = { ...forged[idx], text: 'rewritten history' };
    const report = verify(forged, blocks);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/payload differs .* no redaction stamp/);
  });

  it('the redaction stamp does not license SUBSTITUTING content — only removing it', () => {
    // The attack the tightened payloadMayDiffer closes: a party who serves the
    // log sets redacted:true but fills the payload with NEW text instead of the
    // blanked residue. The structural hash strips text, so only the payload
    // check stands between this and an authentic-looking rewrite of a sealed post.
    const acts = [...world('al', 'bo'), post('al', 'the real thing', { rmen: [] }), like('bo', 'c1'), close(1)];
    const { blocks } = build(acts);
    const forged = clone(acts);
    const idx = forged.findIndex((a) => a.t === 'post');
    forged[idx] = { ...forged[idx], text: 'a forgery wearing the tombstone', redacted: true };
    const report = verify(forged, blocks);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/payload differs .* no redaction stamp/);
    expect(report.tombstoned).toBe(0); // it was NOT accepted as a lawful tombstone
  });

  it('a lawful blanked redaction is still accepted (the residue, not the stamp, is what passes)', () => {
    const acts = [...world('al', 'bo'), post('al', 'to be removed', { rmen: [] }), like('bo', 'c1'), close(1)];
    const { blocks } = build(acts);
    const redacted = clone(acts);
    const idx = redacted.findIndex((a) => a.t === 'post');
    redacted[idx] = { ...redacted[idx], text: '', redacted: true }; // residue: empty text, no media/place
    const report = verify(redacted, blocks);
    expect(report.ok).toBe(true);
    expect(report.tombstoned).toBe(1);
  });
});

describe('tampering fails loudly and names its block', () => {
  const sealedWorld = () => {
    const acts = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), like('bo', 'c1'), close(1)];
    return { acts, chain: build(acts).blocks };
  };

  it('a changed act parameter breaks the structural commitment', () => {
    const { acts, chain } = sealedWorld();
    const forged = clone(acts);
    const idx = forged.findIndex((a) => a.t === 'opinion');
    forged[idx] = { ...forged[idx], p: -0.8 }; // flip a sealed stance
    const report = verify(forged, chain);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/structural hash mismatch/);
  });

  it('a reordered log breaks the structural commitment', () => {
    const { acts, chain } = sealedWorld();
    const forged = clone(acts);
    const i = forged.findIndex((a) => a.t === 'post');
    [forged[i], forged[i + 1]] = [forged[i + 1], forged[i]];
    expect(verify(forged, chain).ok).toBe(false);
  });

  it('an edited state package fails its own root, and an edited root fails the signature', () => {
    const { acts, chain } = sealedWorld();
    const richer: Block = JSON.parse(JSON.stringify(chain[0]));
    richer.package.tokens.bal.PEER.u_bo = 1e9; // print money in the publication
    const r1 = verify(acts, [richer]);
    expect(r1.ok).toBe(false);
    expect(r1.errors.join(' ')).toMatch(/stateRoot/);

    // fix the root but not the signature: the producer never signed this
    const r2 = verify(acts, [{ ...richer, stateRoot: hashOf(richer.package) }]);
    expect(r2.ok).toBe(false);
    expect(r2.errors.join(' ')).toMatch(/signature/);
  });

  it('a block signed by someone else fails a producer pin', () => {
    const { acts } = sealedWorld();
    const impostor = build(acts, newKey()).blocks;
    const honest = build(acts, newKey()).blocks;
    const report = verify(acts, impostor, { producer: honest[0].producer });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/pinned key/);
  });

  it('an elected failover produces a legitimately two-producer chain — a SET pin accepts it, a single pin does not', () => {
    // The failover case G6 must not break: epoch 1 sealed by producer A, then
    // A dies, B is elected and seals epoch 2 with its own key. The chain is
    // genuinely two-producer.
    const kA = newKey();
    const kB = newKey();
    const base = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), like('bo', 'c1'), close(1)];
    const c1 = build(base, kA).blocks;
    const ext = [...clone(base), post('bo', 'Q', { rmen: [] }), close(2)];
    const c2 = build(ext, kB, c1).blocks; // block 1 reused (A), block 2 signed by B
    expect(c2[0].producer).toBe(kA.pub);
    expect(c2[1].producer).toBe(kB.pub);

    // A PEER_PRODUCER set listing both keys accepts it.
    expect(verify(ext, c2, { producer: [kA.pub, kB.pub] }).ok).toBe(true);
    // No pin at all: multi-producer is a warning, not a fault — this is the
    // mirror's default (unpinned), so automatic failover to a new producer works.
    expect(verify(ext, c2).ok).toBe(true);
    // Pinning ONLY to A rejects B's block — a deliberately strict PEER_PRODUCER
    // refuses the handoff until the operator adds B's key, exactly as documented.
    const strict = verify(ext, c2, { producer: kA.pub });
    expect(strict.ok).toBe(false);
    expect(strict.errors.join(' ')).toMatch(/pinned key/);
  });

  it('a broken hash link is a fault', () => {
    const acts = [...world('al', 'bo'), post('al', 'P', { rmen: [] }), like('bo', 'c1'), close(1),
      post('bo', 'Q', { rmen: [] }), close(2)];
    const { blocks } = build(acts);
    const cut: Block[] = [blocks[0], { ...blocks[1], prev: blocks[1].actsRoot }];
    const report = verify(acts, cut);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/hash link|signature/);
  });
});

/** sha256 over the canonical form — mirrors package.mjs's stateRoot. */
import { createHash } from 'node:crypto';
function hashOf(v: unknown): string {
  return createHash('sha256').update(canonicalMod.canonical(v)).digest('hex');
}
