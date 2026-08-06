// Writer election: which host holds the pen right now.
//
// The rule, in one sentence: the longest issuance wins, and among equals,
// the host most people are actually using. Concretely, candidates order by
//
//   1. sealed chain height   — the longest SIGNED history. Blocks are
//      verifiable and hash-linked, so this cannot be claimed, only shown.
//   2. act count             — the longest log. Verifiable by fetching it.
//   3. active authors (1h)   — distinct identities that appear as authors in
//      the last hour OF THE LOG. Deliberately computed from the public
//      record rather than from private connection counts, so any observer
//      can recompute the same number from the same acts. A host can still
//      inflate it only by having real acts to show for it.
//   4. node id               — the producer public key, lexicographically.
//      Pure tiebreak: no meaning, just determinism.
//
// Every field is either verifiable from public data (1, 2, 3) or a stable
// arbitrary constant (4), so two honest observers with the same view compute
// the same winner. That is the whole design: election here is not a vote, it
// is a deterministic function of who exists and what they can prove.
//
// What this file does NOT decide: whether to trust an unreachable host
// (probing is the server's job), or what to do with a loser's unsynced tail
// (reconcile.mjs). Pure functions only — this must be testable to the bone.

/** Distinct identities appearing as authors in the log within the window.
 *  Reads the same fields the replay reads (author/from/id) and only counts
 *  acts that carry a timestamp — unstamped acts prove no recency. */
export function activeAuthors(fileActs, nowMs, windowMs = 3600_000) {
  const seen = new Set();
  const from = nowMs - windowMs;
  for (const a of fileActs) {
    if (!(a && typeof a.ts === 'number' && a.ts >= from && a.ts <= nowMs)) continue;
    const who = a.author || a.from || a.id;
    if (typeof who === 'string' && who) seen.add(who);
  }
  return seen.size;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strId = (v) => (typeof v === 'string' ? v : '￿'); // no id sorts last

/** Strict total order: does candidate a outrank candidate b? */
export function outranks(a, b) {
  const ah = num(a.chainHeight), bh = num(b.chainHeight);
  if (ah !== bh) return ah > bh;
  const aa = num(a.acts), ba = num(b.acts);
  if (aa !== ba) return aa > ba;
  const av = num(a.active), bv = num(b.active);
  if (av !== bv) return av > bv;
  return strId(a.nodeId) < strId(b.nodeId);
}

/** The writer among these candidates. Deterministic for any input order. */
export function pickWriter(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c) continue;
    if (best === null || outranks(c, best)) best = c;
  }
  return best;
}

/**
 * Does a hold a strictly LONGER issuance than b — more sealed chain, or the
 * same chain and more acts? This, and only this, dethrones a living writer.
 *
 * The distinction was found live, in the first two-host drill: two hosts
 * with identical records tie-broke on node id, the incumbent computed the
 * other as "the writer", and the demotion path would have made each the
 * other's mirror — a network with two perfect copies and nobody allowed to
 * write. Tiebreaks pick a SUCCESSOR among the living when the writer is
 * dead; they never unseat one that is answering. An incumbent yields to a
 * longer record, because a longer record is the one thing that proves the
 * network moved on without it.
 */
export function strictlyLonger(a, b) {
  const ah = num(a.chainHeight), bh = num(b.chainHeight);
  if (ah !== bh) return ah > bh;
  return num(a.acts) > num(b.acts);
}
