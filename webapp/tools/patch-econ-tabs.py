# The Economy switcher had a tab you could not see.
#
# Measured against the running app at 1280x720, viewport by viewport: the six
# lanes - Wallet, Network, Pools & ads, Epoch chain, Layer 0, Transactions -
# needed 688px of scrollWidth inside a 600px centre column, so 'Transactions'
# began at x=569 and ended at 688, off the right edge of its own strip. On a
# 375px phone it was worse: 652px inside 355px, with 'Epoch chain', 'Layer 0'
# and 'Transactions' all clipped. `.lanes` is flex-wrap: nowrap with overflow-x:
# auto and scrollbar-width: none, so the only way to those tabs was a sideways
# drag with nothing on screen saying there was anything to drag to. A tab
# reachable only by an unsignposted scroll is a hidden tab.
#
# The fix is to let the strip wrap, and NOT to shorten or group:
#
#   * shortening fails on the two widest labels, because each names two
#     subjects. 'Pools & ads' and 'Epoch chain' cannot lose a word without
#     losing half of what the tab holds, which is a worse bug than the scroll.
#   * grouping fails the predictability test. There is no merge of wallet,
#     graph, pools, chain, Layer 0 and history that a reader would guess at;
#     any pairing that made the arithmetic work would be arithmetic dressed up
#     as taxonomy, and people would hunt for the merged one.
#   * and neither survives the seventh lane, which is coming. Both are one-off
#     purchases of a few dozen pixels. Wrapping is not: it spends height, which
#     the page has, instead of width, which it does not.
#
# Nothing about the six destinations changes - same ids, same labels, same
# order, same .lane.on styling for the selected one. Only the strip's geometry.
#
# Run:  python tools/patch-econ-tabs.py && node social/assemble.mjs
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


# -- 1. The wrapping variant of the lane strip -----------------------------
# A modifier rather than a change to `.lanes`, because `.lanes` is also the
# two-lane switcher on Alerts (Inbound / The record) and the two-lane one on
# Chats (Your chats / Everyone). Two lanes never overflow, so those two are not
# broken and there is nothing there to fix; making them grid cells would resize
# buttons for no reason on screens that already worked. The comment above
# `.lanes` says the strip scrolls rather than wrapping ON PURPOSE, to keep its
# shape on a phone - that reasoning is sound for two lanes and stops being
# sound at six, so the rule stays and this one says when to reach for it.
once(
    r""".lane.on { border-color: var(--ember); background: var(--card); box-shadow: inset 0 2px 0 var(--ember); }
""",
    r""".lane.on { border-color: var(--ember); background: var(--card); box-shadow: inset 0 2px 0 var(--ember); }

/* -- ...and the same strip when there are too many lanes to fit one row ----
   Add beside `lanes` when the strip carries more lanes than a narrow column
   can hold. The Economy switcher needed 688px inside a 600px column at
   1280x720 and 652px inside 355px on a phone, which put its last tab off the
   edge behind a scrollbar that is deliberately invisible.

   Grid rather than flex-wrap: wrap, because flex leaves the final row ragged
   at natural widths or stretches a single leftover button across the whole
   column, and a lane four times the size of its neighbours reads as a banner
   rather than as one of a set. Equal columns keep every lane the same size and
   shape, which is what lets `.lane.on` go on doing its job unchanged - the
   ember rule along the top edge answers 'where am I' because the thing it
   marks is otherwise identical to its neighbours.

   The 120px floor is measured, not picked: the widest label in the strip is
   'Transactions' at 119.2px with this font, padding and letter-spacing, so
   120px is that rounded up. It holds at the tightest packing there is - the
   376px centre column at 1011px viewport, just above the 1010px breakpoint,
   where auto-fit lands on exactly three 120px columns and every label still
   sits on one line.

   How it degrades as lanes are added: lanes per row is whatever fits, so a
   seventh costs height and never reach - at 1280 it joins the second row and
   the strip does not grow at all. A label too wide for its column wraps onto a
   second line inside its own button and the row grows to match; it cannot be
   pushed out of the strip, because with the row axis wrapping there is no
   direction left for it to overflow along. Height is the only thing this can
   ever cost, and on every screen the rail sits beside or below the content. */
.lanes-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  overflow-x: visible; }
""",
    'CSS: .lanes-wrap, the lane strip that wraps instead of scrolling',
)


# -- 2. The Economy strip uses it ------------------------------------------
once(
    r"""    var views = [['wallet', 'Wallet'], ['net', 'Network'], ['pools', 'Pools & ads'], ['chain', 'Epoch chain'], ['layer0', 'Layer 0'], ['ledger', 'Transactions']];
    var bar = h('div', { class: 'lanes' });
""",
    r"""    // Six of them do not fit one row, and until this strip wrapped they did
    // not admit it: 688px of lanes inside a 600px centre column at 1280x720,
    // 652px inside 355px on a phone, with the overflow behind a scrollbar
    // `.lanes` hides on purpose. So between one and three of these tabs were
    // off the edge, reachable only by a sideways drag nothing signposted.
    //
    // The labels are unchanged and so is the count. Every one of the six is
    // already the shortest phrase that says what its tab is, and the two
    // longest are the two that name two subjects each - 'Pools & ads' and
    // 'Epoch chain' - so trimming either would have bought pixels by dropping
    // half of what the tab holds. `.lanes-wrap` spends a row of height
    // instead, and its comment in the stylesheet carries the measurements and
    // what happens when a seventh lane lands here.
    var views = [['wallet', 'Wallet'], ['net', 'Network'], ['pools', 'Pools & ads'], ['chain', 'Epoch chain'], ['layer0', 'Layer 0'], ['ledger', 'Transactions']];
    var bar = h('div', { class: 'lanes lanes-wrap' });
""",
    'the Economy sub-tab strip wraps instead of scrolling',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
