/**
 * Structural grouping of the raw graph — who transacts with whom.
 *
 * This is the one quantity on the Network screen that is *not* read out of the
 * record. Every edge is a priced act somebody committed to; a community is an
 * arrangement of those acts that this function chose. The distinction is not
 * cosmetic and the UI is required to carry it: reach, standing and path terms
 * are derived from the specified mathematics over recorded acts, whereas a
 * grouping is a reading. Modularity Q is returned alongside it so a reader can
 * see how much structure there actually was to find.
 *
 * Three properties are load-bearing here:
 *
 *   DIRECTION IS DROPPED. The router is directional and asymmetric on purpose —
 *   reaching somebody is not the same as being reachable by them. A grouping
 *   cannot be directional without ceasing to be a partition, so the pair
 *   (a→b, b→a) folds to one undirected link. That makes a community a claim
 *   about who transacts, never about who reaches whom.
 *
 *   SIGN IS DROPPED. A negative act is still a relationship, and `weight`
 *   already carries the damping. A community is people who transact, not people
 *   who agree — grouping by agreement would be a different, much stronger claim
 *   than this method supports.
 *
 *   THE RESULT IS DETERMINISTIC. Same acts in, same partition out, on every
 *   engine, because the whole application is replayable by doctrine. There is
 *   no randomness, no wall-clock, and no dependence on object key order. The
 *   three rules that settle ties live in `oneLevel`.
 */

/** A node as this module needs it — id only; kind and label are the caller's business. */
export interface CommunityNode {
  id: string;
}

/** An edge as this module needs it. `weight` is the damped routing weight. */
export interface CommunityEdge {
  src: string;
  tgt: string;
  weight: number;
}

export interface CommunityResult {
  /** Folded node id → community index. Indices are canonical (see `canonicalise`). */
  of: Record<string, number>;
  /** Node count per community, by index. */
  sizes: number[];
  /** Folded id → weighted degree over the folded undirected graph. */
  strength: Record<string, number>;
  /** Folded id → number of incident folded links. Counts relationships, not weight. */
  links: Record<string, number>;
  /**
   * Newman–Girvan modularity of the returned partition, in [−0.5, 1].
   * Below ~0.15 the graph did not really separate and the caller must say so.
   */
  q: number;
  /** Number of communities. */
  count: number;
}

/** Louvain stops here; both bounds are reached only by pathological inputs. */
const MAX_LEVELS = 10;
const MAX_PASSES = 20;
/** A gain must beat the incumbent by more than this to move a node. */
const EPS = 1e-12;

/**
 * An undirected weighted graph in compressed sparse row form.
 *
 * CSR rather than an array of arrays for two reasons: typed arrays index to
 * `number` instead of `number | undefined` under `noUncheckedIndexedAccess`, so
 * the inner loops stay readable without assertions; and the whole adjacency is
 * three contiguous buffers, which is what makes twenty sweeps over a thousand
 * edges free next to the layout solve.
 */
interface Csr {
  /** Node count. */
  n: number;
  /** Row start offsets, length n+1. */
  off: Int32Array;
  /** Neighbour index per slot. */
  nbr: Int32Array;
  /** Link weight per slot. */
  wgt: Float64Array;
  /** Weighted degree per node (self-loops counted twice). */
  deg: Float64Array;
  /** Sum of all degrees — i.e. 2m. */
  m2: number;
}

/** Build CSR from a pair-keyed weight map. `selfLoops` are stored once, degree twice. */
function csrFrom(n: number, acc: Map<number, number>): Csr {
  const keys = Array.from(acc.keys()).sort((x, y) => x - y);
  const counts = new Int32Array(n);
  for (const key of keys) {
    const lo = Math.floor(key / n);
    const hi = key % n;
    if (lo === hi) counts[lo]! += 1;
    else {
      counts[lo]! += 1;
      counts[hi]! += 1;
    }
  }
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i]! + counts[i]!;
  const total = off[n]!;
  const nbr = new Int32Array(total);
  const wgt = new Float64Array(total);
  const deg = new Float64Array(n);
  const cursor = new Int32Array(n);
  for (let i = 0; i < n; i++) cursor[i] = off[i]!;
  let m2 = 0;
  for (const key of keys) {
    const w = acc.get(key) as number;
    const lo = Math.floor(key / n);
    const hi = key % n;
    if (lo === hi) {
      nbr[cursor[lo]!] = lo;
      wgt[cursor[lo]!] = w;
      cursor[lo]! += 1;
      deg[lo]! += 2 * w;
      m2 += 2 * w;
    } else {
      nbr[cursor[lo]!] = hi;
      wgt[cursor[lo]!] = w;
      cursor[lo]! += 1;
      nbr[cursor[hi]!] = lo;
      wgt[cursor[hi]!] = w;
      cursor[hi]! += 1;
      deg[lo]! += w;
      deg[hi]! += w;
      m2 += 2 * w;
    }
  }
  return { n, off, nbr, wgt, deg, m2 };
}

