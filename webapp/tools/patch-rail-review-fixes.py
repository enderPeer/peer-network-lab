# The per-tab rail, corrected: seven findings, and none of them cosmetic.
#
# The rail patch that preceded this one moved the right cards onto the right
# tabs. What it got wrong is what those cards SAY and what the page around
# them does, and five of the seven faults below are the same species: a
# sentence that describes behaviour the code does not have.
#
#   1. CHATS said a message "enters no score: messaging somebody moves neither
#      your standing nor theirs". Measured against social/replay.cjs — alice
#      vouches for bob, then sends bob one message — alice's standing falls
#      33.3% and bob's falls 15.2%. The dm branch (replay.cjs:1689) is
#      `debit(a.from); weighHome(a.from, 0.8, 0.8)`: two standing-relevant
#      effects, not zero. debit raises N and drops reserve, so the sender's own
#      rate falls; weighHome pushes a self-cell onto the sender's diagonal,
#      which is the exact mechanism the guide already describes for reactions
#      ("their coefficient lands on your own diagonal, crowding your outward
#      influence") — and crowding the outward transport is what drags down
#      everyone the sender vouches for. The same rail contradicted itself two
#      cards down, where railWallNote prints "acting raises N, so every act
#      drags x* down". Fixed in all three places the claim was written: the
#      rail card, TERMS.dm, and the guide paragraph.
#
#      What stays TRUE and is what people actually need told: a message
#      transports nothing TO the person you wrote to. No vouch is compiled, it
#      enters no feed ranking and no PEER weight. The reassurance was about
#      direction; it was written as if it were about magnitude.
#
#   2. ALERTS counted the wrong forty acts and called them the most recent.
#      notificationsFor mixed two index scales — graph rows keyed on
#      `e.appendIndex` (a position in the graph's edge array) and message rows
#      on `100000 + m.idx` (a position in the act log). The constant made every
#      message outrank every reaction, comment, quote, mention, tag and vouch,
#      forever, before slice(0,40) ran. Reproduced: a log where bob sends alice
#      45 messages and then, as the two newest acts in the whole log, reacts to
#      and comments on her post. The rail printed `{ dm: 40 }` — no reactions
#      line, no comments line, and a sentence claiming those forty were the
#      most recent while the two it dropped were the newest acts on the
#      network. It mis-ordered the centre list too; this is fixed at the index,
#      not at the sentence.
#
#      The comparable key is the ACT index, which is what the rest of the app
#      already prints ("act #217" in a chat thread). Messages carry it. Edges
#      did not, so replay.cjs now records which act appended which edge — as a
#      side table, never as a field on the edge record, because an edge is
#      material the epoch hash commits to and a published epoch has to keep
#      reproducing.
#
#   3. THREE OF THE FOUR NEW RAILS opened with a card restating the identity
#      card six inches to their right. Verified live at 1280x720: the Economy
#      money card printed reserve 3.000 / rate 0.300 / acts it covers 56 / x*
#      3.000, and idCard on the same screen printed all four. Profile's record
#      card printed standing, rate, N, reserve — again all four. Chats repeated
#      reserve and affordable. The Economy PEER card printed "in the act log /
#      of everything minted" while the Wallet lane's own centre column printed
#      "you hold / your share of everything minted" plus a third copy under
#      "Your balances". Each card did carry something new, but the new part was
#      one element and the restatement was the headline. The ledgers are cut;
#      what is left is what only that rail has.
#
#   4. railWallNote said "the network refuses your writes". Nothing refuses
#      them. tryAct (template.html:2166) gates on W1 solvency alone; the host's
#      W1_GATED set is a solvency set and its own status text says the opposite
#      in as many words ("your acts still record, but your standing no longer
#      carries weight for others"); W2a is an epoch-close check whose failure
#      makes the certificate read "wall/door failed". The overstatement was in
#      TERMS.wall, the guide and wallBanner too, so all four now say what the
#      code does — including the mechanism, which is emission: a ledger whose
#      own rate is under the floor emits proportionally less outward and keeps
#      the remainder on its own diagonal (peer-engine emission/solveStanding).
#
#   5. "exactly the list beside this" was false on the Alerts record lane,
#      where the centre column becomes ledgerTab — everybody's acts, most of
#      them older and none of them inbound. The rail was made tab-aware and not
#      lane-aware, and it is the only card that asserts a relationship with the
#      centre column, so it was the only one a lane switch could falsify. Both
#      Alerts and Economy now read their lane.
#
#   6. THE PRIMARY TAB STRIP clipped Profile at 375px — the reported bug, one
#      level up from the Economy strip that was fixed. `.tabs` had the same
#      construction the earlier patch's own comment condemns: overflow-x auto
#      with the scrollbar hidden. Bare it just fits (scrollWidth 371 ==
#      clientWidth 371, zero margin), but renderGeek appends a `.nbadge` to
#      Alerts whenever anything is unseen and a `.live-dot` to Profile whenever
#      anyone is broadcasting: measured with both present, 384 vs 371, Profile
#      13px past the edge behind an invisible scrollbar. At 320px it clipped
#      with no adornment at all — 384 vs 316, Profile 66px over. The tab that
#      disappeared was Profile, pushed off by a dot drawn on Profile itself.
#      Measured after the fix, both adornments present: 375px one row, 371 ==
#      371; 320px two rows, 316 == 316, nothing clipped.
#
#   7. `position: sticky` on both rails had never worked. `html, body {
#      overflow-x: hidden }` makes body a scroll container, and a sticky
#      element resolves its offsets against the nearest scrollport — body,
#      which never scrolls. Controlled experiment at scrollTop 550: both rails
#      reported top = -329.3, exactly naturalTop 220.7 - 550. Computed
#      `position` read "sticky" throughout, so nothing in devtools said it was
#      dead. `overflow-x: clip` clips identically and does NOT create a scroll
#      container, so the horizontal guard survives intact (re-measured with a
#      1000-character word injected: documentElement.scrollWidth 1265 ==
#      clientWidth 1265) and the rails pin. A rail taller than the pinned slice
#      would then have its bottom cards buried, so `.rail` is bounded and
#      scrolls inside itself — which is exactly the defect this whole task is
#      about, arriving a second way.
#
#      Turning it on uncovered a second dead rule underneath: the one-column
#      `.rail { position: static }` sat ABOVE the `.rail` rule it overrode, so
#      at equal specificity the later one won and the phone override had never
#      applied. Nothing could show that while sticky was broken, because a dead
#      sticky and a static box lay out identically — but with the pin working
#      it put a 750px scrolling box below the content at 375x812, measured. It
#      moves to the second 1010px block, which is after `.rail`.
#
# Run:  python tools/patch-rail-review-fixes.py && node social/assemble.mjs
import io

