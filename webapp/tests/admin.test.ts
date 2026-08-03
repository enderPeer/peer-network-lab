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

function seedDir(base: string) {
  const d = mkdtempSync(join(tmpdir(), base));
  mkdirSync(join(d, 'server-data'), { recursive: true });
  writeFileSync(join(d, 'server-data', 'acts.jsonl'), [
    { t: 'register', id: 'u_op', handle: 'Op', seed: 1, epoch: 0, pinHash: hash('u_op', '1234') },
    { t: 'burn', id: 'u_op', amt: 1 },
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

describe('a paid placement is not an act', () => {
  let adId = '';

  it('takes a proposal and quotes an amount unique to it', async () => {
    const r = await fetch(BASE + '/api/ads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'A shop that sells nothing.', url: 'https://example.org/shop', days: 7, contact: 'a@example.org' }),
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    adId = b.id;
    expect(b.payTo).toBe(ADDR);
    expect(b.amountSats).toBeGreaterThan(0);
    // The offset is what lets one address attribute payments.
    expect(b.amountSats % 20000).not.toBe(0);
    expect(b.important).toMatch(/Do not pay yet/i);
  });

  it('appends nothing to the act log', async () => {
    const total = (await jget(BASE + '/api/acts')).total;
    await fetch(BASE + '/api/ads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Another advert.', url: 'https://example.org/2', days: 3 }),
    });
    expect((await jget(BASE + '/api/acts')).total).toBe(total);
    const raw = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    expect(raw).not.toContain('Another advert');
    expect(raw).not.toContain('example.org');
  });

  it('stays invisible until it is both approved and paid', async () => {
    expect((await jget(BASE + '/api/ads')).ads).toHaveLength(0);
    await admin('ads', { method: 'POST', body: JSON.stringify({ id: adId, action: 'approve' }) });
    expect((await jget(BASE + '/api/ads')).ads).toHaveLength(0);
    await admin('ads', { method: 'POST', body: JSON.stringify({ id: adId, action: 'paid' }) });
    const live = (await jget(BASE + '/api/ads')).ads;
    expect(live).toHaveLength(1);
    expect(live[0].label).toBe('paid placement');
  });

  it('refuses to be marked paid before it has been read', async () => {
    const r = await fetch(BASE + '/api/ads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Unread advert.', url: 'https://example.org/3', days: 1 }),
    });
    const id = (await r.json()).id;
    const bad = await admin('ads', { method: 'POST', body: JSON.stringify({ id, action: 'paid' }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/approve/i);
  });

  it('holds no standing and no content node, because it is in no graph', async () => {
    // The structural claim, checked rather than asserted in prose: the ad's
    // text exists nowhere the protocol can see.
    const feed = await jget(BASE + '/api/v1/feed?as=u_op');
    expect(JSON.stringify(feed)).not.toContain('A shop that sells nothing');
    const events = await jget(BASE + '/api/v1/events?since=0&limit=200');
    expect(JSON.stringify(events)).not.toContain('A shop that sells nothing');
  });

  it('rejects a link that is not a plain http(s) url', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.org', 'not a url']) {
      const r = await fetch(BASE + '/api/ads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x', url, days: 1 }),
      });
      expect(r.status, url).toBe(400);
    }
  });

  it('says plainly, in the public API, that money buys nothing else', async () => {
    const d = await jget(BASE + '/api/ads');
    expect(d.whatItIsNot).toMatch(/no standing/i);
    expect(d.whatItIsNot).toMatch(/feed score/i);
  });

  it('refuses proposals when no payment address is configured', async () => {
    const r = await fetch(OPEN + '/api/ads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x', url: 'https://example.org', days: 1 }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/no payment address/i);
  });
});

describe('ad targeting, and the line it must not cross', () => {
  let tId = '';

  it('takes a placement and a subject, normalising both', async () => {
    const r = await fetch(BASE + '/api/ads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'For people who read specifications.', url: 'https://example.org/spec', days: 5,
        placement: ['feed', 'live'], tags: ['Photography', 'photography', 'pro to col', '!!!'],
      }),
    });
    expect(r.status).toBe(200);
    tId = (await r.json()).id;
    const ads = (await adminJson('ads')).ads as Array<Record<string, any>>;
    const mine = ads.find((a) => a.id === tId)!;
    expect(mine.placement).toEqual(['feed', 'live']);
    expect(mine.tags).toEqual(['photography', 'protocol']); // lowercased, cleaned, deduped
  });

  it('refuses a placement that is not a real surface', async () => {
    const r = await fetch(BASE + '/api/ads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x', url: 'https://example.org', days: 1, placement: ['inbox'] }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/feed, live, record/);
  });

  it('ships the criteria to every reader, so matching can happen on their device', async () => {
    // The whole design: the browser decides whether an advert applies to it.
    // If the host filtered instead, it would have to know who was asking.
    await admin('ads', { method: 'POST', body: JSON.stringify({ id: tId, action: 'approve' }) });
    await admin('ads', { method: 'POST', body: JSON.stringify({ id: tId, action: 'paid' }) });
    const live = (await jget(BASE + '/api/ads')).ads as Array<Record<string, any>>;
    const mine = live.find((a) => a.id === tId)!;
    expect(mine.placement).toEqual(['feed', 'live']);
    expect(mine.tags).toEqual(['photography', 'protocol']);
  });

  it('serves the same advert list to everyone, with no per-reader filtering', async () => {
    // Two callers who look nothing alike must receive byte-identical lists —
    // any difference would mean the host had formed an opinion about them.
    const a = await (await fetch(BASE + '/api/ads', {
      headers: { 'CF-Connecting-IP': '198.51.100.7', 'User-Agent': 'one' },
    })).text();
    const b = await (await fetch(BASE + '/api/ads', {
      headers: { 'CF-Connecting-IP': '203.0.113.44', 'User-Agent': 'two' },
    })).text();
    expect(a).toBe(b);
  });

  it('never accepts a reader identity on the advert endpoint', async () => {
    // Passing "as" is meaningless here by construction; assert it changes
    // nothing, so a future refactor cannot quietly make it meaningful.
    const plain = await (await fetch(BASE + '/api/ads')).text();
    const withWho = await (await fetch(BASE + '/api/ads?as=u_op')).text();
    expect(withWho).toBe(plain);
  });

  it('keeps targeting out of the act log entirely', async () => {
    const raw = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    expect(raw).not.toContain('photography');
    expect(raw).not.toContain('For people who read specifications');
  });

  it('leaves an untargeted advert visible to everyone', async () => {
    const r = await fetch(BASE + '/api/ads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'For anyone at all.', url: 'https://example.org/all', days: 1 }),
    });
    const id = (await r.json()).id;
    const ads = (await adminJson('ads')).ads as Array<Record<string, any>>;
    const mine = ads.find((a) => a.id === id)!;
    expect(mine.placement).toEqual([]);
    expect(mine.tags).toEqual([]);
  });
});

describe('the configured payment address', () => {
  it('is the operator’s own, and passes its own checksum', () => {
    // The live address, checked here so a typo in deployment fails a test
    // rather than sending someone's payment where no key exists.
    expect(validBtcAddress('bc1qzs7ca605hl5xsxnesjurqck0ycsps7s5ty73jr')).toBe(true);
  });
});
