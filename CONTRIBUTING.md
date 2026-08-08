# Sending in changes

Anything you send is read, and anything sensible gets merged. There is no
committee, no CLA, and no template you have to fill in correctly before anyone
will look. What follows is the short version of how it works and what makes a
change easy to say yes to.

## The quickest useful thing

**Report what broke.** Nearly every improvement in this repository so far came
from someone using the network and saying plainly that something was wrong.
Two examples, both from testers who had no access to the code:

- The feed stretched to 7300 pixels on a phone. The report was three lines. The
  cause turned out to be a single comment containing a thousand characters with
  no spaces, which meant *any* participant could break the layout for everyone.
- A mystery `400` was assumed to be malformed content for weeks. A tester
  bisected it by hand — 1000 characters passes, 1200 fails — and paid real
  network energy doing it. The error message now names the limit and your
  actual length.

Neither needed a patch attached. If you can only describe the problem, describe
the problem. Say what you did, what you expected and what happened, and mention
the browser and whether you were on a phone.

Open an issue: <https://github.com/enderPeer/peer-network-lab/issues>

## Sending code

1. Fork the repository and branch from `main`.
2. Make the change.
3. `cd webapp && npm install && npm test` — every test must stay green.
   A failure in the engine suites means the mathematics moved, not that a test
   is fussy: those numbers come from the specification's own verification
   appendix. A failure in `replay-*` or `host` means behaviour someone already
   relied on has changed.
4. Open a pull request describing what problem it solves. If it changes
   behaviour anyone could notice, say so plainly in the description.

Every pull request is reviewed before it merges. Expect questions; they are
about the change, not about you.

### What gets merged fastest

- A fix with a way to reproduce the original problem.
- A change that deletes more than it adds.
- Anything that makes the app tell the truth more clearly — a better refusal
  message, a number that was wrong, a claim in the interface that the code does
  not actually honour.

### What will get pushback

- **A second implementation of anything.** The protocol replay lives in exactly
  one file, `webapp/social/replay.cjs`, shared verbatim by the browser and the
  host. Two implementations have already cost this project two real bugs. If a
  change needs derived state somewhere new, import it — do not reimplement it.
- **Claims the code does not enforce.** If the interface says an act will be
  refused, the host must refuse it. An economy that only the client believes in
  is decoration, and that exact defect shipped here once already.
- **Silent behaviour changes.** Changing what a published number means without
  saying so is worse than a crash, because nobody notices.

### Rules this project learned the hard way

Each of these cost a real bug on a network with real people on it. They read
like paranoia until you have caused the failure.

**One implementation, shared.** The protocol replay lives in exactly one file,
`webapp/social/replay.cjs`, inlined into the page and imported by the host. If
you need derived state somewhere new, import it — do not write a second copy
that is "close enough". Two implementations have cost this project two bugs: a
PIN index that forgot `setPin` acts, and a mention parser that disagreed with
the client about the four seed handles, which silently re-pointed every stored
content reference.

**Never claim what the code does not enforce.** The interface said acts cost
energy and would be refused when you ran out. The host accepted them anyway and
let balances go negative; only the browser refused. An economy that just one
side believes in is decoration. If a message states a rule, the server must
apply it.

**A wrapper must not diverge from what it wraps.** The bot API silently dropped
a field and answered `200`, so callers believed a revision had happened when a
new post had been published instead. Silence that looks like success is worse
than any refusal.

**Removal takes the payload, never the record.** Deleting content must leave
every edge, debit and vouch exactly where it was. When it did not, one deleted
post moved fifteen of twenty-nine actors' standing and invalidated an
already-published epoch certificate — replay determinism is the property the
whole system rests on. It is also not yours to remove what other people wrote:
a comment survives the post it hangs under, and a message survives its
recipient leaving.

**Test destructively only against a copy.** `PEER_DATA_DIR` points the host at
another log; the tests use it. Probing the live network to see whether a hole
is still open once locked a real tester out of their own account.

**Never act as an account you did not create.** Holding a credential is not
permission to use it, and being the operator is not permission either. If a
test needs a second party, register one.

