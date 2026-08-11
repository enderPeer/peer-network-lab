/**
 * Prender Markets: a bet, its parimutuel pool, and the elected jury that
 * certifies the answer.
 *
 * Three properties are asserted here rather than trusted, because all three
 * are the kind that fail silently:
 *
 * 1. Value is conserved. Every scenario below adds up what every account holds
 *    before and after settlement and demands the same total. An escrow that
 *    leaks pays somebody with money that was never staked; an escrow that
 *    keeps pays nobody at all, and neither shows up as an exception.
 * 2. The wall holds. Staking, standing for a seat, voting and certifying
 *    append no edge, compile no vouch and move no standing beyond the ordinary
 *    θ that any act costs. Being right about the future must buy nothing.
 * 3. Settlement is a pure function of the log. No clock is consulted, and a
 *    deletion cannot re-cut a market that already paid out — the defect class
 *    this project has paid for twice.
 */
import { describe, it, expect } from 'vitest';
import { replay, seed } from './helpers/world';

/** A proven Bitcoin burn — the only thing that weighs a jury ballot. */
function btcBurn(name: string, sats: number, nonce = 0) {
  const txid = (name + ':' + sats + ':' + nonce).padEnd(32, '0').split('')
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').slice(0, 64).padEnd(64, 'b');
  return { t: 'btcBurn', id: 'u_' + name, txid, sats, addr: 'bc1qdead' };
}

/**
 * Everyone registered, burned, and holding 1000 CHIP.
 *
 * CHIP is a minted asset rather than PEER because PEER only exists after an
 * epoch has been distributed, and a fixture that had to farm engagement first
 * would be testing the mint instead of the market.
 */
const START = 1000;
function table(...names: string[]) {
  const acts: Record<string, unknown>[] = [...seed('bank', ...names)];
  acts.push({ t: 'assetCreate', author: 'u_bank', sym: 'CHIP', name: 'table stakes', supply: 1e6 });
  for (const n of names) acts.push({ t: 'tokenSend', author: 'u_bank', sym: 'CHIP', to: 'u_' + n, amt: START });
  return acts;
}
const chips = (st: any, name: string): number => (st.tokens.bal.CHIP && st.tokens.bal.CHIP['u_' + name]) || 0;
/** What every player at the table holds, summed. The bank is excluded: it
 *  minted the supply, so its balance is the mirror of everyone else's. */
function purse(st: any, names: string[]): number {
  return +names.reduce((s, n) => s + chips(st, n), 0).toFixed(6);
}
/** What the market is still holding. Stakes and bonds leave a balance the
 *  moment they are made, so an open market's escrow is the difference between
 *  what the table holds and what it started with — and a settled one must be
 *  holding nothing at all. */
function escrow(st: any, cid: string): number {
  const m = st.markets[cid];
  if (!m || m.state !== 'open') return 0;
  return +Object.keys(m.cands).reduce((s, k) => s + m.cands[k], m.pool).toFixed(6);
}
/** Nothing minted, nothing lost: the table plus the escrow is the table. */
function conserved(st: any, names: string[], cid: string): number {
  return +(purse(st, names) + escrow(st, cid)).toFixed(6);
}

const ask = (who: string, opts: string[], over: Record<string, unknown> = {}) => ({
  t: 'market', author: 'u_' + who, text: 'will it?', opts,
  cur: 'CHIP', seats: 3, bond: 10, feeBp: 200, ...over,
});
const bet = (who: string, cid: string, opt: number, amt: number) =>
  ({ t: 'bet', author: 'u_' + who, cid, opt, amt });
const stand = (who: string, cid: string, on = true) => ({ t: 'modStand', author: 'u_' + who, cid, on });
const ballot = (who: string, cid: string, ...names: string[]) =>
  ({ t: 'modVote', author: 'u_' + who, cid, for: names.map((n) => 'u_' + n) });
const certify = (who: string, cid: string, opt: number) => ({ t: 'attest', author: 'u_' + who, cid, opt });
const callTime = (who: string, cid: string) => ({ t: 'marketVoid', author: 'u_' + who, cid });

