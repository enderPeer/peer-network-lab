import { describe, it, expect } from 'vitest';
import { RawGraph } from '../src/engine/graph';
import { buildHops, scoreCandidate, cograRank, COGRA_DEFAULTS } from '../src/engine/cogra';
import { referenceGraph, REFERENCE_CREATORS } from '../src/engine/fixtures';

const close = (actual: number, expected: number, tol = 2e-3) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);

const PERSON: Record<string, string> = {};
function personOf(id: string): string {
  if (id.startsWith('prof_')) return id.slice(5);
  return PERSON[id] ?? id;
}

function opts(creators: Record<string, string>) {
  return { personOf, creatorOf: (id: string) => creators[id] ?? null };
}

/** Small builder: actors + contents, positive Opinions unless stated. */
function world(): RawGraph {
  const g = new RawGraph();
  for (const a of ['u', 'b', 'x', 'y', 'z']) g.addNode({ id: a, kind: 'Actor', label: a });
  for (const c of ['c1', 'c2']) g.addNode({ id: c, kind: 'Content', label: c });
  for (const a of ['u', 'b', 'x', 'y', 'z']) g.addNode({ id: 'prof_' + a, kind: 'Profile', label: a });
  return g;
}
let n = 0;
function op(g: RawGraph, src: string, tgt: string, p = 0.8, r = 0.8, epoch = 0) {
  g.append({ id: 'q' + ++n, family: 'Opinion', src, tgt, pd: p, pi: r, epoch, tauOverride: 0 });
}

describe('CoGra S(u,c): disjoint-sum extraction', () => {
  it('breadth counts: two disjoint chains sum, funnel through one bridge does not', () => {
    // disjoint: u→x→c1 and u→y→c1
    const g1 = world();
    op(g1, 'u', 'prof_x'); op(g1, 'x', 'c1');
    op(g1, 'u', 'prof_y'); op(g1, 'y', 'c1');
    const s1 = scoreCandidate(buildHops(g1, opts({})), 'u', 'c1', 0);
    expect(s1.paths.length).toBe(2);

    // funnel: u→b, then b→x→c1, b→y→c1, b→z→c1 (min-cut 1 at b)
    const g2 = world();
    op(g2, 'u', 'prof_b');
    for (const m of ['x', 'y', 'z']) { op(g2, 'b', 'prof_' + m); op(g2, m, 'c1'); }
    const s2 = scoreCandidate(buildHops(g2, opts({})), 'u', 'c1', 0);
    expect(s2.paths.length).toBe(1); // amplification ceiling exactly 1×
    expect(s1.S).toBeGreaterThan(s2.S);
  });

  it('zero-jail: a (0,0)-netted bundle kills every path through it', () => {
    const g = world();
    op(g, 'u', 'prof_x', 0.7, 0.6);
    op(g, 'x', 'c1');
    op(g, 'u', 'prof_x', -0.7, -0.6); // counter-record nets the bundle to (0,0)
    const s = scoreCandidate(buildHops(g, opts({})), 'u', 'c1', 0);
    expect(s.paths.length).toBe(0); // absence, not a bucket
  });
});

describe('CoGra sign: balance and taint', () => {
  it('negative directional verdict flips balance; two negatives flip back', () => {
    const g = world();
    op(g, 'u', 'prof_x', -0.8, 0.8); // dislike-but-engage
    op(g, 'x', 'c1', 0.8, 0.8);
    const s = scoreCandidate(buildHops(g, opts({})), 'u', 'c1', 0);
    expect(s.paths[0]!.sigma).toBe(-1);

    const g2 = world();
    op(g2, 'u', 'prof_x', -0.8, 0.8);
    op(g2, 'x', 'prof_y', -0.8, 0.8); // enemy of my enemy
    op(g2, 'y', 'c1', 0.8, 0.8);
    const s2 = scoreCandidate(buildHops(g2, opts({})), 'u', 'c1', 0);
    expect(s2.paths[0]!.sigma).toBe(1);
  });

  it('taint is absorbing: any p̄_i < 0 forces σ = −1, even with positive balance', () => {
    const g = world();
    op(g, 'u', 'prof_x', 0.8, -0.5); // avoid
    op(g, 'x', 'c1', 0.8, 0.8);
    const s = scoreCandidate(buildHops(g, opts({})), 'u', 'c1', 0);
    expect(s.paths[0]!.sigma).toBe(-1);

    const g2 = world();
    op(g2, 'u', 'prof_x', -0.8, -0.5); // hate-and-avoid: balance would need a pair
    op(g2, 'x', 'prof_y', -0.8, -0.5);
    op(g2, 'y', 'c1', 0.8, 0.8);
    const s2 = scoreCandidate(buildHops(g2, opts({})), 'u', 'c1', 0);
    expect(s2.paths[0]!.sigma).toBe(-1); // avoidances never compose into endorsement
  });
});

