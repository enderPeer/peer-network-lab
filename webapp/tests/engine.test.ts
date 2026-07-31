import { describe, it, expect } from 'vitest';
import { fpl, fpm, binaryEntropy, boltzmann } from '../src/engine/kernels';
import {
  DOMAIN_MASKS,
  sentimentSlice,
  pathView,
  frobenius,
  detScore,
  detSign,
  dampedWeight,
} from '../src/engine/tensor';
import { referenceGraph, REFERENCE_SEEDS, REFERENCE_CREATORS } from '../src/engine/fixtures';
import { doubleCoverBFS } from '../src/engine/traversal';
import { rankFeed } from '../src/engine/feed';
import { RawGraph } from '../src/engine/graph';
import { transmission, dependencyWeights, canValue } from '../src/engine/can';
import registry from './registry.json';

const reg = registry as Record<string, number>;

// Displayed spec decimals are rounded to 3 places; compare at that grain.
const close = (actual: number, expected: number, tol = 2e-3) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);

describe('kernel clamps (Appendix F table)', () => {
  it('f_pl values', () => {
    close(fpl(1), 0.8, 1e-9); // exact 4/5
    close(fpl(0.63), 0.705);
    close(fpl(0.7), 0.725);
    close(fpl(0.9), 0.777);
    close(fpl(0.48), 0.66);
    close(fpl(0.75), 0.739);
    close(fpl(0.05), 0.517);
  });
  it('f_pm values', () => {
    close(fpm(0.63), 0.394);
    close(fpm(0.7), 0.438);
    close(fpm(0.9), 0.556);
    close(fpm(1), 0.609);
    close(fpm(0.75), 0.469);
    close(fpm(0.05), 0.026);
    close(fpm(0.0025), 0.00125);
  });
  it('entropy and Boltzmann landmarks', () => {
    close(binaryEntropy(0.5), Math.log(2), 1e-12);
    close(boltzmann(0.5), 0.383);
    close(boltzmann(2 / 3), 0.414);
    close(boltzmann(0.75), 0.459);
    expect(boltzmann(0)).toBe(1);
  });
});

describe('reference graph edge table (9 edges × 7 quantities)', () => {
  const g = referenceGraph();
  const byId = new Map(g.edges.map((e) => [e.id, e]));
  const rows: Array<[string, number, number, number, number]> = [
    // id, ‖Ψ‖_F, det_score, τ, damped weight
    ['e1', 1.784, 0.588, 0.0, 0.588],
    ['e1r', 1.784, 0.588, 0.5, 0.252],
    ['e2', 1.798, 0.35, 2 / 3, 0.174],
    ['e3', 1.733, 0.342, 0.5, 0.146],
    ['e4', 1.662, 0.077, 2 / 3, 0.038],
    ['e5', 1.762, 0.079, 0.5, 0.034],
    ['e6', 1.762, 0.079, 2 / 3, 0.04],
    ['e7', 1.613, 0.073, 0.75, 0.042],
    ['e8', 1.863, 0.355, 0.5, 0.152],
  ];
  for (const [id, frob, score, tau, weight] of rows) {
    it(`${id}: norm/score/τ/weight`, () => {
      const e = byId.get(id)!;
      expect(e).toBeDefined();
      close(e.frob, frob);
      close(e.score, score);
      expect(Math.abs(e.tau - tau)).toBeLessThanOrEqual(1e-9);
      close(e.weight, weight);
      expect(e.sign).toBe(1);
    });
  }
});

