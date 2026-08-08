// Reading the real chain, with no dependencies and no keys.
//
// This module can only ever READ. There is no signing code here, no private
// key is accepted by any function, and nothing it does can move a coin — by
// construction, not by discipline. The host displays on-chain truth; moving
// value is done by people in their own wallets.
//
// No ABI encoder and no keccak library either: every call this network makes
// is a fixed 4-byte selector with at most one address argument, so the
// selectors are hardcoded constants below (each with the signature it came
// from, so anyone can recompute it) and an address argument is just 32-byte
// left-padded hex. That is the whole encoder.
//
//   PEER_L2_RPC        JSON-RPC endpoint      (default Base mainnet)
//   PEER_L2_CHAIN_ID   expected chain id      (default 8453 = Base)
//   PEER_TOKEN_ADDR    the deployed PEER ERC-20
//   PEER_BTC_ADDR      the BTC-representing ERC-20 (cbBTC on Base)
//   PEER_POOL_ADDR     the AMM pair/pool holding PEER + BTC
//
// Nothing here has a default token address on purpose. An address baked into
// source is one nobody verified; if it is not configured, the feature is off
// and says so, exactly like proof-of-burn and paid placements.

const RPC = (process.env.PEER_L2_RPC || 'https://mainnet.base.org').trim();
const CHAIN_ID = Number(process.env.PEER_L2_CHAIN_ID || 8453);
const clean = (a) => {
  const s = String(a || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : '';
};
export const TOKEN_ADDR = clean(process.env.PEER_TOKEN_ADDR);
export const BTC_ADDR = clean(process.env.PEER_BTC_ADDR);
export const POOL_ADDR = clean(process.env.PEER_POOL_ADDR);
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
};

const pad = (addr) => String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');

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

/** Fixed-point BigInt -> Number, for display only. Never for arithmetic that
 *  decides anything: this is where precision goes to die, so the raw string
 *  is always carried alongside it. */
function human(v, dec) {
  if (v === null) return null;
  return Number(v) / Math.pow(10, dec);
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
  const id = Number(BigInt(await rpc('eth_chainId', [])));
  out.chainIdSeen = id;
  out.chainIdMatches = id === CHAIN_ID;
  if (!out.chainIdMatches) {
    out.error = 'the RPC answered for chain ' + id + ', not ' + CHAIN_ID + ' — refusing to report its numbers as this network’s';
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
  return out;
}

/** One account's PEER balance, raw and humanised. */
export async function balanceOf(addr) {
  const a = clean(addr);
  if (!L2_ON || !a) return null;
  const raw = word(await call(TOKEN_ADDR, SEL.balanceOf + pad(a)));
  if (raw === null) return null;
  const dec = Number(word(await call(TOKEN_ADDR, SEL.decimals)) ?? 18n);
  return { address: a, raw: raw.toString(), amount: human(raw, dec), decimals: dec };
}
