// A test chain, on this machine, that must never be pointed at a real network.
//
// Everything this repo has built on-chain — named pools, anchored epochs,
// merkle claims, the wallet card — has been checked by unit tests and by
// read-only reads against Base. None of it has ever been USED, because using
// it needs a funded wallet and a signature, and on Base that means real money
// and a real private key. This file exists so the whole flow can be driven for
// real at a cost of nothing: a JSON-RPC endpoint that speaks enough Ethereum
// for chain-l2/onchain.mjs and for a page in a browser, backed by
// @ethereumjs/vm running the actual compiled contracts in memory.
//
// Read this part twice:
//
//   * This chain is worthless and is meant to be. Its "coins" are numbers in
//     one Node process and they disappear when it exits. There is no
//     persistence, no peers, no consensus, and no history beyond the current
//     run.
//   * Its accounts are UNLOCKED. eth_sendTransaction here executes straight
//     from whatever `from` you name, with no signature and no proof you own
//     that address. On a real network that is the entire security model,
//     absent.
//   * Its private keys are PRINTED IN THIS SOURCE FILE's output, derived from
//     fixed labels below so they are the same on every machine and every run.
//     Anyone who has ever read this file can spend from those addresses. They
//     exist only so a browser wallet can import one and sign against this
//     chain. Value sent to them anywhere else is gone.
//   * It binds 127.0.0.1 and nothing else, so nothing off this machine can
//     reach it.
//
// So: nothing here may ever be handed a mainnet RPC, a mainnet chain id, or a
// key anyone cares about. It is a fake chain that behaves enough like the real
// one to find the bugs that only appear when something is actually used.
//
//   node tools/devchain.mjs [--port 8545] [--chain-id 31337] [--accounts 5]
//
// Point the reader at it with the two variables it already reads:
//
//   PEER_L2_RPC=http://127.0.0.1:8545  PEER_L2_CHAIN_ID=31337
//
// WHAT IT IS NOT. Being clear about the gaps matters more than the features,
// because a gap you meet by surprise looks like a bug in the thing you were
// testing:
//
//   * Only the LATEST state exists. There are no historical state roots and no
//     archive, so eth_call / eth_getBalance / eth_getCode / eth_getStorageAt
//     against an older block number are REFUSED by name rather than answered
//     from the head, which would be a wrong number that looks right. Logs and
//     receipts, which are stored as they are produced, are queryable over the
//     full history.
//   * Gas is not paid for. Execution is metered exactly (an out-of-gas here is
//     a real out-of-gas) but no ether leaves the sender's balance, so balances
//     only move when a transaction moves them. That makes value assertions in
//     a test mean what they say.
//   * Block and transaction hashes are keccak over the fields this chain
//     actually has, not over an Ethereum header or a signed transaction —
//     there are no headers here and unlocked transactions carry no signature.
//     They are unique and stable identifiers; they are not verifiable against
//     anything.
//   * One block per transaction, no mempool, no reorgs, no pending state.
//     'pending', 'safe' and 'finalized' all mean the head, because on a chain
//     that mines synchronously they do.
//   * A block's stateRoot, transactionsRoot and receiptsRoot are zero. No trie
//     is built here, so there is nothing to root. The logs bloom on a block and
//     on a receipt IS computed for real, because a client may filter on it and
//     a zero bloom would make it skip a block that did emit logs.

