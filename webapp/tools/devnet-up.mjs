// One command that stands this whole network up on a chain that costs nothing.
//
// Everything this repo built on-chain — the pool, anchored epochs, merkle
// claims, the wallet card — was checked by unit tests and by read-only reads
// against Base, and then never USED. Using it needs a funded wallet and a
// signature; on Base that is real money and a real key. tools/devchain.mjs
// supplies a chain where both are free. This file is the other half: it
// deploys the committed artifacts onto that chain, funds a wallet, seeds a
// small world, and starts a SECOND host pointed at the result, so the real app
// can be driven end to end by a person or a script.
//
//   node tools/devnet-up.mjs [--data DIR] [--host-port N] [--rpc-port N]
//                            [--chain-id N] [--reset] [--no-exercise]
//
// What it leaves running when it exits: a devchain and a host, both detached,
// both bound to 127.0.0.1, with their pids written into <data>/devnet.json so
// they can be stopped by pid and nothing else has to be guessed at.
//
// THE SAFETY RULES THIS FILE ENFORCES, rather than assumes:
//
//   * The data directory may never be webapp/server-data. That is the live
//     host's log; a test world written into it is not a test. Refused by path
//     comparison, before anything is created.
//   * The host port may never be 5210, the live host's. Refused the same way,
//     and any port already in use is refused too — this tool never restarts,
//     replaces or writes to a host it did not start.
//   * The chain id may never be a real network's. devchain.mjs refuses those
//     itself; this file refuses them again before spawning, because the cost
//     of being wrong is a page that reports invented numbers as Base's.
//
// THE ONE DIFFERENCE FROM BASE THAT CAN HIDE A BUG. On Base the bitcoin side
// of the pool is cbBTC, which has EIGHT decimals. There is no cbBTC on a
// chain that was born ninety seconds ago, so this file deploys a second
// PeerToken as a stand-in and calls it TBTC — and PeerToken has EIGHTEEN
// decimals, like PEER. So a display that hardcodes 8, or that scales the
// bitcoin side by the PEER side's decimals, is WRONG ON BASE AND RIGHT HERE:
// the two mistakes cancel on this chain. Anything that looks right here and is
// scaled by a constant should be read again against a token with 8 decimals
// before it is believed. Every amount this file prints says which decimals it
// used, for the same reason.
//
// onchain.mjs reads decimals() off the POOL's own btc() — not off
// PEER_BTC_ADDR — which is the correct behaviour and also the behaviour that
// hides the bug here, because this file sets PEER_BTC_ADDR to the very TBTC the
// pool was deployed against, so the two agree and either would give 18. That
// sentence was false for one release: the pools card took its scaling from the
// configured addresses while signing against the pool's own pair, and this
// devnet could not have surfaced it. Reading the pool's pair is now asserted in
// tests/onchain-pool-decode.test.ts against a pair that DISAGREES, which is the
// only place the difference is visible.
//
// Nothing here signs with a secret. The devchain's accounts are unlocked:
// eth_sendTransaction executes straight from whatever `from` names, so this
// file holds no key and needs none. The keys devchain prints are derived from
// labels in its own source and are worthless anywhere else.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { keccak_256 } from '@noble/hashes/sha3.js';

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, '..');

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (name) => argv.includes('--' + name);
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`--${name} needs a value`);
  return v;
}
function die(msg) {
  console.error('\n  ' + msg + '\n');
  process.exit(1);
}

const DATA_DIR = resolve(flag('data', join(tmpdir(), 'peer-devnet')));
const WANT_HOST_PORT = Number(flag('host-port', 5310));
const WANT_RPC_PORT = Number(flag('rpc-port', 8545));
const CHAIN_ID = Number(flag('chain-id', 31337));
const RESET = has('reset');
const EXERCISE = !has('no-exercise');

// The live host's directory and port. Both are refused rather than warned
// about: a warning is something a script ignores.
const LIVE_DATA = resolve(webapp, 'server-data');
const LIVE_PORT = 5210;
if (DATA_DIR === LIVE_DATA || DATA_DIR.startsWith(LIVE_DATA + '\\') || DATA_DIR.startsWith(LIVE_DATA + '/')) {
  die(`--data may not be ${LIVE_DATA} or anything inside it. That is the live host's act log; a test\n  world written there is not a test, it is a corruption of the record. Pick a scratch path.`);
}
if (WANT_HOST_PORT === LIVE_PORT) {
  die(`--host-port may not be ${LIVE_PORT}. That is the live host's port and this tool never touches a host it did not start.`);
}
const REAL_CHAINS = new Map([[1, 'Ethereum'], [10, 'OP Mainnet'], [56, 'BNB Chain'], [137, 'Polygon'], [8453, 'Base'], [42161, 'Arbitrum One']]);
if (REAL_CHAINS.has(CHAIN_ID)) {
  die(`--chain-id ${CHAIN_ID} is ${REAL_CHAINS.get(CHAIN_ID)}. A fake chain wearing a real network's id lets a host\n  report its invented numbers as that network's. Pick a test id such as 31337.`);
}

