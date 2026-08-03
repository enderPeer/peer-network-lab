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

**Not fixed, because it cannot be here: identity is cheap.** If the puppets
*also* burn, they weigh again — measured at **59.6%** for twenty puppets. This
is not a defect in the port; it is what poolsite's λ does. λ has diminishing
returns *per account*, so splitting one stake across many accounts beats
concentrating it. In poolsite, burn cost real money, which is what made that
acceptable. Here `burn` is a faucet, so the cost is a registration.

Three things follow, and none of them are hidden:

- On this test network, PEER distribution is **farmable by anyone willing to
  register accounts**. It is play money, and it is labelled play money.
- The defence that does work is the one already in the protocol: **pair
  damping** limits what any single account can push toward any single creator,
  so an attacker needs breadth, not repetition.
- The structural fix, if this economy ever needed to be sybil-resistant, is to
  make weight **linear in committed value rather than saturating per identity**
  — then splitting a stake across twenty accounts weighs exactly what holding
  it in one weighs. That is a different economy from poolsite's, so it is not
  what was ported; it is written down here so the choice is visible.

**None of this touches standing.** Every number above is about who receives
minted play money. Nobody's reputation moved, because no balance can reach it.

### It applies retroactively, and that is deliberate

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

## tBTC — and why there is no real bitcoin here

`tBTC` is a **test asset with a bitcoin-shaped name**. One claim of 0.01 per
account, ever. It is backed by nothing, bridged to nothing, and redeemable for
nothing.

Real BTC cannot live in this network, and the honest thing is to say so in the
symbol rather than in a footnote. This host holds **no private keys** — that is
a deliberate property established when paid placements were built, and it is
what makes the operator's own bitcoin address safe to publish. A network that
custodied real coin would need exactly the thing this codebase refuses to have.

So tBTC is the trading pair you start from: it behaves like a scarce asset in
the pools without pretending to be one outside them.

## Fun assets

`assetCreate` mints your own symbol, 3–8 characters, full supply to you. It is
worth exactly what a pool says it is worth and not one satoshi more. Pair it
against PEER, against tBTC, or against someone else's joke.

Reserved symbols (`PEER`, `tBTC`) cannot be shadowed.

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

## What this is not

A test network's play money. There is no exchange, no bridge, no custody, no
redemption and no promise. Nothing here is an investment, and the only thing
any of it can buy is a place in a pool.