/**
 * Fold to an undirected, simple, weighted graph.
 *
 * Node order is first-appearance order in `nodes`, which for the live graph is
 * act-append order, which replay reproduces exactly. It is never derived from
 * object key enumeration.
 *
 * Self-pairs are dropped. On this graph they are exactly the Registration,
 * SelfDeclaration and SelfReputation legs between an actor and their own
 * profile, which fold onto one node and would otherwise inflate every degree by
 * a constant carrying no grouping information.
 */
function fold(
  nodes: CommunityNode[],
  edges: CommunityEdge[],
  personOf: (id: string) => string,
): { csr: Csr; ids: string[]; links: Int32Array } {
  const index = new Map<string, number>();
  const ids: string[] = [];
  for (const node of nodes) {
    const pid = personOf(node.id);
    if (!index.has(pid)) {
      index.set(pid, ids.length);
      ids.push(pid);
    }
  }
  const n = ids.length;

  // Parallel acts between the same pair are one relationship of summed weight,
  // not several links.
  const acc = new Map<number, number>();
  for (const e of edges) {
    if (!(e.weight > 0)) continue; // routing-inert edges carry no relationship
    const a = index.get(personOf(e.src));
    const b = index.get(personOf(e.tgt));
    if (a === undefined || b === undefined || a === b) continue;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * n + hi;
    acc.set(key, (acc.get(key) ?? 0) + e.weight);
  }

  const links = new Int32Array(n);
  for (const key of acc.keys()) {
    const lo = Math.floor(key / n);
    const hi = key % n;
    links[lo]! += 1;
    links[hi]! += 1;
  }
  return { csr: csrFrom(n, acc), ids, links };
}

/**
 * One Louvain level: move nodes between communities while modularity improves.
 *
 * Determinism rests on three rules, all of them here:
 *
 *   1. Nodes are visited in index order, which is first-appearance order.
 *   2. Candidate communities are scanned in ascending index order. The
 *      neighbour-weight accumulator is a dense array, so its natural order
 *      would be encounter order; `touched` is sorted to remove that dependence.
 *   3. A move requires a *strictly* better gain, by more than EPS. The
 *      incumbent is seeded as the best before the scan, so a tie leaves a node
 *      where it is, and among equally-good challengers the lowest index wins.
 */
function oneLevel(g: Csr): Int32Array {
  const { n, off, nbr, wgt, deg, m2 } = g;
  const com = new Int32Array(n);
  const ktot = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    com[i] = i;
    ktot[i] = deg[i]!;
  }
  const linkW = new Float64Array(n);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const ci = com[i]!;
      const touched: number[] = [];
      for (let t = off[i]!; t < off[i + 1]!; t++) {
        const c = com[nbr[t]!]!;
        if (linkW[c] === 0) touched.push(c);
        linkW[c]! += wgt[t]!;
      }
      if (linkW[ci] === 0) touched.push(ci); // the incumbent is always a candidate
      touched.sort((x, y) => x - y); // rule 2

      // Remove i from its community before scoring, so the incumbent is judged
      // on the same footing as every challenger.
      ktot[ci]! -= deg[i]!;
      let best = ci;
      let bestGain = linkW[ci]! - (ktot[ci]! * deg[i]!) / m2;
      for (const cc of touched) {
        const gain = linkW[cc]! - (ktot[cc]! * deg[i]!) / m2;
        if (gain > bestGain + EPS) {
          // rule 3
          bestGain = gain;
          best = cc;
        }
      }
      ktot[best]! += deg[i]!;
      if (best !== ci) {
        com[i] = best;
        moved++;
      }
      for (const c of touched) linkW[c] = 0;
    }
    if (!moved) break;
  }
  return com;
}

/** Compact community labels to 0..k−1 in ascending order of first appearance. */
function compact(com: Int32Array): { com: Int32Array; count: number } {
  const map = new Map<number, number>();
  const out = new Int32Array(com.length);
  for (let i = 0; i < com.length; i++) {
    const raw = com[i]!;
    let c = map.get(raw);
    if (c === undefined) {
      c = map.size;
      map.set(raw, c);
    }
    out[i] = c;
  }
  return { com: out, count: map.size };
}

/**
 * Collapse the graph by a partition: one node per community, weights summed.
 * A community's internal weight becomes a self-loop, which modularity needs —
 * it is the Σin term.
 *
 * Every level re-collapses the *original* folded graph by the current
 * partition, rather than aggregating an aggregate. The weights stay exact
 * instead of accumulating rounding through a chain of sums.
 */
function aggregate(g: Csr, com: Int32Array, count: number): Csr {
  const acc = new Map<number, number>();
  for (let i = 0; i < g.n; i++) {
    const a = com[i]!;
    for (let t = g.off[i]!; t < g.off[i + 1]!; t++) {
      const b = com[g.nbr[t]!]!;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * count + hi;
      // Each undirected link is stored in both endpoints' rows, so halve it
      // back; a self-loop is stored once but visited once too, and its own
      // halving is undone by csrFrom counting it twice into the degree.
      acc.set(key, (acc.get(key) ?? 0) + g.wgt[t]! / 2);
    }
  }
  return csrFrom(count, acc);
}