// ---------------------------------------------------------------------------
// The artifacts, and the selectors taken FROM them
//
// solc wrote a methodIdentifiers table into each build.json. Those are the
// authority — not anything computed here — because a selector this file
// invented and then verified against its own hasher would only prove the
// hasher agrees with itself. What IS done below is the other direction: every
// selector used here is recomputed from its signature and compared with the
// artifact's table, and a disagreement stops the run. That cannot make a wrong
// selector right; it can only catch a signature typed wrong in this file, or
// an artifact that has drifted from the source beside it.
//
// PeerToken's artifact carries no table (it was compiled without one), so its
// four ERC-20 selectors are the canonical constants chain-l2/onchain.mjs
// already hardcodes, checked the same way.
// ---------------------------------------------------------------------------

const build = (name) => JSON.parse(readFileSync(join(webapp, 'chain-l2', name + '.build.json'), 'utf8'));
const ART = {
  PeerToken: build('PeerToken'),
  PeerPool: build('PeerPool'),
  PeerAnchor: build('PeerAnchor'),
  PeerClaim: build('PeerClaim'),
};

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const sig4 = (signature) => hex(keccak_256(Buffer.from(signature, 'utf8'))).slice(0, 8);

/** A selector the artifact vouches for, cross-checked against the signature. */
function sel(contract, signature) {
  const table = ART[contract].hashes;
  if (!table || !(signature in table)) {
    die(`${contract}.build.json has no selector for ${signature} — this file and the artifact disagree about what was compiled.`);
  }
  const fromArtifact = String(table[signature]).toLowerCase();
  const computed = sig4(signature);
  if (fromArtifact !== computed) {
    die(`selector mismatch for ${contract}.${signature}: the artifact says ${fromArtifact}, keccak of that signature is ${computed}.\n  One of the two is not what it claims to be. Nothing is deployed.`);
  }
  return '0x' + fromArtifact;
}
/** An ERC-20 selector with no artifact table behind it. */
function erc20(signature, expected) {
  const computed = sig4(signature);
  if (computed !== expected) die(`ERC-20 selector for ${signature} computes to ${computed}, not the ${expected} this file expected.`);
  return '0x' + expected;
}

const SEL = {
  // PeerToken (ERC-20; the same constants onchain.mjs hardcodes)
  transfer: erc20('transfer(address,uint256)', 'a9059cbb'),
  approve: erc20('approve(address,uint256)', '095ea7b3'),
  balanceOf: erc20('balanceOf(address)', '70a08231'),
  decimals: erc20('decimals()', '313ce567'),
  symbol: erc20('symbol()', '95d89b41'),
  totalSupply: erc20('totalSupply()', '18160ddd'),
  // PeerPool - one pool at one address, so there is nothing to create and
  // nothing to count. `add` is both the seeding call and every later deposit.
  add: sel('PeerPool', 'add(uint256,uint256,uint256,uint256)'),
  reserves: sel('PeerPool', 'reserves()'),
  poolPeer: sel('PeerPool', 'peer()'),
  poolBtc: sel('PeerPool', 'btc()'),
  // PeerAnchor
  anchor: sel('PeerAnchor', 'anchor(uint256,bytes32,bytes32)'),
  // PeerClaim
  openEpoch: sel('PeerClaim', 'openEpoch(uint256,bytes32,uint256,uint64)'),
  epochInfo: sel('PeerClaim', 'epochInfo(uint256)'),
  claimToken: sel('PeerClaim', 'token()'),
  steward: sel('PeerClaim', 'steward()'),
};

// ---------------------------------------------------------------------------
// Encoding. Four fixed shapes, no ABI library: a uint256, an address, a
// bytes32 and a utf-8 name padded into a bytes32. Every argument this file
// passes is one of those.
// ---------------------------------------------------------------------------

const uint = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const b32 = (h) => {
  const s = String(h).replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) die('not a 32-byte hex word: ' + String(h).slice(0, 80));
  return s;
};
// ---------------------------------------------------------------------------
// Talking to the chain
// ---------------------------------------------------------------------------

