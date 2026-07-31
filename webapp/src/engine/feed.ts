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
export function contentNorm(graph: RawGraph, nodeId: string): number {
  const stance = graph
    .incoming(nodeId)
    .filter((e) => e.family === 'Opinion');
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
