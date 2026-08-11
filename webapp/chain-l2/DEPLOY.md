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

### A pool name is a label, not a namespace

Names are claimed **per creator**. Your pool called `main` and a stranger's
pool called `main` are two different pools, and both are allowed. Nothing
in the contract arbitrates between them, because arbitrating names would
mean somebody holding the power to arbitrate, and this contract has no
privileged anybody.

That is a deliberate choice over the obvious one. A global first-come
namespace on a chain with a public mempool is a gift to whoever pays the
higher priority fee: they read the name out of your pending `createPool`,
land theirs first, and your honest transaction reverts on a name that now
belongs — permanently, with no reclaim path — to a pool holding dust. The
attack costs a fee and buys a word. Per-creator claiming makes it buy
nothing.

The consequence is worth stating plainly, to yourself as much as to anyone
reading a pool list: **a name confers no trust, no seniority and no
provenance.** What identifies a pool is its numeric id. What tells you
whose it is, is the `creator` address that `poolInfo` returns beside the
reserves. Judge a pool by its reserves and its creator; a list that shows
a bare name without saying whose pool it is, is a list you cannot safely
act on. Within one creator a name is still claimed forever, even after the
pool is drained — reusing your own dead name would let a pool people point
at quietly change referent.

Every call that moves value carries the caller's own guards: a minimum on
what must come back, and, on `swap` and `addLiquidity`, a deadline past
which the signed transaction is void. The contract has no oracle and wants
none — those numbers are how a caller states what they will accept, and
they are the only price protection there is.

### Deploying it

Same discipline as §1: the fresh account, wallet on Base.

1. In Remix, create `PeerPools.sol`, paste the contents of
   [`PeerPools.sol`](./PeerPools.sol). No imports here either — what you
   compile is exactly what you can read.
2. Compiler **0.8.24**, optimizer **on**, 200 runs — identical settings.
3. Constructor takes two addresses: `peer_` is **your token address from
   §1**, `btc_` is cbBTC, `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`.
4. Deploy, confirm, and **copy the factory address — and the block number it
   landed in.** Both, together. The block is on the deployment transaction on
   any explorer, and the one-click page prints it beside the address; §4
   explains what it is for. Recording it now costs nothing and finding it
   later is a chore.

(The one-click page covers this step too: `node chain-l2/serve-deploy.mjs`,
open <http://127.0.0.1:8899/>, cards 4 and 5 — the cbBTC address is
prefilled there, the PEER address is the one you paste in from §1. The page
embeds the compiled bytecode and fetches nothing; rebuild it with `node
chain-l2/build-deploy-page.js` any time `PeerPools.sol` changes, or you
will deploy the previous contract. `chain-l2/auto-deploy.ps1` runs that
whole sitting end to end, including §4 below.)

**Check the fingerprint before you sign.** Card 5 prints the SHA-256 of the
factory bytecode that page will deploy, and `auto-deploy.ps1` refuses to open
a page whose fingerprint is not the one `chain-l2/PeerPools.build.json`
produces. This is not paranoia about attackers — it is about copies. A stale
`deploy.html`, from a git worktree or an old checkout, serving on the same
port embeds a *previous* immutable contract, and deploying it is irreversible,
silent, and leaves the app calling functions that contract does not have. If
you opened the page by hand rather than through the script, compare that line
against what `node chain-l2/build-deploy-page.js` prints.

Verify before going further:

```bash
curl -s https://mainnet.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"YOUR_POOLS_ADDR","data":"0xf525cb68"},"latest"]}'
```

`0xf525cb68` is `poolCount()` — a fresh factory answers a 32-byte zero. If
it returns `0x`, nothing is deployed at that address — stop and check.

Zero is the right answer and not a failure: deploying the factory creates no
pool and moves no coin. The first pool is a `createPool` from a wallet, in
the app's Pools tab, and it is that call — not this one — that hands over
real PEER and real cbBTC.

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

These are **files**, not a shell you have to remember to export in. Each
lives in `webapp/server-data/` (gitignored — nothing here reaches the repo),
holds one value and nothing else, and is read into an environment variable
at startup by `load-config.ps1`, which every launcher dot-sources —
`start-host.ps1`, `watchdog.ps1`, `serve-public.ps1` and `setup-host.ps1`.
That single list is the point: a watchdog restart at some hour nobody is
watching cannot silently unconfigure the on-chain surface.

This guarantee used to be written here and be false. The list was pasted
into each launcher by hand, and `setup-host.ps1` — the fresh-machine setup
and the command `HOSTING.md` gives for both planned and emergency
**promotion** — had none of it, so a promoted host came up with the admin
panel, passkeys, proof of burn and every on-chain address off, looking
perfectly healthy. If you add a launcher, dot-source `load-config.ps1`;
do not copy the list.

