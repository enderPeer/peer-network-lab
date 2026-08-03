/**
 * Can the app still let you in after the host has quietly changed how your
 * PIN is stored?
 *
 * This is the regression from a real lockout. The app wrote sha256(id:pin) at
 * registration; the host, on the owner's first correct act, silently re-stored
 * that as PBKDF2 (flushPinUpgrades) because the old form is crackable offline.
 * Nothing was wrong with either half on its own. But the unlock dialog still
 * computed sha256 and compared it to whatever was stored — a sha256 string
 * against a pbkdf2 string, which cannot match whatever the owner types.
 *
 * The PIN kept working for acting, because the host verifies it properly, so
 * nobody noticed until a session ended. Fourteen accounts were shut out,
 * including a tester who had done nothing but use the app.
 *
 * So this test does not check the client in isolation. It runs the real host,
 * lets it perform the real upgrade, and then asks the code that actually
 * ships in the page whether it can still read the result.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';

const PORT = 5319;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(__dirname, '..');
const PAGE = resolve(ROOT, 'public/peer-social-preview.html');

/**
 * Lift a function out of the built page by name.
 *
 * Brace-matched rather than regexed, and it throws if the function is missing
 * or unbalanced — a test that silently stopped covering anything would be
 * worse than no test, which this project has already learned once.
 */
function lift(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`the built page has no function ${name} — did it get renamed?`);
  let depth = 0, i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name} out of the page (from ${open})`);
}

/** The page's own PIN checker, running here exactly as it does in a browser. */
function pageVerifier() {
  const page = readFileSync(PAGE, 'utf8');
  const src = `
    ${lift(page, 'sha256hex')}
    ${lift(page, 'verifyPin')}
    return verifyPin;
  `;
  // The globals a browser would have supplied.
  const make = new Function('window', 'crypto', 'TextEncoder', src);
  return make({ crypto: webcrypto }, webcrypto, TextEncoder) as
    (id: string, pin: string, stored: string) => Promise<boolean | null>;
}

let child: ChildProcess;
let dir: string;

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const total = async () => ((await (await fetch(BASE + '/api/acts')).json()) as { total: number }).total;
async function storedHashFor(id: string) {
  const { acts } = (await (await fetch(BASE + '/api/acts')).json()) as { acts: Array<Record<string, string>> };
  let hash = '';
  for (const a of acts) if ((a.t === 'register' || a.t === 'setPin') && a.id === id && a.pinHash) hash = a.pinHash;
  return hash;
}

describe('getting back in after the host re-stores your PIN', () => {
  beforeAll(async () => {
    expect(existsSync(PAGE), 'run `npm run build:social` first').toBe(true);
    dir = mkdtempSync(join(tmpdir(), 'peer-pin-test-'));
    mkdirSync(join(dir, 'server-data'), { recursive: true });
    child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
      stdio: 'ignore', env: { ...process.env, PEER_DATA_DIR: join(dir, 'server-data') },
    });
    for (let i = 0; i < 100; i++) {
      try { await fetch(BASE + '/api/live'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  }, 30000);

  afterAll(() => {
    child?.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows holds files briefly */ }
  });

  it('reads back a PIN the host silently upgraded — the lockout itself', async () => {
    const id = 'u_locked';
    const PIN = 'Egoplayer133';       // a real one from the incident: mixed case, not digits
    const legacy = createHash('sha256').update(`${id}:${PIN}`, 'utf8').digest('hex');

    await post('/api/act', { t: 'register', id, handle: 'Locked', seed: 1, epoch: 0, pinHash: legacy, since: await total() });
    expect(await storedHashFor(id), 'registered in the old format').toBe(legacy);

    const verify = pageVerifier();
    expect(await verify(id, PIN, legacy), 'the app must read the old format').toBe(true);

    // One ordinary act with the correct PIN. This is all it took in production.
    const burn = await post('/api/act', { t: 'burn', id, amt: 1, auth: PIN, since: await total() });
    expect(burn.status).toBe(200);

    const upgraded = await storedHashFor(id);
    expect(upgraded, 'the host re-stores it as PBKDF2 on a correct act').toMatch(/^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]{64}$/);
    expect(upgraded).not.toBe(legacy);

    // What the old code did, kept here so this test cannot quietly stop
    // testing anything: it compared a sha256 string to the stored value.
    expect(createHash('sha256').update(`${id}:${PIN}`, 'utf8').digest('hex'),
      'the old comparison could not match an upgraded hash — that was the lockout')
      .not.toBe(upgraded);

    // The moment the owner's session ends, this is the only thing standing
    // between them and their account.
    expect(await verify(id, PIN, upgraded),
      'the app must still recognise the PIN after the host upgraded it').toBe(true);
    expect(await verify(id, 'Egoplayer134', upgraded), 'and must still refuse a wrong one').toBe(false);
    expect(await verify(id, PIN.toLowerCase(), upgraded), 'a PIN is case sensitive').toBe(false);
  }, 30000);

  it('refuses a wrong PIN in the old format too', async () => {
    const verify = pageVerifier();
    const stored = createHash('sha256').update('u_x:1234', 'utf8').digest('hex');
    expect(await verify('u_x', '1234', stored)).toBe(true);
    expect(await verify('u_x', '1235', stored)).toBe(false);
    expect(await verify('u_x', '', stored)).toBe(false);
  });

  it('says "cannot check here" rather than "wrong" when there is no WebCrypto', async () => {
    // A plain-http page has no crypto.subtle. Reporting that as a wrong PIN
    // would send somebody looking for a password that was never the problem.
    const page = readFileSync(PAGE, 'utf8');
    const make = new Function('window', 'crypto', 'TextEncoder', `
      ${lift(page, 'sha256hex')}
      ${lift(page, 'verifyPin')}
      return verifyPin;
    `);
    const verify = make({}, undefined, TextEncoder) as (i: string, p: string, s: string) => Promise<boolean | null>;
    const pbkdf2 = 'pbkdf2$210000$' + 'a'.repeat(32) + '$' + 'b'.repeat(64);
    expect(await verify('u_x', '1234', pbkdf2)).toBe(null);
  });
});
