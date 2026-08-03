/**
 * The host's refusals.
 *
 * These run against a real server process on a throwaway data directory — the
 * validation, auth and economy rules only exist in the request path, so
 * exercising them any other way would test a copy of them rather than them.
 *
 * Everything asserted here is something that was once wrong in production: an
 * unsecured handle anyone could claim (which locked a real tester out of their
 * own account), destructive acts accepted without a PIN, an energy gate the
 * host claimed to enforce and did not, opaque errors that named no number, and
 * a convenience wrapper that dropped a field and answered 200.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const PORT = 5311;
const BASE = `http://127.0.0.1:${PORT}`;
const OPERATOR = 'operator-token-for-tests';
const ROOT = resolve(__dirname, '..');

let child: ChildProcess;
let dir: string;

const hash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}
const get = async (path: string) => (await fetch(BASE + path)).json() as Promise<Record<string, unknown>>;
const total = async () => (await get('/api/acts')).total as number;
/** Append an act, always with the caller's current view of the log length. */
const act = async (a: Record<string, unknown>) => post('/api/act', { ...a, since: await total() });

beforeAll(async () => {
  // Its own data directory: these tests append, redact and claim handles, and
  // none of that may touch the live log.
  dir = mkdtempSync(join(tmpdir(), 'peer-host-test-'));
  mkdirSync(join(dir, 'server-data'), { recursive: true });
  writeFileSync(join(dir, 'server-data', 'acts.jsonl'), [
    { t: 'register', id: 'u_secured', handle: 'Secured', seed: 1, epoch: 0, pinHash: hash('u_secured', '1234') },
    { t: 'register', id: 'u_open', handle: 'Open', seed: 1, epoch: 0 },
    { t: 'register', id: 'u_fresh', handle: 'Fresh', seed: 1, epoch: 0 },
    // Enough energy for the whole file: a W1 refusal mid-suite would look
    // exactly like the rule under test failing.
    { t: 'burn', id: 'u_secured', amt: 1 },
    { t: 'burn', id: 'u_secured', amt: 1 },
    { t: 'burn', id: 'u_secured', amt: 1 },
    { t: 'burn', id: 'u_open', amt: 1 },
    // u_open has spoken; u_fresh has not. That distinction decides who may
    // still put a first PIN on a handle.
    { t: 'post', author: 'u_open', text: 'a post from an unsecured handle', a: 0.8, rmen: [] },
  ].map((a) => JSON.stringify(a)).join('\n') + '\n');

  child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
    cwd: ROOT,
    // The rate limit is real and is asserted below; it is raised here only so a
    // suite driving the host as fast as it answers does not spend its budget
    // proving the limiter works instead of the rules under test.
    env: {
      ...process.env, PEER_OPERATOR_TOKEN: OPERATOR, PEER_ACT_RATE: '400',
      PEER_DATA_DIR: join(dir, 'server-data'),
    },
    stdio: 'ignore',
  });

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/acts'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('host did not come up');
}, 20000);

