/**
 * Impersonation, brute force, and what replaces a guessable secret.
 *
 * Every case here is something a tester demonstrated or something the log
 * makes trivially possible. The first one was performed on the live network:
 * two accounts registered wearing another person's handle, byte for byte, and
 * one of them posted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import { handleSkeleton, handleClash, takenHandles } from '../identity.mjs';
import { verifyAssertion, newChallenge } from '../webauthn.mjs';

const PORT = 5315;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(__dirname, '..');
let child: ChildProcess;
let dir: string;

const sha = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');
const jget = async (u: string) => (await fetch(u)).json() as Promise<Record<string, any>>;
const total = async () => (await jget(BASE + '/api/acts')).total as number;
async function act(a: Record<string, unknown>) {
  const r = await fetch(BASE + '/api/act', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...a, since: await total() }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'peer-sec-'));
  mkdirSync(join(dir, 'server-data'), { recursive: true });
  writeFileSync(join(dir, 'server-data', 'acts.jsonl'), [
    // Legacy sha256 hash, exactly as accounts on the live network carry.
    { t: 'register', id: 'u_ender133', handle: 'Ender133', seed: 1, epoch: 0, pinHash: sha('u_ender133', '1234') },
    { t: 'burn', id: 'u_ender133', amt: 1 },
    { t: 'post', author: 'u_ender133', text: 'the real one', a: 0.8, rmen: [] },
  ].map((a) => JSON.stringify(a)).join('\n') + '\n');
  child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, PEER_DATA_DIR: join(dir, 'server-data'), PEER_ACT_RATE: '400' },
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

describe('a handle identifies one person', () => {
  it('refuses the exact attack that was performed on the live network', async () => {
    // u_ender1337 and u_ender1338, both displaying "Ender133". Registration
    // only ever checked that the ID was free.
    const r = await act({ t: 'register', id: 'u_ender1337', handle: 'Ender133', seed: 1, epoch: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/already registered/i);
  });

  it('refuses the look-alikes, not just the exact string', async () => {
    const variants = [
      ['ender133', 'case'],
      ['Ender-133', 'punctuation'],
      ['Еnder133', 'Cyrillic E'],
      ['EnderI33', 'capital I for the digit 1'],
      ['E n d e r 1 3 3', 'spaces'],
      ['Ｅnder１３３', 'fullwidth digits'],
    ];
    for (const [handle, why] of variants) {
      const r = await act({ t: 'register', id: 'u_x' + Math.random().toString(36).slice(2, 8), handle, seed: 1, epoch: 0 });
      expect(r.status, why).toBe(400);
      expect(r.body.error, why).toMatch(/already registered|reads as/i);
    }
  });

  it('still lets a genuinely different name through', async () => {
    const r = await act({ t: 'register', id: 'u_koebbe', handle: 'Koebbe', seed: 1, epoch: 0 });
    expect(r.status).toBe(200);
  });

  it('refuses a handle made only of decoration', () => {
    expect(handleClash('!!!', new Map())).toMatch(/at least one letter/);
    expect(handleSkeleton('•••')).toBe('');
  });

  it('explains the refusal instead of just saying taken', () => {
    const taken = takenHandles([{ t: 'register', handle: 'Fable' }]);
    expect(handleClash('FabIe', taken)).toMatch(/reads as Fable/);
    expect(handleClash('Fable', taken)).toMatch(/already registered/);
  });
});

describe('a PIN hash in a public log', () => {
  it('is stored slowly, so the whole four-digit keyspace is not free to try', async () => {
    // The old format was sha256(id:pin): ten thousand hashes to break a
    // four-digit PIN, computed offline where no rate limit can reach.
    const before = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    expect(before).toContain(sha('u_ender133', '1234'));   // legacy, as deployed

    const ok = await act({ t: 'post', author: 'u_ender133', text: 'signing in', a: 0.8, auth: '1234' });
    expect(ok.status).toBe(200);

    // Correct PIN on a legacy hash upgrades it in place, silently, for the
    // people who would never read a notice telling them to reset anything.
    const after = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    expect(after).not.toContain(sha('u_ender133', '1234'));
    expect(after).toMatch(/pbkdf2\$\d{6}\$[a-f0-9]{32}\$[a-f0-9]{64}/);
  });

  it('still accepts the same PIN after the upgrade', async () => {
    const r = await act({ t: 'post', author: 'u_ender133', text: 'again', a: 0.8, auth: '1234' });
    expect(r.status).toBe(200);
  });

  it('refuses a wrong PIN, before and after', async () => {
    const r = await act({ t: 'post', author: 'u_ender133', text: 'nope', a: 0.8, auth: '9999' });
    expect(r.status).toBe(401);
  });

  it('does not rewrite anything on a failed guess', async () => {
    const before = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    await act({ t: 'post', author: 'u_ender133', text: 'x', a: 0.8, auth: '0000' });
    expect(readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8')).toBe(before);
  });

  it('reports honestly what protects an account', async () => {
    const d = await jget(BASE + '/api/auth/status?as=u_ender133');
    expect(d.hasPin).toBe(true);
    expect(String(d.pinStorage)).toMatch(/pbkdf2/);
    expect(d.passkeys).toEqual([]);
  });
});

describe('passkeys', () => {
  const rpId = '127.0.0.1';

  /** Sign an assertion the way a browser would, with a real P-256 key. */
  function assertWith(privateKey: any, cose: unknown[], challenge: string, origin: string, counter: number) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const authData = Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([0x05]),
      Buffer.from([0, 0, 0, counter]),
    ]);
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    const der = createSign('SHA256').update(signed).sign(privateKey);
    const rl = der[3];
    const r = der.subarray(4, 4 + rl);
    const sl = der[4 + rl + 1];
    const sBuf = der.subarray(4 + rl + 2, 4 + rl + 2 + sl);
    const pad = (b: Buffer) => Buffer.concat([Buffer.alloc(Math.max(0, 32 - b.length)), b.subarray(Math.max(0, b.length - 32))]);
    return {
      clientDataJSON: clientData.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: Buffer.concat([pad(r), pad(sBuf)]).toString('base64url'),
    };
  }

  function makeKey() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = [[1, 2], [3, -7], [-1, 1], [-2, jwk.x], [-3, jwk.y]];
    return { privateKey, cose };
  }

  it('accepts a genuine signature', () => {
    const { privateKey, cose } = makeKey();
    const challenge = newChallenge();
    const origin = 'https://example.org';
    const resp = assertWith(privateKey, cose, challenge, origin, 7);
    expect(verifyAssertion(resp, { cose, signCount: 3 }, { challenge, origin, rpId })).toBeNull();
  });

  it('refuses a replayed challenge — the thing a PIN cannot refuse', () => {
    const { privateKey, cose } = makeKey();
    const origin = 'https://example.org';
    const resp = assertWith(privateKey, cose, newChallenge(), origin, 7);
    expect(verifyAssertion(resp, { cose, signCount: 3 }, { challenge: newChallenge(), origin, rpId }))
      .toMatch(/replayed or stale/);
  });

  it('refuses a signature made for another origin — this is what defeats phishing', () => {
    const { privateKey, cose } = makeKey();
    const challenge = newChallenge();
    const resp = assertWith(privateKey, cose, challenge, 'https://phish.example', 7);
    expect(verifyAssertion(resp, { cose, signCount: 3 }, { challenge, origin: 'https://example.org', rpId }))
      .toMatch(/origin mismatch/);
  });

  it('refuses a tampered signature and a counter that went backwards', () => {
    const { privateKey, cose } = makeKey();
    const challenge = newChallenge();
    const origin = 'https://example.org';
    const good = assertWith(privateKey, cose, challenge, origin, 7);
    const sig = Buffer.from(good.signature, 'base64url');
    sig[63] ^= 1;
    expect(verifyAssertion({ ...good, signature: sig.toString('base64url') }, { cose, signCount: 3 }, { challenge, origin, rpId }))
      .toMatch(/does not verify/);
    expect(verifyAssertion(good, { cose, signCount: 99 }, { challenge, origin, rpId }))
      .toMatch(/cloned credential/);
  });

  it('refuses a key signed by somebody else entirely', () => {
    const mine = makeKey();
    const theirs = makeKey();
    const challenge = newChallenge();
    const origin = 'https://example.org';
    const resp = assertWith(theirs.privateKey, theirs.cose, challenge, origin, 7);
    expect(verifyAssertion(resp, { cose: mine.cose, signCount: 3 }, { challenge, origin, rpId }))
      .toMatch(/does not verify/);
  });

  it('issues single-use challenges', async () => {
    const a = await (await fetch(BASE + '/api/auth/challenge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'u_ender133' }),
    })).json();
    const b = await (await fetch(BASE + '/api/auth/challenge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'u_ender133' }),
    })).json();
    expect(a.challenge).not.toBe(b.challenge);
    expect(String(a.challenge).length).toBeGreaterThan(30);
  });

  it('will not let a stranger bolt a key onto a handle that has already acted', async () => {
    const ch = await (await fetch(BASE + '/api/auth/challenge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'u_ender133' }),
    })).json();
    const r = await fetch(BASE + '/api/auth/passkey', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'u_ender133', challenge: ch.challenge, response: {} }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatch(/PIN|wrong or missing/i);
  });
});

