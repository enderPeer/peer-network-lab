/**
 * CoGra feed ranking — the Layer-2 score S(u,c) published formula-complete in
 * cogra/docs/primitive/feed-ranking.md, implemented over this engine's raw
 * edge records. Layer 1 grants every L2 the right to replace the default
 * relevance readout with a published computation; this is that computation:
 *
 *   S(u,c) = Σ_{i=1..k} σ(π_i) · m(π_i) · f(Δt_{π_i})
 *
 * over up to k internally node-disjoint strongest forward paths, extracted
 * greedily (Dijkstra on cost −ln(γ·w̃), delete interior, repeat).
 *
 * Key rules implemented from the spec:
 *  - fold first: same-author (src, tgt, family) bundles net by sum-then-clip,
 *    weight recomputed from the folded parameters; (0,0) nets are inert
 *    (zero-jail is unreachability, not a sort bucket)
 *  - persons are one node (Actor + Profile merged); the standing-derived
 *    Self-edge bond, Registration, and control records are never traversed;
 *    standing never enters the score (no creator amplifier)
 *  - Types are sinks; hyper T-legs are channel-gated: content-intrinsic
 *    (author of the leg = carrier's creator → free continuation) or
 *    initiator-owned (composite author→terminal hop at w̃_A·w̃_T)
 *  - sign: balance = ∏ sgn(p̄_d); taint if any p̄_i < 0 (absorbing);
 *    σ = +1 iff balance is +1 and untainted — deliberately not L1 parity
 *  - recency: f(Δt) = 0.5^(Δt/half-life) on the terminal hop's epoch age only
 *
 * v0 simplifications (documented, sandbox-honest): hyper legs pair by append
 * adjacency (this engine appends them adjacently); Reference records and the
 * seen-list are not in the sandbox; tie-breaking uses the canonical hop-key
 * sequence on exact cost ties.
 */

import { FAMILIES } from './families';
import { DOMAIN_MASKS, pathView, detScore, dampedWeight } from './tensor';
import type { EdgeRecord, NodeInfo, RawGraph } from './graph';

export interface CograConfig {
  /** Disjoint paths extracted per (viewer, target); governed order 4–8. */
  k: number;
  /** Per-hop attenuation γ ∈ (0,1], default 1. */
  gamma: number;
  /** Dust floor χ — extraction stops below this path product. */
  chi: number;
  /** Recency half-life in epochs; Infinity disables recency. */
  halfLifeEpochs: number;
}

export const COGRA_DEFAULTS: CograConfig = { k: 5, gamma: 1, chi: 1e-4, halfLifeEpochs: 4 };

/** Families that never enter feed traversal. */
const NEVER_TRAVERSED = new Set(['SelfDeclaration', 'SelfReputation', 'Registration', 'Control']);
/** Hyper T-leg families (channel-gated) and their A-leg partners. */
const T_LEGS: Record<string, string> = { ReviewT: 'ReviewA', TagT: 'TagA', ReferenceT: 'ReferenceA' };

export interface Hop {
  from: string;
  to: string;
  weight: number;
  /** sgn of folded p̄_d over the hop (composite hops multiply both legs). */
  pdSign: number;
  /** true if any folded p̄_i on the hop is negative (taint). */
  piNegative: boolean;
  /** Epoch of the ≺-newest member of the terminal bundle (recency input). */
  epoch: number;
  /** Canonical key for deterministic tie-breaking. */
  key: string;
}

export interface CograPath {
  nodes: string[];
  hops: Hop[];
  /** Magnitude m(π) = ∏ γ·w̃. */
  m: number;
  /** σ(π) ∈ {+1, −1}. */
  sigma: number;
  /** Recency factor of the terminal hop. */
  f: number;
  /** Signed decayed contribution σ·m·f. */
  term: number;
}

export interface CograScore {
  node: NodeInfo;
  S: number;
  paths: CograPath[];
}

interface BuildOpts {
  /** Person fold: canonical person id for a node (Profile → its Actor). */
  personOf: (nodeId: string) => string;
  /** Creator of a minted artifact (content-intrinsic channel test). */
  creatorOf: (nodeId: string) => string | null;
}

