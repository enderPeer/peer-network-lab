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
   any explorer, and the one-click page prints it beside the address; §5
   explains what it is for. Recording it now costs nothing and finding it
   later is a chore.

(The one-click page covers this step too: `node chain-l2/serve-deploy.mjs`,
open <http://127.0.0.1:8899/>, cards 4 and 5 — the cbBTC address is
prefilled there, the PEER address is the one you paste in from §1. The page
embeds the compiled bytecode and fetches nothing; rebuild it with `node
chain-l2/build-deploy-page.js` any time `PeerPools.sol` changes, or you
will deploy the previous contract. `chain-l2/auto-deploy.ps1` runs that
whole sitting end to end, including §5 below.)

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

## 4. The epoch contracts (~$0.06), optional

Everything above is about the token and where it trades. These two are about
the **epoch chain**: the signed certificate `webapp/chain/` seals every time
an epoch closes, and the epoch token that certificate distributes.

Both are optional and independent of each other. The network runs exactly as
it does today without either — closing epochs, sealing blocks, distributing
the epoch token in its own act log. What these add is (a) an outside witness
that a result existed at a particular time, and (b) a way for that
distribution to become real PEER on Base.

### PeerAnchor — the epoch chain's public clock

`webapp/chain/` already makes a silent rewrite **detectable** by anyone
holding an older copy of the chain. "Anyone holding an older copy" is the
catch: a producer who rewrote history and reissued every block from the fork
point hands a self-consistent chain to a reader who was not watching at the
time, and nothing inside the chain tells that reader which version existed
first.

An anchor is the outside witness for exactly that one gap. It posts an
epoch's block id and its earnings root, and Base timestamps the pair in a
place the poster cannot reach back into.

**What an anchor does not say**, because a contract that overstates itself is
worse than no contract at all: it does not say the block is correct, that the
epoch was computed honestly, that the earnings in that root are deserved, or
that the poster is anybody in particular. It is a timestamp over two hashes.
Truth stays where `block.mjs` says it stays — in replay of the public log, by
anyone who disagrees.

**Anyone may post, and that is the design.** No owner, no allowlist, no pause,
no privileged function of any kind. Records are keyed by `(poster, epoch)`, so
your epoch 12 and a stranger's epoch 12 are two separate rows and neither can
touch the other — the same rule PeerPools applies to pool names. Readers
decide whose anchors mean anything by choosing whose address to read. An
impostor anchoring garbage is not an attack on the contract; their garbage
sits under their own address, next to nothing.

**One anchor per (poster, epoch), forever.** A second attempt reverts. If you
anchor the wrong hash there is no repair inside the contract by design; the
honest repair is to anchor the corrected epoch from a **new address** and say
plainly why. The mistake stays visible, which is the point of the mechanism.

### PeerClaim — epoch earnings, paid out of PEER that already exists

Each closed epoch publishes a merkle root of who earned what, and people claim
their earnings as real on-chain PEER.

**Where the PEER comes from is the question the whole design turns on.**
`PeerToken.sol` has no mint function and no owner, so the supply is fixed
forever and nothing here can create a token. Every PEER this contract ever
pays out was pulled from the steward's own holdings when the epoch was opened.
"Epoch earnings" on-chain means a transfer out of one existing pile, never an
issuance — and if the steward stops funding epochs, epochs stop being
claimable, which is an honest failure mode with no hidden inflation
underneath it.

**The steward** is the first privileged role anywhere in this codebase, so
here it is in the same words as the contract header:

> The steward **can** open an epoch — publish a root, a total and a claim
> deadline, once per epoch number, and thereby direct PEER that the steward
> themselves just deposited into the contract to whichever addresses that root
> commits to; publish a root whose leaves **oversum** that deposit, which makes
> the epoch first-come and reverts everyone after the money runs out, including
> by putting an address they control in the root and claiming it first; and
> reclaim, after the deadline, whatever nobody claimed.
>
> The steward **cannot** mint anything (there is no mint; the token cannot
> grow); touch any balance outside the contract, or any epoch's deposit other
> than through the root that epoch was opened with; take back a claim already
> made; alter, replace, or re-open a root already published; reach into an open
> epoch to stop one named claimant (there is no pause, no allowlist, no
> per-claimant switch); or sweep early — `sweep` reverts before the deadline for
> everyone including the steward, and `openEpoch` refuses a window shorter than
> `MIN_WINDOW` (7 days) or longer than `MAX_WINDOW` (365 days).

