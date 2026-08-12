# Two sentences left behind by the previous patch, both of which now say
# something the code no longer does.
#
#  1. The token card's second paragraph still called the ERC-20 "an ERC-20 on
#     Base" while every wallet check on the same card is now derived from the
#     chain the host serves. On a host configured for anything else, that
#     paragraph names one chain and the row underneath names another.
#
#  2. The pool row's "no minimum-shares guard" note was true when the guard
#     came from the host's snapshot: a host reporting no total shares left
#     nothing to compute a minimum from. The guard is now computed from a
#     read of the pool taken at signing time, so a host that reported nothing
#     no longer means an unguarded deposit — only a pool the CHAIN says holds
#     nothing does. Saying otherwise now understates the protection, which is
#     the same class of error as overstating it: the reader cannot tell which
#     of the two the sentence is.
#
# Run:  python tools/patch-chain-name-and-guard-note.py && node social/assemble.mjs
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
    "an ERC-20 on Base. That is the one a wallet holds",
    "an ERC-20 on ' + chainName + '. That is the one a wallet holds",
    'the two-tokens paragraph names the chain this host actually serves',
)

once(
    "text: 'This host did not report this pool\\u2019s total shares, "
    "so an add here goes in with no minimum-shares guard: the ratio can move under you between pressing and mining.' }));\n",
    "text: 'This host did not report this pool\\u2019s total shares, so the figure above the button is missing rather than zero. "
    "The minimum-shares guard does not come from it: the pool is read again on chain the moment you press, and the minimum is set from that. "
    "A deposit here goes in unguarded only if the chain also answers zero \\u2014 which means the pool holds nothing and there is no ratio to be moved.' }));\n",
    'the missing-total-shares note describes the guard as it is now computed',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
