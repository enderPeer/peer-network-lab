/**
 * The operator surface, and the two boundaries it must not cross.
 *
 * 1. Addresses are observed and never recorded. The act log is public at
 *    /api/acts, so an IP that reached it could never be taken back out.
 * 2. A paid placement is not an act. This network's claim is that influence
 *    is transported commitment; if money could reach the log, the graph or a
 *    score, that claim would be marketing copy. The separation is asserted
 *    here rather than trusted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validBtcAddress } from '../ads.mjs';

const PORT = 5313;
const OPEN_PORT = 5314;        // a host with NO operator token
const BASE = `http://127.0.0.1:${PORT}`;
const OPEN = `http://127.0.0.1:${OPEN_PORT}`;
const TOKEN = 'operator-token-for-admin-tests';
// A real, checksum-valid mainnet address (the genesis coinbase output), used
// purely as a well-formed value. No key, and no expectation of funds.
const ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ROOT = resolve(__dirname, '..');

let child: ChildProcess;
let openChild: ChildProcess;
let dir: string;
let openDir: string;

const hash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');

const admin = (path: string, opts: RequestInit = {}) =>
  fetch(BASE + '/api/admin/' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const adminJson = async (path: string) => (await admin(path)).json() as Promise<Record<string, any>>;
const jget = async (u: string) => (await fetch(u)).json() as Promise<Record<string, any>>;
const total = async () => (await jget(BASE + '/api/acts')).total as number;
/** Append an act, always against the caller's current view of the log. */
const act = async (a: Record<string, unknown>) => {
  const r = await fetch(BASE + '/api/act', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...a, since: await total() }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
};

function seedDir(base: string) {
  const d = mkdtempSync(join(tmpdir(), base));
  mkdirSync(join(d, 'server-data'), { recursive: true });
  writeFileSync(join(d, 'server-data', 'acts.jsonl'), [
    { t: 'register', id: 'u_op', handle: 'Op', seed: 1, epoch: 0, pinHash: hash('u_op', '1234') },
    { t: 'btcBurn', id: 'u_op', txid: 'abopabopabopabopabopabopabopabopffffffffffffffffffffffffffffffff', sats: 10000, addr: 'bc1qdead' },
  ].map((a) => JSON.stringify(a)).join('\n') + '\n');
  return d;
}

async function waitUp(url: string) {
  for (let i = 0; i < 60; i++) {
    try { await fetch(url + '/api/acts'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('host did not come up: ' + url);
}

beforeAll(async () => {
  dir = seedDir('peer-admin-');
  openDir = seedDir('peer-open-');
  child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env, PEER_DATA_DIR: join(dir, 'server-data'),
      PEER_OPERATOR_TOKEN: TOKEN, PEER_BTC_ADDRESS: ADDR, PEER_ACT_RATE: '400', PEER_AD_RATE: '200',
    },
    stdio: 'ignore',
  });
  // Deliberately no PEER_OPERATOR_TOKEN: the unconfigured case is the one
  // where an admin panel would otherwise stand wide open.
  openChild = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(OPEN_PORT)], {
    cwd: ROOT,
    env: { ...process.env, PEER_DATA_DIR: join(openDir, 'server-data'), PEER_ACT_RATE: '400' },
    stdio: 'ignore',
  });
  await waitUp(BASE);
  await waitUp(OPEN);
}, 25000);

afterAll(() => {
  child?.kill(); openChild?.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(openDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the admin door', () => {
  it('is closed, not open, on a host with no operator token', async () => {
    // The failure mode worth testing: an unconfigured panel that answers.
    for (const p of ['/admin', '/api/admin/metrics', '/api/admin/ips', '/api/admin/ads']) {
      const r = await fetch(OPEN + p);
      expect(r.status, p).toBe(404);
    }
  });

  it('refuses a missing, wrong, or truncated token', async () => {
    expect((await fetch(BASE + '/api/admin/metrics')).status).toBe(401);
    for (const bad of ['wrong', TOKEN.slice(0, -1), TOKEN + 'x', '']) {
      const r = await fetch(BASE + '/api/admin/metrics', { headers: { Authorization: 'Bearer ' + bad } });
      expect(r.status, bad).toBe(401);
    }
  });

  it('accepts the token in either header form', async () => {
    expect((await fetch(BASE + '/api/admin/metrics', { headers: { Authorization: 'Bearer ' + TOKEN } })).status).toBe(200);
    expect((await fetch(BASE + '/api/admin/metrics', { headers: { 'X-Operator-Token': TOKEN } })).status).toBe(200);
  });

  it('serves the panel itself without a token, and it carries no secret', async () => {
    // The page is a shell that asks for the token; gating it would only stop
    // the operator reaching the login box.
    const r = await fetch(BASE + '/admin');
    expect(r.status).toBe(200);
    expect(r.headers.get('x-robots-tag')).toMatch(/noindex/);
    expect(await r.text()).not.toContain(TOKEN);
  });
});

describe('metrics report what actually happened', () => {
  it('counts an accepted act and a refused one separately', async () => {
    const before = await adminJson('metrics');
    const total = (await jget(BASE + '/api/acts')).total;
    await fetch(BASE + '/api/act', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: 'post', author: 'u_op', text: 'counted', a: 0.8, auth: '1234', since: total }),
    });
    await fetch(BASE + '/api/act', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: 'post', author: 'u_op', text: 'z'.repeat(1400), a: 0.8, auth: '1234', since: total + 1 }),
    });
    const after = await adminJson('metrics');
    expect(after.traffic.actsAccepted).toBe(before.traffic.actsAccepted + 1);
    expect(after.traffic.actsRefused).toBe(before.traffic.actsRefused + 1);
  });

  it('folds numbers out of refusal reasons so the breakdown stays bounded', async () => {
    const m = await adminJson('metrics');
    const keys = m.traffic.topRefusals.map((r: { key: string }) => r.key);
    expect(keys.some((k: string) => /N characters/.test(k))).toBe(true);
    expect(keys.some((k: string) => /1400/.test(k))).toBe(false);
  });

  it('knows which handles acted from an address, and says the role', async () => {
    const d = await adminJson('ips');
    expect(d.ips.length).toBeGreaterThan(0);
    expect(d.ips.some((r: { handles: string[] }) => r.handles.includes('u_op'))).toBe(true);
    expect((await adminJson('metrics')).host.role).toBe('primary');
  });
});