function clip(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** Recompute w̃ from folded parameters through the ordinary tensor pipeline. */
function foldedWeight(family: string, pd: number, pi: number, tau: number): number {
  const spec = FAMILIES[family];
  if (!spec) return 0;
  const mask = spec.promoted ? DOMAIN_MASKS.Tribal : DOMAIN_MASKS[spec.domain];
  const pv = pathView(pd, pi, mask, spec.tier);
  return dampedWeight(detScore(pv), tau);
}

interface FoldedBundle {
  family: string;
  src: string;
  tgt: string;
  pd: number;
  pi: number;
  tau: number;
  epoch: number;
  weight: number;
  key: string;
}

/** Sum-then-clip fold of parallel records, keyed (src, tgt, family). */
function foldBundles(edges: EdgeRecord[]): Map<string, FoldedBundle> {
  const bundles = new Map<string, FoldedBundle>();
  for (const e of edges) {
    const key = e.src + '|' + e.tgt + '|' + e.family;
    let b = bundles.get(key);
    if (!b) {
      b = { family: e.family, src: e.src, tgt: e.tgt, pd: 0, pi: 0, tau: e.tau, epoch: e.epoch ?? 0, weight: 0, key };
      bundles.set(key, b);
    }
    b.pd += e.pd;
    b.pi += e.pi;
    // temporal attributes from the ≺-newest member
    if (e.appendIndex >= 0) { b.tau = e.tau; b.epoch = Math.max(b.epoch, e.epoch ?? 0); }
  }
  for (const b of bundles.values()) {
    b.pd = clip(b.pd);
    b.pi = clip(b.pi);
    b.weight = b.pd === 0 || b.pi === 0 ? 0 : foldedWeight(b.family, b.pd, b.pi, b.tau);
  }
  return bundles;
}

/**
 * Build the traversal hop set from the raw graph: fold, person-merge,
 * drop never-traversed families, sink Types, channel-gate T-legs.
 */
export function buildHops(graph: RawGraph, opts: BuildOpts): Map<string, Hop[]> {
  const kindOf = (id: string): string => graph.nodes.get(id)?.kind ?? 'Content';

  // Partition raw edges: T-legs pair with their adjacent A-leg act-mate.
  const tLegs: { t: EdgeRecord; a: EdgeRecord | null }[] = [];
  const ordinary: EdgeRecord[] = [];
  for (const e of graph.edges) {
    if (NEVER_TRAVERSED.has(e.family)) continue;
    if (T_LEGS[e.family]) {
      const prev = graph.edges[e.appendIndex - 1];
      tLegs.push({ t: e, a: prev && prev.family === T_LEGS[e.family] ? prev : null });
    } else {
      ordinary.push(e);
    }
  }

  const bundles = foldBundles(ordinary);
  const hops = new Map<string, Hop[]>();
  const push = (h: Hop) => {
    if (h.weight <= 0) return; // zero is inert — nothing revives a dead hop
    if (kindOf(h.from) === 'Type') return; // Types are sinks, never transit
    const from = opts.personOf(h.from);
    const to = opts.personOf(h.to);
    if (from === to) return; // intra-person (grounded pair) is not a hop
    const list = hops.get(from) ?? [];
    list.push({ ...h, from, to });
    hops.set(from, list);
  };

  for (const b of bundles.values()) {
    push({
      from: b.src, to: b.tgt, weight: b.weight,
      pdSign: Math.sign(b.pd) || 1, piNegative: b.pi < 0,
      epoch: b.epoch, key: b.key,
    });
  }

  // Channel-gated T-legs.
  for (const { t, a } of tLegs) {
    const author = a ? a.src : null;
    const carrier = t.src;
    const creator = opts.creatorOf(carrier);
    if (author && creator && opts.personOf(author) === opts.personOf(creator)) {
      // content-intrinsic: the leg is part of the content — free continuation
      push({
        from: carrier, to: t.tgt, weight: t.weight,
        pdSign: Math.sign(t.pd) || 1, piNegative: t.pi < 0,
        epoch: t.epoch ?? 0, key: t.id,
      });
    } else if (author && a) {
      // initiator-owned: reachable only through the leg's author
      push({
        from: author, to: t.tgt, weight: a.weight * t.weight,
        pdSign: (Math.sign(a.pd) || 1) * (Math.sign(t.pd) || 1),
        piNegative: a.pi < 0 || t.pi < 0,
        epoch: Math.max(a.epoch ?? 0, t.epoch ?? 0), key: a.id + '+' + t.id,
      });
    }
  }
  return hops;
}

/** Max-product Dijkstra u→target over live hops, skipping banned interior nodes. */
function strongestPath(
  hops: Map<string, Hop[]>,
  source: string,
  target: string,
  banned: Set<string>,
  usedHops: Set<string>,
  gamma: number,
): { nodes: string[]; hops: Hop[]; m: number } | null {
  interface Entry { node: string; cost: number; keys: string; path: Hop[] }
  const best = new Map<string, { cost: number; keys: string }>();
  const queue: Entry[] = [{ node: source, cost: 0, keys: '', path: [] }];
  let found: Entry | null = null;
  while (queue.length) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) {
      const q = queue[i]!;
      const b = queue[bi]!;
      if (q.cost < b.cost - 1e-15 || (Math.abs(q.cost - b.cost) <= 1e-15 && q.keys < b.keys)) bi = i;
    }
    const cur = queue.splice(bi, 1)[0]!;
    const seen = best.get(cur.node);
    if (seen && (seen.cost < cur.cost - 1e-15 || (Math.abs(seen.cost - cur.cost) <= 1e-15 && seen.keys <= cur.keys))) continue;
    best.set(cur.node, { cost: cur.cost, keys: cur.keys });
    if (cur.node === target) { found = cur; break; }
    for (const h of hops.get(cur.node) ?? []) {
      if (banned.has(h.to)) continue; // interior of an extracted path (endpoints never banned)
      if (usedHops.has(h.key)) continue; // paths must be distinct — a direct hop extracts once
      if (cur.path.some((p) => p.to === h.to || p.from === h.to)) continue; // no revisits
      const cost = cur.cost - Math.log(gamma * h.weight);
      queue.push({ node: h.to, cost, keys: cur.keys + '/' + h.key, path: cur.path.concat(h) });
    }
  }
  if (!found) return null;
  const nodes = [source].concat(found.path.map((h) => h.to));
  return { nodes, hops: found.path, m: Math.exp(-found.cost) };
}