TP = 'social/template.html'
RP = 'social/replay.cjs'


class Patcher(object):
    def __init__(self, path):
        self.path = path
        self.s = io.open(path, encoding='utf-8').read()
        self.before = len(self.s)

    def once(self, old, new, label):
        n = self.s.count(old)
        assert n == 1, 'anchor %r in %s matched %d times, expected exactly 1' % (label, self.path, n)
        self.s = self.s.replace(old, new, 1)
        print('  patched: ' + label)

    def write(self):
        _data = self.s.encode('utf-8')     # its own line: open() truncates first
        io.open(self.path, 'wb').write(_data)
        print('%s %d -> %d chars' % (self.path, self.before, len(self.s)))


t = Patcher(TP)
r = Patcher(RP)


# ══════════════════════════════════════════════════════════════════════════
# FINDING 6 — the primary tab strip clipped Profile
# ══════════════════════════════════════════════════════════════════════════
t.once(
    r"""/* Eight tabs do not fit a phone, and the page clips horizontal overflow, so
   the last ones were unreachable rather than merely off-screen — reported as
   "the Live tab is not shown". The row scrolls on its own instead. */
.tabs { display: flex; gap: 12px; background: transparent; border: 0; border-radius: 0; padding: 0 2px; max-width: 100%; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.tabs::-webkit-scrollbar { display: none; }
""",
    r"""/* The tabs do not fit a phone, and the page clips horizontal overflow, so the
   last ones are unreachable rather than merely off-screen — reported once as
   "the Live tab is not shown". The row used to scroll on its own, with
   `scrollbar-width: none` and a `::-webkit-scrollbar { display: none }` rule
   hiding the only thing that said it could: a tab reachable only by an
   unsignposted sideways drag is a hidden tab, which is the same fault the
   Economy lane strip was fixed for and this row inherited unchanged.

   Measured at 375x812 in the running app. Bare, the strip just fits and
   nothing warns you how narrowly: scrollWidth 371 against clientWidth 371,
   zero margin. But renderGeek appends two adornments in perfectly ordinary
   states — a `.nbadge` on Alerts whenever anything is unseen, a `.live-dot` on
   Profile whenever anyone is broadcasting — and with both present it is 384
   against 371, putting Profile's right edge 13px past the container. At 320px
   it overflowed with no adornment at all, 384 against 316, Profile 66px over.
   The tab that vanished was Profile, and the dot that pushed it off is drawn
   on Profile: the indicator became unreachable exactly when it lit up.

   So the row wraps. Height is the only thing wrapping can cost, and the
   topbar already carries `flex-wrap: wrap` for the same reason. Re-measured
   with badge and dot present: 375px keeps one row at 371 == 371, and 320px
   takes two rows at 316 == 316 with nothing clipped. */
.tabs { display: flex; flex-wrap: wrap; gap: 12px; background: transparent; border: 0; border-radius: 0; padding: 0 2px; max-width: 100%; }
""",
    'CSS: .tabs wraps instead of scrolling behind a hidden scrollbar',
)

