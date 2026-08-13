# The per-tab rail was invisible on a phone, and a positional CSS rule did it.
#
# `.rail-left .card:nth-child(-n+3) { display: none; }` (max-width: 1010px) was
# written when the left rail was the feed's rail on every tab, and there it was
# correct: the feed draws a second copy of search, sorting and filters inside a
# folded <details class="ctl-m"> at the head of the list, because on a narrow
# screen the rail stacks BELOW the feed and controls that govern a list must not
# require traversing the list. One copy or the other, never both — so the rail's
# three came off at that width, and 'the first three' named them exactly.
#
# It stopped naming them the moment railLeftFor() gave the other four tabs rails
# of their own. Measured in the running app at 375x812, every card below is
# display: none:
#
#   Chats     What a message is here / Waiting on you / What saying it costs
#             -> all three hidden, rail height 0. The whole rail, gone.
#   Alerts    What has reached you / Who is naming you / Where these come from
#             -> all three hidden, rail height 0. The whole rail, gone.
#   Economy   Can you afford to speak? / PEER you hold / Epoch 3 hidden;
#             only 'On the chain, here' survived.
#   Profile   Your record / What your acts are made of / Who can act as this
#             handle hidden; only 'Where you are paid' survived.
#
# Which is the original complaint again, inverted: the rail was the feed's on
# every tab, and now on a phone it is nothing on four of them. Nobody chose
# either; both are what a rule that counts positions does when the thing it
# counts changes underneath it.
#
# So the cards get marked and the rule reads the mark. A class cannot drift the
# way an index does: `ctl-d` is on the three cards it was written for, and a
# rail card added, removed or reordered on any tab cannot inherit it by landing
# in a particular slot. The `.rail-left` scope stays, which is what keeps the
# phone copies inside `.ctl-m` visible — they are not in the rail.
#
# Run:  python tools/patch-rail-phone-hide.py && node social/assemble.mjs
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


# -- 1. The rule names the cards instead of counting them -------------------
once(
    r"""  .rail-left .card:nth-child(-n+3) { display: none; }
""",
    r"""  /* The rail's copy of the feed's reading controls, off at the width where
     the folded `.ctl-m` copy above the feed takes over — exactly one of the
     two is ever on screen. This selected `:nth-child(-n+3)` until the rail
     became per-tab, which was the same three cards only while every tab
     inherited the feed's rail; afterwards it hid the first three cards of
     whatever Chats, Alerts, Economy and Profile put there, which at 375px
     was the entire Chats and Alerts rails and three quarters of the other
     two. `.ctl-d` is on the three cards themselves, so no card can inherit
     this by being early. Scope stays `.rail-left`: the `.ctl-m` copies live
     in the centre column and must go on showing. */
  .rail-left .ctl-d { display: none; }
""",
    'CSS: hide the feed rail controls by mark, not by position',
)


# -- 2. The three cards carry the mark --------------------------------------
# At the composition site rather than inside railSearchCard/railSortCard/
# railFilterCard, because those three build both copies and this is true of
# only one of them. Marking them where the rail is assembled keeps the class
# meaning 'the rail's copy', which is what the stylesheet rule is about.
once(
    r"""    return [railSearchCard(), railSortCard(), railFilterCard(), aboutCard(), ageWidget(st), epochCard(st)];
""",
    r"""    // `ctl-d`, the desktop copy: feedTab draws these same three inside a
    // folded <details> at the head of the list for narrow screens, and the
    // stylesheet hides whichever copy is wrong for the width. The mark goes
    // on the cards because the rule used to find them by position, and
    // position stopped identifying them the moment this function started
    // handing the other four tabs rails of their own.
    var ctls = [railSearchCard(), railSortCard(), railFilterCard()];
    ctls.forEach(function (c) { c.className += ' ctl-d'; });
    return ctls.concat([aboutCard(), ageWidget(st), epochCard(st)]);
""",
    'the feed rail marks its three reading controls ctl-d',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