afterAll(() => {
  child?.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('PIN protection', () => {
  it('refuses an act from a secured handle without the PIN', async () => {
    const r = await act({ t: 'post', author: 'u_secured', text: 'x', a: 0.5 });
    expect(r.status).toBe(401);
  });

  it('accepts it with the PIN', async () => {
    const r = await act({ t: 'post', author: 'u_secured', text: 'with the pin', a: 0.5, auth: '1234' });
    expect(r.status).toBe(200);
  });

  it('refuses deletion on a handle that has no PIN', async () => {
    // Irreversible acts must never be reachable without proof of identity.
    const r = await act({ t: 'deleteAccount', id: 'u_open' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/no PIN/i);
  });
});

describe('claiming an unsecured handle', () => {
  it('refuses a stranger securing a handle that has already posted', async () => {
    // The exact mechanism that locked a real tester out of their account.
    const r = await act({ t: 'setPin', id: 'u_open', pinHash: hash('u_open', '9999') });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/already posted/i);
  });

  it('still lets a handle with no history secure itself', async () => {
    const r = await act({ t: 'setPin', id: 'u_fresh', pinHash: hash('u_fresh', '4321') });
    expect(r.status).toBe(200);
  });

  it('requires the old PIN to change an existing one', async () => {
    const wrong = await act({ t: 'setPin', id: 'u_fresh', pinHash: hash('u_fresh', '5555'), auth: 'nope' });
    expect(wrong.status).toBe(401);
    const right = await act({ t: 'setPin', id: 'u_fresh', pinHash: hash('u_fresh', '5555'), auth: '4321' });
    expect(right.status).toBe(200);
  });

  it('lets the operator rescue someone who is locked out', async () => {
    const r = await act({ t: 'setPin', id: 'u_open', pinHash: hash('u_open', '1111'), auth: OPERATOR });
    expect(r.status).toBe(200);
  });
});

describe('refusals name their numbers', () => {
  it('says how long the text was and what the limit is', async () => {
    const r = await act({ t: 'post', author: 'u_secured', text: 'z'.repeat(1400), a: 0.5, auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/1400/);
    expect(r.body.error).toMatch(/1000/);
  });

  it('says the serialised size when the whole act is too big', async () => {
    // This one used to answer a bare "act too large" — the same misread the
    // per-field messages had just been cured of, one layer up.
    const r = await act({ t: 'post', author: 'u_secured', text: 'z'.repeat(500), a: 0.5, auth: '1234', media: [] });
    // (a valid act; the guard is exercised by an oversized one below)
    expect([200, 400]).toContain(r.status);
    const big = await act({ t: 'dm', from: 'u_secured', to: 'u_open', text: 'z'.repeat(600), auth: '1234' });
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/\d+/);
  });
});

describe('revision authorship', () => {
  it('refuses a revision of someone else’s post', async () => {
    const acts = (await get('/api/acts')).acts as Array<Record<string, unknown>>;
    const idx = acts.findIndex((a) => a.t === 'post' && a.author === 'u_open');
    const r = await act({ t: 'post', author: 'u_secured', text: 'hijack', a: 0.5, target: idx, auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/only the author/i);
  });

  it('retires editPost with a message naming its replacement', async () => {
    const r = await act({ t: 'editPost', author: 'u_secured', target: 1, text: 'x', auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/revision/i);
  });
});

describe('the bot API must not diverge from the act API it wraps', () => {
  it('refuses a revision of another author’s post, rather than silently publishing a new one', async () => {
    // It used to drop the field and answer 200: the caller believed they had
    // revised something when they had published something else entirely.
    const feed = await get('/api/v1/feed?as=u_secured&sort=new&limit=20') as { items: Array<{ id: string; author: string }> };
    const theirs = feed.items.find((i) => i.author === 'u_open');
    expect(theirs).toBeDefined();
    const r = await post('/api/v1/post', { as: 'u_secured', pin: '1234', text: 'x', revise: theirs!.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/only the author/i);
  });

  it('answers 404 for a revision target that does not exist', async () => {
    const r = await post('/api/v1/post', { as: 'u_secured', pin: '1234', text: 'x', revise: 'c99999' });
    expect(r.status).toBe(404);
  });
});

describe('views are telemetry, never protocol', () => {
  it('does not append an act', async () => {
    const before = await total();
    await post('/api/view', { ids: ['c1'] });
    expect(await total()).toBe(before);
  });

  it('ignores ids that name no content', async () => {
    const r = await post('/api/view', { ids: ['c9999999', 'not-an-id'] });
    expect(r.body.counted).toBe(0);
  });

  it('says plainly that views are not scored', async () => {
    const d = await get('/api/views');
    expect(String(d.note)).toMatch(/not protocol|never enter/i);
  });
});

describe('deleting a post that has been revised', () => {
  /** Post, then edit it, and hand back both act indices. */
  async function postThenRevise(text: string, edit: string) {
    // /api/act answers with the acts the caller was missing, not an index, so
    // the position is read off the log length either side of the append.
    const p = await act({ t: 'post', author: 'u_secured', text, a: 0.8, auth: '1234' });
    expect(p.status).toBe(200);
    const mintIdx = (await total()) - 1;
    const r = await act({ t: 'post', author: 'u_secured', text: edit, a: 0.8, target: mintIdx, auth: '1234' });
    expect(r.status).toBe(200);
    return { mintIdx, revIdx: (await total()) - 1 };
  }
  const served = async () => JSON.stringify((await get('/api/acts')).acts);

  it('removes the revised text from the served log, not only the original', async () => {
    // The interface tells the author their content is gone from the record.
    // Redacting only the mint act left the version everyone had been reading
    // sitting in /api/acts — deletion that deletes the wrong copy is worse than
    // one that refuses, because the author is told it worked.
    const { mintIdx } = await postThenRevise('FIRST DRAFT alpha', 'PUBLISHED TEXT beta');
    expect(await served()).toContain('PUBLISHED TEXT beta');
    const d = await act({ t: 'deletePost', author: 'u_secured', target: mintIdx, auth: '1234' });
    expect(d.status).toBe(200);
    const log = await served();
    expect(log).not.toContain('PUBLISHED TEXT beta');
    expect(log).not.toContain('FIRST DRAFT alpha');
  });

  it('deletes the post when the tombstone names the revision act', async () => {
    // A caller holding an act index has no way to know it is a revision. This
    // used to answer 200 and un-edit the post instead of removing it.
    const { revIdx } = await postThenRevise('FIRST DRAFT gamma', 'PUBLISHED TEXT delta');
    const d = await act({ t: 'deletePost', author: 'u_secured', target: revIdx, auth: '1234' });
    expect(d.status).toBe(200);
    const log = await served();
    expect(log).not.toContain('PUBLISHED TEXT delta');
    expect(log).not.toContain('FIRST DRAFT gamma');
  });

  it('records the tombstone against the post, not the edit', async () => {
    const { mintIdx, revIdx } = await postThenRevise('FIRST DRAFT eps', 'PUBLISHED TEXT zeta');
    await act({ t: 'deletePost', author: 'u_secured', target: revIdx, auth: '1234' });
    const list = (await get('/api/acts')).acts as Record<string, unknown>[];
    const tomb = list.filter((a) => a.t === 'deletePost').pop()!;
    expect(tomb.target).toBe(mintIdx);
  });

  it('still refuses when someone else authored the post it revises', async () => {
    const { revIdx } = await postThenRevise('FIRST DRAFT eta', 'PUBLISHED TEXT theta');
    const r = await act({ t: 'deletePost', author: 'u_open', target: revIdx });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/only the author/i);
  });
});

describe('the rate limit says the number it actually applies', () => {
  it('reports the configured limit rather than a hardcoded 20', async () => {
    // The limit became operator-tunable so the suite could run. That is exactly
    // how a message starts lying about what the code does, so the published
    // figure and the refusal text both read the same variable.
    const doc = await get('/api/v1');
    expect(String((doc.limits as Record<string, unknown>).acts)).toContain('400');
  });
});

describe('acts may not name content that was never minted', () => {
  // Eighteen acts on the live network point at content ids replay never minted.
  // They were accepted, charged energy, and now read as "something since
  // removed" in a record that is supposed to be navigable. Nothing checked.
  it('refuses a reaction to an id that does not exist, and names the id', async () => {
    const r = await act({ t: 'opinion', author: 'u_secured', target: 'c99999', p: 0.5, r: 0.5, auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/c99999/);
  });

  it('refuses a comment on an id that does not exist', async () => {
    const r = await act({ t: 'review', author: 'u_secured', target: 'c99999', e: 0.5, f: 0.5, text: 'hi', auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/c99999/);
  });

  it('refuses a tag on an id that does not exist', async () => {
    const r = await act({ t: 'tag', author: 'u_secured', target: 'c99999', name: 'x', r: 0.5, c: 0.5, auth: '1234' });
    expect(r.status).toBe(400);
  });

  it('refuses a post quoting an id that does not exist', async () => {
    const r = await act({ t: 'post', author: 'u_secured', text: 'quoting nothing', a: 0.8, ref: 'c99999', auth: '1234' });
    expect(r.status).toBe(400);
  });

  it('still accepts a person-vouch, whose target is a profile and not content', async () => {
    const r = await act({ t: 'opinion', author: 'u_secured', target: 'prof_u_open', p: 0.5, r: 0.5, auth: '1234' });
    expect(r.status).toBe(200);
  });

  it('still accepts a reaction to content that does exist', async () => {
    const feed = await get('/api/v1/feed?as=u_secured') as { items: Array<{ id: string }> };
    const id = feed.items[0].id;
    const r = await act({ t: 'opinion', author: 'u_secured', target: id, p: 0.5, r: 0.5, auth: '1234' });
    expect(r.status).toBe(200);
  });
});

describe('events name the node they minted', () => {
  it('a post event carries the content id, so clients never derive one', async () => {
    // An API client derived node ids by counting posts. The counter also ticks
    // for hyperedge legs, so the derived id was off by one and a real reply
    // went to a node that did not exist. The event stream now says the id.
    await act({ t: 'post', author: 'u_secured', text: 'node field check', a: 0.8, auth: '1234' });
    const idx = (await total()) - 1;
    const d = await get(`/api/v1/events?since=${idx}&limit=1`) as { events: Array<Record<string, unknown>> };
    expect(d.events[0].kind).toBe('post');
    expect(String(d.events[0].node)).toMatch(/^c\d+$/);
  });

  it('a revision event carries the node it wrote to, not a fresh one', async () => {
    const p = await act({ t: 'post', author: 'u_secured', text: 'original for node test', a: 0.8, auth: '1234' });
    expect(p.status).toBe(200);
    const mintIdx = (await total()) - 1;
    const mintNode = ((await get(`/api/v1/events?since=${mintIdx}&limit=1`)) as { events: Array<Record<string, unknown>> }).events[0].node;
    await act({ t: 'post', author: 'u_secured', text: 'revised for node test', a: 0.8, target: mintIdx, auth: '1234' });
    const revIdx = (await total()) - 1;
    const revNode = ((await get(`/api/v1/events?since=${revIdx}&limit=1`)) as { events: Array<Record<string, unknown>> }).events[0].node;
    expect(revNode).toBe(mintNode);
  });
});
