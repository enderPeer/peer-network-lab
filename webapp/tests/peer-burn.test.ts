/**
 * The second door into reserve: PEER destroyed, priced by the pool.
 *
 * Reserve is VALUE DESTROYED, and until now the only way to destroy value here
 * was to destroy bitcoin — which is a large part of why this network has
 * twelve actors. This door opens a second way in and changes nothing about the
 * first: both credit reserve at the same SATS_PER_RESERVE, because two doors
 * at two prices would be two classes of speaker.
 *
 * What these tests are actually defending is narrower and more important than
 * "the arithmetic works":
 *
 * 1. REPLAY IS STILL A PURE FUNCTION OF THE LOG. Nothing below gives the
 *    engine a price, a pool, a clock or a network. The act carries what the
 *    host verified and replay does arithmetic on those recorded numbers — the
 *    same discipline btcBurn has, and the reason a published epoch
 *    certificate keeps reproducing after the price moves.
 * 2. A RECORDED PRICE IS NOT A TRUSTED PRICE. The act states its satoshi value
 *    AND the reserves behind it AND the blocks they were read at, so replay
 *    recomputes one from the other and refuses the act when they disagree. A
 *    host that records a price and a value which do not match each other is
 *    either broken or lying, and this is where that is caught instead of
 *    believed.
 * 3. THE DEFENCES LIVE IN REPLAY, NOT AT THE DOOR. A door can be bypassed by
 *    any host — a mirror, a hand-edited log, a fork with the check removed.
 *    Every log passes through this file, so ownership, both ceilings, the
 *    depth floor, the averaging window and the sampling grid are enforced
 *    here.
 * 4. WHOSE BURN IT IS, IS A QUESTION ABOUT THE LOG. That was the hole: the
 *    host asked only whether a transfer came from the address bound to
 *    whoever was asking, and binding an address needs nothing but the binding
 *    handle's own PIN. A stranger bound somebody else's address and took the
 *    reserve. Every ownership case below is in this file for that reason.
 */
import { describe, it, expect } from 'vitest';
import { replay, seed } from './helpers/world';

/** The 18-decimal raw unit of PEER, as a string — never as a JS number. */
const PEER = (n: bigint) => String(n * 10n ** 18n);
/** A pool with a real price: 1,000,000 PEER against 0.1 cbBTC (10,000,000 sat). */
const RES_PEER = PEER(1_000_000n);
const RES_BTC = '10000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const FACTORY = '0x4444444444444444444444444444444444444444';
/** The floors the engine enforces, restated here so a test fails if one moves. */
const TWAP_MS = 30 * 60 * 1000;
const TWAP_OBS = 12;
/** One address per actor, so "whose burn is this" has an answer in every case. */
const ADDR: Record<string, string> = {
  al: '0x' + 'a'.repeat(40), bo: '0x' + 'b'.repeat(40), cy: '0x' + 'c'.repeat(40),
};
/** A block hash: the seed that decides which blocks the window was read at. */
const HASH = '0x' + '13579bdf2468ace0'.repeat(4);
const WIN_FROM = 30_000_000;
const WIN_TO = 30_001_125;
/** When the bindings happen, and when the coins are destroyed. Order matters. */
const BOUND_AT = 1_000;
const BURNED_AT = 5_000;

const tx = (s: string) => '0x' + s.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '1');

type Act = Record<string, unknown>;

/** The engine's own grid rule, asked of the engine rather than reimplemented. */
const ENGINE = replay([{ t: 'seedWorld' }]);
const GRID_N = ENGINE.peerBurn.limits.twapGrid;
const gridOf = (from: number, to: number, hash = HASH) => ENGINE.peerBurnGrid(from, to, hash, GRID_N);

/** Binding an address to a handle, at a time. */
function bind(who: string, ts = BOUND_AT, addr = ADDR[who]): Act {
  return { t: 'bindAddress', id: 'u_' + who, addr, ts };
}

/**
 * A well-formed PEER burn. Every field the act needs is here by default so
 * that each test can spoil exactly one of them and nothing else.
 */
function peerBurn(who: string, peerAmount: bigint, over: Act = {}): Act {
  const amtRaw = PEER(peerAmount);
  const rp = (over.resPeerRaw as string) ?? RES_PEER;
  const rb = (over.resBtcRaw as string) ?? RES_BTC;
  const sats = Number((BigInt(amtRaw) * BigInt(rb)) / (BigInt(rp) + BigInt(amtRaw)));
  const blocks = gridOf(WIN_FROM, WIN_TO);
  return {
    t: 'peerBurn',
    id: 'u_' + who,
    txid: tx('a' + who + peerAmount),
    from: ADDR[who],
    amtRaw,
    factory: FACTORY,
    pool: 0,
    startsAt: WIN_FROM,
    endsAt: WIN_TO,
    refHash: HASH,
    blocks,
    resPeerRaw: RES_PEER,
    resBtcRaw: RES_BTC,
    twapMs: TWAP_MS,
    obs: blocks.length,
    sats,
    creditsSats: sats,
    reserve: sats / 100,
    addr: DEAD,
    blockMs: BURNED_AT,
    ts: BURNED_AT + 100,
    ...over,
  };
}

