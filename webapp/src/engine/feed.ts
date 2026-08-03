import { NU } from './constants';
import { DOMAIN_MASKS, sentimentSlice, frobenius } from './tensor';
import type { RawGraph, NodeInfo } from './graph';
import { doubleCoverBFS } from './traversal';

export interface FeedEntry {
  node: NodeInfo;
  /** Positive-parity max-product BFS register (viewer → content). */
  bfsWeight: number;
  /** Creator amplifier 1 + standing(creator)/ν; 1 for creator ⊥. */
  amplifier: number;
  /** Content tensor Frobenius norm at the terminus. */
  contentNorm: number;
  relevance: number;
}

/**
 * Content tensor norm ‖T_content‖_F: full-mask slice of the arithmetic mean
 * (p̄_d, p̄_i) over incoming user-authored Opinion stance records.
 * (Appendix F computes S(Bob, Photo) with exactly this reading — 1.798 for the
 * single Opinion e2; the general node-fold table adds a maturity factor whose
 * inclusion here is a flagged spec ambiguity. We match the fixture.)
 */
/**
 * Stance records that fold into a node's sentiment slice.
 *
 * Opinion is the obvious one. Publish belongs too, and v0.24.2 says so in
 * as many words: the genesis exclusion removes the minting act's structural
 * FIELDS — the ones fixing identity, creator and license — not the record, so
 * "a genesis Publish folds into p̄_d, p̄_i like any other Publish, because its
 * author's stance toward the thing they published is a stance like any other".
 * Reading it the other way makes the first act about a node invisible to the
 * fold while every later act counts.
 *
 * ReviewA is deliberately NOT here. Admitting it moves the Appendix F
 * reference content norm off its certified 1.798, so the verification suite
 * says plainly that a review's A-leg is not part of this fold.
 */
const STANCE_FAMILIES = new Set(['Opinion', 'Publish']);

export function contentNorm(graph: RawGraph, nodeId: string): number {
  const stance = graph
    .incoming(nodeId)
    .filter((e) => STANCE_FAMILIES.has(e.family));
  if (stance.length === 0) return 0;
  const pd = stance.reduce((s, e) => s + e.pd, 0) / stance.length;
  const pi = stance.reduce((s, e) => s + e.pi, 0) / stance.length;
  return frobenius(sentimentSlice(pd, pi, DOMAIN_MASKS.Tribal));
}

/**
 * Feed ranking for a viewer: relevance
 * S(viewer, c) = W_BFS(viewer→c) · (1 + standing(creator)/ν) · ‖T_c‖_F.
 */
export function rankFeed(
  graph: RawGraph,
  viewerId: string,
  standingOf: (actorId: string) => number,
  creatorOf: (nodeId: string) => string | null,
): FeedEntry[] {
  const reg = doubleCoverBFS(graph, viewerId);
  const entries: FeedEntry[] = [];
  for (const node of graph.nodes.values()) {
    if (node.kind === 'Actor' || node.kind === 'Profile') continue;
    const r = reg.get(node.id);
    const bfsWeight = r?.pos ?? 0;
    if (bfsWeight <= 0) continue;
    const creator = creatorOf(node.id);
    const amplifier = creator ? 1 + standingOf(creator) / NU : 1;
    const norm = contentNorm(graph, node.id);
    entries.push({
      node,
      bfsWeight,
      amplifier,
      contentNorm: norm,
      relevance: bfsWeight * amplifier * norm,
    });
  }
  entries.sort((a, b) => b.relevance - a.relevance);
  return entries;
}