describe('adversarial + special tensors', () => {
  it('spam edge (p=r=0.05, τ=0.5, Tribal full)', () => {
    const pv = pathView(0.05, 0.05, DOMAIN_MASKS.Tribal, 'full');
    close(detScore(pv), 0.025, 1e-3);
    close(dampedWeight(detScore(pv), 0.5), 0.011, 1e-3);
    close(frobenius(sentimentSlice(0.05, 0.05, DOMAIN_MASKS.Tribal)), 1.195);
  });
  it('control tensor (Minimal, p_d=p_i=1)', () => {
    const pv = pathView(1, 1, DOMAIN_MASKS.Minimal, 'marginal');
    close(detScore(pv), 0.153);
    close(frobenius(sentimentSlice(1, 1, DOMAIN_MASKS.Minimal)), 1.817);
  });
  it('half-tier Accept (0.7, 0.8, τ=0)', () => {
    const pv = pathView(0.7, 0.8, DOMAIN_MASKS.Tribal, 'half');
    close(detScore(pv), 0.217);
    expect(detSign(pv)).toBe(1);
  });
  it('mask promotion 4.5× (e8 params, restricted vs promoted)', () => {
    const restricted = pathView(0.7, 1.0, DOMAIN_MASKS.Economic, 'marginal');
    const promoted = pathView(0.7, 1.0, DOMAIN_MASKS.Tribal, 'full');
    close(detScore(restricted), 0.079);
    close(detScore(promoted), 0.355);
  });
});

describe('double-cover BFS', () => {
  it('parity blocking: Accept(+1) then Ratify(−1) chain', () => {
    const g = new RawGraph();
    g.addNode({ id: 'dave', kind: 'Actor', label: 'Dave' });
    g.addNode({ id: 'mid', kind: 'Actor', label: 'Mid' });
    g.addNode({ id: 'carol', kind: 'Actor', label: 'Carol' });
    g.append({ id: 'acc', family: 'Accept', src: 'dave', tgt: 'mid', pd: 0.7, pi: 0.8, tauOverride: 0 });
    g.append({ id: 'rat', family: 'Ratify', src: 'mid', tgt: 'carol', pd: -0.7, pi: 0.8, tauOverride: 0 });
    const reg2 = doubleCoverBFS(g, 'dave');
    close(reg2.get('mid')!.pos, 0.217);
    close(reg2.get('carol')!.neg, 0.047);
    expect(reg2.get('carol')!.pos).toBe(0);
  });

  it('path products on the reference graph', () => {
    const g = referenceGraph();
    const fromBob = doubleCoverBFS(g, 'bob');
    close(fromBob.get('photo')!.pos, 0.146);
    // Bob → StreetArt via e3·e4·e6 = 0.146·0.038·0.040
    close(fromBob.get('streetart')!.pos, 2.2e-4, 5e-5);
    const fromAlice = doubleCoverBFS(g, 'alice');
    close(fromAlice.get('streetart')!.pos, 0.042); // direct e7 beats the long path
  });
});

describe('feed relevance', () => {
  it('S(Bob, Photo) = 0.146 · (1+3.000) · 1.798 ≈ 1.053', () => {
    const g = referenceGraph();
    const rates = new Map(REFERENCE_SEEDS.map((l) => [l.id, l.burnBal / l.actCount]));
    const feed = rankFeed(
      g,
      'bob',
      (id) => rates.get(id) ?? 0,
      (nodeId) => REFERENCE_CREATORS[nodeId] ?? null,
    );
    const photo = feed.find((f) => f.node.id === 'photo')!;
    expect(photo).toBeDefined();
    close(photo.contentNorm, 1.798);
    close(photo.amplifier, 4.0, 1e-6);
    close(photo.relevance, 1.053, 5e-3);
  });
});

describe('CAN attribution', () => {
  it('Bob reviewer: trans 0.629, canval 1.069', () => {
    const norms = [1.733, 1.662];
    close(transmission(norms), 0.629);
    const w = dependencyWeights(norms);
    close(w[0]!, 0.51);
    close(w[1]!, 0.49);
    close(canValue({ childNorms: norms, childValues: norms }), 1.069);
  });
  it('parasitic wrapper gets 1% vs curator 60%', () => {
    close(canValue({ childNorms: [0.01], childValues: [1.798] }), 0.018, 1e-3);
    close(canValue({ childNorms: [1.5], childValues: [1.798] }), 1.079, 1e-3);
  });
});

describe('registry spot checks', () => {
  it('key constants present and consistent', () => {
    expect(reg['const.activation.beta_2ln2']).toBeCloseTo(1.386, 3);
    expect(reg['const.graph.bleed']).toBeCloseTo(0.05, 9);
    expect(reg['const.comparator.numeraire']).toBeCloseTo(0.1, 9);
  });
});
