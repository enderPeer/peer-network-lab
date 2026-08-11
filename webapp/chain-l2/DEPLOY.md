# Putting PEER on a real chain — the runbook

Everything here is built and tested. What is left is the part that needs a
private key, which is yours and stays yours. Budget: **under $0.30 of gas**
for the whole thing. Read the whole page before starting.

## Why Base

Measured live on 2026-08-08 against three families of chain, not chosen from
memory:

| | deploy a token | create + seed a pool | BTC asset | activity |
|---|---|---|---|---|
| **Base** | ~$0.04 | **under $0.25** | cbBTC, 44,721 BTC backing | millions tx/day |
| Rootstock | ~$2 | ~$10 | RBTC, native, federated peg | ~7,000 tx/day |
| Stacks | ~$0.05 | — | sBTC, real | **no permissionless AMM** |

Base wins on all three of cheap, efficient and scalable. The honest tradeoff:
**cbBTC is custodied by Coinbase**, 1:1 and redeemable, where Rootstock's
RBTC uses a more decentralised federated peg. If that tradeoff ever stops
being acceptable, `onchain.mjs` is config-driven — Rootstock is a different
`PEER_L2_RPC` and `PEER_L2_CHAIN_ID`, not a rewrite.

## What you need first

1. A browser wallet (MetaMask or Rabby) with a **fresh account** used for
   nothing else. Write the seed phrase on paper. Nobody, including me, ever
   needs to see it.
2. **~$2 of ETH on Base** for gas. Deployment costs about $0.25 all-in; this
   is 8x over-provisioned on purpose so a fee spike cannot strand you
   mid-sequence.
3. **The BTC you want to seed with, as cbBTC on Base.** Buy BTC on Coinbase,
   convert to cbBTC, withdraw choosing the **Base** network. No bridge, no
   wrapping step, withdrawal is free.

> Sending actual bitcoin to a Base address does not work and the coins do not
> arrive. Base is an Ethereum L2; cbBTC is the ERC-20 that represents BTC on
> it.

## 1. Deploy PEER (~$0.04)

1. Open <https://remix.ethereum.org>, create `PeerToken.sol`, paste the
   contents of [`PeerToken.sol`](./PeerToken.sol). It has no imports, so what
   you compile is exactly what you can read — eighty lines, no owner, no mint
   function, no pause, nothing privileged.
2. Compiler **0.8.24**, optimizer **on**, 200 runs.
3. Deploy tab → Environment **Injected Provider**, wallet on **Base
   (chain 8453)**.
4. Constructor `wholeTokens`: **18250000** (the cap TOKEN.md sets).
5. Deploy, confirm, and **copy the contract address**.

Verify before going further:

```bash
curl -s https://mainnet.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"YOUR_TOKEN_ADDR","data":"0x18160ddd"},"latest"]}'
```

The result decodes to 18,250,000 × 10¹⁸. If it returns `0x`, nothing is
deployed at that address — stop and check the address.

## 2. Deploy the pools factory (~$0.08)

`PeerPools.sol` is the app's own pool contract: named constant-product pools
over the one PEER/cbBTC pair, Uniswap V2 math with the 0.3% fee staying in
the pool, and — same as the token — no owner, no fee switch, nothing
privileged. One deployment holds every pool; anyone can open a named pool
afterwards by calling it.

Same discipline as §1: the fresh account, wallet on Base.

1. In Remix, create `PeerPools.sol`, paste the contents of
   [`PeerPools.sol`](./PeerPools.sol). No imports here either — what you
   compile is exactly what you can read.
2. Compiler **0.8.24**, optimizer **on**, 200 runs — identical settings.
3. Constructor takes two addresses: `peer_` is **your token address from
   §1**, `btc_` is cbBTC, `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`.
4. Deploy, confirm, and **copy the factory address**.

(The one-click page covers this step too: `node chain-l2/serve-deploy.mjs`,
open <http://127.0.0.1:8899/>, second card sequence.)

Verify before going further:

```bash
curl -s https://mainnet.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"YOUR_POOLS_ADDR","data":"0xf525cb68"},"latest"]}'
```

`0xf525cb68` is `poolCount()` — a fresh factory answers a 32-byte zero. If
it returns `0x`, nothing is deployed at that address — stop and check.

## 3. The Uniswap alternative (~$0.20)

The factory in §2 is what the app reads: named pools, listed live by
`/api/token/onchain`. Create a Uniswap pool instead if you want the pair on
infrastructure every aggregator already indexes. Either works; nothing stops
you doing both, but the two do not share liquidity, so running both splits
what little there is.

cbBTC on Base is `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8 decimals —
**not** 18; a cbBTC amount of `0.001` is `100000` raw).

Use <https://app.uniswap.org> connected to Base:

1. Pool → New position → select **PEER** (paste your address) and **cbBTC**.
2. Fee tier **1%** — correct for an illiquid new pair, not 0.05%.
3. **You set the opening price.** With no market, this number is your
   invention: it is the ratio of what you deposit. Decide how many PEER one
   cbBTC should buy and deposit in exactly that ratio.
4. Choose a **full range** position unless you understand concentrated
   liquidity, then Add.

## 4. Point the network at it

In `webapp/server-data/` (gitignored — nothing here reaches the repo), set
the host's environment and restart:

```bash
PEER_TOKEN_ADDR=0xYourPeerToken
PEER_BTC_ADDR=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf
PEER_POOLS_ADDR=0xYourPoolsFactory
PEER_POOL_ADDR=0xYourUniswapPool   # only if you took the §3 alternative
```

Then `GET /api/token/onchain` reports live supply, reserves, any account's
balance and — with `PEER_POOLS_ADDR` set — every named pool with its
reserves, and refuses to report anything if the RPC answers for the wrong
chain. Unset, the endpoint returns 404 and says why — a token address baked
into source is one nobody verified.

## What to expect, plainly

The pool will be **illiquid and its price meaningless** until PEER has
holders who want it. With no organic volume there are no arbitrageurs, so
the price is whatever the last trade left behind, and the first real trade
against a thin pool will move it enormously. Seed only what you are content
to lose — you called this a doability trial, and that is the right frame.

## What stays impossible, and why that is correct

Nobody can mint more PEER, including you: there is no mint function. Nobody
can pause transfers or seize a balance. That is what makes the supply figure
worth reading — and it is also why the deploying key matters so much. If it
leaks, whoever has it holds whatever that account holds. Fresh account, paper
backup, nothing else on it.
