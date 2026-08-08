/**
 * Following, profiles, search and recovery.
 *
 * The load-bearing assertion in this file is the one about standing. This
 * network's whole claim is that influence is transported commitment and not
 * attention — it keeps view counts out of the log, the graph and every score,
 * and says so on screen. A follow is attention. So the test that matters is
 * not that following works; it is that following changes NOTHING: no edge, no
 * standing, no rate, no epoch certificate. If that ever stops holding, the
 * network is measuring popularity and still telling people it does not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, pbkdf2Sync } from 'node:crypto';
import { replay, seed, standings } from './helpers/world';

const PORT = 5321;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(__dirname, '..');
let child: ChildProcess;
let dir: string;

const pinHash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');
/** The modern format, the way the client derives it. */
function strongHash(secret: string) {
  const salt = randomBytes(16).toString('hex');
  const h = pbkdf2Sync(secret, Buffer.from(salt, 'hex'), 210000, 32, 'sha256').toString('hex');
  return `pbkdf2$210000$${salt}$${h}`;
}

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const total = async () => ((await (await fetch(BASE + '/api/acts')).json()) as { total: number }).total;
const act = async (a: Record<string, unknown>) => post('/api/act', { ...a, since: await total() });

// ── Following changes nothing that is scored ─────────────────────────────

describe('a follow is recorded and never scored', () => {
  it('leaves every standing, edge and ledger exactly as it found them', () => {
    const base = seed('ann', 'bob');
    const before = replay(base);
    const after = replay(base.concat([{ t: 'follow', from: 'u_ann', to: 'u_bob' }]));

    expect(standings(after), 'a follow moved a standing').toEqual(standings(before));
    expect(after.g.edges.length, 'a follow added an edge').toBe(before.g.edges.length);
    expect(after.g.nodes.size, 'a follow minted a node').toBe(before.g.nodes.size);
    for (const l of after.ledgers) {
      const was = before.ledgerById[l.id];
      expect(l.burnBal, `reserve moved for ${l.id}`).toBe(was.burnBal);
      expect(l.actCount, `act count moved for ${l.id}`).toBe(was.actCount);
    }
    // And it IS recorded — otherwise it would not survive a reload.
    expect(after.follows.u_ann.u_bob).toBe(true);
    expect(after.followers.u_bob.u_ann).toBe(true);
  });

  it('unfollows, and refuses to follow itself', () => {
    const base = seed('ann', 'bob');
    const st = replay(base.concat([
      { t: 'follow', from: 'u_ann', to: 'u_bob' },
      { t: 'follow', from: 'u_ann', to: 'u_bob', on: false },
    ]));
    expect(st.follows.u_ann && st.follows.u_ann.u_bob).toBeUndefined();
    // The replay ignores a self-follow; the host refuses it outright (below).
    const self = replay(base.concat([{ t: 'follow', from: 'u_ann', to: 'u_ann' }]));
    expect(self.follows.u_ann).toBeUndefined();
  });

  it('records a profile without touching a score', () => {
    const base = seed('ann');
    const before = replay(base);
    const after = replay(base.concat([{ t: 'profile', id: 'u_ann', bio: 'builds things', link: 'https://example.org' }]));
    expect(standings(after)).toEqual(standings(before));
    expect(after.profiles.u_ann.bio).toBe('builds things');
    expect(after.profiles.u_ann.link).toBe('https://example.org');
  });
});

// ── The host's half ──────────────────────────────────────────────────────