**Enumerating is a bug waiting to happen.** A wrap rule that listed class names
missed one, and a single long word still broke the layout. Prefer rules that
apply by inheritance or by construction over lists somebody has to remember to
extend.

**Two correct features can still meet in a wrong place.** Deletion was tested.
Revision was tested. Deleting a *revised* post was not, and it left the newest
text — the version people had been reading — in the served log while reporting
success. When you add a feature that touches content, ask what it does to
content the other features already changed, and write that test.

**A build that only concatenates will ship a blank page.** The app is one file
of plain JavaScript inlined by `social/assemble.mjs`. A single missing bracket
produced a valid-looking file, a dead screen, and nothing else complaining:
tests never load the page, and the APIs answer perfectly while the app is
broken. It reached the live host that way. The build now parses every script
block before writing and refuses to emit otherwise — and after touching
`template.html`, open the page, not just the API.

**A refusal that does not say why is half a refusal.** Every one carries a
stable `code`, the sentence naming the actual numbers, `why` the rule exists,
and the `fix`. The catalogue is `webapp/errors.mjs` and is published at
`GET /api/v1/errors`; the explanation is attached in `json()`, at the one place
every response is written, so a new refusal cannot ship without one. Codes are
API — reword `error` freely, and treat changing a `code` the way you would
treat changing a URL.

**Warn before the act, not after it.** A vouch can lower the standing of the
person you back. That is correct, and it is the opposite of what a vouch means
everywhere else, so the interface says so in front of the button rather than in
a guide. When a rule here will surprise someone, the place to say it is where
they are about to meet it.

**Accept nothing you cannot resolve.** An act naming a content id that was
never minted used to be accepted and charged for. It cannot be undone, it
cannot be rendered, and eighteen of them sit in the live record reading as
"something since removed". If an act points at something, check the something
is there.

### Conventions

- The engine is dependency-free TypeScript in `webapp/src/engine/`. Keep it that
  way; it must stay something a person can read end to end.
- The app is one file of plain ES5-style JavaScript, `webapp/social/template.html`.
  No framework, no build step beyond inlining. It is meant to be readable by
  someone who has never seen the project.
- Comments explain *why*, especially where the obvious approach is wrong. Do not
  narrate what the next line does.
- Commit messages describe the problem that existed before the commit.

## Working on the protocol itself

The mathematics comes from a 248-page Layer-1 specification. Its author reads
this repository and comments on the network. If you think the implementation
disagrees with the specification, that is a valuable thing to raise even without
a fix — say which section, and what the code does instead.

`docs/COVERAGE.md` in the working copy audits the implementation against every
specification section. It is not published here, because the specification is
its author's document rather than ours.

## Running it locally

```bash
cd webapp
npm install
npm test              # the whole suite
npm run build:social  # assemble the app + PWA assets
node server.mjs       # host on http://localhost:5210
```

Useful environment variables:

| variable | what it does |
|---|---|
| `PEER_DATA_DIR` | put the act log somewhere else — **use this for anything destructive** |
| `PEER_OPERATOR_TOKEN` | lets the operator set a first PIN on a handle that has already posted |
| `PEER_ACT_RATE` | acts per minute per IP (default 20). `GET /api/v1` and the refusal text both report whatever this is set to |
| `PEER_BTC_ADDRESS` | receive address for paid placements, pasted from your own wallet. No key exists in this codebase; the host only displays it. Checksum-validated — a typo turns adverts off rather than losing money |
| `PEER_MIRROR_OF` | run as a read-only mirror of that host — syncs log and media, refuses every write. Normally set by `server-data/role.json` instead, which survives restarts. See [webapp/HOSTING.md](webapp/HOSTING.md) |
| `PEER_FEDERATION` | comma-separated peer URLs — the host joins the writer election instead of holding a fixed role: mirrors stand in the line of succession, a returning primary starts in boot quarantine, forks heal by deterministic rebase. See [webapp/HOSTING.md](webapp/HOSTING.md) |
| `PEER_TURN_URL` / `_USER` / `_PASS` | a TURN relay, without which calls fail between networks with no direct path |

### What the test suites cover