import { createServer } from 'node:http';
import { createEVM } from '@ethereumjs/evm';
import { SimpleStateManager } from '@ethereumjs/statemanager';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { Bloom } from '@ethereumjs/vm';
import { createTxFromRLP } from '@ethereumjs/tx';
import { RLP } from '@ethereumjs/rlp';
import {
  Address,
  bytesToHex,
  createAddressFromPrivateKey,
  createAddressFromString,
  createZeroAddress,
  hexToBytes,
  utf8ToBytes,
} from '@ethereumjs/util';
import { keccak_256 } from '@noble/hashes/sha3.js';

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(1);
  }
  return v;
}
function whole(name, dflt, min, max) {
  const raw = String(flag(name, dflt));
  let v;
  try {
    v = BigInt(raw);
  } catch {
    console.error(`--${name} wants a whole number, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  if (v < min || v > max) {
    console.error(`--${name} must be between ${min} and ${max}, got ${v}`);
    process.exit(1);
  }
  return v;
}
const PORT = Number(whole('port', 8545, 1n, 65535n));
const CHAIN_ID = whole('chain-id', 31337, 1n, BigInt(Number.MAX_SAFE_INTEGER));
const ACCOUNT_COUNT = Number(whole('accounts', 5, 1n, 100n));

// 8453 is Base and 1 is Ethereum. Refusing them is not paranoia about this
// process reaching them — it cannot, it has no peers — it is about the OTHER
// side: a host configured with PEER_L2_CHAIN_ID=8453 and pointed here would
// pass its own chain check and report this chain's invented numbers as Base's.
// The chain check in onchain.mjs is the last thing standing between a test
// fixture and a page that says "this is what is on Base".
const FORBIDDEN_CHAIN_IDS = new Map([
  [1n, 'Ethereum mainnet'],
  [10n, 'OP Mainnet'],
  [56n, 'BNB Chain'],
  [137n, 'Polygon'],
  [8453n, 'Base'],
  [42161n, 'Arbitrum One'],
]);
if (FORBIDDEN_CHAIN_IDS.has(CHAIN_ID)) {
  console.error(
    `refusing to run as chain ${CHAIN_ID} (${FORBIDDEN_CHAIN_IDS.get(CHAIN_ID)}). ` +
      'This is a fake chain; wearing a real network’s id would let a host report its ' +
      'invented numbers as that network’s. Pick a test id such as 31337.',
  );
  process.exit(1);
}

const BLOCK_GAS_LIMIT = 30_000_000n;
// 10,000 ETH each, in wei. Large enough that no test ever runs out, small
// enough that it is obviously not a real balance.
const FUNDING = 10_000n * 10n ** 18n;

// ---------------------------------------------------------------------------
// The unlocked accounts
//
// Derived from fixed labels so the same addresses appear on every machine,
// which is what makes a devchain scriptable: a harness can hardcode account 0
// and be right tomorrow. keccak of a label is a 32-byte number; the chance one
// of them falls outside the secp256k1 range is about 2^-128, and if it ever
// did, createAddressFromPrivateKey would throw here at boot rather than
// somewhere confusing later.
// ---------------------------------------------------------------------------

const accounts = [];
for (let i = 0; i < ACCOUNT_COUNT; i++) {
  const key = keccak_256(utf8ToBytes('peer devchain test account ' + i));
  const address = createAddressFromPrivateKey(key);
  accounts.push({ index: i, address, privateKey: bytesToHex(key) });
}

// ---------------------------------------------------------------------------
// Chain state
//
// Three arrays and two maps, all in memory. `blocks` is indexed by block
// number, so blocks[0] is genesis and blocks.length - 1 is the head.
// ---------------------------------------------------------------------------

const blocks = [];
const txByHash = new Map();
const receiptByHash = new Map();
/** Every log ever emitted, in emission order. eth_getLogs walks this. */
const allLogs = [];

const head = () => blocks[blocks.length - 1];
const quantity = (n) => '0x' + BigInt(n).toString(16);

/**
 * A block's identity.
 *
 * Not an Ethereum header hash — this chain has no headers to hash. It is
 * keccak over the fields a block here actually has, which makes it unique,
 * stable across runs with the same transactions, and useless as proof of
 * anything. Said plainly here because a 32-byte hex string looks equally
 * authoritative either way.
 */
function blockIdentity(number, parentHash, timestamp, txHashes) {
  return bytesToHex(
    keccak_256(
      RLP.encode([
        bigIntToRlp(CHAIN_ID),
        bigIntToRlp(number),
        hexToBytes(parentHash),
        bigIntToRlp(timestamp),
        ...txHashes.map((h) => hexToBytes(h)),
      ]),
    ),
  );
}

/** Minimal big-endian bytes for RLP, since RLP has no bigint encoder. */
function bigIntToRlp(v) {
  let hex = BigInt(v).toString(16);
  if (hex === '0') return new Uint8Array(0);
  if (hex.length % 2) hex = '0' + hex;
  return hexToBytes('0x' + hex);
}

/**
 * A transaction's identity, for the unlocked path.
 *
 * A real transaction hash is keccak of its signed encoding, and an unlocked
 * transaction has no signature to encode — so this is keccak over the fields
 * that were actually executed, plus the block it landed in so that two
 * identical transfers from the same sender are still two different rows. A
 * transaction that arrived already signed keeps its own real hash instead;
 * see eth_sendRawTransaction.
 */
function txIdentity({ from, nonce, to, value, data, blockNumber }) {
  return bytesToHex(
    keccak_256(
      RLP.encode([
        bigIntToRlp(CHAIN_ID),
        from.bytes,
        bigIntToRlp(nonce),
        to ? to.bytes : new Uint8Array(0),
        bigIntToRlp(value),
        data,
        bigIntToRlp(blockNumber),
      ]),
    ),
  );
}

/** The block object the EVM reads for NUMBER, TIMESTAMP, COINBASE and friends. */
function evmBlock(number, timestamp) {
  return {
    header: {
      number,
      coinbase: createZeroAddress(),
      timestamp,
      difficulty: 0n,
      prevRandao: new Uint8Array(32),
      gasLimit: BLOCK_GAS_LIMIT,
      baseFeePerGas: 0n,
      getBlobGasPrice: () => 1n,
    },
  };
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

const stateManager = new SimpleStateManager();
// Number, not BigInt: Common JSON round-trips its chain config and JSON has no
// bigint. --chain-id is capped at MAX_SAFE_INTEGER above so this cannot round.
const common = createCustomCommon({ chainId: Number(CHAIN_ID) }, Mainnet, { hardfork: Hardfork.Cancun });
// BLOCKHASH should answer with the identities this chain actually handed out,
// not the zeroes the library's stand-in returns, or a contract that checks a
// recent block hash gets a value no client can look up.
const blockchain = {
  async getBlock(id) {
    const n = Number(id);
    const b = blocks[n];
    const bytes = b ? hexToBytes(b.hash) : new Uint8Array(32);
    return { hash: () => bytes };
  },
  async putBlock() {},
  shallowCopy() {
    return this;
  },
};
const evm = await createEVM({ common, stateManager, blockchain });

// ---------------------------------------------------------------------------
// Gas
//
// Execution gas is metered by the EVM and is exactly right. What the EVM does
// NOT charge is the intrinsic cost a transaction pays before its first opcode,
// so that is computed here and added on. Getting it wrong would not make a
// test fail — it would make every gas number quietly too small, and a harness
// that copies a receipt's gasUsed into a real transaction's limit would run
// out of gas on the network this is a rehearsal for.
// ---------------------------------------------------------------------------

function intrinsicGas(data, isCreate) {
  let gas = 21_000n;
  for (const b of data) gas += b === 0 ? 4n : 16n;
  if (isCreate) {
    gas += 32_000n;
    // EIP-3860: two gas per 32-byte word of init code, Shanghai onwards.
    gas += 2n * BigInt(Math.ceil(data.length / 32));
  }
  return gas;
}

// ---------------------------------------------------------------------------
// Execution
//
// One entry point for calls, estimates and transactions, because they are the
// same execution and only differ in whether the result is kept. The caller's
// nonce is bumped by the EVM itself at depth 0, which is also where CREATE
// takes the address from — so a reverted eth_call must undo that too, and does,
// via the outer checkpoint.
// ---------------------------------------------------------------------------

let running = Promise.resolve();
/** One request at a time. There is one state and one journal; two overlapping
 *  executions would interleave their checkpoints and corrupt both. */
function serialize(fn) {
  const next = running.then(fn, fn);
  running = next.then(
    () => {},
    () => {},
  );
  return next;
}

async function execute({ from, to, data, value, gasLimit, number, timestamp, keep }) {
  await stateManager.checkpoint();
  let result;
  try {
    result = await evm.runCall({
      caller: from,
      origin: from,
      to,
      data,
      value,
      gasLimit,
      gasPrice: 0n,
      block: evmBlock(number, timestamp),
    });
    await evm.journal.cleanup();
  } catch (err) {
    await stateManager.revert();
    throw err;
  }
  // A transaction is kept even when it reverts: the sender's nonce still moved
  // and the receipt still exists with status 0, exactly as on a real chain.
  // The EVM has already rolled back everything the failed call touched.
  if (keep) await stateManager.commit();
  else await stateManager.revert();
  return result;
}

/** The bytes a revert came back with, and the string inside if it is the
 *  standard Error(string) shape, so a failure says why instead of "reverted". */
function revertInfo(result) {
  const raw = bytesToHex(result.execResult.returnValue);
  let message = 'execution reverted';
  if (raw.startsWith('0x08c379a0') && raw.length >= 10 + 128) {
    try {
      const len = Number(BigInt('0x' + raw.slice(10 + 64, 10 + 128)));
      const body = raw.slice(10 + 128, 10 + 128 + len * 2);
      const text = new TextDecoder().decode(hexToBytes('0x' + body));
      if (text) message += ': ' + text;
    } catch {
      /* a malformed revert string is still a revert */
    }
  }
  const err = result.execResult.exceptionError;
  if (raw === '0x' && err) message = 'execution failed: ' + String(err.error || err);
  return { message, data: raw };
}

/**
 * Run a transaction and mine the block that holds it.
 *
 * One block per transaction, which is what makes a devchain easy to reason
 * about: a receipt's block number is a sequence number. Timestamps advance by
 * the wall clock but never repeat or go backwards, because two blocks sharing a
 * timestamp is legal on Ethereum and confusing everywhere else.
 */
async function mine({ from, to, data, value, gas, hash }) {
  const parent = head();
  const number = parent.number + 1n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const timestamp = now > parent.timestamp ? now : parent.timestamp + 1n;

  const isCreate = to === undefined;
  const intrinsic = intrinsicGas(data, isCreate);
  const limit = gas === undefined ? BLOCK_GAS_LIMIT : gas;
  if (limit < intrinsic) {
    throw rpcError(-32000, `intrinsic gas too low: this transaction needs at least ${intrinsic}, was given ${limit}`);
  }
  if (limit > BLOCK_GAS_LIMIT) {
    throw rpcError(-32000, `gas limit ${limit} is above this chain's block gas limit of ${BLOCK_GAS_LIMIT}`);
  }

  const account = await stateManager.getAccount(from);
  const nonce = account ? account.nonce : 0n;

  const result = await execute({
    from,
    to,
    data,
    value,
    gasLimit: limit - intrinsic,
    number,
    timestamp,
    keep: true,
  });

  const txHash = hash ?? txIdentity({ from, nonce, to, value, data, blockNumber: number });
  const failed = result.execResult.exceptionError !== undefined;

  // Refunds (SSTORE clears, mainly) are capped at a fifth of the gas used from
  // London onwards, and are forfeited entirely by a failed transaction.
  let used = intrinsic + result.execResult.executionGasUsed;
  if (!failed) {
    const refund = result.execResult.gasRefund ?? 0n;
    const cap = used / 5n;
    used -= refund > cap ? cap : refund;
  }

  const bloom = new Bloom(undefined, common);
  const blockHash = blockIdentity(number, parent.hash, timestamp, [txHash]);
  const logs = (result.execResult.logs ?? []).map(([address, topics, logData], i) => {
    bloom.add(address);
    for (const t of topics) bloom.add(t);
    return {
      address: bytesToHex(address),
      topics: topics.map((t) => bytesToHex(t)),
      data: bytesToHex(logData),
      blockNumber: quantity(number),
      blockHash,
      transactionHash: txHash,
      transactionIndex: '0x0',
      logIndex: quantity(i),
      removed: false,
    };
  });
  for (const log of logs) allLogs.push({ ...log, _block: number });

  // The block carries the same bloom as its one receipt, because it holds
  // exactly one transaction. A zero bloom on a block that emitted logs is the
  // kind of lie a bloom-filtering client cannot see through: it would skip the
  // block and conclude nothing happened in it.
  const block = {
    number,
    hash: blockHash,
    parentHash: parent.hash,
    timestamp,
    gasUsed: used,
    txHashes: [txHash],
    logsBloom: bytesToHex(bloom.bitvector),
  };
  blocks.push(block);

  txByHash.set(txHash, {
    hash: txHash,
    nonce: quantity(nonce),
    blockHash,
    blockNumber: quantity(number),
    transactionIndex: '0x0',
    from: from.toString(),
    to: to ? to.toString() : null,
    value: quantity(value),
    gas: quantity(limit),
    gasPrice: '0x0',
    input: bytesToHex(data),
    chainId: quantity(CHAIN_ID),
    type: '0x0',
  });
  receiptByHash.set(txHash, {
    transactionHash: txHash,
    transactionIndex: '0x0',
    blockHash,
    blockNumber: quantity(number),
    from: from.toString(),
    to: to ? to.toString() : null,
    cumulativeGasUsed: quantity(used),
    gasUsed: quantity(used),
    effectiveGasPrice: '0x0',
    contractAddress: result.createdAddress ? result.createdAddress.toString() : null,
    logs,
    logsBloom: bytesToHex(bloom.bitvector),
    status: failed ? '0x0' : '0x1',
    type: '0x0',
  });

  return { txHash, result, failed };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function rpcError(code, message, data) {
  const e = new Error(message);
  e.rpc = data === undefined ? { code, message } : { code, message, data };
  return e;
}

function addressOf(value, what) {
  const s = String(value ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw rpcError(-32602, `${what} is not a 20-byte address: ${JSON.stringify(value)}`);
  return createAddressFromString(s.toLowerCase());
}

function bytesOf(value, what) {
  if (value === undefined || value === null || value === '') return new Uint8Array(0);
  const s = String(value);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) throw rpcError(-32602, `${what} is not hex bytes: ${JSON.stringify(value)}`);
  return hexToBytes(s);
}

function bigOf(value, what, dflt) {
  if (value === undefined || value === null || value === '') return dflt;
  try {
    return BigInt(value);
  } catch {
    throw rpcError(-32602, `${what} is not a number: ${JSON.stringify(value)}`);
  }
}

/**
 * A block tag to a number.
 *
 * 'pending', 'safe' and 'finalized' are the head here and that is not a
 * shortcut: this chain mines a block per transaction with no mempool and no
 * consensus, so nothing is ever pending and everything is final the moment it
 * exists.
 */
function blockNumberOf(tag, what) {
  if (tag === undefined || tag === null || tag === '') return head().number;
  const s = String(tag);
  if (s === 'latest' || s === 'pending' || s === 'safe' || s === 'finalized') return head().number;
  if (s === 'earliest') return 0n;
  let n;
  try {
    n = BigInt(s);
  } catch {
    throw rpcError(-32602, `${what} is not a block tag this chain knows: ${JSON.stringify(tag)}`);
  }
  if (n < 0n) throw rpcError(-32602, `${what} is negative: ${s}`);
  return n;
}

/**
 * State questions may only be asked about the head.
 *
 * There is one state here and no archive. Answering "balance at block 3" from
 * block 40's state would be a wrong number wearing the shape of a right one,
 * and the caller would have no way to tell. So it is refused, by name.
 */
function requireHead(tag, method) {
  const n = blockNumberOf(tag, 'the block tag');
  if (n !== head().number) {
    throw rpcError(
      -32000,
      `${method} was asked about block ${n}, and this test chain keeps only the state of its head (block ${head().number}). ` +
        'There is no archive here; ask about "latest", or read logs and receipts, which are kept for every block.',
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Methods
//
// Everything chain-l2/onchain.mjs asks for, everything a page needs to send a
// transaction, and nothing speculative. A method that is not here says so with
// its own name in the message, because "method not found" with no name has
// sent people looking in the wrong file more than once.
// ---------------------------------------------------------------------------

const methods = {
  // --- identity ---------------------------------------------------------
  eth_chainId: () => quantity(CHAIN_ID),
  net_version: () => CHAIN_ID.toString(10),
  web3_clientVersion: () => 'peer-devchain/1.0 (ethereumjs, test chain, unlocked accounts)',
  eth_accounts: () => accounts.map((a) => a.address.toString()),
  // A page that expects an injected wallet asks this before anything else.
  // Here every account is already unlocked, so there is nothing to grant.
  eth_requestAccounts: () => accounts.map((a) => a.address.toString()),

  // --- reading the head -------------------------------------------------
  eth_blockNumber: () => quantity(head().number),
  eth_gasPrice: () => '0x0',
  eth_maxPriorityFeePerGas: () => '0x0',

  async eth_getBalance([who, tag]) {
    requireHead(tag, 'eth_getBalance');
    const account = await stateManager.getAccount(addressOf(who, 'the account'));
    return quantity(account ? account.balance : 0n);
  },

  async eth_getTransactionCount([who, tag]) {
    requireHead(tag, 'eth_getTransactionCount');
    const account = await stateManager.getAccount(addressOf(who, 'the account'));
    return quantity(account ? account.nonce : 0n);
  },

  async eth_getCode([who, tag]) {
    requireHead(tag, 'eth_getCode');
    return bytesToHex(await stateManager.getCode(addressOf(who, 'the address')));
  },

  async eth_getStorageAt([who, slot, tag]) {
    requireHead(tag, 'eth_getStorageAt');
    const key = bytesOf(slot, 'the storage slot');
    const padded = new Uint8Array(32);
    padded.set(key.slice(-32), 32 - Math.min(32, key.length));
    const value = await stateManager.getStorage(addressOf(who, 'the address'), padded);
    const out = new Uint8Array(32);
    out.set(value.slice(-32), 32 - Math.min(32, value.length));
    return bytesToHex(out);
  },

  // --- calling ----------------------------------------------------------
  async eth_call([tx, tag]) {
    requireHead(tag, 'eth_call');
    const from = tx?.from ? addressOf(tx.from, 'the caller') : accounts[0].address;
    const to = tx?.to ? addressOf(tx.to, 'the callee') : undefined;
    const data = bytesOf(tx?.data ?? tx?.input, 'the call data');
    const value = bigOf(tx?.value, 'the value', 0n);
    const gas = bigOf(tx?.gas ?? tx?.gasLimit, 'the gas', BLOCK_GAS_LIMIT);
    const intrinsic = intrinsicGas(data, to === undefined);
    const result = await execute({
      from,
      to,
      data,
      value,
      // A call given less than its intrinsic cost gets nothing to run on, and
      // fails as an out-of-gas. Handing it the full amount instead would make
      // an under-funded call succeed here and fail on a real network.
      gasLimit: gas > intrinsic ? gas - intrinsic : 0n,
      number: head().number,
      timestamp: head().timestamp,
      keep: false,
    });
    if (result.execResult.exceptionError) {
      const { message, data: reason } = revertInfo(result);
      // Code 3 with the revert bytes in `data` is what every real endpoint
      // sends and what every client knows how to unpack.
      throw rpcError(3, message, reason);
    }
    return bytesToHex(result.execResult.returnValue);
  },

  /**
   * The smallest gas limit this transaction actually succeeds at.
   *
   * Measured, then binary-searched, rather than measured and padded. The 63/64
   * rule means a call can use less gas than it needs to be GIVEN — a padded
   * guess is right most of the time and wrong exactly on the deep-call cases a
   * test is trying to reach, and it fails as an out-of-gas with no hint that
   * the estimate was the problem.
   */
  async eth_estimateGas([tx]) {
    const from = tx?.from ? addressOf(tx.from, 'the caller') : accounts[0].address;
    const to = tx?.to ? addressOf(tx.to, 'the callee') : undefined;
    const data = bytesOf(tx?.data ?? tx?.input, 'the call data');
    const value = bigOf(tx?.value, 'the value', 0n);
    const intrinsic = intrinsicGas(data, to === undefined);
    const at = head();

    const attempt = (limit) =>
      execute({
        from,
        to,
        data,
        value,
        gasLimit: limit - intrinsic,
        number: at.number,
        timestamp: at.timestamp,
        keep: false,
      });

    const full = await attempt(BLOCK_GAS_LIMIT);
    if (full.execResult.exceptionError) {
      const { message, data: reason } = revertInfo(full);
      throw rpcError(3, message, reason);
    }

    let lo = intrinsic + full.execResult.executionGasUsed;
    let hi = BLOCK_GAS_LIMIT;
    if (!(await attempt(lo)).execResult.exceptionError) return quantity(lo);
    // ~15 halvings from 30M down to the 1000-wide window below.
    while (hi - lo > 1_000n && hi - lo > lo / 64n) {
      const mid = (hi + lo) / 2n;
      if ((await attempt(mid)).execResult.exceptionError) lo = mid;
      else hi = mid;
    }
    return quantity(hi);
  },

  // --- sending ----------------------------------------------------------
  /**
   * Execute directly as `from`. No signature is asked for and none is checked.
   *
   * This is the whole point of an unlocked chain and it is also the single most
   * dangerous line in this file if it ever ran anywhere real: anyone who can
   * reach this port can move anything belonging to anyone. It reaches exactly
   * one interface, 127.0.0.1, and that is the only thing keeping it honest.
   */
  async eth_sendTransaction([tx]) {
    if (!tx || typeof tx !== 'object') throw rpcError(-32602, 'eth_sendTransaction needs a transaction object');
    const from = addressOf(tx.from, 'the sender');
    const to = tx.to ? addressOf(tx.to, 'the recipient') : undefined;
    const data = bytesOf(tx.data ?? tx.input, 'the transaction data');
    const value = bigOf(tx.value, 'the value', 0n);
    const gas = bigOf(tx.gas ?? tx.gasLimit, 'the gas', undefined);
    const { txHash } = await mine({ from, to, data, value, gas });
    return txHash;
  },

  /**
   * The same execution, for a transaction that arrived already signed.
   *
   * A wallet extension signs and sends bytes; it never calls
   * eth_sendTransaction on the node. The signature is decoded only to learn who
   * sent it — this chain enforces nothing else about it, and in particular does
   * not check the nonce, because a wallet that has cached a stale nonce should
   * be a nuisance here rather than a wall.
   */
  async eth_sendRawTransaction([raw]) {
    const bytes = bytesOf(raw, 'the signed transaction');
    let tx;
    try {
      tx = createTxFromRLP(bytes, { common });
    } catch (e) {
      throw rpcError(-32602, 'could not decode that as a transaction: ' + String(e && e.message));
    }
    let from;
    try {
      from = tx.getSenderAddress();
    } catch (e) {
      throw rpcError(-32000, 'that transaction carries no recoverable signature: ' + String(e && e.message));
    }
    const { txHash } = await mine({
      from,
      to: tx.to ?? undefined,
      data: tx.data ?? new Uint8Array(0),
      value: tx.value ?? 0n,
      gas: tx.gasLimit,
      hash: bytesToHex(tx.hash()),
    });
    return txHash;
  },

  // --- receipts, transactions, blocks -----------------------------------
  // A receipt for a hash this chain has never seen is null, not an error: that
  // is how a client polls for one, and an error would look like a failure.
  eth_getTransactionReceipt: ([hash]) => receiptByHash.get(String(hash ?? '').toLowerCase()) ?? null,
  eth_getTransactionByHash: ([hash]) => txByHash.get(String(hash ?? '').toLowerCase()) ?? null,

  eth_getBlockByNumber([tag, full]) {
    const n = blockNumberOf(tag, 'the block tag');
    return blockJSON(blocks[Number(n)], full === true);
  },
  eth_getBlockByHash([hash, full]) {
    const want = String(hash ?? '').toLowerCase();
    return blockJSON(
      blocks.find((b) => b.hash === want),
      full === true,
    );
  },

  /**
   * Logs, filtered the way a real endpoint filters them.
   *
   * onchain.mjs finds every pool, every anchor and every opened epoch through
   * this one method, so a bug here does not raise an error anywhere — it
   * returns an empty list, which is indistinguishable from a contract nobody
   * has ever used. That is the failure this whole devchain exists to be able to
   * catch, so the matching rules are spelled out rather than assumed:
   * `address` may be one or many, a topic filter position of null matches
   * anything, an array at a position matches any of its entries, and a filter
   * shorter than the log's topic list still matches.
   */
  eth_getLogs([filter]) {
    const f = filter ?? {};
    let from;
    let to;
    if (f.blockHash !== undefined && f.blockHash !== null) {
      const want = String(f.blockHash).toLowerCase();
      const block = blocks.find((b) => b.hash === want);
      if (!block) throw rpcError(-32000, 'no block on this chain has hash ' + want);
      from = block.number;
      to = block.number;
    } else {
      from = blockNumberOf(f.fromBlock, 'fromBlock');
      to = blockNumberOf(f.toBlock, 'toBlock');
    }
    if (to < from) throw rpcError(-32602, `toBlock (${to}) is before fromBlock (${from})`);

    const wanted = f.address === undefined || f.address === null
      ? null
      : new Set((Array.isArray(f.address) ? f.address : [f.address]).map((a) => String(a).toLowerCase()));
    if (wanted) {
      for (const a of wanted) {
        if (!/^0x[0-9a-f]{40}$/.test(a)) throw rpcError(-32602, `the address filter holds something that is not an address: ${a}`);
      }
    }
    const topicFilter = Array.isArray(f.topics) ? f.topics : null;

    const out = [];
    for (const log of allLogs) {
      if (log._block < from || log._block > to) continue;
      if (wanted && !wanted.has(log.address)) continue;
      if (topicFilter && !topicsMatch(topicFilter, log.topics)) continue;
      const { _block, ...rest } = log;
      out.push(rest);
    }
    return out;
  },

  /**
   * Enough of a fee history for a wallet to pick a fee on a chain that has no
   * fees. Every block here is zero-base-fee, so the honest answer is a column
   * of zeroes rather than an error that stops a wallet from building a
   * transaction at all.
   */
  eth_feeHistory([count, newest]) {
    const n = blockNumberOf(newest, 'the newest block');
    const want = Number(bigOf(count, 'the block count', 1n));
    const oldest = n - BigInt(Math.max(0, want - 1)) < 0n ? 0n : n - BigInt(Math.max(0, want - 1));
    const span = Number(n - oldest) + 1;
    return {
      oldestBlock: quantity(oldest),
      baseFeePerGas: new Array(span + 1).fill('0x0'),
      gasUsedRatio: new Array(span).fill(0),
      reward: new Array(span).fill(['0x0']),
    };
  },

  /** A page asking to be switched to this chain is already on it, or is asking
   *  for a chain this process is not. Both answers are short. */
  wallet_switchEthereumChain([target]) {
    const want = String(target?.chainId ?? '');
    if (want && BigInt(want) !== CHAIN_ID) {
      throw rpcError(4902, `this endpoint is chain ${CHAIN_ID}; it cannot switch to ${BigInt(want)}`);
    }
    return null;
  },
};

function topicsMatch(filter, topics) {
  if (filter.length > topics.length) return false;
  for (let i = 0; i < filter.length; i++) {
    const want = filter[i];
    if (want === null || want === undefined) continue;
    const options = (Array.isArray(want) ? want : [want]).map((t) => String(t).toLowerCase());
    if (options.length === 0) continue;
    if (!options.includes(topics[i])) return false;
  }
  return true;
}

function blockJSON(block, full) {
  if (!block) return null;
  return {
    number: quantity(block.number),
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: quantity(block.timestamp),
    gasLimit: quantity(BLOCK_GAS_LIMIT),
    gasUsed: quantity(block.gasUsed),
    baseFeePerGas: '0x0',
    miner: createZeroAddress().toString(),
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x0',
    nonce: '0x0000000000000000',
    mixHash: '0x' + '0'.repeat(64),
    sha3Uncles: '0x' + '0'.repeat(64),
    // Zero because this chain computes no tries, not because they hashed to
    // zero. They are present so a client that reads the field finds one, and
    // they are worth nothing — see the header. The bloom, by contrast, is real:
    // it is computed from the logs the block actually emitted.
    stateRoot: '0x' + '0'.repeat(64),
    transactionsRoot: '0x' + '0'.repeat(64),
    receiptsRoot: '0x' + '0'.repeat(64),
    logsBloom: block.logsBloom ?? '0x' + '0'.repeat(512),
    uncles: [],
    transactions: full ? block.txHashes.map((h) => txByHash.get(h)) : block.txHashes,
  };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

async function handle(request) {
  const { id = null, method, params } = request ?? {};
  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'a JSON-RPC request needs a "method" string' } };
  }
  const fn = methods[method];
  if (!fn) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `no method named "${method}" on this test chain — it implements only what chain-l2/onchain.mjs and a browser wallet need; see the list at the top of tools/devchain.mjs`,
      },
    };
  }
  try {
    const result = await serialize(() => fn(Array.isArray(params) ? params : []));
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (err && err.rpc) return { jsonrpc: '2.0', id, error: err.rpc };
    return { jsonrpc: '2.0', id, error: { code: -32603, message: `${method} failed: ${err && err.message}` } };
  }
}