describe('the host on following, profiles and recovery', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-social-test-'));
    mkdirSync(join(dir, 'server-data'), { recursive: true });
    child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
      stdio: 'ignore', env: { ...process.env, PEER_DATA_DIR: join(dir, 'server-data') },
    });
    for (let i = 0; i < 100; i++) {
      try { await fetch(BASE + '/api/live'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    for (const [id, handle] of [['u_ann', 'Ann'], ['u_bob', 'Bob2']]) {
      await act({ t: 'register', id, handle, seed: 1, epoch: 0, pinHash: pinHash(id, '4321') });
      for (let i = 0; i < 4; i++) await act({ t: 'burn', id, amt: 1, auth: '4321' });
    }
  }, 30000);

  afterAll(() => {
    child?.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows holds files briefly */ }
  });

  it('accepts a follow and refuses a self-follow and an unknown target', async () => {
    expect((await act({ t: 'follow', from: 'u_ann', to: 'u_bob', auth: '4321' })).status).toBe(200);
    const self = await act({ t: 'follow', from: 'u_ann', to: 'u_ann', auth: '4321' });
    expect(self.status).toBe(400);
    expect(String(self.body.error)).toMatch(/cannot follow itself/);
    const ghost = await act({ t: 'follow', from: 'u_ann', to: 'u_nobody', auth: '4321' });
    expect(ghost.status).toBe(400);
  });

  it('will not let one account write another account\'s profile', async () => {
    // The actor of a profile act lives in `id`. If that is not wired into the
    // host's actor derivation, this passes silently and anyone can rewrite
    // anyone's description — which is why it is a test and not a comment.
    const forged = await act({ t: 'profile', id: 'u_bob', bio: 'written by someone else', auth: 'wrong' });
    expect(forged.status).toBe(401);
    const own = await act({ t: 'profile', id: 'u_ann', bio: 'mine', auth: '4321' });
    expect(own.status).toBe(200);
  });

  it('holds the profile to a length, and refuses a link that is not a link', async () => {
    const long = await act({ t: 'profile', id: 'u_ann', bio: 'x'.repeat(281), auth: '4321' });
    expect(long.status).toBe(400);
    expect(String(long.body.error)).toMatch(/281/);
    const bad = await act({ t: 'profile', id: 'u_ann', bio: 'ok', link: 'javascript:alert(1)', auth: '4321' });
    expect(bad.status).toBe(400);
  });

  it('recovers a locked account with its code, and only with its code', async () => {
    const CODE = 'aaaa1111-bbbb2222-cccc3333-dddd4444';
    expect((await act({ t: 'setRecovery', id: 'u_ann', codeHash: strongHash(CODE), auth: '4321' })).status).toBe(200);

    // The PIN is now forgotten. The wrong code must not help.
    const wrong = await post('/api/auth/recover', { as: 'u_ann', code: 'not-the-code', pinHash: strongHash('9999') });
    expect(wrong.status).toBe(401);
    // ...and neither must the right code for somebody else's handle.
    const other = await post('/api/auth/recover', { as: 'u_bob', code: CODE, pinHash: strongHash('9999') });
    expect(other.status).toBe(401);

    const ok = await post('/api/auth/recover', { as: 'u_ann', code: CODE, pinHash: strongHash('9999') });
    expect(ok.status).toBe(200);

    // The new PIN works and the old one does not.
    // A PIN-gated act, not a burn: burns are minted by the host after it
    // verifies a transaction, so they can never come through this door.
    expect((await act({ t: 'profile', id: 'u_ann', bio: 'right pin', auth: '9999' })).status).toBe(200);
    expect((await act({ t: 'profile', id: 'u_ann', bio: 'wrong pin', auth: '4321' })).status).toBe(401);

    // And the record says how it happened, rather than looking like an
    // ordinary PIN change by the owner.
    const { acts } = await (await fetch(BASE + '/api/acts')).json() as { acts: Array<Record<string, unknown>> };
    const reset = acts.filter((a) => a.t === 'setPin' && a.id === 'u_ann').pop()!;
    expect(reset.byRecovery).toBe(true);
  }, 30000);

  it('keeps a contact address out of the public log entirely', async () => {
    const r = await post('/api/contact', { as: 'u_ann', auth: '9999', email: 'someone@example.org' });
    expect(r.status).toBe(200);

    // The one assertion that matters: the log is served, mirrored and
    // published, so an address in it would be public for good.
    const raw = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    expect(raw, 'a contact address reached the act log').not.toMatch(/someone@example\.org/);
    const served = await (await fetch(BASE + '/api/acts')).text();
    expect(served, 'a contact address is being served to anyone').not.toMatch(/someone@example\.org/);

    // It is on the host, beside the log, in a directory git ignores wholesale.
    const book = join(dir, 'server-data', 'contacts.json');
    expect(existsSync(book)).toBe(true);
    expect(readFileSync(book, 'utf8')).toMatch(/someone@example\.org/);
  });

  it('refuses a contact address without the PIN that owns the handle', async () => {
    const r = await post('/api/contact', { as: 'u_bob', auth: 'wrong', email: 'x@example.org' });
    expect(r.status).toBe(401);
  });
});