t.once(
    r"""  .tabs { order: 3; width: 100%; justify-content: space-between; }
  .tabs button { flex: 1; padding: 8px 4px; }
""",
    r"""  .tabs { order: 3; width: 100%; justify-content: space-between; gap: 8px; }
  /* `flex: 1` here was `flex: 1 1 0%`, which cannot shrink a nowrap label
     below its own text — so it never equalised anything at these widths, it
     only guaranteed that a lone wrapped tab would stretch across the whole
     row like a banner. `0 1 auto` leaves the buttons at their content width
     and lets `space-between` do the spreading it was already asking for.
     The tighter tracking is what buys the headroom the two adornments need:
     0.1em over ~30 characters of label is ~37px of pure letter-spacing. */
  .tabs button { flex: 0 1 auto; padding: 8px 4px; letter-spacing: 0.04em; }
""",
    'CSS: the phone tab strip stops pretending it can equalise nowrap labels',
)


# ══════════════════════════════════════════════════════════════════════════
# FINDING 7 — sticky rails that never stuck, and a rail too tall for the day
#             somebody fixed them
# ══════════════════════════════════════════════════════════════════════════
t.once(
    r"""/* Structural backstop: whatever a peer posts, the page itself never widens —
   an oversized child scrolls inside its own card instead. */
html, body { overflow-x: hidden; }
""",
    r"""/* Structural backstop: whatever a peer posts, the page itself never widens —
   an oversized child scrolls inside its own card instead.

   `clip`, not `hidden`, and the difference is load-bearing rather than
   stylistic. `overflow: hidden` makes an element a scroll container; `clip`
   clips without becoming one. With `hidden` on body, `.rail`'s
   `position: sticky` resolved its offsets against body — a scrollport that
   never scrolls — so both rails scrolled away like static boxes on every
   screen this app has ever been opened on, while computed `position` went on
   reading "sticky" and devtools said nothing. Measured at scrollTop 550: both
   rails reported top = -329.3, exactly naturalTop 220.7 minus the scroll.
   Lifting the declaration alone moved them to top = 62 immediately.

   The guard is unchanged in what it guards: re-measured with a
   1000-character unbroken word posted into a card, documentElement.scrollWidth
   1265 == clientWidth 1265, the same as before. `hidden` is left in front as
   the fallback for engines without `clip` — they keep today's behaviour
   exactly, which is a dormant sticky rule and a page that does not widen. */
html, body { overflow-x: hidden; overflow-x: clip; }
""",
    'CSS: the horizontal guard stops eating the sticky rails',
)

# The one-column override lived HERE, above the `.rail` rule it was meant
# to override, so it never applied: same specificity, and the later rule
# wins. That was invisible while sticky was inert — static and a dead sticky
# look identical — and it stopped being invisible the moment the line above
# started working, at which point a phone got a rail pinned below the content
# and bounded to a scrolling box. Measured at 375x812 with the reset left
# here: computed position "sticky", max-height 750px, rail height 750. It
# moves to the second `max-width: 1010px` block, which sits after `.rail` and
# is already where the one-column rail rules live.
t.once(
    r"""@media (max-width: 1010px) { .cols { grid-template-columns: minmax(0, 1fr); } .rail { position: static; } }
""",
    r"""@media (max-width: 1010px) { .cols { grid-template-columns: minmax(0, 1fr); } }
""",
    'CSS: the dead one-column rail override leaves the block above .rail',
)

t.once(
    r"""  .rail-left .ctl-d { display: none; }
}
""",
    r"""  .rail-left .ctl-d { display: none; }
  /* One column: the rail is below the content, so pinning it would pin it to
     a viewport the reader has already scrolled past, and bounding its height
     would turn a full-width column into a short box that scrolls inside a
     page that scrolls. Both are undone together or neither is.

     This is the block that can undo them. The same three declarations used to
     sit in the `max-width: 1010px` rule beside `.cols`, which is ABOVE the
     `.rail` rule — same specificity, later rule wins, so the override had
     never once applied. Nothing showed it while sticky was broken, because a
     dead sticky and a static box lay out identically. */
  .rail { position: static; max-height: none; overflow-y: visible; }
}
""",
    'CSS: the one-column rail reset moves to where it can actually win',
)

t.once(
    r""".rail { position: sticky; top: 62px; }
""",
    r"""/* Pinned under the topbar, and BOUNDED, because a pinned rail taller than
   the slice it is pinned into buries whatever is at its bottom — at 1280x720
   the slice is 720 - 62 = 658px, and the Economy rail is over a thousand.
   The two cards that would have gone under the fold there are the epoch clock
   and the on-chain surfaces card: two of the things this rail exists to
   carry. A rail that scrolls inside itself keeps all of them reachable, which
   is the whole point of the column. */
.rail { position: sticky; top: 62px; max-height: calc(100vh - 62px); overflow-y: auto; }
""",
    'CSS: .rail is bounded so the pin cannot bury its last cards',
)

t.once(
    r"""   pushed out of the strip, because with the row axis wrapping there is no
   direction left for it to overflow along. Height is the only thing this can
   ever cost, and on every screen the rail sits beside or below the content. */""",
    r"""   pushed out of the strip, because with the row axis wrapping there is no
   direction left for it to overflow along. Height is the only thing this can
   ever cost, and this strip is in the centre column, which is not height-
   bounded on any screen. (An earlier version of this note said height was
   safe because "on every screen the rail sits beside or below the content",
   which was leaning on `position: sticky` being broken. It is not broken any
   more, and `.rail` is bounded and scrolls inside itself instead — but none
   of that was ever this strip's business.) */""",
    'CSS: the lanes-wrap note stops resting on the sticky bug',
)


