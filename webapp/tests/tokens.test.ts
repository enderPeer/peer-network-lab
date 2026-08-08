/**
 * The PEER token, its epoch distribution, and the pools.
 *
 * Two walls hold this together, and both are asserted rather than trusted:
 *
 * 1. Value never becomes standing. No token act creates a graph edge, compiles
 *    a vouch, or moves anyone's solved standing beyond the ordinary θ cost of
 *    acting. If money could reach the reputation system, the network's central
 *    claim would be for sale.
 * 2. The distribution pays creators for engagement they drew, gated the same
 *    way everything here is gated: on burned commitment. A swarm of empty
 *    accounts weighs nothing.
 */
import { describe, it, expect } from 'vitest';
import { replay, seed } from './helpers/world';

/**
 * seed + a proven Bitcoin burn each, so every actor carries the same weight.
 *
 * Weight used to come from the faucet, which is why this helper used to hand
 * out `burn` acts. It comes from destroyed value now, so it hands out the
 * thing that is actually scarce. One TOK_SAT_UNIT (1000 sat) each puts every
 * actor at exactly λ = 1, which is what makes the arithmetic in these tests
 * readable: a weight is then just base × damping.
 */
const BURN_UNIT = 1000;
function btcBurn(name: string, sats = BURN_UNIT, nonce = 0) {
  // A txid is 64 hex characters and each burn must be a distinct one — the
  // replay credits a given txid exactly once, on purpose.
  const txid = (name + ':' + sats + ':' + nonce).padEnd(32, '0').split('')
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').slice(0, 64).padEnd(64, 'a');
  return { t: 'btcBurn', id: 'u_' + name, txid, sats, addr: 'bc1qdead' };
}
function world(...names: string[]) {
  const acts = seed(...names);
  for (const n of names) acts.push(btcBurn(n));
  return acts;
}
const post = (who: string, text: string) => ({ t: 'post', author: 'u_' + who, text, a: 0.8, rmen: [] });
const like = (who: string, cid: string) => ({ t: 'opinion', author: 'u_' + who, target: cid, p: 0.8, r: 0.8 });
const comment = (who: string, cid: string) => ({ t: 'review', author: 'u_' + who, target: cid, e: 0.7, f: 0.8, text: 'nice' });
const close = () => ({ t: 'closeEpoch', epoch: 1 });

