import { describe, it, expect } from 'vitest';
import { RawGraph } from '../src/engine/graph';
import { buildHops, scoreCandidate, cograRank, COGRA_DEFAULTS } from '../src/engine/cogra';
import { FAMILIES } from '../src/engine/families';
import { DOMAIN_MASKS, pathView, detScore, dampedWeight } from '../src/engine/tensor';

const personOf = (id: string) => (id.startsWith('prof_') ? id.slice(5) : id);

describe('probe', () => {
  it('P2: max damped weight over all families / params', () => {
    let max = 0;
    let arg = '';
    for (const fam of Object.keys(FAMILIES)) {
      const spec = FAMILIES[fam]!;
      const mask = spec.promoted ? DOMAIN_MASKS.Tribal : DOMAIN_MASKS[spec.domain];
      for (let pd = -1; pd <= 1.0001; pd += 0.05) {
        for (let pi = -1; pi <= 1.0001; pi += 0.05) {
          for (let tau = 0; tau <= 1.0001; tau += 0.05) {
            const w = dampedWeight(detScore(pathView(pd, pi, mask, spec.tier)), tau);
            if (w > max) { max = w; arg = `${fam} pd=${pd.toFixed(2)} pi=${pi.toFixed(2)} tau=${tau.toFixed(2)}`; }
          }
        }
      }
    }
    console.log('MAX WEIGHT', max, arg);
    expect(max).toBeGreaterThan(0);
  });

  it('P1: source === target', () => {
    const g = new RawGraph();
    g.addNode({ id: 'u', kind: 'Actor', label: 'u' });
    g.addNode({ id: 'c1', kind: 'Content', label: 'c1' });
    g.append({ id: 'q1', family: 'Opinion', src: 'u', tgt: 'c1', pd: 0.8, pi: 0.8, tauOverride: 0 });
    const hops = buildHops(g, { personOf, creatorOf: () => null });
    let err: unknown = null;
    try {
      scoreCandidate(hops, 'u', 'u', 0);
    } catch (e) { err = e; }
    console.log('P1 result:', err ? String(err) : 'no throw');
    expect(true).toBe(true);
  });

  it('P1b: cograRank with a candidate whose id equals the viewer person', () => {
    const g = new RawGraph();
    g.addNode({ id: 'u', kind: 'Content', label: 'u' }); // viewer id is also a Content node
    g.addNode({ id: 'c1', kind: 'Content', label: 'c1' });
    g.append({ id: 'q1', family: 'Opinion', src: 'u', tgt: 'c1', pd: 0.8, pi: 0.8, tauOverride: 0 });
    let err: unknown = null;
    try {
      cograRank(g, 'u', 0, { personOf, creatorOf: () => null });
    } catch (e) { err = e; }
    console.log('P1b result:', err ? String(err) : 'no throw');
  });

  it('P3: two parallel direct hops of different families between viewer and candidate', () => {
    const g = new RawGraph();
    g.addNode({ id: 'u', kind: 'Actor', label: 'u' });
    g.addNode({ id: 'c1', kind: 'Content', label: 'c1' });
    g.append({ id: 'pub1', family: 'Publish', src: 'u', tgt: 'c1', pd: 0.8, pi: 1, tauOverride: 0 });
    g.append({ id: 'op1', family: 'Opinion', src: 'u', tgt: 'c1', pd: 0.8, pi: 0.8, tauOverride: 0 });
    const hops = buildHops(g, { personOf, creatorOf: () => 'u' });
    const s = scoreCandidate(hops, 'u', 'c1', 0);
    console.log('P3 paths', s.paths.length, s.paths.map((p) => p.nodes.join('>') + '@' + p.m.toFixed(4)), 'S=', s.S);
  });

  it('P4: DM chat hops appear in the CoGra hop graph', () => {
    const g = new RawGraph();
    g.addNode({ id: 'a', kind: 'Actor', label: 'a' });
    g.addNode({ id: 'b', kind: 'Actor', label: 'b' });
    g.addNode({ id: 'chat_a_b', kind: 'Chat', label: 'chat' });
    g.addNode({ id: 'm1', kind: 'Message', label: 'msg' });
    g.appendHyper(
      { id: 'snA1', family: 'SendA', src: 'a', tgt: 'chat_a_b', pd: 0.8, pi: 0.8 },
      { id: 'snT1', family: 'SendT', src: 'chat_a_b', tgt: 'm1', pd: 0.8, pi: 0.8 },
    );
    const hops = buildHops(g, { personOf, creatorOf: () => null });
    console.log('P4 hops', JSON.stringify(Array.from(hops.entries()).map(([k, v]) => [k, v.map((h) => h.from + '->' + h.to + ':' + h.key + '@' + h.weight.toFixed(4))])));
  });

  it('P5: T-leg mispair - unpaired T-leg is silently dropped', () => {
    const g = new RawGraph();
    g.addNode({ id: 'x', kind: 'Actor', label: 'x' });
    g.addNode({ id: 'c1', kind: 'Content', label: 'c1' });
    g.addNode({ id: 'c2', kind: 'Content', label: 'c2' });
    g.addNode({ id: 'ty', kind: 'Type', label: 'ty' });
    // two hyper acts appended A,A,T,T (non-adjacent legs)
    g.append({ id: 'tgA1', family: 'TagA', src: 'x', tgt: 'c1', pd: 0.8, pi: 0.8, tauOverride: 0 });
    g.append({ id: 'tgA2', family: 'TagA', src: 'x', tgt: 'c2', pd: 0.8, pi: 0.8, tauOverride: 0 });
    g.append({ id: 'tgT1', family: 'TagT', src: 'c1', tgt: 'ty', pd: 0.8, pi: 0.8, tauOverride: 0 });
    g.append({ id: 'tgT2', family: 'TagT', src: 'c2', tgt: 'ty', pd: 0.8, pi: 0.8, tauOverride: 0 });
    const hops = buildHops(g, { personOf, creatorOf: () => 'zz' });
    console.log('P5 hops', JSON.stringify(Array.from(hops.entries()).map(([k, v]) => [k, v.map((h) => h.from + '->' + h.to + ':' + h.key)])));
  });

  it('P6: chi/k/halfLife degenerate configs', () => {
    const g = new RawGraph();
    g.addNode({ id: 'u', kind: 'Actor', label: 'u' });
    g.addNode({ id: 'c1', kind: 'Content', label: 'c1' });
    g.append({ id: 'q1', family: 'Opinion', src: 'u', tgt: 'c1', pd: 0.8, pi: 0.8, tauOverride: 0 });
    const hops = buildHops(g, { personOf, creatorOf: () => null });
    console.log('P6 hl=0', scoreCandidate(hops, 'u', 'c1', 0, { ...COGRA_DEFAULTS, halfLifeEpochs: 0 }).S);
    console.log('P6 hl=Inf', scoreCandidate(hops, 'u', 'c1', 3, { ...COGRA_DEFAULTS, halfLifeEpochs: Infinity }).S);
    console.log('P6 gamma=0', scoreCandidate(hops, 'u', 'c1', 0, { ...COGRA_DEFAULTS, gamma: 0 }).S);
  });

  it('P7: composite hop reuses A-leg raw weight while A-leg bundle is zero-jailed', () => {
    const g = new RawGraph();
    g.addNode({ id: 'u', kind: 'Actor', label: 'u' });
    g.addNode({ id: 'x', kind: 'Actor', label: 'x' });
    g.addNode({ id: 'prof_x', kind: 'Profile', label: 'x' });
    g.addNode({ id: 'c1', kind: 'Content', label: 'c1' });
    g.addNode({ id: 'cm1', kind: 'Comment', label: 'cm1' });
    g.addNode({ id: 'cm2', kind: 'Comment', label: 'cm2' });
    g.append({ id: 'q1', family: 'Opinion', src: 'u', tgt: 'prof_x', pd: 0.8, pi: 0.8, tauOverride: 0 });
    g.appendHyper(
      { id: 'rvA1', family: 'ReviewA', src: 'x', tgt: 'c1', pd: 0.7, pi: 0.7, tauOverride: 0 },
      { id: 'rvT1', family: 'ReviewT', src: 'c1', tgt: 'cm1', pd: 0.7, pi: 0.7, tauOverride: 0 },
    );
    g.appendHyper(
      { id: 'rvA2', family: 'ReviewA', src: 'x', tgt: 'c1', pd: -0.7, pi: -0.7, tauOverride: 0 },
      { id: 'rvT2', family: 'ReviewT', src: 'c1', tgt: 'cm2', pd: 0.7, pi: 0.7, tauOverride: 0 },
    );
    const hops = buildHops(g, { personOf, creatorOf: (id) => (id === 'c1' ? 'zz' : null) });
    console.log('P7 hops', JSON.stringify(Array.from(hops.entries()).map(([k, v]) => [k, v.map((h) => h.from + '->' + h.to + ':' + h.key + '@' + h.weight.toFixed(4))])));
    console.log('P7 score cm1', JSON.stringify(scoreCandidate(hops, 'u', 'cm1', 0).paths.map((p) => p.nodes.join('>'))));
    console.log('P7 score c1', JSON.stringify(scoreCandidate(hops, 'u', 'c1', 0).paths.map((p) => p.nodes.join('>'))));
  });
});