/** A verified Bitcoin burn, the shape the existing door already writes. */
function btcBurn(who: string, sats: number, nonce = 'x'): Act {
  return { t: 'btcBurn', id: 'u_' + who, sats, addr: 'bc1qdead', txid: (who + nonce).padEnd(64, 'f') };
}

/** A world where these handles exist AND have each bound their own address. */
function bound(...who: string[]): Act[] {
  return [...seed(...who), ...who.map((w) => bind(w))];
}

/** How much reserve an account holds after a log, and after the same log minus one act. */
function reserveOf(acts: Act[], who: string) {
  return replay(acts).ledgerById['u_' + who]!.burnBal;
}
/** The reserve a single extra act was responsible for, with act costs held equal. */
function credited(base: Act[], extra: Act[], who: string) {
  const withOut = reserveOf(base, who);
  const withIn = reserveOf([...base, ...extra], who);
  return +(withIn - withOut).toFixed(10);
}
/** Every refusal replay printed, as sentences. */
function refusals(acts: Act[]) {
  return replay(acts).chron.filter((c) => /PEER burn was refused/.test(c.line)).map((c) => c.line);
}

describe('peerBurn — reserve from the recorded numbers, and from nothing else', () => {
  it('credits exactly what the act records, and what the act records is what the reserves produce', () => {
    const base = bound('al');
    // 1000 PEER against 1,000,000 PEER / 10,000,000 sat is 9990 sat by the
    // pool's own answer — floor(amt·resBtc/(resPeer+amt)), the constant-product
    // output rather than the marginal ratio, which is a price no trade can get.
    const act = peerBurn('al', 1000n);
    expect(act.sats).toBe(9990);
    expect(act.reserve).toBe(99.9);
    expect(credited(base, [act], 'al')).toBe(99.9);
  });

  it('prices at the SAME rate as the bitcoin door — one price of speech, two doors', () => {
    const base = bound('al', 'bo');
    // 9990 satoshis destroyed as bitcoin, and 9990 satoshis' worth of PEER,
    // must buy the identical amount of reserve. If these two ever diverge, one
    // door has become a discount on speaking.
    const byBitcoin = credited(base, [btcBurn('al', 9990, 'same')], 'al');
    const byPeer = credited(base, [peerBurn('bo', 1000n)], 'bo');
    expect(byPeer).toBe(byBitcoin);
  });

  it('never touches the weight that decides the mint or the writer election', () => {
    // burnedSats is documented as value destroyed ON THE BITCOIN CHAIN, and it
    // is the weight in the epoch distribution. A PEER burn has a price, and a
    // price can be lied to — so the most a manipulated window can ever buy is
    // the right to speak. Proven the way the engine exposes it: an account
    // whose only commitment is a PEER burn earns nothing from an epoch.
    const acts: Act[] = [
      { t: 'seedWorld' },
      { t: 'register', id: 'u_al', handle: 'al', seed: 1, epoch: 0 },
      { t: 'register', id: 'u_bo', handle: 'bo', seed: 1, epoch: 0 },
      bind('bo'),
      peerBurn('bo', 1000n),
      { t: 'post', author: 'u_al', text: 'P', a: 0.8 },
      { t: 'opinion', author: 'u_bo', target: 'c1', p: 0.8, r: 0.8 },
      { t: 'closeEpoch', epoch: 1 },
    ];
    const st = replay(acts);
    const tokens = (st as unknown as { tokens: { bal: Record<string, Record<string, number>>;
      dist: Array<{ minted: number; totalWeight: number }> } }).tokens;
    // bo can act — the reserve is real…
    expect(st.ledgerById.u_bo!.burnBal).toBeGreaterThan(0);
    // …and weighs nothing: the whole pool carries forward, unminted.
    expect(tokens.dist[0]!.minted).toBe(0);
    expect(tokens.dist[0]!.totalWeight).toBe(0);
    expect((tokens.bal.PEER || {}).u_al).toBeUndefined();
  });

  it('buys acts, and the engine no longer claims it buys no standing', () => {
    // The branch used to end 'never a share of the mint, never a vote for the
    // writer, never standing that was not earned'. The first two are true and
    // are asserted above. The third was contradicted by this same engine's
    // account of the faucet — reserve buys acts, acts append the edges CoGra
    // solves standing over — so it is gone. This test holds down what remains
    // true: the reserve is spendable on acts, and spending it moves standing.
    const base = bound('al', 'bo');
    const quiet = replay([...base, peerBurn('al', 1000n)]);
    const loud = replay([...base, peerBurn('al', 1000n),
      { t: 'post', author: 'u_al', text: 'one', a: 0.8 },
      { t: 'opinion', author: 'u_bo', target: 'c1', p: 0.9, r: 0.9 }]);
    expect(loud.ledgerById.u_al!.actCount).toBeGreaterThan(quiet.ledgerById.u_al!.actCount);
    expect(loud.xById.u_al).not.toBe(quiet.xById.u_al);
  });
});

