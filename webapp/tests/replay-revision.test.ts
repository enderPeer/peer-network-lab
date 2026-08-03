/**
 * Revisions, and the id stability everything else depends on.
 *
 * Content ids are minted by a counter and then referenced by later acts, so a
 * change in counter allocation does not fail loudly — it silently re-points
 * stored references at the wrong content. That is the failure mode these tests
 * exist to catch.
 */
import { describe, it, expect } from 'vitest';
import { replay, seed, contentIds, standings } from './helpers/world';

function withPost() {
  return [
    ...seed('al', 'bo'),
    { t: 'post', author: 'u_al', text: 'ORIGINAL', a: 0.8, rmen: [] },   // c1
    { t: 'review', author: 'u_bo', target: 'c1', e: 0.7, f: 0.8, text: 'A COMMENT' }, // c2
    { t: 'opinion', author: 'u_bo', target: 'c1', p: 0.8, r: 0.8 },
  ];
}

describe('revising a post', () => {
  const base = withPost();
  const postIdx = base.findIndex((a) => a.t === 'post');
  const revised = [...base, { t: 'post', author: 'u_al', text: 'REVISED', a: 0.8, target: postIdx, rmen: [] }];

  it('supersedes the text', () => {
    expect(replay(revised).payloads.c1).toBe('REVISED');
  });

  it('mints nothing — the node count is unchanged', () => {
    // An act naming an existing node is ordinary, not genesis. If it minted,
    // every later content id would shift by one.
    expect(contentIds(replay(revised))).toEqual(contentIds(replay(base)));
  });

  it('leaves creator, comments and reactions attached', () => {
    const st = replay(revised);
    expect(st.creators.c1).toBe('u_al');
    expect(st.payloads.c2).toBe('A COMMENT');
    expect(st.g.edges.filter((e) => e.family === 'Opinion' && e.tgt === 'c1').length).toBe(1);
  });

  it('marks the post as edited', () => {
    expect(replay(revised).postMeta.c1.edited).toBe(true);
  });

  it('appends a second Publish edge rather than rewriting the first', () => {
    const pubs = replay(revised).g.edges.filter((e) => e.family === 'Publish' && e.tgt === 'c1');
    expect(pubs.length).toBe(2);
  });

  it('costs the author an act, like any other publication', () => {
    const before = replay(base).ledgerById.u_al;
    const after = replay(revised).ledgerById.u_al;
    expect(after.actCount).toBe(before.actCount + 1);
    expect(after.burnBal).toBeLessThan(before.burnBal);
  });

  it('ignores a target that never became a node', () => {
    // Quote and mention legs consume counter values without minting, so a
    // target can name a number that is not a post. It must mint instead of
    // silently attaching to nothing.
    const dangling = [...base, { t: 'post', author: 'u_al', text: 'X', a: 0.8, target: 9999, rmen: [] }];
    expect(contentIds(replay(dangling)).length).toBe(contentIds(replay(base)).length + 1);
  });
});

describe('revising a comment', () => {
  const base = withPost();
  const reviewIdx = base.findIndex((a) => a.t === 'review');
  const revised = [...base, {
    t: 'review', author: 'u_bo', target: 'c1', e: 0.7, f: 0.8, text: 'REVISED COMMENT', upd: reviewIdx,
  }];

  it('supersedes the comment text without minting a new comment', () => {
    const st = replay(revised);
    expect(st.payloads.c2).toBe('REVISED COMMENT');
    expect(contentIds(st)).toEqual(contentIds(replay(base)));
  });
});

