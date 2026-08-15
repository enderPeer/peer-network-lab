/**
 * The door on a Prender Market.
 *
 * The replay decides what a bet MEANS; these tests are about the two things
 * the replay is forbidden to know — the wall clock and deletion — plus the
 * promise that everything else the host refuses, it refuses in the replay's
 * own words. A host that accepted what the replay skips would write a log
 * that means one thing to it and another to every mirror reading it.
 *
 * Run against a real server process on a throwaway data directory, because
 * these rules exist only in the request path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const PORT = 5331;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(__dirname, '..');
const PIN = '1234';

let child: ChildProcess;
let dir: string;

const hash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');
async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const get = async (path: string) => (await fetch(BASE + path)).json() as Promise<Record<string, any>>;
const total = async () => (await get('/api/acts')).total as number;
const act = async (a: Record<string, unknown>) => post('/api/act', { auth: PIN, ...a, since: await total() });

const WHO = ['u_asker', 'u_backer', 'u_mod1', 'u_mod2', 'u_mod3'];
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'peer-market-test-'));
  mkdirSync(join(dir, 'server-data'), { recursive: true });
  const log: Record<string, unknown>[] = [];
  WHO.forEach((id, i) => {
    log.push({ t: 'register', id, handle: id.slice(2), seed: 1, epoch: 0, pinHash: hash(id, PIN) });
    // Enough reserve that no W1 refusal can be mistaken for the rule under
    // test, and enough destroyed value to weigh a ballot.
    log.push({ t: 'btcBurn', id, sats: 40000, addr: 'bc1qdead',
      txid: String(i).repeat(4).padEnd(64, 'abcdef0123456789') });
  });
  // Something to stake. PEER only exists after an epoch is distributed, so the
  // table plays with a minted asset instead of farming engagement first.
  log.push({ t: 'assetCreate', author: 'u_asker', sym: 'CHIP', name: 'table stakes', supply: 100000 });
  for (const id of WHO.slice(1)) log.push({ t: 'tokenSend', author: 'u_asker', sym: 'CHIP', to: id, amt: 1000 });
  writeFileSync(join(dir, 'server-data', 'acts.jsonl'), log.map((a) => JSON.stringify(a)).join('\n') + '\n');

  child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, PEER_ACT_RATE: '400', PEER_DATA_DIR: join(dir, 'server-data') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + '/api/acts');
      // …and wait for the replay to be loaded, not just the socket to be open.
      // Every market check consults it, and a sync validator cannot await a
      // lazy import: the host warms it at boot, so this is just the race.
      for (let j = 0; j < 60; j++) {
        const probe = await post('/api/act', { t: 'bet', author: 'u_backer', cid: 'c1', opt: 0, amt: 1 });
        if (!/still loading/.test(String(probe.body.error ?? ''))) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('host did not come up');
}, 20000);

afterAll(() => {
  child?.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * The content id of a bet, found the way a bot is told to find one: read from
 * the host, never derived. The id counter also ticks for hyperedge legs, so
 * client-side counting lands off by one and every later act goes nowhere.
 */
async function marketCid(text: string): Promise<string> {
  const r = await get('/api/v1/markets?all=1');
  const found = (r.markets as Array<Record<string, any>>).find((m) => m.text === text);
  return found ? (found.id as string) : '';
}
async function ask(text: string, over: Record<string, unknown> = {}) {
  const r = await act({
    t: 'market', author: 'u_asker', text, opts: ['yes', 'no'],
    cur: 'CHIP', at: Date.now() + HOUR, seats: 3, bond: 10, feeBp: 200, ...over,
  });
  return { r, cid: r.status === 200 ? await marketCid(text) : '' };
}

