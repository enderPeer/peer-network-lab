// Reading the real chain, with no dependencies and no keys.
//
// This module can only ever READ. There is no signing code here, no private
// key is accepted by any function, and nothing it does can move a coin — by
// construction, not by discipline. The host displays on-chain truth; moving
// value is done by people in their own wallets.
//
// No ABI encoder and no keccak library either: every call this network makes
// is a fixed 4-byte selector with at most two word-sized arguments, so the
// selectors are hardcoded constants below (each with the signature it came
// from, so anyone can recompute it) and an argument — an address or a
// uint256 — is just 32-byte left-padded hex. That is the whole encoder. The
// one event topic this file needs follows the same rule with all 32 bytes
// kept instead of the first four, and says under it how it was checked.
//
//   PEER_L2_RPC        JSON-RPC endpoint      (default Base mainnet)
//   PEER_L2_CHAIN_ID   expected chain id      (default 8453 = Base)
//   PEER_TOKEN_ADDR    the deployed PEER ERC-20
//   PEER_BTC_ADDR      the BTC-representing ERC-20 (cbBTC on Base). Worth
//                      setting even though nothing refuses to start without it:
//                      it is what the pool's own btc() is COMPARED against, and
//                      with it unset the only fence left is "that token answers
//                      8 decimals", which any 8-decimal token anybody minted
//                      also answers
//   PEER_POOL_ADDR     THE pool: the one PeerPool contract holding PEER + BTC.
//                      Unset means burning PEER for reserve is OFF and every
//                      route says so in words — with no pool there is no
//                      price, and a guessed price is an invented exchange rate
//                      for the right to speak
//   PEER_ANCHOR_ADDR   the PeerAnchor contract: epoch ids and earnings roots,
//                      timestamped by the chain
//   PEER_CLAIM_ADDR    the PeerClaim contract: epoch earnings, claimable as
//                      real PEER against a published merkle root
//   PEER_EPOCH_FROM_BLOCK  first block to scan for Anchored and EpochOpened
//                      (default 0)
//   PEER_PEERBURN_FROM_BLOCK  first block to scan for PEER burns (default 0)
//   PEER_PEERBURN_MIN_CONF    how deep a burn must be buried (default 30)
//
// ── WHAT ONE POOL DELETED FROM THIS FILE ───────────────────────────────────
// PeerPools.sol held MANY pools under human-chosen names, and this reader paid
// for that in defensive code. PeerPool.sol replaces it with one contract at
// one address, and the following are GONE rather than left inert — dead
// defensive code reads as a defence that is still running:
//
//   PEER_POOLS_ADDR, PEER_POOLS_FROM_BLOCK and the whole `namedPools` reader:
//     the chunked resumable PoolCreated log scan, the depth-ranked pre-filter
//     that decided which pools were worth an eth_call, the READ/LIST caps and
//     the truncation counters beside them, and server-data/pools-scan.json.
//     All of it existed because a LIST is censorable: 256 dust pools, a few
//     dollars of gas, and the operator's real pool falls off the end of
//     whatever a reader was willing to walk. One address has no discovery
//     problem — you either have it or you do not — so there is nothing to
//     enumerate, nothing to rank, and no cap to disclose.
//
//   PEER_PEERBURN_FACTORY and PEER_PEERBURN_POOL_ID: two variables that
//     existed only to answer "which pool is the official one" in a world where
//     a NAME could not answer it. PeerPools claimed names per creator, so
//     resolving the price source by name would have been an oracle attack
//     costing one transaction. The address IS the answer now, so the question
//     is gone with the variables. PEER_POOL_ADDR is the one place it is asked.
//
// Reading the pool is now one eth_call to reserves(). No logs, no cursor, no
// backfill, and nothing about the pool that a refused window could hide.
//
// The two epoch contracts are OFF until their addresses are set, and the
// answer says so in words rather than by leaving a key out: `anchors` and
// `claimState` come back as { configured: false, why: … }, because "this host
// reads no anchors" and "this network has never anchored anything" are
// opposite sentences and a missing key blurs them. Same rule as the token
// itself — an address baked into source is one nobody verified.
//
// This file writes files of its own, and none of them are on any chain: one
// scan memory per contract it discovers things from — which blocks it has
// already walked and what it saw in them — under the host's data directory:
//
//   server-data/anchor-scan.json   Anchored,    from PEER_ANCHOR_ADDR
//   server-data/claim-scan.json    EpochOpened, from PEER_CLAIM_ADDR
//   server-data/peerburn-scan.json Transfer to the dead address, from the token
//
// (server-data/pools-scan.json is no longer written or read. A host upgrading
// across this change can delete it; nothing here will ever look at it again.)
//
// They are caches, never sources of truth: delete any of them and the next
// refresh rebuilds it from the chain. They exist because without them every
// refresh re-walks a contract's entire history, which grows without bound.
// Reading the chain is still all this module can do — there is no signing code
// here and no function accepts a key.
//
// Nothing here has a default token address on purpose. An address baked into
// source is one nobody verified; if it is not configured, the feature is off
// and says so, exactly like proof-of-burn and paid placements.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC = (process.env.PEER_L2_RPC || 'https://mainnet.base.org').trim();
const CHAIN_ID = Number(process.env.PEER_L2_CHAIN_ID || 8453);
const clean = (a) => {
  const s = String(a || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : '';
};
export const TOKEN_ADDR = clean(process.env.PEER_TOKEN_ADDR);
export const BTC_ADDR = clean(process.env.PEER_BTC_ADDR);
export const ANCHOR_ADDR = clean(process.env.PEER_ANCHOR_ADDR);
export const CLAIM_ADDR = clean(process.env.PEER_CLAIM_ADDR);
export const L2_ON = !!TOKEN_ADDR;

// ── THE pool: one address, and nothing else to decide ──────────────────────
//
// A `peerBurn` is priced by ONE pool, and this is it. There is no id to pick,
// no name to resolve and no list to choose from — PeerPool.sol is a single
// market at a single address, so the address is the whole identity and a
// wrong one is wrong loudly (reserves() answers nothing) rather than by
// quietly pointing at somebody else's dust.
//
// It stays configuration rather than a constant for the reason nothing else
// here is baked in either: an address written into source is one nobody
// verified. Unset means this door is CLOSED and says so in words, which is
// still the shipped state — the pool has to be deployed and seeded before
// there is a price at all, and a host that guessed one would be inventing the
// exchange rate at which speech is sold.
//
// PEER_POOL_ADDR used to name a UniswapV2-style PAIR that tokenState read
// through getReserves(). That reading is gone with the variable's meaning:
// the network has its own pool now, the panel this fed is the pool panel, and
// two contracts behind one variable would be a display that is right about
// whichever one the operator happened to point at.
export const POOL_ADDR = clean(process.env.PEER_POOL_ADDR);
export const PEERBURN_ON = !!(TOKEN_ADDR && POOL_ADDR);
/**
 * How deep a Base transaction must be buried before a burn counts.
 *
 * Thirty blocks is about a minute at Base's two-second blocks. It is a CHOICE
 * about the price of speech, like every number in this door, and it is a
 * weaker one than it looks — say so rather than let the count imply Bitcoin's
 * meaning. Base is a rollup: its sequencer can reorganise unsafe blocks, and
 * the depth that actually settles a transaction is its inclusion on Ethereum,
 * which is minutes away, not blocks. What this threshold buys is protection
 * from the ordinary case (a transaction that is briefly visible and then is
 * not), not from a sequencer that decides otherwise. The burner's exposure is
 * bounded either way: an act filed for a transfer that later vanished would
 * be a claim anyone can check against the chain and see is false.
 */
export const PEERBURN_MIN_CONF = Math.max(1, Number(process.env.PEER_PEERBURN_MIN_CONF) || 30);

// Selectors: first 4 bytes of keccak256 of the signature in the comment.
// Hardcoded so this file needs no hashing library; recompute them yourself
// with `cast sig 'balanceOf(address)'` if you do not want to take them on
// trust — which you should not.
const SEL = {
  totalSupply: '0x18160ddd',  // totalSupply()
  balanceOf: '0x70a08231',    // balanceOf(address)
  decimals: '0x313ce567',     // decimals()
  symbol: '0x95d89b41',       // symbol()
  // PeerPool — values from the compiler's own methodIdentifiers table in
  // PeerPool.build.json, not recomputed here. tests/one-pool.test.ts calls the
  // compiled bytecode through that same table, so a selector that drifted from
  // the artifact fails there before it can fail here.
  reserves: '0x75172a8b',     // reserves()               — resPeer, resBtc, totalShares
  poolSharesOf: '0xf5eb42dc', // sharesOf(address)        — one holder's share units
  poolPeer: '0x11cda415',     // peer()                   — the pool's own PEER
  poolBtc: '0xa28d57d8',      // btc()                    — the pool's own BTC
  // PeerAnchor and PeerClaim — again the compiler's own methodIdentifiers
  // tables, in PeerAnchor.build.json and PeerClaim.build.json, copied rather
  // than recomputed. tests/epoch-onchain.test.ts calls the compiled bytecode
  // through those same tables, so a selector that drifted from the artifact
  // fails there before it can fail here.
  anchorOf: '0x75834a61',     // anchorOf(address,uint256)
  claimToken: '0xfc0c546a',   // token()                  — PeerClaim's immutable ERC-20
  steward: '0x637eea19',      // steward()                — PeerClaim's one privileged address
  epochInfo: '0x3894228e',    // epochInfo(uint256)
  claimed: '0x120aa877',      // claimed(uint256,address)
};

/**
 * The two epoch topics, by the same rule and checked the same two ways.
 *
 *   event Anchored(address indexed by, uint256 indexed epoch, bytes32 blockId,
 *                  bytes32 earningsRoot, uint64 at)
 *   hashed as: Anchored(address,uint256,bytes32,bytes32,uint64)
 *
 *   event EpochOpened(uint256 indexed epoch, bytes32 root, uint256 total,
 *                     uint64 claimUntil)
 *   hashed as: EpochOpened(uint256,bytes32,uint256,uint64)
 *
 * (`indexed` is not part of the string, and neither are the argument names.)
 *
 * First check: a from-scratch Keccak-256, written for this and thrown away,
 * which reproduced three things it was not given — the hash of the empty
 * string, the canonical ERC-20 Transfer topic (ddf252ad…), and all twenty-two
 * selectors solc emitted into PeerAnchor/PeerClaim/PeerPools.build.json —
 * before it was asked for these two.
 *
 * Second check, and the one that needs no trust at all: the compiled bytecode
 * itself under @ethereumjs/vm. anchor() put 86ec5f6e… in topics[0] with three
 * topics (signature, poster, epoch); openEpoch() put 545340447… there with
 * two (signature, epoch), and the PEER transfer it pulled in alongside carried
 * the canonical Transfer topic, which is a third thing nobody here chose.
 * tests/onchain-epoch-decode.test.ts pins both constants against exactly that
 * run, so this comment cannot quietly stop being true.
 *
 * A wrong topic is not an error message. It is an empty list that looks
 * exactly like a network that has never anchored an epoch.
 */
const TOPIC_ANCHORED = '0x86ec5f6efee73f1d5be0ac8a6f8bb4bba87bd4f8caf2edd1fd79943f42518077';
const TOPIC_EPOCH_OPENED = '0x545340447d4e1b1c96be9168286c525d0b7b3996b05be777a65d4d42dfe1d708';

/** Accepts 12345 or 0x3039; anything else is reported, never guessed at. */
function fromBlockOf(value) {
  const raw = String(value || '').trim();
  const ok = raw === '' || /^(0x[0-9a-f]+|[0-9]+)$/i.test(raw);
  return { raw, ok, hex: ok && raw ? '0x' + BigInt(raw).toString(16) : '0x0' };
}
// One from-block for both epoch contracts. They are deployed in the same
// sitting, minutes apart, and two variables here would be two chances to set
// the wrong one. The rule is err LOW: too low costs a little scanning, too
// high silently hides anchors and epochs opened before it. Each scan's memory
// is keyed to its own contract, so sharing the variable does not mix the two.
//
// The honest default is the whole chain — no block number is baked into this
// source for the same reason no address is: it would be a number nobody
// verified. Public RPCs cap how wide ONE log query may be (Base's answers
// 9,999 blocks and refuses 10,000), so the scan below is chunked into windows
// under that cap and walks forward across as many of them as it needs.
// Setting this to the deployment block does not switch anything on; it
// shortens the one-time backfill from "the whole chain" to "since these
// contracts existed", which is the difference between minutes and hours of
// catching up.
const EPOCH_FROM = fromBlockOf(process.env.PEER_EPOCH_FROM_BLOCK);
// The PEER burn scan walks the TOKEN's Transfer logs, so its from-block is the
// block the token was deployed in — a different contract from the two epoch
// contracts, hence a variable of its own rather than a third meaning bolted
// onto theirs. Same err-LOW rule as above:
// too low costs a little scanning, too high silently hides burns made before
// it, and a burn this scan never sees is reserve somebody destroyed PEER for
// and never got. Unset means block 0, which is correct and slow.
const PEERBURN_FROM = fromBlockOf(process.env.PEER_PEERBURN_FROM_BLOCK);

/**
 * Caps for the epoch contracts, and one more for the memory.
 *
 * ANCHOR_LIST_CAP is how many anchors come back, newest first. Nothing is read
 * per anchor — an Anchored log carries the whole row and the contract can
 * never revise it — so there is no read budget here, only a list length.
 *
 * ANCHOR_MEMORY is how many rows the scan file keeps. Anyone may anchor
 * anything, forever, so an unbounded memory is a file an attacker decides the
 * size of. The newest are kept because that is what the list shows.
 *
 * EPOCH_READ_CAP is how many recent epochs get an epochInfo call. Epoch
 * numbers come from the steward — openEpoch is the one privileged function —
 * so this list cannot be flooded by strangers the way the anchor list can, and
 * a small cap is enough. What each epoch OWES changes as people claim, so it
 * is read live every refresh and never taken from the opening log.
 *
 * CLAIM_ACCOUNT_CAP is how many `claimed(epoch, you)` questions one ?of=
 * request will spend. That path is outside the 30-second cache by design, so
 * it is one client's ability to spend this host's endpoint quota; capped, and
 * the answer says when it was.
 *
 * Every one of these is reported next to what it actually is — discovered,
 * returned, truncated — because a cap you cannot see is indistinguishable from
 * censorship.
 */
const ANCHOR_LIST_CAP = 32;
const ANCHOR_MEMORY = 400;
const EPOCH_READ_CAP = 12;
const CLAIM_ACCOUNT_CAP = 8;

/**
 * The scan's shape, and why each number is what it is.
 *
 * WINDOW is the width of one eth_getLogs. Base's public endpoint answers a
 * span of 9,999 blocks and refuses 10,000 with "eth_getLogs is limited to a
 * 10,000 range", so this sits one block under the refusal and every window is
 * a query the endpoint will actually serve. A single unchunked query from the
 * deploy block to 'latest' worked for exactly as long as the contract was
 * younger than 10,000 blocks — five and a half hours at Base's two-second
 * blocks — and then threw on every refresh forever, telling the operator to
 * set the variable they had already set correctly. That is a lesson paid for
 * on the pools scan, which no longer exists; it is kept because the three
 * scans that remain would have learned it the same way.
 *
 * WINDOW_CAP is how many of those windows ONE refresh will spend, so a host
 * pointed at block 0 of a chain thirty million blocks long does not hang the
 * first request for an hour. It gets through ~240k blocks per refresh (about
 * five days of Base) and remembers where it stopped, so the backfill finishes
 * across successive refreshes instead of inside one of them — and says how
 * far behind it still is while it does.
 *
 * REORG_REWIND is how far back a refresh starts from the block it last
 * scanned. The cursor is saved at the head we asked for, which may still be
 * reorganised out from under us; re-walking the last minute or two of blocks
 * costs one small window and makes a re-served log a duplicate (harmless — the
 * rows are a Map) rather than an anchor or a burn nobody ever sees.
 */
const WINDOW = 9_999;
const WINDOW_CAP = 24;
const REORG_REWIND = 64;

const here = dirname(fileURLToPath(import.meta.url));
// The host's data directory, resolved the way server.mjs and chain/*.mjs
// resolve it — PEER_DATA_DIR, else webapp/server-data — because a second
// convention for the same directory is a directory that ends up in two
// places. server-data is gitignored wholesale, so this file is too.
const DATA_DIR = resolve(process.env.PEER_DATA_DIR || join(here, '..', 'server-data'));
const SCAN_VERSION = 1;
/** One memory per contract walked. See the header for what each holds. The
 *  pool is not among them: it is read with one eth_call and has no history to
 *  remember. */
const ANCHOR_SCAN_FILE = join(DATA_DIR, 'anchor-scan.json');
const CLAIM_SCAN_FILE = join(DATA_DIR, 'claim-scan.json');
// Transfer, from PEER_TOKEN_ADDR, to the dead address — every PEER burn there
// has ever been. A cache like the other two: delete it and the next refresh
// re-walks the range from PEER_PEERBURN_FROM_BLOCK. What it must never become
// is the authority on which burn was already credited; that is the act log,
// and the credit path asks the log immediately before it writes.
const PEERBURN_SCAN_FILE = join(DATA_DIR, 'peerburn-scan.json');

/**
 * What a scan remembers between refreshes: the last block it walked, and the
 * rows it saw in that range.
 *
 * It is keyed to the chain, the CONTRACT and the from-block, and any
 * disagreement throws the whole thing away rather than mixing eras. A cursor
 * remembered for one contract is meaningless for another, and a from-block that
 * moved makes `fromBlock` in the answer a claim the remembered rows do not
 * support — better to pay one backfill than to report a range that was never
 * walked.
 *
 * The stored field is still called `factory`, which is what the pools scan
 * wrote before this file was shared with the epoch contracts and the burn
 * watcher. That scan is gone; the WORD stays, because renaming it to
 * `contract` would be tidier and would throw away every live host's anchor,
 * claim and burn memories on the deploy that landed it — three whole-chain
 * backfills per host to improve a word nobody reads.
 *
 * A missing file is the normal first run and says nothing. A file that exists
 * and will not parse DOES say something, so it is reported: silently starting
 * over would hide a data directory going bad.
 */
function loadScan(file, contract, from) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    return { lastScanned: null, ids: {}, note: e.code === 'ENOENT' ? null : 'could not read the remembered scan (' + String(e.message).slice(0, 60) + ') — starting from ' + from.hex };
  }
  try {
    const j = JSON.parse(raw);
    if (j && j.v === SCAN_VERSION && j.chainId === CHAIN_ID && j.factory === contract
        && j.fromBlock === from.hex && typeof j.lastScanned === 'string' && j.ids && typeof j.ids === 'object') {
      return { lastScanned: BigInt(j.lastScanned), ids: j.ids, note: null };
    }
    return { lastScanned: null, ids: {}, note: 'the remembered scan was for a different chain, factory or from-block — discarded, and this range is being walked again' };
  } catch {
    return { lastScanned: null, ids: {}, note: 'the remembered scan would not parse — discarded, and this range is being walked again' };
  }
}