| file in `server-data/` | environment variable | what goes in it |
|---|---|---|
| `token-address.txt` | `PEER_TOKEN_ADDR` | your PEER token from §1 |
| `btc-token-address.txt` | `PEER_BTC_ADDR` | cbBTC, `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |
| `pools-address.txt` | `PEER_POOLS_ADDR` | your pools factory from §2 |
| `pools-from-block.txt` | `PEER_POOLS_FROM_BLOCK` | the block §2 deployed in |

Then restart the host: `.\start-host.ps1`. Or let
`chain-l2/auto-deploy.ps1` write all four and restart for you — it is the
same four files, typed once.

That last one is worth getting right even though the host no longer breaks
without it. The host finds pools by asking the RPC for the factory's
`PoolCreated` logs, and public endpoints cap how wide one such query may be —
Base's answers 9,999 blocks and refuses 10,000. The reader walks the range in
windows under that cap, remembers how far it got in
`server-data/pools-scan.json`, and continues on the next refresh, so with no
starting block it starts at block 0 and simply takes a while: `namedPools.scan`
reports `windows`, `complete` and how many blocks of history are still
unwalked while it catches up. Setting the deployment block turns that backfill
from hours into one query.

Err **low**, never high. Too low costs a little scanning; too high silently
hides every pool opened before it. The reader reports `total` — the
factory's own `poolCount` — beside `discovered`, the number the log scan
actually saw, precisely so that gap is visible rather than something you
have to suspect. If those two disagree, this file is the first thing to
check.

Changing it afterwards is safe and costs one backfill: `pools-scan.json` is
keyed to the chain, the factory and this block, so a value that moved throws
the remembered scan away rather than reporting a range it never walked. The
file is a cache in every direction — delete it and the next refresh rebuilds
it from the chain.

The §3 Uniswap pool is the exception, and it is worth knowing before you
rely on it: **`PEER_POOL_ADDR` has no file behind it.** Exported by hand it
works, until the watchdog restarts the host without that environment and the
Uniswap reading goes quiet with nothing to say why. If you take the §3
alternative and mean to keep it, give it a file of its own beside the others
in all three launchers rather than trusting a shell to outlive a reboot.

Two more the reader honours, both with working defaults and neither needing
a file: `PEER_L2_RPC` (Base mainnet) and `PEER_L2_CHAIN_ID` (8453). The
authoritative list is the header comment of `chain-l2/onchain.mjs` — these
are only the ones an operator normally sets.

Then `GET /api/token/onchain` reports live supply, reserves, any account's
balance and — with `PEER_POOLS_ADDR` set — every named pool with its
reserves and its creator, and refuses to report anything if the RPC answers
for the wrong chain. Unset, the endpoint returns 404 and says why — a token
address baked into source is one nobody verified. Readings are cached for
30 seconds, so a pool you just opened can take that long to appear.

Read the `tokens` field the first time. It is the pair the factory names in
its own immutables, and if it disagrees with what you configured, a
`mismatch` key says so instead of quietly scaling amounts by the wrong
decimals. That is the shape of a factory deployed over the wrong PEER
address — a mistake worth catching while the pools are still empty, because
it cannot be corrected afterwards, only abandoned.

## What to expect, plainly

The pool will be **illiquid and its price meaningless** until PEER has
holders who want it. With no organic volume there are no arbitrageurs, so
the price is whatever the last trade left behind, and the first real trade
against a thin pool will move it enormously. Seed only what you are content
to lose — you called this a doability trial, and that is the right frame.

Expect duplicates, too. Nothing stops a second person opening a pool with
the same name as yours, at whatever price they like, and nothing should.
Thin lookalike pools beside a real one are the ordinary condition of a
permissionless list, not a sign something broke. The host orders that list
by BTC reserve, deepest first, and says so in `rankedBy` — because depth is
the one thing about a pool that cannot be faked cheaply, and because
somebody has to choose an order. Depth is not endorsement: it says a trade
can be filled there, nothing about who opened it or why.

## What stays impossible, and why that is correct

Nobody can mint more PEER, including you: there is no mint function. Nobody
can pause transfers or seize a balance. That is what makes the supply figure
worth reading — and it is also why the deploying key matters so much. If it
leaks, whoever has it holds whatever that account holds. Fresh account, paper
backup, nothing else on it.

The factory has no owner either, and that cuts both ways. Once it is
deployed there is no upgrade, no pause, no admin call, and no way for you or
anyone to correct a pool opened at a silly ratio or under a confusing name —
the only remedies are the ordinary ones anybody has: trade against it, add
liquidity, or leave it alone. Deploying is the last moment anything about
that contract can change. That is the same property that makes it worth
trusting with other people's coins, and it is why this runbook asks you to
read `PeerPools.sol` rather than take the summary above on trust.