describe('opening a bet', () => {
  it('refuses one with no closing time, and one that closes in the past', async () => {
    const none = await act({ t: 'market', author: 'u_asker', text: 'q', opts: ['a', 'b'],
      cur: 'CHIP', seats: 3, bond: 10, feeBp: 200 });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/closing time in the future/);
    const past = await act({ t: 'market', author: 'u_asker', text: 'q', opts: ['a', 'b'],
      cur: 'CHIP', at: Date.now() - 1000, seats: 3, bond: 10, feeBp: 200 });
    expect(past.body.error).toMatch(/closing time in the future/);
  });

  it('refuses eight answers, two answers that read the same, and a fee over the cap', async () => {
    const many = await act({ t: 'market', author: 'u_asker', text: 'q',
      opts: ['1', '2', '3', '4', '5', '6', '7', '8'], cur: 'CHIP', at: Date.now() + HOUR,
      seats: 3, bond: 10, feeBp: 200 });
    expect(many.body.error).toMatch(/between 2 and 7 answers/);
    const dupe = await act({ t: 'market', author: 'u_asker', text: 'q', opts: ['Yes', ' yes '],
      cur: 'CHIP', at: Date.now() + HOUR, seats: 3, bond: 10, feeBp: 200 });
    expect(dupe.body.error).toMatch(/say the same thing/);
    const greedy = await act({ t: 'market', author: 'u_asker', text: 'q', opts: ['a', 'b'],
      cur: 'CHIP', at: Date.now() + HOUR, seats: 3, bond: 10, feeBp: 900 });
    expect(greedy.body.error).toMatch(/at most 5%/);
  });

  it('refuses a nominee who does not exist, and an asset that does not', async () => {
    const ghost = await act({ t: 'market', author: 'u_asker', text: 'q', opts: ['a', 'b'],
      cur: 'CHIP', at: Date.now() + HOUR, seats: 3, bond: 10, feeBp: 200, mods: ['u_nobody'] });
    expect(ghost.body.error).toMatch(/no such handle/);
    const nocur = await act({ t: 'market', author: 'u_asker', text: 'q', opts: ['a', 'b'],
      cur: 'NOPE', at: Date.now() + HOUR, seats: 3, bond: 10, feeBp: 200 });
    expect(nocur.body.error).toMatch(/no such asset/);
  });

  it('keeps every field it was given — the whitelist is a hard one', async () => {
    const r = await act({ t: 'market', author: 'u_asker', text: 'kept?', opts: ['a', 'b'],
      cur: 'CHIP', at: Date.now() + HOUR, seats: 5, bond: 7, feeBp: 300, mods: ['u_mod1'] });
    expect(r.status).toBe(200);
    // The LAST market act, not the last act: a first PIN check appends a
    // setPin of its own when it upgrades the stored hash, and a fixture that
    // assumed it had the tail of the log would be asserting about that.
    const acts = (await get('/api/acts')).acts as Array<Record<string, unknown>>;
    const mine = acts.filter((a) => a.t === 'market').pop()!;
    expect(mine.text).toBe('kept?');
    // A field silently dropped here would publish a different bet from the one
    // the author wrote, and answer 200 while doing it.
    expect(mine.opts).toEqual(['a', 'b']);
    expect(mine.seats).toBe(5);
    expect(mine.bond).toBe(7);
    expect(mine.feeBp).toBe(300);
    expect(mine.cur).toBe('CHIP');
    expect(mine.mods).toEqual(['u_mod1']);
    // and the PIN never lands in the public log
    expect(mine.auth).toBeUndefined();
  });
});

