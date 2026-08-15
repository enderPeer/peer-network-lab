/**
 * Two ways a handle's value could be taken by someone who never held it.
 *
 * 1. THE FUNDED-SILENT WINDOW. A handle registered without a PIN that then
 *    burned real bitcoin had reserve but had not "spoken", so hasHistory()
 *    called it unclaimed and a stranger's first setPin was accepted — locking
 *    the owner out and handing them the reserve. Reserve is history now, and
 *    the claim door refuses to credit a burn into an unsecured handle exactly
 *    as the intent door and the PEER-burn door always did.
 *
 * 2. THE STALE MIRROR. Credential indexes were built once at boot and updated
 *    only by applyAct — which a mirror never runs. A setPin that landed on the
 *    primary was invisible to the mirror, so a promoted mirror validated
 *    against the OLD PIN. Adoption re-derives the indexes now.
 *
 * Both run against real server processes on throwaway data directories.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(__dirname, '..');
const sha = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');
const children: ChildProcess[] = [];
const dirs: string[] = [];

async function host(port: number, log: unknown[], extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-rc-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'server-data'), { recursive: true });
  writeFileSync(join(dir, 'server-data', 'acts.jsonl'), log.map((a) => JSON.stringify(a)).join('\n') + (log.length ? '\n' : ''));
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(port)], {
    cwd: ROOT,
    env: { ...process.env, PEER_DATA_DIR: join(dir, 'server-data'), PEER_ACT_RATE: '400', PEER_REGISTER_RATE: '200', ...extraEnv },
    stdio: 'ignore',
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { await fetch(base + '/api/acts'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    if (i === 79) throw new Error('host ' + port + ' did not come up');
  }
  const jget = async (p: string) => (await fetch(base + p)).json() as Promise<Record<string, any>>;
  const total = async () => (await jget('/api/acts')).total as number;
  const act = async (a: Record<string, unknown>) => {
    const r = await fetch(base + '/api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...a, since: await total() }) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const post = async (p: string, body: unknown) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { base, jget, act, post, dir };
}

afterAll(() => {
  for (const c of children) c.kill();
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('a funded but silent unsecured handle cannot be seized', () => {
  it('refuses a stranger’s first setPin once the handle holds reserve, and refuses to credit a burn into an unsecured handle', async () => {
    const h = await host(5341, [
      { t: 'register', id: 'u_nopin', handle: 'nopin', seed: 1, epoch: 0 },   // no PIN
      { t: 'btcBurn', id: 'u_nopin', sats: 100000, addr: 'bc1qdead', txid: 'a'.repeat(64) },
      { t: 'register', id: 'u_fresh', handle: 'fresh', seed: 1, epoch: 0 },   // no PIN, no reserve
    ]);
    // Reserve is history: the stranger's setPin is refused, in the operator-only sentence.
    const seize = await h.act({ t: 'setPin', id: 'u_nopin', pinHash: sha('u_nopin', '9999') });
    expect(seize.status, JSON.stringify(seize.body)).toBe(401);
    expect(seize.body.error).toMatch(/cannot be claimed from outside/);
    // The handle is STILL unsecured — the stranger did not become its owner
    // and cannot lock the real owner out. (An unsecured handle's reserve was
    // always spendable by anyone; the intent/claim doors below are what keep
    // value from entering one in the first place.)
    const st = await h.jget('/api/auth/status?as=u_nopin');
    expect(st.hasPin).toBe(false);

    // A handle with NO history at all can still secure itself — that is the
    // ordinary "register then set a PIN" path and it must keep working.
    const own = await h.act({ t: 'setPin', id: 'u_fresh', pinHash: sha('u_fresh', '4321') });
    expect(own.status, JSON.stringify(own.body)).toBe(200);

    // The claim door refuses to credit value into an unsecured handle, like
    // its siblings, BEFORE it ever talks to a block explorer.
    // Proof of burn must be ON for the door to exist at all (else BURN_OFF
    // answers first); the address is the network's own keyless P2WSH.
    const h2 = await host(5342, [{ t: 'register', id: 'u_open', handle: 'open', seed: 1, epoch: 0 }],
      { PEER_BURN_ADDRESS: 'bc1qrz05qq6tu7senu06nzgkdrhr4dsyn7pd8rrghec0t9h2ktsc27msqvznj2' });
    const c2 = await h2.post('/api/burn/claim', { id: 'u_open', auth: '', txid: 'b'.repeat(64) });
    expect(c2.status).toBe(401);
    expect(c2.body.code).toBe('PIN_REQUIRED');
    expect(c2.body.error).toMatch(/set a PIN on this handle before burning into it/);
  }, 60000);
});

describe('rotating a legacy PIN is not undone by its own upgrade', () => {
  it('after setPin from a sha256 hash, the OLD pin is refused and the NEW one accepted, and no upgrade line follows the rotation', async () => {
    const h = await host(5347, [
      { t: 'register', id: 'u_rot', handle: 'rot', seed: 1, epoch: 0, pinHash: sha('u_rot', '1111') },
      { t: 'btcBurn', id: 'u_rot', sats: 100000, addr: 'bc1qdead', txid: 'd'.repeat(64) },
    ]);
    const rot = await h.act({ t: 'setPin', id: 'u_rot', pinHash: sha('u_rot', '2222'), auth: '1111' });
    expect(rot.status, JSON.stringify(rot.body)).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const acts = (await h.jget('/api/acts')).acts as Array<Record<string, unknown>>;
    const setPins = acts.filter((a) => a.t === 'setPin' && a.id === 'u_rot');
    expect(setPins.length, 'exactly the rotation act — no re-store of the proven old PIN after it').toBe(1);
    expect((await h.act({ t: 'post', author: 'u_rot', text: 'old', a: 0.8, auth: '1111' })).status).toBe(401);
    expect((await h.act({ t: 'post', author: 'u_rot', text: 'new', a: 0.8, auth: '2222' })).status).toBe(200);
  }, 60000);
});

describe('a mirror sees the credentials the primary accepted', () => {
  it('after adopting the primary’s setPin and being PROMOTED IN PLACE by the election, validates against the rotated pin', async () => {
    const seed = [
      { t: 'register', id: 'u_rot', handle: 'rot', seed: 1, epoch: 0, pinHash: sha('u_rot', '1111') },
      { t: 'btcBurn', id: 'u_rot', sats: 100000, addr: 'bc1qdead', txid: 'c'.repeat(64) },
    ];
    const primary = await host(5343, seed);
    // A real mirror in a two-host federation, with the election wound tight
    // so promotion happens in seconds: probe every 2s, promote after 2 misses.
    const mirror = await host(5344, seed, {
      PEER_MIRROR_OF: primary.base,
      PEER_FEDERATION: primary.base + ',' + `http://127.0.0.1:5344`,
      PEER_ELECTION_INTERVAL: '2000',
      PEER_PROMOTE_AFTER: '2',
    });

    // Rotate the PIN on the primary. This is the act a mirror never runs
    // through applyAct — it arrives by adoption.
    const rot = await primary.act({ t: 'setPin', id: 'u_rot', pinHash: sha('u_rot', '2222'), auth: '1111' });
    expect(rot.status, JSON.stringify(rot.body)).toBe(200);

    // Let the mirror adopt the tail.
    for (let i = 0; i < 60; i++) {
      if ((await mirror.jget('/api/acts')).total >= (await primary.jget('/api/acts')).total) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect((await mirror.jget('/api/acts')).total).toBe((await primary.jget('/api/acts')).total);
    // Still a mirror: writes are refused as such, whatever the pin.
    expect((await mirror.act({ t: 'post', author: 'u_rot', text: 'x', a: 0.8, auth: '2222' })).status).toBe(503);

    // Kill the primary; the election promotes the mirror IN PROCESS (no
    // restart, no boot-time reindex) — the exact path that used to keep the
    // stale credential indexes forever.
    const pi = children.findIndex((c) => c.spawnargs.includes('5343'));
    children[pi]!.kill();
    let promoted = false;
    for (let i = 0; i < 40; i++) {
      const e = await mirror.jget('/api/election').catch(() => null);
      if (e && e.primary === null && e.writer === null) { /* not yet informative */ }
      const probe = await mirror.act({ t: 'post', author: 'u_rot', text: 'am I the writer yet', a: 0.8, auth: '2222' });
      if (probe.status !== 503) { promoted = true; expect(probe.status, JSON.stringify(probe.body)).toBe(200); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(promoted, 'the mirror must be promoted by the election within the window').toBe(true);

    // The promoted host validates against the ROTATED pin the primary
    // accepted, not the one it booted with.
    const oldPin = await mirror.act({ t: 'post', author: 'u_rot', text: 'old pin', a: 0.8, auth: '1111' });
    expect(oldPin.status, 'the OLD pin must be refused after adoption + promotion').toBe(401);
    const newPin = await mirror.act({ t: 'post', author: 'u_rot', text: 'new pin', a: 0.8, auth: '2222' });
    expect(newPin.status, JSON.stringify(newPin.body)).toBe(200);
  }, 120000);
});