The oversum is in the **can** list and it is the one to read twice. Nothing
on-chain holds the tree, only its root, so no contract can add the leaves up
— which means "this epoch can pay everyone it commits to" is not a promise
the chain makes. It is checkable before the first claim instead: the host
publishes the full leaf list beside the root
(`GET /api/v1/epoch/<n>/claim`), so anyone can sum it against `total` and
refuse to believe an epoch that does not add up. A window floor is what makes
"cannot sweep early" mean anything; without it a deadline of `now + 1` was
legal and the next Base block could take the whole deposit back.

The role is unavoidable rather than desirable: a contract that pays out must
have something deciding who is owed what, and if publishing a root were open
to anyone, the first passer-by would publish a root paying themselves the
entire deposit. What the contract does instead is make the role **small** and
its every use **public** — the steward's authority extends to money they put
in themselves, each epoch is one irreversible publication, and PeerAnchor
timestamps the root so "the root was fixed before the claims" is checkable by
a stranger.

**Exposure is bounded by what was actually deposited.** `openEpoch` pulls the
whole total up front with `transferFrom`, so an epoch is either fully funded
from the first second or it does not exist — funded to `total`, which is a
different claim from "funded to what the tree owes". Deploying the contract
moves no coins at all; funding an epoch is two later transactions you sign
yourself (an `approve`, then `openEpoch`).

**A handle with no bound address has no leaf that epoch.** Earnings are owed
to a network identity (`u_ender`) and paid to an ethereum address; the binding
is a signed `bindAddress` act in the log, under the handle's own credential.
An unbound handle is simply not in the tree — its share is **not**
redistributed to everyone else and is not held in escrow. It stays in the
unclaimed remainder and returns to the steward at sweep. Rebinding is allowed
and takes effect for **future epochs only**: a root already published cannot
change, which is the entire point of publishing it.

### Deploying them

Same discipline as §1 and §2: the fresh account, wallet on Base, compiler
**0.8.24**, optimizer **on**, 200 runs.

1. `PeerAnchor.sol` — **no constructor arguments.** Deploy, copy the address
   and the block.
2. `PeerClaim.sol` — constructor takes **two addresses, both immutable
   forever**: `token_` is your PEER from §1, `steward_` is the account that
   will open epochs. The steward must be a key **you hold**: there is no
   transfer function for the role, and a steward key that could hand itself to
   another address is a steward key one phishing email wider than it looks. If
   the role must ever move, deploy a new contract and let the old epochs finish
   under the address they were opened by.

The one-click page covers both — cards **6** and **7** of
`node chain-l2/serve-deploy.mjs`. Card 7 checks both arguments against the
chain before anything is signed, in opposite directions: the token must answer
`decimals()` and `totalSupply()`, and the steward must **not** — a token
contract as steward is an epoch nobody can ever open. It also warns if the
steward is not the wallet you are deploying from. Each card prints its build
fingerprint; check it against `node chain-l2/build-deploy-page.js` if you did
not open the page from `auto-deploy.ps1`, for the reason §2 gives.

Verify before going further:

```bash
# PeerAnchor: anchorOf(0x0…0, 0) = selector 0x75834a61 + two zero words.
# A fresh contract answers 96 bytes of zeros; that IS the empty answer.
A=0x75834a61$(printf '0%.0s' $(seq 1 128))
curl -s https://mainnet.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"YOUR_ANCHOR_ADDR","data":"'"$A"'"},"latest"]}'

# PeerClaim: token() — must answer YOUR PEER address from §1
curl -s https://mainnet.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"YOUR_CLAIM_ADDR","data":"0xfc0c546a"},"latest"]}'
```

