/**
 * Fork reconciliation: the merge that used to be impossible.
 *
 * Every assertion here is a sentence from HOSTING.md's old warning turned
 * into a check: references minted after a split rebind correctly, revisions
 * follow their posts across the renumbering, nothing is dropped silently,
 * and the whole operation is a pure function — run it twice, get the bytes
 * twice. The scenarios are double-writer scenarios on purpose: they are the
 * exact histories the one-writer rule existed to prevent.
 */
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { R, chainMod, newKey } from './helpers/chain';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => import(pathToFileURL(join(here, '..', 'chain', f)).href);
const { reconcile, commonPrefixLen, forkChainMergeable } = (await load('reconcile.mjs')) as {
  reconcile(o: { baseActs: unknown[]; forkActs: unknown[]; R: unknown }): { merged: any[]; report: any };
  commonPrefixLen(a: unknown[], b: unknown[], pm: unknown): number;
  forkChainMergeable(base: unknown[], fork: unknown[]): boolean;
};

const SEED = { t: 'seedWorld' };
const replay = (fileActs: unknown[]) => (R as any).replay([SEED, ...fileActs]);

/** Three fueled actors and one post — the shared history before the split. */
function prefix() {
  return [
    { t: 'register', id: 'u_x', handle: 'Xena', seed: 1, epoch: 0 },
    { t: 'register', id: 'u_y', handle: 'Yuri', seed: 1, epoch: 0 },
    { t: 'register', id: 'u_z', handle: 'Zoe', seed: 1, epoch: 0 },
    { t: 'burn', id: 'u_x', amt: 2 }, { t: 'burn', id: 'u_y', amt: 2 }, { t: 'burn', id: 'u_z', amt: 2 },
    { t: 'post', author: 'u_x', text: 'hello from the shared prefix', a: 0.8, rmen: [] },
  ];
}
/** The winning host's tail: it kept writing after the split. */
function baseTail() {
  return [
    { t: 'post', author: 'u_y', text: 'written on the winning side', a: 0.8, rmen: [] },
    { t: 'opinion', author: 'u_y', target: 'c1', p: 0.5, r: 0.5 },
  ];
}

const cidOf = (st: any, text: string) => {
  for (const k of Object.keys(st.payloads)) if (st.payloads[k] === text) return k;
  return undefined;
};

