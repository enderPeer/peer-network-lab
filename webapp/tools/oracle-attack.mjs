// The oracle attack on the PEER door, run against the real price reader.
//
//   node tools/oracle-attack.mjs
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT. The code under test is
// chain-l2/onchain.mjs — poolTwap, the thing that decides what a burn is
// worth — driven through a fake JSON-RPC endpoint on localhost that serves a
// scripted pool history. The pool CONTRACT is not under test and is not run
// here: reserves are moved by the constant-product identity directly, because
// what is being asked is "what does the reader make of a pool that moved",
// not "does PeerPool swap correctly", which has its own tests. Nothing here
// touches Base, and nothing here signs anything.
//
// THE ATTACK. Constant-product price is whatever the last trade left behind.
// An attacker with cbBTC can push the pool's price of PEER up by a factor k
// by adding ΔB = B·(√k − 1) satoshis, burn PEER at the inflated rate, and take
// it straight back out — the capital returns, only the swap fee is spent. On a
// 0.3%-per-leg pool a round trip costs about 0.6% of ΔB. What that buys, here,
// is the one thing this network says cannot be bought.
//
// WHY THE WINDOW ALONE DID NOT STOP IT. The host cannot read nine hundred
// blocks per burn, so it samples sixteen. The first version chose those
// sixteen by arithmetic — floor(ref/stride)·stride, counting back — and the
// attacker chooses the block their own burn lands in, so they knew every block
// that would be read. Sixteen pump-and-dumps, one per sampled block, and the
// "thirty-minute average" was fully manipulated while the pool stood at its
// true price for the other 98.6% of the window.
//
// WHAT CHANGED. The sampled blocks now come from the ENGINE's peerBurnGrid,
// seeded by the hash of the block the window ends at — a number that does not
// exist until that block does. The attacker can still hold a false price, but
// they have to HOLD it: a lie that covers a fraction f of the window is
// sampled about f of the time. This tool runs both rules against the same
// endpoint and prints what each costs and what each buys.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── the fake chain ────────────────────────────────────────────────────────
const CHAIN_ID = 8453;
const TOKEN = '0x5d63786095d09210011fd382c0710a7a1bc90e6f';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
/** THE pool. One address, no factory above it and no id inside it — which is
 *  also why this file no longer stages a pool id that has to match. */
const POOL = '0x4444444444444444444444444444444444444444';
const E18 = 10n ** 18n;
const BLOCK0 = 30_000_000;
const HEAD = BLOCK0 + 2000;
const MS_PER_BLOCK = 2000;
const T0 = Date.now();

/** The pool at rest: 100,000 PEER against 0.01 cbBTC — exactly the minimum
 *  depth the engine will price against, which is the attacker's best case. */
const REST = { peer: 100_000n * E18, btc: 1_000_000n };
/** How far the attacker pushes the price of PEER, in multiples. */
const PUMP = 100n;

/** Reserves while the price is pushed ×k: rb' = rb·√k, rp' = k/rb'. */
function pumped(rest, k) {
  const root = BigInt(Math.round(Math.sqrt(Number(k))));
  const btc = rest.btc * root;
  const peer = (rest.peer * rest.btc) / btc;
  return { peer, btc };
}
const HIGH = pumped(REST, PUMP);

/** Which blocks the attacker is holding the false price at. Set per run. */
let held = new Set();
const blockHash = (n) => '0x' + createHash('sha256').update('block:' + n).digest('hex');
const blockMs = (n) => T0 + (n - HEAD) * MS_PER_BLOCK;
const poolAt = (n) => (held.has(n) ? HIGH : REST);

const hex = (n) => '0x' + n.toString(16);
const word = (v) => v.toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