# ══════════════════════════════════════════════════════════════════════════
# FINDING 2 — the act index, so two sources of alerts can be ordered together
# ══════════════════════════════════════════════════════════════════════════
r.once(
    r"""  for (var i = 0; i < acts.length; i++) {
    var a = acts[i];
""",
    r"""  // Which act appended which edge: edgeAct[appendIndex] = act index.
  //
  // The graph numbers edges by append order and the log numbers acts by
  // append order, and those are not the same scale — one act appends zero
  // edges, one, or two. Anything that has to interleave a graph-derived
  // record with an act-derived one needs a key both can be read on, and the
  // act index is the one both genuinely have; the alerts list had been
  // comparing the two scales directly and getting a fixed, permanent
  // mis-order out of it.
  //
  // Kept beside the graph rather than ON the edge record, deliberately: an
  // edge is material the epoch hash commits to, and a field added to it would
  // change what an already-published epoch reproduces.
  var edgeAct = [];
  for (var i = 0; i < acts.length; i++) {
    // Everything appended since the last time round the loop came from the
    // act before this one — which is why the fill sits at the TOP of the body
    // rather than the bottom, where the branch's `continue`s would skip it.
    // At i = 0 anything already there predates the log and is left at -1.
    while (edgeAct.length < g.edges.length) edgeAct.push(i - 1);
    var a = acts[i];
""",
    'replay: edgeAct records which act appended which edge',
)

r.once(
    r"""  // Deleted actors leave the standings solve entirely: their vouches (given
""",
    r"""  // The last act's edges, which no next iteration will claim. Edges appended
  // AFTER this point — the self-declaration and self-reputation pair below,
  // recomputed from the solved standing — belong to no act and get no entry,
  // which is the honest answer for them.
  while (edgeAct.length < g.edges.length) edgeAct.push(acts.length - 1);

  // Deleted actors leave the standings solve entirely: their vouches (given
""",
    'replay: the tail fill, before the post-loop self edges',
)

r.once(
    r"""    peerBurnGrid: peerBurnGrid,
""",
    r"""    peerBurnGrid: peerBurnGrid,
    // appendIndex -> act index, for anything that has to put a graph-derived
    // record and an act-derived one in one order. Sparse at the end on
    // purpose: the self edges appended after the log was consumed have no act.
    edgeAct: edgeAct,
""",
    'replay: edgeAct is published with the rest of the state',
)

t.once(
    r"""      if (who2 && who2 !== me && st.handles[who2]) {
        out.push({ who: who2, kind: kind, target: target, idx: e.appendIndex });
      }
    });
    st.dms.forEach(function (m) {
      if (m.to !== me) return;
      if (m.call) {
        out.push({ who: m.from, kind: 'call', text: m.call.outcome === 'completed' ? 'call · ' + fmtDur(m.call.dur) : m.call.outcome + ' call', idx: 100000 + m.idx });
      } else {
        out.push({ who: m.from, kind: 'dm', text: m.text, idx: 100000 + m.idx });
      }
    });
    out.sort(function (a, b) { return b.idx - a.idx; });
    return out.slice(0, 40);
""",
    r"""      if (who2 && who2 !== me && st.handles[who2]) {
        out.push({ who: who2, kind: kind, target: target, idx: actOf(e) });
      }
    });
    st.dms.forEach(function (m) {
      if (m.to !== me) return;
      if (m.call) {
        out.push({ who: m.from, kind: 'call', text: m.call.outcome === 'completed' ? 'call · ' + fmtDur(m.call.dur) : m.call.outcome + ' call', idx: m.idx });
      } else {
        out.push({ who: m.from, kind: 'dm', text: m.text, idx: m.idx });
      }
    });
    out.sort(function (a, b) { return b.idx - a.idx; });
    return out.slice(0, 40);
""",
    'notificationsFor: one index scale, the act index',
)

t.once(
    r"""  function notificationsFor(st, me) {
    if (!me) return [];
    var out = [];
""",
    r"""  /**
   * Inbound acts naming you, newest first.
   *
   * Both halves of this list are keyed on the ACT index, which is the number
   * the rest of the app already prints ("act #217" on a message) and the only
   * scale the two sources share. It used to key graph rows on `e.appendIndex`
   * — a position in the graph's edge array — and message rows on
   * `100000 + m.idx`, a position in the act log with a constant bolted on to
   * keep the two apart. The constant did keep them apart: it put every
   * message ahead of every reaction, comment, quote, mention, tag and vouch
   * that has ever happened or ever will, before the slice below ran.
   * Reproduced against replay.cjs — 45 messages, then a reaction and a comment
   * as the two newest acts in the whole log — this returned forty messages and
   * neither of the two acts that were actually newest.
   */
  function notificationsFor(st, me) {
    if (!me) return [];
    var out = [];
    // An edge appended after the log was consumed (the self-declaration pair
    // recomputed from the solved standing) belongs to no act. None of the
    // families read below is one of those, so this is a guard rather than a
    // case: -1 sorts last and is never mistaken for act zero.
    var eAct = st.edgeAct || [];
    function actOf(e) {
      var v = eAct[e.appendIndex];
      return typeof v === 'number' ? v : -1;
    }
""",
    'notificationsFor: the doc comment carries the defect it was fixed for',
)

