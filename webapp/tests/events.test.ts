/**
 * Events, and the wall between money and standing.
 *
 * An adversarial review of this design, run against the real replay before any
 * of it was written, produced a list of ways paid entry could become bought
 * influence. The tests below are that list. The assertions that matter are not
 * "an event can be created" — they are the ones proving that a fee moved and
 * changed nothing anybody is ranked by.
 *
 * The specific attacks these pin, each measured by that review:
 *   - a negative fee run through debit-then-credit mints currency;
 *   - a fee paid to an accomplice who then reacts converts money into PEER,
 *     because a reaction is one of exactly two acts that earn an epoch share;
 *   - the organiser reprices between the moment somebody reads the card and
 *     the moment their answer lands;
 *   - an unsecured handle is drained by an answer that reads, in the record,
 *     as that person choosing to attend;
 *   - a place — where a named person will physically be — survives the
 *     deletion that promised to remove it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { replay, seed, standings } from './helpers/world';

const PORT = 5322;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(__dirname, '..');
let child: ChildProcess;
let dir: string;

const pinHash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');
async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const total = async () => ((await (await fetch(BASE + '/api/acts')).json()) as { total: number }).total;
const act = async (a: Record<string, unknown>) => post('/api/act', { ...a, since: await total() });

// ── The wall, in the replay ──────────────────────────────────────────────

describe('a paid event moves money and nothing that is ranked', () => {
  /** Two accounts, one holding tBTC, and an event with an entry fee. */
  function world(fee: number) {
    const base = seed('host', 'goer').concat([
      { t: 'assetCreate', author: 'u_goer', sym: 'TBTC', name: 'test unit', supply: 0.01 },
      { t: 'event', author: 'u_host', text: 'a reading', at: 0, place: 'the back room', fee, cur: 'TBTC', cap: 0 },
    ]);
    return base;
  }

  it('an entry fee is a transfer: balances move, standings do not', () => {
    const before = replay(world(0).concat([{ t: 'rsvp', from: 'u_goer', cid: 'c1', on: true }]));
    const after = replay(world(0.004).concat([
      { t: 'rsvp', from: 'u_goer', cid: 'c1', on: true, amt: 0.004, cur: 'TBTC', to: 'u_host' },
    ]));

    // The money moved.
    expect(after.tokens.bal.TBTC.u_host).toBeCloseTo(0.004, 9);
    expect(after.tokens.bal.TBTC.u_goer).toBeCloseTo(0.006, 9);
    // Nothing else did. This is the assertion the whole feature stands on.
    expect(standings(after), 'paying moved a standing').toEqual(standings(before));
    expect(after.g.edges.length, 'paying added an edge').toBe(before.g.edges.length);
    for (const l of after.ledgers) {
      expect(l.burnBal, `paying moved reserve for ${l.id}`).toBe(before.ledgerById[l.id].burnBal);
      expect(l.actCount, `paying moved the act count for ${l.id}`).toBe(before.ledgerById[l.id].actCount);
    }
    expect(after.eventGoing.c1.u_goer).toBe(true);
  });

  it('refuses a negative fee, which would otherwise mint currency', () => {
    // debit(-x) followed by credit(-x) is a credit and a no-op: the payer ends
    // richer and the supply is silently inflated.
    const st = replay(world(-5).concat([
      { t: 'rsvp', from: 'u_goer', cid: 'c1', on: true, amt: -5, cur: 'TBTC', to: 'u_host' },
    ]));
    expect(st.tokens.bal.TBTC.u_goer).toBeCloseTo(0.01, 9);
    expect(st.tokens.bal.TBTC.u_host === undefined || st.tokens.bal.TBTC.u_host === 0).toBe(true);
  });

  it('refuses a payment that does not match what the event asks', () => {
    const st = replay(world(0.004).concat([
      { t: 'rsvp', from: 'u_goer', cid: 'c1', on: true, amt: 0.001, cur: 'TBTC', to: 'u_host' },
    ]));
    expect(st.eventGoing.c1, 'an underpaying answer was accepted').toBeUndefined();
    expect(st.tokens.bal.TBTC.u_goer).toBeCloseTo(0.01, 9);
  });

  it('refuses a payment somebody cannot cover', () => {
    const st = replay(world(5).concat([
      { t: 'rsvp', from: 'u_goer', cid: 'c1', on: true, amt: 5, cur: 'TBTC', to: 'u_host' },
    ]));
    expect(st.eventGoing.c1).toBeUndefined();
    expect(st.tokens.bal.TBTC.u_goer).toBeCloseTo(0.01, 9);
  });

  it('does not credit a symbol the payer never held, and does not throw', () => {
    // The old tokDebit was a bare subtraction with no map and no check: a
    // symbol nobody had ever held threw a TypeError, and a replay that throws
    // takes the whole host down, because every request replays the log.
    expect(() => replay(seed('host', 'goer').concat([
      { t: 'event', author: 'u_host', text: 'x', fee: 1, cur: 'PEER' },
      { t: 'rsvp', from: 'u_goer', cid: 'c1', on: true, amt: 1, cur: 'PEER', to: 'u_host' },
    ]))).not.toThrow();
  });

  it('honours a capacity', () => {
    const st = replay(seed('host', 'a', 'b').concat([
      { t: 'event', author: 'u_host', text: 'small room', fee: 0, cap: 1 },
      { t: 'rsvp', from: 'u_a', cid: 'c1', on: true },
      { t: 'rsvp', from: 'u_b', cid: 'c1', on: true },
    ]));
    expect(Object.keys(st.eventGoing.c1).length).toBe(1);
    expect(st.eventGoing.c1.u_a).toBe(true);
  });

  it('lets only the host invite, and records it without scoring it', () => {
    const before = replay(seed('host', 'a', 'b'));
    const st = replay(seed('host', 'a', 'b').concat([
      { t: 'event', author: 'u_host', text: 'x' },
      { t: 'invite', from: 'u_host', to: 'u_a', cid: 'c1' },
      { t: 'invite', from: 'u_b', to: 'u_b', cid: 'c1' },   // not the host: ignored
    ]));
    expect(st.eventInvites.c1.u_a).toBe(true);
    expect(st.eventInvites.c1.u_b).toBeUndefined();
    // The event itself is a Publish and moves its author, as content does —
    // but the invitation is attention and moves nobody.
    const withEventOnly = replay(seed('host', 'a', 'b').concat([{ t: 'event', author: 'u_host', text: 'x' }]));
    expect(standings(st)).toEqual(standings(withEventOnly));
    expect(Object.keys(standings(before)).length).toBeGreaterThan(0);
  });

  it('makes an event react-able, comment-able and rankable like any post', () => {
    // The whole integration: contentAuthor is set, so the ordinary acts work.
    const st = replay(seed('host', 'fan').concat([
      { t: 'btcBurn', id: 'u_fan', txid: 'f6ed4dd288fe6fd9fe89f83eb3abf4bad0302c43f7941608a2d14d9404280b0f', sats: 10000, addr: 'bc1qdead' },
      { t: 'event', author: 'u_host', text: 'a reading' },
      { t: 'opinion', author: 'u_fan', target: 'c1', p: 0.9, r: 0.9 },
      { t: 'review', author: 'u_fan', target: 'c1', e: 0.7, f: 0.8, text: 'looking forward to it' },
    ]));
    expect(st.g.nodes.get('c1')!.kind).toBe('Content');
    expect(st.creators.c1).toBe('u_host');
    expect(st.payloads.c1).toBe('a reading');
  });

  it('a fee buys no epoch share from the person who was paid', () => {
    // The attack: the organiser pays an accomplice, the accomplice reacts, and
    // the reaction earns the organiser a slice of the epoch. Money in, PEER
    // out. Suppressed by refusing engagement weight between two accounts that
    // moved money to each other in the same epoch.
    const common = seed('host', 'goer').concat([
      { t: 'assetCreate', author: 'u_goer', sym: 'TBTC', name: 'test unit', supply: 0.01 },
      // A real burn, because weight comes from destroyed value now — without
      // one the goer weighs nothing, both sides of this comparison are zero,
      // and the test would "pass" while proving nothing about the wall.
      { t: 'btcBurn', id: 'u_goer', sats: 1000, addr: 'bc1qdead',
        txid: 'e7'.repeat(32) },
      { t: 'event', author: 'u_host', text: 'a reading', fee: 0.004, cur: 'TBTC' },
    ]);
    const paidThenReacted = replay(common.concat([
      { t: 'rsvp', from: 'u_goer', cid: 'c1', on: true, amt: 0.004, cur: 'TBTC', to: 'u_host' },
      { t: 'opinion', author: 'u_goer', target: 'c1', p: 0.9, r: 0.9 },
      { t: 'closeEpoch', epoch: 0 },
    ]));
    const justReacted = replay(common.concat([
      { t: 'opinion', author: 'u_goer', target: 'c1', p: 0.9, r: 0.9 },
      { t: 'closeEpoch', epoch: 0 },
    ]));
    const paidShare = (paidThenReacted.tokens.bal.PEER || {}).u_host || 0;
    const freeShare = (justReacted.tokens.bal.PEER || {}).u_host || 0;
    expect(freeShare, 'the unpaid reaction should earn the host a share').toBeGreaterThan(0);
    expect(paidShare, 'a reaction from somebody who just paid this host earned them PEER').toBe(0);
  });
});

  
// ── The host's half ──────────────────────────────────────────────────────

