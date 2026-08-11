# PEER — the epoch token

Ported from the poolsite economy ([enderPeer/poolsite](https://github.com/enderPeer/poolsite))
and mapped onto this network's epoch machinery. What poolsite distributed per
**day**, this distributes per **epoch close**. The constants are poolsite's:
5000 per period in year one, decaying 0.9 per year, capped at 18,250,000.

## The one rule everything else protects

**Tokens are value. Standing is reputation. They touch nowhere.**

No token act creates a graph edge, compiles a vouch, or moves anyone's solved
standing beyond the ordinary θ that any act costs. No balance enters any feed
score, any gate, or any epoch certificate. A token millionaire outranks nobody,
and there is a test that says so by comparing their standing against someone
who spent the same number of acts on nothing at all.

This is the same wall that keeps paid placements outside the protocol. The
network's claim is that influence is transported commitment; the moment money
could reach the reputation system, that claim would be for sale.

## How PEER is distributed

At every epoch close, `5000 × 0.9^floor(epochs/365)` PEER is minted and split
among **creators**, by the engagement their work drew:

| what | weight |
|---|---|
| a reaction | 1.0 |
| a comment | 1.2 |
| a negative reaction | 0.3 |

Three things shape it, all inherited from poolsite:

- **Per-pair damping.** The *n*-th engagement from the same person toward the
  same creator is worth `1/(1 + 0.3·(n−1))`. Ten nudges from one friend lose to
  one nudge from ten people — by a factor the test pins at more than 2×.
- **The commitment gate.** A weigher's influence scales by `λ(α̂) = α̂/(1+α̂)`
  and is **zero below α̂ = 0.2**. The rate is computed from burn the account
  **acquired**, never from the grant handed out at registration — see below.
  An account that never burned weighs nothing at all.
- **Self-engagement never counts.**

Rounding dust and epochs nobody engaged in **carry over**, so nothing is lost —
the next real epoch pays out the accumulated pool.

### What the gate does and does not stop

An adversarial review of this economy found one serious defect and it is fixed,
but the honest picture is worth stating with numbers rather than adjectives.

**Fixed: the registration grant was being read as commitment.** Registering
hands out burn so a newcomer can act at all. That grant put a fresh account at
α̂ = 9.47 against a gate of 0.2, and made it weigh λ = 0.90 — *more* than a real
participant who had burned three times and posted fifteen times (λ = 0.65). The
weighting rewarded freshness over commitment, exactly backwards. Measured:
**twenty free registrations captured 55.9% of an epoch** from twenty burned,
active users. Weight now comes from burn the account acquired, so those twenty
registrations capture **0.0%**. There is a test.

**Fixed, and here is how.** The sybil hole this section used to describe was
real and measured: twenty puppets took **59.6%** of an epoch, because λ has
diminishing returns *per account*, so splitting a stake beat concentrating it —
and the stake itself was free, since `burn` was a faucet and the true cost of
weight was the cost of registering.

Both halves are gone. Weight is now **linear in satoshis destroyed**, so twenty
accounts sharing a stake weigh exactly what one account holding it weighs; the
split is worth precisely nothing, and there is a test that splits a stake twenty
ways and gets the same number back. And the stake is real: reserve comes from
bitcoin burned at an address with no key, verified against two independent
explorers before it is recorded. In poolsite, burn cost real money, which is
what made λ acceptable. Here burn costs real money again — so the whole
argument closes.

The commitment gate is gone with it. There is no α̂ threshold to sit under any
more; there is zero and there is more than zero.

## It applies retroactively, and that is deliberate

Replay is a pure function of the whole log, so the rule reads engagement that
already happened. On the live network this credited 275,000 PEER across the 55
epochs that had already closed, to the people who had actually been engaged
with. The alternative — starting the clock at deployment — would have handed
the entire early supply to whoever happened to be online the day it shipped.

### Deletion does not rewrite it

A creator who later deletes their account **keeps** their share, and their
epoch is not re-cut. Skipping them would silently change every other creator's
slice of an epoch that closed months ago — the same defect as a deletion that
moves everyone's standing, which this project has already paid for once.

For that to hold, authorship is recorded as **structure**, separately from the
payload: the Publish edge already names the author publicly, so deleting the
text cannot take the authorship with it.

## tBTC — retired, and why it existed at all

`tBTC` was a **test asset with a bitcoin-shaped name**: one free claim of 0.01
per account, backed by nothing, bridged to nothing, redeemable for nothing. It
is retired. Nothing mints it, no supply of it exists, and the claim is refused.

It is worth saying why it went, because the reasoning is the whole point of this
network. A symbol that looks like bitcoin and costs nothing teaches people that
value here is decorative — and once the economy actually became real, keeping a
free asset beside it would have meant the fake one bought more participation
than the real one.

**Real bitcoin does live here now, and it lives here by being destroyed.** You
burn it at a P2WSH output committing to `OP_RETURN`, a script no witness can
ever satisfy. This host still holds **no private keys** — that property was
established when paid placements were built and has never been broken. A burn
needs no custody by construction: nobody can spend what was sent, including the
operator, including the network.

## Fun assets

`assetCreate` mints your own symbol, 3–8 characters, full supply to you. It is
worth exactly what a pool says it is worth and not one satoshi more. Pair it
against PEER or against someone else's joke.

Reserved symbols (`PEER`, `tBTC`) cannot be shadowed — tBTC stays reserved
precisely because it is retired, so nobody can mint a new asset wearing the
name of the old fiction.

## Pools

Constant-product automated market makers — `x · y = k`, the Uniswap V2
arithmetic:

- A swap of `Δin` returns `resOut · 0.997·Δin / (resIn + 0.997·Δin)`. The 0.3%
  that stays behind is how liquidity providers are paid: `k` grows on every
  swap, and shares are worth more when redeemed.
- Shares at creation are `√(a·b)`, with a sliver **locked forever** so the pool
  can never be drained to zero — that is the guard against the classic
  first-depositor share-inflation attack.
- Adding liquidity takes the *proportional* part of what you offer, so a skewed
  deposit cannot mint shares against the existing providers.
- `poolSwap` accepts `minOut`; the interface sends one with a 2% tolerance, so
  a trade that would fill at a price the screen never showed is refused rather
  than executed.
- A pair has **one** pool whichever way you name it: `poolCreate` normalises
  the order, and the mirrored duplicate is refused.

## The acts

All cost θ like any act, all go through `POST /api/act`:

| act | fields |
|---|---|
| `btcClaim` | — |
| `assetCreate` | `sym`, `name`, `supply` |
| `tokenSend` | `sym`, `to`, `amt` |
| `poolCreate` | `symA`, `symB`, `amtA`, `amtB` |
| `poolAdd` | `pool`, `amtA`, `amtB` |
| `poolRemove` | `pool`, `shares` |
| `poolSwap` | `pool`, `sell`, `amt`, `minOut?` |

Read state with `GET /api/v1/tokens?as=ID` and `GET /api/v1/pools`.

**One rulebook, two readers.** The host validates against the *same*
`tokenActError` the replay consults, run over a fresh replay of the log. The
host cannot accept what the replay would skip, and the refusal text is the same
sentence in both places. Invalid acts that reach the replay anyway — a
hand-edited log, a foreign log — are skipped whole, never half-applied: there
is a test firing negative amounts, infinities, overdrafts, self-paired pools
and reserved-symbol shadowing straight at it, asserting no balance moves and no
number becomes NaN.

## Every close is sealed

Since the epoch chain (`webapp/chain/`, see
[DECENTRALIZATION.md](DECENTRALIZATION.md)), each epoch close is sealed into
a signed block carrying the mint, the per-creator distribution, every
balance and every pool as computed at that close — hash-linked to the
previous block, with the emission constants and the replay edition sealed
in. The distribution was always replayable; now it is also *attributable*: a
host that later showed you different numbers for a closed epoch would be
contradicting its own signature, and `node chain/verify.mjs` says so.

## Betting on an answer

The other thing a balance can do here is take a side. A **bet** is a post with
two to seven answers, a parimutuel pool, and a jury the community elects and
bonds — and it obeys this same wall from both directions: no stake moves a
standing, and no standing weighs a jury ballot. See [MARKETS.md](MARKETS.md).

## What this is not

A test network's play money. There is no exchange, no bridge, no custody, no
redemption and no promise. Nothing here is an investment, and the only thing
any of it can buy is a place in a pool.