# The seen mark was written on the OLD mixed scale, and the biggest number it
# could hold was 100000 + an act index. Left in place it would sit permanently
# above every act index this network will ever reach, so nothing would ever
# read as new again — a silent, permanent zero on the one badge that tells
# somebody an act named them. Bumping the key resets it once; the first visit
# to Alerts re-marks it on the new scale, which is exactly what it is for.
t.once(
    r"""  var LS_SEEN = 'peer-sandbox-seen-v1';
""",
    r"""  // v2: the mark is on the act index now. A v1 mark was written on the old
  // mixed scale, where a message scored 100000 + its act index — above every
  // act index this log will plausibly reach, so keeping it would leave the
  // badge permanently reading zero. One reset, and the first look at Alerts
  // writes the mark again on the scale it is now compared against.
  var LS_SEEN = 'peer-sandbox-seen-v2';
""",
    'the seen mark moves to the act index with a new key',
)


# ══════════════════════════════════════════════════════════════════════════
# FINDING 4 — the wall refuses nothing, said in the four places it was claimed
# ══════════════════════════════════════════════════════════════════════════
t.once(
    r"""      one: 'The floor you must stay above to keep writing: x* ≥ ' + fmt(SAFE_FLOOR, 3) + '.',
      more: 'It is checked per person, and again on every writer when an epoch closes. Falling through it does not delete you — it stops you writing until standing comes back.',
""",
    r"""      one: 'The floor every writer’s x* must clear when an epoch closes: x* ≥ ' + fmt(SAFE_FLOOR, 3) + '.',
      more: 'Nothing refuses an act for being under it — the only gate that stops an act is W1, which asks whether your reserve covers the θ. What falling through it costs is the certificate: an epoch you wrote in while under the floor closes as “wall/door failed”. Separately, an account whose own rate is under the floor emits less of its standing outward, keeping the remainder on its own diagonal, so the people it vouches for feel it. Burning raises the rate and lifts both back.',
""",
    'TERMS.wall: the wall stops no writes',
)

t.once(
    r"""    var msg = w.below
      ? 'Below the safety wall — the network will refuse your writes until you burn credits.'
      : (w.actsLeft <= 0
        ? 'One more act and your own rate falls below the wall. Burn credits first.'
        : 'Close to the safety wall: about ' + w.actsLeft + ' more act' + (w.actsLeft === 1 ? '' : 's') + ' before your rate drops under it. Burn credits to keep talking.');
    return h('div', { class: 'wall-warn' + (w.below ? ' bad' : '') },
      h('b', { text: w.below ? '⛔ frozen' : '⚠ approaching the wall' }),
""",
    r"""    // "frozen" and "will refuse your writes" were both false, and the second
    // was checkable in one grep: tryAct gates on W1 solvency and nothing
    // else, and the host's own status text for this state says the opposite —
    // "your acts still record, but your standing no longer carries weight for
    // others". W2a is read when an epoch CLOSES, and a writer under it makes
    // the certificate fail; it has never rejected an act.
    var msg = w.below
      ? 'Under the safety wall. Your acts still record — nothing refuses them — but writing while you are under it makes this epoch’s certificate fail its W2a check on you. Burning lifts your rate back over the floor.'
      : (w.actsLeft <= 0
        ? 'One more act and your own rate falls below the wall. Burn credits first.'
        : 'Close to the safety wall: about ' + w.actsLeft + ' more act' + (w.actsLeft === 1 ? '' : 's') + ' before your rate drops under it. Burn credits to keep talking.');
    return h('div', { class: 'wall-warn' + (w.below ? ' bad' : '') },
      h('b', { text: w.below ? '⛔ under the wall' : '⚠ approaching the wall' }),
""",
    'wallBanner: no freeze, because nothing freezes',
)

t.once(
    r"""' (below it you cannot write) and the ', K('W2b door'), '""",
    r"""' (a writer under it fails the epoch’s W2a check — the acts still record) and the ', K('W2b door'), '""",
    'the guide: the wall is an epoch check, not a write gate',
)

