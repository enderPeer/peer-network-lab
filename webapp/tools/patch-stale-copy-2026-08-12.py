# Three sentences this repo tells people that its own code contradicts.
#
# Found while driving the first real end-to-end run of the on-chain flow on a
# local devchain. None of these touch a money path, an act or a contract — they
# are display strings and one documentation bullet, and the engine is left
# exactly as it is. The rules they describe were changed long ago; only the
# descriptions were left behind.
#
#   1. "keep the 67 tests green" — the suite is 586 tests across 30 files. The
#      number is replaced with no number at all rather than with 586: a count
#      pasted into a card nobody re-reads has already rotted once by an order
#      of magnitude, and it will rot again. What the sentence is actually
#      asking for is a green suite, which is what it now says.
#
#   2. The PEER card's distribution rule. It claims each weigher is "scaled by
#      their commitment rate λ(α̂) and gated at α̂ ≥ 0.2". Both halves are false
#      in the engine that actually pays people: social/replay.cjs:1789 gates on
#      `if (sats <= 0) continue;` — any nonzero burn qualifies, there is no 0.2
#      threshold — and :1797 sets `var lam = ahat; // linear, not saturating`,
#      so λ(α̂)=α̂/(1+α̂) is gone. This is the card that explains where people's
#      money comes from, stating a retired rule as current fact.
#
#   3. TOKEN.md contradicts itself 38 lines apart: the bullet at :38 states the
#      same retired gate that :76 says is gone ("There is no α̂ threshold to sit
#      under any more; there is zero and there is more than zero"). A reader who
#      stops at the bullet list gets the wrong rule. The replacement wording is
#      taken from TOKEN.md's own corrected prose at :66 and :76 rather than
#      invented here, so the document agrees with itself in its own voice.
#
# Run:  python tools/patch-stale-copy-2026-08-12.py && node social/assemble.mjs && npx vitest run
import io

def patch(path, edits):
    s = io.open(path, encoding='utf-8').read()
    before = len(s)
    for old, new, label in edits:
        n = s.count(old)
        assert n == 1, 'anchor %r matched %d times in %s, expected exactly 1' % (label, n, path)
        s = s.replace(old, new, 1)
        print('  patched: ' + label)
    _data = s.encode('utf-8')      # must be its own line: open() truncates first
    io.open(path, 'wb').write(_data)
    print('%s %d -> %d chars' % (path, before, len(s)))


patch('social/template.html', [
    (
        "fork, keep the 67 tests green, open a pull request",
        "fork, keep the tests green, open a pull request",
        'the contribute card stops naming a test count that is off by an order of magnitude',
    ),
    (
        "each weigher scaled by their commitment rate λ(α̂) and gated at α̂ ≥ 0.2.",
        "each weigher scaled linearly by the satoshis they have proved destroyed — "
        "an account that never burned weighs nothing, and above zero there is no threshold.",
        'the PEER card describes the gate the engine actually applies',
    ),
])

patch('TOKEN.md', [
    (
        "- **The commitment gate.** A weigher's influence scales by `λ(α̂) = α̂/(1+α̂)`\n"
        "  and is **zero below α̂ = 0.2**. The rate is computed from burn the account\n"
        "  **acquired**, never from the grant handed out at registration — see below.\n"
        "  An account that never burned weighs nothing at all.",

        "- **Weight is linear in satoshis destroyed.** A weigher's influence scales\n"
        "  straight with burn the account **acquired**, never with the grant handed out\n"
        "  at registration — see below. An account that never burned weighs nothing at\n"
        "  all, and above zero there is no threshold to sit under.",
        'the bullet list stops stating the gate this document later says is gone',
    ),
])