`0x` back from either means nothing is deployed at that address. A `token()` that
answers an address you do not recognise means the claim contract pays a
different coin than this network's; that pairing is immutable, so the only
repair is to deploy again.

Zero anchors and zero epochs is the right answer for a fresh pair and not a
failure: deploying creates no anchor and opens no epoch, and no PEER has moved.

## 5. Point the network at it

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
| `anchor-address.txt` | `PEER_ANCHOR_ADDR` | your PeerAnchor from §4 |
| `claim-address.txt` | `PEER_CLAIM_ADDR` | your PeerClaim from §4 |
| `epoch-from-block.txt` | `PEER_EPOCH_FROM_BLOCK` | the **lower** of the two blocks §4 deployed in |
| `peerburn-factory.txt` | `PEER_PEERBURN_FACTORY` | the factory holding the **official pool** — §6, optional |
| `peerburn-pool-id.txt` | `PEER_PEERBURN_POOL_ID` | which pool id in it — §6, optional |
| `peerburn-from-block.txt` | `PEER_PEERBURN_FROM_BLOCK` | the block §1 deployed in — §6, optional |

Then restart the host: `.\start-host.ps1`. Or let
`chain-l2/auto-deploy.ps1` write the first four and restart for you — it
writes the §1–§2 files, and the §4 ones are typed by hand.

The last three are the epoch contracts, and every one of them is optional:
with none of them set, `GET /api/token/onchain` answers `anchors` and
`claimState` as `{ configured: false, why: … }` — in words, rather than by
leaving the keys out, because "this host reads no anchors" and "nothing was
ever anchored" are opposite claims and a missing key lets an interface render
either one as the other. `PEER_EPOCH_FROM_BLOCK` covers **both** epoch scans
with one value, so use the lower of the two deployment blocks; the same
err-low rule below applies to it word for word.

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

The epoch contracts are walked by that same scan, with a memory file each:

| file in `server-data/` | what it remembers |
|---|---|
| `pools-scan.json` | how far the `PoolCreated` scan got, and each pool's last measured BTC reserve |
| `anchor-scan.json` | how far the `Anchored` scan got, and the anchors it has seen |
| `claim-scan.json` | how far the `EpochOpened` scan got, and which epochs exist |
| `peerburn-scan.json` | how far the PEER-burn scan got, and the transfers to the dead address it has seen (§6) |

All three are caches, none of them is a source of truth, and each is keyed to
its own contract — delete any of them and the next refresh rebuilds it from
the chain. `anchor-scan.json` keeps the newest 400 rows and no more: anyone
may anchor anything, forever, so an unbounded file is one a stranger decides
the size of. `claim-scan.json` holds only which epochs exist; what each epoch
is worth and how much of it has been taken is read from `epochInfo` on every
refresh, because `paid` moves with every claim and a remembered figure would
show a full pot to somebody whose claim had already come out of it.

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

The PEER door in §6 adds four more of the same kind, all defaulted and none
needing a file: `PEER_PEERBURN_MIN_CONF` (30 blocks), how deep a burn must
be buried; `PEER_PEERBURN_WATCH_INTERVAL` (120s), how often the dead address
is checked for burns nobody claimed; and two memos that exist so a public
read door cannot be turned into a request amplifier against your endpoint —
`PEER_PEERBURN_TICK_MEMO_MS` (10s) and `PEER_PEERBURN_QUOTE_MEMO_MS` (15s).
The quote memo is safe at that length precisely because the price it holds
is averaged over half an hour; it would not be safe for a spot price, and
there is no spot price here to hold.

Note also what §6 asks of your **endpoint**, not just your configuration:
the price is read at past blocks, so `PEER_L2_RPC` must serve recent
historical state. A pruning node that answers only for its own head cannot
produce a window, and the host says exactly that rather than falling back to
a spot read — the fallback is the attack.

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

With §4 configured the same endpoint also carries `anchors` — the recent
`Anchored` rows, newest first, each with its poster, epoch, block id,
earnings root and the chain's own timestamp — and `claimState`, with each
recent epoch's root, total, paid, remaining, deadline and whether a claim
would be paid right now. `claimState.token` gets the same treatment as
`tokens` above: read it once, and a `mismatch` key means the claim contract
pays a different coin than this host reports.