/** al asks, bo and cy back it, dd/ee/ff stand for the three seats. */
function game(over: Record<string, unknown> = {}) {
  const players = ['al', 'bo', 'cy', 'dd', 'ee', 'ff'];
  const acts = [...table(...players),
    ask('al', ['yes', 'no'], over),
  ];
  const cid = 'c1'; // the first content node this log mints
  acts.push(
    bet('bo', cid, 0, 100),
    bet('cy', cid, 1, 300),
    stand('dd', cid), stand('ee', cid), stand('ff', cid),
  );
  return { acts, cid, players };
}

describe('a bet is content, and its market hangs off the node', () => {
  it('mints a Content node the ordinary way, so comments and reactions land on it', () => {
    const st: any = replay([...table('al', 'bo'), ask('al', ['yes', 'no']),
      { t: 'review', author: 'u_bo', target: 'c1', e: 0.7, f: 0.8, text: 'good question' }]);
    expect(st.g.nodes.get('c1').kind).toBe('Content');
    expect(st.creators.c1).toBe('u_al');
    expect(st.postMeta.c1.market).toBe(true);
    expect(st.markets.c1.n).toBe(2);
    expect(st.markets.c1.state).toBe('open');
    // the comment minted its own node against the bet, like any other post
    expect(st.payloads.c2).toBe('good question');
  });

  it('refuses more than seven answers, and an even jury', () => {
    const eight = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const st: any = replay([...table('al'), ask('al', eight)]);
    // The node is still minted — content ids may never depend on validation —
    // but no market opened on it.
    expect(st.g.nodes.get('c1')).toBeTruthy();
    expect(st.markets.c1).toBeUndefined();
    const seven: any = replay([...table('al'), ask('al', eight.slice(0, 7))]);
    expect(seven.markets.c1.n).toBe(7);
    const even: any = replay([...table('al'), ask('al', ['y', 'n'], { seats: 4 })]);
    expect(even.markets.c1).toBeUndefined();
    const greedy: any = replay([...table('al'), ask('al', ['y', 'n'], { feeBp: 501 })]);
    expect(greedy.markets.c1).toBeUndefined();
  });
});

