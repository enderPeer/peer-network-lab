/**
 * The anchor and claim paths in chain-l2/onchain.mjs, exercised without a
 * chain: global fetch is replaced by a dispatcher answering exactly the
 * JSON-RPC calls tokenState() is expected to make, from canned hex — the same
 * seam tests/onchain-pools-decode.test.ts uses for the pools factory.
 *
 * What is asserted is the decoding, the DISCOVERY and the refusals:
 *
 * - THE TWO EVENT TOPICS. A wrong topic0 is not an error message; it is an
 *   empty list that looks exactly like a network which has never anchored an
 *   epoch. The constants are written out here independently of the module, so
 *   the two have to agree — and then pinned, in the last block of this file,
 *   against topics[0] as the COMPILED CONTRACTS emit it under @ethereumjs/vm.
 *   Nothing in this repo hashes them at runtime, so this is the check that
 *   they were hashed correctly once.
 * - Anchors are read from the log and nothing is read back per anchor: a row
 *   is immutable by contract (one per poster per epoch, forever), so the
 *   scan's memory IS the answer. Claim epochs are the opposite — root, total,
 *   PAID, deadline and open are re-read from epochInfo every refresh, because
 *   `paid` moves with every claim and an opening log would show a full pot to
 *   somebody whose claim had already come out of it.
 * - The scan is the SAME chunked, resumable one the pools factory walks:
 *   windows under the endpoint's cap, a cursor persisted per contract, a
 *   refused window that keeps what was already found and names itself.
 * - Off is off, and says so. With no address configured, `anchors` and
 *   `claimState` come back as { configured: false, why } rather than missing —
 *   "this host reads no anchors" and "nothing was ever anchored" are opposite
 *   claims and an absent key lets an interface render either as the other.
 * - A wrong address is not an empty contract. An address that will not answer
 *   anchorOf() or token() is reported as a misconfiguration, never as a
 *   network with nothing to claim.
 * - Per-account claim flags never enter the shared 30-second cache. The last
 *   block runs a real host process against a fake endpoint to prove it: the
 *   anchors and epochs are cached for everybody, `claimed` is asked per
 *   request and attached to that request's account alone.
 *
 * Selectors are the compiler's own, out of the two build.json files, and the
 * epoch numbers are decimal strings throughout — an epoch number in an anchor
 * is whatever a stranger typed, and 2^255 rounded through a float would print
 * a number nobody anchored.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOKEN = '0x' + '11'.repeat(20);
const ANCHOR = '0x' + '33'.repeat(20);
const CLAIM = '0x' + '44'.repeat(20);
const STEWARD = '0x' + '55'.repeat(20);
const ALICE = '0x' + 'a1'.repeat(20);
const BOB = '0x' + 'b0'.repeat(20);
// Deliberately not a byte that appears in any hash below: the last test
// asserts this address does NOT appear in a body nobody asked it about, and a
// collision with a block id would make that assertion pass or fail for the
// wrong reason.
const WHO = '0x' + '7e'.repeat(20);

// Env before the import: onchain.mjs reads it once, at module load.
const DATA_TMP = mkdtempSync(join(tmpdir(), 'peer-epoch-scan-'));
const ANCHOR_SCAN = join(DATA_TMP, 'anchor-scan.json');
const CLAIM_SCAN = join(DATA_TMP, 'claim-scan.json');
process.env.PEER_DATA_DIR = DATA_TMP;
process.env.PEER_TOKEN_ADDR = TOKEN;
process.env.PEER_ANCHOR_ADDR = ANCHOR;
process.env.PEER_CLAIM_ADDR = CLAIM;
delete process.env.PEER_POOLS_ADDR; // pools have their own file; this one is epochs
delete process.env.PEER_POOL_ADDR;
delete process.env.PEER_BTC_ADDR;
delete process.env.PEER_L2_RPC; // default RPC; fetch is stubbed, nothing leaves
delete process.env.PEER_L2_CHAIN_ID;
delete process.env.PEER_EPOCH_FROM_BLOCK;

const m = await import('../chain-l2/onchain.mjs');

afterAll(() => {
  try { rmSync(DATA_TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const anchorBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerAnchor.build.json', import.meta.url), 'utf8'));
const claimBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerClaim.build.json', import.meta.url), 'utf8'));

// ERC-20 selectors, hardcoded with their signatures like everywhere else.
const SEL_DECIMALS = '0x313ce567'; //    decimals()
const SEL_TOTAL_SUPPLY = '0x18160ddd'; //totalSupply()
const SEL_BALANCE_OF = '0x70a08231'; //  balanceOf(address)
// PeerAnchor / PeerClaim, straight out of the compiler's methodIdentifiers.
const SEL_ANCHOR_OF = '0x' + anchorBuild.hashes['anchorOf(address,uint256)'];
const SEL_TOKEN = '0x' + claimBuild.hashes['token()'];
const SEL_STEWARD = '0x' + claimBuild.hashes['steward()'];
const SEL_EPOCH_INFO = '0x' + claimBuild.hashes['epochInfo(uint256)'];
const SEL_CLAIMED = '0x' + claimBuild.hashes['claimed(uint256,address)'];

/**
 * The two topics, written out here independently of the module under test.
 * `indexed` is not part of the hashed string and neither are argument names:
 *
 *   Anchored(address,uint256,bytes32,bytes32,uint64)
 *   EpochOpened(uint256,bytes32,uint256,uint64)
 *
 * The last describe block in this file proves both against the compiled
 * bytecode itself, so nothing here rests on a hash anybody typed.
 */