describe('peerBurn — whose burn it is, decided by the log', () => {
  it('refuses a burn from an address no handle had bound', () => {
    const base = seed('al');                      // registered, nothing bound
    expect(credited(base, [peerBurn('al', 1000n)], 'al')).toBe(0);
    expect(refusals([...base, peerBurn('al', 1000n)])[0]).toMatch(/no handle had bound/);
  });

  it('refuses the theft that was demonstrated against the live door', () => {
    // A stranger binds the burner's address and files the claim. Under the old
    // rule this returned 200 and 24.99 reserve, and locked the real burner out
    // of their own destroyed coins forever, on every host.
    const base = bound('al');
    const stolen = peerBurn('bo', 1000n, { from: ADDR.al });
    expect(credited([...seed('bo'), ...base, bind('bo', 9_000, ADDR.al)], [stolen], 'bo')).toBe(0);
  });

  it('pays nobody for an address two handles have bound', () => {
    // Not the first binder and not the newest: both of those rules end in a
    // theft. Ambiguity closes the door for that address, which costs a burn
    // and never hands one to somebody else.
    const base = [...bound('al'), ...seed('bo'), bind('bo', BOUND_AT + 1, ADDR.al)];
    expect(credited(base, [peerBurn('al', 1000n)], 'al')).toBe(0);
    expect(refusals([...base, peerBurn('al', 1000n)])[0]).toMatch(/more than one handle has bound/);
  });

  it('refuses a binding filed after the coins were destroyed, even by their owner', () => {
    // The honest cost of closing the pending-list harvest, and it is said in
    // those words rather than hidden: bind first, then burn.
    const late = [...seed('al'), bind('al', BURNED_AT + 1)];
    expect(credited(late, [peerBurn('al', 1000n)], 'al')).toBe(0);
    expect(refusals([...late, peerBurn('al', 1000n)])[0]).toMatch(/bound after those coins were destroyed/);
  });

  it('refuses a burn whose recorded sender is not an address at all', () => {
    expect(credited(bound('al'), [peerBurn('al', 1000n, { from: undefined })], 'al')).toBe(0);
    expect(credited(bound('al'), [peerBurn('al', 1000n, { from: 'me' })], 'al')).toBe(0);
  });

  it('leaves epoch-earnings bindings alone — one address may still name two handles', () => {
    // The live log already contains one address bound by two handles. Making
    // binding itself first-come would have recomputed an earnings root that is
    // already published, so ownership for THIS door is a separate question
    // asked of the same acts.
    const st = replay([...bound('al'), ...seed('bo'), bind('bo', BOUND_AT + 1, ADDR.al)]);
    expect(st.addresses.u_al).toBe(ADDR.al);
    expect(st.addresses.u_bo).toBe(ADDR.al);
    expect(st.peerBurn.binders[ADDR.al]!.n).toBe(2);
    expect(st.peerBurn.binders[ADDR.al]!.id).toBe(null);
  });
});

describe('peerBurn — a burn is claimed once, ever, up to its own value', () => {
  it('credits a repeated transaction hash exactly once', () => {
    const base = bound('al');
    const one = peerBurn('al', 500n);
    const again = { ...one };            // the same txid, presented twice
    expect(credited(base, [one], 'al')).toBe(49.97);
    expect(credited(base, [one, again], 'al')).toBe(49.97);
  });

  it('credits it once however the hash is SPELLED', () => {
    // The dedupe table was keyed on the raw string while the validator accepted
    // upper-case hex, so 0xABAB… and 0xabab… were one Base transaction and two
    // keys here. Measured before the fix: 19.98 reserve for one 9.99 burn.
    const base = bound('al');
    const one = peerBurn('al', 100n);
    const shouted = { ...one, txid: (one.txid as string).toUpperCase().replace('0X', '0x') };
    expect(credited(base, [one], 'al')).toBe(9.99);
    expect(credited(base, [one, shouted], 'al')).toBe(9.99);
  });

  it('keeps the bitcoin dedupe case-insensitive too, without moving any existing burn', () => {
    const base = seed('al');
    const lower = btcBurn('al', 1000, 'case');
    const upper = { ...lower, txid: (lower.txid as string).toUpperCase() };
    expect(credited(base, [lower], 'al')).toBe(10);
    expect(credited(base, [lower, upper], 'al')).toBe(10);
    // …and the burns that are already in the live log, which are all lower
    // case, still credit exactly what they credited.
    expect(credited(base, [btcBurn('al', 54321, 'k')], 'al')).toBe(543.21);
  });

  it('refuses a second claim on the same hash even from a different handle', () => {
    const base = bound('al', 'bo');
    const mine = peerBurn('al', 500n);
    const stolen = { ...mine, id: 'u_bo', from: ADDR.bo };
    expect(credited(base, [mine, stolen], 'bo')).toBe(0);
    expect(credited(base, [mine, stolen], 'al')).toBe(49.97);
  });

  it('keeps the bitcoin and Base dedupe tables apart', () => {
    // Same 64 characters, two different chains. Sharing one table would make a
    // bitcoin txid and a Base transaction hash interchangeable inside the one
    // structure whose entire job is to say which burn was already paid for.
    const base = bound('al');
    const collide = '0x' + 'a'.repeat(64);          // byte-identical in both tables
    const both = [
      { t: 'btcBurn', id: 'u_al', sats: 1000, addr: 'bc1qdead', txid: collide },
      peerBurn('al', 500n, { txid: collide }),
    ];
    expect(credited(base, both, 'al')).toBe(10 + 49.97);
  });
});