let calls = 0;
function handle({ method, params = [] }) {
  calls++;
  if (method === 'eth_chainId') return hex(BigInt(CHAIN_ID));
  if (method === 'eth_blockNumber') return hex(BigInt(HEAD));
  if (method === 'eth_getBlockByNumber') {
    const tag = String(params[0]);
    const n = tag === 'latest' ? HEAD : Number(BigInt(tag));
    if (n > HEAD || n < 0) return null;
    return { number: hex(BigInt(n)), hash: blockHash(n), timestamp: hex(BigInt(Math.floor(blockMs(n) / 1000))) };
  }
  if (method === 'eth_call') {
    const p = params[0];
    const to = String(p.to).toLowerCase();
    const data = String(p.data).toLowerCase();
    const tag = String(params[1] ?? 'latest');
    const at = tag === 'latest' ? HEAD : Number(BigInt(tag));
    if (to === POOL.toLowerCase()) {
      if (data.startsWith('0x11cda415')) return '0x' + addrWord(TOKEN);   // peer()
      if (data.startsWith('0xa28d57d8')) return '0x' + addrWord(CBBTC);   // btc()
      if (data.startsWith('0x75172a8b')) {                                 // reserves()
        // Three words: resPeer, resBtc, totalShares. The reader cuts by
        // offset, so the order here is the contract's order or nothing.
        const r = poolAt(at);
        return '0x' + word(r.peer) + word(r.btc) + word(1000n);
      }
    }
    if (data.startsWith('0x313ce567')) return '0x' + word(to === CBBTC ? 8n : 18n);   // decimals()
    return '0x';
  }
  return null;
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    try {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: handle(parsed) }));
    } catch (e) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { message: String(e.message) } }));
    }
  });
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

process.env.PEER_L2_RPC = 'http://127.0.0.1:' + port;
process.env.PEER_L2_CHAIN_ID = String(CHAIN_ID);
process.env.PEER_TOKEN_ADDR = TOKEN;
process.env.PEER_BTC_ADDR = CBBTC;
process.env.PEER_POOL_ADDR = POOL;
process.env.PEER_PEERBURN_QUOTE_MEMO_MS = '0';

/**
 * A FRESH copy of the reader for every scenario.
 *
 * poolTwap keeps its readings in a module-level Map for the life of the
 * process, and it must not be allowed to carry one scenario's readings into
 * the next — that would measure the cache rather than the rule. (It is also
 * the bug this rebuild fixed inside poolTwap itself: the average used to be
 * taken over whatever that Map happened to hold rather than over the blocks
 * the grid named, so a host that had served quotes recently priced a burn
 * differently from one that had not.) A query string gives a new module
 * instance because ESM caches by URL.
 */
let freshN = 0;
const freshReader = () => import('../chain-l2/onchain.mjs?attack=' + (freshN++));

const engine = await import('../public/peer-engine.mjs');
const { create } = require('../social/replay.cjs');
const state = create(engine).replay([{ t: 'seedWorld' }]);
const LIM = state.peerBurn.limits;

// ── the two sampling rules ────────────────────────────────────────────────
//
// The one that shipped first, reconstructed exactly as it was — stride and
// anchor from public arithmetic — so the numbers below are a comparison and
// not a memory. Same signature as the engine's, so the same reader can be
// driven under either rule.
const SPAN_OVERSHOOT = 1.25;
function oldGrid(startsAt, endsAt, _refHash, n) {
  const spanBlocks = endsAt - startsAt;
  const stride = Math.max(1, Math.round(spanBlocks / (n - 1)));
  const anchor = Math.floor(endsAt / stride) * stride;
  const out = [];
  for (let i = 0; i < n; i++) { const b = anchor - stride * i; if (b >= 0) out.push(b); }
  return out.sort((a, b) => a - b);
}
const GRID_N = LIM.twapGrid;
const WINDOW_BLOCKS = Math.round((LIM.twapMs * SPAN_OVERSHOOT) / MS_PER_BLOCK);
const STARTS_AT = HEAD - WINDOW_BLOCKS;

/** What a burn of N PEER is worth against the reserves the reader recorded. */
function priceOf(amtPeer, twap) {
  const amt = amtPeer * E18;
  const sats = Number((amt * BigInt(twap.resBtcRaw)) / (BigInt(twap.resPeerRaw) + amt));
  return { sats, reserve: sats / LIM.satsPerReserve };
}
/** What the attacker spends to hold the price at `blocks.size` moments. */
function feeFor(rounds) {
  const dB = Number(REST.btc) * (Math.sqrt(Number(PUMP)) - 1);   // capital in, and out again
  const fee = 0.006 * dB;                                        // 0.3% a leg, both ways
  return { dB, perRound: fee, total: fee * rounds };
}
/** How much PEER it takes to fill one epoch's ceiling at a given price. */
function peerToFillCeiling(twap) {
  const rp = BigInt(twap.resPeerRaw), rb = BigInt(twap.resBtcRaw);
  const s = BigInt(LIM.satsPerEpoch);
  if (rb <= s) return null;
  return Number((s * rp) / (rb - s)) / 1e18;
}