/**
 * Save it, and say so if that failed rather than pretending it worked.
 *
 * Written to a temporary name and renamed, because a crash halfway through a
 * plain write leaves a truncated JSON file, and the next boot would read that
 * as "this contract has nothing in it" — a lie that looks exactly like an
 * empty network. If any of it fails the reader still answers: the file is an
 * optimisation, and losing it costs windows, never truth.
 */
function saveScan(file, contract, from, lastScanned, ids) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify({
      v: SCAN_VERSION,
      chainId: CHAIN_ID,
      factory: contract,
      fromBlock: from.hex,
      lastScanned: lastScanned.toString(),
      ids,
    }));
    renameSync(tmp, file);
    return null;
  } catch (e) {
    return String(e.message).slice(0, 80);
  }
}

/**
 * ONE chunked, resumable log scan, walked by every contract this module
 * discovers things from.
 *
 * There used to be exactly one of these and it lived inside the pools reader,
 * which was fine while pools were the only thing found by log. The moment a
 * second caller needed the same walk, copying it would have meant two window
 * chunkers, two cursors, two rewind rules and two ways to report a refused
 * window — and the pools one is the one that had already been wrong twice in
 * production (an unchunked query that died at 10,000 blocks; a cursor that
 * skipped past a refused window and left a permanent hole). Whatever is
 * learned about scanning is worth learning once. The pools reader is gone now;
 * everything it taught this helper stays, because the three callers below can
 * be wrong in exactly those two ways.
 *
 * The caller supplies only what differs: which contract, which topic, where to
 * start, how to revive a remembered row, and what to do with a log. The
 * window width, the per-refresh budget, the reorg rewind, the stop-at-the-
 * first-refusal rule and every field of the `scan` report are the same for
 * everyone.
 *
 * `topicsRest` narrows the query past topic0 — the indexed arguments, in
 * order, with null for "any". It exists for the PEER burn scan, which wants
 * ERC-20 Transfers to ONE recipient out of a token's entire transfer history:
 * asking the endpoint for the whole history and discarding 99% of it locally
 * is the same answer at a hundred times the bandwidth, and on a busy token it
 * is the difference between a window that serves and one that times out. The
 * two epoch scans pass nothing.
 *
 * Returns the rows (remembered ones already folded in, so a refused window
 * costs nothing that was learned earlier) and the `scan` block that says
 * plainly how much of the range this refresh actually covered.
 */
async function walkLogs({ file, contract, topic0, topicsRest, from, fromVar, revive, take }) {
  const scan = { windowSpan: WINDOW, windows: 0, failed: 0 };
  const remembered = loadScan(file, contract, from);
  if (remembered.note) scan.memory = remembered.note;

  // Everything the scan already knew, loaded BEFORE this refresh adds to it.
  // A window that fails below must cost us none of these: a row seen last
  // week is still a row, and dropping it because today's endpoint hiccuped
  // would make it vanish from the host for as long as the hiccup lasts.
  const rows = new Map();
  for (const [key, v] of Object.entries(remembered.ids)) {
    const row = revive(key, v);
    if (row) rows.set(key, row);
  }

  // 'latest' is pinned to a number once, up front. Left as the string, each
  // window would end at a different, moving head and the blocks that arrived
  // between two windows would fall in the gap.
  let head = null;
  let walked = remembered.lastScanned; // last block covered contiguously, or null
  try {
    head = BigInt(await rpc('eth_blockNumber', []));
    scan.head = '0x' + head.toString(16);
  } catch (e) {
    scan.failed = 1;
    scan.failedWhy = 'eth_blockNumber: ' + String(e.message).slice(0, 60);
  }
  if (head !== null) {
    const first = BigInt(from.hex);
    const rewound = remembered.lastScanned === null ? first : remembered.lastScanned - BigInt(REORG_REWIND) + 1n;
    let cursor = rewound > first ? rewound : first;
    scan.from = '0x' + cursor.toString(16);
    if (cursor > head) {
      // Nothing to walk, and the two ways that happens are not the same
      // sentence. A from-block past the tip is an operator's typo — the one
      // configuration where the scan does nothing and finds nothing, and it
      // must not read as an empty contract. A remembered cursor past the tip
      // means this endpoint is behind the one that filled the memory, which
      // is the endpoint's problem to catch up with, not a misconfiguration.
      scan.aheadOfHead = first > head
        ? fromVar + ' is ' + from.hex + ', past this chain’s head at ' + scan.head + ' — no range was walked, and an empty list here says nothing about the contract'
        : 'this endpoint’s head (' + scan.head + ') is behind the block this scan already walked — nothing new to read until it catches up';
    }
    while (cursor <= head && scan.windows < WINDOW_CAP) {
      const last = cursor + BigInt(WINDOW - 1) > head ? head : cursor + BigInt(WINDOW - 1);
      let lgs;
      try {
        lgs = await rpc(
          'eth_getLogs',
          [{
            address: contract,
            topics: [topic0, ...(Array.isArray(topicsRest) ? topicsRest : [])],
            fromBlock: '0x' + cursor.toString(16),
            toBlock: '0x' + last.toString(16),
          }],
          20_000,
        );
      } catch (e) {
        // Stop at the first refused window rather than skipping past it. A
        // skipped window is a permanent hole in the discovery that no later
        // refresh would ever revisit, because the cursor would have moved
        // beyond it — and a hole in this list is something the host will
        // never show anyone again. So the cursor stays put, the failure is
        // reported, and the next refresh tries the same window. The tradeoff
        // is plain: a window this endpoint can never serve wedges the scan
        // there, which is loud in `scan.failedAt` rather than silent.
        scan.failed++;
        scan.failedAt = '0x' + cursor.toString(16) + '..0x' + last.toString(16);
        scan.failedWhy = String(e.message).slice(0, 60);
        break;
      }
      scan.windows++;
      for (const lg of Array.isArray(lgs) ? lgs : []) take(lg, rows);
      walked = last;
      cursor = last + 1n;
    }
    scan.complete = scan.failed === 0 && walked !== null && walked >= head;
    if (!scan.complete) {
      const at = walked === null ? (cursor > head ? head : cursor) : walked;
      scan.behind = Number(head - at);
      if (!scan.aheadOfHead) {
        scan.backfill = scan.behind + ' blocks of history are still unwalked, so anything in them is not in this list yet — later refreshes continue from ' +
          (walked === null ? scan.from : '0x' + (walked + 1n).toString(16));
      }
    }
  }
  return { scan, rows, walked };
}

const pad = (addr) => String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const padUint = (v) => BigInt(v).toString(16).padStart(64, '0');

let rpcId = 1;
async function rpc(method, params, timeoutMs = 12_000) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('rpc ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('rpc: ' + (j.error.message || 'call failed'));
  return j.result;
}

const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

/** A 32-byte return word as a BigInt. Empty/`0x` means the call hit nothing. */
function word(hex, index = 0) {
  const body = String(hex || '').replace(/^0x/, '');
  if (body.length < 64 * (index + 1)) return null;
  return BigInt('0x' + body.slice(64 * index, 64 * (index + 1)));
}

/** A 32-byte word (a return word, or a log topic) as a 0x address — and null
 *  if the top 12 bytes are not zero, because a word that is not a left-padded
 *  address is not an address. Slicing the low 20 bytes off whatever came back
 *  would invent a contract that is not there, and this reader would then go
 *  ask it for decimals. */
function addrFromWord(hex, index = 0) {
  const body = String(hex || '').replace(/^0x/, '');
  const w = body.slice(64 * index, 64 * (index + 1));
  return /^0{24}[0-9a-f]{40}$/i.test(w) ? '0x' + w.slice(24).toLowerCase() : null;
}

/**
 * Is this endpoint on the chain this host claims? Asked by every exported
 * reader, not only by tokenState.
 *
 * It lived inside tokenState alone, and the result was a body that said "I
 * refuse to report this chain's numbers as this network's" with an account
 * balance — read from that same refused endpoint — attached underneath.
 * One answer, two opposite claims, and the number is the one a person reads.
 * A refusal that covers only the headline figures is not a refusal, so the
 * gate sits here, in front of all three readers, and costs one cheap call.
 */
async function chainCheck() {
  const seen = Number(BigInt(await rpc('eth_chainId', [])));
  return {
    seen,
    ok: seen === CHAIN_ID,
    error: 'the RPC answered for chain ' + seen + ', not ' + CHAIN_ID + ' — refusing to report its numbers as this network’s',
  };
}

/** decimals() with a stated fallback: display scaling only, and a token that
 *  will not answer must not take the whole report down with it. */
async function decimalsOf(addr, dflt) {
  if (!addr) return dflt;
  try {
    const d = word(await call(addr, SEL.decimals));
    return d === null ? dflt : Number(d);
  } catch {
    return dflt;
  }
}

/** Fixed-point BigInt -> Number, for display only. Never for arithmetic that
 *  decides anything: this is where precision goes to die, so the raw string
 *  is always carried alongside it. */
function human(v, dec) {
  if (v === null) return null;
  return Number(v) / Math.pow(10, dec);
}

/**
 * THE pool's three words, decoded, or a sentence saying why there are none.
 *
 *   reserves() -> resPeer, resBtc, totalShares
 *
 * Three static words, in that order, cut by offset — the order is written
 * down in PeerPool.sol beside the function, because nothing but that comment
 * tells this side where to cut. A SHORT answer is a pool this host could not
 * read, and it is reported as exactly that: "nothing answered" and "the pool
 * is empty" are opposite sentences, one a misconfiguration to fix and the
 * other an invitation to make the first deposit.
 *
 * All three zero IS a real state and says so: the contract exists and nobody
 * has seeded it. The first add() sets the opening price, so an unseeded pool
 * is not an error — it is the one state from which a price can still be
 * invented by whoever gets there first, and every caller of this is told
 * `seeded: false` rather than being handed a zero to divide by.
 */