describe('epoch distribution — the poolsite curve on the epoch clock', () => {
  it('mints 5000 to the sole engaged creator, minus nothing', () => {
    const acts = [...world('al', 'bo'), post('al', 'P'), like('bo', 'c1'), close()];
    const st = replay(acts);
    expect(st.tokens.dist).toHaveLength(1);
    expect(st.tokens.dist[0].minted).toBe(5000);
    expect(st.tokens.bal.PEER.u_al).toBe(5000);
    expect(st.tokens.bal.PEER.u_bo).toBeUndefined(); // engaging pays the CREATOR
  });

  it('carries the whole pool over an epoch nobody engaged in', () => {
    const acts = [...world('al'), post('al', 'P'), close(), close()];
    const st = replay(acts);
    expect(st.tokens.dist[0].minted).toBe(0);
    expect(st.tokens.dist[1].minted).toBe(0);
    expect(st.tokens.carry).toBe(10000); // two epochs of emission, waiting
  });

  it('pays the carried pool out with the next real engagement', () => {
    const acts = [...world('al', 'bo'), post('al', 'P'), close(), like('bo', 'c1'), close()];
    const st = replay(acts);
    expect(st.tokens.dist[1].minted).toBe(10000); // 5000 carried + 5000 fresh
    expect(st.tokens.bal.PEER.u_al).toBe(10000);
  });

  it('weighs comments 1.2 against likes 1.0', () => {
    const acts = [...world('al', 'bo', 'cy'),
      post('al', 'A'), post('bo', 'B'),
      like('cy', 'c1'),      // al drew a like
      comment('cy', 'c2'),   // bo drew a comment
      close()];
    const st = replay(acts);
    const ratio = st.tokens.bal.PEER.u_bo / st.tokens.bal.PEER.u_al;
    expect(ratio).toBeCloseTo(1.2, 5);
  });

  it('damps the tenth nudge from the same fan', () => {
    // Ten likes from one fan vs one like each from ten fans, identical rates:
    // breadth must beat repetition, or one friend with a buying habit is a
    // distribution strategy.
    const fans = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'fa'];
    const rep = [...world('al', 'bo', ...fans), post('al', 'A'), post('bo', 'B')];
    for (let i = 0; i < 10; i++) rep.push(like('f1', 'c1'));       // one fan, ten times
    for (const f of fans) rep.push(like(f, 'c2'));                 // ten fans, once each
    rep.push(close());
    const st = replay(rep);
    // The margin is now exactly derivable, so assert the number rather than a
    // hand-picked threshold. Ten fans once each weigh 10 × damp(1) = 10; one
    // fan ten times weighs Σ 1/(1+0.3(n−1)) for n=1..10 = 5.0188…, so breadth
    // wins by 1.992×. It used to clear 2× because the old λ punished the busy
    // fan a second time — a high act count lowered α̂ — and weight no longer
    // depends on how much you act, only on what you burned. Damping alone
    // still decides it, which is the property this test exists for.
    const ratio = st.tokens.bal.PEER.u_bo / st.tokens.bal.PEER.u_al;
    expect(ratio).toBeCloseTo(10 / 5.018773, 3);
    expect(ratio).toBeGreaterThan(1.9);
  });

  it('a stake split across twenty puppets weighs exactly what one account weighs', () => {
    // The whole reason this economy changed. Weight used to be λ(α̂)=α̂/(1+α̂),
    // which saturates per ACCOUNT, so splitting a stake beat concentrating it
    // — measured at 59.6% capture by twenty puppets, and documented in
    // TOKEN.md as unfixable while burn was a faucet. Weight is linear in
    // destroyed satoshis now, so the split is worth precisely nothing.
    const puppets = Array.from({ length: 20 }, (_, i) => 'p' + i);
    const split = seed('cr', 'whale', ...puppets);
    split.push(btcBurn('whale', 20000));                 // one account, 20k sat
    puppets.forEach((p, i) => split.push(btcBurn(p, 1000, i))); // twenty, 1k each
    split.push(post('cr', 'C'));
    // Both sides engage the same creator the same number of times, so only the
    // shape of the stake differs.
    const whaleSide = [...split];
    for (let i = 0; i < 20; i++) whaleSide.push(like('whale', 'c1'));
    const puppetSide = [...split];
    for (const p of puppets) puppetSide.push(like(p, 'c1'));

    const wDetail = replay([...whaleSide, close()]).tokens.dist[0];
    const pDetail = replay([...puppetSide, close()]).tokens.dist[0];
    // Same minted pool either way, and the creator receives all of it in both
    // — what matters is that neither arrangement out-weighs the other, which
    // is what "linear in committed value" means.
    expect(wDetail.minted).toBeCloseTo(pDetail.minted, 6);
    expect(wDetail.to.u_cr).toBeCloseTo(pDetail.to.u_cr, 6);
  });

  it('a real burn buys BOTH the right to speak and a share of the mint', () => {
    // The inversion this guards against: burning real bitcoin used to grant
    // weight but no reserve, while the free faucet granted reserve but no
    // weight — so the fake currency bought more participation than the real
    // one. A burn must buy at least what the faucet buys, or nobody sane
    // would ever burn.
    // The DELTA, not the balance: registering already hands out a starter
    // grant, and asserting the total would silently pin that grant's size
    // into a test about burns.
    const before = replay(seed('al')).ledgerById.u_al.burnBal;
    const after = replay([...seed('al'), btcBurn('al', 10000)]).ledgerById.u_al.burnBal;
    expect(after - before).toBeCloseTo(100, 6);  // 10,000 sat at 100 sat/unit
    // …and it still weighs, which the faucet never does.
    const withEngagement = replay([...seed('al', 'bo'), btcBurn('bo', 10000),
      post('al', 'P'), like('bo', 'c1'), close()]);
    expect(withEngagement.tokens.bal.PEER.u_al).toBeGreaterThan(0);
  });

  it('the faucet buys energy to act, and no share of the mint', () => {
    // Anyone can still speak: `burn` is untouched as a source of θ. It simply
    // stopped being evidence of commitment, because it never cost anything.
    const acts = [...seed('al', 'bo'),
      { t: 'btcBurn', id: 'u_bo', txid: 'abboabboabboabboabboabboabboabboffffffffffffffffffffffffffffffff', sats: 10000, addr: 'bc1qdead' }, { t: 'btcBurn', id: 'u_bo', txid: 'abboabboabboabboabboabboabboabboffffffffffffffffffffffffffffffff', sats: 10000, addr: 'bc1qdead' },
      post('al', 'P'), like('bo', 'c1'), close()];
    const st = replay(acts);
    // Nothing was distributed at all, so the PEER ledger was never even
    // created — a stronger statement than "al got zero".
    expect((st.tokens.bal.PEER ?? {}).u_al).toBeUndefined();
    expect(st.tokens.dist.every((d: { minted: number }) => d.minted === 0)
      || st.tokens.dist.length === 0).toBe(true);
    expect(st.ledgerById.u_bo.burnBal).toBeGreaterThan(0); // but bo can still act
  });

  it('gives zero weight to an actor below the α̂ gate', () => {
    // cy burns once (rate 1-θ·n ≈ high)… the gate needs α̂ < 0.2 to exclude,
    // so exhaust cy's rate with spam first.
    const acts = [...world('al'), { t: 'register', id: 'u_cy', handle: 'cy', seed: 1, epoch: 0 },
      { t: 'btcBurn', id: 'u_cy', txid: 'abcyabcyabcyabcyabcyabcyabcyabcyffffffffffffffffffffffffffffffff', sats: 10000, addr: 'bc1qdead' }, post('al', 'P')];
    // ~48 acts at θ≈0.0528 drain 1.0 burn to ≈0; rate collapses under 0.02·ν
    for (let i = 0; i < 40; i++) acts.push(post('cy', 'spam ' + i));
    acts.push(like('cy', 'c1'), close());
    const st = replay(acts);
    const cyLedger = st.ledgerById.u_cy;
    expect((cyLedger.burnBal / cyLedger.actCount) / 0.1).toBeLessThan(0.2); // gate really below
    expect(st.tokens.bal.PEER?.u_al).toBeUndefined();
    expect(st.tokens.carry).toBe(5000); // gated weight ⇒ full carryover
  });

  it('never counts self-engagement', () => {
    const acts = [...world('al'), post('al', 'P'), like('al', 'c1'), close()];
    expect(replay(acts).tokens.dist[0].minted).toBe(0);
  });

  it('decays emission 0.9 per 365 epochs', () => {
    const acts = [...world('al', 'bo'), post('al', 'P')];
    for (let i = 0; i < 365; i++) acts.push(close());
    acts.push(like('bo', 'c1'), close()); // epoch 366: year-2 emission joins the carry
    const st = replay(acts);
    // 365 epochs × 5000 carried + epoch 366 at 4500
    expect(st.tokens.dist[365].minted).toBeCloseTo(365 * 5000 + 4500, 4);
  });
});