t.once(
    r"""  function railWallNote(st) {
    var w = wallState(st, who);
    if (!w) return null;
    if (w.below) {
      return h('p', { class: 'smallnote', style: 'color:var(--bad)' },
        'Your x* is under the ', term('wall', 'W2a wall'), ' — the network refuses your writes until standing comes back or you burn more. Nothing is deleted and nothing is lost; you cannot write.');
    }
""",
    r"""  function railWallNote(st) {
    var w = wallState(st, who);
    if (!w) return null;
    if (w.below) {
      var note = h('p', { class: 'smallnote', style: 'color:var(--bad)' },
        'Your x* is under the ', term('wall', 'W2a wall'), ' — and nothing refuses the act. You can still post, message and vouch: the only gate that stops one is ',
        term('w1', 'W1'), ', which asks whether your reserve covers the θ. What the wall decides is the certificate — write in this epoch while you are under the floor and its close stamps you there, and the epoch closes as “wall/door failed”.');
      // The second consequence is keyed on the OWN rate, not on x*, so it is
      // said only when the own rate is the thing that is under: emission is
      // min(1, own rate / floor), and the share you do not emit stays on your
      // own diagonal instead of reaching anyone you vouch for. Somebody
      // carried over the floor by other people's vouches is under W2a without
      // being under this, and telling them otherwise would be the same class
      // of error as the sentence this replaces.
      var lw = st.ledgerById[who];
      if (lw && (lw.burnBal / Math.max(lw.actCount, 1)) / NU < SAFE_FLOOR) {
        note.appendChild(h('span', { text: ' Your own rate is under it too, so you are emitting less of your standing outward — the share you would have routed to the people you vouch for stays on your own diagonal. Burning is what lifts it back.' }));
      }
      return note;
    }
""",
    'railWallNote: what being under the wall actually does',
)


# ══════════════════════════════════════════════════════════════════════════
# FINDING 1 — a message moves standing, in three places that said it does not
# ══════════════════════════════════════════════════════════════════════════
t.once(
    r"""      more: 'A Send act carries the sender, the recipient and the text into the same append-only record as every post — served by this host, copied into every mirror, and published in the archive. It costs θ like any other act and enters no score. “Direct” says who it is addressed to; it has never meant hidden, and nothing in this app can make it so.',
""",
    r"""      more: 'A Send act carries the sender, the recipient and the text into the same append-only record as every post — served by this host, copied into every mirror, and published in the archive. It costs θ and raises N like any other act, and like any artifact-directed act it weighs home: the coefficient lands on the sender’s own diagonal. So sending moves the SENDER’s standing, and through it everyone the sender vouches for. What it never does is carry anything to the person it is addressed to — no vouch is compiled, and it enters no feed ranking and no PEER weight. “Direct” says who it is addressed to; it has never meant hidden, and nothing in this app can make it so.',
""",
    'TERMS.dm: a message is priced and weighs home',
)

t.once(
    r"""        P(B('A message is one of them. '), 'A direct message is a ', K('Send'), ' act: sender, recipient and text, appended to the same public log as everything else and readable by anybody — including through the ', K('Everyone'), ' lane on the Chats tab, which browses other people’s conversations. It debits θ like any other act and enters no score. “Direct” names who it is addressed to and has never meant hidden.')),""",
    r"""        P(B('A message is one of them. '), 'A direct message is a ', K('Send'), ' act: sender, recipient and text, appended to the same public log as everything else and readable by anybody — including through the ', K('Everyone'), ' lane on the Chats tab, which browses other people’s conversations. “Direct” names who it is addressed to and has never meant hidden.'),
        P('It is priced exactly like the acts above it, and it ', B('weighs home'), ' for the same reason a reaction does: it debits θ, raises N — so your own rate, and the standing riding on it, fall — and its coefficient lands on your own diagonal, crowding the influence you route outward, which the people you vouch for feel. Measured on a two-account log, one message cost the sender 33% of their standing and the person they had vouched for 15%. What a message does NOT do is carry anything to the person you wrote to: no vouch is compiled, nothing enters their score from it, and it enters no feed ranking and no ', K('PEER'), ' weight. The reassurance is about direction, not about magnitude.')),""",
    'the guide: a message is priced, and weighs home',
)

t.once(
    r"""      h('p', { class: 'smallnote' },
        'It costs ', term('theta', 'θ'), ' ' + fmt(THETA, 4) + ' like every other act, and it enters no score: messaging somebody moves neither your ',
        term('standing'), ' nor theirs. Vouching is the act that does.')));
""",
    r"""      // This card sits beside the box somebody is about to type into, which
      // makes it the most load-bearing sentence in the rail — and it used to
      // say "it enters no score: messaging somebody moves neither your
      // standing nor theirs". The dm branch in replay.cjs is
      // `debit(a.from); weighHome(a.from, 0.8, 0.8)`, which is two
      // standing-relevant effects rather than none, and the rail contradicted
      // itself two cards down where railWallNote prints "acting raises N, so
      // every act drags x* down". Measured: alice vouches for bob, then sends
      // bob one message — alice's standing falls 33.3%, bob's falls 15.2%.
      // Both clauses false, the second falsified by the two people it names.
      //
      // What survives is the claim about DIRECTION, which is the one people
      // actually need and the one that is true.
      h('p', { class: 'smallnote' },
        'It costs ', term('theta', 'θ'), ' ' + fmt(THETA, 4) + ' and raises your ', term('acts', 'N'),
        ' like every other act, so your own ', term('rate', 'rate'),
        ' falls — and it weighs home, landing its coefficient on your own diagonal and crowding what you route outward, which the people you vouch for feel. Sending is not free of your ',
        term('standing'), '; it is spent from it.'),
      h('p', { class: 'smallnote' },
        'What it does not do is carry anything TO the person you wrote to. No vouch is compiled by writing to somebody, nothing enters their score from it, and a message enters no feed ranking and no PEER weight. ',
        term('standing', 'Standing'), ' moves toward a person only when somebody vouches for them.')));
""",
    'the Chats rail says what a message costs, and to whom',
)