describe('the clock, which is the host’s business and never the replay’s', () => {
  let id = '';
  beforeAll(async () => { id = (await ask('clock bet')).cid; });

  it('refuses a certificate before betting has closed', async () => {
    expect(id).toBeTruthy();
    await act({ t: 'modStand', author: 'u_mod1', cid: id, on: true });
    const early = await act({ t: 'attest', author: 'u_mod1', cid: id, opt: 0 });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/still open/);
  });

  it('refuses calling time before the jury has had its window', async () => {
    const soon = await act({ t: 'marketVoid', author: 'u_backer', cid: id });
    expect(soon.body.error).toMatch(/jury has until/);
  });

  it('refuses a stake and a ballot once betting has closed', async () => {
    // A bet that closed one second ago: the door reads the clock, the replay
    // never does, and this is the only place the difference can be tested.
    const shut = await ask('already shut', { at: Date.now() + 1500, seats: 1, feeBp: 0 });
    expect(shut.r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 1700));
    const late = await act({ t: 'bet', author: 'u_backer', cid: shut.cid, opt: 0, amt: 10 });
    expect(late.status).toBe(400);
    expect(late.body.error).toMatch(/betting on this closed/);
    const ballot = await act({ t: 'modVote', author: 'u_backer', cid: shut.cid, for: [] });
    expect(ballot.body.error).toMatch(/jury for this bet was settled/);
    // and the jury may now do its job
    const ok = await act({ t: 'attest', author: 'u_mod1', cid: shut.cid, opt: 0 });
    expect(ok.body.error).toMatch(/holds no seat/);   // nobody stood: the replay's own words
  });

  it('lets anyone call time at once on a closed bet where nobody ever stood', async () => {
    // The shape cam's c37 had on the live network: real stakes in, betting
    // closed, and an empty candidate list — a bond no eligible handle could
    // post. Standing shut with betting, so no seat can ever be filled and no
    // certification can ever be taken; the jury window would hold the stakes
    // for a week against an event the rulebook has already made impossible.
    const dead = await ask('unseatable', { at: Date.now() + 1500, seats: 3, bond: 10, feeBp: 200 });
    expect(dead.r.status).toBe(200);
    const stake = await act({ t: 'bet', author: 'u_backer', cid: dead.cid, opt: 0, amt: 25 });
    expect(stake.status).toBe(200);
    // Still open: the window applies as usual, and the market is not yet dead.
    let row = ((await get('/api/v1/markets?all=1')).markets as Array<Record<string, any>>).find((m) => m.id === dead.cid)!;
    expect(row.unseatable).toBe(false);
    const early = await act({ t: 'marketVoid', author: 'u_mod2', cid: dead.cid });
    expect(early.body.error).toMatch(/jury has until/);
    await new Promise((res) => setTimeout(res, 1700));
    // Closed with nobody standing: the API says so, and the door opens.
    row = ((await get('/api/v1/markets?all=1')).markets as Array<Record<string, any>>).find((m) => m.id === dead.cid)!;
    expect(row.betting).toBe(false);
    expect(row.standing).toEqual([]);
    expect(row.unseatable).toBe(true);
    const before = (await get('/api/v1/tokens?as=u_backer')).balances.CHIP as number;
    const now = await act({ t: 'marketVoid', author: 'u_mod2', cid: dead.cid });
    expect(now.status).toBe(200);
    // Every stake back in full, no fee: a void can only ever be generous.
    row = ((await get('/api/v1/markets?all=1')).markets as Array<Record<string, any>>).find((m) => m.id === dead.cid)!;
    expect(row.state).toBe('void');
    expect(row.refunded.u_backer).toBe(25);
    const after = (await get('/api/v1/tokens?as=u_backer')).balances.CHIP as number;
    expect(after - before).toBeCloseTo(25, 6);
  });

  it('still makes a bet WITH a candidate wait out the jury window', async () => {
    // The relaxation is for the arithmetically dead case only. One person
    // standing is a jury that might still certify, and calling time on them
    // early would let a loser void a bet the moment the answer went against them.
    const alive = await ask('one stood', { at: Date.now() + 1500, seats: 1, bond: 10, feeBp: 200 });
    expect(alive.r.status).toBe(200);
    expect((await act({ t: 'modStand', author: 'u_mod3', cid: alive.cid, on: true })).status).toBe(200);
    await new Promise((res) => setTimeout(res, 1700));
    const row = ((await get('/api/v1/markets?all=1')).markets as Array<Record<string, any>>).find((m) => m.id === alive.cid)!;
    expect(row.betting).toBe(false);
    expect(row.unseatable).toBe(false);
    const soon = await act({ t: 'marketVoid', author: 'u_backer', cid: alive.cid });
    expect(soon.status).toBe(400);
    expect(soon.body.error).toMatch(/jury has until/);
  });
});