describe('the wall between value and standing', () => {
  it('token acts create no graph edges and compile no vouches', () => {
    const base = [...world('al', 'bo'), post('al', 'P'), like('bo', 'c1'), close()];
    const withTok = [...base,
      { t: 'assetCreate', author: 'u_al', sym: 'TBTC', name: 'test unit', supply: 0.02 },
      { t: 'tokenSend', from: 'u_al', to: 'u_bo', sym: 'TBTC', amt: 0.01 },
      { t: 'assetCreate', author: 'u_al', sym: 'FUN', name: 'a joke', supply: 1000 },
      { t: 'tokenSend', author: 'u_al', sym: 'FUN', to: 'u_bo', amt: 10 },
      { t: 'poolCreate', author: 'u_al', symA: 'PEER', symB: 'TBTC', amtA: 100, amtB: 0.005 },
      { t: 'poolSwap', author: 'u_bo', pool: 'PEER/TBTC', sell: 'TBTC', amt: 0.001 },
    ];
    const a = replay(base), b = replay(withTok);
    expect(b.g.edges.length).toBe(a.g.edges.length);
    expect(Object.keys(b.bundles)).toEqual(Object.keys(a.bundles));
    for (const k of Object.keys(a.bundles)) {
      expect(b.bundles[k].pd).toBe(a.bundles[k].pd);
      expect(b.bundles[k].pi).toBe(a.bundles[k].pi);
    }
  });

  it('a token millionaire outranks nobody', () => {
    // bo ends up holding effectively everything; bo's standing must move only
    // by the ordinary θ cost of having acted, identical to spending the same
    // acts on anything else.
    const rich = [...world('al', 'bo'),
      { t: 'assetCreate', author: 'u_bo', sym: 'GOLD', name: 'all of it', supply: 1e9 },
      { t: 'assetCreate', author: 'u_bo', sym: 'TBTC', name: 'test unit', supply: 0.01 },
    ];
    const poor = [...world('al', 'bo'),
      post('bo', 'x'), post('bo', 'y'), // same act count, no tokens
    ];
    const a = replay(rich), b = replay(poor);
    expect(a.xById.u_bo).toBeCloseTo(b.xById.u_bo, 9);
  });
});