const TOPIC_ANCHORED = '0x86ec5f6efee73f1d5be0ac8a6f8bb4bba87bd4f8caf2edd1fd79943f42518077';
const TOPIC_EPOCH_OPENED = '0x545340447d4e1b1c96be9168286c525d0b7b3996b05be777a65d4d42dfe1d708';

const uint = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
/** A 64-char hex hash, as chain/block.mjs and chain/merkle.mjs write them. */
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const BLOCK_ID_12 = hash('ab');
const ROOT_12 = hash('cd');
const BLOCK_ID_13 = hash('ef');
const ROOT_13 = hash('12');
const SUPPLY = 18_250_000n * 10n ** 18n;
const E18 = 10n ** 18n;

type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string };

/** An Anchored log as an endpoint would serve it: poster and epoch indexed,
 *  the two commitments and the chain's timestamp in the data words. */
const anchorLog = (by: string, epoch: bigint, blockId: string, root: string, at: bigint, blk: number): Log => ({
  address: ANCHOR,
  topics: [TOPIC_ANCHORED, '0x' + addrWord(by), '0x' + uint(epoch)],
  data: '0x' + blockId + root + uint(at),
  transactionHash: '0x' + uint(epoch).slice(0, 62) + 'aa',
  blockNumber: hex(blk),
});

/** An EpochOpened log: epoch indexed, the rest in data — none of which this
 *  reader uses, because epochInfo is where the current numbers live. */
const epochLog = (epoch: bigint, root: string, total: bigint, until: bigint, blk: number): Log => ({
  address: CLAIM,
  topics: [TOPIC_EPOCH_OPENED, '0x' + uint(epoch)],
  data: '0x' + root + uint(total) + uint(until),
  transactionHash: '0x' + uint(epoch).slice(0, 62) + 'bb',
  blockNumber: hex(blk),
});

/** The five static words epochInfo promises, in the contract's own order. */
const info5 = (root: string, total: bigint, paid: bigint, until: bigint, open: boolean) =>
  '0x' + root + uint(total) + uint(paid) + uint(until) + uint(open ? 1n : 0n);

let routes: Map<string, string>;
let logs: Log[] | Error;
let chainIdHex: string;
let seen: Array<{ to: string; data: string }>;
let logQueries: Array<Record<string, unknown>>;
let headBlock: bigint;
let failLogsFrom: bigint | null;
const HEAD_DEFAULT = 2000n;
const route = (to: string, data: string, result: string) =>
  routes.set(to.toLowerCase() + '|' + data.toLowerCase(), result);

const NOW = 1_800_000_000n;
// Thirty days, because PeerClaim.openEpoch refuses a window shorter than
// MIN_WINDOW (7 days) — "the steward cannot sweep early" means nothing without
// a floor, since the steward also picks the deadline. It was one day here,
// which the contract now rejects, and the block at the bottom of this file
// runs the real bytecode.
const UNTIL = NOW + 30n * 86_400n;

beforeEach(() => {
  routes = new Map();
  seen = [];
  logQueries = [];
  headBlock = HEAD_DEFAULT;
  failLogsFrom = null;
  // Each scan's memory is per host, not per test: left in place it would let
  // one test's discoveries decide the next one's list.
  for (const f of [ANCHOR_SCAN, CLAIM_SCAN]) { try { rmSync(f, { force: true }); } catch { /* never existed */ } }
  chainIdHex = '0x2105'; // 8453 — Base, the default the module expects
  route(TOKEN, SEL_DECIMALS, '0x' + uint(18));
  route(TOKEN, SEL_TOTAL_SUPPLY, '0x' + uint(SUPPLY));
  // The anchor contract answers anchorOf for the zero probe: three words.
  route(ANCHOR, SEL_ANCHOR_OF + addrWord('0x' + '00'.repeat(20)) + uint(0), '0x' + uint(0) + uint(0) + uint(0));
  route(CLAIM, SEL_TOKEN, '0x' + addrWord(TOKEN));
  route(CLAIM, SEL_STEWARD, '0x' + addrWord(STEWARD));
  route(TOKEN, SEL_BALANCE_OF + addrWord(CLAIM), '0x' + uint(900n * E18));
  route(CLAIM, SEL_EPOCH_INFO + uint(12), info5(ROOT_12, 500n * E18, 120n * E18, UNTIL, true));
  route(CLAIM, SEL_EPOCH_INFO + uint(13), info5(ROOT_13, 400n * E18, 0n, UNTIL, true));
  logs = [
    anchorLog(STEWARD, 12n, BLOCK_ID_12, ROOT_12, NOW, 1000),
    anchorLog(STEWARD, 13n, BLOCK_ID_13, ROOT_13, NOW + 60n, 1030),
    epochLog(12n, ROOT_12, 500n * E18, UNTIL, 1001),
    epochLog(13n, ROOT_13, 400n * E18, UNTIL, 1031),
  ];
});

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (url: unknown, init: { body: string }) => {
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url as string, init as RequestInit);
  const body = JSON.parse(init.body);
  let result: unknown;
  if (body.method === 'eth_chainId') {
    result = chainIdHex;
  } else if (body.method === 'eth_blockNumber') {
    result = hex(headBlock);
  } else if (body.method === 'eth_getLogs') {
    const q = body.params[0] as { fromBlock: string; toBlock: string; address: string; topics: string[] };
    logQueries.push(q);
    if (logs instanceof Error) throw logs;
    if (failLogsFrom !== null && BigInt(q.fromBlock) >= failLogsFrom) throw new Error('this window was refused');
    const from = BigInt(q.fromBlock), to = BigInt(q.toBlock);
    // Serve only what the query actually asked for — this contract, this
    // topic, this window. An endpoint that returned everything regardless
    // would let a wrong topic or a broken chunker pass unnoticed.
    result = (logs as Log[]).filter(
      (l) => l.address.toLowerCase() === String(q.address).toLowerCase() &&
        l.topics[0] === q.topics[0] &&
        BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to,
    );
  } else if (body.method === 'eth_call') {
    const { to, data } = body.params[0];
    seen.push({ to, data });
    const hit = routes.get(String(to).toLowerCase() + '|' + String(data).toLowerCase());
    if (hit === undefined) throw new Error('unexpected eth_call: ' + to + ' ' + data);
    result = hit;
  } else {
    throw new Error('unexpected rpc method: ' + body.method);
  }
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
});

