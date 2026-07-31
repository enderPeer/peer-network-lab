import { FEED_DEPTH } from './constants';
import type { RawGraph } from './graph';

export interface CoverRegisters {
  /** Max product weight over positive-parity paths from the source. */
  pos: number;
  /** Same for negative parity. */
  neg: number;
}

/**
 * Exact Signed Raw Traversal (double-cover BFS), depth-bounded max-product.
 * s = +1 preserves parity; s = −1 swaps registers. No pruning threshold.
 * On an all-positive graph the pos register equals the feed-ranking BFS state.
 */
export function doubleCoverBFS(
  graph: RawGraph,
  sourceId: string,
  depth = FEED_DEPTH,
): Map<string, CoverRegisters> {
  const reg = new Map<string, CoverRegisters>();
  const get = (id: string): CoverRegisters => {
    let r = reg.get(id);
    if (!r) {
      r = { pos: 0, neg: 0 };
      reg.set(id, r);
    }
    return r;
  };
  get(sourceId).pos = 1;

  // Depth-layered registers W_d±.
  let layer = new Map<string, CoverRegisters>([[sourceId, { pos: 1, neg: 0 }]]);
  for (let d = 1; d <= depth; d++) {
    const next = new Map<string, CoverRegisters>();
    for (const e of graph.edges) {
      if (e.weight <= 0) continue; // routing-inert zero-determinant edge
      const from = layer.get(e.src);
      if (!from) continue;
      let t = next.get(e.tgt);
      if (!t) {
        t = { pos: 0, neg: 0 };
        next.set(e.tgt, t);
      }
      if (e.sign > 0) {
        t.pos = Math.max(t.pos, from.pos * e.weight);
        t.neg = Math.max(t.neg, from.neg * e.weight);
      } else {
        t.pos = Math.max(t.pos, from.neg * e.weight);
        t.neg = Math.max(t.neg, from.pos * e.weight);
      }
    }
    for (const [id, w] of next) {
      const r = get(id);
      r.pos = Math.max(r.pos, w.pos);
      r.neg = Math.max(r.neg, w.neg);
    }
    layer = next;
  }
  return reg;
}
