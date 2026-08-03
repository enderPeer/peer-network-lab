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
/**
 * Minimum number of routable hops from `sourceId` to every node within `depth`.
 *
 * The signed double cover answers "how strongly does this reach me"; it cannot
 * answer "how far away is it", because a weight of zero is indistinguishable
 * from out-of-range. Readers asked for the distance itself: whether a thing is
 * one hop off or sits beyond the horizon entirely. Same edge-admissibility rule
 * as the cover (routing-inert zero-determinant edges are skipped), so a node
 * that appears here is a node the feed could in principle reach.
 *
 * Nodes further than `depth` are simply absent from the map.
 */
export function hopDistance(
  graph: RawGraph,
  sourceId: string,
  depth = FEED_DEPTH,
): Map<string, number> {
  const dist = new Map<string, number>([[sourceId, 0]]);
  let frontier = new Set<string>([sourceId]);
  for (let d = 1; d <= depth && frontier.size; d++) {
    const next = new Set<string>();
    for (const e of graph.edges) {
      if (e.weight <= 0) continue;
      if (!frontier.has(e.src)) continue;
      if (dist.has(e.tgt)) continue; // first arrival is the minimum
      dist.set(e.tgt, d);
      next.add(e.tgt);
    }
    frontier = next;
  }
  return dist;
}

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