async function readPool() {
  const out = { address: POOL_ADDR };
  // At the head, always. The historical reads the averaging window needs go
  // through callAt in the burn section, and they decode two of these three
  // words rather than all of them — keeping them separate is what stops a
  // display read from quietly becoming a price.
  const ret = await call(POOL_ADDR, SEL.reserves);
  const body = String(ret || '').replace(/^0x/, '');
  if (body.length < 64 * 3) {
    out.error = 'nothing at ' + POOL_ADDR + ' answered reserves() on chain ' + CHAIN_ID
      + ' — that address is not a PeerPool. This is a misconfiguration to fix, not a pool with nothing in it.';
    return out;
  }
  out.resPeerRaw = word(ret, 0).toString();
  out.resBtcRaw = word(ret, 1).toString();
  out.totalSharesRaw = word(ret, 2).toString();
  out.seeded = out.totalSharesRaw !== '0';
  return out;
}

/**
 * Everything the network wants to say about its token, in one round trip set.
 *
 * Returns null when nothing is configured, so callers can render "not
 * deployed yet" rather than inventing zeroes — a balance of 0 and "there is
 * no token" are very different sentences and the interface must not blur
 * them.
 */
export async function tokenState() {
  if (!L2_ON) return null;
  const out = { chainId: CHAIN_ID, rpc: RPC, token: TOKEN_ADDR, btc: BTC_ADDR || null };
  // The chain id is checked every time, cheaply. Pointing at the wrong
  // network and reading confident numbers off it is the failure that looks
  // most like success.
  const chain = await chainCheck();
  out.chainIdSeen = chain.seen;
  out.chainIdMatches = chain.ok;
  if (!chain.ok) {
    out.error = chain.error;
    return out;
  }
  const dec = Number(word(await call(TOKEN_ADDR, SEL.decimals)) ?? 18n);
  out.decimals = dec;
  const supply = word(await call(TOKEN_ADDR, SEL.totalSupply));
  out.totalSupplyRaw = supply === null ? null : supply.toString();
  out.totalSupply = human(supply, dec);
  if (supply === null) {
    out.error = 'no ERC-20 answered at ' + TOKEN_ADDR + ' on chain ' + CHAIN_ID;
    return out;
  }
  // THE pool: reserves(), plus the pool's own account of which two coins it
  // moves. This whole block used to be two — a UniswapV2 pair read through
  // getReserves, and a factory whose pools were discovered from logs, ranked by
  // depth and capped twice with the caps disclosed. One address needs none of
  // it.
  //
  // WHICH TOKENS, asked of the POOL and never taken from this host's env. The
  // decimals that scale every amount on the pools card must come from the same
  // two contracts a signed trade actually moves coins in, because that card
  // reads peer()/btc() off the pool for its approvals and its add: taking the
  // scaling from PEER_TOKEN_ADDR / PEER_BTC_ADDR while the transaction targets
  // the pool's own pair is a display that is wrong by a hundred million while
  // looking perfectly ordinary. checkPair is the reader that asks — already
  // written, already memoised per process — and this used to be the one path
  // that did not call it. The factory reader it replaced did; the check went
  // out with the factory and it was never the factory's.
  //
  // Fenced on its own so that a wrong or dead pool address degrades to an
  // error note under its own key and never takes the token report down with
  // it, and OFF says so in words rather than by leaving the key out: "this
  // host reads no pool" and "the pool is empty" are opposite sentences.
  if (POOL_ADDR) {
    try {
      const pair = await checkPair();
      const p = await readPool();
      out.pool = { ...p, tokens: { peer: pair.peer || null, btc: pair.btc || null } };
      out.pool.decimals = {
        // tokenState already asked TOKEN_ADDR for its decimals, and checkPair
        // asked the pool's own two tokens for theirs, so nothing here is asked
        // twice. 18 and 8 are the expected answers and never the assumed ones:
        // they are what a token that would not answer at all falls back to, and
        // that case is the one the mismatch/tokensNote lines above are for.
        peer: pair.peer && pair.peer !== TOKEN_ADDR ? (pair.peerDecimals == null ? 18 : pair.peerDecimals) : dec,
        btc: pair.btc ? (pair.btcDecimals == null ? 8 : pair.btcDecimals) : await decimalsOf(BTC_ADDR, 8),
      };
      // Where the pool's pair and this host's configuration disagree, that
      // sentence is reported and the CARD prints it first, above the wallet
      // row: it means every button below moves coins the operator did not mean
      // to serve. Nothing is hidden and nothing is disabled — this module
      // cannot know which of the two addresses is the wrong one, and the trades
      // are perfectly real either way — but nobody should approve a token
      // without having read it.
      if (pair.mismatch) out.pool.mismatch = pair.mismatch;
      else if (pair.note) out.pool.tokensNote = pair.note;
      if (p.seeded === false) {
        out.pool.note = 'this pool exists and nobody has added liquidity to it yet. The FIRST add sets the opening price — the two amounts deposited are the ratio, invented by whoever deposits them — and every add after that is proportional to what is already here.';
      }
    } catch (e) {
      out.pool = { address: POOL_ADDR, error: 'could not read the pool (' + String(e.message).slice(0, 60) + ')' };
    }
  } else {
    out.pool = {
      configured: false,
      why: 'PEER_POOL_ADDR is unset, so this host reads no pool. That is not a claim that none exists — an address baked into source is one nobody verified, so this stays off until an operator points it at a deployment they made themselves. With no pool there is no price, and burning PEER for reserve is off for the same reason.',
    };
  }
  // The epoch chain's two contracts, each fenced the same way and each saying
  // plainly when it is off. "This host reads no anchors" and "this network has
  // never anchored an epoch" are opposite claims, and an absent key would let
  // an interface render either one as the other.
  if (ANCHOR_ADDR) {
    try {
      out.anchors = await anchorState();
    } catch (e) {
      out.anchors = { contract: ANCHOR_ADDR, error: 'could not read the anchor contract (' + String(e.message).slice(0, 60) + ')' };
    }
  } else {
    out.anchors = {
      configured: false,
      why: 'PEER_ANCHOR_ADDR is unset, so this host reads no epoch anchors. That is not a claim that none exist — an address baked into source is one nobody verified, so this stays off until an operator points it at a deployment they made themselves.',
    };
  }
  if (CLAIM_ADDR) {
    try {
      out.claimState = await claimState();
    } catch (e) {
      out.claimState = { contract: CLAIM_ADDR, error: 'could not read the claim contract (' + String(e.message).slice(0, 60) + ')' };
    }
  } else {
    out.claimState = {
      configured: false,
      why: 'PEER_CLAIM_ADDR is unset, so no epoch earnings are claimable through this host. Epoch tokens still exist in the act log exactly as before; nothing about them is on a chain until a claim contract is deployed and funded.',
    };
  }
  return out;
}

/**
 * PeerAnchor: which epochs have been committed to on this chain, by whom, and
 * at what time the CHAIN says it happened.
 *
 * An anchor is two 32-byte words — a block id from chain/block.mjs and that
 * epoch's earnings root — timestamped in a place the poster cannot reach back
 * into. That is the whole of it, and this reader must not imply more. It does
 * not say the epoch was computed honestly, that the block is correct, or that
 * the poster is anybody in particular; it says THIS address committed to THESE
 * two words at THAT time. Truth still lives in replay of the public log.
 *
 * ANYONE MAY POST, by design (see PeerAnchor.sol), and that has a consequence
 * this list has to be honest about rather than paper over: unlike the pools
 * list there is no depth to rank by, so a stranger anchoring garbage every
 * block WOULD push real anchors out of a newest-first window. The answer is
 * not to invent an authority here — this module has no way to know whose key
 * matters — but to say what the list is: what was posted, newest first, capped
 * and counted. A reader who cares about one poster reads that poster's rows,
 * or asks the contract directly with anchorOf(poster, epoch); `posters` below
 * makes a flood visible instead of leaving it to be inferred from a list that
 * merely looks busy.
 *
 * Nothing is read back per anchor. The log carries every field, and the
 * contract can never revise a row — one anchor per (poster, epoch), forever —
 * so a remembered row is exactly as good as a freshly fetched one. That is the
 * opposite of the pools path, where reserves must be re-read every refresh
 * because they change; the difference is in the contracts, not in taste.
 */
async function anchorState() {
  const out = { contract: ANCHOR_ADDR };
  // Is this address a PeerAnchor at all? anchorOf() over an address/epoch
  // nobody could have anchored answers three zero words on the real contract
  // and nothing at all on a wallet or an unrelated contract. Same discipline
  // as reserves() above: "no anchors yet" and "wrong address" are different
  // sentences and an empty list must not be allowed to say both.
  let probe;
  try {
    probe = await call(ANCHOR_ADDR, SEL.anchorOf + pad('0x' + '0'.repeat(40)) + padUint(0));
  } catch (e) {
    probe = null;
    out.probeError = String(e.message).slice(0, 60);
  }
  if (String(probe || '').replace(/^0x/, '').length < 64 * 3) {
    out.error =
      'nothing at ' + ANCHOR_ADDR + ' answered anchorOf(address,uint256) on chain ' + CHAIN_ID +
      ' — that address is not a PeerAnchor contract. This is a misconfiguration to fix, not a network that has never anchored an epoch.';
    return out;
  }
  if (!EPOCH_FROM.ok) out.fromBlockIgnored = EPOCH_FROM.raw.slice(0, 40);
  out.fromBlock = EPOCH_FROM.hex;
  out.discoveredBy = 'Anchored logs — the contract publishes no list, and there is nothing to enumerate: rows are keyed by (poster, epoch) and only the log says which pairs exist';

  const { scan, rows, walked } = await walkLogs({
    file: ANCHOR_SCAN_FILE,
    contract: ANCHOR_ADDR,
    topic0: TOPIC_ANCHORED,
    from: EPOCH_FROM,
    fromVar: 'PEER_EPOCH_FROM_BLOCK',
    // Stored as it will be reported: an anchor is immutable, so the memory is
    // the answer rather than a hint about where to look for it.
    revive: (key, v) => {
      const cut = key.indexOf(':');
      if (cut < 0 || !v || typeof v.b !== 'string' || typeof v.r !== 'string') return null;
      const by = clean(key.slice(0, cut));
      const epoch = key.slice(cut + 1);
      if (!by || !/^[0-9]+$/.test(epoch)) return null;
      return { by, epoch, blockId: v.b, earningsRoot: v.r, at: Number(v.at) || 0, tx: typeof v.tx === 'string' ? v.tx : null, blk: Number(v.blk) || 0 };
    },
    take: (lg, map) => {
      const topics = lg && Array.isArray(lg.topics) ? lg.topics : [];
      if (topics.length < 3) return;
      const by = addrFromWord(topics[1]); // topic1 = the indexed poster
      const epoch = word(topics[2]);      // topic2 = the indexed epoch
      if (!by || epoch === null) return;
      const data = String(lg.data || '').replace(/^0x/, '');
      // blockId, earningsRoot, at — three static words. A short body is a log
      // this reader does not understand, and half-decoding it would put an
      // invented hash next to a real timestamp.
      if (data.length < 64 * 3) return;
      map.set(by + ':' + epoch.toString(), {
        by,
        // The epoch as a DECIMAL STRING, never a Number. Pool ids come from a
        // factory counting upwards; an epoch number here is whatever a
        // stranger typed, and 2^255 rounded through a float would print a
        // number nobody anchored.
        epoch: epoch.toString(),
        // Bare lowercase hex, no 0x — exactly how chain/block.mjs writes a
        // block id and chain/merkle.mjs a root, so checking an anchor against
        // the log is a string comparison and not a de-prefixing exercise.
        blockId: data.slice(0, 64),
        earningsRoot: data.slice(64, 128),
        // The chain's own second, taken from the event rather than from any
        // clock here. uint64 seconds is comfortably inside a JS integer.
        at: Number(BigInt('0x' + data.slice(128, 192))),
        tx: typeof lg.transactionHash === 'string' ? lg.transactionHash : null,
        blk: typeof lg.blockNumber === 'string' ? Number(BigInt(lg.blockNumber)) : 0,
      });
    },
  });

  if (scan.failed && rows.size === 0) {
    out.error =
      'could not read Anchored logs from ' + (scan.from || EPOCH_FROM.hex) + ' (' + (scan.failedWhy || 'no reason given') + '). ' +
      'The scan asks in ' + WINDOW + '-block windows — the widest Base’s own endpoint serves — so either this endpoint could not be reached, or it caps log ranges tighter than that and nothing here can widen it. ' +
      'Setting PEER_EPOCH_FROM_BLOCK to the block PeerAnchor was deployed in shortens the backfill. ' +
      'An empty list here is not evidence that nothing was anchored; it is this host saying it could not look.';
    out.scan = scan;
    return out;
  }

  const all = [...rows.values()];
  // Newest first — by block, then by epoch, so the order never depends on
  // whatever order an endpoint served its logs in.
  all.sort((a, b) => (b.blk - a.blk) || (a.epoch === b.epoch ? 0 : BigInt(a.epoch) > BigInt(b.epoch) ? -1 : 1));
  out.discovered = all.length;
  out.anchors = all.slice(0, ANCHOR_LIST_CAP).map((a) => ({
    by: a.by, epoch: a.epoch, blockId: a.blockId, earningsRoot: a.earningsRoot, at: a.at, tx: a.tx, block: a.blk,
  }));
  out.returned = out.anchors.length;
  out.truncated = out.returned < out.discovered;
  // How many distinct addresses posted the rows in view, and how many rows
  // the busiest one holds. Two small integers, and between them a flood is
  // arithmetic rather than a hunch.
  const perPoster = new Map();
  for (const a of all) perPoster.set(a.by, (perPoster.get(a.by) ?? 0) + 1);
  out.posters = perPoster.size;
  out.busiestPoster = [...perPoster.entries()].sort((x, y) => y[1] - x[1]).slice(0, 1).map(([by, n]) => ({ by, anchors: n }))[0] ?? null;
  out.meaning =
    'An anchor is a timestamp over two hashes and nothing else: this address committed to this block id and this earnings root at this time. It does not say the epoch was computed honestly or that the poster is anyone in particular — anyone may post, and impostor rows sit under their own address next to nothing. What an anchor adds is the one fact replay cannot reconstruct: WHEN a commitment was made.';

  if (walked !== null) {
    // Bounded memory: anyone may anchor, forever, so an unbounded file is one
    // a stranger decides the size of. The newest ANCHOR_MEMORY rows are kept
    // because those are the ones the list shows; older rows are re-found from
    // the chain if the from-block is ever moved back.
    const ids = {};
    for (const a of all.slice(0, ANCHOR_MEMORY)) {
      ids[a.by + ':' + a.epoch] = { b: a.blockId, r: a.earningsRoot, at: a.at, blk: a.blk, ...(a.tx ? { tx: a.tx } : {}) };
    }
    const why = saveScan(ANCHOR_SCAN_FILE, ANCHOR_ADDR, EPOCH_FROM, walked, ids);
    scan.cursor = '0x' + walked.toString(16);
    scan.remembering = Math.min(all.length, ANCHOR_MEMORY);
    if (why) scan.notSaved = 'the scan could not be saved (' + why + ') — every refresh will re-walk this range until it can';
  }
  out.scan = scan;
  if (out.truncated || scan.failed || scan.complete === false) {
    out.note =
      'showing ' + out.returned + ' of ' + out.discovered + ' anchors this host has seen, newest first. ' +
      (scan.failed ? 'a log window (' + (scan.failedAt || 'the chain head') + ') was refused, so anything anchored in it is not here yet; ' : '') +
      (scan.backfill || scan.aheadOfHead ? (scan.backfill || scan.aheadOfHead) + '; ' : '') +
      'an anchor missing from this list is still on the chain and still readable with anchorOf(poster, epoch).';
  }
  return out;
}