describe('anchors — a timestamp over two hashes, and nothing more', () => {
  it('decodes both anchors from the log, newest first, with the chain’s own second', async () => {
    const a = (await m.tokenState()).anchors;
    expect(a.contract).toBe(ANCHOR);
    expect(a.discovered).toBe(2);
    expect(a.returned).toBe(2);
    expect(a.truncated).toBe(false);
    expect(a.anchors[0]).toEqual({
      by: STEWARD.toLowerCase(),
      epoch: '13',
      blockId: BLOCK_ID_13,
      earningsRoot: ROOT_13,
      at: Number(NOW + 60n),
      tx: anchorLog(STEWARD, 13n, BLOCK_ID_13, ROOT_13, NOW + 60n, 1030).transactionHash,
      block: 1030,
    });
    expect(a.anchors[1].epoch).toBe('12');
    // Bare lowercase hex, no 0x — the shape chain/block.mjs and
    // chain/merkle.mjs write, so checking an anchor against the log is a
    // string comparison rather than a de-prefixing exercise.
    expect(a.anchors[1].blockId).toBe(BLOCK_ID_12);
    expect(a.anchors[1].blockId.startsWith('0x')).toBe(false);
    expect(a.anchors[1].blockId).toHaveLength(64);
    // And it never claims the anchor means more than it does.
    expect(a.meaning).toMatch(/timestamp over two hashes/);
    expect(a.meaning).toMatch(/anyone may post/i);
  });

  it('asks for exactly the anchor contract and exactly the Anchored topic', async () => {
    await m.tokenState();
    const q = logQueries.filter((x) => String(x.address).toLowerCase() === ANCHOR);
    expect(q).toHaveLength(1);
    expect(q[0]!.topics).toEqual([TOPIC_ANCHORED]);
    expect(q[0]!.fromBlock).toBe('0x0');
    expect(q[0]!.toBlock).toBe(hex(HEAD_DEFAULT)); // never 'latest'
  });

  it('spends no eth_call per anchor: the log carries a row the contract can never revise', async () => {
    await m.tokenState();
    // The one call to the anchor contract is the existence probe, and nothing
    // else. Reading anchorOf per row would be a round trip for an answer that
    // cannot have changed since it was logged.
    const calls = seen.filter((c) => c.to.toLowerCase() === ANCHOR);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data.startsWith(SEL_ANCHOR_OF)).toBe(true);
  });

  it('keeps an epoch number as a decimal string, so a hostile one cannot round', async () => {
    // Anyone may anchor any epoch number. Through a float, 2^255 prints as a
    // number nobody anchored — and a UI would show it beside the real ones.
    const huge = (1n << 255n) + 7n;
    logs = [anchorLog(BOB, huge, BLOCK_ID_12, ROOT_12, NOW, 1500)];
    const a = (await m.tokenState()).anchors;
    expect(a.anchors[0].epoch).toBe(huge.toString());
    expect(typeof a.anchors[0].epoch).toBe('string');
  });

  it('counts the posters, so a flood is arithmetic rather than a hunch', async () => {
    // Nothing ranks anchors by cost — there is no depth here to buy — so the
    // honest defence is to make a crowded list visibly crowded.
    logs = [];
    for (let i = 0; i < 40; i++) (logs as Log[]).push(anchorLog(BOB, BigInt(i), BLOCK_ID_12, ROOT_12, NOW, 1100 + i));
    (logs as Log[]).push(anchorLog(STEWARD, 99n, BLOCK_ID_13, ROOT_13, NOW, 1500));
    const a = (await m.tokenState()).anchors;
    expect(a.discovered).toBe(41);
    expect(a.returned).toBe(32); // the list cap, and it says so
    expect(a.truncated).toBe(true);
    expect(a.posters).toBe(2);
    expect(a.busiestPoster).toEqual({ by: BOB.toLowerCase(), anchors: 40 });
    expect(a.note).toMatch(/showing 32 of 41 anchors/);
    // The newest is the operator's, and it is still first — newest-first is
    // the ordering, and the flood below it does not displace it.
    expect(a.anchors[0].by).toBe(STEWARD.toLowerCase());
  });

  it('does not report an address that answers nothing as a network with no anchors', async () => {
    routes.delete(ANCHOR + '|' + (SEL_ANCHOR_OF + addrWord('0x' + '00'.repeat(20)) + uint(0)).toLowerCase());
    const a = (await m.tokenState()).anchors;
    expect(a.error).toMatch(/not a PeerAnchor contract/);
    expect(a.anchors).toBeUndefined();
    // And the token half of the report is untouched by it.
    expect((await m.tokenState()).totalSupplyRaw).toBe(SUPPLY.toString());
  });

  it('refuses to call an empty list an answer when every window was rejected', async () => {
    logs = new Error('endpoint refused');
    const a = (await m.tokenState()).anchors;
    expect(a.error).toMatch(/could not read Anchored logs/);
    expect(a.error).toMatch(/PEER_EPOCH_FROM_BLOCK/);
    expect(a.error).toMatch(/not evidence that nothing was anchored/);
    expect(a.anchors).toBeUndefined();
  });
});