describe('settlement', () => {
  it('pays the backers of the certified answer, pro rata, minus the fee', () => {
    const { acts, cid, players } = game();
    const st: any = replay([...acts,
      ballot('bo', cid, 'dd', 'ee', 'ff'),
      certify('dd', cid, 1), certify('ee', cid, 1),   // 2 of 3 — resolved here
    ]);
    const m = st.markets[cid];
    expect(m.state).toBe('resolved');
    expect(m.outcome).toBe(1);
    expect(m.pool).toBe(400);
    expect(m.feePaid).toBe(8);                        // 2% of 400

    expect(chips(st, 'cy')).toBe(START - 300 + 392);  // 400 − 8 fee, all of it
    expect(chips(st, 'bo')).toBe(START - 100);        // backed the other answer
    expect(chips(st, 'al')).toBe(START + 4);          // half the fee to the author
    expect(chips(st, 'dd')).toBe(START + 2);          // bond back + a quarter of the fee
    expect(chips(st, 'ee')).toBe(START + 2);
    expect(chips(st, 'ff')).toBe(START);              // silent: bond back, no fee
    expect(conserved(st, players, cid)).toBe(START * players.length);
  });

  it('strikes the bond of a moderator who certified against the jury, into the winners’ pool', () => {
    const { acts, cid, players } = game();
    const st: any = replay([...acts,
      certify('dd', cid, 1), certify('ff', cid, 0), certify('ee', cid, 1),
    ]);
    const m = st.markets[cid];
    expect(m.outcome).toBe(1);
    expect(m.guilty).toEqual(['u_ff']);
    expect(m.slashedTotal).toBe(10);
    expect(m.struck.u_ff).toBe(10);

    expect(chips(st, 'ff')).toBe(START - 10);         // the bond is gone
    expect(chips(st, 'cy')).toBe(START - 300 + 402);  // 400 − 8 + the struck 10
    expect(chips(st, 'dd')).toBe(START + 2);
    expect(chips(st, 'al')).toBe(START + 4);
    expect(conserved(st, players, cid)).toBe(START * players.length);
  });

  it('returns every stake in full when the certified answer had no backers', () => {
    const players = ['al', 'bo', 'dd', 'ee', 'ff'];
    const cid = 'c1';
    const st: any = replay([...table(...players), ask('al', ['yes', 'no']),
      bet('bo', cid, 0, 100),
      stand('dd', cid), stand('ee', cid), stand('ff', cid),
      certify('dd', cid, 1), certify('ee', cid, 1),
    ]);
    expect(st.markets[cid].outcome).toBe(1);
    expect(st.markets[cid].feePaid).toBe(0);          // nobody was right; the house takes nothing
    expect(chips(st, 'bo')).toBe(START);
    expect(chips(st, 'al')).toBe(START);
    expect(conserved(st, players, cid)).toBe(START * players.length);
  });

  it('a majority certifying “void” returns the stakes and pays no fee', () => {
    const { acts, cid, players } = game();
    const st: any = replay([...acts, certify('dd', cid, -1), certify('ee', cid, -1)]);
    expect(st.markets[cid].state).toBe('void');
    expect(chips(st, 'bo')).toBe(START);
    expect(chips(st, 'cy')).toBe(START);
    expect(chips(st, 'dd')).toBe(START);              // certified, so the bond comes back
    expect(conserved(st, players, cid)).toBe(START * players.length);
  });

  it('calling time on a silent jury refunds everyone and strikes the seats that never spoke', () => {
    const { acts, cid, players } = game();
    const st: any = replay([...acts, callTime('bo', cid)]);
    const m = st.markets[cid];
    expect(m.state).toBe('void');
    expect(m.guilty.sort()).toEqual(['u_dd', 'u_ee', 'u_ff']);
    expect(m.slashedTotal).toBe(30);
    // stakes back in full, plus the struck bonds spread across them pro rata
    expect(chips(st, 'bo')).toBe(START + 7.5);        // 100/400 of 30
    expect(chips(st, 'cy')).toBe(START + 22.5);       // 300/400 of 30
    expect(chips(st, 'dd')).toBe(START - 10);
    expect(conserved(st, players, cid)).toBe(START * players.length);
  });

  it('a seat that certified before the deadline keeps its bond when the market voids', () => {
    const { acts, cid, players } = game();
    const st: any = replay([...acts, certify('dd', cid, 0), callTime('bo', cid)]);
    expect(st.markets[cid].guilty.sort()).toEqual(['u_ee', 'u_ff']);
    expect(chips(st, 'dd')).toBe(START);
    expect(chips(st, 'ee')).toBe(START - 10);
    expect(conserved(st, players, cid)).toBe(START * players.length);
  });

  it('settles once and never again', () => {
    const { acts, cid, players } = game();
    const st: any = replay([...acts,
      certify('dd', cid, 1), certify('ee', cid, 1),
      certify('ff', cid, 1),                          // too late to be paid
      callTime('bo', cid),                            // and nothing left to void
      bet('bo', cid, 0, 50),                          // and nothing left to back
    ]);
    expect(st.markets[cid].state).toBe('resolved');
    expect(st.markets[cid].pool).toBe(400);
    expect(chips(st, 'ff')).toBe(START);              // its bond, and not a chip more
    expect(chips(st, 'bo')).toBe(START - 100);
    expect(conserved(st, players, cid)).toBe(START * players.length);
  });
});