let RPC = '';
let rpcId = 1;
async function rpc(method, params, timeoutMs = 30_000) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('rpc http ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}${j.error.data ? ' (' + JSON.stringify(j.error.data) + ')' : ''}`);
  return j.result;
}
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

/**
 * Send, then INSIST on the receipt saying it worked.
 *
 * A reverted transaction on this chain comes back with a hash and a receipt
 * whose status is 0x0 — no throw, no message. A script that ignores that
 * builds its whole world on transactions that did nothing and only finds out
 * when a pool list is mysteriously empty. So every send is dry-run through
 * eth_call first, which DOES surface the revert string, and the receipt's
 * status is checked afterwards regardless.
 */
async function send(from, to, data, what) {
  try {
    await rpc('eth_call', [{ from, to, data }, 'latest']);
  } catch (e) {
    throw new Error(`${what} would revert: ${e.message}`);
  }
  const tx = { from, data };
  if (to) tx.to = to;
  const hash = await rpc('eth_sendTransaction', [tx]);
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  if (!receipt) throw new Error(`${what}: no receipt for ${hash}`);
  if (receipt.status !== '0x1') throw new Error(`${what}: reverted on-chain (${hash})`);
  return receipt;
}

/** Deploy one artifact; the constructor's arguments are already encoded. */
async function deploy(from, contract, args, label) {
  const bytecode = ART[contract].bytecode;
  if (!/^0x[0-9a-f]+$/i.test(bytecode)) die(`${contract}.build.json has no usable bytecode`);
  const receipt = await send(from, null, bytecode + args, `deploying ${label}`);
  if (!receipt.contractAddress) throw new Error(`deploying ${label}: the receipt names no contract address`);
  const address = receipt.contractAddress.toLowerCase();
  const code = await rpc('eth_getCode', [address, 'latest']);
  if (!code || code === '0x') throw new Error(`deploying ${label}: nothing is deployed at ${address}`);
  const block = Number(BigInt(receipt.blockNumber));
  say(`    ${label.padEnd(22)} ${address}  (block ${block}, ${(code.length - 2) / 2} bytes of code)`);
  return { address, block };
}

const readWord = (ret, i = 0) => {
  const body = String(ret || '').replace(/^0x/, '');
  return body.length < 64 * (i + 1) ? null : BigInt('0x' + body.slice(64 * i, 64 * (i + 1)));
};

// ---------------------------------------------------------------------------
// Ports, processes, waiting
// ---------------------------------------------------------------------------

const say = (s) => console.log(s);

/** Is anything listening on this port of the loopback interface? */
function portTaken(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', (e) => done(e.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => done(false)));
    probe.listen(port, '127.0.0.1');
  });
}
/** The first free port at or above `from`, so two devnets can coexist. */
async function freePort(from, what) {
  for (let p = from; p < from + 40; p++) {
    if (p === LIVE_PORT) continue;
    if (!(await portTaken(p))) return p;
  }
  die(`could not find a free port for ${what} in ${from}..${from + 39}`);
}

/** Poll until `check` returns truthy, or give up with a sentence saying what
 *  never happened rather than a bare timeout. */
async function waitFor(check, what, ms = 30_000) {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = String(e.message).slice(0, 120);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  die(`gave up waiting for ${what} after ${ms / 1000}s${last ? ' — last error: ' + last : ''}`);
}

/** Start a long-lived child that outlives this process, with its output going
 *  to a file so a crash after we exit is still readable. */
