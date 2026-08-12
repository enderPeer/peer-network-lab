# One label, from the explorer table rather than from memory.
#
# The steward row added by patch-claim-truth.py asked l2ScanLink for a link
# labelled "on basescan". l2ScanLink already names the explorer it built the
# href from, and every other caller lets it: a hardcoded name is a sentence
# about which chain this host serves, written by a page that does not know —
# the same mistake this file refuses everywhere else, one chain later.
#
# Run:  python tools/patch-claim-truth-2.py && node social/assemble.mjs && npx vitest run
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


once(
    """          var link = l2ScanLink(d.chainId, 'address', cs.steward, 'on basescan');""",
    """          // No label: l2ScanLink names the explorer it actually built the
          // href from, and this page must not say "basescan" about a chain the
          // host may not be serving.
          var link = l2ScanLink(d.chainId, 'address', cs.steward);""",
    'the steward link is labelled by the explorer table',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