# ══════════════════════════════════════════════════════════════════════════
# FINDING 3 — three rails opened by restating the identity card
# ══════════════════════════════════════════════════════════════════════════
t.once(
    r"""    // ── the price, beside the box that charges it ──
    var afford = railAffords(me);
    var cost = h('div', { class: 'card' }, h('h2', { text: 'What saying it costs' }),
      h('div', { class: 'kv' },
        h('span', {}, term('reserve')), h('b', { class: 'num', text: fmt(me.burnBal, 3) }),
        h('span', { text: 'messages it covers' }), h('b', { class: 'num', text: String(afford) })));
    if (afford <= 0) {
""",
    r"""    // ── how close the wall is, beside the box that moves you toward it ──
    //
    // Not a ledger. idCard is in the right rail on this tab too, roughly
    // 300px away, and it already prints reserve, acts N, rate, x* and how
    // many acts the reserve covers — this card printed two of those five back
    // at the reader as its headline. What idCard does NOT carry until it is
    // nearly too late is the distance to the wall and what crossing it costs,
    // and that is the whole content here.
    var afford = railAffords(me);
    var cost = h('div', { class: 'card' }, h('h2', { text: 'Before you send' }));
    if (afford <= 0) {
""",
    'Chats: the cost card stops being a second copy of the ledger',
)

t.once(
    r"""  function econRailCards(st, me) {
    var cards = [];
    var rate = me.burnBal / Math.max(me.actCount, 1);
    var w = wallState(st, who);
    var afford = railAffords(me);

    var money = h('div', { class: 'card' }, h('h2', { text: 'Can you afford to speak?' }),
      h('div', { class: 'kv' },
        h('span', {}, term('reserve')), h('b', { class: 'num', text: fmt(me.burnBal, 3) }),
        h('span', {}, term('rate', 'rate burn/N')), h('b', { class: 'num', text: fmt(rate, 3) }),
        h('span', {}, term('affordable', 'acts it covers')), h('b', { class: 'num', text: String(afford) }),
        h('span', {}, term('x', 'x* against the wall')), h('b', { class: 'num', text: fmt(w ? w.x : 0, 3) + ' / ' + fmt(SAFE_FLOOR, 3) })));
    var wallNote = railWallNote(st);
    if (wallNote) money.appendChild(wallNote);
    money.appendChild(h('div', { class: 'mini-form persistent' },
      h('button', { class: 'btn small primary', text: 'Burn bitcoin →', onclick: function () { burnDialog(); } })));
    money.appendChild(h('p', { class: 'smallnote', text: 'Reserve is value destroyed, and destroying value is the only thing that adds to it — no balance on this tab does, and nothing on this tab can be sold for it. Everything else here is value; this is the right to speak.' }));
    cards.push(money);

    // ── the epoch token, and the wall between value and standing ──
    var tok = st.tokens || { bal: {}, supply: {} };
    var held = (tok.bal && tok.bal.PEER && tok.bal.PEER[who]) || 0;
    var supply = (tok.supply && tok.supply.PEER) || 0;
    cards.push(h('div', { class: 'card' }, h('h2', { text: 'PEER you hold' }),
      h('div', { class: 'kv' },
        h('span', { text: 'in the act log' }), h('b', { class: 'num', text: fmt(held, 2) }),
        h('span', { text: 'of everything minted' }),
        h('b', { class: 'num', text: supply > 0 ? (held / supply * 100).toFixed(2) + '%' : '—' })),
      h('p', { class: 'smallnote', text: supply > 0
        ? 'It arrives when an epoch closes and somebody has engaged with what you made — never for acting, only for being engaged with.'
        : 'Nothing has been minted yet: PEER is distributed when an epoch closes, and none has closed with engagement in it.' }),
      h('p', { class: 'smallnote' },
        'Value, never ', term('standing'), '. No balance anywhere buys a point of it, this number enters no score and no feed, and that wall is the reason the economy can exist at all.'),
      h('p', { class: 'smallnote', text: 'This is the epoch token — a number in the log this page replays. The ERC-20 called PEER on Base shares its name and nothing else: no bridge, no conversion, in either direction.' })));
""",
    r"""  function econRailCards(st, me) {
    var cards = [];

    // ── how close the wall is ──
    //
    // This card was a ledger — reserve, rate, acts it covers, x* against the
    // wall — and every one of those four is printed by idCard, in the right
    // rail, on this same screen, about 300px away, above a second copy of the
    // same Burn button. Four of four. The card kept the one thing idCard does
    // not carry until the wall banner fires, which is how far away the wall
    // is and what happens at it, and gave up the headline.
    var money = h('div', { class: 'card' }, h('h2', { text: 'How close the wall is' }));
    var wallNote = railWallNote(st);
    if (wallNote) money.appendChild(wallNote);
    money.appendChild(h('div', { class: 'mini-form persistent' },
      h('button', { class: 'btn small primary', text: 'Burn bitcoin →', onclick: function () { burnDialog(); } })));
    money.appendChild(h('p', { class: 'smallnote', text: 'Reserve is value destroyed, and destroying value is the only thing that adds to it — no balance on this tab does, and nothing on this tab can be sold for it. Everything else here is value; this is the right to speak.' }));
    cards.push(money);

    // ── the epoch token, and the wall between value and standing ──
    //
    // Lane-aware, and only because the Wallet lane already answers it in
    // full: its centre column prints 'you hold' and 'your share of everything
    // minted' in the same words and the same formatting this card used, with
    // a third copy of the balance under 'Your balances' above it. Three
    // copies of one number on one screen is not a summary. On the other five
    // lanes the centre column is about pools, the graph, the chain, Layer 0
    // or the transaction list, and none of them says what you hold — so there
    // the card is the only answer on screen and it earns its place.
    if (econView !== 'wallet') {
      var tok = st.tokens || { bal: {}, supply: {} };
      var held = (tok.bal && tok.bal.PEER && tok.bal.PEER[who]) || 0;
      var supply = (tok.supply && tok.supply.PEER) || 0;
      cards.push(h('div', { class: 'card' }, h('h2', { text: 'PEER you hold' }),
        h('div', { class: 'kv' },
          h('span', { text: 'in the act log' }), h('b', { class: 'num', text: fmt(held, 2) }),
          h('span', { text: 'of everything minted' }),
          h('b', { class: 'num', text: supply > 0 ? (held / supply * 100).toFixed(2) + '%' : '—' })),
        h('p', { class: 'smallnote', text: supply > 0
          ? 'It arrives when an epoch closes and somebody has engaged with what you made — never for acting, only for being engaged with.'
          : 'Nothing has been minted yet: PEER is distributed when an epoch closes, and none has closed with engagement in it.' }),
        h('p', { class: 'smallnote' },
          'Value, never ', term('standing'), '. No balance anywhere buys a point of it, this number enters no score and no feed, and that wall is the reason the economy can exist at all.'),
        h('p', { class: 'smallnote', text: 'The Wallet lane holds this in full, with what generated it.' })));
    }
""",
    'Economy: the money card stops restating idCard, the token card reads its lane',
)