/**
 * PeerClaim: which epochs were opened, what each was funded with, how much of
 * it has been taken, and until when.
 *
 * Epochs are discovered from EpochOpened, and every number that can MOVE is
 * then read live from epochInfo — `paid` changes with each claim, so taking it
 * from the opening log would show a full pot to somebody whose claim had
 * already been paid out of it. One rule everywhere in this file: logs say what
 * exists, calls say what is true now.
 *
 * This list cannot be flooded by strangers, and that is a property of the
 * contract rather than of this code: openEpoch is the steward's alone, so the
 * epoch numbers here are the steward's own. Which is also why the steward is
 * named in the answer — a role this small is still a role, and it belongs on
 * screen rather than in a runbook.
 */
async function claimState() {
  const out = { contract: CLAIM_ADDR };
  // token() first: one cheap word that settles whether this address is a
  // PeerClaim at all, and which coin it pays.
  let tk = null;
  try {
    tk = addrFromWord(await call(CLAIM_ADDR, SEL.claimToken));
  } catch (e) {
    out.probeError = String(e.message).slice(0, 60);
  }
  if (!tk) {
    out.error =
      'nothing at ' + CLAIM_ADDR + ' answered token() on chain ' + CHAIN_ID +
      ' — that address is not a PeerClaim contract. This is a misconfiguration to fix, not a network with no epochs to claim.';
    return out;
  }
  out.token = tk;
  out.steward = addrFromWord(await call(CLAIM_ADDR, SEL.steward));
  // The same words PeerClaim.sol's header uses, including the part that is
  // uncomfortable. An earlier version of this sentence promised the steward
  // "cannot stop or delay a valid claim", which the contract's own header
  // contradicts two paragraphs later: nothing on-chain can add a tree's leaves
  // up, so a root that oversums its deposit pays first-come and reverts for
  // everyone after — and the steward writes the root. Serving the comfortable
  // half to every consumer of this endpoint was the worst place for it, because
  // this is the sentence a claimant reads before deciding to trust the epoch.
  out.stewardIs =
    'The steward can open an epoch — publish a root, a total and a deadline, once per epoch number, funded with PEER they deposit themselves — and reclaim what nobody claimed after the deadline. The steward cannot mint (there is no mint), cannot alter or re-open a published root, cannot take back a claim already made, cannot reach into an open epoch to stop one named claimant (there is no pause and no allowlist), and cannot sweep early or open a window shorter than MIN_WINDOW. What the steward CAN do that costs claimants: publish a root whose leaves oversum the deposit — including one paying an address they control — which makes that epoch first-come and reverts the late claims. No contract can check that sum, so check it yourself: the leaf list is published beside the root, and it either adds up to the total or it does not.';
  if (TOKEN_ADDR && tk !== TOKEN_ADDR) {
    // The same refusal-to-guess checkPair makes about the pool: neither
    // address is silently preferred, because a contract paying a different coin
    // than this host reports is exactly the failure that looks like success.
    out.mismatch = {
      contract: tk,
      configured: TOKEN_ADDR,
      error: 'this claim contract pays a DIFFERENT token than this host is configured with. Its token address is immutable, so one of the two is wrong and it cannot be corrected here: fix PEER_TOKEN_ADDR, or point PEER_CLAIM_ADDR at the contract you meant.',
    };
  }
  // What the contract holds right now, asked of the token the CONTRACT names
  // rather than the one this host was configured with — those are the coins a
  // claim here actually moves, the same reason checkPair asks the POOL which
  // two tokens it trades. Asking the configured token would answer the balance
  // of a coin nobody can claim, precisely in the case the mismatch above is
  // warning about.
  //
  // openEpoch pulls each epoch's whole total up front, so this covers EVERY
  // unswept epoch — including ones older than the window below — and must not
  // be read as backing only for the remainders listed here. Fenced on its own:
  // a token that will not answer a balance is not a reason to lose the epoch
  // list, which came from somewhere else entirely.
  try {
    const held = word(await call(tk, SEL.balanceOf + pad(CLAIM_ADDR)));
    out.heldRaw = held === null ? null : held.toString();
  } catch (e) {
    out.heldRaw = null;
    out.heldError = 'could not read this contract’s balance (' + String(e.message).slice(0, 60) + ')';
  }
  out.heldIs = 'the PEER this contract holds across every epoch it has open, not only the ones listed below';

  if (!EPOCH_FROM.ok) out.fromBlockIgnored = EPOCH_FROM.raw.slice(0, 40);
  out.fromBlock = EPOCH_FROM.hex;
  out.discoveredBy = 'EpochOpened logs — openEpoch is the steward’s alone, so these epoch numbers cannot be flooded by strangers the way an open list could be';

  const { scan, rows, walked } = await walkLogs({
    file: CLAIM_SCAN_FILE,
    contract: CLAIM_ADDR,
    topic0: TOPIC_EPOCH_OPENED,
    from: EPOCH_FROM,
    fromVar: 'PEER_EPOCH_FROM_BLOCK',
    revive: (key, v) => (!/^[0-9]+$/.test(key) ? null : {
      epoch: key,
      tx: v && typeof v.tx === 'string' ? v.tx : null,
      blk: v && Number.isFinite(Number(v.blk)) ? Number(v.blk) : 0,
    }),
    take: (lg, map) => {
      const topics = lg && Array.isArray(lg.topics) ? lg.topics : [];
      if (topics.length < 2) return;
      const epoch = word(topics[1]); // topic1 = the indexed epoch
      if (epoch === null) return;
      const key = epoch.toString();
      const had = map.get(key);
      // The data words — root, total, claimUntil — are deliberately NOT read
      // here. All three come from epochInfo below, because `paid` sits beside
      // them in the same answer and must be current; reading two of the four
      // from a log and one from the chain is how a display ends up internally
      // inconsistent for the length of a refresh.
      map.set(key, {
        epoch: key,
        tx: typeof lg.transactionHash === 'string' ? lg.transactionHash : (had ? had.tx : null),
        blk: typeof lg.blockNumber === 'string' ? Number(BigInt(lg.blockNumber)) : (had ? had.blk : 0),
      });
    },
  });

  if (scan.failed && rows.size === 0) {
    out.error =
      'could not read EpochOpened logs from ' + (scan.from || EPOCH_FROM.hex) + ' (' + (scan.failedWhy || 'no reason given') + '). ' +
      'The scan asks in ' + WINDOW + '-block windows — the widest Base’s own endpoint serves — so either this endpoint could not be reached, or it caps log ranges tighter than that. ' +
      'Setting PEER_EPOCH_FROM_BLOCK to the block PeerClaim was deployed in shortens the backfill. ' +
      'An empty list here is this host saying it could not look, not that there is nothing to claim.';
    out.scan = scan;
    return out;
  }

  const all = [...rows.values()].sort((a, b) => (a.epoch === b.epoch ? 0 : BigInt(a.epoch) > BigInt(b.epoch) ? -1 : 1));
  out.discovered = all.length;
  const chosen = all.slice(0, EPOCH_READ_CAP); // highest epoch numbers first
  const epochs = [];
  let skipped = 0;
  for (let i = 0; i < chosen.length; i += 8) {
    const batch = chosen.slice(i, i + 8);
    const rets = await Promise.all(batch.map((c) => call(CLAIM_ADDR, SEL.epochInfo + padUint(c.epoch)).catch(() => null)));
    rets.forEach((ret, k) => {
      const c = batch[k];
      const body = String(ret || '').replace(/^0x/, '');
      // Five static words: root, total, paid, claimUntil, open. Short means
      // this host could not read it — counted, never half-decoded.
      if (body.length < 64 * 5) { skipped++; return; }
      const root = body.slice(0, 64);
      if (/^0+$/.test(root)) {
        // A log said this epoch opened and the contract says it does not
        // exist. That is a reorged or invented log, not an epoch, and it must
        // not be listed with a zero root as though it were claimable.
        skipped++;
        return;
      }
      const total = word(ret, 1), paid = word(ret, 2);
      epochs.push({
        epoch: c.epoch,
        // Bare lowercase hex, no 0x — the same convention as the anchors
        // above, so an earningsRoot from either side compares as a string.
        root,
        totalRaw: total.toString(),
        paidRaw: paid.toString(),
        // What is still claimable from this epoch. paid <= total is enforced
        // on every claim by the contract, so this cannot go negative.
        remainingRaw: (total - paid).toString(),
        claimUntil: Number(word(ret, 3)),
        // TRUE only if a valid claim would be paid right now: the epoch
        // exists, the window is open, and the remainder has not been swept.
        // Deliberately not "has been opened" — see epochInfo in PeerClaim.sol.
        open: word(ret, 4) === 1n,
        openedTx: c.tx,
        openedBlock: c.blk,
      });
    });
  }
  out.epochs = epochs;
  out.returned = epochs.length;
  out.skipped = skipped;
  out.truncated = out.returned < out.discovered;
  out.readCap = EPOCH_READ_CAP;
  out.liveFields = 'root, total, paid, claimUntil and open are read from epochInfo every refresh, never from the opening log — paid moves with every claim';
  out.unboundHandles =
    'A handle with no bindAddress act has no leaf in an epoch’s tree, so it has nothing to claim and its share is not redistributed: it stays in the remainder and returns to the steward at sweep.';

  if (walked !== null) {
    const ids = {};
    for (const c of all) ids[c.epoch] = { blk: c.blk, ...(c.tx ? { tx: c.tx } : {}) };
    const why = saveScan(CLAIM_SCAN_FILE, CLAIM_ADDR, EPOCH_FROM, walked, ids);
    scan.cursor = '0x' + walked.toString(16);
    scan.remembering = all.length;
    if (why) scan.notSaved = 'the scan could not be saved (' + why + ') — every refresh will re-walk this range until it can';
  }
  out.scan = scan;
  if (out.truncated || skipped || scan.failed || scan.complete === false) {
    out.note =
      'showing ' + out.returned + ' of ' + out.discovered + ' epochs this host has seen, newest first. ' +
      (skipped ? skipped + ' would not answer epochInfo or came back with no root; ' : '') +
      (scan.failed ? 'a log window (' + (scan.failedAt || 'the chain head') + ') was refused, so epochs opened in it are not here yet; ' : '') +
      (scan.backfill || scan.aheadOfHead ? (scan.backfill || scan.aheadOfHead) + '; ' : '') +
      'an epoch missing from this list is still claimable by anyone holding a proof against its root.';
  }
  return out;
}

/**
 * ONE epoch's on-chain status, for the endpoint that hands out a claim.
 *
 * The claim endpoint could compute a root, an amount and a proof for anybody
 * and say "here is the call that pays it" without ever asking whether a claim
 * contract exists — and with PEER_CLAIM_ADDR unset, which is the shipped
 * state, that is exactly what it said. A proof is not money. It becomes money
 * only if the steward has chosen to open that epoch and fund it out of PEER
 * they already hold, because the token has no mint and nothing obliges anyone
 * to open anything. An answer that leaves that out implies an entitlement the
 * contract deliberately does not create.
 *
 * So: unconfigured answers `configured: false` and says why, in the same words
 * claimState uses; configured answers what the chain says about that epoch
 * number, live, so a caller can tell a payable proof from a hypothetical one.
 * Every failure is reported in the body — a chain this host could not read is
 * never rendered as "not claimable", because those are different sentences.
 */
export async function epochOnChain(epoch) {
  const n = String(epoch);
  if (!/^[0-9]+$/.test(n)) return null;
  if (!CLAIM_ADDR) {
    return {
      configured: false,
      why: 'PEER_CLAIM_ADDR is unset, so no epoch earnings are claimable through this host. Epoch tokens still exist in the act log exactly as before; nothing about them is on a chain until a claim contract is deployed and funded.',
    };
  }
  const out = { configured: true, contract: CLAIM_ADDR, chainId: CHAIN_ID, epoch: n };
  try {
    const chain = await chainCheck();
    if (!chain.ok) {
      out.chainIdSeen = chain.seen;
      out.error = chain.error;
      return out;
    }
    const ret = await call(CLAIM_ADDR, SEL.epochInfo + padUint(n));
    const body = String(ret || '').replace(/^0x/, '');
    // Five static words or nothing. A short answer means this host could not
    // read the epoch, which must not be reported as an epoch that is not open.
    if (body.length < 64 * 5) {
      out.error = 'this host could not read epochInfo(' + n + ') from ' + CLAIM_ADDR + ' — that is a failure to look, not an answer';
      return out;
    }
    const root = body.slice(0, 64);
    out.opened = !/^0+$/.test(root);
    if (!out.opened) {
      out.open = false;
      out.why =
        'epoch ' + n + ' has not been opened on ' + CLAIM_ADDR + '. The root below is what this host computes from the log; nothing on Base commits to it yet, and nothing is payable against it. Opening and funding an epoch is the steward\'s own transaction, out of PEER they already hold — there is no mint, and no obligation.';
      return out;
    }
    const total = word(ret, 1), paid = word(ret, 2);
    out.root = root;                       // bare hex, comparable to the tree's
    out.totalRaw = total.toString();
    out.paidRaw = paid.toString();
    out.remainingRaw = (total - paid).toString();
    out.claimUntil = Number(word(ret, 3));
    // TRUE only if a valid claim would be paid right now — the epoch exists,
    // the window is open, the remainder is unswept. See epochInfo in
    // PeerClaim.sol; it is deliberately not "has been opened".
    out.open = word(ret, 4) === 1n;
    out.rootMatches = null;                // filled in by the caller, which holds the tree
    out.note =
      'total is what the steward deposited, and this contract cannot check it against the tree — nothing on-chain holds the leaves. Sum the leaf list against total yourself before trusting the epoch: a root that oversums its deposit pays first-come and then reverts.';
  } catch (e) {
    out.error = 'could not read the claim contract (' + String(e.message).slice(0, 60) + ')';
  }
  return out;
}