describe('peerBurn — an act that disagrees with itself is refused', () => {
  const base = bound('al');
  const say = (over: Act) => credited(base, [peerBurn('al', 1000n, over)], 'al');

  it('refuses a satoshi value its own reserves do not produce', () => {
    expect(say({ sats: 9991, reserve: 99.91, creditsSats: 9991 })).toBe(0);
    expect(say({ sats: 99900, reserve: 999, creditsSats: 99900 })).toBe(0);
  });

  it('refuses a reserve credit that is not sats ÷ SATS_PER_RESERVE', () => {
    expect(say({ reserve: 999 })).toBe(0);
    expect(say({ reserve: 99.9000001 })).toBe(0);
  });

  it('says why, in the chronicle, rather than skipping in silence', () => {
    const line = refusals([...base, peerBurn('al', 1000n, { sats: 9991, reserve: 99.91, creditsSats: 9991 })])[0];
    expect(line).toBeTruthy();
    expect(line).toMatch(/9990 sat/);
  });

  it('refuses reserves that arrived as JSON numbers instead of exact strings', () => {
    // An 18-decimal amount does not survive Number() intact, and two honest
    // hosts that both rounded it would still have to agree on how.
    expect(say({ amtRaw: 1e21 })).toBe(0);
    expect(say({ resPeerRaw: 1e24 })).toBe(0);
  });

  it('refuses a burn that names no pool, no factory, or the wrong sink', () => {
    expect(say({ pool: undefined })).toBe(0);
    expect(say({ factory: undefined })).toBe(0);
    expect(say({ factory: 'the main one' })).toBe(0);
    expect(say({ addr: '0x0000000000000000000000000000000000000000' })).toBe(0);
    expect(say({ addr: '0x8Af0e5F458D99a255092A3B6C9874dD153aB3714' })).toBe(0);
  });

  it('accepts the dead address in any case, because a hash is not a spelling test', () => {
    expect(say({ addr: DEAD.toLowerCase() })).toBe(99.9);
    expect(say({ addr: DEAD.toUpperCase().replace('0X', '0x') })).toBe(99.9);
  });

  it('refuses an act that states no slice, or a slice bigger than the burn', () => {
    expect(say({ creditsSats: 0 })).toBe(0);
    expect(say({ creditsSats: 9991 })).toBe(0);
    expect(say({ creditsSats: undefined })).toBe(0);
    expect(say({ creditsSats: 99.5 })).toBe(0);
  });
});

