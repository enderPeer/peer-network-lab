/**
 * Deletion and revision, together.
 *
 * The two features shipped in separate commits and were tested separately, and
 * the interaction between them was where the damage sat: deleting a post that
 * had been revised left the newest text — the version people were actually
 * reading — in the served log, while telling the user it had been redacted.
 */
import { describe, it, expect } from 'vitest';
import { replay, seed } from './helpers/world';

function revisedPost() {
  const base = [...seed('al', 'bo'), { t: 'post', author: 'u_al', text: 'ORIGINAL', a: 0.8, rmen: [] }];
  const mintIdx = base.length - 1;
  const acts = [...base, { t: 'post', author: 'u_al', text: 'REVISED', a: 0.8, target: mintIdx, rmen: [] }];
  return { acts, mintIdx, revIdx: acts.length - 1 };
}

/** What the host does: redact every act that writes text into the node. */
function redactNode(acts: Record<string, unknown>[], mintIdx: number) {
  const out = acts.map((a, i) => (
    (i === mintIdx || (a.t === 'post' && a.target === mintIdx)) && a.text
      ? { ...a, text: '', redacted: true }
      : a
  ));
  out.push({ t: 'deletePost', author: acts[mintIdx].author, target: mintIdx });
  return out;
}

describe('deleting a post that was revised', () => {
  it('removes the node’s payload', () => {
    const { acts, mintIdx } = revisedPost();
    expect(replay(redactNode(acts, mintIdx)).payloads.c1).toBeUndefined();
  });

  it('leaves no act in the log still carrying the revised text', () => {
    // The version everyone was reading lives in the REVISION act, not the mint.
    // Redacting only the mint left it downloadable from /api/acts forever while
    // the interface said the content had been removed.
    const { acts, mintIdx } = revisedPost();
    const after = redactNode(acts, mintIdx);
    expect(after.some((a) => typeof a.text === 'string' && a.text.includes('REVISED'))).toBe(false);
    expect(after.some((a) => typeof a.text === 'string' && a.text.includes('ORIGINAL'))).toBe(false);
  });

  it('does not resurrect the node when the revision replays after the tombstone', () => {
    // Ordering must not matter: a revision appearing after the delete must not
    // write text back into a node whose payload is gone.
    const { acts, mintIdx } = revisedPost();
    const out = acts.map((a, i) => (i === mintIdx && a.text ? { ...a, text: '', redacted: true } : a));
    out.push({ t: 'deletePost', author: 'u_al', target: mintIdx });
    out.push({ t: 'post', author: 'u_al', text: 'BACK AGAIN', a: 0.8, target: mintIdx, rmen: [] });
    const st = replay(out);
    expect(st.payloads.c1).toBeUndefined();
    expect(st.chron.some((c) => /BACK AGAIN/.test(c.line))).toBe(false);
  });

  it('deletes rather than un-edits when the tombstone names the revision', () => {
    // Naming the revision used to skip the update branch, so the node fell back
    // to the pre-edit text and stayed fully visible — while the request that
    // was meant to remove it returned success.
    const { acts, revIdx } = revisedPost();
    const out = [...acts, { t: 'deletePost', author: 'u_al', target: revIdx }];
    expect(replay(out).payloads.c1).toBeUndefined();
  });
});

describe('a revision does not pay the mention vouch twice', () => {
  it('leaves the compiled vouch exactly where the original put it', () => {
    // Re-publishing the same text with the same @mention doubled the bundle,
    // which compileCells clamps to 1 — so two edits saturated a person-vouch at
    // maximum. Standing ranks the whole feed, so this moved what everyone saw.
    const base = [...seed('al', 'bo'), { t: 'post', author: 'u_al', text: '@bo hi', a: 0.8, rmen: ['u_bo'] }];
    const mintIdx = base.length - 1;
    const revised = [...base, { t: 'post', author: 'u_al', text: '@bo hi again', a: 0.8, target: mintIdx, rmen: ['u_bo'] }];
    const before = replay(base).bundles['u_al>u_bo'];
    const after = replay(revised).bundles['u_al>u_bo'];
    expect(after.pd).toBeCloseTo(before.pd, 12);
    expect(after.pi).toBeCloseTo(before.pi, 12);
  });

  it('moves the mentioned person’s standing only by the cost of the act', () => {
    // An edit does move u_bo: it debits u_al, whose commitment rate then falls,
    // and a vouch transports the voucher's own rate. That is the economy
    // working. What must NOT happen is a second vouch on top — so the edit has
    // to land exactly where any other act by the same author would land.
    const base = [...seed('al', 'bo'), { t: 'post', author: 'u_al', text: '@bo hi', a: 0.8, rmen: ['u_bo'] }];
    const mintIdx = base.length - 1;
    const revised = [...base, { t: 'post', author: 'u_al', text: '@bo hi again', a: 0.8, target: mintIdx, rmen: ['u_bo'] }];
    const unrelated = [...base, { t: 'post', author: 'u_al', text: 'something else', a: 0.8, rmen: [] }];
    expect(replay(revised).xById.u_bo).toBeCloseTo(replay(unrelated).xById.u_bo, 9);
    expect(replay(revised).xById.u_bo).not.toBeCloseTo(replay(base).xById.u_bo, 6);
  });

  it('does not mint a second reference node for the quote either', () => {
    const base = [
      ...seed('al'),
      { t: 'post', author: 'u_al', text: 'FIRST', a: 0.8, rmen: [] },
      { t: 'post', author: 'u_al', text: 'QUOTING', a: 0.8, ref: 'c1', rmen: [] },
    ];
    const mintIdx = base.length - 1;
    const revised = [...base, { t: 'post', author: 'u_al', text: 'QUOTING, EDITED', a: 0.8, ref: 'c1', target: mintIdx, rmen: [] }];
    const refEdges = (s: ReturnType<typeof replay>) =>
      s.g.edges.filter((e) => e.family === 'ReferenceT' && e.tgt === 'c1').length;
    expect(refEdges(replay(revised))).toBe(refEdges(replay(base)));
  });
});