/**
 * Has this address already claimed these epochs?
 *
 * Per-account and therefore deliberately OUTSIDE the host's shared 30-second
 * cache, exactly like balanceOf: a cached answer here would show one viewer's
 * claim history to everybody who asked in the same window. One cheap eth_call
 * per epoch, capped, and the cap is in the answer.
 *
 * `claimed` is the contract's own public mapping — the same flag claim()
 * checks — so this cannot drift from the thing that actually decides. A word
 * that is neither 0 nor 1 is reported as null rather than coerced: an
 * endpoint answering nonsense must not read as "no, go ahead and try".
 */
export async function claimsOf(addr, epochs) {
  const a = clean(addr);
  if (!CLAIM_ADDR || !a || !Array.isArray(epochs) || epochs.length === 0) return null;
  const chain = await chainCheck();
  if (!chain.ok) return { address: a, chainIdSeen: chain.seen, chainIdMatches: false, error: chain.error };
  const wanted = [];
  for (const e of epochs) {
    const s = String(e);
    if (/^[0-9]+$/.test(s) && !wanted.includes(s)) wanted.push(s);
    if (wanted.length >= CLAIM_ACCOUNT_CAP) break;
  }
  if (!wanted.length) return null;
  const rets = await Promise.all(
    wanted.map((e) => call(CLAIM_ADDR, SEL.claimed + padUint(e) + pad(a)).catch(() => null)),
  );
  return {
    address: a,
    contract: CLAIM_ADDR,
    epochs: wanted.map((epoch, i) => {
      const v = word(rets[i]);
      return { epoch, claimed: v === 1n ? true : v === 0n ? false : null };
    }),
    asked: wanted.length,
    capped: epochs.length > CLAIM_ACCOUNT_CAP,
    note: 'claimed says only whether this address has already taken its leaf. It is not a statement that the address HAS a leaf in that epoch — an unbound handle has no leaf at all, and the answer for it is false forever.',
  };
}

/** One account's PEER balance, raw and humanised — or, off the wrong chain,
 *  the refusal instead of a number. The check is here rather than only in
 *  the caller so that no exported reader in this file can be made to answer
 *  off an endpoint the host has already said it does not trust. */
export async function balanceOf(addr) {
  const a = clean(addr);
  if (!L2_ON || !a) return null;
  const chain = await chainCheck();
  if (!chain.ok) return { address: a, chainIdSeen: chain.seen, chainIdMatches: false, error: chain.error };
  const raw = word(await call(TOKEN_ADDR, SEL.balanceOf + pad(a)));
  if (raw === null) return null;
  const dec = Number(word(await call(TOKEN_ADDR, SEL.decimals)) ?? 18n);
  return { address: a, raw: raw.toString(), amount: human(raw, dec), decimals: dec };
}

/** One account's shares in THE pool. Shares are internal accounting inside
 *  PeerPool, not a token — they do not transfer and there is no ERC-20 to ask,
 *  so this reader is the only way to see them. The encoding is the house
 *  encoder: selector plus one left-padded address, and the pool id that used
 *  to sit in front of it is gone with the factory. Raw string only; a share
 *  count has no decimals to humanise by. */