t.once(
    r"""  function profileRailCards(st, me) {
    var cards = [];
    var myX = st.xById[who] || 0;
    var rate = me.burnBal / Math.max(me.actCount, 1);

    // ── standing, and what produced it ──
""",
    r"""  function profileRailCards(st, me) {
    var cards = [];

    // ── where the standing came from ──
    //
    // The four figures that used to head this card — standing, rate, acts N,
    // reserve — are all four on idCard, in the right rail, on this screen.
    // The backers are not on any screen anywhere, and they are the actual
    // answer to the question somebody opens their own profile with. So the
    // ledger goes and the list stays.
""",
    'Profile: the record card drops the ledger idCard already carries',
)

t.once(
    r"""    var rec = h('div', { class: 'card' }, h('h2', { text: 'Your record' }),
      h('div', { class: 'kv' },
        h('span', {}, term('standing')), h('b', { class: 'num', text: fmt(NU * myX, 4) }),
        h('span', {}, term('rate', 'rate burn/N')), h('b', { class: 'num', text: fmt(rate, 3) }),
        h('span', {}, term('acts', 'acts N')), h('b', { class: 'num', text: String(me.actCount) }),
        h('span', {}, term('reserve')), h('b', { class: 'num', text: fmt(me.burnBal, 3) })));
""",
    r"""    var rec = h('div', { class: 'card' }, h('h2', { text: 'Where your standing came from' }));
""",
    'Profile: the record card is the backers list',
)


# ══════════════════════════════════════════════════════════════════════════
# FINDING 5 — the Alerts rail asserted a relationship with a centre column
#             that changes underneath it
# ══════════════════════════════════════════════════════════════════════════
t.once(
    r"""      shape.appendChild(h('p', { class: 'smallnote', text: 'Counted over the ' + notifs.length + ' most recent inbound acts, which is exactly the list beside this — nothing older is in either.' }));
""",
    r"""      // The only card in any rail that asserts a relationship with the centre
      // column, which makes it the only one a lane switch can falsify — and
      // the record lane switches the centre to ledgerTab, the whole
      // chronicle: everybody's acts, most of them older, none of them
      // necessarily inbound. So the sentence reads its lane.
      shape.appendChild(h('p', { class: 'smallnote', text: alertView === 'record'
        ? 'Counted over the ' + notifs.length + ' most recent act' + (notifs.length === 1 ? '' : 's') + ' naming you. The chronicle beside this is a different list — everyone’s acts, in append order, whether or not they touch you. Switch to Inbound and the two match.'
        : 'Counted over the ' + notifs.length + ' most recent inbound act' + (notifs.length === 1 ? '' : 's') + ', which is exactly the list beside this — nothing older is in either.' }));
""",
    'Alerts: the shape card reads its lane before claiming what is beside it',
)


t.write()
r.write()