async function run(label, blocks, ruleGrid) {
  held = new Set(blocks);
  calls = 0;
  const onchain = await freshReader();
  const twap = await onchain.poolTwap({
    windowMs: LIM.twapMs, minObs: LIM.twapObs, minPoolSats: LIM.minPoolSats,
    atBlock: HEAD, gridN: GRID_N,
    // The rule under test. `state.peerBurnGrid` is the shipped one, seeded by
    // the reference block's hash; `oldGrid` is the arithmetic one it replaced,
    // reconstructed so the two can be measured against the same endpoint.
    gridFn: ruleGrid || state.peerBurnGrid,
  });
  if (!twap.ok) return { label, refused: twap.code + ' — ' + twap.why };
  const hit = (twap.blocks || []).filter((b) => held.has(b)).length;
  return {
    label,
    read: twap.blocks.length,
    hit,
    resPeerRaw: twap.resPeerRaw,
    resBtcRaw: twap.resBtcRaw,
    price: priceOf(1000n, twap),
    fill: peerToFillCeiling(twap),
    twap,
  };
}

function line(r, cost) {
  if (r.refused) { console.log('    ' + r.label.padEnd(40) + 'REFUSED: ' + r.refused); return; }
  const pad = ' '.repeat(4);
  console.log(pad + r.label);
  console.log(pad + '  readings manipulated : ' + r.hit + ' of ' + r.read);
  console.log(pad + '  pool recorded as     : ' + (Number(r.resBtcRaw) / Number(REST.btc)).toFixed(2)
    + '× its true bitcoin side');
  console.log(pad + '  1000 PEER prices at  : ' + r.price.sats.toLocaleString('en-US') + ' sat = '
    + r.price.reserve.toFixed(2) + ' reserve   (true price: 9,900 sat = 99.00 reserve)');
  console.log(pad + '  PEER to fill a whole epoch ceiling: '
    + (r.fill === null ? 'n/a' : r.fill.toFixed(2)) + '   (true price: 1010.10)');
  console.log(pad + '  attacker pays        : ' + cost);
}

console.log('\nPEER door — oracle attack, measured against chain-l2/onchain.mjs');
console.log('pool at rest: ' + (Number(REST.peer / E18)).toLocaleString('en-US') + ' PEER / '
  + Number(REST.btc).toLocaleString('en-US') + ' sat — exactly the engine\'s minimum depth,');
console.log('              which is the attacker\'s best case, because anything thinner is refused.');
console.log('window: ' + (LIM.twapMs / 60000) + ' min ≈ ' + WINDOW_BLOCKS + ' blocks at '
  + MS_PER_BLOCK + ' ms · ' + GRID_N + ' blocks read · ceilings ' + LIM.reservePerEpoch
  + ' reserve per account per epoch, and one pool\'s own bitcoin side per epoch');
console.log('attacker pushes the price ×' + PUMP + ': '
  + Math.round(feeFor(1).dB).toLocaleString('en-US') + ' sat of capital, returned, and '
  + Math.round(feeFor(1).perRound).toLocaleString('en-US') + ' sat of fees per pump-and-dump\n');

console.log('[baseline] nobody is manipulating anything');
line(await run('honest window', []), 'nothing');

// THE ATTACK AS IT WORKED. The attacker computes the old arithmetic grid —
// public, and a function of the block they choose to burn in — and holds the
// false price at exactly those blocks and nowhere else.
const OLD = oldGrid(STARTS_AT, HEAD, null, GRID_N);
const OLD_PCT = (100 * OLD.length / WINDOW_BLOCKS).toFixed(2);
console.log('\n[a] THE OLD RULE: the price is pushed only at the ' + OLD.length
  + ' blocks the arithmetic grid selects');