export async function sharesOf(addr) {
  const a = clean(addr);
  // Garbage is refused before the network is touched; the chain is checked
  // before an answer is given. Same gate as balanceOf, same reason.
  if (!POOL_ADDR || !a) return null;
  const chain = await chainCheck();
  if (!chain.ok) return { pool: POOL_ADDR, address: a, chainIdSeen: chain.seen, chainIdMatches: false, error: chain.error };
  const raw = word(await call(POOL_ADDR, SEL.poolSharesOf + pad(a)));
  if (raw === null) return null;
  return { pool: POOL_ADDR, address: a, raw: raw.toString() };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE PEER DOOR: the price, and the proof that the PEER is gone
// ═══════════════════════════════════════════════════════════════════════════
//
// Reserve is VALUE DESTROYED. The bitcoin door destroys bitcoin at an address
// that is unspendable BY ARITHMETIC, and needs no price: a satoshi is the
// unit reserve is denominated in, so there is nothing to convert and nothing
// to be wrong about. This door destroys PEER, which has a price, and that one
// difference is where every hazard in this file comes from.
//
// Two things must be true before a peerBurn act is written, and this module
// answers both:
//
//   1. THE PEER IS REALLY GONE. An ERC-20 Transfer, on the chain this host
//      claims, of the token this host is configured with, from the burner's
//      own bound address, to the dead address, buried deep enough. Anything
//      short of that is a claim rather than a burn, and a claim credits
//      nothing.
//   2. WHAT IT WAS WORTH IS NOT THIS HOST'S OPINION. The price comes from the
//      official pool, TIME-WEIGHTED across a window, and the act records the
//      reserves used so a reader can recompute the satoshi figure instead of
//      believing it. See the peerBurn branch in social/replay.cjs: replay
//      recomputes and refuses any disagreement.
//
// WHAT THIS MODULE DOES NOT DECIDE. The window, the observation count, the
// depth floor and the per-epoch ceiling are the ENGINE's constants — they are
// declared once in social/replay.cjs, published on the replay state as
// `peerBurn.limits`, and passed IN to the functions below. Restating any of
// them here would create a second copy of a rule, and a rule with two copies
// is a rule that will eventually be enforced at one door and not the other:
// the host would credit a burn replay then refuses, and the burner would be
// told "recorded" about reserve they never received. What lives here is HOW a
// time-weighted price is obtained; HOW MUCH is required of it lives there.

/**
 * The canonical ERC-20 Transfer topic — keccak256 of the event signature,
 * which is a 4-byte selector with all 32 bytes kept:
 *
 *   event Transfer(address indexed from, address indexed to, uint256 value)
 *   hashed as: Transfer(address,address,uint256)
 *
 * Hardcoded like every other topic and selector in this file, and it is the
 * most-checked constant in the repository rather than the least: the header
 * comments above describe reproducing it from scratch twice, and
 * tests/onchain-epoch-decode.test.ts pins this exact word against a transfer
 * emitted by compiled bytecode running under @ethereumjs/vm. A wrong topic
 * here would not be an error message — it would be a burn that the chain
 * shows and this host cannot see, which reads exactly like a burn that never
 * happened.
 */
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * The shape of the sampling, and why each number is what it is. None of these
 * is a floor — the floors are the engine's, and so is the NUMBER OF SAMPLES
 * (limits.twapGrid), because replay re-derives the sampled blocks and refuses
 * an act whose readings are not on that grid. These decide how the host GOES
 * LOOKING for a price it can defend.
 *
 * SPAN_OVERSHOOT is how much wider than the required window the oldest sample
 * is aimed. Block numbers are estimated from an average block time, so aiming
 * exactly at the window means half the attempts land just inside it and the
 * span comes out one second short of a floor — refused, correctly, and
 * uselessly. A quarter more history removes the whole class of near-miss.
 *
 * MAX_GAP_FRACTION is the largest hole tolerated between two consecutive
 * observations, as a fraction of the window. Without it "twelve observations
 * spanning thirty minutes" is satisfiable by eleven samples in the last two
 * minutes and one half an hour ago — which is a spot price wearing a TWAP's
 * clothes, and precisely the thing the window exists to prevent.
 *
 * HEAD_STALE_MS is how old the chain head may be before this host refuses to
 * price anything. An endpoint stuck ten minutes in the past quotes a real
 * price from a real pool at a time that is not now, and a burner would be
 * paid at a rate the pool has already left behind.
 *
 * QUOTE_REF_STRIDE is the one place a quote and a burn are read differently,
 * and only a quote is affected. A burn is priced by the window ending at its
 * OWN block, whose hash nobody could know in advance — that unpredictability
 * is the defence. A quote is priced at the head, credits nothing, and is asked
 * for by every visitor: pricing it at a reference block snapped to this many
 * blocks means everyone within about a minute shares one window, so the
 * readings are already held and a public GET does not turn this host into a
 * request amplifier pointed at the operator's endpoint. Snapping costs a quote
 * up to a minute of freshness against a half-hour average, which is nothing,
 * and costs the defence nothing at all, because a predictable grid on a number
 * nobody is credited for buys an attacker exactly no reserve.
 */
const SPAN_OVERSHOOT = 1.25;
const MAX_GAP_FRACTION = 1 / 3;
const HEAD_STALE_MS = 5 * 60_000;
const QUOTE_REF_STRIDE = 30n;
/** How many observations are kept between refreshes. Bounded because it is a
 *  process-lifetime memory, not a file, and an unbounded map that grows with
 *  every quote is a slow leak nobody notices. */
const OBS_KEEP = 96;

/**
 * One reading of the official pool, at one block, as the chain reports it.
 * blockNumber -> { block, ms, resPeerRaw, resBtcRaw }.
 *
 * Keyed and timestamped by the CHAIN, never by this host's clock. That is not
 * fussiness: `twapMs` goes into the act as a claim about how long the price
 * was observed for, and a claim measured by the recorder's own wall clock is
 * a claim the recorder can make say anything. A block timestamp is a number
 * the burner, the host and any reader all fetch from the same place.
 *
 * In memory only, and it does not survive a restart. That is the honest
 * behaviour: a restarted host has not observed anything yet and says so — it
 * refills the window from historical blocks if the endpoint will serve them,
 * and otherwise waits, which is what "this price has been watched for four of
 * the required thirty minutes" means in the refusal below.
 */
const poolObs = new Map();

/**
 * The last answer poolTwap gave, and when.
 *
 * GET /api/peerburn is public and prices on every request; without this, one
 * anonymous caller in a loop spends the operator's endpoint quota — and an
 * endpoint that has run out of quota is a door that credits nobody's burn.
 * The same lesson the bitcoin pending path already learned from a public
 * explorer's rate limit.
 *
 * Fifteen seconds is safe HERE in a way it would not be for a spot price: the
 * window this averages over is half an hour long, so an answer computed a few
 * seconds ago describes very nearly the same window as one computed now. What
 * it must never do is turn a refusal into an acceptance or the reverse — and
 * it cannot, because the whole result including its refusal is what is held.
 */
const TWAP_MEMO_MS = Math.max(0, Number(process.env.PEER_PEERBURN_QUOTE_MEMO_MS ?? 15_000));
let twapMemo = { at: 0, key: '', value: null };

/** eth_call at a specific block, for the historical reads the window needs.
 *  `call` above is 'latest' and stays that way; a helper rather than a
 *  parameter so no existing caller can be moved off the head by accident. */
const callAt = (to, data, tag) => rpc('eth_call', [{ to, data }, tag]);

/** One block header — the number, the timestamp in milliseconds, and the hash.
 *  Nothing else is read: full transaction bodies are megabytes and this needs a
 *  clock and a seed. The hash is what decides which blocks the window is
 *  sampled at, so a header without one cannot anchor a window. */
async function blockAt(tag) {
  const b = await rpc('eth_getBlockByNumber', [tag, false]);
  if (!b || typeof b.number !== 'string' || typeof b.timestamp !== 'string') return null;
  const hash = typeof b.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(b.hash) ? b.hash.toLowerCase() : null;
  return { block: BigInt(b.number), ms: Number(BigInt(b.timestamp)) * 1000, hash };
}

/**
 * Is the code at POOL_ADDR the code in this repository's PeerPool.build.json?
 *
 * "The address IS the identity" (PeerPool.sol) is the whole argument for one
 * pool, and until this was here it was an assertion: the host asked the
 * address three questions — reserves(), peer(), btc() — and believed any
 * contract that answered them plausibly. A contract with an owner, a pause and
 * a reserves() returning whatever its author liked would have passed every one
 * of them and set the price at which the right to speak is sold. One
 * eth_getCode, once, makes it checkable instead.
 *
 * WHAT THE CHECK PROVES, exactly: that the code at that address is this file's.
 * It does NOT prove the operator pointed at the right INSTANCE of it — anybody
 * may deploy this contract, and two honest deployments are indistinguishable
 * here. That question is the pair check below, which ties the instance to this
 * host's own coins. The two are different questions and neither substitutes.
 *
 * Two parts of the runtime code are deliberately not compared, and build-pool.js
 * writes down both so this side does not have to guess:
 *
 *   the ten immutable words — `peer` and `btc` are written into the code at
 *     construction, so real code differs from the artifact at exactly those
 *     ranges. They are masked here and their values are checked where they can
 *     be: against peer() and btc() themselves.
 *   the metadata trailer — solc appends a hash of the SOURCE. Editing a comment
 *     in PeerPool.sol changes it without changing one instruction, and a host
 *     that started refusing burns because somebody improved a sentence would be
 *     a worse failure than the one this catches.
 */
const POOL_BUILD = (() => {
  try {
    const j = JSON.parse(readFileSync(join(here, 'PeerPool.build.json'), 'utf8'));
    const d = j.deployed;
    if (!d || typeof d.object !== 'string' || !Array.isArray(d.immutables) || !(d.metaLen > 0)) return null;
    return { object: d.object.replace(/^0x/, '').toLowerCase(), immutables: d.immutables, metaLen: d.metaLen };
  } catch {
    return null;
  }
})();

/** The comparable part of a runtime code string: immutables zeroed, metadata
 *  trailer cut. Null when the input is not code at all. */
function poolCodePrint(hex) {
  const body = String(hex || '').replace(/^0x/i, '').toLowerCase();
  if (!body.length || !/^[0-9a-f]+$/.test(body)) return null;
  const chars = body.split('');
  for (const r of POOL_BUILD.immutables) {
    for (let i = r.start * 2; i < (r.start + r.length) * 2 && i < chars.length; i++) chars[i] = '0';
  }
  return chars.join('').slice(0, Math.max(0, chars.length - POOL_BUILD.metaLen * 2));
}

/**
 * Is the configured pool a pool over THIS host's PEER, priced in something
 * where a raw unit is a satoshi?
 *
 * Every half matters and none of them is checkable later. The pool's own
 * immutables say which two tokens it trades; if its peer() is not the token
 * this host is configured with, then every price below is the price of a
 * DIFFERENT COIN with the same name, which is the failure that looks most
 * like success. The bitcoin side gets the same treatment for the same reason —
 * it used to get only the decimals gate below, which meant a stranger's
 * PeerPool over the real PEER and an 8-decimal token they minted themselves
 * passed every identity check this host made. And the satoshi arithmetic in
 * the engine — sats = amt·resBtc / (resPeer + amt), with no scaling constant
 * anywhere — is only true because cbBTC carries 8 decimals, so one raw unit IS
 * one satoshi. Against an 18-decimal BTC stand-in the same expression is right
 * by ten orders of magnitude, silently, in the burner's favour.
 *
 * The two BTC fences do different work and which one bites depends on the
 * configuration: with PEER_BTC_ADDR set, the address comparison is the real
 * gate and the decimals gate is a second fence that can no longer fire. With it
 * unset — which is legal, since PEERBURN_ON asks only for the token and the
 * pool — the decimals gate is the ONLY thing standing between this door and a
 * pool whose "bitcoin" is any 8-decimal coin at all, and it is not enough to
 * identify one. Setting PEER_BTC_ADDR is how a host says which bitcoin it
 * means.
 *
 * Memoised per process: these are immutable on the contracts, and asking four
 * times a minute would spend the host's endpoint quota re-confirming
 * something that cannot change.
 */
let pairCheck = null;
async function checkPair() {
  if (pairCheck) return pairCheck;
  const out = { ok: false };
  try {
    const fPeer = addrFromWord(await call(POOL_ADDR, SEL.poolPeer));
    const fBtc = addrFromWord(await call(POOL_ADDR, SEL.poolBtc));
    out.peer = fPeer;
    out.btc = fBtc;
    if (!fPeer || !fBtc) {
      out.why = 'nothing at ' + POOL_ADDR + ' answered peer()/btc() on chain ' + CHAIN_ID
        + ' — that address is not a PeerPool, and a price read off it would be a number from an unknown contract';
      out.note = 'the pool at ' + POOL_ADDR + ' did not answer peer()/btc(), so nothing here knows which two coins it moves and the scaling below comes from this host’s configured addresses with nothing to check it against';
      return out;                       // not memoised: a reachability failure is not an answer
    }
    // The pool's own decimals, read from the pool's own tokens, whatever the
    // comparisons below decide. A display has to be scaled by the coins a
    // trade actually moves even when — especially when — those are not the
    // coins this host was configured with.
    out.btcDecimals = await decimalsOf(fBtc, null);
    if (fPeer !== TOKEN_ADDR) out.peerDecimals = await decimalsOf(fPeer, 18);
    // Neither address is silently preferred: an operator whose pool trades
    // different tokens than they configured has one of the two wrong, and this
    // module cannot know which. Both are named.
    const disagree = [];
    if (fPeer !== TOKEN_ADDR) disagree.push({ side: 'peer', pool: fPeer, configured: TOKEN_ADDR });
    if (BTC_ADDR && fBtc !== BTC_ADDR) disagree.push({ side: 'btc', pool: fBtc, configured: BTC_ADDR });
    if (disagree.length) {
      out.mismatch = {
        pairs: disagree,
        error: 'this pool trades tokens this host was not configured with — amounts are scaled by the POOL’s tokens, because those are the coins a trade here actually moves. One of the two is wrong: fix PEER_TOKEN_ADDR / PEER_BTC_ADDR, or point PEER_POOL_ADDR at the pool you meant.',
      };
    }
    if (fPeer !== TOKEN_ADDR) {
      out.why = 'the pool at ' + POOL_ADDR + ' trades ' + fPeer + ', and this host’s PEER is ' + TOKEN_ADDR
        + ' — that is a different coin with the same name, so nothing here can price a burn of yours';
      pairCheck = out;
      return out;
    }
    if (BTC_ADDR && fBtc !== BTC_ADDR) {
      out.why = 'the bitcoin side of the pool at ' + POOL_ADDR + ' is ' + fBtc + ', and this host’s cbBTC is ' + BTC_ADDR
        + ' — that is a different coin, so nothing here can price a burn against it. Reserve is satoshis destroyed, and satoshis of something else are not satoshis.';
      pairCheck = out;
      return out;
    }
    // Before the decimals gate, because it answers a prior question: the scale
    // of the bitcoin token is arithmetic ABOUT the pool, and there is no point
    // reasoning about a contract's arithmetic until it is established that the
    // contract is this one.
    if (!POOL_BUILD) {
      out.codeChecked = false;
      out.codeNote = 'chain-l2/PeerPool.build.json is missing or carries no deployed code, so this host could not compare the code at ' + POOL_ADDR + ' against the contract in this repository. The pair checks above still ran; this one did not, and saying so is better than letting an unmade check pass for a made one. Rebuild it with node chain-l2/build-pool.js.';
    } else {
      const got = poolCodePrint(await rpc('eth_getCode', [POOL_ADDR, 'latest']));
      const want = poolCodePrint('0x' + POOL_BUILD.object);
      out.codeChecked = true;
      if (got !== want) {
        out.why = 'the code at ' + POOL_ADDR + ' is not PeerPool. It answers peer() and btc() with the right two tokens, which any contract can do, but its runtime code is not the code in chain-l2/PeerPool.build.json — so what it returns from reserves() is whatever its author decided to return, and pricing the right to speak off that is pricing it off a stranger’s arithmetic.';
        pairCheck = out;
        return out;
      }
    }
    if (out.btcDecimals !== 8) {
      out.why = 'the bitcoin side of the pool ' + (out.btcDecimals === null ? 'did not answer decimals() at all' : 'answers ' + out.btcDecimals + ' decimals, not 8')
        + ' — reserve is denominated in satoshis and this whole door rests on one raw unit of that token BEING one satoshi. Against any other scale every price here would be wrong by orders of magnitude, so it refuses rather than guesses a multiplier.';
      pairCheck = out;
      return out;
    }
    out.ok = true;
    pairCheck = out;
    return out;
  } catch (e) {
    out.why = 'could not read the pool’s own token pair (' + String(e.message).slice(0, 60) + ')';
    out.note = 'this host could not ask the pool at ' + POOL_ADDR + ' which two coins it moves, so any amounts shown are scaled by this host’s configured addresses with nothing to check them against';
    return out;                         // again: not memoised, this is a failure to look
  }
}

/**
 * Is this door configured at all, and what would a burner need to know?
 *
 * Answers in WORDS when it is off, and that is the shipped state until the
 * pool is deployed and seeded: with no pool there is no price. A feature that
 * degraded into a guessed rate would be worse than one that is closed.
 *
 * `missing` used to name two variables — a factory and a pool id — because a
 * pool NAME could not be trusted to identify anything. There is one address
 * now, so there is one thing that can be missing.
 */
export function peerBurnConfig() {
  if (!PEERBURN_ON) {
    const missing = [];
    if (!TOKEN_ADDR) missing.push('PEER_TOKEN_ADDR');
    if (!POOL_ADDR) missing.push('PEER_POOL_ADDR');
    return {
      on: false,
      missing,
      why: 'burning PEER for reserve is off on this host: ' + missing.join(' and ') + ' '
        + (missing.length > 1 ? 'are' : 'is') + ' unset'
        + '. A PEER burn is priced by THE pool — one PeerPool contract at one address, which an operator points this host at. With none configured there is no price, and a host that invented one would be inventing the rate at which speech is sold. Burning bitcoin is unaffected and needs no price at all: GET /api/burn.',
    };
  }
  return {
    on: true,
    chainId: CHAIN_ID,
    token: TOKEN_ADDR,
    pool: POOL_ADDR,
    minConfirmations: PEERBURN_MIN_CONF,
    fromBlock: PEERBURN_FROM.hex,
  };
}

/**
 * The pool as it stands RIGHT NOW — one read, at the head.
 *
 * This is for display and for the "what is in there" question, and it is
 * deliberately NOT what a burn is priced at. The spot reserves are whatever
 * the last trade left behind; poolTwap below is what a burn is priced at, and
 * showing them side by side is the point rather than an accident.
 */
let poolMemo = { at: 0, value: null };
export async function officialPool() {
  const cfg = peerBurnConfig();
  if (!cfg.on) return cfg;
  // Memoised on the same clock as the quote, for the same reason: this is
  // read by a public GET, and two eth_calls per request from one caller in a
  // loop is a bill the operator's endpoint pays. Nothing decides anything on
  // this reading — it is the "what does the pool hold right now" panel,
  // deliberately NOT the price a burn is charged at.
  if (poolMemo.value && Date.now() - poolMemo.at < TWAP_MEMO_MS) {
    return { ...poolMemo.value, memoAgeMs: Date.now() - poolMemo.at };
  }
  const value = await officialPoolFresh();
  poolMemo = { at: Date.now(), value };
  return value;
}

async function officialPoolFresh() {
  const out = { on: true, address: POOL_ADDR, chainId: CHAIN_ID };
  try {
    const chain = await chainCheck();
    if (!chain.ok) { out.chainIdSeen = chain.seen; out.error = chain.error; return out; }
    const pair = await checkPair();
    out.tokens = { peer: pair.peer || null, btc: pair.btc || null };
    if (!pair.ok) { out.error = pair.why; return out; }
    const p = await readPool();
    if (p.error) { out.error = p.error; return out; }
    out.resPeerRaw = p.resPeerRaw;
    out.resBtcRaw = p.resBtcRaw;
    out.totalSharesRaw = p.totalSharesRaw;
    out.seeded = p.seeded;
    // What identifies this pool, said once rather than left to be inferred.
    // There is no name to disclaim any more and no creator to name beside it:
    // the address is the identity, anyone may add liquidity to it, and nobody
    // holds any privilege over it — not even whoever deployed it.
    out.identity = 'this pool is the contract at ' + POOL_ADDR + ' and nothing else identifies it: no name, no id, no factory. Anyone may add liquidity, and every add makes it bigger.';
    if (!p.seeded) {
      out.note = 'nobody has added liquidity yet, so there are no reserves and no price. The FIRST add sets the opening price — the two amounts deposited ARE the ratio — and it can be as small as the depositor likes.';
    }
  } catch (e) {
    out.error = 'could not read the pool (' + String(e.message).slice(0, 60) + ')';
  }
  return out;
}

/**
 * THE PRICE: the official pool's reserves, time-weighted across a window of
 * real blocks, or a plain sentence saying why there is no price to give.
 *
 * ── Why a window at all ──────────────────────────────────────────────────
 * Constant-product price is whatever the last trade left behind. Against a
 * shallow pool an attacker pumps it, burns PEER at the inflated rate, takes
 * the reserve and lets the price fall — the ordinary oracle attack, aimed
 * here at the one thing this network says cannot be bought. A time-weighted
 * price makes that expensive in the only currency that is hard to fake: the
 * attacker must hold the false price against every arbitrageur for the whole
 * window, at their own cost, and the reserve they get is diluted by however
 * much of the window they could not hold.
 *
 * A window is only worth as much as WHERE INSIDE IT the host looks, which the
 * first version of this got wrong: sixteen readings on a fixed arithmetic grid
 * that anyone could compute meant the attacker had to hold the false price for
 * 1.4% of the window rather than all of it. The blocks are now chosen by the
 * ENGINE's peerBurnGrid from the reference block's own hash — see the comment
 * on the grid below, and on peerBurnGrid in social/replay.cjs.
 *
 * ── How the observations are obtained ────────────────────────────────────
 * By reading the pool AT PAST BLOCKS, not by remembering what this host saw.
 * Every sample carries the block's own timestamp, so the window is measured in
 * chain time by numbers anyone can re-fetch, and the average is built from
 * exactly the blocks the grid named — never from whatever this process happens
 * to have cached. The alternative — a host that polls every minute and averages
 * its own diary — is a price whose entire provenance is "this host says it
 * looked", unverifiable by anyone and unavailable for thirty minutes after
 * every restart.
 *
 * The cost is a dependency worth stating: an endpoint that does not serve
 * historical state answers nothing for old blocks, and then this host cannot
 * price a burn at all. It says exactly that, with the numbers, rather than
 * falling back to a spot read — the fallback is the attack.
 *
 * ── What is averaged, and the rounding ───────────────────────────────────
 * Each side of the pool is averaged over time separately, weighted by how
 * long it stood: sum(res·duration)/sum(duration). The act records those two
 * averaged reserves, and replay recomputes the satoshi figure from them — so
 * what is recorded has to be a PAIR OF RESERVES, not a rate. (Averaging the
 * rate instead would leave no reserves to write down that reproduce it, and
 * "trust my division" is exactly the property this act exists to avoid.)
 * Both roundings run AGAINST the burner: the bitcoin side floors, the PEER
 * side ceils, so the arithmetic can only ever credit fewer satoshis than the
 * true average, never more.
 *
 * The caller passes the floors, from the engine. See the section header for
 * why they are not repeated here.
 */
export async function poolTwap(limits) {
  const { windowMs, minObs, minPoolSats, atBlock, gridN, gridFn } = limits || {};
  // Keyed by the floors it was computed under AND by the block it ends at, so
  // a caller asking with different limits — or about a different burn — can
  // never be served an answer that satisfied different ones. In practice the
  // floors come from the engine and never change; the key costs nothing and
  // removes the class of bug entirely.
  const memoKey = windowMs + ':' + minObs + ':' + minPoolSats + ':' + (atBlock ?? 'head');
  if (twapMemo.value && twapMemo.key === memoKey && Date.now() - twapMemo.at < TWAP_MEMO_MS) {
    return { ...twapMemo.value, memoAgeMs: Date.now() - twapMemo.at };
  }
  const value = await poolTwapFresh({ windowMs, minObs, minPoolSats, atBlock, gridN, gridFn });
  // The refusals are held too, and deliberately: "this pool is too thin to
  // price" is exactly as expensive to establish as a price, and a caller in a
  // loop against a thin pool must not cost more than one against a healthy
  // one.
  twapMemo = { at: Date.now(), key: memoKey, value };
  return value;
}

async function poolTwapFresh({ windowMs, minObs, minPoolSats, atBlock, gridN, gridFn }) {
  const cfg = peerBurnConfig();
  if (!cfg.on) return { ok: false, code: 'PEERBURN_OFF', why: cfg.why };
  if (!(windowMs > 0) || !(minObs > 0) || !(minPoolSats > 0) || !(gridN > 0) || typeof gridFn !== 'function') {
    // Called without the engine's floors. Refused rather than defaulted: a
    // default here would be a second copy of a rule that lives in replay.cjs,
    // and the day the two disagreed this host would credit burns replay
    // refuses.
    return { ok: false, code: 'PEERBURN_OFF', why: 'this host could not read the engine’s burn limits, and it will not invent them — the window, the observation count, the depth floor and the sampling grid are declared once in the replay engine so that the page, this door and replay all refuse in the same numbers' };
  }
  const out = { pool: POOL_ADDR, windowMs, minObs, minPoolSats, gridN };
  // ── Which block the window ENDS at ────────────────────────────────────
  //
  // For a quote: the head, because the question is "what would a burn get".
  // For a burn: THE BLOCK THAT BURN IS IN, and that is not a detail.
  //
  // Priced at claim time instead, a burner would hold free optionality on the
  // price of speech: burn from an address nobody has bound, watch, and bind
  // and claim after a pump. The window would be honest — thirty minutes,
  // twelve readings, all of it — and still be the burner's pick of the best
  // half hour in a week. Anchoring the window to the burn's own block makes
  // waiting worth exactly nothing, and it makes the price a permanent fact
  // about that transaction rather than about when somebody got around to
  // claiming it. Be exact about how far that goes: the act records the block
  // range, the reference block's hash and every block read, so anyone can
  // re-fetch reserves() at those exact blocks and recompute the same two
  // reserves, forever — and replay checks that those blocks are the ones the
  // recorded seed selects. What replay cannot check, because it asks no chain
  // anything, is that the seed is really that block's hash. A reader with any
  // Base endpoint can, in one call.
  let ref;
  try {
    const chain = await chainCheck();
    if (!chain.ok) return { ...out, ok: false, code: 'L2_UNREACHABLE', why: chain.error };
    const pair = await checkPair();
    if (!pair.ok) return { ...out, ok: false, code: 'PEERBURN_OFF', why: pair.why };
    if (atBlock == null) {
      // A quote: snapped to a shared reference so every visitor within about a
      // minute reads the same window. See QUOTE_REF_STRIDE.
      const headHex = await rpc('eth_blockNumber', []);
      const head = BigInt(headHex);
      const snapped = (head / QUOTE_REF_STRIDE) * QUOTE_REF_STRIDE;
      ref = await blockAt('0x' + (snapped > 0n ? snapped : head).toString(16));
      if (!ref) ref = await blockAt('latest');
    } else {
      ref = await blockAt('0x' + BigInt(atBlock).toString(16));
    }
    if (!ref) {
      return atBlock == null
        ? { ...out, ok: false, code: 'L2_UNREACHABLE', why: 'this endpoint did not answer eth_getBlockByNumber for its own head — there is no clock to measure a window against' }
        // Not unreachable: the head reads fine. This endpoint keeps no state
        // as old as the burn, and the price of a burn is the window ending at
        // its own block, so there is nothing honest to quote.
        : { ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
          why: 'this host has no reading of block ' + atBlock + ', which is the block that burn is in — a burn is priced by the window ending at its OWN block, so that waiting for a better price buys nothing, and this endpoint does not serve state that old' };
    }
  } catch (e) {
    return { ...out, ok: false, code: 'L2_UNREACHABLE', why: 'could not reach the chain to read the pool (' + String(e.message).slice(0, 60) + ')' };
  }
  out.endsAt = Number(ref.block);
  // The seed. Without it there is no way to choose sample blocks that an
  // attacker cannot compute in advance, and a window sampled on a public grid
  // is a window an attacker holds for 1.4% of its length. Refused rather than
  // fallen back to arithmetic snapping — the fallback is the attack.
  if (!ref.hash) {
    return { ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
      why: 'this host’s chain endpoint returned block ' + out.endsAt + ' without its hash, and that hash is what decides which blocks inside the window are read. Without it the sampled blocks would be public arithmetic an attacker could pump one at a time, so no price is offered.' };
  }
  out.refHash = ref.hash;
  // Staleness is only a question for a quote. A window anchored to a burn is
  // deliberately in the past, and calling that stale would refuse every burn
  // older than five minutes.
  const behind = Date.now() - ref.ms;
  if (atBlock == null && behind > HEAD_STALE_MS) {
    return {
      ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
      why: 'this host’s chain endpoint is ' + Math.round(behind / 60_000) + ' minutes behind — its newest block is older than that, so any price read from it is a real price from a time that is not now',
    };
  }

  // ── Which blocks to read ───────────────────────────────────────────────
  //
  // Estimated from the chain's own average block time over a recent stretch,
  // never from a constant: "Base makes a block every two seconds" is true
  // until it is not, and a hardcoded two would quietly aim every sample at
  // the wrong depth on any other chain this config-driven reader is pointed
  // at. The estimate only decides WHERE to look — each sample's weight comes
  // from the block timestamp it actually carries — so an estimate that is off
  // costs coverage, never correctness.
  //
  // Probed at a ladder of depths rather than one, because the endpoints that
  // fail here fail in a specific way: a pruning node serves the last hundred
  // or so blocks and refuses everything older. One probe a thousand deep would
  // read that node as unusable when it can still measure a block time
  // perfectly well from four blocks back — and the refusal a burner then gets
  // would be "the chain is unreachable", which is false and unactionable.
  const spanTarget = windowMs * SPAN_OVERSHOOT;
  let msPerBlock = null;
  for (const back of [1000n, 200n, 32n, 4n, 1n]) {
    if (msPerBlock) break;
    try {
      const older = await blockAt('0x' + (ref.block > back ? ref.block - back : 0n).toString(16));
      if (older && older.block < ref.block && older.ms < ref.ms) {
        msPerBlock = (ref.ms - older.ms) / Number(ref.block - older.block);
      }
    } catch { /* try a shallower probe */ }
  }
  if (!msPerBlock || !(msPerBlock > 0)) {
    // Not "unreachable": the head read fine a moment ago. This endpoint keeps
    // no historical state at all, so no window can be built from it — which is
    // a refusal to price, not a failure to connect, and the operator's fix is
    // an endpoint that serves history rather than a retry.
    return {
      ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
      why: 'this host’s chain endpoint answers for its own head but for no earlier block, so there is no history to average over. A price from one block is a spot price — whatever the last trade left behind — and a burn is refused rather than priced from one. The operator needs an endpoint that serves recent historical state (PEER_L2_RPC).',
    };
  }
  out.msPerBlock = Math.round(msPerBlock);
  // ── WHICH BLOCKS, and why not the obvious ones ─────────────────────────
  //
  // The obvious answer — a fixed arithmetic grid, `floor(ref/stride)*stride`
  // counting back — is the one this used to use, and it was broken in a way
  // that made the whole window decorative. The grid is public arithmetic and
  // the attacker chooses the block of their own burn, so they know all sixteen
  // blocks that will be read: pump and dump sixteen times and the "average" is
  // fully manipulated while the pool sits at its true price for 98.6% of the
  // window. Measured on a fake chain at the minimum permitted depth: 16 blocks
  // of ~1125, 1.4% of the window, ~864,000 sat of round-trip fees, after which
  // reserve cost about 1 satoshi a unit instead of 100.
  //
  // So the blocks come from the ENGINE's peerBurnGrid, seeded by the reference
  // block's own hash: the window is cut into gridN buckets and one block is
  // read from each, its position inside the bucket taken from the hash. Nobody
  // knows a block's hash before it exists, so nobody can pre-pump the blocks
  // that will be read, and a pump lasting f of the window is sampled about f
  // of the time — cost proportional to duration, which is what a time-weighted
  // price was always supposed to charge for.
  //
  // startsAt is derived from the measured block time and is RECORDED in the
  // act, so a reader never has to reproduce this host's estimate: they read
  // the range, the hash and the grid rule out of the log and re-fetch. An
  // estimate that is off makes the window longer or shorter, and a window that
  // came out too short is refused by the engine's own floor.
  const spanBlocks = BigInt(Math.max(1, Math.round(spanTarget / msPerBlock)));
  const startsAt = ref.block > spanBlocks ? ref.block - spanBlocks : 0n;
  out.startsAt = Number(startsAt);
  const wanted = gridFn(Number(startsAt), Number(ref.block), ref.hash, gridN).map((n) => BigInt(n));
  if (wanted.length < minObs) {
    return { ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
      why: 'the window between blocks ' + out.startsAt + ' and ' + out.endsAt + ' is too short to hold '
        + minObs + ' separate readings, so there is nothing to average' };
  }

  // ── Read the ones not already held ─────────────────────────────────────
  // Two calls per block — the header for its timestamp, reserves() for the
  // two sides — in small parallel batches, so a window of sixteen samples is
  // two rounds of waiting rather than sixteen.
  const missing = wanted.filter((b) => !poolObs.has(b.toString()));
  let unreadable = 0;
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8);
    const rets = await Promise.all(batch.map(async (b) => {
      const tag = '0x' + b.toString(16);
      try {
        const [hdr, ret] = await Promise.all([
          blockAt(tag),
          callAt(POOL_ADDR, SEL.reserves, tag),
        ]);
        const body = String(ret || '').replace(/^0x/, '');
        // Three static words: resPeer, resBtc, totalShares. A short answer is
        // a block this host could not read, counted below and never
        // half-decoded into a reading that looks like a measurement.
        if (!hdr || body.length < 64 * 3) return null;
        return { block: b, ms: hdr.ms, resPeerRaw: word(ret, 0).toString(), resBtcRaw: word(ret, 1).toString() };
      } catch {
        // An endpoint that prunes state answers an error for old blocks. That
        // is a fact about the endpoint, counted and reported below, never a
        // reason to price the burn off whatever is left.
        return null;
      }
    }));
    for (const r of rets) {
      if (!r) { unreadable++; continue; }
      poolObs.set(r.block.toString(), r);
    }
  }
  // Bounded memory: the oldest observations go first, and they are the ones
  // no window will ask for again.
  if (poolObs.size > OBS_KEEP) {
    const keys = [...poolObs.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    for (const k of keys.slice(0, poolObs.size - OBS_KEEP)) poolObs.delete(k);
  }

  // ── The window ─────────────────────────────────────────────────────────
  //
  // Built from EXACTLY the blocks the grid named, and from nothing else.
  //
  // This used to read `[...poolObs.values()].filter(inside the window)`, which
  // is a different thing wearing the same name: poolObs is a process-lifetime
  // cache that accumulates every reading from every previous quote, so any
  // stray reading whose timestamp fell inside the window was folded into the
  // average. A host that had served quotes in the previous half hour priced a
  // burn differently from one that had not, the same host priced it
  // differently after a restart, and eviction (OBS_KEEP) could turn a
  // priceable burn into a stale one and back. The reserves in the act are
  // supposed to be a fact about a transaction, not a fact about this process's
  // memory. The cache is now purely an optimisation: it decides what has to be
  // FETCHED, never what is averaged.
  const samples = wanted
    .map((b) => poolObs.get(b.toString()))
    .filter((o) => o && o.ms <= ref.ms)
    .sort((a, b) => a.ms - b.ms || (a.block < b.block ? -1 : 1));
  out.observed = samples.length;
  out.blocks = samples.map((s) => Number(s.block));
  out.unreadable = unreadable;
  if (samples.length < 2) {
    return {
      ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
      why: 'this host has ' + samples.length + ' usable reading of the pool and needs at least ' + minObs
        + ' spread across ' + Math.round(windowMs / 60_000) + ' minutes'
        + (unreadable ? ' — ' + unreadable + ' historical block(s) were refused by this chain endpoint, which is what a node that keeps no old state answers' : '')
        + '. A spot price is whatever the last trade left behind, so a burn is refused rather than priced from one.',
    };
  }
  const span = ref.ms - samples[0].ms;
  out.twapMs = span;
  out.from = samples[0].ms;
  out.to = ref.ms;
  // The samples travel with the answer, so "time-weighted" is a claim with
  // its evidence attached: every block, its timestamp and the reserves read
  // at it, re-fetchable by anyone who doubts the average.
  out.samples = samples.map((s) => ({ block: Number(s.block), ms: s.ms, resPeerRaw: s.resPeerRaw, resBtcRaw: s.resBtcRaw }));
  if (samples.length < minObs) {
    return { ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
      why: 'the price came from ' + samples.length + ' observation(s) and at least ' + minObs + ' are required'
        + (unreadable ? ' — ' + unreadable + ' historical block(s) were refused by this chain endpoint' : '') };
  }
  if (span < windowMs) {
    return { ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
      why: 'the readings available cover ' + Math.round(span / 60_000) + ' minutes and at least '
        + Math.round(windowMs / 60_000) + ' are required — a spot price is whatever the last trade left behind' };
  }
  // A hole in the middle. Checked because the two floors above can both be
  // satisfied by a cluster of recent samples plus one old one, which is a
  // spot price with a long shadow rather than an average.
  const maxGap = windowMs * MAX_GAP_FRACTION;
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i].ms - samples[i - 1].ms;
    if (gap > maxGap) {
      return { ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
        why: 'the readings have a ' + Math.round(gap / 60_000) + '-minute hole in them, and a window with a hole is not a window — the price was unobserved for longer than this host is willing to average across' };
    }
  }
  if (ref.ms - samples[samples.length - 1].ms > maxGap) {
    return { ...out, ok: false, code: 'PEER_BURN_STALE_PRICE',
      why: 'the newest reading of the pool is older than this host will average up to the present from' };
  }

  // ── The weighted average ───────────────────────────────────────────────
  // Each observation stands until the next one, and the last stands to the
  // head. BigInt throughout: these are raw 18-decimal and 8-decimal integers,
  // and a double loses the low digits of the first one before any arithmetic
  // happens.
  let wPeer = 0n, wBtc = 0n, total = 0n;
  let minBtc = null;
  for (let i = 0; i < samples.length; i++) {
    const until = i + 1 < samples.length ? samples[i + 1].ms : ref.ms;
    const dur = BigInt(Math.max(0, Math.round(until - samples[i].ms)));
    if (dur === 0n) continue;
    wPeer += BigInt(samples[i].resPeerRaw) * dur;
    wBtc += BigInt(samples[i].resBtcRaw) * dur;
    total += dur;
    const b = BigInt(samples[i].resBtcRaw);
    if (minBtc === null || b < minBtc) minBtc = b;
  }
  if (total === 0n) {
    return { ...out, ok: false, code: 'PEER_BURN_STALE_PRICE', why: 'every reading of the pool carries the same timestamp, so there is no elapsed time to weight them by' };
  }
  // Against the burner in both directions: more PEER in the pool and less
  // bitcoin both mean fewer satoshis out. Rounding is never a gift here.
  const resPeer = (wPeer + total - 1n) / total;      // ceil
  const resBtc = wBtc / total;                       // floor
  out.resPeerRaw = resPeer.toString();
  out.resBtcRaw = resBtc.toString();
  out.minBtcRaw = (minBtc ?? 0n).toString();

  // ── The depth floor ────────────────────────────────────────────────────
  // Refused IN WORDS rather than priced badly. Checked on the average (which
  // is what the act records and what replay re-checks) and on the shallowest
  // moment in the window: a pool that was thin at any point did not have a
  // price for the whole of the window it is being averaged over, and the
  // averaging is what would hide that.
  //
  // Note what this floor is NOT: it is not a statement that a shallower pool
  // is illegitimate. Anyone may seed this pool at any size and anyone may add
  // to it, and PeerPool's own MIN_LIQ refuses only the degenerate wei-against-
  // satoshi case. This floor says something narrower — that below it, this
  // host will not treat the pool's ratio as a PRICE — and it stays exactly
  // where it was, because one pool does not make a thin one harder to push.
  const floor = BigInt(minPoolSats);
  // Nothing on either side, across the whole window: nobody had added
  // liquidity yet. Its own refusal rather than "too thin", because they are
  // different sentences with different fixes — a thin pool needs deposits to
  // grow, an unseeded one needs its FIRST deposit, which is also the act that
  // invents the opening price. Reporting "0 sat, floor 1,000,000" would be
  // arithmetically true and would describe a pool that does not exist yet.
  if (resPeer === 0n && resBtc === 0n) {
    return { ...out, ok: false, code: 'PEER_BURN_POOL_UNSEEDED',
      why: 'the pool at ' + POOL_ADDR + ' held nothing at all across this window — nobody has added liquidity to it. The first add sets the opening price out of the two amounts deposited, and until somebody makes it there is no ratio here to price a burn against.' };
  }
  if (resBtc < floor) {
    return { ...out, ok: false, code: 'PEER_BURN_THIN_POOL',
      why: 'the pool averaged ' + resBtc.toString() + ' sat of bitcoin across the window and a burn needs at least '
        + minPoolSats + ' — below that a pool has no price, only a last trade. The pool is real and usable at any size; it is the PRICING of a burn that this refuses, and every add of liquidity moves it toward the floor.' };
  }
  if (minBtc !== null && minBtc < floor) {
    return { ...out, ok: false, code: 'PEER_BURN_THIN_POOL',
      why: 'the pool fell to ' + minBtc.toString() + ' sat of bitcoin during the window, under the ' + minPoolSats
        + ' floor — the average hides that, so it is refused on the shallowest moment rather than the comfortable mean' };
  }
  if (resPeer <= 0n) {
    return { ...out, ok: false, code: 'PEER_BURN_THIN_POOL', why: 'the pool holds no PEER, so it prices nothing — either nobody has seeded it yet, or every unit of PEER has been swapped out of it' };
  }
  out.ok = true;
  out.note = 'time-weighted across ' + samples.length + ' readings of the pool at ' + POOL_ADDR + ' spanning '
    + Math.round(span / 60_000) + ' minutes of chain time, between blocks ' + out.startsAt + ' and ' + out.endsAt
    + '. The blocks read are not chosen by this host: the range is cut into ' + gridN
    + ' buckets and one block is taken from each at a position decided by the hash of block ' + out.endsAt
    + ' (' + out.refHash + '), so nobody — including whoever is about to burn — can know in advance which blocks will be read, and a price held for part of the window is sampled about that part of the time. Every reading is listed with its block, so the average is re-fetchable rather than asserted, and a burn is priced by the window ending at ITS OWN block, so a quote is what a burn made now would get and not a rate held open for anybody.';
  return out;
}