describe('the jury is elected, and the election is decided by destroyed value', () => {
  const cid = 'c1';
  /** One seat, two candidates who have both bonded. */
  const race = [...table('al', 'bo', 'dd', 'ee'),
    ask('al', ['yes', 'no'], { seats: 1 }), stand('dd', cid), stand('ee', cid)];
  /** Registered and burned for exactly `sats` and nothing else. seed() burns a
   *  uniform 30,000 for everyone, which would drown the quantity under test. */
  const lean = (name: string, sats: number) =>
    [{ t: 'register', id: 'u_' + name, handle: name, seed: 1, epoch: 0 }, btcBurn(name, sats, 7)];

  it('seats the candidate the community weighed behind, and refuses the loser’s certificate', () => {
    const elected = [...race, ballot('bo', cid, 'ee')];
    const st: any = replay(elected);
    expect(st.marketSeats(st.markets[cid]).seated).toEqual(['u_ee']);
    const loser: any = replay([...elected, certify('dd', cid, 0)]);
    expect(loser.markets[cid].state).toBe('open');     // dd holds no seat: nothing happened
    expect(loser.marketActError({ t: 'attest', author: 'u_dd', cid, opt: 0 })).toMatch(/holds no seat/);
    const seated: any = replay([...elected, certify('ee', cid, 0)]);
    expect(seated.markets[cid].state).toBe('resolved');
  });

  it('a stake split across puppets weighs exactly what one account holding it weighs', () => {
    const one: any = replay([...race, ...lean('w1', 8000), ballot('w1', cid, 'dd')]);
    const many: any = replay([...race,
      ...lean('p1', 2000), ...lean('p2', 2000), ...lean('p3', 2000), ...lean('p4', 2000),
      ballot('p1', cid, 'dd'), ballot('p2', cid, 'dd'), ballot('p3', cid, 'dd'), ballot('p4', cid, 'dd')]);
    expect(one.marketSeats(one.markets[cid]).weight['u_dd']).toBe(8000);
    expect(many.marketSeats(many.markets[cid]).weight['u_dd']).toBe(8000);
  });

  it('an account that never burned cannot weigh a jury at all', () => {
    // Two fences, and the outer one catches first: registering opens a handle
    // at exactly zero, so a swarm that burned nothing cannot even afford the
    // θ a ballot costs. The weight check behind it is for foreign logs, where
    // an account might carry reserve from a rule this host no longer runs.
    const st: any = replay([...race,
      { t: 'register', id: 'u_ghost', handle: 'ghost', seed: 1, epoch: 0 },
      ballot('ghost', cid, 'dd')]);
    expect(st.markets[cid].votes['u_ghost']).toBeUndefined();
    expect(st.marketActError({ t: 'modVote', author: 'u_ghost', cid, for: ['u_dd'] }))
      .toMatch(/not enough energy/);
    const seatedAnyway: any = replay([...race, ...lean('w1', 5000), ballot('w1', cid, 'dd')]);
    expect(seatedAnyway.marketSeats(seatedAnyway.markets[cid]).weight['u_dd']).toBe(5000);
  });

  it('nobody votes themselves onto a jury', () => {
    const cid = 'c1';
    const st: any = replay([...table('al', 'dd', 'ee', 'bo'),
      ask('al', ['y', 'n'], { seats: 1 }),
      stand('dd', cid), stand('ee', cid),
      ballot('dd', cid, 'dd'),                        // refused whole
      ballot('bo', cid, 'ee')]);
    expect(st.markets[cid].votes['u_dd']).toBeUndefined();
    expect(st.marketSeats(st.markets[cid]).seated).toEqual(['u_ee']);
  });

  it('a later ballot replaces the earlier one, so a seat can be recalled without new machinery', () => {
    const first: any = replay([...race, ballot('bo', cid, 'dd')]);
    expect(first.marketSeats(first.markets[cid]).seated).toEqual(['u_dd']);
    const recalled: any = replay([...race, ballot('bo', cid, 'dd'), ballot('bo', cid, 'ee')]);
    expect(recalled.marketSeats(recalled.markets[cid]).seated).toEqual(['u_ee']);
  });

  it('standing down returns the bond in full and vacates the seat', () => {
    const st: any = replay([...race, ballot('bo', cid, 'dd'), stand('dd', cid, false)]);
    expect(chips(st, 'dd')).toBe(START);
    expect(st.marketSeats(st.markets[cid]).seated).toEqual(['u_ee']);
  });
});