/** Score one candidate: greedy k-disjoint extraction + signed decayed sum. */
export function scoreCandidate(
  hops: Map<string, Hop[]>,
  viewer: string,
  target: string,
  certCount: number,
  cfg: CograConfig = COGRA_DEFAULTS,
): { S: number; paths: CograPath[] } {
  const banned = new Set<string>();
  const usedHops = new Set<string>();
  const paths: CograPath[] = [];
  for (let i = 0; i < cfg.k; i++) {
    const p = strongestPath(hops, viewer, target, banned, usedHops, cfg.gamma);
    if (!p || p.m < cfg.chi) break;
    const balance = p.hops.reduce((s, h) => s * h.pdSign, 1);
    const tainted = p.hops.some((h) => h.piNegative);
    const sigma = balance > 0 && !tainted ? 1 : -1;
    const terminal = p.hops[p.hops.length - 1]!;
    const dt = Math.max(0, certCount - terminal.epoch);
    const f = cfg.halfLifeEpochs === Infinity ? 1 : Math.pow(0.5, dt / cfg.halfLifeEpochs);
    paths.push({ nodes: p.nodes, hops: p.hops, m: p.m, sigma, f, term: sigma * p.m * f });
    for (const n of p.nodes.slice(1, -1)) banned.add(n); // delete interior (persons = one node)
    for (const h of p.hops) usedHops.add(h.key);
  }
  return { S: paths.reduce((s, p) => s + p.term, 0), paths };
}

/**
 * Rank the feed for a viewer: default candidate scope is payload-bearing
 * Content (posts). Unreachable candidates are absent; negatives sort to the
 * bottom but stay visible — a friend's strong dislike is information.
 */
export function cograRank(
  graph: RawGraph,
  viewer: string,
  certCount: number,
  opts: BuildOpts & { candidates?: (n: NodeInfo) => boolean; cfg?: Partial<CograConfig> },
): CograScore[] {
  const cfg: CograConfig = { ...COGRA_DEFAULTS, ...(opts.cfg ?? {}) };
  const hops = buildHops(graph, opts);
  const wanted = opts.candidates ?? ((n: NodeInfo) => n.kind === 'Content');
  const out: CograScore[] = [];
  for (const node of graph.nodes.values()) {
    if (!wanted(node)) continue;
    const { S, paths } = scoreCandidate(hops, opts.personOf(viewer), node.id, certCount, cfg);
    if (paths.length === 0) continue; // absence, not a bucket
    out.push({ node, S, paths });
  }
  out.sort((a, b) => b.S - a.S);
  return out;
}