/**
 * THE PROOF: did this transaction really destroy that PEER, from that address?
 *
 * The bitcoin door asks two independent explorers and requires them to agree,
 * because an explorer is somebody's API and this host's economy must not sit
 * inside it. Here there is one RPC endpoint, and it is worth being plain that
 * this is a WEAKER arrangement rather than pretending the two doors are the
 * same shape: what protects a reader is that the act records the transaction
 * hash, so anyone can put the same question to any Base endpoint, or to their
 * own node, and get a yes or a no. A host that lied here would be lying in a
 * way that is checkable by everyone, forever.
 *
 * What is checked, and why each one is a way to steal reserve if it is not:
 *   - the chain id, so the "burn" is not on some other chain entirely;
 *   - the receipt exists and SUCCEEDED — a reverted transaction has logs of
 *     nothing and moved no coins;
 *   - the token is this host's PEER, not something else with a Transfer event
 *     (anyone can deploy a token, mint a trillion, and send it to the dead
 *     address for the price of gas);
 *   - the recipient is the dead address, summed across every matching log, so
 *     a transaction that burns in two legs is not under-credited;
 *   - and depth, because a transaction that can still be un-mined is not a
 *     burn yet.
 *
 * WHOSE burn it is, is deliberately NOT decided here. This function reports
 * the sender the chain names and stops. Ownership is a question about the act
 * log — which handle had bound that address, and when — and it is answered by
 * the engine, in replay, where a mirror or a fork cannot skip it. Deciding it
 * here was the shape of a real hole: the caller passed in the address bound to
 * whoever was asking, this function checked the transfer against that, and
 * nothing anywhere checked that the asker controlled it.
 *
 * The block's timestamp comes back too, because "the binding was already in
 * the log when the coins were destroyed" needs the time the coins were
 * destroyed, and the chain is the only honest source for it.
 */
