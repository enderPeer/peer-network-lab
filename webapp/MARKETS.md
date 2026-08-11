# Prender Markets — a bet is a post

A question with two to seven answers, money staked on each, and a jury the
community elects to say which one came true.

It is built out of pieces this network already has. A bet mints a Content node
through the same path a note takes, so reactions, comments, quotes and tags
land on it unchanged and the epoch mint sees it without knowing markets exist.
The stakes are ordinary token balances moving through escrow. What is new is
the jury, and the bond that makes a jury seat cost something to abuse.

## The one rule everything else protects

**Tokens are value. Standing is reputation. They touch nowhere.**

The same wall that keeps paid placements and the token ledger outside the
reputation system holds here, and it holds in both directions:

- No market act appends an edge, compiles a vouch, or enters an epoch
  certificate. Staking, standing for a seat, voting and certifying cost θ like
  any act and nothing else. Winning a pool outranks nobody, and there is a test
  that says so by comparing a winner's standing against someone who spent the
  same number of acts on nothing at all.
- **Standing does not elect the jury either.** A ballot is weighed by satoshis
  the voter proved they destroyed — the same weight the PEER distribution uses.
  If reputation decided who gets paid, reputation would have a price, and the
  wall only holds if neither side crosses it.

## How one runs

**1. Somebody asks.** Two to seven answers, the asset stakes are denominated
in, a closing time, the bond a moderator must post, and a resolution fee capped
at 5% of the pool. All of it is on the card before anybody stakes anything, and
none of it can be edited afterwards — a stake records an answer's *number*, so
editing the list would repoint money at a different answer. The author may
nominate up to eight people to moderate; a nomination is an invitation and
nothing more.

**2. People back an answer.** A stake leaves the balance immediately and sits
in escrow. It is parimutuel: there is no price and no counterparty, only a pool
and a share of it. The card shows what fraction of the money sits on each
answer and says in the same breath that this is not a probability.

**3. People stand for the jury, and the community elects it.** Standing for a
seat means posting the bond. Any account may vote, by approval — name up to as
many candidates as there are seats — and a ballot weighs the satoshis that
account has destroyed. A later ballot replaces an earlier one, which is what
makes a seat recallable: the community can move its weight to somebody else at
any point up to the close, and no separate machinery for throwing a moderator
out has to exist.

Ties break by bond, then by handle. That is determinism, not merit: two honest
observers replaying the same log must seat the same people, or the network has
two different answers to who may certify a bet.

**4. Betting closes, and the jury certifies.** Each seated moderator names one
answer, or `void`. A certification is final — that is what makes the bond mean
anything. The moment a strict majority of the seated jury agrees, the market
settles. Juries are 1, 3 or 5 seats, because an even jury cannot reach a
majority.

**5. The money moves, once.**

| who | what they get |
|---|---|
| backers of the certified answer | the whole pool, less the fee, plus every struck bond — split in proportion to what each staked |
| the author | half the fee, and the rounding dust |
| moderators who certified the answer the jury reached | the other half of the fee, split equally, and their bond back |
| a moderator who certified a *different* answer | **the bond is struck** — and it is paid to the people who backed the answer the jury did reach |
| a moderator who never certified | their bond back, and no fee |

**If the certified answer had no backers at all**, nobody was right, so nobody
is paid and **no fee is taken**: every stake goes back in full.

**If the jury never agrees**, anyone may call time seven days after the close.
Every stake goes back in full, no fee is taken — and there the silence is what
costs: seats that never certified forfeit their bonds, shared across the stakes
that were held hostage while they said nothing.

## Who may not do what

- **The author of a bet may not hold a position on it.** They are paid a fee
  whichever answer wins.
- **A moderator may not back an answer they may be asked to certify**, and
  anyone already holding a position may not stand.

That is the whole conflict-of-interest rule, and it is deliberately short: the
two roles that can shape the answer are the two that may not profit from it.

## Where the clock lives

Nowhere near the replay. Settlement happens because an **act landed**, never
because time passed: the majority certificate settles the bet, and the timeout
path is its own act that anybody can send. The host is what knows the time — it
refuses stakes and ballots after the close, refuses certificates before it, and
refuses calling time before the jury's window is up.

This is not tidiness. A replay that consulted a clock would stop being a pure
function of the log, and a market that settled differently depending on when
you read it could not be verified by anyone.

For the same reason, **deleting a bet does not touch its escrow.** The question
and the answer labels are redacted like any payload; the answer *count* and
every stake are structure and stay, the jury can still certify, and the money
still finds its way home. The host refuses new money into a deleted bet, and
nothing else.

## What this does not stop

Written out with the same honesty as the sybil section in
[TOKEN.md](TOKEN.md), because a prediction market with an unstated failure mode
is a way to lose other people's money.

**A large enough burn can buy a jury.** Ballots are linear in destroyed
satoshis, so splitting a stake across puppets gains nothing — that hole is
closed and there is a test. What is *not* closed is concentration: somebody who
has destroyed more bitcoin than everyone else voting can seat whoever they
like. The counterweights are that seats are contestable until the close, that a
corrupt certification forfeits the bond, and that the whole election is in the
public log with every ballot's weight beside it. None of those is a proof.

**A colluding majority of a seated jury can certify a lie.** They would forfeit
nothing — the minority would be the ones struck for dissenting. This is the
irreducible property of majority attestation, and no amount of bonding removes
it; it can only be made expensive and visible. A larger jury and a larger bond
both raise the price.

**Bettors may vote.** Nothing stops somebody with money on an answer from
voting for the jury that will certify it. Excluding them was considered and
rejected: it would hand the election to the people with no interest in the
answer at all, and the account with a position is also the account with the
strongest interest in an honest one. It is a real conflict and it is disclosed
rather than pretended away.

**A void refunds; it does not compensate.** Money held for a week in a market
that failed comes back with nothing for the wait, beyond the struck bonds.

**The host can cancel, but it cannot take.** The deadline is a wall-clock check
and the host is what owns the clock, so a dishonest host could call time early.
It could not steal by doing so: a void refunds every stake in full and pays a
fee to nobody.

## The acts

All cost θ like any act, all go through `POST /api/act`:

| act | fields |
|---|---|
| `market` | `text`, `opts` (2–7), `cur`, `at`, `seats` (1/3/5), `bond`, `feeBp` (≤500), `mods?` |
| `bet` | `cid`, `opt`, `amt` |
| `modStand` | `cid`, `on` |
| `modVote` | `cid`, `for` (handles, at most `seats`) |
| `attest` | `cid`, `opt` (−1 = void) |
| `marketVoid` | `cid` |

Read state with `GET /api/v1/markets` (`?all=1` for settled ones too). Read the
content id from there and never derive it — the id counter also ticks for
hyperedge legs, and a client that counts posts lands one off.

`bet` and `modStand` require a PIN on the handle: they spend a balance, and an
unsecured handle would otherwise be drained by a stranger while the record read
as its owner choosing to play.

**One rulebook, two readers.** The host validates against the *same*
`marketActError` the replay applies with, run over a fresh replay of the log, so
the refusal text is the same sentence in both places and the host cannot accept
what the replay would skip. The only things the host adds are the clock and
deletion — the two things a pure replay must never know about.