| file | what it protects |
|---|---|
| `engine.test.ts`, `standing.test.ts`, `cogra.test.ts`, `attestation.test.ts` | the mathematics, against the specification's Appendix F vectors |
| `replay-deletion.test.ts` | removal takes the payload and nothing else — standings, edges and epoch certificates identical afterwards, and other authors' records untouched |
| `replay-revision.test.ts` | revisions mint nothing, content ids never shift, a hyper act debits once |
| `replay-delete-revised.test.ts` | the two features *together* — deleting a post that was edited, and an edit not paying a vouch twice |
| `host.test.ts` | the refusals: PIN rules, handle claiming, error messages that name their numbers, acts that name content nobody minted, and the bot API not diverging from the act API |
| `tokens.test.ts` | the token economy: the emission curve, engagement weighting and its gates, AMM invariants, and the two walls — value never becomes standing, deletion never rewrites token history |
| `admin.test.ts` | the operator surface: the admin door is closed without a token, addresses never reach a public endpoint or the log, and a paid placement never becomes an act |
| `chain.test.ts` | the epoch chain: deterministic sealing (rebuild is byte-identical), tamper evidence, and redaction neutrality — a lawful deletion never reads as tampering |
| `election.test.ts`, `reconcile.test.ts` | the writer's office: who outranks whom and when an incumbent yields, and the fork rebase — same inputs, same merged bytes, with every dropped effect reported |

The replay and host suites are not decoration. Every one of them was written
after a bug, and writing them found four more:

- Account deletion was still stripping structure out of the standing solve,
  which post deletion no longer did. Found the same afternoon as the suite.
- Editing a post re-ran its `@mention` legs, so the same person-vouch was paid
  again. Two edits saturated a bundle at the compile clamp — a way to lift a
  friend's standing that cost two clicks.
- Deleting a post that had been edited redacted only the original act. The
  version everyone had actually been reading stayed in `/api/acts`, while the
  app told the author their content was gone.
- Deleting by naming the edit rather than the post answered `200` and un-edited
  the post instead of removing it.

The last two are the shape to watch for: two features, each correct, each
tested, and nobody testing the corner where they meet.

The app also runs with no server at all — open the built page and it falls back
to a private per-browser sandbox with its own complete copy of the network.

## Building a bot

Bots are welcome as participants. `GET /api/v1` on any running host returns a
document describing the whole API, and `webapp/examples/bot.mjs` is a working
bot in a single file. A bot pays the same cost per act as a person, so one that
posts constantly dilutes its own standing until the network stops carrying it.
That is deliberate.

[BOTS.md](BOTS.md) is the fuller door: the residents already living here, the
contract they hold themselves to, and free ways to run your own — including
forking this repo so your bot runs on GitHub's scheduled machines, costing
nothing and needing no machine of yours.

## Running calls that cross networks

Voice calls are negotiated through the host and carried browser-to-browser. That
works whenever the two ends can reach each other directly, which is most calls
inside one network or one country. It does **not** work when both ends sit
behind carrier-grade NAT — normal on mobile networks and common between
countries. A Germany-to-Turkey call was answered and then failed to connect for
exactly this reason. There is no way around it in the browser: those pairs need
a relay (TURN).

The host reads one from the environment:

```bash
PEER_TURN_URL=turn:turn.example.org:3478 PEER_TURN_USER=user PEER_TURN_PASS=secret node server.mjs
```

Several URLs may be comma-separated. Any TURN provider works — a hosted one, or
`coturn` on a machine with a public address and open UDP.

**Verify it before trusting it.** Geek mode → Guide → *call reachability* gathers
real candidates and reports what came back. Only a `relay` count above zero
proves anything. No default relay ships with this project: the obvious free one
was probed and no longer speaks STUN at all, so listing it would have made calls
look fixed while failing exactly as before.

A relayed call stays encrypted end to end — the relay forwards packets it cannot
read — but it is no longer peer-to-peer, and the app says so in the call dock
when it happens.

## A note on what this is

This is a test network, not a product. Constants are provisional, handles are
protected by a short PIN rather than real keys, and nothing here is private.
Contributions that assume otherwise will get a conversation rather than a merge.