export async function verifyPeerBurnTx(txid, { sink, minConf }) {
  const cfg = peerBurnConfig();
  if (!cfg.on) return { ok: false, code: 'PEERBURN_OFF', why: cfg.why };
  const tx = String(txid || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) {
    return { ok: false, code: 'BAD_TXID', why: 'a Base transaction hash is 0x followed by 64 hex characters' };
  }
  const dead = clean(sink);
  if (!dead) return { ok: false, code: 'PEERBURN_OFF', why: 'this host could not read the engine’s burn address and will not guess one' };
  const conf = Math.max(1, Number(minConf) || PEERBURN_MIN_CONF);
  try {
    const chain = await chainCheck();
    if (!chain.ok) return { ok: false, code: 'L2_UNREACHABLE', why: chain.error };
    const receipt = await rpc('eth_getTransactionReceipt', [tx]);
    if (!receipt || typeof receipt.blockNumber !== 'string') {
      return { ok: false, code: 'PEERBURN_UNVERIFIED',
        why: 'no mined transaction with that hash on chain ' + CHAIN_ID + ' — either it is still pending, it was replaced, or it is not on this chain. Nothing was recorded.' };
    }
    // status 0x0 is a transaction that ran and reverted. It is on the chain,
    // it cost gas, and it moved nothing: crediting it would credit a failure.
    if (receipt.status !== undefined && receipt.status !== null && BigInt(receipt.status) !== 1n) {
      return { ok: false, code: 'PEERBURN_UNVERIFIED', why: 'that transaction is on the chain but it FAILED — it reverted, so no PEER left your wallet and there is nothing to credit' };
    }
    const block = BigInt(receipt.blockNumber);
    const headHex = await rpc('eth_blockNumber', []);
    const head = BigInt(headHex);
    const depth = head >= block ? Number(head - block) + 1 : 0;
    // Summed PER SENDER. A transaction may carry burns from two addresses —
    // rare, but a contract call can — and crediting the total to one of them
    // would credit somebody for coins that were not theirs. The largest single
    // sender is reported and the rest is named, so the refusal can say so.
    const bySender = new Map();
    const otherTokens = new Set();
    for (const lg of (Array.isArray(receipt.logs) ? receipt.logs : [])) {
      const topics = lg && Array.isArray(lg.topics) ? lg.topics : [];
      if (topics.length < 3 || String(topics[0]).toLowerCase() !== TOPIC_TRANSFER) continue;
      const to = addrFromWord(topics[2]);
      if (to !== dead) continue;
      const token = clean(lg.address);
      if (token !== TOKEN_ADDR) { otherTokens.add(token || String(lg.address)); continue; }
      const src = addrFromWord(topics[1]);
      const amt = word(lg.data);
      if (amt === null || !src) continue;
      bySender.set(src, (bySender.get(src) || 0n) + amt);
    }
    if (!bySender.size) {
      if (otherTokens.size) {
        return { ok: false, code: 'PEERBURN_UNVERIFIED',
          why: 'that transaction sent ' + [...otherTokens].join(', ') + ' to the dead address, not this network’s PEER ('
            + TOKEN_ADDR + '). Anyone can deploy a token and destroy it; reserve is only created by destroying the one this host is configured with.' };
      }
      return { ok: false, code: 'PEERBURN_UNVERIFIED',
        why: 'that transaction moves no PEER to ' + dead + '. Nothing was recorded — a burn this host cannot see on the chain is a claim, and claims credit nothing.' };
    }
    let sender = null, burned = 0n;
    for (const [src, amt] of bySender) if (amt > burned) { sender = src; burned = amt; }
    if (depth < conf) {
      return { ok: false, code: 'PEERBURN_UNCONFIRMED', depth, needed: conf,
        why: 'that transaction is ' + depth + ' block' + (depth === 1 ? '' : 's') + ' deep and this host waits for ' + conf
          + ' — about ' + Math.max(1, Math.round(conf * 2 / 60)) + ' minute(s) on Base. It will be credited on its own once it is buried, with nothing open on your side.' };
    }
    // The block's own clock, which is what "the binding predates the burn" is
    // measured against. A header this endpoint cannot serve is a refusal, not
    // a reason to fall back to this host's wall clock — the recorder's own
    // clock is a number the recorder can make say anything.
    const hdr = await blockAt(receipt.blockNumber);
    if (!hdr || !(hdr.ms > 0)) {
      return { ok: false, code: 'PEERBURN_UNVERIFIED',
        why: 'this host could not read the header of block ' + Number(block) + ', so it cannot say WHEN those coins were destroyed — and whether an address binding came before or after a burn is the whole of who the burn belongs to. Nothing was recorded.' };
    }
    return { ok: true, txid: tx, amtRaw: burned.toString(), from: sender, addr: dead,
      block: Number(block), blockMs: hdr.ms, confirmations: depth,
      senders: bySender.size };
  } catch (e) {
    return { ok: false, code: 'L2_UNREACHABLE', why: 'could not read that transaction from the chain (' + String(e.message).slice(0, 60) + ') — try again shortly' };
  }
}

/**
 * Every PEER burn the chain has ever seen: Transfer logs of this host's token
 * whose recipient is the dead address.
 *
 * This is what makes closing the tab safe, and it is the same lesson the
 * bitcoin watcher was written from — two real burns sat unclaimed for four
 * days because a browser tab was closed. The bitcoin side needed an INTENT to
 * say whose a payment was, because a bitcoin output pays a script and nothing
 * in the transaction says "ender". Here it needs none: an ERC-20 Transfer
 * names its sender, and this network already binds handles to addresses for
 * epoch earnings. So ownership is decided by a binding that is already in the
 * public log, filed with the handle's own credential, rather than by a race
 * to describe somebody else's transaction first.
 *
 * Narrowed at the endpoint by the recipient topic, so a token with a busy
 * transfer history costs the same as a quiet one. Chunked and resumable
 * through the same walkLogs every other scan here uses; the memory is a cache
 * and the act log remains the only authority on what has been credited.
 */
export async function peerBurnsSeen({ sink }) {
  const cfg = peerBurnConfig();
  if (!cfg.on) return { on: false, why: cfg.why, rows: [] };
  const dead = clean(sink);
  if (!dead) return { on: false, why: 'this host could not read the engine’s burn address and will not guess one', rows: [] };
  const out = { on: true, token: TOKEN_ADDR, addr: dead, fromBlock: PEERBURN_FROM.hex };
  if (!PEERBURN_FROM.ok) out.fromBlockIgnored = PEERBURN_FROM.raw.slice(0, 40);
  try {
    const chain = await chainCheck();
    if (!chain.ok) return { ...out, rows: [], error: chain.error };
  } catch (e) {
    return { ...out, rows: [], error: 'could not reach the chain (' + String(e.message).slice(0, 60) + ')' };
  }
  const { scan, rows, walked } = await walkLogs({
    file: PEERBURN_SCAN_FILE,
    contract: TOKEN_ADDR,
    topic0: TOPIC_TRANSFER,
    // [from, to] — any sender, this recipient. The whole point of asking the
    // endpoint rather than filtering here.
    topicsRest: [null, '0x' + pad(dead)],
    from: PEERBURN_FROM,
    fromVar: 'PEER_PEERBURN_FROM_BLOCK',
    revive: (key, v) => (v && typeof v.from === 'string' && typeof v.amt === 'string' && /^[0-9]+$/.test(v.amt)
      ? { key, txid: key.split(':')[0], from: v.from, amtRaw: v.amt, block: Number(v.blk) || 0 }
      : null),
    take: (lg, map) => {
      const topics = lg && Array.isArray(lg.topics) ? lg.topics : [];
      if (topics.length < 3) return;
      const src = addrFromWord(topics[1]);
      const amt = word(lg.data);
      const txh = typeof lg.transactionHash === 'string' ? lg.transactionHash.toLowerCase() : '';
      if (!src || amt === null || amt <= 0n || !/^0x[0-9a-f]{64}$/.test(txh)) return;
      // One entry per (transaction, log index): a transaction may burn in two
      // legs, and both are real. Keyed rather than pushed so a re-served log
      // after a reorg is a duplicate the Map absorbs, not a double credit.
      const idx = typeof lg.logIndex === 'string' ? Number(BigInt(lg.logIndex)) : 0;
      map.set(txh + ':' + idx, { key: txh + ':' + idx, txid: txh, from: src, amtRaw: amt.toString(), block: Number(BigInt(lg.blockNumber || '0x0')) });
    },
  });
  const list = [...rows.values()].sort((a, b) => b.block - a.block || a.key.localeCompare(b.key));
  if (walked !== null) {
    const ids = {};
    for (const r of list) ids[r.key] = { from: r.from, amt: r.amtRaw, blk: r.block };
    const why = saveScan(PEERBURN_SCAN_FILE, TOKEN_ADDR, PEERBURN_FROM, walked, ids);
    scan.cursor = '0x' + walked.toString(16);
    if (why) scan.notSaved = 'the scan could not be saved (' + why + ') — every refresh will re-walk this range until it can';
  }
  out.scan = scan;
  out.rows = list;
  if (scan.failed && !list.length) {
    out.error = 'could not read PEER transfers to ' + dead + ' from ' + (scan.from || PEERBURN_FROM.hex)
      + ' (' + (scan.failedWhy || 'no reason given') + ') — so an empty list here says nothing about whether anyone has burned';
  }
  return out;
}