describe('claim epochs — what is owed, read live rather than from the opening log', () => {
  it('decodes each epoch from epochInfo, with the remainder computed and the deadline kept', async () => {
    const c = (await m.tokenState()).claimState;
    expect(c.contract).toBe(CLAIM);
    expect(c.token).toBe(TOKEN);
    expect(c.steward).toBe(STEWARD.toLowerCase());
    expect(c.mismatch).toBeUndefined();
    expect(c.discovered).toBe(2);
    expect(c.returned).toBe(2);
    expect(c.epochs[0]).toEqual({
      epoch: '13',
      root: ROOT_13,
      totalRaw: (400n * E18).toString(),
      paidRaw: '0',
      remainingRaw: (400n * E18).toString(),
      claimUntil: Number(UNTIL),
      open: true,
      openedTx: epochLog(13n, ROOT_13, 400n * E18, UNTIL, 1031).transactionHash,
      openedBlock: 1031,
    });
    // Epoch 12 is partly claimed, and the arithmetic is exact: these are
    // strings past Number.MAX_SAFE_INTEGER and a float would already have
    // rounded them.
    expect(c.epochs[1].paidRaw).toBe((120n * E18).toString());
    expect(c.epochs[1].remainingRaw).toBe((380n * E18).toString());
    expect(c.heldRaw).toBe((900n * E18).toString());
    expect(c.heldIs).toMatch(/every epoch it has open/);
  });

  it('reads paid from the chain every refresh, never from the log that opened the epoch', async () => {
    const first = (await m.tokenState()).claimState;
    expect(first.epochs[1].paidRaw).toBe((120n * E18).toString());
    // Somebody claims. The opening log has not changed and never will; the
    // contract's answer has.
    route(CLAIM, SEL_EPOCH_INFO + uint(12), info5(ROOT_12, 500n * E18, 500n * E18, UNTIL, true));
    const again = (await m.tokenState()).claimState;
    const e12 = again.epochs.find((e: { epoch: string }) => e.epoch === '12');
    expect(e12.paidRaw).toBe((500n * E18).toString());
    expect(e12.remainingRaw).toBe('0');
  });

  it('says what the steward is and is not, in the contract’s own words', async () => {
    const c = (await m.tokenState()).claimState;
    expect(c.stewardIs).toMatch(/cannot mint/);
    expect(c.stewardIs).toMatch(/cannot .*alter or re-open a published root/);
    expect(c.stewardIs).toMatch(/sweep early/);
    expect(c.unboundHandles).toMatch(/no leaf/);
    expect(c.unboundHandles).toMatch(/not redistributed/);
  });

  it('names a claim contract that pays a different token instead of scaling by the wrong one', async () => {
    const other = '0x' + '99'.repeat(20);
    route(CLAIM, SEL_TOKEN, '0x' + addrWord(other));
    route(other, SEL_BALANCE_OF + addrWord(CLAIM), '0x' + uint(42n));
    const c = (await m.tokenState()).claimState;
    expect(c.token).toBe(other);
    // The holding is read from the coin the CONTRACT names, not the one this
    // host was configured with — asking the configured token would report the
    // balance of a coin nobody here can claim, in exactly the case this
    // mismatch is warning about.
    expect(c.heldRaw).toBe('42');
    expect(c.mismatch.contract).toBe(other);
    expect(c.mismatch.configured).toBe(TOKEN);
    expect(c.mismatch.error).toMatch(/DIFFERENT token/);
    expect(c.mismatch.error).toMatch(/immutable/);
    // Still reports the epochs: the mismatch is named, not used as a reason
    // to show nothing.
    expect(c.epochs).toHaveLength(2);
  });

  it('drops an epoch the contract does not have, rather than listing a zero root as claimable', async () => {
    // A reorged or invented log. The log says epoch 14 opened; the contract
    // says there is no such epoch (root zero is the existence test).
    (logs as Log[]).push(epochLog(14n, hash('00'), 1n, UNTIL, 1040));
    route(CLAIM, SEL_EPOCH_INFO + uint(14), info5('0'.repeat(64), 0n, 0n, 0n, false));
    const c = (await m.tokenState()).claimState;
    expect(c.discovered).toBe(3);
    expect(c.returned).toBe(2);
    expect(c.skipped).toBe(1);
    expect(c.epochs.map((e: { epoch: string }) => e.epoch)).toEqual(['13', '12']);
    expect(c.note).toMatch(/came back with no root/);
  });

  it('counts a four-word epochInfo as unread rather than half-decoding it', async () => {
    route(CLAIM, SEL_EPOCH_INFO + uint(13), '0x' + ROOT_13 + uint(1n) + uint(0n) + uint(UNTIL));
    const c = (await m.tokenState()).claimState;
    expect(c.skipped).toBe(1);
    expect(c.returned).toBe(1);
    expect(c.epochs[0].epoch).toBe('12');
  });

  it('does not report an address that answers nothing as a network with nothing to claim', async () => {
    routes.delete(CLAIM + '|' + SEL_TOKEN);
    const c = (await m.tokenState()).claimState;
    expect(c.error).toMatch(/not a PeerClaim contract/);
    expect(c.epochs).toBeUndefined();
  });

  it('asks for exactly the claim contract and exactly the EpochOpened topic', async () => {
    await m.tokenState();
    const q = logQueries.filter((x) => String(x.address).toLowerCase() === CLAIM);
    expect(q).toHaveLength(1);
    expect(q[0]!.topics).toEqual([TOPIC_EPOCH_OPENED]);
  });
});

