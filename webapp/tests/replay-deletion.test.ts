/**
 * Deletion semantics.
 *
 * Every assertion here corresponds to something that was once wrong on the live
 * network. Deletion used to remove the RECORD rather than the payload, which
 * silently rewrote everyone's standing and invalidated an already-published
 * epoch certificate; and it used to cascade into other people's comments and
 * messages, destroying records their own authors control.
 */
import { describe, it, expect } from 'vitest';
import { replay, seed, standings } from './helpers/world';

/** A world where al posts, bo comments on it, and both message each other. */
function conversation() {
  return [
    ...seed('al', 'bo'),
    { t: 'post', author: 'u_al', text: 'ALICE POST', a: 0.8, rmen: [] },
    { t: 'review', author: 'u_bo', target: 'c1', e: 0.7, f: 0.8, text: 'BO ON ALICE POST' },
    { t: 'review', author: 'u_al', target: 'c2', e: 0.7, f: 0.8, text: 'ALICE REPLY' },
    { t: 'opinion', author: 'u_bo', target: 'c1', p: 0.8, r: 0.8 },
    { t: 'dm', from: 'u_bo', to: 'u_al', text: 'BO MESSAGE' },
    { t: 'dm', from: 'u_al', to: 'u_bo', text: 'ALICE MESSAGE' },
  ];
}

/** What the host does to the stored bytes when a post is deleted. */
function redactPost(acts: Record<string, unknown>[], idx: number) {
  const out = acts.map((a, i) => (i === idx ? { ...a, text: '', redacted: true } : a));
  out.push({ t: 'deletePost', author: acts[idx].author, target: idx });
  return out;
}

describe('deleting a post', () => {
  const base = conversation();
  const postIdx = base.findIndex((a) => a.t === 'post');

  it('removes the payload', () => {
    const st = replay(redactPost(base, postIdx));
    expect(st.payloads.c1).toBeUndefined();
  });

  it('moves nobody’s standing — payload removal is scoring-neutral', () => {
    // The property the whole system rests on. When this broke, deleting one
    // post shifted 15 of 29 actors and changed a published epoch stamp.
    const before = standings(replay(base));
    const after = standings(replay(redactPost(base, postIdx)));
    expect(after).toEqual(before);
  });

  it('leaves the graph intact — the Publish edge survives', () => {
    const before = replay(base);
    const after = replay(redactPost(base, postIdx));
    expect(after.g.edges.length).toBe(before.g.edges.length);
    expect(after.g.edges.some((e) => e.family === 'Publish' && e.tgt === 'c1')).toBe(true);
  });

  it('reproduces an already-published epoch certificate', () => {
    const withEpoch = [...base, { t: 'closeEpoch', epoch: 1 }];
    const before = replay(withEpoch);
    const after = replay(redactPost(withEpoch, postIdx));
    expect(after.epochHistory[0].stamp).toBeCloseTo(before.epochHistory[0].stamp, 12);
    expect(after.epochHistory[0].pass).toBe(before.epochHistory[0].pass);
  });

  it('keeps the comments other people wrote under it', () => {
    // "Commentary outlives its subject": the surviving record is the
    // reviewer's own authored act, not the deleted author's to remove.
    const st = replay(redactPost(base, postIdx));
    expect(st.payloads.c2).toBe('BO ON ALICE POST');
  });
});

describe('deleting an account', () => {
  const base = conversation();

  /** What the host does on deleteAccount: redact only what that id authored. */
  function leave(id: string) {
    const out = base.map((a) => {
      const mine = (a.t === 'post' && a.author === id)
        || (a.t === 'review' && a.author === id)
        || (a.t === 'dm' && a.from === id);
      return mine && a.text ? { ...a, text: '', redacted: true } : a;
    });
    out.push({ t: 'deleteAccount', id });
    return out;
  }

  it('removes what the leaver wrote', () => {
    const st = replay(leave('u_al'));
    expect(st.payloads.c1).toBeUndefined();
    expect(st.payloads.c3).toBeUndefined();
    expect(st.dms.some((m) => m.from === 'u_al' && m.text)).toBe(false);
  });

  it('keeps the other person’s comment', () => {
    expect(replay(leave('u_al')).payloads.c2).toBe('BO ON ALICE POST');
  });

  it('keeps messages the other person wrote, even though they were addressed to the leaver', () => {
    // Blanking on `a.to` destroyed the counterparty's own record — their words,
    // erased by somebody else's decision.
    const st = replay(leave('u_al'));
    expect(st.dms.find((m) => m.from === 'u_bo')?.text).toBe('BO MESSAGE');
  });

  it('leaves everyone else’s standing untouched', () => {
    const before = standings(replay(base));
    const after = standings(replay(leave('u_al')));
    expect(after.u_bo).toBeCloseTo(before.u_bo, 12);
  });

  it('shows the departed as [deleted] without leaking the handle', () => {
    const st = replay(leave('u_al'));
    expect(st.handles.u_al).toBe('[deleted]');
    expect(st.g.nodes.get('u_al')?.label).toBe('[deleted]');
    expect(st.chron.some((c) => /\bal\b/.test(c.line))).toBe(false);
  });

  it('does not retract the vouches the account already gave', () => {
    // Deliberate: removal must not be a way to launder standing that other
    // people have already received.
    const withVouch = [...base, { t: 'opinion', author: 'u_al', target: 'prof_u_bo', p: 0.9, r: 0.9 }];
    const before = replay(withVouch).xById.u_bo;
    const gone = [...withVouch, { t: 'deleteAccount', id: 'u_al' }];
    expect(replay(gone).xById.u_bo).toBeCloseTo(before, 12);
  });
});
