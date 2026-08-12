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
//   PEER_BTC_ADDR      the BTC-representing ERC-20 (cbBTC on Base)
//   PEER_POOL_ADDR     the AMM pair/pool holding PEER + BTC
//   PEER_POOLS_ADDR    the PeerPools factory: named PEER/BTC pools
//   PEER_POOLS_FROM_BLOCK  first block to scan for PoolCreated (default 0)
//   PEER_ANCHOR_ADDR   the PeerAnchor contract: epoch ids and earnings roots,
//                      timestamped by the chain
//   PEER_CLAIM_ADDR    the PeerClaim contract: epoch earnings, claimable as
//                      real PEER against a published merkle root
//   PEER_EPOCH_FROM_BLOCK  first block to scan for Anchored and EpochOpened
//                      (default 0) — the same shape, and the same tradeoff, as
//                      PEER_POOLS_FROM_BLOCK below
//
// The two epoch contracts are OFF until their addresses are set, and the
// answer says so in words rather than by leaving a key out: `anchors` and
// `claimState` come back as { configured: false, why: … }, because "this host
// reads no anchors" and "this network has never anchored anything" are
// opposite sentences and a missing key blurs them. Same rule as the token
// itself — an address baked into source is one nobody verified.
//
// PEER_POOLS_FROM_BLOCK deserves its own paragraph. Pools are found by asking
// for the factory's PoolCreated logs, and the honest default range is the
// whole chain — no block number is baked into this source for the same reason
// no address is: it would be a number nobody verified. Public RPCs cap how
// wide ONE log query may be (Base's answers 9,999 blocks and refuses 10,000),
// so the scan below is chunked into windows under that cap and walks forward
// across as many of them as it needs. Setting this to the block your factory
// was deployed in does not switch the scan on — it shortens the one-time
// backfill from "the whole chain" to "the pools that exist", which is the
// difference between minutes and hours of catching up. Set too LATE it
// silently hides pools opened before it, so the reader reports the on-chain
// pool total next to what it actually found and a gap between the two is
// visible rather than inferred.
//
// This file writes files of its own, and none of them are on any chain: one
// scan memory per contract it discovers things from — which blocks it has
// already walked and what it saw in them — under the host's data directory:
//
//   server-data/pools-scan.json   PoolCreated,  from PEER_POOLS_ADDR
//   server-data/anchor-scan.json  Anchored,     from PEER_ANCHOR_ADDR
//   server-data/claim-scan.json   EpochOpened,  from PEER_CLAIM_ADDR
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
export const POOL_ADDR = clean(process.env.PEER_POOL_ADDR);
export const POOLS_ADDR = clean(process.env.PEER_POOLS_ADDR);
export const ANCHOR_ADDR = clean(process.env.PEER_ANCHOR_ADDR);
export const CLAIM_ADDR = clean(process.env.PEER_CLAIM_ADDR);
export const L2_ON = !!TOKEN_ADDR;