Two things that list deliberately does not do. It does not rank anchors by
anything, because there is nothing here to rank by — anyone may post, so
`posters` and `busiestPoster` are reported instead, which makes a flood
arithmetic rather than a hunch. And whether **you** have already claimed an
epoch is never in the cached body: it comes back under `account.claims` only
when you ask with `?of=YOUR_ADDRESS`, because a claimed flag inside the
30-second cache would answer for everyone out of the first asker's wallet.

## 6. The official pool — burning PEER for reserve (optional)

Reserve is **value destroyed**, and until now the only way to destroy value
was to destroy bitcoin. Requiring real BTC before anybody may say a word is
a large part of why this network has twelve actors, so there is a second
door: burn PEER, and get reserve worth the same as the bitcoin that PEER was
worth. The bitcoin door is untouched and both credit reserve at the same
rate — two prices for reserve would be two classes of speaker.

The pair is PEER/cbBTC, so **the pool already quotes PEER in satoshis** and
no currency oracle is needed anywhere. A euro figure is a caption for humans
and never enters the arithmetic: if the euro source is down you lose a
label, not a number.

### Which pool, and why it is never a name

A PEER burn is priced by **one** pool, and which one is an operator's
decision written down as a factory **address** plus a numeric **id**:

| file in `server-data/` | what goes in it |
|---|---|
| `peerburn-factory.txt` | the PeerPools factory holding the pool — usually the same address as `pools-address.txt`, typed again on purpose |
| `peerburn-pool-id.txt` | the pool id, as `poolInfo` indexes it |
| `peerburn-from-block.txt` | the block your **token** was deployed in (§1) — this scan walks the token's Transfer logs, not the factory's |

Never a name. Names in PeerPools are claimed **per creator** (see §2), so
"the pool called main" is a phrase two strangers can both satisfy — and a
host that resolved its price source by name could be re-pointed at a pool
opened at any ratio at all, for the price of one transaction. That is an
oracle attack whose entire cost is gas, aimed at the one thing this network
says cannot be bought.

The factory deliberately does **not** fall back to `pools-address.txt`. That
file decides which factory the pool *list* is read from; a price that
silently followed it would re-point itself the day you aimed the list at
somebody else's factory to look at it.

Unset, this door is **off** and every route says so in words — which is the
state as shipped, since no factory is deployed and the wallet holds no
cbBTC. There is no price today, and a host that guessed one would be
inventing the exchange rate at which speech is sold.

### What the host checks before it credits anything

The price is **time-weighted** across a window of real blocks — the reserves
read at each of a spread of past blocks, weighted by how long each stood,
never the spot price one trade left behind. The window length, the minimum
number of readings, the minimum pool depth, how many blocks inside the
window are read, and both ceilings are the **engine's** constants
(`social/replay.cjs`), not this file's, so the page, the host and replay
refuse in the same numbers. The act records the reserves it used, the pool's
factory and id, the block range, the reference block's hash and every block
read, so anyone replaying the log recomputes the satoshi figure and can
re-fetch the pool at the same blocks instead of believing this host — and
replay refuses any act whose recorded price and recorded value disagree.

**Which blocks inside the window are read is not the host's choice.** A host
cannot read nine hundred blocks per burn, so it reads sixteen; if those
sixteen came from public arithmetic, whoever burns would know all of them in
advance (they choose the block their own burn lands in) and could push the
price at exactly those, holding a lie across 1.4% of the window instead of
all of it. Measured against this reader with a fixed grid: 16 of 16 readings
manipulated for 864,000 sat of swap fees, after which one epoch's whole
allowance cost 10 PEER instead of 1,010. The blocks are therefore chosen by
the **hash of the block the window ends at** — unknowable until that block
exists — so the same spend now moves 0 of 16 readings, and pushing the price
for a quarter of the window moves 4 of 16, for half 8 of 16. Cost is
proportional to how long the lie is held, which is what a time-weighted
price is for. `node tools/oracle-attack.mjs` runs all of that.