describe('the emission schedule is a ceiling, not a target', () => {
  it('never mints more than the epoch pool, however many creators share it', () => {
    // Rounding to nearest let the sum of shares exceed the pool by a sliver
    // per creator — real drift on the live log, and a slow leak past the cap.
    const many = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
    const acts = [...world('bo', ...many)];
    many.forEach((n) => acts.push(post(n, 'by ' + n)));
    many.forEach((_, i) => acts.push(like('bo', 'c' + (i + 1))));
    acts.push(close());
    const st = replay(acts);
    expect(st.tokens.dist[0].minted).toBeLessThanOrEqual(5000);
    expect(st.tokens.dist[0].minted + st.tokens.carry).toBeCloseTo(5000, 9);
  });

  it('keeps total supply at or under the schedule across many epochs', () => {
    const acts = [...world('al', 'bo', 'cy'), post('al', 'A'), post('cy', 'C')];
    for (let e = 0; e < 12; e++) {
      acts.push(like('bo', 'c1'), comment('bo', 'c2'), close());
    }
    const st = replay(acts);
    expect(st.tokens.supply.PEER).toBeLessThanOrEqual(12 * 5000);
    // and nothing is lost: everything minted or carried, to the micro-token
    expect(st.tokens.supply.PEER + st.tokens.carry).toBeCloseTo(12 * 5000, 6);
  });
});

describe('deletion stays scoring-neutral even when token acts are in the log', () => {
  it('leaves every standing and every epoch certificate exactly reproducible', () => {
    // An attack agent found this the same way the probe did: if a token act is
    // skipped when its author is later deleted, its θ-debit vanishes with it —
    // which moves that actor's rate, and with it the solved standings and an
    // already-published epoch certificate. The property this whole system
    // rests on is that a certificate still reproduces from the log afterwards.
    const base = [...world('al', 'bo'),
      post('al', 'P'),
      { t: 'assetCreate', author: 'u_bo', sym: 'TBTC', name: 'test unit', supply: 0.01 },
      { t: 'assetCreate', author: 'u_bo', sym: 'BYE', name: 'leaving soon', supply: 100 },
      like('bo', 'c1'),
      close(),
    ];
    const before = replay(base);
    const after = replay([...base, { t: 'deleteAccount', id: 'u_bo' }]);

    // the departed actor's own ledger is untouched: their acts still happened
    expect(after.ledgerById.u_bo.actCount).toBe(before.ledgerById.u_bo.actCount);
    expect(after.ledgerById.u_bo.burnBal).toBeCloseTo(before.ledgerById.u_bo.burnBal, 12);

    // nobody else's standing moves
    for (const id of Object.keys(before.xById)) {
      expect(after.xById[id]).toBeCloseTo(before.xById[id], 12);
    }
    // and the certificate still reproduces
    expect(after.epochHistory[0].stamp).toBeCloseTo(before.epochHistory[0].stamp, 12);
    expect(after.epochHistory[0].pass).toBe(before.epochHistory[0].pass);
  });
});

describe('the registration grant is a starter, not a stake', () => {
  it('gives a never-burned account no distribution weight at all', () => {
    // Measured before the fix: a fresh account sat at α̂ 9.47 against the
    // gate's 0.2 and out-weighed a burned, active user (λ 0.90 vs 0.65), so
    // twenty free registrations took 55.9% of an epoch from twenty real
    // participants. Registering hands out burn so a newcomer CAN act; that is
    // not evidence they committed anything.
    const acts: Record<string, unknown>[] = [{ t: 'seedWorld' },
      { t: 'register', id: 'u_atk', handle: 'atk', seed: 1, epoch: 0 },
      { t: 'btcBurn', id: 'u_atk', txid: 'abatkabatkabatkabatkabatkabatkabatkabatkffffffffffffffffffffffff', sats: 10000, addr: 'bc1qdead' },
      post('atk', 'mine'),
    ];
    for (let i = 0; i < 20; i++) {
      acts.push({ t: 'register', id: 'u_p' + i, handle: 'p' + i, seed: 1, epoch: 0 });
      acts.push(like('p' + i, 'c1'));
    }
    acts.push(close());
    const st = replay(acts);
    expect(st.tokens.dist[0].minted).toBe(0);
    expect(st.tokens.carry).toBe(5000);
  });

  it('still pays an account that actually burned', () => {
    const acts = [...world('al', 'bo'), post('al', 'P'), like('bo', 'c1'), close()];
    expect(replay(acts).tokens.bal.PEER.u_al).toBe(5000);
  });
});