// Selectors: first 4 bytes of keccak256 of the signature in the comment.
// Hardcoded so this file needs no hashing library; recompute them yourself
// with `cast sig 'balanceOf(address)'` if you do not want to take them on
// trust — which you should not.
const SEL = {
  totalSupply: '0x18160ddd',  // totalSupply()
  balanceOf: '0x70a08231',    // balanceOf(address)
  decimals: '0x313ce567',     // decimals()
  symbol: '0x95d89b41',       // symbol()
  getReserves: '0x0902f1ac',  // getReserves()            — UniswapV2-style pair
  token0: '0x0dfe1681',       // token0()
  token1: '0xd21220a7',       // token1()
  // PeerPools factory — values from the compiler's own methodIdentifiers
  // table in PeerPools.build.json, not recomputed here.
  poolCount: '0xf525cb68',    // poolCount()
  poolInfo: '0x1526fe27',     // poolInfo(uint256)
  sharesOf: '0xe78307ca',     // sharesOf(uint256,address)
  poolsPeer: '0x11cda415',    // peer()                   — the factory's own PEER
  poolsBtc: '0xa28d57d8',     // btc()                    — the factory's own BTC
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
 * The PoolCreated topic0: keccak256 of the event signature, which is the
 * same rule as a 4-byte selector with all 32 bytes kept. Hardcoded for the
 * same reason the selectors are — this file grows no hashing library — and
 * the `indexed` markers are NOT part of the string it is taken over:
 *
 *   event PoolCreated(uint256 indexed id, bytes32 name, address indexed by,
 *                     uint256 amtPeer, uint256 amtBtc)
 *   hashed as: PoolCreated(uint256,bytes32,address,uint256,uint256)
 *
 * Verified twice rather than trusted once, because a wrong topic here is not
 * an error message, it is an empty pool list that looks like an empty
 * network. First: a from-scratch Keccak-256 that reproduces the canonical
 * ERC-20 Transfer topic (ddf252ad…) and every one of the eleven selectors in
 * PeerPools.build.json, which solc produced independently. Second: the
 * compiled PeerPools bytecode itself, run under @ethereumjs/vm — createPool
 * put exactly this word in topics[0]. Anyone can redo the second in one
 * command; tests/pools-onchain.test.ts already deploys that bytecode.
 */
const TOPIC_POOL_CREATED = '0xdbc17b6ce8216b142cb8dab25e6228bd0965d99cb4a9f8f2e45cd8e7df33df81';

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
const POOLS_FROM = fromBlockOf(process.env.PEER_POOLS_FROM_BLOCK);
// One from-block for both epoch contracts. They are deployed in the same
// sitting, minutes apart, and two variables here would be two chances to set
// the wrong one — the rule is the same as for pools, err LOW: too low costs
// a little scanning, too high silently hides anchors and epochs opened before
// it. Each scan's memory is keyed to its own contract, so sharing the
// variable does not mix the two.
const EPOCH_FROM = fromBlockOf(process.env.PEER_EPOCH_FROM_BLOCK);

/**
 * Two caps, both surfaced in the answer rather than applied quietly.
 *
 * READ_CAP is how many poolInfo eth_calls one refresh will spend: a factory
 * with ten thousand pools must not turn every cache miss into ten thousand
 * round trips against a public RPC. LIST_CAP is how many pools come back in
 * the payload — a list nobody scrolls is not a feature, and the deepest
 * pools are the ones a trade can actually fill. READ_CAP is deliberately
 * twice LIST_CAP: the list is ranked on CURRENT reserves, which are only
 * knowable by reading, so the reader must read more pools than it shows or
 * the ranking is decided by whatever the pre-filter guessed.
 *
 * Neither cap is allowed to be invisible: `total` is the factory's own
 * poolCount(), `discovered` is how many the log scan saw, `returned` is the
 * length of the list, and `truncated` says plainly that those numbers differ.
 * A cap you cannot see is indistinguishable from censorship, which is the
 * exact bug this whole path exists to fix.
 */
const READ_CAP = 64;
const LIST_CAP = 32;

/**
 * The same two caps for the epoch contracts, and one more for the memory.
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
 * returned, truncated — for the reason the pools list already gives: a cap you
 * cannot see is indistinguishable from censorship.
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
 * deploy block to 'latest' worked for exactly as long as the factory was
 * younger than 10,000 blocks — five and a half hours at Base's two-second
 * blocks — and then threw on every refresh forever, telling the operator to
 * set the variable they had already set correctly.
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
 * ids are a Map) rather than a pool nobody ever sees.
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
/** One memory per contract walked. See the header for what each holds. */
const POOLS_SCAN_FILE = join(DATA_DIR, 'pools-scan.json');
const ANCHOR_SCAN_FILE = join(DATA_DIR, 'anchor-scan.json');
const CLAIM_SCAN_FILE = join(DATA_DIR, 'claim-scan.json');

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
 * wrote before this file was shared with the two epoch contracts. Renaming it
 * to `contract` would be tidier and would throw away every live host's pools
 * memory on the deploy that landed it, for nothing: one whole-chain backfill
 * per host to improve a word nobody reads.
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
 * There used to be exactly one of these and it lived inside namedPools, which
 * was fine while pools were the only thing found by log. The moment a second
 * caller needed the same walk, copying it would have meant two window
 * chunkers, two cursors, two rewind rules and two ways to report a refused
 * window — and the pools one is the one that has already been wrong twice in
 * production (an unchunked query that died at 10,000 blocks; a cursor that
 * skipped past a refused window and left a permanent hole). Whatever is
 * learned about scanning is worth learning once.
 *
 * The caller supplies only what differs: which contract, which topic, where to
 * start, how to revive a remembered row, and what to do with a log. The
 * window width, the per-refresh budget, the reorg rewind, the stop-at-the-
 * first-refusal rule and every field of the `scan` report are the same for
 * everyone.
 *
 * Returns the rows (remembered ones already folded in, so a refused window
 * costs nothing that was learned earlier) and the `scan` block that says
 * plainly how much of the range this refresh actually covered.
 */
async function walkLogs({ file, contract, topic0, from, fromVar, revive, take }) {
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
          [{ address: contract, topics: [topic0], fromBlock: '0x' + cursor.toString(16), toBlock: '0x' + last.toString(16) }],
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

/** A bytes32 pool name back to the utf-8 someone typed: decode hex pairs and
 *  stop at the first NUL, because Solidity right-pads short names with zero
 *  bytes and the padding is not part of the name. The raw word travels
 *  alongside the decoded string everywhere this is used — a name is the
 *  pool's on-chain identity, and a caller who wants to call createPool's
 *  namesake or check uniqueness needs the exact 32 bytes, not our reading
 *  of them. */
function bytes32Name(hexWord) {
  const bytes = [];
  for (let i = 0; i + 2 <= hexWord.length && i < 64; i += 2) {
    const b = parseInt(hexWord.slice(i, i + 2), 16);
    if (b === 0) break;
    bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
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
  const out = { chainId: CHAIN_ID, rpc: RPC, token: TOKEN_ADDR, btc: BTC_ADDR || null, pool: POOL_ADDR || null };
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
  if (POOL_ADDR) {
    try {
      const res = await call(POOL_ADDR, SEL.getReserves);
      const r0 = word(res, 0), r1 = word(res, 1);
      const t0 = word(await call(POOL_ADDR, SEL.token0));
      if (r0 !== null && r1 !== null && t0 !== null) {
        // token0 is whichever address sorts lower; ask rather than assume.
        const token0 = '0x' + t0.toString(16).padStart(40, '0');
        const peerIs0 = token0 === TOKEN_ADDR;
        out.pool = {
          address: POOL_ADDR,
          peerReserveRaw: (peerIs0 ? r0 : r1).toString(),
          btcReserveRaw: (peerIs0 ? r1 : r0).toString(),
          note: 'reserves are raw integers; a price is only meaningful once both sides are non-zero',
        };
      }
    } catch (e) {
      // A v3 pool has no getReserves, and a wrong address has nothing at all.
      // Neither is fatal to reporting the token itself.
      out.pool = { address: POOL_ADDR, error: 'no UniswapV2-style reserves here (' + String(e.message).slice(0, 60) + ')' };
    }
  }
  if (POOLS_ADDR) {
    // Fenced exactly like POOL_ADDR above: a wrong or dead factory address
    // degrades to an error note under its own key and never takes the token
    // report down with it.
    try {
      out.namedPools = await namedPools(dec);
    } catch (e) {
      out.namedPools = { factory: POOLS_ADDR, error: 'could not read the pools factory (' + String(e.message).slice(0, 60) + ')' };
    }
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
 * The named-pools factory (PeerPools.sol): constant-product pools over the
 * one fixed PEER/BTC pair, each under a human-chosen bytes32 name. Several
 * pools of the same pair coexisting is deliberate — the network chose named
 * pools and accepts the liquidity fragmentation that comes with it.
 *
 * Pools are found from the PoolCreated LOG. They used to be found by walking
 * ids 0, 1, 2 … and stopping at 256, and that was a censorship hole with a
 * price tag on it: open 256 pools with dust — a few dollars of gas on Base,
 * total — and every id from 256 up, including the operator's real pool, is
 * never returned by this host again. Permanently, with no privileged
 * function anywhere in PeerPools to undo it, because there is no privileged
 * function anywhere in PeerPools. That property is worth keeping, so the
 * reader is what changes.
 *
 * Indexing by event and ranking by depth prices the attack in the one thing
 * dust cannot buy. To sit above a real pool in this list you must hold more
 * bitcoin in your pool than it holds in its own — at which point you have
 * not buried anybody, you have provided liquidity. Array position buys
 * nothing here; it is not read.
 *
 * "Hold", present tense, everywhere — including in the pre-filter that picks
 * which pools get read at all. It once ranked candidates by the opening
 * deposit in the PoolCreated log, which is a number an attacker writes once
 * and can take straight back out: open sixty-four pools with a real deposit,
 * drain them in the same block, and the log still says you are the deepest
 * liquidity on the factory for as long as the log exists. That inverted the
 * exact property this module advertises. Nothing on the ranking path reads an
 * opening amount now; see the pre-filter below for what the cap does and does
 * not buy.
 *
 * Every number a UI could mistake for "all of them" is reported next to what
 * it actually is: `total` from the factory's own poolCount(), `discovered`
 * from the scan, `returned` from the list, plus `skipped`, `unread` and the
 * `scan` block — windows walked, windows refused, how far behind the backfill
 * still is. A scan that only half happened must never look like a whole one.
 */
async function namedPools(peerDec) {
  const out = { factory: POOLS_ADDR };
  // poolCount() first, because it is one cheap word and it settles whether
  // this address is the factory at all. Nothing answering is NOT an empty
  // factory: an empty factory invites a first deposit and a wrong address
  // must not. The two sentences are kept apart here rather than blurred
  // into a zero.
  const countWord = word(await call(POOLS_ADDR, SEL.poolCount));
  if (countWord === null) {
    out.error =
      'nothing at ' + POOLS_ADDR + ' answered poolCount() on chain ' + CHAIN_ID +
      ' — that address is not a PeerPools factory. This is a misconfiguration to fix, not an empty pool list to deposit into.';
    return out;
  }
  const total = Number(countWord);

  // WHICH tokens? The factory's own immutables, not this host's env. The
  // decimals that scale every amount below must come from the same two
  // contracts a signed trade actually moves coins in; reading them off
  // PEER_BTC_ADDR while the transaction targets the factory's btc() is how
  // a display ends up a hundred million times wrong while looking fine.
  const fPeer = addrFromWord(await call(POOLS_ADDR, SEL.poolsPeer));
  const fBtc = addrFromWord(await call(POOLS_ADDR, SEL.poolsBtc));
  out.tokens = { peer: fPeer, btc: fBtc };
  const disagree = [];
  if (fPeer && TOKEN_ADDR && fPeer !== TOKEN_ADDR) disagree.push({ side: 'peer', factory: fPeer, configured: TOKEN_ADDR });
  if (fBtc && BTC_ADDR && fBtc !== BTC_ADDR) disagree.push({ side: 'btc', factory: fBtc, configured: BTC_ADDR });
  if (disagree.length) {
    // Neither address is silently preferred, because neither is obviously
    // right: an operator pointing a host at a factory over different tokens
    // than they configured is exactly the failure that looks like success.
    // The decimals below follow the FACTORY, since those are the coins that
    // move — and this field says so, naming both, so the operator can see
    // which of the two they got wrong.
    out.mismatch = {
      pairs: disagree,
      error: 'this factory trades tokens this host was not configured with — amounts below are scaled by the FACTORY’s tokens, because those are the coins a trade here actually moves. One of the two is wrong: fix PEER_TOKEN_ADDR / PEER_BTC_ADDR, or point PEER_POOLS_ADDR at the factory you meant.',
    };
  } else if (!fPeer || !fBtc) {
    // The cross-check is the whole point of asking; when it cannot be made,
    // say so rather than letting the env pass for confirmed.
    out.tokensNote =
      'this factory did not answer peer()/btc(), so the decimals below come from this host’s configured addresses with nothing to check them against';
  }
  // PEER at 18 and cbBTC at 8 are the expected answers, never the assumed
  // ones. tokenState already asked TOKEN_ADDR, so that call is not repeated
  // when the factory names the same token.
  out.peerDecimals = fPeer && fPeer !== TOKEN_ADDR ? await decimalsOf(fPeer, 18) : peerDec;
  out.btcDecimals = await decimalsOf(fBtc || BTC_ADDR, 8);

  // ── The scan ──────────────────────────────────────────────────────────
  //
  // Chunked, and it remembers. The whole range is walked in windows the
  // endpoint will serve (see WINDOW), forward from wherever the last refresh
  // stopped, with a budget of windows per refresh so a cold host with a
  // from-block of 0 catches up over several refreshes instead of hanging one.
  // In steady state that is one window: sixty-odd blocks of rewind plus the
  // minute of new chain since the last refresh.
  if (!POOLS_FROM.ok) out.fromBlockIgnored = POOLS_FROM.raw.slice(0, 40);
  out.fromBlock = POOLS_FROM.hex;
  out.discoveredBy = 'PoolCreated logs — never by array position, so no one can bury a pool by opening dust ones ahead of it';

  const { scan, rows: found, walked } = await walkLogs({
    file: POOLS_SCAN_FILE,
    contract: POOLS_ADDR,
    topic0: TOPIC_POOL_CREATED,
    from: POOLS_FROM,
    fromVar: 'PEER_POOLS_FROM_BLOCK',
    revive: (key, v) => (!/^[0-9]+$/.test(key) ? null : {
      id: Number(key),
      openTx: v && typeof v.tx === 'string' ? v.tx : null,
      // The bitcoin reserve this pool was last MEASURED at, not the amount it
      // was opened with. Only used to decide who gets read first when there
      // are more pools than reads; it is never displayed, because by the time
      // it is displayed it would be a stale number wearing a current one's
      // clothes.
      lastBtc: v && typeof v.btc === 'string' && /^[0-9]+$/.test(v.btc) ? v.btc : null,
    }),
    take: (lg, rows) => {
      const topics = lg && Array.isArray(lg.topics) ? lg.topics : [];
      if (topics.length < 3) return;
      const id = word(topics[1]); // topic1 = the indexed uint256 id
      if (id === null) return;
      const key = id.toString();
      const had = rows.get(key);
      // One entry per id, whatever the endpoint served: reorged and duplicated
      // logs are the endpoint's business, not the list's. A re-served log may
      // fill in a transaction hash we did not have; it never overwrites the
      // measured reserve, which came from the chain's current state.
      // The data words (name, amtPeer, amtBtc) are deliberately not read: the
      // name and the reserves both come from poolInfo, and the opening amounts
      // are the wash-tradeable number this ranking used to trust.
      rows.set(key, {
        id: Number(id),
        openTx: typeof lg.transactionHash === 'string' ? lg.transactionHash : (had ? had.openTx : null),
        // topic2 is the indexed creator, and it is deliberately not used: the
        // creator below comes from poolInfo, which is current state rather
        // than a log an endpoint chose to serve us.
        lastBtc: had ? had.lastBtc : null,
      });
    },
  });

  if (scan.failed && found.size === 0) {
    // Nothing scanned and nothing remembered: say so instead of showing an
    // empty factory. No fallback to the id walk on purpose either — the walk
    // is the hole, and a quiet fallback would restore it on exactly the
    // endpoints that force it.
    out.error =
      'could not read PoolCreated logs from ' + (scan.from || POOLS_FROM.hex) + ' (' + (scan.failedWhy || 'no reason given') + '). ' +
      'The scan asks in ' + WINDOW + '-block windows — the widest Base’s own endpoint serves — so this is not the whole-chain query it used to send: either this endpoint could not be reached, or it caps log ranges tighter than that and nothing here can widen it. ' +
      'Setting PEER_POOLS_FROM_BLOCK to the block the factory was deployed in shortens the backfill, which is the other reason a scan takes long enough to time out. ' +
      'This host will not fall back to walking pool ids 0,1,2… — that scan is censorable by anyone willing to open a few dust pools.';
    out.total = total;
    out.scan = scan;
    return out;
  }

  const candidates = [...found.values()];
  out.discovered = candidates.length;

  // ── Which pools get read ───────────────────────────────────────────────
  //
  // Reading poolInfo is the only way to learn a pool's CURRENT reserves, and
  // current reserves are what this list ranks on. When there are more pools
  // than READ_CAP reads to spend, something has to choose, and that chooser
  // is the whole security of the ranking: whatever it trusts is what an
  // attacker forges.
  //
  // It used to trust the opening deposit out of the log, which costs an
  // attacker nothing to fake — deposit, drain, and the log still says you are
  // deep. So the choice is made from two things a flood cannot rewrite:
  //
  //   1. What the reserve MEASURED at, last time this host read the pool.
  //      A pool that really holds bitcoin keeps its slot however many pools
  //      are opened around it; a whale that drained itself measures near zero
  //      on the next refresh and falls out. This is the property the module
  //      claims, and it is now the one doing the work.
  //   2. Most-recent-first, for ids never read yet. It buys exactly one
  //      thing: it cannot be forged RETROACTIVELY — no amount of spending
  //      today puts you ahead of a pool opened tomorrow. It does NOT stop
  //      somebody opening READ_CAP/4 pools right now to crowd out this
  //      round's newcomers; nothing cheap does, and pretending otherwise is
  //      how the old pre-filter got written. What limits that attack is (1):
  //      the pools they crowd out get read on a later refresh, and once read
  //      a pool with real depth is never crowded out again.
  //
  // Measured pools take priority up to three quarters of the budget; the last
  // quarter is held for ids never read, so a genuinely new pool is not starved
  // by a factory full of known ones. Whatever either side does not use goes to
  // the other, so on any factory with fewer than READ_CAP pools none of this
  // arithmetic runs at all and everything is read.
  const known = candidates.filter((c) => c.lastBtc !== null);
  const fresh = candidates.filter((c) => c.lastBtc === null);
  known.sort((a, b) => {
    const x = BigInt(a.lastBtc), y = BigInt(b.lastBtc);
    return x === y ? b.id - a.id : x > y ? -1 : 1;
  });
  fresh.sort((a, b) => b.id - a.id);
  let unread = 0;
  let chosen = candidates;
  if (candidates.length > READ_CAP) {
    const NEW_FLOOR = Math.max(1, Math.floor(READ_CAP / 4));
    const knownTake = Math.min(known.length, READ_CAP - Math.min(fresh.length, NEW_FLOOR));
    const freshTake = Math.min(fresh.length, READ_CAP - knownTake);
    chosen = [...known.slice(0, knownTake), ...fresh.slice(0, freshTake)];
    unread = candidates.length - chosen.length;
    out.preFilteredBy =
      'more pools than this refresh reads: ' + knownTake + ' chosen by the bitcoin reserve each was last measured at, ' +
      freshTake + ' by most-recently-opened among ids never read here. Opening amounts are not consulted — they can be deposited and withdrawn in the same block.';
  }

  // Read in small parallel batches. Sixty-four sequential round trips to a
  // public endpoint is most of a minute with the whole host waiting on it;
  // eight at a time is eight waits, and no endpoint minds eight.
  const pools = [];
  let skipped = 0;
  for (let i = 0; i < chosen.length; i += 8) {
    const batch = chosen.slice(i, i + 8);
    const rets = await Promise.all(
      batch.map((c) => call(POOLS_ADDR, SEL.poolInfo + padUint(c.id)).catch(() => null)),
    );
    rets.forEach((ret, k) => {
      const c = batch[k];
      const body = String(ret || '').replace(/^0x/, '');
      // Five static words now: name, resPeer, resBtc, totalShares, creator.
      // A short body is a pool this host could NOT read — it is counted, not
      // skipped in silence, because "we saw fewer" and "there are fewer" are
      // different sentences.
      if (body.length < 64 * 5) { skipped++; return; }
      const nameHex = body.slice(0, 64);
      pools.push({
        id: c.id,
        name: bytes32Name(nameHex),
        nameRaw: '0x' + nameHex,
        resPeerRaw: word(ret, 1).toString(),
        resBtcRaw: word(ret, 2).toString(),
        totalSharesRaw: word(ret, 3).toString(),
        // Provenance, and the only thing that tells two pools with the same
        // name apart: names in PeerPools are claimed per creator, so a bare
        // name shown without whose it is would be a lie by omission.
        creator: addrFromWord(ret, 4),
        openTx: c.openTx,
      });
    });
  }

  // Deepest bitcoin reserve first — the pool a trade can actually fill —
  // with the id as a tiebreak so the order never depends on the endpoint's.
  pools.sort((a, b) => {
    const x = BigInt(a.resBtcRaw), y = BigInt(b.resBtcRaw);
    return x === y ? a.id - b.id : x > y ? -1 : 1;
  });
  out.pools = pools.slice(0, LIST_CAP);
  out.returned = out.pools.length;
  out.total = total;
  out.skipped = skipped;
  out.unread = unread;
  out.truncated = out.returned < total;
  out.rankedBy = 'BTC reserve as it stands right now, deepest first — never the amount a pool was opened with';

  // What this refresh learned, handed to the next one. Every id that has ever
  // been seen is kept, including the ones no read was spent on this round —
  // dropping them would re-discover them from the chain every refresh, which
  // is the unbounded scan this whole section exists to end. Reserves are
  // written only for pools actually read, and they are the numbers just
  // measured, so the pre-filter above ranks on measurement rather than on
  // anything anybody wrote into a log.
  if (walked !== null) {
    const ids = {};
    for (const c of candidates) {
      const row = {};
      if (c.openTx) row.tx = c.openTx;
      if (c.lastBtc) row.btc = c.lastBtc;
      ids[String(c.id)] = row;
    }
    for (const p of pools) ids[String(p.id)] = { ...(ids[String(p.id)] || {}), btc: p.resBtcRaw };
    const why = saveScan(POOLS_SCAN_FILE, POOLS_ADDR, POOLS_FROM, walked, ids);
    scan.cursor = '0x' + walked.toString(16);
    scan.remembering = candidates.length;
    if (why) scan.notSaved = 'the scan could not be saved (' + why + ') — every refresh will re-walk this range until it can';
  }
  out.scan = scan;

  if (out.truncated || scan.failed || scan.complete === false) {
    out.note =
      'showing ' + out.returned + ' of ' + total + ' pools on this factory, deepest first. ' +
      (unread ? unread + ' were seen but not read this round; ' : '') +
      (skipped ? skipped + ' would not answer poolInfo; ' : '') +
      (scan.failed ? 'a log window (' + (scan.failedAt || 'the chain head') + ') was refused, so anything opened in it is not here yet; ' : '') +
      (scan.backfill || scan.aheadOfHead ? (scan.backfill || scan.aheadOfHead) + '; ' : '') +
      (out.discovered < total
        ? (total - out.discovered) + ' were never seen — PEER_POOLS_FROM_BLOCK may start after they were opened, or this endpoint no longer serves logs that old; '
        : '') +
      'a pool missing from this list is still perfectly usable by anyone who has its id.';
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
  // as poolCount() above: "no anchors yet" and "wrong address" are different
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
 * already been paid out of it. Same rule as the pools reader: logs say what
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
    // The same refusal-to-guess as namedPools' mismatch: neither address is
    // silently preferred, because a claim contract paying a different coin
    // than this host reports is exactly the failure that looks like success.
    out.mismatch = {
      contract: tk,
      configured: TOKEN_ADDR,
      error: 'this claim contract pays a DIFFERENT token than this host is configured with. Its token address is immutable, so one of the two is wrong and it cannot be corrected here: fix PEER_TOKEN_ADDR, or point PEER_CLAIM_ADDR at the contract you meant.',
    };
  }
  // What the contract holds right now, asked of the token the CONTRACT names
  // rather than the one this host was configured with — those are the coins a
  // claim here actually moves, the same reason namedPools scales by the
  // factory's own pair. Asking the configured token would answer the balance
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

/** One account's shares in one named pool, straight off the factory. Shares
 *  are internal accounting inside PeerPools, not a token — there is no
 *  ERC-20 to ask, so this reader is the only way to see them. The encoding
 *  is the house encoder again: selector, a uint256 word for the pool id, a
 *  left-padded address. Raw string only; a share count has no decimals to
 *  humanise by. */
export async function sharesOf(poolId, addr) {
  const a = clean(addr);
  const id = Number(poolId);
  // Garbage is refused before the network is touched; the chain is checked
  // before an answer is given. Same gate as balanceOf, same reason.
  if (!POOLS_ADDR || !a || !Number.isInteger(id) || id < 0) return null;
  const chain = await chainCheck();
  if (!chain.ok) return { poolId: id, address: a, chainIdSeen: chain.seen, chainIdMatches: false, error: chain.error };
  const raw = word(await call(POOLS_ADDR, SEL.sharesOf + padUint(id) + pad(a)));
  if (raw === null) return null;
  return { poolId: id, address: a, raw: raw.toString() };
}
