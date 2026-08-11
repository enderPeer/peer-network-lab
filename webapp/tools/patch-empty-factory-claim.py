# The card stops calling a factory empty when it only means it has not looked.
#
# drawPools gated the "open the first pool" invitation on `!scanError`, and
# scanError is set ONLY when the log scan failed AND nothing was remembered.
# An INCOMPLETE scan sets no error at all - it sets total, truncated, and
# scan.complete=false. So a host still walking the log rendered, in this
# order: "The factory is live and empty. The first pool is opened below -
# its starting ratio IS its starting price", and then, underneath, "showing
# 0 of 5 pools on this factory". The invitation is the sentence somebody
# acts on, and it is the wrong one: they open a second pool believing there
# is no market and set its ratio against a deep pool they cannot see, which
# is immediately arbitrageable against them. PeerPools has no privileged
# function to undo it.
#
# Ordinary path, not a corner: auto-deploy.ps1 lets the operator press Enter
# past the deploy block, and the scan then walks from block 0 for many
# refreshes. Any fresh clone, container or rebuilt box reaches it too, since
# server-data is gitignored and the scan state lives there.
#
# The count the factory itself reports is the honest gate: total comes from
# poolCount() on chain, not from the scan, so it is right even when nothing
# has been read yet.
#
# Run:  python tools/patch-empty-factory-claim.py && node social/assemble.mjs
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
    "            if (!scanError) listBox.appendChild(h('p', { class: 'smallnote', text: 'The factory is live and empty. The first pool is opened below \\u2014 its starting ratio IS its starting price.' }));\n",
    # Three states, not two. An error was already reported above; a factory
    # the chain says is empty invites the first pool; a factory that holds
    # pools this host has not read yet must say exactly that, because the
    # difference between "there is no market" and "I have not looked" is
    # the whole decision the reader is about to make.
    "            if (!scanError) {\n"
    "              var known = Number(np.total || 0);\n"
    "              listBox.appendChild(known === 0\n"
    "                ? h('p', { class: 'smallnote', text: 'The factory is live and empty. The first pool is opened below \\u2014 its starting ratio IS its starting price.' })\n"
    "                : h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px',\n"
    "                    text: 'This factory holds ' + known + ' pool' + (known === 1 ? '' : 's') + ' that this host has not read yet \\u2014 it is still walking the log. That is a list which has not arrived, not an empty factory. Do not open a \\u201cfirst\\u201d pool here: its ratio would be priced against pools you cannot see.' }));\n"
    "            }\n",
    'empty-factory claim is gated on the count the chain reports, not on the absence of an error',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