describe('peerBurn — the window, and where inside it the price was read', () => {
  const base = bound('al');
  const say = (over: Act) => credited(base, [peerBurn('al', 1000n, over)], 'al');

  it('refuses a pool below the minimum bitcoin depth, rather than pricing it badly', () => {
    // 0.001 cbBTC against a tenth of the PEER: the same price, a tenth of the
    // depth. Same arithmetic, refused — because below the floor a pool has no
    // price, only a last trade, and an attacker can buy that.
    const thin = peerBurn('al', 1000n, { resPeerRaw: PEER(100_000n), resBtcRaw: '100000' });
    const sats = Number((BigInt(thin.amtRaw as string) * 100000n) / (BigInt(PEER(100_000n)) + BigInt(thin.amtRaw as string)));
    expect(credited(base, [{ ...thin, sats, creditsSats: sats, reserve: sats / 100 }], 'al')).toBe(0);
  });

  it('accepts a pool exactly at the floor — the boundary is stated, not approximate', () => {
    const at = peerBurn('al', 1000n, { resBtcRaw: '1000000' });
    const sats = Number((BigInt(at.amtRaw as string) * 1000000n) / (BigInt(RES_PEER) + BigInt(at.amtRaw as string)));
    expect(credited(base, [{ ...at, sats, creditsSats: sats, reserve: sats / 100 }], 'al')).toBe(sats / 100);
  });

  it('refuses a price averaged over too short a window, or too few observations', () => {
    expect(say({ twapMs: TWAP_MS - 1 })).toBe(0);
    expect(say({ obs: TWAP_OBS - 1 })).toBe(0);
    expect(say({ twapMs: 0, obs: 1 })).toBe(0);
    expect(say({ twapMs: undefined })).toBe(0);
  });

  it('refuses an act that does not say where its window sat', () => {
    expect(say({ startsAt: undefined })).toBe(0);
    expect(say({ endsAt: undefined })).toBe(0);
    expect(say({ endsAt: WIN_FROM })).toBe(0);      // a window with no width
    expect(say({ refHash: undefined })).toBe(0);
    expect(say({ blocks: undefined })).toBe(0);
  });

  it('refuses readings taken anywhere but the blocks its own seed selects', () => {
    // The whole point of seeding the grid with the reference block's hash: the
    // sampled blocks cannot be known in advance, so an attacker cannot pump
    // exactly them — and a host cannot sample where it likes either, because
    // this is arithmetic replay can redo.
    const good = gridOf(WIN_FROM, WIN_TO);
    expect(say({ blocks: good.map((b, i) => (i === 3 ? b + 1 : b)) })).toBe(0);
    expect(say({ blocks: good.slice().reverse() })).toBe(0);
    // A different seed picks different blocks, so the same list no longer fits.
    expect(say({ refHash: '0x' + 'f'.repeat(64) })).toBe(0);
    // And the honest list still passes, which is what makes the above a rule
    // rather than a refusal of everything.
    expect(say({ blocks: good })).toBe(99.9);
  });

  it('lets a few unreadable blocks cost accuracy rather than the whole quote', () => {
    const good = gridOf(WIN_FROM, WIN_TO);
    expect(good.length).toBe(GRID_N);
    const missing = good.filter((_, i) => i !== 2 && i !== 7);   // 14 of 16
    expect(say({ blocks: missing, obs: missing.length })).toBe(99.9);
    // …but not below the engine's own observation floor.
    const tooFew = good.slice(0, TWAP_OBS - 1);
    expect(say({ blocks: tooFew, obs: tooFew.length })).toBe(0);
  });

  it('derives the same grid twice, and a different one from a different block', () => {
    expect(gridOf(WIN_FROM, WIN_TO)).toEqual(gridOf(WIN_FROM, WIN_TO));
    expect(gridOf(WIN_FROM, WIN_TO)).not.toEqual(gridOf(WIN_FROM, WIN_TO, '0x' + 'ab'.repeat(32)));
    // Spread across the window rather than clustered: one block per bucket,
    // which is what stops sixteen readings from being a spot price in disguise.
    const g = gridOf(WIN_FROM, WIN_TO);
    for (let i = 1; i < g.length; i++) expect(g[i]!).toBeGreaterThan(g[i - 1]!);
    expect(g[0]!).toBeLessThan(WIN_FROM + (WIN_TO - WIN_FROM) / GRID_N);
    expect(g[g.length - 1]!).toBeGreaterThan(WIN_TO - (WIN_TO - WIN_FROM) / GRID_N);
  });

  it('cannot be worth more than the pool holds, however much PEER is destroyed', () => {
    // The constant-product form carries this ceiling PER ACT for free. A burn
    // of a hundred million PEER against a pool holding 10,000,000 sat still
    // cannot be worth more than 10,000,000 sat — the marginal-ratio price
    // would have credited a thousand times the pool's whole bitcoin side.
    const huge = peerBurn('al', 100_000_000n);
    expect(huge.sats as number).toBeLessThan(10_000_000);
    expect(huge.sats as number).toBeGreaterThan(9_900_000);
  });
});

