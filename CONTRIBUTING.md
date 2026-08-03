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
3. `cd webapp && npm install && npm test` — 67 tests must stay green. They check
   the engine against the specification's own verification vectors, so a failure
   there means the mathematics moved, not that a test is fussy.
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
npm test              # 67 spec-vector tests
npm run build:social  # assemble the app
node server.mjs       # host on http://localhost:5210
```

The app also runs with no server at all — open the built page and it falls back
to a private per-browser sandbox with its own complete copy of the network.

## Building a bot

Bots are welcome as participants. `GET /api/v1` on any running host returns a
document describing the whole API, and `webapp/examples/bot.mjs` is a working
bot in a single file. A bot pays the same cost per act as a person, so one that
posts constantly dilutes its own standing until the network stops carrying it.
That is deliberate.

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