describe('content id stability', () => {
  it('ids do not shift when acts are appended', () => {
    const base = withPost();
    const ids = contentIds(replay(base));
    const grown = [...base, { t: 'post', author: 'u_bo', text: 'LATER', a: 0.5, rmen: [] }];
    // every earlier id keeps its meaning
    const after = replay(grown);
    ids.forEach((id) => expect(after.payloads[id]).toBe(replay(base).payloads[id]));
  });

  it('a quote leg consumes a counter value without minting a node', () => {
    // This is why a comment can point at an id that is not a post, and why the
    // jump has to tolerate it.
    const base = [
      ...seed('al'),
      { t: 'post', author: 'u_al', text: 'FIRST', a: 0.8, rmen: [] },              // c1
      { t: 'post', author: 'u_al', text: 'QUOTING', a: 0.8, ref: 'c1', rmen: [] }, // c2, and c3 burned by the ref leg
      { t: 'post', author: 'u_al', text: 'THIRD', a: 0.8, rmen: [] },              // c4
    ];
    const st = replay(base);
    expect(st.payloads.c1).toBe('FIRST');
    expect(st.payloads.c2).toBe('QUOTING');
    expect(st.payloads.c3).toBeUndefined();   // consumed by the reference leg
    expect(st.payloads.c4).toBe('THIRD');
  });

  it('a mention resolves against seed actors, so redaction cannot shift ids', () => {
    // The server stamps `rmen`; when it disagreed with the client about the
    // four seed handles, redacting an old post dropped a counter increment and
    // re-pointed every later reference.
    const withMention = [
      ...seed('al'),
      { t: 'post', author: 'u_al', text: 'hello @Carol', a: 0.8, rmen: ['carol'] },
      { t: 'post', author: 'u_al', text: 'after', a: 0.8, rmen: [] },
    ];
    const st = replay(withMention);
    // the mention leg consumed c2, so the next post is c3
    expect(st.payloads.c1).toBe('hello @Carol');
    expect(st.payloads.c3).toBe('after');
  });
});

describe('the chronicle', () => {
  it('records link targets as data, not as prose to be matched', () => {
    // Handles here include "A", "cam" and "Echo"; matching them against text
    // would light up inside ordinary words. The label is recorded with its id.
    const acts = [
      ...seed('al', 'bo'),
      { t: 'opinion', author: 'u_al', target: 'prof_u_bo', p: 0.9, r: 0.9 },
    ];
    const row = replay(acts).chron.find((c) => /vouched on/.test(c.line));
    expect(row).toBeDefined();
    expect(row!.refs?.[0]).toEqual({ label: 'bo', id: 'u_bo' });
    expect(row!.line).toContain(row!.refs![0].label);
  });

  it('never leaks a departed handle into chronicle text', () => {
    const acts = [
      ...seed('al', 'bo'),
      { t: 'transferL0', from: 'u_bo', to: 'u_al', x: 1, cls: 'live' },
      { t: 'deleteAccount', id: 'u_al' },
    ];
    const st = replay(acts);
    const line = st.chron.find((c) => /sent/.test(c.line));
    expect(line?.line).toContain('[deleted]');
    expect(line?.line).not.toContain('al ');
  });
});

describe('economy parity', () => {
  it('a hyper act debits exactly once', () => {
    // A review projects two edges but is one authored act; charging twice
    // would make the epoch budget and every rate wrong.
    const base = [...seed('al', 'bo'), { t: 'post', author: 'u_al', text: 'P', a: 0.8, rmen: [] }];
    const before = replay(base).ledgerById.u_bo.actCount;
    const after = replay([...base, { t: 'review', author: 'u_bo', target: 'c1', e: 0.7, f: 0.8, text: 'C' }]);
    expect(after.ledgerById.u_bo.actCount).toBe(before + 1);
  });

  it('acting dilutes the actor’s own rate', () => {
    const base = [...seed('al')];
    const rate = (s: ReturnType<typeof replay>) => s.ledgerById.u_al.burnBal / s.ledgerById.u_al.actCount;
    const before = rate(replay(base));
    const after = rate(replay([...base, { t: 'post', author: 'u_al', text: 'P', a: 0.8, rmen: [] }]));
    expect(after).toBeLessThan(before);
  });

  it('replay is a pure function of the log', () => {
    const acts = withPost();
    expect(standings(replay(acts))).toEqual(standings(replay(acts)));
  });
});