describe('peerBurn — the per-account ceiling, enforced in replay', () => {
  it('binds when a second burn would carry an account past the ceiling', () => {
    const base = bound('al');
    const first = peerBurn('al', 1000n);           // 99.9 reserve
    const second = peerBurn('al', 1000n, { txid: tx('bbb') });
    expect(credited(base, [first], 'al')).toBe(99.9);
    // The second is refused whole rather than trimmed, because the act states
    // the slice it credits and this one states a slice that does not fit. The
    // host files a smaller slice instead; a hand-written log gets a refusal.
    expect(credited(base, [first, second], 'al')).toBe(99.9);
  });

  it('takes the part that fits when the act says so', () => {
    const base = bound('al');
    const first = peerBurn('al', 1000n);                                  // 9990 sat
    const rest = peerBurn('al', 1000n, { txid: tx('bbb'), creditsSats: 10 });
    expect(credited(base, [first, rest], 'al')).toBe(100);
    // …and never past the ceiling, whatever the act claims.
    expect(credited(base, [first, { ...rest, creditsSats: 11 }], 'al')).toBe(99.9);
  });

  it('lets an account fill the allowance across several smaller burns', () => {
    const base = bound('al');
    const a = peerBurn('al', 500n, { txid: tx('c1') });   // 49.97
    const b = peerBurn('al', 500n, { txid: tx('c2') });   // 49.97 -> 99.94
    const c = peerBurn('al', 500n, { txid: tx('c3') });   // would be 149.91
    expect(credited(base, [a, b], 'al')).toBe(99.94);
    expect(credited(base, [a, b, c], 'al')).toBe(99.94);
  });

  it('counts in satoshis, so filling the allowance exactly does not drift past it', () => {
    // Ten burns of 9.99 reserve each. Added as reserve this reached
    // 99.99000000000252 against a cap of 100; added as satoshis it is 9990.
    const base = bound('al');
    const ten = Array.from({ length: 10 }, (_, i) => peerBurn('al', 100n, { txid: tx('e' + i) }));
    expect(credited(base, ten, 'al')).toBe(99.9);
    const st = replay([...base, ...ten]);
    expect(st.peerBurn.usedSatsThisEpoch['u_al@0']).toBe(9990);
    expect(st.peerBurn.usedThisEpoch['u_al@0']).toBe(99.9);
  });

  it('resets at the epoch boundary, and the refusal names what is left', () => {
    const base = bound('al');
    const a = peerBurn('al', 1000n, { txid: tx('d1') });
    const b = peerBurn('al', 1000n, { txid: tx('d2') });
    const acts = [...base, a, b, { t: 'closeEpoch', epoch: 1 }, peerBurn('al', 1000n, { txid: tx('d3') })];
    const refused = refusals(acts);
    expect(refused).toHaveLength(1);
    expect(refused[0]!).toMatch(/per account per epoch/);
    expect(refused[0]!).toMatch(/claimable after the next epoch closes/);
    // Two credited burns: one before the close, one after.
    expect(replay(acts).chron.filter((c) => /burned .* PEER →/.test(c.line))).toHaveLength(2);
  });

  it('finishes a burn worth MORE than a whole epoch’s allowance, an epoch at a time', () => {
    // The bug this replaces: the ceiling test refused the act whole, `used`
    // resets each epoch, so `0 + reserve > 100` held in every epoch that will
    // ever exist. A 100,000 PEER burn — 9,090.9 reserve, and against this pool
    // the line is crossed at about 1,101 PEER — credited NOTHING, forever,
    // while the refusal said 'claim the rest next epoch'.
    const base = bound('al');
    const whole = peerBurn('al', 100_000n, { txid: tx('big') });
    expect(whole.sats).toBe(909_090);
    expect(whole.reserve).toBe(9090.9);
    // Presented whole it still does not fit, and says so.
    expect(credited(base, [whole], 'al')).toBe(0);
    // Presented as the slices the host actually files, it credits an epoch's
    // worth each time and the remainder stays claimable.
    const slice = { ...whole, creditsSats: 10_000 };
    const acts = [...base, slice, { t: 'closeEpoch', epoch: 1 }, slice, { t: 'closeEpoch', epoch: 2 }, slice];
    expect(credited(base, acts.slice(base.length), 'al')).toBe(300);
    const st = replay(acts);
    expect(st.peerBurn.txCreditedSats[whole.txid as string]).toBe(30_000);
    expect(st.peerBurn.tx[whole.txid as string]).toBe('u_al');
  });

  it('never credits more of a transaction than that transaction was worth', () => {
    const base = bound('al');
    const small = peerBurn('al', 100n, { txid: tx('sm') });      // 999 sat
    expect(small.sats).toBe(999);
    const acts = [...base, { ...small, creditsSats: 900 }, { ...small, creditsSats: 100 }];
    expect(credited(base, acts.slice(base.length), 'al')).toBe(9);       // 900 sat, not 1000
    expect(refusals(acts)[0]).toMatch(/already been credited/);
  });

  it('bounds each account separately — the ceiling is per account, not per network', () => {
    const base = bound('al', 'bo');
    const both = [peerBurn('al', 1000n, { txid: tx('e1') }), peerBurn('bo', 1000n, { txid: tx('e2') })];
    expect(credited(base, both, 'al')).toBe(99.9);
    expect(credited(base, both, 'bo')).toBe(99.9);
  });

  it('is a rule of the LOG, not of this host — a foreign log is bound the same way', () => {
    // The point of enforcing it here rather than only at the door: nothing in
    // this fixture ever passed through a host. These acts are hand-written,
    // exactly as a mirror or a fork with the check removed would produce.
    const base = bound('al');
    const overs = [1000n, 1000n, 1000n, 1000n].map((n, i) => peerBurn('al', n, { txid: tx('f' + i) }));
    expect(credited(base, overs, 'al')).toBe(99.9);
  });
});

