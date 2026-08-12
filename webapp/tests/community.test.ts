import { describe, it, expect } from 'vitest';
import { communities, type CommunityEdge, type CommunityNode } from '../src/engine/community';

function nodes(...ids: string[]): CommunityNode[] {
  return ids.map((id) => ({ id }));
}

function edge(src: string, tgt: string, weight = 1): CommunityEdge {
  return { src, tgt, weight };
}

/** Two triangles joined by a single link — the textbook two-community graph. */
function twoCliques(): { n: CommunityNode[]; e: CommunityEdge[] } {
  return {
    n: nodes('a', 'b', 'c', 'x', 'y', 'z'),
    e: [
      edge('a', 'b'), edge('b', 'c'), edge('c', 'a'),
      edge('x', 'y'), edge('y', 'z'), edge('z', 'x'),
      edge('c', 'x'), // the bridge
    ],
  };
}

describe('community grouping', () => {
  it('separates two cliques joined by one link', () => {
    const { n, e } = twoCliques();
    const r = communities(n, e);
    expect(r.count).toBe(2);
    // Membership, not label: the two triangles must not mix.
    expect(r.of['a']).toBe(r.of['b']);
    expect(r.of['b']).toBe(r.of['c']);
    expect(r.of['x']).toBe(r.of['y']);
    expect(r.of['y']).toBe(r.of['z']);
    expect(r.of['a']).not.toBe(r.of['x']);
    // A real split scores well above the "this graph does not separate" floor.
    expect(r.q).toBeGreaterThan(0.15);
  });

  it('finds no structure in a complete graph', () => {
    // Everything connected to everything: any partition is as good as any
    // other, so modularity is ~0 and the caller must not present a split.
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const e: CommunityEdge[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) e.push(edge(ids[i]!, ids[j]!));
    }
    const r = communities(nodes(...ids), e);
    expect(r.count).toBe(1);
    expect(r.q).toBeLessThan(0.15);
  });

  it('leaves every node alone when no edge carries weight', () => {
    // A fresh network, or a min-weight filter that excluded everything. This is
    // a real state, not an error.
    const r = communities(nodes('a', 'b', 'c'), [edge('a', 'b', 0)]);
    expect(r.count).toBe(3);
    expect(r.q).toBe(0);
    expect(r.sizes).toEqual([1, 1, 1]);
  });

  it('handles an empty graph without dividing by zero', () => {
    const r = communities([], []);
    expect(r.count).toBe(0);
    expect(r.q).toBe(0);
    expect(Number.isFinite(r.q)).toBe(true);
  });

  it('gives the identical partition on every run', () => {
    // The doctrine: same acts in, same answer out. Ten runs, byte-identical.
    const { n, e } = twoCliques();
    const first = JSON.stringify(communities(n, e));
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(communities(n, e))).toBe(first);
    }
  });

  it('does not depend on the order edges arrive in', () => {
    // Edge order is an artifact of how the caller filtered, not a fact about
    // the graph. Membership must survive a reversal.
    const { n, e } = twoCliques();
    const forward = communities(n, e);
    const backward = communities(n, e.slice().reverse());
    expect(backward.of['a']).toBe(backward.of['c']);
    expect(backward.of['x']).toBe(backward.of['z']);
    expect(backward.of['a']).not.toBe(backward.of['x']);
    expect(backward.count).toBe(forward.count);
    expect(backward.q).toBeCloseTo(forward.q, 12);
  });

  it('numbers the largest community first, and breaks size ties by member id', () => {
    // Colours are assigned by index, so an unrelated act must not be able to
    // permute the legend. Two equal-sized cliques: the one holding the
    // lexicographically smallest member takes index 0.
    const { n, e } = twoCliques();
    const r = communities(n, e);
    expect(r.sizes).toEqual([3, 3]);
    expect(r.of['a']).toBe(0); // 'a' < 'x'
    expect(r.of['x']).toBe(1);
  });

  it('folds a profile onto its account', () => {
    // prof_alice and alice are one person; without folding they would be a
    // two-node community of their own in every graph.
    const personOf = (id: string) => (id.indexOf('prof_') === 0 ? id.slice(5) : id);
    const r = communities(
      nodes('alice', 'prof_alice', 'bob', 'prof_bob'),
      [edge('alice', 'prof_alice'), edge('bob', 'prof_bob'), edge('alice', 'bob')],
      personOf,
    );
    // The two self-pairs drop out entirely, leaving one alice–bob link.
    expect(Object.keys(r.of).sort()).toEqual(['alice', 'bob']);
    expect(r.strength['alice']).toBe(1);
    expect(r.links['alice']).toBe(1);
  });

  it('sums parallel acts between the same pair into one relationship', () => {
    const r = communities(nodes('a', 'b'), [edge('a', 'b', 0.5), edge('b', 'a', 0.25)]);
    expect(r.strength['a']).toBeCloseTo(0.75, 12);
    expect(r.links['a']).toBe(1); // one relationship, two acts
  });

  it('reports weighted degree and link count per node', () => {
    const r = communities(nodes('a', 'b', 'c'), [edge('a', 'b', 2), edge('a', 'c', 3)]);
    expect(r.strength['a']).toBe(5);
    expect(r.strength['b']).toBe(2);
    expect(r.links['a']).toBe(2);
    expect(r.links['b']).toBe(1);
  });

  it('keeps modularity inside its defined range on a lopsided graph', () => {
    // A star: one hub, twenty leaves. Q is defined but low — there is one
    // group and no structure to find.
    const ids = ['hub'];
    const e: CommunityEdge[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push('leaf' + i);
      e.push(edge('hub', 'leaf' + i));
    }
    const r = communities(nodes(...ids), e);
    expect(r.q).toBeGreaterThanOrEqual(-0.5);
    expect(r.q).toBeLessThanOrEqual(1);
    expect(r.sizes.reduce((a, b) => a + b, 0)).toBe(21);
  });

  it('assigns every node to exactly one community', () => {
    const { n, e } = twoCliques();
    const r = communities(n, e);
    const counted = new Array<number>(r.count).fill(0);
    for (const id of Object.keys(r.of)) counted[r.of[id]!] += 1;
    expect(counted).toEqual(r.sizes);
    expect(Object.keys(r.of).length).toBe(6);
  });
});
