/**
 * Writer election: a deterministic function of who exists and what they can
 * prove. The rank order is the user-facing promise — longest sealed chain,
 * then longest log, then most active people, then a meaningless stable
 * tiebreak — and these tests pin both the order and its totality: for any
 * two distinct candidates, exactly one outranks the other, whatever the
 * input order. An election two honest observers can disagree about is a
 * partition generator, not an election.
 */
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { activeAuthors, outranks, pickWriter, strictlyLonger } = (await import(
  pathToFileURL(join(here, '..', 'chain', 'election.mjs')).href
)) as {
  activeAuthors(acts: unknown[], now: number, win?: number): number;
  outranks(a: Record<string, unknown>, b: Record<string, unknown>): boolean;
  pickWriter(cs: Array<Record<string, unknown> | null>): Record<string, unknown> | null;
  strictlyLonger(a: Record<string, unknown>, b: Record<string, unknown>): boolean;
};

const c = (chainHeight: number, acts: number, active: number, nodeId: string) =>
  ({ chainHeight, acts, active, nodeId });

describe('writer election', () => {
  it('longest sealed chain wins over everything', () => {
    expect(outranks(c(5, 10, 0, 'zzz'), c(4, 900, 40, 'aaa'))).toBe(true);
  });
  it('then the longest log', () => {
    expect(outranks(c(5, 900, 0, 'zzz'), c(5, 899, 40, 'aaa'))).toBe(true);
  });
  it('then the most active authors', () => {
    expect(outranks(c(5, 900, 3, 'zzz'), c(5, 900, 2, 'aaa'))).toBe(true);
  });
  it('then the lower node id — determinism, not merit', () => {
    expect(outranks(c(5, 900, 3, 'aaa'), c(5, 900, 3, 'zzz'))).toBe(true);
    expect(outranks(c(5, 900, 3, 'zzz'), c(5, 900, 3, 'aaa'))).toBe(false);
  });
  it('is a strict total order on distinct candidates', () => {
    const cs = [c(1, 5, 2, 'a'), c(1, 5, 2, 'b'), c(2, 1, 0, 'c'), c(1, 9, 0, 'd')];
    for (const x of cs) for (const y of cs) {
      if (x === y) continue;
      expect(outranks(x, y)).toBe(!outranks(y, x));
    }
  });
  it('pickWriter ignores input order and null gaps', () => {
    const a = c(3, 50, 1, 'aaa'), b = c(3, 50, 1, 'bbb'), d = c(2, 500, 9, 'ccc');
    expect(pickWriter([d, null, b, a])).toBe(a);
    expect(pickWriter([a, b, d])).toBe(a);
    expect(pickWriter([null])).toBe(null);
  });
  it('a host with no chain and no acts still orders — fields default to zero', () => {
    expect(outranks(c(0, 1, 0, 'b'), { nodeId: 'a' })).toBe(true);
    expect(outranks({ nodeId: 'a' }, { nodeId: 'b' })).toBe(true);
  });

  it('a tiebreak never dethrones a living writer — only a strictly longer record does', () => {
    // Found live: two identical hosts tie-broke on node id and would have
    // demoted each other into mutual mirrors — a network nobody could write
    // to. outranks() may prefer the other host; strictlyLonger() must not.
    const incumbent = c(5, 100, 2, 'zzz');
    const twin = c(5, 100, 9, 'aaa'); // outranks the incumbent on soft fields…
    expect(outranks(twin, incumbent)).toBe(true);
    expect(strictlyLonger(twin, incumbent)).toBe(false); // …but cannot unseat it
    expect(strictlyLonger(c(6, 1, 0, 'aaa'), incumbent)).toBe(true);  // longer chain can
    expect(strictlyLonger(c(5, 101, 0, 'aaa'), incumbent)).toBe(true); // longer log can
    expect(strictlyLonger(c(4, 999, 9, 'aaa'), incumbent)).toBe(false); // shorter chain cannot, whatever the log says
  });

  it('activeAuthors counts distinct recent authors from the public log only', () => {
    const now = 10_000_000;
    const acts = [
      { t: 'post', author: 'u_a', ts: now - 100 },
      { t: 'post', author: 'u_a', ts: now - 200 },          // same person, once
      { t: 'dm', from: 'u_b', to: 'u_a', ts: now - 500 },   // `from` counts
      { t: 'btcBurn', id: 'u_c', txid: 'd75c1e48d9e933381abfcae380f954dd53d5957bb4bf90f503b372d9a1cd086e', sats: 10000, addr: 'bc1qdead', ts: now - 3_599_000 },  // inside the hour
      { t: 'post', author: 'u_old', ts: now - 3_600_001 },  // outside
      { t: 'post', author: 'u_unstamped' },                 // no ts proves no recency
    ];
    expect(activeAuthors(acts, now)).toBe(3);
    expect(activeAuthors(acts, now, 300)).toBe(1); // 300ms window: only u_a's posts are that fresh
  });
});