describe('CoGra recency', () => {
  it('terminal hop decays by epoch age; intermediate hops never do', () => {
    const g = world();
    op(g, 'u', 'prof_x', 0.8, 0.8, 0); // old intermediate stance
    op(g, 'x', 'c1', 0.8, 0.8, 0);     // old terminal stance
    const hops = buildHops(g, opts({}));
    const fresh = scoreCandidate(hops, 'u', 'c1', 0);
    const aged = scoreCandidate(hops, 'u', 'c1', COGRA_DEFAULTS.halfLifeEpochs);
    close(aged.paths[0]!.f, 0.5, 1e-9); // one half-life on the terminal
    close(aged.paths[0]!.m, fresh.paths[0]!.m, 1e-12); // magnitude untouched
    close(aged.S, fresh.S * 0.5, 1e-9);
  });
});

describe('CoGra structural rules', () => {
  it('standing self-bond and control edges never traverse; persons fold', () => {
    const g = world();
    g.append({ id: 'dec', family: 'SelfDeclaration', src: 'x', tgt: 'prof_x', pd: 1, pi: 0.8, tauOverride: 0 });
    g.append({ id: 'rep', family: 'SelfReputation', src: 'prof_x', tgt: 'x', pd: 1, pi: 0.8, tauOverride: 0 });
    op(g, 'u', 'prof_x');
    op(g, 'x', 'c1');
    const hops = buildHops(g, opts({}));
    // the u→x hop exists via person fold; no hop uses the bond
    const all = Array.from(hops.values()).flat();
    expect(all.some((h) => h.key.includes('dec') || h.key.includes('rep'))).toBe(false);
    const s = scoreCandidate(hops, 'u', 'c1', 0);
    expect(s.paths.length).toBe(1);
    expect(s.paths[0]!.nodes).toEqual(['u', 'x', 'c1']);
  });

  it('Types are sinks: paths end at a Type, nothing routes through it', () => {
    const g = world();
    g.addNode({ id: 'type_t', kind: 'Type', label: '#t' });
    op(g, 'u', 'type_t'); // affinity-ish stance toward the type (Opinion for the test)
    op(g, 'u', 'prof_x');
    // tag hyper: x tags c1 with type_t — but nothing may continue OUT of type_t
    g.appendHyper(
      { id: 'tgA1', family: 'TagA', src: 'x', tgt: 'c1', pd: 0.8, pi: 0.8, tauOverride: 0 },
      { id: 'tgT1', family: 'TagT', src: 'c1', tgt: 'type_t', pd: 0.8, pi: 0.8, tauOverride: 0 },
    );
    const hops = buildHops(g, opts({}));
    expect(hops.get('type_t')).toBeUndefined();
  });

  it('T-legs are channel-gated: initiator-owned crosses only through the tagger', () => {
    const g = world();
    g.addNode({ id: 'type_t', kind: 'Type', label: '#t' });
    // stranger x tags creator b's content c1
    op(g, 'b', 'c1'); // just to have c1 populated by someone else
    g.appendHyper(
      { id: 'tgA2', family: 'TagA', src: 'x', tgt: 'c1', pd: 0.8, pi: 0.8, tauOverride: 0 },
      { id: 'tgT2', family: 'TagT', src: 'c1', tgt: 'type_t', pd: 0.8, pi: 0.8, tauOverride: 0 },
    );
    const hops = buildHops(g, opts({ c1: 'b' }));
    // no free carrier→type hop (x is not c1's creator)…
    expect((hops.get('c1') ?? []).some((h) => h.to === 'type_t')).toBe(false);
    // …but a composite x→type hop exists at w̃_A · w̃_T
    const comp = (hops.get('x') ?? []).find((h) => h.to === 'type_t');
    expect(comp).toBeDefined();
  });
});

describe('CoGra over the Appendix F reference graph', () => {
  it('ranks Photo for Bob from his own position, with no standing amplifier', () => {
    const g = referenceGraph();
    const ranked = cograRank(g, 'bob', 0, {
      personOf: (id) => (id === 'profA' ? 'alice' : personOf(id)),
      creatorOf: (id) => REFERENCE_CREATORS[id] ?? null,
      candidates: (nd) => nd.kind === 'Content' || nd.kind === 'Comment',
    });
    const photo = ranked.find((r) => r.node.id === 'photo');
    expect(photo).toBeDefined();
    // Bob's folded ReviewA hop to Photo is his one live path
    expect(photo!.paths.length).toBe(1);
    close(photo!.paths[0]!.m, 0.146, 2e-3);
    expect(photo!.S).toBeGreaterThan(0);
  });

  it('is deterministic: same records, same ranking', () => {
    const g = referenceGraph();
    const o = {
      personOf: (id: string) => (id === 'profA' ? 'alice' : personOf(id)),
      creatorOf: (id: string) => REFERENCE_CREATORS[id] ?? null,
    };
    const a = cograRank(g, 'alice', 0, o).map((r) => r.node.id + ':' + r.S.toFixed(12));
    const b = cograRank(referenceGraph(), 'alice', 0, o).map((r) => r.node.id + ':' + r.S.toFixed(12));
    expect(a).toEqual(b);
  });
});