describe('an act must come from an account that exists', () => {
  // Demonstrated live: three posts authored by "Luke Skywalker", "Darth Vader"
  // and "Han Solo" — names that were never registered. Nothing checked the
  // author existed, so anyone could speak as anyone; and because the replay
  // then dereferenced a ledger that was not there, the same acts crashed every
  // reader of the log and took the host down. One missing check, two failures.
  it('refuses a post from a handle that never registered', async () => {
    const r = await act({ t: 'post', author: 'Luke Skywalker', text: 'ghost', a: 0.8 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no such handle/i);
  });

  it('refuses every other act kind from a ghost too', async () => {
    for (const a of [
      { t: 'opinion', author: 'Darth Vader', target: 'c1', p: 0.5, r: 0.5 },
      { t: 'review', author: 'Han Solo', target: 'c1', e: 0.5, f: 0.5, text: 'x' },
      { t: 'tag', author: 'Boba Fett', target: 'c1', name: 'x', r: 0.5, c: 0.5 },
      { t: 'burn', id: 'Chewbacca', amt: 1 },
      { t: 'dm', from: 'Leia', to: 'u_ender133', text: 'x' },
    ]) {
      const r = await act(a);
      expect(r.status, a.t).toBe(400);
      expect(r.body.error, a.t).toMatch(/no such handle|no such recipient/i);
    }
  });

  it('refuses a message TO a handle that never registered', async () => {
    const r = await act({ t: 'dm', from: 'u_ender133', to: 'Jabba', text: 'x', auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no such recipient/i);
  });

  it('still lets the four seed actors act — they exist without a register act', async () => {
    const r = await act({ t: 'post', author: 'alice', text: 'seeded, not registered', a: 0.8 });
    expect(r.status).toBe(200);
  });

  it('survives a log that already contains ghost acts, rather than dying on it', async () => {
    // A replay that throws on input is a denial of service with extra steps.
    // Poison the log directly, the way the live one was poisoned, and require
    // the host to keep answering with the ghosts simply skipped.
    const { replay } = await import('./helpers/world');
    const acts = [
      { t: 'seedWorld' },
      { t: 'register', id: 'u_real', handle: 'Real', seed: 1, epoch: 0 },
      { t: 'burn', id: 'u_real', amt: 1 },
      { t: 'post', author: 'u_real', text: 'genuine', a: 0.8, rmen: [] },
      { t: 'post', author: 'Luke Skywalker', text: 'ghost post', a: 0.8, rmen: [] },
      { t: 'opinion', author: 'Darth Vader', target: 'c1', p: 0.9, r: 0.9 },
      { t: 'burn', id: 'Han Solo', amt: 1 },
      { t: 'closeEpoch', epoch: 1 },
    ];
    const st = replay(acts);
    expect(st.xById.u_real).toBeGreaterThan(0);
    expect(st.xById['Luke Skywalker']).toBeUndefined();
    expect(JSON.stringify(st.payloads)).not.toContain('ghost post');
    // and the genuine act is untouched by the noise around it
    expect(replay(acts.filter((a) => !['Luke Skywalker', 'Darth Vader', 'Han Solo'].includes(a.author ?? a.id))).xById.u_real)
      .toBeCloseTo(st.xById.u_real, 12);
  });
});