const CORS = {
  // A page served from any origin — file://, a vite dev server, the host on
  // 5210 — has to be able to POST here, and a devchain that a browser cannot
  // reach is half a devchain. This is only survivable because of the bind
  // address: nothing outside this machine gets to have an origin here.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('JSON-RPC over POST only. This is a test chain; see tools/devchain.mjs.\n');
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 8_000_000) req.destroy();
  });
  req.on('end', async () => {
    const send = (payload) => {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'that was not JSON' } });
      return;
    }
    try {
      // Batches are answered as batches; some wallets send them.
      send(Array.isArray(parsed) ? await Promise.all(parsed.map(handle)) : await handle(parsed));
    } catch (err) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err && err.message) } });
    }
  });
});

server.on('error', (e) => {
  console.error(
    e && e.code === 'EADDRINUSE'
      ? `port ${PORT} is taken. Something is already listening there — pick another with --port.`
      : 'could not listen: ' + (e && e.message),
  );
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Genesis, then boot
// ---------------------------------------------------------------------------

for (const a of accounts) await stateManager.modifyAccountFields(a.address, { balance: FUNDING });

const genesisTime = BigInt(Math.floor(Date.now() / 1000));
blocks.push({
  number: 0n,
  hash: blockIdentity(0n, '0x' + '0'.repeat(64), genesisTime, []),
  parentHash: '0x' + '0'.repeat(64),
  timestamp: genesisTime,
  gasUsed: 0n,
  txHashes: [],
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  peer devchain — a TEST chain. Worthless coins, unlocked accounts, memory only.');
  console.log('');
  console.log(`  rpc        http://127.0.0.1:${PORT}`);
  console.log(`  chain id   ${CHAIN_ID}`);
  console.log(`  hardfork   ${common.hardfork()}`);
  console.log(`  gas limit  ${BLOCK_GAS_LIMIT} per block`);
  console.log('');
  console.log(`  ${accounts.length} unlocked accounts, ${FUNDING / 10n ** 18n} ETH each:`);
  for (const a of accounts) {
    console.log(`    [${a.index}] ${a.address.toString()}`);
    console.log(`        key  ${a.privateKey}`);
  }
  console.log('');
  console.log('  Those keys are printed in this repo’s source. They are for this fake chain');
  console.log('  and nowhere else — anything of value sent to those addresses on a real');
  console.log('  network belongs to whoever reads the file first.');
  console.log('');
  console.log(`  point the reader at it:  PEER_L2_RPC=http://127.0.0.1:${PORT}  PEER_L2_CHAIN_ID=${CHAIN_ID}`);
  console.log('  Ctrl-C to stop. Nothing is saved.');
  console.log('');
});