describe('the host on events', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-events-test-'));
    mkdirSync(join(dir, 'server-data'), { recursive: true });
    child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
      stdio: 'ignore',
      // This file spends more than twenty acts a minute setting its worlds up,
      // and the default limiter is twenty per IP. Raised for the test host
      // only; the limit itself is exercised by the host tests.
      env: { ...process.env, PEER_DATA_DIR: join(dir, 'server-data'), PEER_ACT_RATE: '400' },
    });
    for (let i = 0; i < 100; i++) {
      try { await fetch(BASE + '/api/live'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await act({ t: 'register', id: 'u_org', handle: 'Org', seed: 1, epoch: 0, pinHash: pinHash('u_org', '2468') });
    await act({ t: 'register', id: 'u_open', handle: 'Openhandle', seed: 1, epoch: 0 });   // no PIN on purpose
    await act({ t: 'assetCreate', author: 'u_open', sym: 'TBTC', name: 'test unit', supply: 0.01 });
  }, 30000);

  afterAll(() => {
    child?.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
  });

  it('refuses a fee that is not a positive, finite, real currency', async () => {
    expect((await act({ t: 'event', author: 'u_org', text: 'x', fee: -1, cur: 'PEER', auth: '2468' })).status).toBe(400);
    expect((await act({ t: 'event', author: 'u_org', text: 'x', fee: 1e12, cur: 'PEER', auth: '2468' })).status).toBe(400);
    const odd = await act({ t: 'event', author: 'u_org', text: 'x', fee: 5, cur: 'not a symbol', auth: '2468' });
    expect(odd.status).toBe(400);
    expect(String(odd.body.error)).toMatch(/PEER, or in any minted asset/);
  });

  it('refuses a paid answer from a handle nobody can prove they own', async () => {
    const ev = await act({ t: 'event', author: 'u_org', text: 'paid night', fee: 0.004, cur: 'TBTC', auth: '2468' });
    expect(ev.status).toBe(200);
    // Never derive a content id by counting: the id counter also ticks for
    // hyperedge legs, which is a defect this project already shipped once and
    // documented at the endpoint that fixes it. Ask the host.
    const ev1 = await (await fetch(BASE + '/api/v1/events?since=0&limit=200')).json() as
      { events: Array<{ kind: string; node?: string }> };
    const mine = ev1.events.filter((e) => e.node && /event/i.test(e.kind || ''));
    const cid = mine.length ? String(mine[mine.length - 1].node) : '';
    expect(cid, 'the host did not report the minted id').toMatch(/^c\d+$/);
    // u_open holds tBTC but has no PIN: the payment must be refused.
    const r = await act({ t: 'rsvp', from: 'u_open', cid: cid, on: true, amt: 0.004, cur: 'TBTC', to: 'u_org' });
    // The status comes from the error catalogue, not from a number chosen here.
    expect(r.status, 'refused for the wrong reason: ' + JSON.stringify(r.body)).toBe(401);
    expect(String(r.body.error)).toMatch(/needs a PIN/);
    expect(r.body.code, 'the refusal needs a stable code').toBe('PIN_REQUIRED');
  }, 20000);

  it('shuts the door on a deleted event and on one that is over', async () => {
    // Both of these took real money before they were closed. Measured on the
    // running replay: 0.005 tBTC moved to the host of an event whose text and
    // address had been redacted, and 0.004 tBTC to an event two hundred days
    // past. The checks live at the host, never in the shared replay, because
    // deletion and the wall clock are both retroactive there and would rewrite
    // balances in a log that has already been replayed.
    const ev = await act({ t: 'event', author: 'u_org', text: 'doomed', fee: 0.001, cur: 'TBTC', auth: '2468' });
    expect(ev.status).toBe(200);
    const evs = await (await fetch(BASE + '/api/v1/events?since=0&limit=300')).json() as
      { events: Array<{ node?: string }> };
    const withNode = evs.events.filter((e) => e.node);
    const cid = String(withNode[withNode.length - 1].node);

    const { total: n } = await (await fetch(BASE + '/api/acts')).json() as { total: number };
    expect((await act({ t: 'deletePost', author: 'u_org', target: n - 1, auth: '2468' })).status).toBe(200);

    const paid = await act({ t: 'rsvp', from: 'u_org', cid, on: true, amt: 0.001, cur: 'TBTC', to: 'u_org', auth: '2468' });
    expect(paid.status, 'a deleted event still took money').not.toBe(200);
    expect(String(paid.body.error)).toMatch(/deleted/);

    // And one whose time has passed.
    const past = await act({ t: 'event', author: 'u_org', text: 'last year', at: Date.now() - 200 * 86400000, fee: 0.001, cur: 'TBTC', auth: '2468' });
    expect(past.status).toBe(200);
    const evs2 = await (await fetch(BASE + '/api/v1/events?since=0&limit=300')).json() as
      { events: Array<{ node?: string }> };
    const nodes2 = evs2.events.filter((e) => e.node);
    const cid2 = String(nodes2[nodes2.length - 1].node);
    const late = await act({ t: 'rsvp', from: 'u_org', cid: cid2, on: true, amt: 0.001, cur: 'TBTC', to: 'u_org', auth: '2468' });
    expect(late.status, 'an event that is over still took money').not.toBe(200);
    expect(String(late.body.error)).toMatch(/already happened/);
  }, 30000);

  it('keeps a place out of the record once its author deletes it', async () => {
    const ev = await act({ t: 'event', author: 'u_org', text: 'private address', place: '12 Elm Street', auth: '2468' });
    expect(ev.status).toBe(200);
    const before = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    expect(before).toMatch(/12 Elm Street/);

    const { total: n } = await (await fetch(BASE + '/api/acts')).json() as { total: number };
    const del = await act({ t: 'deletePost', author: 'u_org', target: n - 1, auth: '2468' });
    expect(del.status, 'an event could not be deleted: ' + JSON.stringify(del.body)).toBe(200);

    const after = readFileSync(join(dir, 'server-data', 'acts.jsonl'), 'utf8');
    expect(after, 'the address survived the deletion that promised to remove it').not.toMatch(/12 Elm Street/);
  }, 20000);
});