describe('the replay’s rulebook, spoken by the host', () => {
  let id = '';
  beforeAll(async () => { id = (await ask('rulebook bet')).cid; });

  it('refuses the author a position in the replay’s own sentence', async () => {
    const r = await act({ t: 'bet', author: 'u_asker', cid: id, opt: 0, amt: 10 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/author of a bet does not hold a position/);
    expect(r.body.code).toBe('NOT_YOURS');
  });

  it('refuses a stake bigger than the balance, naming both numbers', async () => {
    const r = await act({ t: 'bet', author: 'u_backer', cid: id, opt: 0, amt: 99999 });
    expect(r.body.error).toMatch(/balance is 1000 CHIP, tried to stake 99999/);
  });

  it('takes a real stake, and the escrow leaves the balance at once', async () => {
    const before = await get('/api/v1/tokens?as=u_backer');
    const r = await act({ t: 'bet', author: 'u_backer', cid: id, opt: 0, amt: 100 });
    expect(r.status).toBe(200);
    const after = await get('/api/v1/tokens?as=u_backer');
    const bal = (b: Record<string, any>) => (b.balances ?? b.bal ?? {}).CHIP ?? 0;
    expect(bal(before) - bal(after)).toBe(100);
  });

  it('refuses a stake from a handle with no PIN, before it says anything about the balance', async () => {
    const open = { t: 'register', id: 'u_nopin', handle: 'NoPin', seed: 1, epoch: 0 };
    expect((await act(open)).status).toBe(200);
    const r = await post('/api/act', { t: 'bet', author: 'u_nopin', cid: id, opt: 0, amt: 1, since: await total() });
    expect(r.body.error).toMatch(/needs a PIN/);
  });
});

describe('deleting a bet', () => {
  it('redacts the question, keeps the answer labels the chain already committed to, refuses new money', async () => {
    const { cid: id } = await ask('doomed bet', { seats: 1, feeBp: 0 });
    expect((await act({ t: 'bet', author: 'u_backer', cid: id, opt: 0, amt: 50 })).status).toBe(200);
    expect((await act({ t: 'modStand', author: 'u_mod2', cid: id, on: true })).status).toBe(200);

    const acts = (await get('/api/acts')).acts as Array<Record<string, unknown>>;
    let mIdx = -1;
    for (let i = 0; i < acts.length; i++) if (acts[i]!.t === 'market' && acts[i]!.text === 'doomed bet') mIdx = i;
    // The structural commitment the chain would seal for this act BEFORE the
    // deletion. chain/acts.mjs keeps every field but {text, media, place,
    // redacted} in it — opts included — so a lawful redaction must leave the
    // structural hash exactly where it was, or every later seal throws and
    // every mirror reads a false fork.
    const { actCommitments } = await import(new URL('../chain/acts.mjs', import.meta.url).href);
    const { R } = await import('./helpers/chain');
    // File indices: /api/acts serves seedWorld at 0, the file starts at 1.
    const before = actCommitments(acts.slice(1), R.parseMentions).structural[mIdx - 1];

    expect((await act({ t: 'deletePost', author: 'u_asker', target: mIdx })).status).toBe(200);

    const after = (await get('/api/acts')).acts as Array<Record<string, unknown>>;
    expect(after[mIdx]!.text).toBe('');                 // the question goes
    expect(after[mIdx]!.redacted).toBe(true);
    expect(after[mIdx]!.opts).toEqual(['yes', 'no']);   // the labels stay: they are structure to the chain
    const structuralAfter = actCommitments(after.slice(1), R.parseMentions).structural[mIdx - 1];
    expect(structuralAfter, 'redaction is invisible to the structural hash').toBe(before);

    const more = await act({ t: 'bet', author: 'u_backer', cid: id, opt: 1, amt: 10 });
    expect(more.body.error).toMatch(/was deleted — no new money goes in/);
  });
});