console.log('    — ' + OLD_PCT + '% of the window, and every one of them known in advance');
line(await run('old arithmetic grid', OLD, oldGrid),
  Math.round(feeFor(OLD.length).total).toLocaleString('en-US') + ' sat ('
  + OLD.length + ' pump-and-dumps)');

// THE SAME MONEY, AGAINST THE SEEDED GRID. The attacker cannot know which
// blocks will be read; the old grid is as good a guess as any other.
console.log('\n[b] THE SHIPPED RULE: the same spend, the same blocks pushed, blocks chosen by block hash');
line(await run('hash-seeded grid, same 16 blocks pushed', OLD),
  Math.round(feeFor(OLD.length).total).toLocaleString('en-US') + ' sat, for nothing');

// WHAT IT NOW COSTS TO MOVE THE PRICE AT ALL: holding it. This is the honest
// shape of a time-weighted price — cost proportional to duration — and it is
// what the window always claimed and did not have.
console.log('\n[c] THE SHIPPED RULE: the price is HELD across a contiguous stretch of the window');
console.log('    (fees below are the two swaps that open and close the position. Holding a false');
console.log('     price against arbitrage for N blocks costs far more than that and is NOT modelled');
console.log('     here — every arbitrageur trades against the position for as long as it stands.)');
for (const frac of [0.25, 0.5, 1]) {
  const n = Math.round(WINDOW_BLOCKS * frac);
  const blocks = [];
  for (let i = 0; i < n; i++) blocks.push(HEAD - i);
  line(await run('held for ' + (frac * 100).toFixed(0) + '% of the window (' + n + ' blocks)', blocks),
    Math.round(feeFor(1).total).toLocaleString('en-US') + ' sat of fees, plus '
    + (n * MS_PER_BLOCK / 60000).toFixed(0) + ' minutes of arbitrage against the whole market');
}

// AND WHAT THE MANIPULATION BUYS EVEN IF SOMEBODY PAYS FOR ONE, which is the
// point of the two ceilings: bounded speech, for one account and for one pool.
console.log('\n[d] what a FULLY manipulated window buys, if somebody pays to hold it');
const full = await run('held across the whole window', (() => {
  const b = []; for (let i = 0; i < WINDOW_BLOCKS; i++) b.push(HEAD - i); return b;
})());
if (!full.refused) {
  console.log('    one account, one epoch : ' + LIM.reservePerEpoch + ' reserve — about '
    + Math.floor(LIM.reservePerEpoch / 0.0528066) + ' acts, and never a share of the epoch');
  console.log('                             mint and never a vote for the writer, at any price.');
  console.log('    that pool, one epoch   : '
    + (Number(full.resBtcRaw) / LIM.satsPerReserve).toLocaleString('en-US')
    + ' reserve across everybody — a pool cannot create more');
  console.log('                             reserve in an epoch than the bitcoin it is recorded holding.');
  console.log('    before that bound      : unbounded. 300 free handles filling the per-account');
  console.log('                             ceiling once made 27,100 reserve against this same pool,');
  console.log('                             and it scaled linearly with the number of handles.');
  console.log('    say the weakness       : that pool bound is the bitcoin side the act RECORDS, and a');
  console.log('                             manipulated window inflates the recorded side by the same');
  console.log('                             factor as the price — '
    + (Number(full.resBtcRaw) / Number(REST.btc)).toFixed(0) + '× here, so the bound rises from '
    + (Number(REST.btc) / LIM.satsPerReserve).toLocaleString('en-US'));
  console.log('                             to ' + (Number(full.resBtcRaw) / LIM.satsPerReserve).toLocaleString('en-US')
    + ' reserve. Replay cannot know the untampered depth — it asks no');
  console.log('                             chain anything — so what actually pays for that is holding');
  console.log('                             the false price across the whole window, which is [c].');
}

console.log('\nRPC calls to price one burn on a cold reader: ' + calls);
console.log('(' + GRID_N + ' blocks × a header and a reserves() read, plus the chain id, the pair and the'
  + ' block-time probe)\n');
server.close();