describe('peerBurn — the per-pool aggregate, which is what makes the ceiling mean anything', () => {
  /** One address per handle, and never the zero address — that one is refused. */
  const wallet = (i: number) => '0x' + (i + 1).toString(16).padStart(40, '0');
  /** A crowd of free handles, each with its own bound address. */
  function crowd(n: number, from = 0): { acts: Act[]; ids: string[] } {
    const acts: Act[] = from === 0 ? [{ t: 'seedWorld' }] : [];
    const ids: string[] = [];
    for (let i = from; i < from + n; i++) {
      const id = 'h' + i;
      ids.push(id);
      acts.push({ t: 'register', id: 'u_' + id, handle: id, seed: 1, epoch: 0 });
      acts.push({ t: 'bindAddress', id: 'u_' + id, addr: wallet(i), ts: BOUND_AT });
    }
    return { acts, ids };
  }
  /** One burn against a pool that sits exactly at the minimum permitted depth. */
  const THIN_PEER = PEER(100_000n);
  const THIN_BTC = '1000000';
  function atFloor(i: number, over: Act = {}): Act {
    const amtRaw = PEER(1011n);          // just over a full epoch's allowance
    const sats = Number((BigInt(amtRaw) * BigInt(THIN_BTC)) / (BigInt(THIN_PEER) + BigInt(amtRaw)));
    const blocks = gridOf(WIN_FROM, WIN_TO);
    return {
      t: 'peerBurn', id: 'u_h' + i, txid: '0x' + String(i).padStart(64, 'd'),
      from: wallet(i), amtRaw, factory: FACTORY, pool: 0,
      startsAt: WIN_FROM, endsAt: WIN_TO, refHash: HASH, blocks,
      resPeerRaw: THIN_PEER, resBtcRaw: THIN_BTC, twapMs: TWAP_MS, obs: blocks.length,
      sats, creditsSats: Math.min(sats, 10_000), reserve: sats / 100,
      addr: DEAD, blockMs: BURNED_AT, ts: BURNED_AT + 100, ...over,
    };
  }

  it('stops a pool creating more reserve in an epoch than it holds bitcoin', () => {
    // Measured before this bound existed: 300 handles each filling the
    // per-account ceiling once created 27,100 reserve — 2,710,000 satoshis of
    // 'value destroyed' — against a pool whose entire bitcoin side was
    // 1,000,000 satoshis and which could have realised about 749,600 of them.
    // Handles are free, so it scaled linearly and had no upper bound at all.
    const { acts, ids } = crowd(300);
    const log = [...acts, ...ids.map((_, i) => atFloor(i))];
    const st = replay(log);
    let total = 0;
    for (const id of ids) total += st.ledgerById['u_' + id]!.burnBal;
    expect(Math.round(total * 100)).toBe(1_000_000);       // the pool's whole bitcoin side, exactly
    expect(total).toBe(10_000);
    expect(st.peerBurn.poolUsedSatsThisEpoch[FACTORY.toLowerCase() + '#0@0']).toBe(1_000_000);
  });

  it('says so in words, and lets the next epoch through', () => {
    const { acts, ids } = crowd(300);
    const filled = [...acts, ...ids.map((_, i) => atFloor(i))];
    const refused = refusals(filled);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]!).toMatch(/cannot create more reserve in an epoch than it holds bitcoin/);
    // A fresh epoch reopens the pool — the bound is per epoch, not for ever.
    const after = replay([...filled, { t: 'closeEpoch', epoch: 1 },
      { ...atFloor(0), txid: '0x' + 'e'.repeat(64) }]);
    expect(after.peerBurn.poolUsedSatsThisEpoch[FACTORY.toLowerCase() + '#0@1']).toBeGreaterThan(0);
  });

  it('counts pools apart, so one pool being exhausted does not shut another', () => {
    // Twenty handles burn against pool 0 and twenty different ones against
    // pool 1 — the same factory, the same depth, the same amounts. If the
    // aggregate were kept per factory rather than per pool, the second twenty
    // would be paying for the first twenty's epoch.
    const a = crowd(20, 0);
    const b = crowd(20, 20);
    const st = replay([...a.acts, ...b.acts,
      ...a.ids.map((_, i) => atFloor(i)),
      ...b.ids.map((_, i) => atFloor(20 + i, { pool: 1, txid: '0x' + String(i).padStart(64, 'c') }))]);
    const used0 = st.peerBurn.poolUsedSatsThisEpoch[FACTORY.toLowerCase() + '#0@0'];
    const used1 = st.peerBurn.poolUsedSatsThisEpoch[FACTORY.toLowerCase() + '#1@0'];
    expect(used0).toBeGreaterThan(0);
    expect(used1).toBe(used0);
  });
});

