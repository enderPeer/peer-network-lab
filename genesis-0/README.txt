The first Peer Network, sealed.

893 acts and 60 signed epoch blocks, produced between 2026-07-31 and
2026-08-08. This is the complete and final state of the network as it ran
under its original economy, kept at a permanent address because a restart
should not be able to erase what came before it.

Everything here still verifies on its own terms. Replay acts.jsonl with
webapp/social/replay.cjs and you get the standings, feeds and balances the
live host computed; run webapp/chain/verify.mjs against acts.jsonl and
chain/blocks.jsonl and every root replays and every signature checks,
without trusting whoever is serving these bytes.

Why it ended: the economy was not real. Reserve came from a faucet named
for destruction that destroyed nothing, registration handed out units of a
reserve nobody had deposited, tBTC wore bitcoin's name on an invented
number, and Layer 0 kept full-reserve books over an empty reserve. The
network that follows accepts value from exactly one source - bitcoin
destroyed at an address with no key, proven by a transaction id anyone can
check. The two records cannot be continuous, and carrying the old balances
forward would have priced the fiction in permanently.

The people here were real, and their words are still theirs. Nothing in
this file is deleted by the restart; it simply stops being the present.