Below the depth floor a burn is refused **in words** rather than priced
badly: a shallow pool does not have a price, it has a last trade, and
treating one as the other mints the right to speak out of somebody's
rounding error.

**Two ceilings, not one.** An account creates at most 100 reserve this way
per epoch — and because handles are free, that alone bounds nothing: three
hundred of them filling it once against a pool holding 0.01 cbBTC created
27,100 reserve, 3.6× what selling that PEER into that pool could realise. So
a pool also creates at most as many satoshis of reserve in an epoch as it
holds satoshis of bitcoin, first come first served. A burn worth more than
what is left is **not** forfeited: the act states the slice it credits and
the host finishes the rest in later epochs.

`GET /api/peerburn` shows the pool, the price, the readings behind it and
what a given amount would credit; `POST /api/peerburn/claim {id, txid, auth}`
binds a burn you already made; `GET /api/peerburn/pending` lists burns the
chain shows and this log does not. The host also watches the dead address on
its own, so closing the tab cannot lose a burn.

### Whose burn it is — bind first, then burn

Unlike the bitcoin door this one needs no intents, because an ERC-20
transfer names its sender. What it does need is a rule about **which**
binding counts, and the obvious one was a hole: a `bindAddress` act costs
nothing but the binding handle's own PIN, so under "the handle that has
bound this address", a stranger bound somebody else's address, claimed their
burn, and took the reserve — while the real burner got
`PEERBURN_ALREADY_CLAIMED` on every host, for ever, because the dedupe is by
transaction hash. The public pending list was the target list.

Two rules close it, both enforced in replay rather than at this door:

* **exactly one handle** must have bound the sending address. An address two
  handles have bound is credited to neither. First-binder-wins would make
  pre-binding a stranger's address a silent capture; newest-wins was the
  hole. Ambiguity costs a burn and never hands one over — and if somebody
  binds your address, bind a fresh one and burn from that.
* **the binding must predate the burn.** A binding filed after the coins
  were destroyed reaches nothing, by anybody, including their owner. That is
  the honest cost of closing the pending-list harvest, and every surface
  says it: *bind the address first, then burn from it.*

Epoch earnings are unaffected — that map is still newest-wins per handle,
and one address may still name two handles, which is a state the live log is
already in.

### The one place the two doors are not equals

**Say this wherever they appear together.** The bitcoin address is a P2WSH
commitment to a script that can never be satisfied: unspendable by
*arithmetic*, and anyone can check the arithmetic. The PEER sink is
`0x000000000000000000000000000000000000dEaD`, which is unspendable only
because nobody is believed to know a key for it — a claim about the size of
a search space, not a proof. Both destroy value; only one of them is
provable, and an interface that prints them side by side without that
sentence is lying on the chain's behalf.

`address(0)` is not an option here: `PeerToken` refuses transfers to it
deliberately, so that its supply figure keeps exactly one meaning, and two
burn mechanisms with two meanings would make that figure a lie.

And what a PEER burn buys is bounded on purpose: **reserve only**. It never
touches the weight that decides a share of the epoch mint or a vote in the
writer election — those weigh bitcoin destroyed, whose price nobody here can
move. A PEER burn has a price, and a price can be lied to, so the most a
manipulated window can ever buy is speech, capped per account per epoch.

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

PeerAnchor holds to the same line — no owner, no allowlist, no pause, nothing
privileged, and a row that can never be revised once posted.

**PeerClaim is the exception, and it should be read as one.** It has a
steward, and that is the only privileged address anywhere in this codebase.
The bound is not a promise about behaviour, it is the shape of the contract:
the steward's authority reaches only money they deposited themselves, one
epoch at a time, in publications that cannot be edited afterwards. Nothing
about a steward can mint a token, and no version of a lost or stolen steward
key can touch a claim already paid, a balance outside the contract, or a root
already published. What it can cost you is the undeposited future — an epoch
that never gets opened, or a remainder swept to the wrong hands after a
deadline. That is the price of paying anything out at all, and §4 says so
where you can weigh it before signing rather than afterwards.
