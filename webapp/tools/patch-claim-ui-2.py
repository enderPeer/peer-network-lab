# One connect button in the claim card, not two.
#
# The card grew two: one under the binding section (the address to bind comes
# from the wallet) and one above the epoch rows (the claimed flag and the claim
# itself come from the wallet). They do the identical thing — l2Connect writes
# one module-level l2Wallet — so a reader met "Connect a wallet" and then
# "Connect wallet" a few lines apart and had to work out which one was theirs.
# The binding one stays, because it is the one that appears first and the one
# that appears whether or not any claim contract exists; the lower row keeps
# the status line and points at it.
#
# Run:  python tools/patch-claim-ui-2.py && node social/assemble.mjs
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
    """      if (!l2Wallet) {
        wRow.appendChild(h('button', { class: 'btn small', text: 'Connect wallet', onclick: function () {
          l2Connect(chainHex, chainName).then(function (a) { if (a) redrawAll(); })
            .catch(function (e) { toast('Connect failed: ' + l2Err(e)); });
        } }));
        wRow.appendChild(h('span', { class: 'smallnote', text: 'Connecting lets this card ask the contract whether these epochs have already been claimed. It signs nothing until you press a Claim button.' }));
        return;
      }
""",
    """      if (!l2Wallet) {
        // Not a second button. The binding section above has the only one, and
        // it writes the same l2Wallet this row reads \\u2014 two controls doing
        // one thing, a few lines apart, is a question the reader should not
        // have to answer.
        wRow.appendChild(h('span', { class: 'smallnote', text: 'Connect the wallet above and this card will ask the contract whether these epochs have already been claimed. Connecting signs nothing; nothing here is signed until you press a Claim button.' }));
        return;
      }
""",
    'the claim card connects in one place',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
