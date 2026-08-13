# The add-liquidity preview rounded the wrong way.
#
# PeerPool.add pulls _ceilDiv(minted · reserve, total) from each side: deposits
# round UP, which is the contract's stated rule that every rounding favors the
# pool. The panel that tells you what the deposit will cost computed the same
# two numbers with BigInt floor division, so it could name a figure up to one
# raw unit BELOW what the contract actually takes — on each side.
#
# OBSERVED, on a devchain pool holding 857510361583535802 wei against 2 raw
# units, offering 2 PEER and 10 raw units:
#
#   the panel said   "about 2 PEER and 4.000e-18 cbBTC"
#   the pool pulled   1999999999714163216 wei and 5 raw units
#
# One raw unit of cbBTC IS one satoshi, so on Base this is a quote that
# understates the bitcoin side by a satoshi. The amount is trivial and the
# direction is not: this card's whole claim is that the integers under the
# decimals are what gets signed, and an estimate that can only ever be too LOW
# is the one shape of wrong a person cannot protect themselves against by
# reading it. The ceiling the user typed still binds — the contract can never
# pull more than the maximum offered — so nothing was ever at risk here; the
# number on screen simply did not match the number in the transaction.
#
# It is only visible at all because the pool under test is a few raw units
# deep, which is exactly the size the operator asked to be able to open. On a
# pool holding millions of satoshis the two agree to every digit displayed.
#
# The fix is the contract's own arithmetic, transcribed: a·b rounded up, with
# the zero case spelled out so it cannot underflow, mirroring _ceilDiv in
# PeerPool.sol line for line.
#
# Run:  python tools/patch-add-quote-ceildiv.py && node social/assemble.mjs
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


# ── 1. The helper, beside the other guard arithmetic ──────────────────────
once(
    """      function ocFloor(shown, now) {
        var a = ocGuard(now), b = ocGuard(shown);
        return a > b ? a : b;
      }""",
    """      function ocFloor(shown, now) {
        var a = ocGuard(now), b = ocGuard(shown);
        return a > b ? a : b;
      }
      // a/b rounded UP, which is how PeerPool.add computes what it pulls
      // (_ceilDiv, same shape, zero case spelled out so a==0 cannot
      // underflow). A preview that floors where the contract ceils names a
      // cost up to one raw unit under the real one, on each side.
      function ocCeilDiv(a, b) {
        return a === 0n ? 0n : (a - 1n) / b + 1n;
      }""",
    'ocCeilDiv, mirroring the contract',
)

# ── 2. The preview uses it ────────────────────────────────────────────────
once(
    "            var usedP = mint * rp / ts, usedB = mint * rb / ts;",
    "            var usedP = ocCeilDiv(mint * rp, ts), usedB = ocCeilDiv(mint * rb, ts);",
    'the add-liquidity preview rounds the way the pool does',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
