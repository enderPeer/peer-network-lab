# A follow-up to tools/patch-wallet-clarity.py, in its own script because
# template.html had already been written by another change in between and
# re-running the first one would have taken that change with it.
#
# Seen in the browser rather than in a test: with no wallet extension, the
# PEER-on-Base card drew two stacked panels that told the reader the same
# thing twice — "No wallet in this browser..." beside the add button, and then
# an empty-looking mini-form saying "No wallet here to read a balance with."
# The second box exists to hold a Connect button and an address; without a
# wallet it holds neither, and a mini-form still draws its border and padding
# whether or not anything is in it.
#
# So the row is only put in the document when there is a wallet to connect.
#
# Run:  python tools/patch-wallet-clarity-2.py && node social/assemble.mjs
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
    """      var wRow = h('div', { class: 'mini-form persistent' });
      var balBox = h('div', {});
      body.appendChild(wRow);
      body.appendChild(balBox);
""",
    """      var wRow = h('div', { class: 'mini-form persistent' });
      var balBox = h('div', {});
      // Only where there is a wallet to connect to. Without one this row has
      // nothing to say that the line beside the add button has not already
      // said, and an empty mini-form still draws its own box.
      if (window.ethereum) body.appendChild(wRow);
      body.appendChild(balBox);
""",
    'the connect row is only mounted where a wallet exists',
)

once(
    """        if (!window.ethereum) {
          wRow.appendChild(h('span', { class: 'smallnote', text: 'No wallet here to read a balance with. The supply below still comes from the chain.' }));
          return;
        }
""",
    """        // The row is not in the document at all without a wallet.
        if (!window.ethereum) return;
""",
    'and says nothing twice',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