describe('both scans are the pools scan — chunked, capped and remembered per contract', () => {
  it('walks a 25,000-block span in three windows each, none wider than 9,999', async () => {
    headBlock = 25_000n;
    const st = await m.tokenState();
    for (const c of [ANCHOR, CLAIM]) {
      const q = logQueries.filter((x) => String(x.address).toLowerCase() === c);
      expect(q, c).toHaveLength(3);
      expect(q.map((x) => x.fromBlock)).toEqual([hex(0), hex(9999), hex(19998)]);
      for (const w of q) expect(BigInt(w.toBlock as string) - BigInt(w.fromBlock as string) + 1n <= 9999n).toBe(true);
    }
    expect(st.anchors.scan.windows).toBe(3);
    expect(st.anchors.scan.complete).toBe(true);
    expect(st.claimState.scan.windows).toBe(3);
    // Found in the first window and still here at the end of the third.
    expect(st.anchors.discovered).toBe(2);
    expect(st.claimState.discovered).toBe(2);
  });

  it('remembers each contract in its own file, and scans only the new tail next time', async () => {
    headBlock = 25_000n;
    const first = await m.tokenState();
    expect(first.anchors.scan.cursor).toBe(hex(25_000));
    expect(existsSync(ANCHOR_SCAN)).toBe(true);
    expect(existsSync(CLAIM_SCAN)).toBe(true);
    // Keyed to its own contract, so neither can be read as the other's.
    expect(JSON.parse(readFileSync(ANCHOR_SCAN, 'utf8')).factory).toBe(ANCHOR);
    expect(JSON.parse(readFileSync(CLAIM_SCAN, 'utf8')).factory).toBe(CLAIM);

    logQueries = [];
    headBlock = 25_100n;
    const again = await m.tokenState();
    for (const c of [ANCHOR, CLAIM]) {
      const q = logQueries.filter((x) => String(x.address).toLowerCase() === c);
      expect(q, c).toHaveLength(1);
      expect(q[0]!.fromBlock).toBe(hex(25_000n - 64n + 1n)); // one reorg rewind back
    }
    // That tail window carries no logs at all, and both lists are still whole:
    // they came out of the memory, not the endpoint. For anchors that memory
    // is the ANSWER — the rows are immutable — while the epochs were re-read.
    expect(again.anchors.anchors).toHaveLength(2);
    expect(again.anchors.anchors[0].blockId).toBe(BLOCK_ID_13);
    expect(again.claimState.epochs).toHaveLength(2);
  });

  it('keeps what a refused window did not cost it, and names the window', async () => {
    headBlock = 25_000n;
    failLogsFrom = 9999n;
    const st = await m.tokenState();
    expect(st.anchors.anchors).toHaveLength(2); // found before the refusal
    expect(st.anchors.scan.failed).toBe(1);
    expect(st.anchors.scan.failedAt).toBe(hex(9999) + '..' + hex(19_997));
    expect(st.anchors.scan.complete).toBe(false);
    expect(st.anchors.note).toMatch(/was refused/);
    expect(st.claimState.scan.failed).toBe(1);
    expect(st.claimState.note).toMatch(/was refused/);
  });

  it('honours PEER_EPOCH_FROM_BLOCK, and says so when the value is unusable', async () => {
    headBlock = 1_240_000n;
    process.env.PEER_EPOCH_FROM_BLOCK = '1234567';
    vi.resetModules();
    const m2 = await import('../chain-l2/onchain.mjs');
    const st = await m2.tokenState();
    expect(logQueries[0]!.fromBlock).toBe('0x12d687'); // decimal in, quantity out
    expect(st.anchors.fromBlock).toBe('0x12d687');
    expect(st.claimState.fromBlock).toBe('0x12d687');

    process.env.PEER_EPOCH_FROM_BLOCK = 'the block before last';
    vi.resetModules();
    const m3 = await import('../chain-l2/onchain.mjs');
    const st3 = await m3.tokenState();
    expect(st3.anchors.fromBlockIgnored).toBe('the block before last');
    expect(st3.anchors.fromBlock).toBe('0x0'); // guessed at, never
    expect(st3.anchors.scan.windows).toBe(24); // the per-refresh budget
    expect(st3.anchors.scan.complete).toBe(false);
    expect(st3.anchors.scan.backfill).toMatch(/blocks of history are still unwalked/);
    delete process.env.PEER_EPOCH_FROM_BLOCK;
    vi.resetModules();
  });
});