function background(script, args, env, logFile) {
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [script, ...args], {
    cwd: webapp,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// ---------------------------------------------------------------------------
// The seeded world
//
// The act shapes are the ones tests/claim-ui-onchain.test.ts and
// tests/helpers/world.ts already use, because those are the shapes proven to
// replay into a distribution — an invented act shape produces an empty epoch,
// which looks exactly like a broken claim card.
//
// Deliberate properties, each of which exercises something that a two-leaf
// happy path does not:
//
//   * THREE bound earners, so the merkle tree has a carried-up level and a
//     proof that is neither the degenerate single word nor the trivial pair.
//     That is the case the unusual path-word encoding gets wrong quietly.
//   * ONE earner with no bindAddress, so the claim endpoint's `unbound` list
//     is non-empty and the "their share stays in the remainder" path is real.
//   * Burns with well-formed 64-hex txids. A malformed txid is refused, the
//     account never gets reserve, its reactions never land, and the epoch
//     distributes nothing.
// ---------------------------------------------------------------------------

const PIN = '246813';
const PIN_ITERATIONS = 210_000; // server.mjs's constant; a PIN hashed at any
                                // other count simply will not verify there.
const pinHash = (pin) => {
  const salt = randomBytes(16).toString('hex');
  return 'pbkdf2$' + PIN_ITERATIONS + '$' + salt + '$' +
    pbkdf2Sync(pin, Buffer.from(salt, 'hex'), PIN_ITERATIONS, 32, 'sha256').toString('hex');
};

function seedActs(bindings) {
  const acts = [];
  const people = ['al', 'bo', 'cy', 'di', 'ev'];
  people.forEach((h, i) => {
    acts.push({ t: 'register', id: 'u_' + h, handle: h, seed: 1, epoch: 0, pinHash: pinHash(PIN) });
    acts.push({ t: 'btcBurn', id: 'u_' + h, sats: 60000, addr: 'bc1qdead', txid: (i + 1).toString(16).padStart(64, '0') });
  });
  // Where each handle's earnings are payable. Three of the five; `di` and `ev`
  // are left unbound on purpose (see above).
  for (const [id, addr] of Object.entries(bindings)) acts.push({ t: 'bindAddress', id, addr });
  // Four posts, in this order, so the ids below are c1..c4.
  acts.push({ t: 'post', author: 'u_al', text: 'A local chain, and the first pool that was ever actually opened.', a: 0.8 });
  acts.push({ t: 'post', author: 'u_bo', text: 'Reading a claim root off a contract beats believing a host about it.', a: 0.8 });
  acts.push({ t: 'post', author: 'u_cy', text: 'Three leaves, so the proof carries a real path word.', a: 0.8 });
  acts.push({ t: 'post', author: 'u_ev', text: 'Earning with no address bound: the share stays in the remainder.', a: 0.8 });
  // Reactions. Every earner below earns because somebody else reacted to them.
  acts.push({ t: 'opinion', author: 'u_cy', target: 'c1', p: 0.8, r: 0.8 });
  acts.push({ t: 'opinion', author: 'u_di', target: 'c1', p: 0.8, r: 0.8 });
  acts.push({ t: 'opinion', author: 'u_ev', target: 'c1', p: 0.7, r: 0.7 });
  acts.push({ t: 'opinion', author: 'u_cy', target: 'c2', p: 0.8, r: 0.8 });
  acts.push({ t: 'opinion', author: 'u_al', target: 'c2', p: 0.6, r: 0.7 });
  acts.push({ t: 'opinion', author: 'u_al', target: 'c3', p: 0.8, r: 0.8 });
  acts.push({ t: 'opinion', author: 'u_bo', target: 'c3', p: 0.7, r: 0.8 });
  acts.push({ t: 'opinion', author: 'u_al', target: 'c4', p: 0.8, r: 0.8 });
  acts.push({ t: 'opinion', author: 'u_bo', target: 'c4', p: 0.8, r: 0.7 });
  acts.push({ t: 'review', author: 'u_di', target: 'c1', e: 0.7, f: 0.7, text: 'The devchain is the part that makes this checkable.' });
  acts.push({ t: 'closeEpoch', epoch: 1 });
  return acts;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

say('');
say('  peer devnet — a whole network on a chain that costs nothing');
say('');

// ── The data directory ─────────────────────────────────────────────────────
const MARKER = join(DATA_DIR, 'devnet.json');
if (existsSync(DATA_DIR) && readdirSync(DATA_DIR).length > 0) {
  if (!existsSync(MARKER) && !RESET) {
    die(`${DATA_DIR} already has things in it and no devnet.json saying this tool made it.\n  Refusing to write into a directory that may be somebody's data. Pass --reset to wipe it, or --data elsewhere.`);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
}
mkdirSync(DATA_DIR, { recursive: true });
say(`  data       ${DATA_DIR}   (scratch — nothing here is anyone's record)`);

// ── 1. The chain ───────────────────────────────────────────────────────────
let rpcPort = WANT_RPC_PORT;
let devchainPid = null;
let attached = false;
if (await portTaken(rpcPort)) {
  RPC = `http://127.0.0.1:${rpcPort}`;
  let seen = null;
  try { seen = Number(BigInt(await rpc('eth_chainId', [], 3000))); } catch { /* not an RPC */ }
  if (seen === CHAIN_ID) {
    attached = true;
    say(`  chain      attached to the devchain already running on ${rpcPort} (chain ${seen})`);
  } else if (seen !== null) {
    die(`something on port ${rpcPort} answers eth_chainId with ${seen}, not ${CHAIN_ID}. Refusing to deploy into a chain\n  this run did not identify. Use --rpc-port for a different one.`);
  } else {
    rpcPort = await freePort(rpcPort + 1, 'the devchain');
  }
}
if (!attached) {
  const log = join(DATA_DIR, 'devchain.log');
  devchainPid = background(join(here, 'devchain.mjs'),
    ['--port', String(rpcPort), '--chain-id', String(CHAIN_ID), '--accounts', '5'], {}, log);
  RPC = `http://127.0.0.1:${rpcPort}`;
  await waitFor(async () => Number(BigInt(await rpc('eth_chainId', [], 2000))) === CHAIN_ID,
    `the devchain to answer on ${RPC} (see ${log})`);
  say(`  chain      devchain started on ${RPC}, chain id ${CHAIN_ID}, pid ${devchainPid}`);
}

const unlocked = (await rpc('eth_accounts', [])).map((a) => a.toLowerCase());
if (unlocked.length < 3) die(`this chain has ${unlocked.length} unlocked account(s); this tool needs at least 3`);
const DEPLOYER = unlocked[0];  // also the PeerClaim steward
const WALLET = unlocked[1];    // the TEST WALLET
const SECOND = unlocked[2];    // a second bound earner, so a claim can be
                               // driven without spending the test wallet's own
const THIRD = unlocked[3] ?? unlocked[2];

// ── 2. The contracts ───────────────────────────────────────────────────────
say('');
say('  deploying the committed artifacts (no .sol is compiled here):');
const PEER_SUPPLY = 18_250_000n;
const TBTC_SUPPLY = 21_000_000n;
const peer = await deploy(DEPLOYER, 'PeerToken', uint(PEER_SUPPLY), 'PeerToken (PEER)');
const tbtc = await deploy(DEPLOYER, 'PeerToken', uint(TBTC_SUPPLY), 'PeerToken (TBTC)');
const pool = await deploy(DEPLOYER, 'PeerPool', addrWord(peer.address) + addrWord(tbtc.address), 'PeerPool');
const anchor = await deploy(DEPLOYER, 'PeerAnchor', '', 'PeerAnchor');
const claim = await deploy(DEPLOYER, 'PeerClaim', addrWord(peer.address) + addrWord(DEPLOYER), 'PeerClaim');

// Read back what the chain says, rather than what was just asked for. A
// constructor argument that did not land is the exact failure that produced
// the dead contract on Base — its immutable peer address was the operator's
// own wallet, and nothing checked.
const peerDecimals = Number(readWord(await ethCall(peer.address, SEL.decimals)));
const tbtcDecimals = Number(readWord(await ethCall(tbtc.address, SEL.decimals)));
const poolPeer = '0x' + String(await ethCall(pool.address, SEL.poolPeer)).slice(-40);
const poolBtc = '0x' + String(await ethCall(pool.address, SEL.poolBtc)).slice(-40);
const claimToken = '0x' + String(await ethCall(claim.address, SEL.claimToken)).slice(-40);
const claimSteward = '0x' + String(await ethCall(claim.address, SEL.steward)).slice(-40);
const wrong = [];
if (poolPeer !== peer.address) wrong.push(`PeerPool.peer() is ${poolPeer}, not the PEER just deployed`);
if (poolBtc !== tbtc.address) wrong.push(`PeerPool.btc() is ${poolBtc}, not the TBTC just deployed`);
if (claimToken !== peer.address) wrong.push(`PeerClaim.token() is ${claimToken}, not the PEER just deployed`);
if (claimSteward !== DEPLOYER) wrong.push(`PeerClaim.steward() is ${claimSteward}, not the deployer`);
if (wrong.length) die('the deployed immutables are not what was passed:\n  - ' + wrong.join('\n  - '));
say(`    immutables check out: the pool trades the two tokens above, and PeerClaim pays PEER with ${DEPLOYER} as steward.`);
say('');
say(`    DECIMALS: PEER ${peerDecimals}, TBTC ${tbtcDecimals}. On Base the bitcoin side is cbBTC at EIGHT decimals`);
say('              (0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf). Anything that scales the btc side by a');
say('              constant is wrong on Base and right here — the two errors cancel on this chain.');

// ── 3. The test wallet ─────────────────────────────────────────────────────
const ONE = 10n ** BigInt(peerDecimals);
const ONE_B = 10n ** BigInt(tbtcDecimals);
const walletPeer = 250_000n * ONE;
const walletBtc = 25n * ONE_B;
await send(DEPLOYER, peer.address, SEL.transfer + addrWord(WALLET) + uint(walletPeer), 'funding the test wallet with PEER');
await send(DEPLOYER, tbtc.address, SEL.transfer + addrWord(WALLET) + uint(walletBtc), 'funding the test wallet with TBTC');
// The second bound earner gets a little of each too, so a claim driven from it
// is a wallet that already looks like somebody's, not an empty address.
await send(DEPLOYER, peer.address, SEL.transfer + addrWord(SECOND) + uint(1000n * ONE), 'funding the second earner with PEER');

const bal = async (token, who) => readWord(await ethCall(token, SEL.balanceOf + addrWord(who)));
const eth = async (who) => BigInt(await rpc('eth_getBalance', [who, 'latest']));
say('');
say('  the test wallet (an UNLOCKED devchain account — its key is printed by devchain.mjs and is worthless elsewhere):');
say(`    address    ${WALLET}`);
say(`    ETH        ${await eth(WALLET) / 10n ** 18n}`);
say(`    PEER       ${(await bal(peer.address, WALLET)) / ONE}  (raw ${await bal(peer.address, WALLET)}, ${peerDecimals} decimals)`);
say(`    TBTC       ${(await bal(tbtc.address, WALLET)) / ONE_B}  (raw ${await bal(tbtc.address, WALLET)}, ${tbtcDecimals} decimals)`);

// ── 4 & 5. The data directory, the world, the host ─────────────────────────
const bindings = { u_al: WALLET, u_bo: SECOND, u_cy: THIRD };
const acts = seedActs(bindings);
writeFileSync(join(DATA_DIR, 'acts.jsonl'), acts.map((a) => JSON.stringify(a)).join('\n') + '\n');

const hostPort = await freePort(WANT_HOST_PORT, 'the host');
const hostEnv = {
  PEER_DATA_DIR: DATA_DIR,
  PEER_L2_RPC: RPC,
  PEER_L2_CHAIN_ID: String(CHAIN_ID),
  PEER_TOKEN_ADDR: peer.address,
  PEER_BTC_ADDR: tbtc.address,
  PEER_POOL_ADDR: pool.address,
  PEER_ANCHOR_ADDR: anchor.address,
  PEER_CLAIM_ADDR: claim.address,
  // The block each contract was deployed in. Not an optimisation here — the
  // chain is a hundred blocks long — but it is the variable an operator gets
  // wrong on Base, so the devnet sets it the way a real deployment would.
  // No from-block for the pool: it is read with one eth_call at the head, so
  // there is no log range to start from and nothing a wrong block could hide.
  PEER_EPOCH_FROM_BLOCK: String(Math.min(anchor.block, claim.block)),
  // This host federates with nobody. Inheriting any of these from a shell that
  // once ran the live host would point a test world at the real network.
  PEER_MIRROR_OF: '',
  PEER_FEDERATION: '',
  PEER_SITE_URL: '',
};
const hostLog = join(DATA_DIR, 'host.log');
const hostPid = background(join(webapp, 'server.mjs'), [String(hostPort)], hostEnv, hostLog);
const HOST = `http://127.0.0.1:${hostPort}`;
// Readiness is probed on a door that reads NOTHING from the chain. It used to
// be probed on /api/token/onchain, which answers from a 30-second cache: the
// probe filled that cache with the state of a chain where nothing had happened
// yet, and the first real read after the exercise below then showed a network
// with an empty pool, no anchors and no epochs — thirty seconds of a perfectly
// working reader looking utterly broken.
await waitFor(async () => (await fetch(HOST + '/api/chain/head', { signal: AbortSignal.timeout(4000) })).status > 0,
  `the host to answer on ${HOST} (see ${hostLog})`);
say('');
say(`  host       ${HOST}  pid ${hostPid}  (${acts.length} acts seeded, PIN ${PIN} for every handle)`);

// ── 6. Give the chain something to have happened ───────────────────────────
//
// Everything above is configuration. Without this section the reader's three
// surfaces answer correctly and emptily, which is the one answer that cannot
// tell a working scan from a broken one.
const summary = {
  rpc: RPC, chainId: CHAIN_ID, host: HOST, dataDir: DATA_DIR,
  pids: { devchain: devchainPid, host: hostPid },
  addresses: {
    peer: peer.address, tbtc: tbtc.address, pool: pool.address,
    anchor: anchor.address, claim: claim.address,
  },
  blocks: { peer: peer.block, tbtc: tbtc.block, pool: pool.block, anchor: anchor.block, claim: claim.block },
  accounts: { deployer: DEPLOYER, steward: DEPLOYER, testWallet: WALLET, secondEarner: SECOND, third: THIRD },
  bindings, pin: PIN, env: hostEnv,
};

if (EXERCISE) {
  say('');
  say('  making things happen on the chain, so the reader has something to read:');

  // TWO adds to the ONE pool, the second from the test wallet - which is the
  // whole story of the redesign acted out: the first add sets the opening
  // price out of nothing but the two amounts, and every add after it is
  // proportional to what is already there and simply makes the pool bigger.
  // Nobody opens a second market; there is one address and everyone is in it.
  //
  // `add` takes (amtPeer, amtBtc, minShares, deadline). minShares is 0 here on
  // purpose and would be careless on a live chain: it is the caller's guard
  // against a swap landing in front of them and changing which side binds. On
  // a devchain nothing else is trading, and the deadline is far future for the
  // same reason.
  const FOREVER = 2_000_000_000n;
  const addLiquidity = async (from, amtPeer, amtBtc, what) => {
    await send(from, peer.address, SEL.approve + addrWord(pool.address) + uint(amtPeer), `approving PEER for ${what}`);
    await send(from, tbtc.address, SEL.approve + addrWord(pool.address) + uint(amtBtc), `approving TBTC for ${what}`);
    await send(from, pool.address, SEL.add + uint(amtPeer) + uint(amtBtc) + uint(0n) + uint(FOREVER), what);
    say(`    ${what}: ${amtPeer / ONE} PEER : ${amtBtc / ONE_B} TBTC from ${from}`);
  };
  await addLiquidity(DEPLOYER, 400_000n * ONE, 8n * ONE_B, 'seeding the pool');
  await addLiquidity(WALLET, 120_000n * ONE, 2n * ONE_B, 'adding to the pool');
  const res = String(await ethCall(pool.address, SEL.reserves)).replace(/^0x/, '');
  say(`    reserves() now says ${BigInt('0x' + res.slice(0, 64)) / ONE} PEER : `
    + `${BigInt('0x' + res.slice(64, 128)) / ONE_B} TBTC, ${BigInt('0x' + res.slice(128, 192))} shares`);

  // The epoch. Its root and total come from the HOST's own computation, not
  // from anything recomputed here — publishing a root this file invented would
  // make the card's "does the chain agree with this host" check meaningless by
  // construction.
  const claimBody = await (await fetch(`${HOST}/api/v1/epoch/1/claim`)).json();
  if (!claimBody || !claimBody.root) {
    say('    epoch 1 produced no tree on the host — nothing is opened on-chain. The host said:');
    say('    ' + JSON.stringify(claimBody).slice(0, 300));
    summary.epoch = { opened: false, why: 'the host computed no earnings tree for epoch 1' };
  } else {
    const total = BigInt(claimBody.total);
    const until = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400); // MIN_WINDOW is 7 days
    await send(DEPLOYER, peer.address, SEL.approve + addrWord(claim.address) + uint(total), 'approving PEER for the epoch');
    await send(DEPLOYER, claim.address,
      SEL.openEpoch + uint(1) + b32(claimBody.root) + uint(total) + uint(until), 'opening epoch 1');
    say(`    epoch 1 opened on PeerClaim: root ${claimBody.root.slice(0, 16)}…, ${total / ONE} PEER across ${claimBody.leafCount} leaf/leaves`);
    if (claimBody.unbound && claimBody.unbound.count) {
      say(`      (${claimBody.unbound.count} handle(s) earned with no address bound — their share stays in the remainder)`);
    }
    summary.epoch = { opened: true, root: claimBody.root, totalRaw: String(total), claimUntil: Number(until), leaves: claimBody.leafCount };

    // And an anchor over the same epoch, using the block id the host sealed.
    let blockId = '0'.repeat(64);
    let blockNote = 'no sealed block existed, so the anchored block id is zero';
    try {
      const head = await (await fetch(`${HOST}/api/chain/head`)).json();
      if (head && typeof head.hash === 'string' && /^[0-9a-f]{64}$/.test(head.hash)) {
        blockId = head.hash;
        blockNote = `the host's sealed head at height ${head.height}`;
      }
    } catch { /* the chain may not be sealed yet; the zero id is reported */ }
    await send(DEPLOYER, anchor.address,
      SEL.anchor + uint(1) + b32(blockId) + b32(claimBody.root), 'anchoring epoch 1');
    say(`    epoch 1 anchored on PeerAnchor: blockId ${blockId.slice(0, 16)}… (${blockNote})`);
    summary.anchor = { epoch: 1, blockId, earningsRoot: claimBody.root, note: blockNote };
  }
}

// ── 7. Read it all back through the host ───────────────────────────────────
//
// The one request that proves the whole reader path end to end: chain id,
// token, pool, anchors and claim state, all off a chain that was empty a
// minute ago. Asserted rather than printed and hoped over — an empty surface
// here is the failure this devnet exists to make visible.
say('');
say('  reading it back through the host (GET /api/token/onchain):');
const readback = await (await fetch(`${HOST}/api/token/onchain`)).json();
writeFileSync(join(DATA_DIR, 'onchain.json'), JSON.stringify(readback, null, 2) + '\n');
const pl = readback.pool ?? {};
const an = readback.anchors ?? {};
const cs = readback.claimState ?? {};
say(`    chain id       ${readback.chainIdSeen} (matches: ${readback.chainIdMatches})`);
say(`    total supply   ${readback.totalSupply} PEER at ${readback.decimals} decimals`);
say(`    pool           ${pl.configured === false ? 'OFF - ' + pl.why : `${pl.address} holding ${pl.resPeerRaw} PEER : ${pl.resBtcRaw} TBTC, ${pl.totalSharesRaw} shares, seeded ${pl.seeded}`}`);
say(`    anchors        ${an.configured === false ? 'OFF — ' + an.why : `discovered ${an.discovered}, posters ${an.posters}`}`);
say(`    claimState     ${cs.configured === false ? 'OFF — ' + cs.why : `epochs ${cs.discovered}, holding ${cs.heldRaw} raw PEER`}`);
const quiet = [];
if (an.configured === false) quiet.push('anchors reports itself off');
if (cs.configured === false) quiet.push('claimState reports itself off');
if (pl.configured === false) quiet.push('the pool reports itself off');
if (EXERCISE && pl.seeded === false) quiet.push('the pool reads as unseeded, but liquidity was added above');
if (EXERCISE && summary.anchor && !an.discovered) quiet.push('an anchor was posted above and the scan found none');
if (EXERCISE && summary.epoch && summary.epoch.opened && !cs.discovered) quiet.push('an epoch was opened above and the scan found none');
if (quiet.length) {
  say('');
  say('    THIS IS WRONG, and it is the whole reason this devnet exists:');
  for (const q of quiet) say('      - ' + q);
  say(`    the full body is in ${join(DATA_DIR, 'onchain.json')}`);
}
summary.readback = {
  chainIdMatches: readback.chainIdMatches,
  poolBtcRaw: pl.resBtcRaw, anchors: an.discovered, epochs: cs.discovered, held: cs.heldRaw,
  wrong: quiet,
};

writeFileSync(MARKER, JSON.stringify(summary, null, 2) + '\n');

// ── The summary ────────────────────────────────────────────────────────────
say('');
say('  ────────────────────────────────────────────────────────────────────────');
say('');
say(`  host           ${HOST}`);
say(`  rpc            ${RPC}   chain id ${CHAIN_ID}`);
say('');
say(`  PEER           ${peer.address}   ${PEER_SUPPLY} whole, ${peerDecimals} decimals`);
say(`  TBTC           ${tbtc.address}   ${TBTC_SUPPLY} whole, ${tbtcDecimals} decimals — STAND-IN for cbBTC, which has 8`);
say(`  PeerPool       ${pool.address}   the one pool; anyone may add to it`);
say(`  PeerAnchor     ${anchor.address}   from block ${anchor.block}`);
say(`  PeerClaim      ${claim.address}   from block ${claim.block}, steward ${DEPLOYER}`);
say('');
say(`  test wallet    ${WALLET}   bound to handle "al" (PIN ${PIN})`);
say(`  second earner  ${SECOND}   bound to handle "bo"`);
say(`  third earner   ${THIRD}   bound to handle "cy"`);
say('');
say('  open:');
say(`    ${HOST}/                       the app — sign in as al with PIN ${PIN}`);
say(`    ${HOST}/api/token/onchain      the whole reader: token, pool, anchors, claim state`);
say(`    ${HOST}/api/v1/epoch/1/claim?as=u_al   the proof the wallet card presses the button with`);
say('');
say(`  pids           devchain ${devchainPid ?? '(attached, not started here)'}, host ${hostPid}`);
say(`  stop           kill only these two pids; they are the only processes this tool started`);
say(`  everything     ${MARKER}`);
say('');
