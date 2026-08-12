# Two sentences in the DEX card that were not quite true.
#
#   1. "The pools above are this app's own" is a claim about what is on screen,
#      and where PEER_POOLS_ADDR is unset there are no pools above at all —
#      the card up there says so instead. The sentence is about which contract
#      that card speaks for, so it says that.
#   2. The refusal to draw a link out folded three different reasons into one
#      sentence and produced "it would be written for Base and this host serves
#      chain 8453" when the missing piece was actually the cbBTC address. Three
#      reasons, three sentences, each naming the thing that is actually absent.
#
# Run:  python tools/patch-chainview-links-2.py && node social/assemble.mjs
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
    r"""      'The pools above are this app’s own: named pools inside one contract, opened by whoever wanted one, trading PEER against cbBTC. Every button on this screen calls that contract and nothing else.'));""",
    r"""      'The card above is this app’s own pools: named pools inside one contract, opened by whoever wanted one, trading PEER against cbBTC. Every button on it calls that contract and nothing else.'));""",
    'the card above is named as a card, not as a list that may be empty',
)

once(
    r"""      if (chainId !== 8453 || !/^0x[0-9a-fA-F]{40}$/.test(token) || !btc || !/^0x[0-9a-fA-F]{40}$/.test(btc)) {
        out.appendChild(h('p', { class: 'smallnote', text: 'No link out is drawn: it would be written for Base and this host serves chain ' + d.chainId + (btc ? '' : ', and no cbBTC address is configured to name the other side of the pair') + '. An exchange link built for the wrong chain sends somebody to a page about different coins with the same addresses.' }));
      } else {""",
    r"""      // Three different reasons not to draw a link out, and each says which
      // piece is actually missing. Folded into one sentence they produced
      // "it would be written for Base and this host serves chain 8453" on a
      // host whose only problem was an unset cbBTC address.
      var why = null;
      if (chainId !== 8453) {
        why = 'No link out is drawn. It would be written for Base, and this host serves chain ' + d.chainId + ': an exchange link built for the wrong chain sends somebody to a page about different coins that happen to sit at the same addresses.';
      } else if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
        why = 'No link out is drawn: this host did not name the token as an address, and a link built around ' + token + ' would point at nothing.';
      } else if (!btc || !/^0x[0-9a-fA-F]{40}$/.test(btc)) {
        why = 'No link out is drawn: a pair needs two sides and this host names only one. PEER_BTC_ADDR is unset here, so there is no second token to ask an exchange about.';
      }
      if (why) {
        out.appendChild(h('p', { class: 'smallnote', text: why }));
      } else {""",
    'each refusal to link names the piece that is missing',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