describe('fork reconciliation', () => {
  it('fast-forward: a fork that is a pure prefix merges to the base unchanged', () => {
    const base = [...prefix(), ...baseTail()];
    const { merged, report } = reconcile({ baseActs: base, forkActs: prefix(), R });
    expect(merged).toEqual(base);
    expect(report.appended).toBe(0);
    expect(report.dropped).toEqual([]);
  });

  it('rebinds content ids, act-index revisions and comments minted after the split', () => {
    const base = [...prefix(), ...baseTail()];
    // The losing host accepted a parallel world: a post that was ALSO c2 over
    // there, a reaction to it, a comment under it, and an index-referenced
    // revision of it. Every one of these references collides with the base
    // tail's numbering.
    const forkPost = { t: 'post', author: 'u_z', text: 'written on the losing side', a: 0.8, rmen: [] };
    const fork = [...prefix(), forkPost,
      { t: 'opinion', author: 'u_x', target: 'c2', p: 0.6, r: 0.6 },
      { t: 'review', author: 'u_y', target: 'c2', e: 0.7, f: 0.7, text: 'a comment from the fork' },
      { t: 'post', author: 'u_z', text: 'revised on the losing side', a: 0.8, rmen: [], target: 8 }, // replay idx of forkPost
    ];
    const { merged, report } = reconcile({ baseActs: base, forkActs: fork, R });
    expect(report.prefix).toBe(7);
    expect(report.appended).toBe(4);
    expect(report.dropped).toEqual([]);

    const st = replay(merged);
    // The fork post survived under a NEW id (the base tail took c2) and its
    // revision followed it there.
    const cid = cidOf(st, 'revised on the losing side');
    expect(cid).toBeDefined();
    expect(cid).not.toBe('c2');
    expect(st.creators[cid!]).toBe('u_z');
    // The base side's own post kept ITS meaning.
    expect(cidOf(st, 'written on the winning side')).toBe('c2');
    // The fork's reaction and comment both landed on the remapped node, not
    // on the base post that now wears the fork's old number.
    const edges = (st.g.edges as any[]).filter((e) => e.tgt === cid);
    expect(edges.some((e) => e.family === 'Opinion' && e.src === 'u_x')).toBe(true);
    // The comment's A-leg lands on the remapped post (author -> post) and its
    // T-leg mints the comment node FROM that post — both sides of the hyper
    // act crossed the renumbering together.
    expect(edges.some((e) => e.family === 'ReviewA' && e.src === 'u_y')).toBe(true);
    const commentCid = cidOf(st, 'a comment from the fork');
    expect(commentCid).toBeDefined();
    expect((st.g.edges as any[]).some((e) => e.family === 'ReviewT' && e.src === cid && e.tgt === commentCid)).toBe(true);
    // Nothing targets the base's c2 that the fork did not intend for it.
    const c2edges = (st.g.edges as any[]).filter((e) => e.tgt === 'c2' && e.family === 'Opinion');
    expect(c2edges.every((e) => e.src === 'u_y')).toBe(true);
  });

  it('references into the shared prefix cross the merge untouched', () => {
    const base = [...prefix(), ...baseTail()];
    const fork = [...prefix(),
      { t: 'opinion', author: 'u_z', target: 'c1', p: 0.4, r: 0.9 },
      { t: 'post', author: 'u_x', text: 'prefix post, revised from the fork', a: 0.8, rmen: [], target: 7 },
    ];
    const { merged, report } = reconcile({ baseActs: base, forkActs: fork, R });
    expect(report.dropped).toEqual([]);
    const st = replay(merged);
    expect(st.payloads.c1).toBe('prefix post, revised from the fork');
  });

  it('is deterministic: same inputs, byte-identical output', () => {
    const base = [...prefix(), ...baseTail()];
    const fork = [...prefix(),
      { t: 'post', author: 'u_z', text: 'determinism check', a: 0.8, rmen: [] },
      { t: 'opinion', author: 'u_x', target: 'c2', p: 0.6, r: 0.6 },
    ];
    const one = reconcile({ baseActs: base, forkActs: fork, R });
    const two = reconcile({ baseActs: base, forkActs: fork, R });
    expect(JSON.stringify(one.merged)).toBe(JSON.stringify(two.merged));
    expect(JSON.stringify(one.report)).toBe(JSON.stringify(two.report));
  });

  
  it('carries extra epoch closes over and counts them — each one mints', () => {
    const base = [...prefix(), ...baseTail()];
    const fork = [...prefix(), { t: 'closeEpoch', epoch: 1 }];
    const { merged, report } = reconcile({ baseActs: base, forkActs: fork, R });
    expect(report.closeEpochs).toBe(1);
    expect(replay(merged).epochHistory.length).toBe(1);
  });

  it('redaction on one side is not a fork: the structural prefix survives it', () => {
    const base = [...prefix(), ...baseTail()];
    const redacted = prefix();
    // The base redacted the prefix post's payload (lawful deletion path
    // rewrites bytes in place and stamps the act).
    (base[6] as any) = { ...base[6], text: '', redacted: true };
    expect(commonPrefixLen(base, redacted, (R as any).parseMentions)).toBe(7);
  });

  it('refuses a handle registered on both sides — an id is a name, not a position', () => {
    // Both writers accepted the same handle during the split. Appending the
    // fork's register would put two ledger rows under one id AND, because
    // pinHash is last-wins on replay, hand the account's PIN to whoever
    // claimed it on the losing side.
    const base = [...prefix(), { t: 'register', id: 'u_sam', handle: 'Sam', seed: 1, epoch: 0, pinHash: 'base-side-pin' }];
    const fork = [...prefix(), { t: 'register', id: 'u_sam', handle: 'Sam', seed: 1, epoch: 0, pinHash: 'fork-side-pin' }];
    const { merged, report } = reconcile({ baseActs: base, forkActs: fork, R });
    expect(report.appended).toBe(0);
    expect(report.dropped[0].reason).toMatch(/registered on both sides/);
    const st = replay(merged);
    expect(st.pinHash.u_sam).toBe('base-side-pin');
    expect(st.ledgers.filter((l: any) => l.id === 'u_sam').length).toBe(1);
  });

  it('renumbers carried epoch closes into one sequence', () => {
    // Both sides closed "epoch 1". Carrying the label would put epoch 1 in
    // the record twice and mint two full PEER pools for one epoch.
    const base = [...prefix(), { t: 'closeEpoch', epoch: 1 }];
    const fork = [...prefix(), { t: 'post', author: 'u_z', text: 'fork work', a: 0.8, rmen: [] }, { t: 'closeEpoch', epoch: 1 }];
    const { merged, report } = reconcile({ baseActs: base, forkActs: fork, R });
    expect(report.relabelled).toEqual([{ fileIdx: 8, from: 1, to: 2 }]);
    const epochs = replay(merged).epochHistory.map((e: any) => e.epoch);
    expect(epochs).toEqual([1, 2]);
  });

  
  it('refuses to merge under a diverged sealed chain', async () => {
    const key = newKey();
    const proto = { R, editions: { engine: 'e', replay: 'r' }, constants: { theta: 0.1, nu: 0.1, quantum: 1e-9 } };
    const baseActs = [...prefix(), { t: 'closeEpoch', epoch: 1 }];
    const forkActs = [...prefix(), { t: 'post', author: 'u_z', text: 'diverged before sealing', a: 0.8, rmen: [] }, { t: 'closeEpoch', epoch: 1 }];
    const baseBlocks = chainMod.buildBlocks({ fileActs: baseActs, ...proto, key, existing: [] }).blocks;
    const forkBlocks = chainMod.buildBlocks({ fileActs: forkActs, ...proto, key, existing: [] }).blocks;
    expect(forkChainMergeable(baseBlocks, forkBlocks)).toBe(false);
    // …but a fork that sealed nothing beyond the shared chain merges freely.
    expect(forkChainMergeable(baseBlocks, [])).toBe(true);
    expect(forkChainMergeable(baseBlocks, baseBlocks)).toBe(true);
  });
});
