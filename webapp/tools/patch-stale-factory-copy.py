# The word "factory" outlives the factory.
#
# The network runs ONE pool at one address. PeerPools.sol — the contract that
# held many named pools — is superseded and its reader is gone from
# chain-l2/onchain.mjs. What survived the migration is the VOCABULARY: a
# sentence on screen still tells a reader that "the factory address" would be
# approved on the wrong chain, and two cache fields still call the pool address
# `factory`.
#
# That matters more than tidiness. The card's whole argument is that ONE
# ADDRESS IS THE IDENTITY — nothing to name, nothing to enumerate, nothing to
# choose. A refusal notice that then speaks of "the factory" describes a design
# this app no longer has, to a person who is being asked to trust that the
# address in front of them is the only thing that identifies the pool. And a
# field named `factory` holding a pool address is the kind of thing a later
# reader believes.
#
# WHAT IS DELIBERATELY LEFT ALONE. Four places still say "factory" on purpose
# and are not touched here:
#
#   * the glossary entry ("no name, no id, no factory holding a list") and the
#     card's own history note — both are ABOUT the absence, which is the point;
#   * the stale-host branch (`d.namedPools && !d.pool`) and its notice, which
#     exist to recognise an OLDER host still answering with the named-pool
#     factory. That branch names the old thing because it is detecting the old
#     thing; renaming it would break what it says.
#
# Run:  python tools/patch-stale-factory-copy.py && node social/assemble.mjs
import io

TP = 'social/template.html'
s = io.open(TP, encoding='utf-8').read()
before = len(s)


def once(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, 'anchor %r matched %d times, expected exactly 1' % (label, n)
    s = s.replace(old, new, 1)
    print('  patched: ' + label)


# ── 1. The one sentence a user actually reads ─────────────────────────────
# This is the wrong-chain refusal. It is shown at the moment somebody is being
# told why no buttons are drawn, so it is the worst place in the file to name a
# contract shape that no longer exists.
once(
    "text: 'This host serves chain ' + d.chainId + ', and everything in this card is written for Base (8453): the addresses, the checks and every signature. The factory address would be read and approved on the wrong chain, where it can hold nothing at all or hold a different contract entirely, so nothing is drawn here rather than drawn wrong. The sandbox pools below are unaffected \\u2014 they never leave this log.'",
    "text: 'This host serves chain ' + d.chainId + ', and everything in this card is written for Base (8453): the addresses, the checks and every signature. The pool address would be read and approved on the wrong chain, where it can hold nothing at all or hold a different contract entirely, so nothing is drawn here rather than drawn wrong. The sandbox pools below are unaffected \\u2014 they never leave this log.'",
    'the wrong-chain refusal names the pool, not a factory',
)

# ── 2. The comment directly above it, which makes the same claim ──────────
once(
    """        // Every button below says \\u201con Base\\u201d and every check below
        // compares against OC_CHAIN, but the factory address comes from a
        // host that can be configured for any EVM chain. Pointing a Base
        // wallet at another chain's factory address does not fail loudly:""",
    """        // Every button below says \\u201con Base\\u201d and every check below
        // compares against OC_CHAIN, but the pool address comes from a
        // host that can be configured for any EVM chain. Pointing a Base
        // wallet at another chain's pool address does not fail loudly:""",
    'the reasoning above it agrees',
)

# ── 3. Two more comments that describe the address as a factory ───────────
once(
    "// a factory that only exists on Base",
    "// a pool that only exists on Base",
    'the wallet-event comment',
)
once(
    "On the wrong chain the factory address holds no code:",
    "On the wrong chain the pool address holds no code:",
    'the stale-chain comment',
)
once(
    "  // l2Tokens holds the two token addresses read off the pools factory, which",
    "  // l2Tokens holds the two token addresses read off the pool, which",
    'the l2Tokens comment',
)

# ── 4. The peer-burn card's note about today's real state ─────────────────
once(
    "no pools factory is deployed, so there",
    "no pool is deployed, so there",
    'the peer-burn card says no POOL is deployed',
)

# ── 5. The transcribed /api/peerburn shape ────────────────────────────────
# The host answers `pool` with the address and the three reserve words, and an
# `identity` sentence saying the address is the only identifier. There is no
# poolId, no factory, no creator and no name to disclaim — transcribing a shape
# the endpoint stopped sending is how a client gets written against a fiction.
once(
    "    //            pool:  { poolId, factory, creator, nameNote },",
    "    //            pool:  { address, resPeerRaw, resBtcRaw, identity },",
    'the transcribed response shape matches what the host sends',
)

# ── 6. Two cache keys that hold a pool address ────────────────────────────
# Both memoise "what did THIS address answer", keyed by the address itself so a
# reconfigured host cannot be served another pool's tokens or MIN_LIQ. The key
# is right; only its name was inherited.
once(
    "        if (l2Tokens && l2Tokens.factory === key) return l2Tokens;",
    "        if (l2Tokens && l2Tokens.pool === key) return l2Tokens;",
    'l2Tokens cache hit keys on pool',
)
once(
    "        l2Tokens = { factory: key, peer: '0x' + pa.toString(16).padStart(40, '0'), btc: '0x' + ba.toString(16).padStart(40, '0') };",
    "        l2Tokens = { pool: key, peer: '0x' + pa.toString(16).padStart(40, '0'), btc: '0x' + ba.toString(16).padStart(40, '0') };",
    'l2Tokens cache store keys on pool',
)
once(
    "        if (!ocMin || ocMin.factory !== key) {\n          ocMin = { factory: key, value:",
    "        if (!ocMin || ocMin.pool !== key) {\n          ocMin = { pool: key, value:",
    'the MIN_LIQ memo keys on pool',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