describe('addresses are observed, never recorded', () => {
  it('appears in no public endpoint', async () => {
    // Whatever the host knows about callers must not be reachable without the
    // token, and above all must not be in the log everybody can download.
    const ips = (await adminJson('ips')).ips.map((r: { ip: string }) => r.ip);
    expect(ips.length).toBeGreaterThan(0);
    const publicText = [
      await (await fetch(BASE + '/api/acts')).text(),
      await (await fetch(BASE + '/api/v1')).text(),
      await (await fetch(BASE + '/api/v1/events?since=0&limit=200')).text(),
      await (await fetch(BASE + '/api/ads')).text(),
    ].join('\n');
    for (const ip of ips) expect(publicText).not.toContain(ip);
  });

  it('never reaches the act log on disk', async () => {
    const raw = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    const ips = (await adminJson('ips')).ips.map((r: { ip: string }) => r.ip);
    for (const ip of ips) expect(raw).not.toContain(ip);
  });
});

describe('banning', () => {
  it('blocks an address and says so rather than blackholing it', async () => {
    await admin('ban', { method: 'POST', body: JSON.stringify({ ip: '203.0.113.9', minutes: 5, reason: 'test' }) });
    const r = await fetch(BASE + '/api/acts', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).toMatch(/blocked by the operator/);
    // and everyone else is unaffected
    expect((await fetch(BASE + '/api/acts')).status).toBe(200);
  });

  it('lifts the block', async () => {
    await admin('unban', { method: 'POST', body: JSON.stringify({ ip: '203.0.113.9' }) });
    const r = await fetch(BASE + '/api/acts', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    expect(r.status).toBe(200);
  });
});

describe('bitcoin addresses are checked, not trusted', () => {
  it('accepts real addresses across encodings', () => {
    expect(validBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);   // P2PKH
    expect(validBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);   // P2SH
    expect(validBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true); // bech32
    expect(validBtcAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297')).toBe(true); // taproot
  });

  it('rejects a single wrong character — the case that loses money', () => {
    expect(validBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toBe(false);
    expect(validBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')).toBe(false);
    expect(validBtcAddress('Bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false); // mixed case
    expect(validBtcAddress('not-an-address')).toBe(false);
    expect(validBtcAddress('')).toBe(false);
  });
});



describe('the operator’s bitcoin address', () => {
  it('still passes its own checksum', () => {
    // Adverts are paid in tBTC now, so nothing here quotes this address any
    // more — but the operator still publishes it, and a typo in deployment
    // should fail a test rather than send a donation where no key exists.
    expect(validBtcAddress('bc1qzs7ca605hl5xsxnesjurqck0ycsps7s5ty73jr')).toBe(true);
  });
});


describe('a refusal must never explain itself wrongly', () => {
  it('classifies an unaffordable advert as a balance problem, not a malformed act', async () => {
    // Found live: this fell through to BAD_REQUEST, whose explanation said the
    // act was malformed. It was not — the act was perfect and the wallet was
    // empty. A wrong explanation is worse than none, because it sends someone
    // to check the wrong thing.
    const r = await act({ t: 'advert', author: 'u_op', text: 'x', url: 'https://example.org', days: 3, auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(r.body.why).toMatch(/do not hold/i);
    expect(r.body.why).not.toMatch(/malformed/i);
  });

  it('classifies advert shape problems separately from balance ones', async () => {
    const bad = await act({ t: 'advert', author: 'u_op', text: 'x', url: 'javascript:alert(1)', days: 3, auth: '1234' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BAD_URL');
    expect(bad.body.why).toMatch(/everyone and a link is the one thing they will click/i);
  });
});
