import { RawGraph } from './graph';
import type { Ledger, FoldCell } from './standing';

/**
 * Appendix F reference graph: 4 actors, 5 passive nodes, 9 edges.
 * Edges are appended in the fixture's stated append order; τ values then
 * follow from the pre-degree formula exactly as printed in the spec table.
 * (The fixture matures e3→e4 sequentially even though they form one Review
 * act; normative hyper appends share pre-state — see RawGraph.appendHyper.)
 */
export function referenceGraph(): RawGraph {
  const g = new RawGraph();
  g.addNode({ id: 'alice', kind: 'Actor', label: 'Alice' });
  g.addNode({ id: 'bob', kind: 'Actor', label: 'Bob' });
  g.addNode({ id: 'carol', kind: 'Actor', label: 'Carol' });
  g.addNode({ id: 'dave', kind: 'Actor', label: 'Dave' });
  g.addNode({ id: 'profA', kind: 'Profile', label: 'Profile_A' });
  g.addNode({ id: 'photo', kind: 'Content', label: 'Photo' });
  g.addNode({ id: 'comment', kind: 'Comment', label: 'Comment' });
  g.addNode({ id: 'streetart', kind: 'Type', label: 'StreetArt' });
  g.addNode({ id: 'sneakers', kind: 'Item', label: 'Sneakers' });

  g.append({ id: 'e1', family: 'SelfDeclaration', src: 'alice', tgt: 'profA', pd: 1.0, pi: 0.75 });
  g.append({ id: 'e1r', family: 'SelfReputation', src: 'profA', tgt: 'alice', pd: 1.0, pi: 0.75 });
  g.append({ id: 'e2', family: 'Opinion', src: 'alice', tgt: 'photo', pd: 0.9, pi: 0.7 });
  g.append({ id: 'e3', family: 'ReviewA', src: 'bob', tgt: 'photo', pd: 0.7, pi: 0.8 });
  g.append({ id: 'e4', family: 'ReviewT', src: 'photo', tgt: 'comment', pd: 0.8, pi: 0.7 });
  g.append({ id: 'e5', family: 'TagA', src: 'carol', tgt: 'comment', pd: 0.8, pi: 0.9 });
  g.append({ id: 'e6', family: 'TagT', src: 'comment', tgt: 'streetart', pd: 0.9, pi: 0.8 });
  g.append({ id: 'e7', family: 'Affinity', src: 'alice', tgt: 'streetart', pd: 0.6, pi: 0.8 });
  g.append({ id: 'e8', family: 'Owner', src: 'bob', tgt: 'sneakers', pd: 0.7, pi: 1.0 });
  return g;
}

/** Commitment seeds: burn, act count → rate = standing before any vouch paths. */
export const REFERENCE_SEEDS: Ledger[] = [
  { id: 'alice', burnBal: 3, actCount: 10 },
  { id: 'bob', burnBal: 2, actCount: 8 },
  { id: 'carol', burnBal: 4, actCount: 12 },
  { id: 'dave', burnBal: 1, actCount: 5 },
];

/** Content creator map for the reference graph (Photo is Alice's). */
export const REFERENCE_CREATORS: Record<string, string> = {
  photo: 'alice',
  comment: 'bob',
  streetart: 'carol',
  sneakers: 'bob',
};

/**
 * Appendix F reference epoch (5 actors incl. Eve): final ledger, compiled
 * person-vouch fold cells, per-author Δ act counts, and the certified
 * equilibrium at the accepted rung (full tilt strength 1).
 */
export const REFERENCE_EPOCH = {
  ledgers: [
    { id: 'alice', burnBal: 1.2944, actCount: 12 },
    { id: 'bob', burnBal: 1.2472, actCount: 11 },
    { id: 'carol', burnBal: 1.1472, actCount: 10 },
    { id: 'dave', burnBal: 0.2, actCount: 2 },
    { id: 'eve', burnBal: 0.9, actCount: 8 },
  ] as Ledger[],
  cells: [
    { src: 'alice', rcp: 'bob', coeff: 0.8638 },
    { src: 'alice', rcp: 'carol', coeff: 0.635 },
    { src: 'alice', rcp: 'eve', coeff: 0.3969 },
    { src: 'bob', rcp: 'carol', coeff: 0.7742 },
    { src: 'bob', rcp: 'dave', coeff: 0.6841 },
    { src: 'bob', rcp: 'eve', coeff: 0.5062 },
    { src: 'carol', rcp: 'dave', coeff: 0.8085 },
    { src: 'carol', rcp: 'eve', coeff: 0.7329 },
    { src: 'dave', rcp: 'eve', coeff: 0.772 },
  ] as FoldCell[],
  deltaActs: new Map<string, number>([
    ['alice', 2],
    ['bob', 1],
    ['carol', 1],
    ['dave', 2],
    ['eve', 0],
  ]),
  expectedX: [1.0786557, 1.1051839, 1.1201615, 1.1159692, 1.1171834],
  expectedEpochStamp: 1.102,
  expectedHeadroom: 0.615,
};