describe('who may do what', () => {
  const cid = 'c1';
  const err = (st: any, act: Record<string, unknown>) => st.marketActError({ ...act, cid });

  it('refuses the author a position, and a moderator a position', () => {
    const st: any = replay([...table('al', 'bo', 'dd'), ask('al', ['y', 'n']), stand('dd', cid)]);
    expect(err(st, { t: 'bet', author: 'u_al', opt: 0, amt: 10 })).toMatch(/author of a bet does not hold a position/);
    expect(err(st, { t: 'bet', author: 'u_dd', opt: 0, amt: 10 })).toMatch(/moderator cannot back an answer/);
    expect(err(st, { t: 'bet', author: 'u_bo', opt: 0, amt: 10 })).toBeNull();
  });

  it('refuses a seat to the author, and to anyone holding a position', () => {
    const st: any = replay([...table('al', 'bo'), ask('al', ['y', 'n']), bet('bo', cid, 0, 10)]);
    expect(err(st, { t: 'modStand', author: 'u_al' })).toMatch(/cannot also certify/);
    expect(err(st, { t: 'modStand', author: 'u_bo' })).toMatch(/hold a position/);
  });

  it('refuses a second certificate from the same seat — that is what the bond secures', () => {
    const st: any = replay([...table('al', 'dd', 'ee', 'ff'), ask('al', ['y', 'n']),
      stand('dd', cid), stand('ee', cid), stand('ff', cid), certify('dd', cid, 0)]);
    expect(err(st, { t: 'attest', author: 'u_dd', opt: 1 })).toMatch(/already certified/);
    expect(err(st, { t: 'attest', author: 'u_ee', opt: 1 })).toBeNull();
  });

  it('refuses a stake bigger than the balance, and an answer that does not exist', () => {
    const st: any = replay([...table('al', 'bo'), ask('al', ['y', 'n'])]);
    expect(err(st, { t: 'bet', author: 'u_bo', opt: 0, amt: START + 1 })).toMatch(/balance is/);
    expect(err(st, { t: 'bet', author: 'u_bo', opt: 2, amt: 1 })).toMatch(/no answer 2/);
    expect(err(st, { t: 'bet', author: 'u_bo', opt: 0, amt: -5 })).toMatch(/must be positive/);
  });

  it('refuses a ballot naming more candidates than there are seats', () => {
    const st: any = replay([...table('al', 'bo', 'dd', 'ee'), ask('al', ['y', 'n'], { seats: 1 }),
      stand('dd', cid), stand('ee', cid)]);
    expect(err(st, { t: 'modVote', author: 'u_bo', for: ['u_dd', 'u_ee'] })).toMatch(/at most that many/);
    expect(err(st, { t: 'modVote', author: 'u_bo', for: ['u_dd'] })).toBeNull();
  });

  it('takes exactly what it records, to the micro-token', () => {
    // A stake finer than the record can hold used to be debited in full and
    // recorded rounded. The difference was escrow no payout branch could reach.
    const cid = 'c1';
    const players = ['al', 'bo', 'dd'];
    const acts = [...table(...players), ask('al', ['y', 'n'], { seats: 1 }),
      bet('bo', cid, 0, 10.00000049), stand('dd', cid)];
    const st: any = replay(acts);
    expect(st.markets[cid].pool).toBe(10);              // floored, never rounded up
    expect(chips(st, 'bo')).toBe(START - 10);           // and the debit agrees
    expect(conserved(st, players, cid)).toBe(START * players.length);
    // Below one micro-token there is nothing to record, and it is refused
    // rather than swallowed.
    expect(st.marketActError({ t: 'bet', author: 'u_bo', cid, opt: 0, amt: 1e-9 }))
      .toMatch(/smallest stake/);
    const settled: any = replay([...acts, certify('dd', cid, 0)]);
    expect(chips(settled, 'bo')).toBe(START - 10 + 9.8); // 10 back less the 2% fee
    expect(conserved(settled, players, cid)).toBe(START * players.length);
  });

  it('skips a hand-edited act whole, leaving no half-applied balance and no NaN', () => {
    const { acts, cid: c, players } = game();
    const st: any = replay([...acts,
      { t: 'bet', author: 'u_bo', cid: c, opt: 0, amt: Infinity },
      { t: 'bet', author: 'u_bo', cid: c, opt: 0, amt: -1e9 },
      { t: 'bet', author: 'u_nobody', cid: c, opt: 0, amt: 1 },
      { t: 'bet', author: 'u_bo', cid: 'c99', opt: 0, amt: 1 },
      { t: 'attest', author: 'u_bo', cid: c, opt: 0 },
      { t: 'modVote', author: 'u_bo', cid: c, for: ['u_nobody'] },
    ]);
    expect(st.markets[c].pool).toBe(400);
    expect(Number.isFinite(chips(st, 'bo'))).toBe(true);
    expect(chips(st, 'bo')).toBe(START - 100);
    expect(conserved(st, players, cid)).toBe(START * players.length);
  });
});