describe('unconfigured is off, and says so', () => {
  it('answers configured:false with a reason rather than leaving the keys out', async () => {
    delete process.env.PEER_ANCHOR_ADDR;
    delete process.env.PEER_CLAIM_ADDR;
    vi.resetModules();
    const m2 = await import('../chain-l2/onchain.mjs');
    const st = await m2.tokenState();
    expect(st.anchors).toEqual({ configured: false, why: expect.stringContaining('PEER_ANCHOR_ADDR is unset') });
    expect(st.anchors.why).toMatch(/not a claim that none exist/);
    expect(st.claimState.configured).toBe(false);
    expect(st.claimState.why).toMatch(/PEER_CLAIM_ADDR is unset/);
    expect(st.claimState.why).toMatch(/Epoch tokens still exist in the act log/);
    // And no chain call was spent on either.
    expect(seen.filter((c) => c.to.toLowerCase() === ANCHOR)).toHaveLength(0);
    expect(logQueries).toHaveLength(0);
    // claimsOf is off with it, rather than reading a contract nobody named.
    expect(await m2.claimsOf(WHO, ['12'])).toBe(null);
    process.env.PEER_ANCHOR_ADDR = ANCHOR;
    process.env.PEER_CLAIM_ADDR = CLAIM;
    vi.resetModules();
  });
});

describe('claimsOf — one account’s flags, never the cache’s', () => {
  it('answers per epoch from the contract’s own mapping, and reports the cap', async () => {
    route(CLAIM, SEL_CLAIMED + uint(12) + addrWord(WHO), '0x' + uint(1));
    route(CLAIM, SEL_CLAIMED + uint(13) + addrWord(WHO), '0x' + uint(0));
    const c = await m.claimsOf(WHO, ['12', '13']);
    expect(c.address).toBe(WHO);
    expect(c.contract).toBe(CLAIM);
    expect(c.epochs).toEqual([{ epoch: '12', claimed: true }, { epoch: '13', claimed: false }]);
    expect(c.asked).toBe(2);
    expect(c.capped).toBe(false);
    expect(c.note).toMatch(/not a statement that the address HAS a leaf/);
  });

  it('reports null for a word that is neither 0 nor 1, instead of reading it as "go ahead"', async () => {
    route(CLAIM, SEL_CLAIMED + uint(12) + addrWord(WHO), '0x'); // nothing answered
    const c = await m.claimsOf(WHO, ['12']);
    expect(c.epochs).toEqual([{ epoch: '12', claimed: null }]);
  });

  it('caps how many epochs one request may ask about, and says it did', async () => {
    const many = Array.from({ length: 20 }, (_, i) => String(i));
    for (const e of many) route(CLAIM, SEL_CLAIMED + uint(Number(e)) + addrWord(WHO), '0x' + uint(0));
    const c = await m.claimsOf(WHO, many);
    expect(c.asked).toBe(8);
    expect(c.capped).toBe(true);
    expect(seen.filter((x) => x.data.startsWith(SEL_CLAIMED))).toHaveLength(8);
  });

  it('will not answer off a chain this host has already refused', async () => {
    chainIdHex = '0x1';
    const c = await m.claimsOf(WHO, ['12']);
    expect(c.chainIdMatches).toBe(false);
    expect(c.error).toMatch(/refusing to report its numbers/);
    expect(c.epochs).toBeUndefined();
    expect(seen.filter((x) => x.data.startsWith(SEL_CLAIMED))).toHaveLength(0);
  });
});

/**
 * The topics, pinned to the compiler rather than to a comment.
 *
 * Everything above would pass just as happily with two invented constants: the
 * canned endpoint serves whatever topic it is asked for. This is the block
 * that makes them real — the compiled bytecode of both contracts, executed,
 * emitting its own events, and topics[0] read off the result.
 */