/**
 * Newman–Girvan modularity of a partition over the folded graph.
 * Q = Σ_c [ Σin_c / 2m − (Σtot_c / 2m)² ], with Σin counting both directions.
 */
function modularity(g: Csr, com: Int32Array, count: number): number {
  if (g.m2 <= 0) return 0;
  const inW = new Float64Array(count);
  const totW = new Float64Array(count);
  for (let i = 0; i < g.n; i++) {
    const ci = com[i]!;
    totW[ci]! += g.deg[i]!;
    for (let t = g.off[i]!; t < g.off[i + 1]!; t++) {
      if (com[g.nbr[t]!] === ci) inW[ci]! += g.wgt[t]!;
    }
  }
  let q = 0;
  for (let c = 0; c < count; c++) {
    const tc = totW[c]! / g.m2;
    q += inW[c]! / g.m2 - tc * tc;
  }
  return q;
}

/**
 * Renumber communities so a colour stays put between renders: largest first,
 * and among equal sizes the one holding the lexicographically smallest member.
 * Without this, an unrelated act elsewhere in the log could permute the legend.
 */
function canonicalise(
  com: Int32Array,
  count: number,
  ids: string[],
): { com: Int32Array; sizes: number[] } {
  const sizes = new Array<number>(count).fill(0);
  const minId = new Array<string>(count);
  for (let i = 0; i < com.length; i++) {
    const c = com[i]!;
    sizes[c] = (sizes[c] ?? 0) + 1;
    const id = ids[i] ?? '';
    const cur = minId[c];
    if (cur === undefined || id < cur) minId[c] = id;
  }
  const order = Array.from({ length: count }, (_, c) => c).sort((a, b) => {
    const sa = sizes[a] ?? 0;
    const sb = sizes[b] ?? 0;
    if (sb !== sa) return sb - sa;
    const ma = minId[a] ?? '';
    const mb = minId[b] ?? '';
    return ma < mb ? -1 : ma > mb ? 1 : 0;
  });
  const rank = new Int32Array(count);
  order.forEach((c, r) => {
    rank[c] = r;
  });
  const out = new Int32Array(com.length);
  for (let i = 0; i < com.length; i++) out[i] = rank[com[i]!]!;
  return { com: out, sizes: order.map((c) => sizes[c] ?? 0) };
}

/**
 * Group the graph by Louvain modularity maximisation.
 *
 * `personOf` folds an id onto the unit that should be grouped — on this graph
 * it maps `prof_alice` onto `alice`, so an account and its profile are one
 * thing rather than an artificial pair.
 *
 * Cost is O(E) per sweep. Against the layout solve on the same data (measured
 * at 467ms) this is not a visible expense, but the caller should still cache it
 * on the node and edge set rather than recompute it on every repaint.
 */
export function communities(
  nodes: CommunityNode[],
  edges: CommunityEdge[],
  personOf: (id: string) => string = (id) => id,
): CommunityResult {
  const { csr, ids, links } = fold(nodes, edges, personOf);
  const n = ids.length;

  const strength: Record<string, number> = Object.create(null);
  const linkCount: Record<string, number> = Object.create(null);
  for (let i = 0; i < n; i++) {
    const id = ids[i] as string;
    strength[id] = csr.deg[i]!;
    linkCount[id] = links[i]!;
  }

  // No routable link survives the filter: every node stands alone. That is a
  // real state on a fresh network, not an error, and Q is 0 by definition.
  if (n === 0 || csr.m2 <= 0) {
    const of: Record<string, number> = Object.create(null);
    ids.forEach((id, i) => {
      of[id] = i;
    });
    return { of, sizes: new Array<number>(n).fill(1), strength, links: linkCount, q: 0, count: n };
  }

  // Level 0: move the real nodes until no single move improves modularity.
  let part = compact(oneLevel(csr));

  // Levels 1..MAX_LEVELS: collapse each community to one node and move again.
  // This is what lets Louvain find groups wider than one node's neighbourhood.
  // It stops as soon as a level merges nothing.
  for (let level = 0; level < MAX_LEVELS && part.count > 1; level++) {
    const agg = aggregate(csr, part.com, part.count);
    if (!agg.m2) break;
    const lifted = compact(oneLevel(agg));
    if (lifted.count === part.count) break; // nothing merged; settled
    const raised = new Int32Array(n);
    for (let i = 0; i < n; i++) raised[i] = lifted.com[part.com[i]!]!;
    part = compact(raised);
  }

  const q = modularity(csr, part.com, part.count);
  const canon = canonicalise(part.com, part.count, ids);
  const of: Record<string, number> = Object.create(null);
  ids.forEach((id, i) => {
    of[id] = canon.com[i]!;
  });
  return { of, sizes: canon.sizes, strength, links: linkCount, q, count: part.count };
}