describe('the wall between a bet and a reputation', () => {
  it('staking, standing, voting and certifying append no edge and compile no vouch', () => {
    const { acts, cid } = game();
    // The market act itself is a Publish like any post — that is the point of
    // it being content. Everything hanging off it must add nothing.
    const bare = [...table('al', 'bo', 'cy', 'dd', 'ee', 'ff'), ask('al', ['yes', 'no'])];
    const full = [...acts, ballot('bo', cid, 'dd', 'ee', 'ff'),
      certify('dd', cid, 1), certify('ee', cid, 1)];
    const a: any = replay(bare), b: any = replay(full);
    expect(b.g.edges.length).toBe(a.g.edges.length);
    expect(Object.keys(b.bundles).sort()).toEqual(Object.keys(a.bundles).sort());
    for (const k of Object.keys(a.bundles)) {
      expect(b.bundles[k].pd).toBe(a.bundles[k].pd);
      expect(b.bundles[k].pi).toBe(a.bundles[k].pi);
    }
  });

  it('winning a pool outranks nobody — only the θ of having acted moves', () => {
    const cid = 'c1';
    const rich = [...table('al', 'bo', 'cy', 'dd', 'ee', 'ff'), ask('al', ['yes', 'no']),
      bet('cy', cid, 1, 300), bet('bo', cid, 0, 100),
      stand('dd', cid), stand('ee', cid), stand('ff', cid),
      certify('dd', cid, 1), certify('ee', cid, 1)];
    // cy spent two acts: the stake, and one ballot. The control spends two
    // acts on nothing at all.
    const poor = [...table('al', 'bo', 'cy', 'dd', 'ee', 'ff'), ask('al', ['yes', 'no']),
      { t: 'follow', from: 'u_cy', to: 'u_bo', on: true },
      bet('cy', cid, 1, 1)];
    const a: any = replay(rich), b: any = replay(poor);
    expect(chips(a, 'cy')).toBeGreaterThan(START);       // cy is up on the day
    expect(a.xById.u_cy).toBe(b.xById.u_cy);             // and it bought no standing
  });
});

describe('purity', () => {
  it('deleting the bet redacts the question and pays out exactly the same', () => {
    const { acts, cid, players } = game();
    const tail = [ballot('bo', cid, 'dd', 'ee', 'ff'), certify('dd', cid, 1), certify('ee', cid, 1)];
    const kept: any = replay([...acts, ...tail]);
    // Deletion in this replay is retroactive and driven by the tombstone's
    // target index. The market act is the one right after the funding acts.
    const mIdx = acts.findIndex((a: any) => a.t === 'market');
    const gone: any = replay([...acts, ...tail, { t: 'deletePost', author: 'u_al', target: mIdx }]);
    expect(gone.payloads[cid]).toBeUndefined();          // the question is gone
    expect(gone.markets[cid].state).toBe('resolved');    // the settlement is not
    expect(gone.markets[cid].outcome).toBe(1);
    for (const n of players) expect(chips(gone, n)).toBe(chips(kept, n));
  });

  it('replays to the same numbers twice, with no clock in the answer', () => {
    const { acts, cid, players } = game();
    const log = [...acts, certify('dd', cid, 1), certify('ff', cid, 0), certify('ee', cid, 1)];
    const one: any = replay(log), two: any = replay(log);
    for (const n of players) expect(chips(one, n)).toBe(chips(two, n));
    expect(one.markets[cid].feePaid).toBe(two.markets[cid].feePaid);
    expect(one.markets[cid].guilty).toEqual(two.markets[cid].guilty);
  });
});