describe('the two topic0 constants, taken from the contracts themselves', () => {
  it('is what PeerAnchor.anchor() and PeerClaim.openEpoch() actually emit', async () => {
    const { createVM } = await import('@ethereumjs/vm');
    const { createBlock } = await import('@ethereumjs/block');
    const { createAddressFromString, hexToBytes, bytesToHex } = await import('@ethereumjs/util');
    const tokenBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerToken.build.json', import.meta.url), 'utf8'));

    const vm = await createVM();
    const evm = vm.evm;
    const block = createBlock({ header: { number: 1n, timestamp: NOW } });
    const me = createAddressFromString('0x' + '5'.repeat(40));
    const run = (to: unknown, data: string) =>
      evm.runCall({ caller: me, origin: me, to, block, data: hexToBytes(data as `0x${string}`), gasLimit: 50_000_000n } as never);
    const deploy = async (bc: string, args: string) => (await run(undefined, bc + args)).createdAddress;

    const peer = await deploy(tokenBuild.bytecode, uint(18_250_000n));
    const anchorC = await deploy(anchorBuild.bytecode, '');
    const claimC = await deploy(claimBuild.bytecode, addrWord(peer!.toString()) + addrWord(me.toString()));

    const r1 = await run(anchorC, '0x' + anchorBuild.hashes['anchor(uint256,bytes32,bytes32)'] + uint(12n) + 'aa'.repeat(32) + 'bb'.repeat(32));
    const anchored = r1.execResult.logs![0]!;
    expect(bytesToHex(anchored[1][0])).toBe(TOPIC_ANCHORED);
    expect(anchored[1]).toHaveLength(3); // signature, poster, epoch

    // approve(address,uint256) then openEpoch — the epoch is funded up front.
    await run(peer, '0x095ea7b3' + addrWord(claimC!.toString()) + uint(1000n));
    const r2 = await run(claimC, '0x' + claimBuild.hashes['openEpoch(uint256,bytes32,uint256,uint64)'] + uint(12n) + 'cc'.repeat(32) + uint(1000n) + uint(UNTIL));
    const opened = r2.execResult.logs!.find((l) => bytesToHex(l[0]) === claimC!.toString())!;
    expect(bytesToHex(opened[1][0])).toBe(TOPIC_EPOCH_OPENED);
    expect(opened[1]).toHaveLength(2); // signature, epoch
    // The PEER transfer it pulled in carries the canonical ERC-20 topic, which
    // is a fourth thing nobody in this repo chose — if the toolchain were
    // hashing anything strangely, this is where it would show.
    const transfer = r2.execResult.logs!.find((l) => bytesToHex(l[0]) === peer!.toString())!;
    expect(bytesToHex(transfer[1][0])).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  }, 30_000);
});

/**
 * The deploy page, which is the one surface here that signs anything.
 *
 * It embeds four immutable contracts. A page whose embedded bytecode has
 * drifted from its build.json deploys a DIFFERENT contract than the one this
 * repo's tests were run against, and the operator finds out afterwards or
 * never.
 */
describe('chain-l2/deploy.html carries exactly the built contracts', () => {
  const page = fs.readFileSync(new URL('../chain-l2/deploy.html', import.meta.url), 'utf8');
  // PeerPool, singular: the page deploys ONE pool at one address now, and the
  // superseded PeerPools factory is no longer embedded anywhere. Its build.json
  // is still in the tree so the dead deployment on Base can be read against its
  // own source; nothing signs it.
  const artifacts = ['PeerToken', 'PeerPool', 'PeerAnchor', 'PeerClaim'];

  it('embeds each bytecode byte for byte', () => {
    for (const name of artifacts) {
      const b = JSON.parse(fs.readFileSync(new URL('../chain-l2/' + name + '.build.json', import.meta.url), 'utf8')).bytecode;
      expect(b, name).toMatch(/^0x[0-9a-f]+$/);
      expect(page.includes(JSON.stringify(b)), name).toBe(true);
    }
  });

  it('prints a fingerprint that describes the bytecode it actually embeds', async () => {
    const { createHash } = await import('node:crypto');
    for (const [meta, name] of [['peerpool', 'PeerPool'], ['peeranchor', 'PeerAnchor'], ['peerclaim', 'PeerClaim']]) {
      const b = JSON.parse(fs.readFileSync(new URL('../chain-l2/' + name + '.build.json', import.meta.url), 'utf8')).bytecode;
      const fp = createHash('sha256').update(String(b).trim().toLowerCase(), 'ascii').digest('hex');
      // In the meta tag auto-deploy.ps1 compares, and in the card a human reads.
      expect(page, name).toContain('name="' + meta + '-build" content="sha256:' + fp + '"');
      expect(page.split(fp).length, name).toBeGreaterThanOrEqual(3);
    }
  });

  it('wires every deploy button the page offers', () => {
    for (const id of ['go', 'goPools', 'goAnchor', 'goClaim']) {
      expect(page, id).toContain('id="' + id + '"');
      expect(page, id).toContain("getElementById('" + id + "').onclick");
    }
    // PeerClaim's two immutable arguments are both checked against the chain
    // before anything is signed — the token must be an ERC-20, the steward
    // must not be one.
    expect(page).toContain('probeToken(peer,');
    expect(page).toContain('probeToken(steward,');
  });
});

/**
 * The request path, on a real host process against a fake endpoint. The
 * 30-second cache and the ?of= composition only exist here, and the property
 * that matters is a privacy one: the anchors and the epochs are the same
 * answer for everybody and are cached; whether YOU have claimed is not, and
 * must never be answered out of a body somebody else's request filled.
 */