describe('peerBurn — two hosts replaying one log reach one answer', () => {
  it('is deterministic across repeated replays of the same acts', () => {
    const acts = [...bound('al', 'bo'),
      peerBurn('al', 1000n, { txid: tx('g1') }),
      peerBurn('bo', 333n, { txid: tx('g2') }),
      { t: 'post', author: 'u_al', text: 'hello', a: 0.8 },
      { t: 'closeEpoch', epoch: 1 },
      peerBurn('al', 777n, { txid: tx('g3') }),
    ];
    const one = replay(acts);
    const two = replay(acts.map((a) => JSON.parse(JSON.stringify(a))));
    expect(two.ledgerById.u_al!.burnBal).toBe(one.ledgerById.u_al!.burnBal);
    expect(two.ledgerById.u_bo!.burnBal).toBe(one.ledgerById.u_bo!.burnBal);
    expect(two.peerBurn.by).toEqual(one.peerBurn.by);
    expect(two.peerBurn.usedSatsThisEpoch).toEqual(one.peerBurn.usedSatsThisEpoch);
    expect(two.peerBurn.poolUsedSatsThisEpoch).toEqual(one.peerBurn.poolUsedSatsThisEpoch);
  });

  it('carries no float drift into the reserve of an awkward amount', () => {
    // An amount with no round answer is where a divided-then-stored rate would
    // start disagreeing between hosts. Everything up to the satoshi is integer
    // arithmetic on strings, and the single division that follows is the same
    // one the bitcoin door has always done — so there is nothing left to drift.
    const base = bound('al');
    const odd = peerBurn('al', 313n);
    expect(odd.sats).toBe(3129);
    expect(credited(base, [odd], 'al')).toBe(31.29);
  });
});

describe('both doors in one log, credited correctly and independently', () => {
  it('adds a bitcoin burn and a PEER burn without either disturbing the other', () => {
    const acts: Act[] = [
      { t: 'seedWorld' },
      { t: 'register', id: 'u_al', handle: 'al', seed: 1, epoch: 0 },
      bind('al'),
      btcBurn('al', 30000, 'btc1'),          // 300 reserve
      peerBurn('al', 500n, { txid: tx('h1') }), // 4997 sat -> 49.97 reserve
      btcBurn('al', 12345, 'btc2'),          // 123.45 reserve
      peerBurn('al', 400n, { txid: tx('h2') }),
    ];
    const st = replay(acts);
    const peerTwo = Number((BigInt(PEER(400n)) * BigInt(RES_BTC)) / (BigInt(RES_PEER) + BigInt(PEER(400n)))) / 100;
    // Registration debits θ once and nothing else here costs anything.
    const theta = 300 - replay(acts.slice(0, 4)).ledgerById.u_al!.burnBal;
    expect(st.ledgerById.u_al!.burnBal).toBeCloseTo(300 + 49.97 + 123.45 + peerTwo - theta, 9);
    // The bitcoin weight counts only the bitcoin: 42,345 sat, not the PEER.
    expect(st.peerBurn.by.u_al).toBe(PEER(900n));
  });

  it('leaves every btcBurn in an existing log crediting exactly what it credited before', () => {
    // The retroactive-rewrite guard. A change to reserve arithmetic that moved
    // an old bitcoin burn would recompute everyone's standing and invalidate
    // every published epoch certificate.
    const bitcoinOnly = [...seed('al'), btcBurn('al', 54321, 'k')];
    expect(replay(bitcoinOnly).ledgerById.u_al!.burnBal)
      .toBe(replay([...bitcoinOnly]).ledgerById.u_al!.burnBal);
    expect(credited(seed('al'), [btcBurn('al', 54321, 'k')], 'al')).toBe(543.21);
  });
});

describe('peerBurn — what the engine publishes about the door', () => {
  it('states its own limits, so the screen and the host refuse in the same numbers', () => {
    const st = replay(seed('al'));
    expect(st.peerBurn.limits.satsPerReserve).toBe(100);
    expect(st.peerBurn.limits.reservePerEpoch).toBe(100);
    expect(st.peerBurn.limits.satsPerEpoch).toBe(10_000);
    expect(st.peerBurn.limits.minPoolSats).toBe(1000000);
    expect(st.peerBurn.limits.twapMs).toBe(TWAP_MS);
    expect(st.peerBurn.limits.twapObs).toBe(TWAP_OBS);
    expect(st.peerBurn.limits.twapGrid).toBe(16);
    expect(st.peerBurn.limits.addr).toBe(DEAD.toLowerCase());
  });

  it('says plainly that the two burns are not equally provable', () => {
    const st = replay(seed('al'));
    expect(st.peerBurn.limits.provenance).toMatch(/unspendable by arithmetic/);
    expect(st.peerBurn.limits.provenance).toMatch(/nobody knows a key/);
    expect(st.peerBurn.limits.provenance).toMatch(/only one of them is a proof/);
  });

  it('answers the same question the branch will, before anything is written', () => {
    const st = replay(bound('al'));
    expect(st.peerBurnActError(peerBurn('al', 1000n), 0)).toBeNull();
    expect(st.peerBurnActError(peerBurn('al', 1000n, { sats: 1 }), 0)).toMatch(/disagrees with itself/);
    expect(st.peerBurnActError(peerBurn('zz', 1000n), 0)).toBe('unknown actor');
  });
});