describe('GET /api/token/onchain', () => {
  const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const PORT = 8791;
  const RPC_PORT = 8792;
  const BASE = 'http://127.0.0.1:' + PORT;
  let host: ChildProcess | undefined;
  let rpc: Server;
  let dir: string;
  let calls: string[] = [];

  const answer = (method: string, params: unknown[]): unknown => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_blockNumber') return hex(HEAD_DEFAULT);
    if (method === 'eth_getLogs') {
      const q = params[0] as { address: string; topics: string[]; fromBlock: string; toBlock: string };
      return ([
        anchorLog(STEWARD, 12n, BLOCK_ID_12, ROOT_12, NOW, 1000),
        epochLog(12n, ROOT_12, 500n * E18, UNTIL, 1001),
      ]).filter((l) => l.address.toLowerCase() === String(q.address).toLowerCase() && l.topics[0] === q.topics[0]);
    }
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      const k = to.toLowerCase() + '|' + data.toLowerCase();
      const table: Record<string, string> = {
        [TOKEN + '|' + SEL_DECIMALS]: '0x' + uint(18),
        [TOKEN + '|' + SEL_TOTAL_SUPPLY]: '0x' + uint(SUPPLY),
        [TOKEN + '|' + SEL_BALANCE_OF + addrWord(CLAIM)]: '0x' + uint(900n * E18),
        [TOKEN + '|' + SEL_BALANCE_OF + addrWord(WHO)]: '0x' + uint(7n * E18),
        [ANCHOR + '|' + SEL_ANCHOR_OF + addrWord('0x' + '00'.repeat(20)) + uint(0)]: '0x' + uint(0) + uint(0) + uint(0),
        [CLAIM + '|' + SEL_TOKEN]: '0x' + addrWord(TOKEN),
        [CLAIM + '|' + SEL_STEWARD]: '0x' + addrWord(STEWARD),
        [CLAIM + '|' + SEL_EPOCH_INFO + uint(12)]: info5(ROOT_12, 500n * E18, 120n * E18, UNTIL, true),
        [CLAIM + '|' + SEL_CLAIMED + uint(12) + addrWord(WHO)]: '0x' + uint(1),
        [CLAIM + '|' + SEL_CLAIMED + uint(12) + addrWord(ALICE)]: '0x' + uint(0),
        [TOKEN + '|' + SEL_BALANCE_OF + addrWord(ALICE)]: '0x' + uint(0),
      };
      const hit = table[k.toLowerCase()];
      if (hit === undefined) throw new Error('unexpected eth_call: ' + k);
      return hit;
    }
    throw new Error('unexpected rpc method: ' + method);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-epoch-host-'));
    mkdirSync(join(dir, 'server-data'), { recursive: true });
    writeFileSync(
      join(dir, 'server-data', 'acts.jsonl'),
      JSON.stringify({ t: 'register', id: 'u_a', handle: 'A', seed: 1, epoch: 0 }) + '\n',
    );
    rpc = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        calls.push(body.method);
        let out: Record<string, unknown>;
        try {
          out = { jsonrpc: '2.0', id: body.id, result: answer(body.method, body.params) };
        } catch (e) {
          out = { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: String((e as Error).message) } };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => rpc.listen(RPC_PORT, '127.0.0.1', r));
    host = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
      cwd: ROOT,
      env: {
        ...process.env,
        PEER_DATA_DIR: join(dir, 'server-data'),
        PEER_L2_RPC: 'http://127.0.0.1:' + RPC_PORT,
        PEER_TOKEN_ADDR: TOKEN,
        PEER_ANCHOR_ADDR: ANCHOR,
        PEER_CLAIM_ADDR: CLAIM,
        PEER_POOLS_ADDR: '',
      },
      stdio: 'ignore',
    });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { await realFetch(BASE + '/api/acts'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!up) throw new Error('host did not come up');
    calls = [];
  }, 30_000);

  afterAll(async () => {
    host?.kill();
    await new Promise<void>((r) => rpc.close(() => r()));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('serves the anchors and the epochs to everybody, out of one round of calls', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => realFetch(BASE + '/api/token/onchain')));
    const bodies = await Promise.all(rs.map((r) => r.json() as Promise<Record<string, any>>));
    for (const b of bodies) {
      expect(b.deployed).toBe(true);
      expect(b.anchors.anchors[0].epoch).toBe('12');
      expect(b.anchors.anchors[0].earningsRoot).toBe(ROOT_12);
      expect(b.claimState.epochs[0].root).toBe(ROOT_12);
      expect(b.claimState.epochs[0].remainingRaw).toBe((380n * E18).toString());
      expect(b.claimState.steward).toBe(STEWARD.toLowerCase());
      // Nobody asked about an account, so nothing about one is in the body.
      expect(b.account).toBeUndefined();
    }
    // Ten tabs, one refresh: eth_chainId is asked once per refresh, so
    // counting it counts refreshes. Two log scans, one per contract.
    expect(calls.filter((c) => c === 'eth_chainId')).toHaveLength(1);
    expect(calls.filter((c) => c === 'eth_getLogs')).toHaveLength(2);
  }, 20_000);

  it('answers "have you claimed" per request, and never out of the shared cache', async () => {
    const mine = await (await realFetch(BASE + '/api/token/onchain?of=' + WHO)).json() as Record<string, any>;
    expect(mine.account.raw).toBe((7n * E18).toString());
    expect(mine.account.claims.epochs).toEqual([{ epoch: '12', claimed: true }]);
    // A second viewer, inside the same 30-second cache window, gets their own
    // answer — not the one the first request just put on the page.
    const theirs = await (await realFetch(BASE + '/api/token/onchain?of=' + ALICE)).json() as Record<string, any>;
    expect(theirs.account.claims.epochs).toEqual([{ epoch: '12', claimed: false }]);
    // And the shared half is untouched by either: no claimed flag was written
    // into the cached epoch rows, where it would answer for everyone.
    const plain = await (await realFetch(BASE + '/api/token/onchain')).json() as Record<string, any>;
    expect(plain.claimState.epochs[0].claimed).toBeUndefined();
    expect(plain.account).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain(WHO.slice(2));
  }, 20_000);
});
