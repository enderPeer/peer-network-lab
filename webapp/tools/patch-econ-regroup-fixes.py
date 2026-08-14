# Six things the Economy regrouping broke, and the reason each one broke.
#
# The regrouping itself is right and stays. What it did not do is follow
# through on what moving code does to the code around it: three cards that
# were on three lanes are now in one render pass, a class name that was safe
# while it was unstyled grew four global rules, a lane that was one card long
# became five screens with no way to move inside it, and two guide buttons now
# land on a screen that does not hold what their label promises.
#
#   1  THREE CARDS, ONE SLOT. l2Redraw is how the wallet's own events reach
#      the screen, and the comment above it said "the two are never mounted at
#      once". That was true while the token card was on 'wallet' and the pool
#      card on 'pools'. On 'money' both render in the same pass, so the second
#      one to render takes the wallet's events away from the first — and the
#      pool card re-arms the slot every 31 seconds, so it wins whatever the
#      initial race did. The file had already met this failure once and fixed
#      it with a second slot (l2ClaimRedraw, for the claim card); nobody added
#      a third when the pool card arrived. Now there are three slots and ONE
#      function that calls all of them, so a card cannot be forgotten again by
#      the next person who adds one.
#
#   2  THE WATCHER THE POOL CARD KEPT. l2Watching is a page-lifetime flag over
#      two competing registrations of the same wallet events: l2WatchWallet(),
#      which redraws every card, and the pool card's private copy, which
#      redraws one. The private copy sat at statement level inside the pools
#      lane, so it only ran when somebody opened that lane. On the merged lane
#      it runs on FIRST PAINT of the default tab, takes the flag before any
#      Connect is pressed, and l2WatchWallet is dead for the rest of the page's
#      life — which silently unwires the claim card's redraw for every user.
#      The duplicate is deleted, which is the direction the module comment
#      already recommended, and the one registration is called from render and
#      from both connect paths.
#
#   3  `.sect`, WHICH WAS ALREADY TAKEN. The new heading class was a new NAME
#      but not a new class: `sect` is used nine times outside the economy tab
#      (the events header, the music section, five blocks of the profile
#      drawer) and had no unscoped rule until this pass gave it four. Every one
#      of them grew a border, 16px of padding and flattened paragraphs. The
#      tests are green because they assert text, not computed style. Renamed to
#      `econ-sect`, which this file has never used.
#
#   4  A TAB YOU CANNOT MOVE INSIDE. Measured at 1280x720: the pool is 3,270px
#      further from the top than it was and the ledger 4,290px, across a 4,957px
#      page with three headings in it and a lane strip that scrolls away at
#      221px. Ordering by hold -> trade -> moved is right; having no way to
#      travel it is not. The strip is pinned now (top: 62px, the offset `.rail`
#      already commits to) and carries three jump buttons on the Money lane,
#      using the same scrollIntoView-after-render that jumpTo() uses for the
#      feed.
#
#   5  A TWO-SCREEN ESSAY ABOUT A SHUT DOOR, IN THE DOORWAY. peerBurnCard is
#      1,427px tall and says in its own last paragraphs that this host has no
#      price, so the door is shut and there is no button. It was 45% of the
#      distance between your balance and the pool. It is not new copy, but the
#      regrouping is what put it in the path — and it is the card that belongs
#      on the other side of that wall anyway, because it prices PEER against
#      the pool the reader has not seen yet. Moved under the pool it quotes,
#      and the one sentence that named its old neighbour is corrected.
#
#   6  TWO BUTTONS THAT LIE. 'open the pool' opens a screen with no pool on it
#      (the pool is 4,464px down). 'see certificates' is worse: epoch
#      certificates are on Alerts -> The record and have been for months, and
#      this pass re-aimed the button at Economy without checking. jump() learns
#      two things: an alerts sub-view, and a section id to scroll to.
#
# Run:  python tools/patch-econ-regroup-fixes.py && node social/assemble.mjs
import io
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')   # a label with an arrow in it is not a build failure
except Exception:
    pass

TP = 'social/template.html'
s = io.open(TP, encoding='utf-8').read()
before = len(s)


def once(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, 'anchor %r matched %d times, expected exactly 1' % (label, n)
    s = s.replace(old, new, 1)
    print('  patched: ' + label)


# ══ 3 + 4. The stylesheet ═════════════════════════════════════════════════

# The strip is pinned. 62px is not a new number: `.rail` is pinned at exactly
# that offset already, so the topbar's height is a measurement this stylesheet
# has committed to once and can be read off rather than guessed at again.
once(
    r""".lanes-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  overflow-x: visible; }
""",
    r""".lanes-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  overflow-x: visible; }

/* -- the economy's switcher, pinned, and what travels with it ---------------
   The Money lane is 4,600px at 1280x720 and 8,000px on a phone. The strip
   above it was static, so it left the screen at 221px and the only way back
   to another lane was three to six screens of scrolling. Pinned it stays a
   control instead of becoming a thing you scrolled past.

   62px is the offset `.rail` is already pinned at, i.e. the topbar's height as
   this stylesheet has already measured it; z-index 10 is under the topbar's 20
   so the two stack in the order they are drawn in. The background is opaque
   because a transparent pinned strip has the page sliding through its letters.

   The jump row rides INSIDE it rather than under it: a menu that scrolls off
   the top is a menu you have to scroll back to, which is the problem it was
   added to solve. Everything pinned here is ~114px of a 720px screen, which is
   why the row is tightened rather than left at the default mini-form size. */
.econ-stick { position: sticky; top: 62px; z-index: 10; background: var(--paper); }
.econ-jump { margin: 0 0 8px; padding: 6px 10px; gap: 8px; }
""",
    'CSS: the pinned lane strip and its jump row',
)

# `.sect` was never this pass's to take: nine elements outside the economy tab
# already carried it, deliberately unstyled, and four unscoped rules landed a
# border and 16px of padding on every one of them. Renamed rather than scoped
# — `.drawer .sect` still exists and a second meaning for one word is how this
# comes back.
once(
    r"""   that one case drops the border and keeps the name. */
.sect { margin: 26px 0 12px; padding-top: 16px; border-top: 1px solid var(--line-2); }
.sect h2 { font-family: var(--display); font-size: 13px; margin: 0 0 5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink); }
.sect p { margin: 0; }
.lanes + .sect { border-top: 0; padding-top: 0; margin-top: 4px; }
""",
    r"""   that one case drops the border and keeps the name.

   The class is `econ-sect` and NOT `sect`, which is what it was first called.
   `sect` was already live in this file nine times — the events header, the
   music section, five blocks of the profile drawer — and had no unscoped rule
   at all, which is precisely why those elements looked right: they were
   carrying a name, not a style. Four global rules under that name put a border
   and 16px of padding across all nine, and nothing failed, because the render
   tests assert text and not computed style. A name this file has never used
   cannot do that.

   scroll-margin-top keeps a jumped-to heading clear of what is pinned above
   it. Measured at 1280x720 rather than guessed: the strip sits at y=62 and is
   111px tall on the Money lane (56 of lanes, 55 of jump row), so it ends at
   173 and a heading has to come down below that. Too large only costs a gap
   above the heading; too small hides it under the very strip that sent you
   there. The other lanes have no jump row and get the gap. */
.econ-sect { margin: 26px 0 12px; padding-top: 16px; border-top: 1px solid var(--line-2);
  scroll-margin-top: 180px; }
.econ-sect h2 { font-family: var(--display); font-size: 13px; margin: 0 0 5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink); }
.econ-sect p { margin: 0; }
.econ-stick + .econ-sect { border-top: 0; padding-top: 0; margin-top: 4px; }
""",
    'CSS: .sect renamed to .econ-sect',
)


# ══ 1. Three cards that print an address, three slots, one caller ═════════

once(
    r"""  // are meaningless on any other chain; l2Redraw is the hook the on-chain
  // card installs so the wallet's own events can reach the screen; l2Watching
  // stops those event handlers stacking up one per visit to the tab. When the""",
    r"""  // are meaningless on any other chain; l2Redraw is the hook the TOKEN card
  // installs so the wallet's own events can reach the screen (the claim card
  // and the pool card have one each, below — see l2RedrawAll); l2Watching
  // stops those event handlers stacking up one per visit to the tab. When the""",
    'the l2 state comment names the right card',
)

once(
    r"""  // The claim card's own redraw hook. l2Redraw is the token card's, and the
  // two cards sit in the SAME view — one slot between them means the second
  // one to render silently takes the wallet's events away from the first.
  var l2ClaimRedraw = null;
""",
    r"""  // The claim card's own redraw hook. l2Redraw is the token card's, and the
  // two cards sit in the SAME view — one slot between them means the second
  // one to render silently takes the wallet's events away from the first.
  var l2ClaimRedraw = null;
  // And the pool card's, for exactly the same reason a third time. When the
  // Economy tab's six lanes became four, the pool card joined the token card
  // and the claim card on Money — so all THREE now render in one pass, and the
  // sentence that used to sit over l2Redraw ("the two are never mounted at
  // once") stopped being true without anybody editing it. A shared slot then
  // means the last card to render owns the wallet's events and the others keep
  // printing an address that is no longer connected; and this card re-arms
  // itself every 31 seconds through ocLoad's timer, so it wins that race
  // eventually whichever way the first pass went.
  var l2PoolRedraw = null;
""",
    'l2PoolRedraw: the pool card gets its own slot',
)

# The one caller. Anything that drops l2Wallet goes through here, so the next
# card to want a hook is added in one place rather than in four.
once(
    r"""  // The wallet is not a thing this page can hold still: a user can switch
  // network or account at any moment, including while a card sits open, and
  // an address left on screen after the wallet moved on is a lie the page is
  // telling for free. Registered once per page — l2Watching is the same flag
  // the pools card checks, so whichever of the two runs first installs the
  // one pair of handlers and the other skips.
  function l2WatchWallet() {""",
    r"""  /**
   * Every card that prints a connected address, redrawn together.
   *
   * There are three, they are all on the Money lane, and they render in one
   * pass: the token card, the claim card and the pool card. Nothing that drops
   * l2Wallet may call one slot and leave the others — the whole point of the
   * hook is that an address on screen is the address that is connected, and a
   * card that missed the news is worse than one that never showed an address
   * at all, because it looks like it checked.
   *
   * A fourth card added later needs a slot and a line here, and that is the
   * cheapest place this can be got wrong: it has already been got wrong twice.
   */
  function l2RedrawAll() {
    if (l2Redraw) l2Redraw();
    if (l2PoolRedraw) l2PoolRedraw();
    if (l2ClaimRedraw) l2ClaimRedraw();
  }
  // The wallet is not a thing this page can hold still: a user can switch
  // network or account at any moment, including while a card sits open, and
  // an address left on screen after the wallet moved on is a lie the page is
  // telling for free. Registered once per page, and this is now the ONLY
  // registration — the pool card used to keep a private copy guarded by the
  // same l2Watching flag, which meant whichever ran first decided which cards
  // would ever hear about a wallet change. On the merged lane the pool card's
  // copy ran first, on first paint, before anybody had pressed Connect.
  function l2WatchWallet() {""",
    'l2RedrawAll, and the watcher comment tells the truth',
)

once(
    r"""      if (had) toast(why);
      if (l2Redraw) l2Redraw();
      // Both cards, always. A claim row shows an address, an amount and a
      // Claim button that are only true of one account on one chain.
      if (l2ClaimRedraw) l2ClaimRedraw();
    };""",
    r"""      if (had) toast(why);
      // Every card, always. A claim row shows an address, an amount and a
      // Claim button that are only true of one account on one chain; the
      // token card shows two balances read for one account; the pool card
      // shows the account every button on it would send from.
      l2RedrawAll();
    };""",
    'forget() redraws every card',
)

# The token card's own comment asserted the invariant the merge falsified.
once(
    r"""      // The wallet's own events reach whichever card is on screen through
      // this one slot; the pools card sets it the same way when it renders,
      // and the two are never mounted at once. Only claimed if this card is
      // actually in the document — a fetch that lands after the reader has
      // moved on must not take the hook away from the card they moved to.
      if (card.isConnected) l2Redraw = function () { drawWallet(); };""",
    r"""      // This card's slot, and only this card's. It used to be shared with the
      // pool card on the strength of the two never being mounted at once,
      // which was true while they were on the Wallet and Pools lanes and false
      // from the moment both became sections of Money; the pool card has
      // l2PoolRedraw now and l2RedrawAll calls both. Only claimed if this card
      // is actually in the document — a fetch that lands after the reader has
      // moved on must not take the hook away from the card they moved to.
      if (card.isConnected) l2Redraw = function () { drawWallet(); };""",
    'the token card stops claiming a shared slot',
)


# ══ 2. The pool card's duplicate watcher is deleted ═══════════════════════

once(
    r"""      // The wallet is not a thing this page can hold still. A user can switch
      // network or account in MetaMask at any moment, including while this
      // card sits open, and a chain verified at connect time says nothing
      // about the chain a minute later. So the wallet's own event channel is
      // the authority: on either change everything learned under the old
      // connection is dropped — the address, and the token addresses read off
      // a pool that only exists on Base — and the row redraws to what is
      // true now. Registered once per page rather than once per render, or a
      // second visit to this tab would install a second handler.
      if (window.ethereum && window.ethereum.on && !l2Watching) {
        l2Watching = true;
        var ocForget = function (why) {
          var had = l2Wallet;
          l2Wallet = null;
          l2Tokens = null;
          if (had) toast(why);
          if (l2Redraw) l2Redraw();
        };
        window.ethereum.on('chainChanged', function () { ocForget('The wallet changed network. Nothing here reads or signs until it is back on the chain this host serves and connected again.'); });
        window.ethereum.on('accountsChanged', function () { ocForget('The wallet switched accounts. Connect again \u2014 the address shown here is only ever the one that connected.'); });
      }
""",
    r"""      // The wallet is not a thing this page can hold still. A user can switch
      // network or account in MetaMask at any moment, including while this
      // card sits open, and a chain verified at connect time says nothing
      // about the chain a minute later. So the wallet's own event channel is
      // the authority: on either change everything learned under the old
      // connection is dropped — the address, and the token addresses read off
      // a pool that only exists on Base — and every card that was printing it
      // redraws to what is true now.
      //
      // This card used to register that itself, with its own forget() and the
      // same l2Watching flag l2WatchWallet uses. Two registrations behind one
      // flag is a coin toss over which cards ever hear about a wallet change,
      // and on the merged Money lane the toss was rigged: this block sits at
      // statement level, so it ran on the first paint of the DEFAULT tab,
      // before anybody pressed Connect, and l2WatchWallet was dead for the
      // rest of the page's life — which left the claim card's hook wired to
      // nothing for every reader. One registration now, and it redraws all
      // three cards. Idempotent, so calling it from every render is free.
      l2WatchWallet();
""",
    'the pool card stops registering its own wallet handlers',
)

# ocConnect is the most prominent Connect button on the merged lane and it
# never went near l2WatchWallet. Harmless where the render call above already
# ran; the case it covers is a wallet injected into the page after the render.
once(
    r"""      async function ocConnect() {
        if (!window.ethereum) return null;
        var accs = await ocEth('eth_requestAccounts');""",
    r"""      async function ocConnect() {
        if (!window.ethereum) return null;
        // The one registration, again: this is a no-op where the render call
        // above already made it, and the case it is here for is a wallet
        // injected into the page after this card was drawn — there was no
        // window.ethereum to attach to then, and this is the first moment
        // there certainly is one.
        l2WatchWallet();
        var accs = await ocEth('eth_requestAccounts');""",
    'ocConnect registers the wallet watcher too',
)

# Both of these drop l2Wallet for every card, so both must redraw every card.
once(
    r"""        if (chain !== OC_CHAIN) {
          l2Wallet = null;
          l2Tokens = null;
          if (l2Redraw) l2Redraw();
          leg.state = 'rejected';""",
    r"""        if (chain !== OC_CHAIN) {
          l2Wallet = null;
          l2Tokens = null;
          l2RedrawAll();
          leg.state = 'rejected';""",
    'ocSend: a wrong chain clears every card',
)

once(
    r"""                if (chain !== OC_CHAIN) {
                  l2Wallet = null;
                  l2Tokens = null;
                  if (l2Redraw) l2Redraw();
                  cSay('That wallet answers for chain '""",
    r"""                if (chain !== OC_CHAIN) {
                  l2Wallet = null;
                  l2Tokens = null;
                  l2RedrawAll();
                  cSay('That wallet answers for chain '""",
    'the first-add sequence: a wrong chain clears every card',
)

once(
    r"""        // The wallet's own events reach the screen through here. Assigned on
        // every render so the handler always drives the card that is actually
        // on screen, and never the one three renders ago.
        l2Redraw = function () { drawWallet(); drawPools(); };""",
    r"""        // This card's own slot — l2Redraw belongs to the token card, which is
        // now two sections above this one in the same column rather than on a
        // lane of its own. Assigned on every render so the handler always
        // drives the card that is actually on screen, and never the one three
        // renders ago.
        l2PoolRedraw = function () { drawWallet(); drawPools(); };""",
    'the pool card writes to its own slot',
)

# The module comment offered this deletion as advice; half of it is taken now.
once(
    r"""  // Money lane (they were the Pools and Wallet lanes). The pool card grew its
  // own copies (ocConnect, ocEth, ocWord…)
  // inside its own block, back when there was only one caller; both sets write
  // THIS l2Wallet, so a wallet connected in either card is connected in both.
  // The copies down there should be deleted in favour of these rather than
  // kept in step by hand.""",
    r"""  // Money lane (they were the Pools and Wallet lanes). The pool card grew its
  // own copies (ocConnect, ocEth, ocWord…)
  // inside its own block, back when there was only one caller; both sets write
  // THIS l2Wallet, so a wallet connected in either card is connected in both.
  // The copies down there should be deleted in favour of these rather than
  // kept in step by hand — the one that mattered most already has been. The
  // pool card kept a private copy of the WALLET WATCHER as well, guarded by
  // the same l2Watching flag, and on the merged lane it won that flag on first
  // paint and left the claim card's redraw hook wired to nothing. There is one
  // registration now (l2WatchWallet) and one redraw (l2RedrawAll).""",
    'the module comment records which copy went',
)


# ══ 3 + 4. econHead grows an id, and the strip becomes a place to steer ═══

once(
    r"""     * skimmed in three jumps instead of read in one long fall. `.sect` draws
     * a rule and a name and no box - it is the gap between cards, named,
     * rather than another card.
     */
    function econHead(title, note) {
      return h('div', { class: 'sect' },
        h('h2', { text: title }),
        h('p', { class: 'smallnote', text: note }));
    }
""",
    r"""     * skimmed in three jumps instead of read in one long fall. `.econ-sect`
     * draws a rule and a name and no box - it is the gap between cards, named,
     * rather than another card.
     *
     * The id is what makes the skimming possible rather than merely desirable:
     * a heading is a landmark you can see and not a place you can go, and this
     * lane is 4,600px at 1280x720. The jump row under the strip and the
     * guide's 'open the pool' button both scroll to these ids.
     */
    function econHead(id, title, note) {
      return h('div', { class: 'econ-sect', id: id },
        h('h2', { text: title }),
        h('p', { class: 'smallnote', text: note }));
    }
    /**
     * Scroll to one of them. Same shape as jumpTo()'s scroll for the feed;
     * `.econ-sect` carries a scroll-margin-top so the heading does not land
     * underneath the pinned strip that sent you to it. Guarded on the method
     * existing because jsdom has no layout and no scrollIntoView, and a render
     * test pressing this button must not become the thing that breaks.
     */
    function econJump(id) {
      var el = document.getElementById(id);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
""",
    'econHead takes an id, and econJump goes to one',
)

once(
    r"""    var bar = h('div', { class: 'lanes lanes-wrap' });
    views.forEach(function (v) {
      var b = h('button', { class: 'lane' + (econView === v[0] ? ' on' : '') }, h('b', { text: v[1] }));
      b.onclick = function () { econView = v[0]; saveView(); render(); };
      bar.appendChild(b);
    });
    wrap.appendChild(bar);
""",
    r"""    // The strip is pinned (`.econ-stick`), and the jump row rides with it.
    //
    // Four lanes fit one row, which was the point of the regrouping - but the
    // Money lane behind them is 4,600px at 1280x720 and 8,000px on a phone,
    // and a switcher that leaves the screen at 221px is not a switcher, it is
    // a thing you scrolled past. Pinning it costs ~56px of every screen on
    // this tab and buys back three to six screens of scrolling every time
    // somebody wants another lane.
    //
    // The three buttons under it are the same journey INSIDE the lane, and
    // they are only drawn there: the other three lanes are one subject each
    // and a menu of one entry is furniture. They name the three headings in
    // the reader's words rather than in the section titles' capitals, because
    // a control and a heading that say exactly the same thing read as the same
    // object and one of them is not clickable.
    var stick = h('div', { class: 'econ-stick' });
    var bar = h('div', { class: 'lanes lanes-wrap' });
    views.forEach(function (v) {
      var b = h('button', { class: 'lane' + (econView === v[0] ? ' on' : '') }, h('b', { text: v[1] }));
      b.onclick = function () { econView = v[0]; saveView(); render(); };
      bar.appendChild(b);
    });
    stick.appendChild(bar);
    if (econView === 'money') {
      var jumps = h('div', { class: 'mini-form persistent econ-jump' });
      [['econ-hold', 'what you hold'], ['econ-trades', 'where it trades'], ['econ-moved', 'what moved']]
        .forEach(function (j) {
          jumps.appendChild(h('button', { class: 'btn small ghost', text: j[1],
            onclick: function () { econJump(j[0]); } }));
        });
      stick.appendChild(jumps);
    }
    wrap.appendChild(stick);
""",
    'the pinned strip, and the Money lane jump row',
)


# ══ 5. The second door moves under the pool it quotes ═════════════════════

once(
    r"""      wrap.appendChild(econHead('What you hold',
        'Your balances, what generated them, and the two doors into reserve. Everything in this section is value: none of it is standing, and no amount of it buys a point of standing.'));""",
    r"""      wrap.appendChild(econHead('econ-hold', 'What you hold',
        'Your balances, what generated them, and both tokens that answer to the name PEER — the epoch token this log mints, and the ERC-20 on Base a wallet can hold. Everything in this section is value: none of it is standing, and no amount of it buys a point of standing.'));""",
    'What you hold: id, and a note that matches what is under it',
)

once(
    r"""      // The second door into reserve, under BOTH of them, because it needs
      // both to have been read first: it prices the coin on Base (the card
      // above) and it must not be taken for the epoch token (the card above
      // that). Last rather than between them, so the token card's sentence
      // about 'the card below this one' still names the claim card.
      wrap.appendChild(peerBurnCard(st));

    }
""",
    r"""      // (the second door into reserve used to end this section. It is under
      //  the pool now - see 'Where it trades'. It is 1,427px tall, it says in
      //  its own last paragraphs that this host has no price so the door is
      //  shut, and it stood between a reader's balance and the pool they came
      //  to trade on: 45% of that distance, for a card about something they
      //  cannot do. It also quotes the pool, which they had not seen yet.)
    }
""",
    'the second door leaves the balances section',
)

once(
    r"""      wrap.appendChild(econHead('Where it trades',
        'One pool on Base, which settles in real money, and the sandbox pools under it, which settle in this log and nowhere else.'));""",
    r"""      wrap.appendChild(econHead('econ-trades', 'Where it trades',
        'One pool on Base, which settles in real money, and the sandbox pools under it, which settle in this log and nowhere else. The second door into reserve is here too, under the pool whose price is what it pays out against.'));""",
    'Where it trades: id, and the door is announced',
)

once(
    r"""      // Two pools over one pair are two pools. Directly under the card whose
      // prices could otherwise be read as the market's.
      wrap.appendChild(dexCard());
""",
    r"""      // Two pools over one pair are two pools. Directly under the card whose
      // prices could otherwise be read as the market's.
      wrap.appendChild(dexCard());
      // The second door into reserve, under the pool it is priced by. It was
      // the last card of 'What you hold', where it was two screens of essay
      // between a balance and the pool - and where it quoted a price from a
      // card the reader had not reached. Here the thing it asks about is
      // directly above it. Both sandbox-pool cards follow, which keeps the
      // ocCard sentence about 'the sandbox pools below' true.
      wrap.appendChild(peerBurnCard(st));
""",
    'the second door lands under the pool',
)

# One sentence in that card named the card above it, and the card above it
# changed. Nothing else in it points at a neighbour.
once(
    r"""    card.appendChild(h('p', { class: 'smallnote', text: 'The PEER destroyed here is the ERC-20 on Base — the coin in the card above, the one a wallet can hold. It is not the epoch token counted further up this tab, and this door does not join them:""",
    r"""    card.appendChild(h('p', { class: 'smallnote', text: 'The PEER destroyed here is the ERC-20 on Base — the coin the pool above trades, the one a wallet can hold. It is not the epoch token counted further up this tab, and this door does not join them:""",
    'the second door names the card that is actually above it',
)

# burnDialog's own way in pointed at the lane and not at the card, which was
# survivable while the card was on a short lane. It is 4,600px now.
once(
    r"""    second.appendChild(h('button', { class: 'btn small ghost', text: 'the PEER door →', onclick: function () {
      box.remove();
      tab = 'econ'; econView = 'money'; saveView(); render();
    } }));""",
    r"""    second.appendChild(h('button', { class: 'btn small ghost', text: 'the PEER door →', onclick: function () {
      box.remove();
      tab = 'econ'; econView = 'money'; saveView(); render();
      // The lane is several screens; the card is in its middle section. A
      // button named after one card that opens a screen showing another is
      // the same failure as the guide's two broken jumps.
      setTimeout(function () {
        var el = document.getElementById('econ-trades');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 40);
    } }));""",
    'burnDialog lands on the door rather than on the lane',
)


# ══ the remaining econHead call sites ═════════════════════════════════════

once(
    r"""      wrap.appendChild(econHead('What moved',""",
    r"""      wrap.appendChild(econHead('econ-moved', 'What moved',""",
    'What moved: id',
)

once(
    r"""      wrap.appendChild(econHead('Under the log',""",
    r"""      wrap.appendChild(econHead('econ-chain', 'Under the log',""",
    'Under the log: id',
)

once(
    r"""      wrap.appendChild(econHead('Layer 0, and where reserve came from',""",
    r"""      wrap.appendChild(econHead('econ-layer0', 'Layer 0, and where reserve came from',""",
    'Layer 0: id',
)


# ══ 6. Two guide buttons that land where their label says ═════════════════

once(
    r"""    function jump(label, to) {
      var parts = String(to).split('/');
      var toTab = parts[0], sub = parts[1] || null;
      return h('button', { class: 'btn small ghost jump', text: label + ' →', onclick: function () {
        if (GEEK_TABS.indexOf(toTab) < 0) { toast('That screen has moved — nothing here goes to “' + toTab + '” any more.'); return; }
        tab = toTab;
        // Through the same map a stored view goes through, so a link written
        // against the old six ('econ/pools', 'econ/ledger') lands where that
        // content lives now instead of on a lane that does not exist.
        if (sub) econView = econViewFrom(sub);
        saveView(); render();
      } });
    }""",
    r"""    function jump(label, to) {
      var parts = String(to).split('/');
      var toTab = parts[0], sub = parts[1] || null, sect = parts[2] || null;
      return h('button', { class: 'btn small ghost jump', text: label + ' →', onclick: function () {
        if (GEEK_TABS.indexOf(toTab) < 0) { toast('That screen has moved — nothing here goes to “' + toTab + '” any more.'); return; }
        tab = toTab;
        // Economy's sub-view goes through the same map a stored view goes
        // through, so a link written against the old six ('econ/pools',
        // 'econ/ledger') lands where that content lives now instead of on a
        // lane that does not exist. Alerts has sub-views too, and until now
        // this helper could not name one — which is why the button for epoch
        // certificates pointed at Economy, where certificates have not been
        // drawn for months.
        if (sub) {
          if (toTab === 'econ') econView = econViewFrom(sub);
          else if (toTab === 'alerts') alertView = sub === 'record' ? 'record' : 'inbound';
        }
        saveView(); render();
        // And the third part is a section INSIDE the destination. Opening the
        // right lane is not the same as showing the thing: the Money lane is
        // 4,600px and 'open the pool →' was landing 4,400px above the pool.
        // Same scrollIntoView-after-render jumpTo() uses for the feed.
        if (sect) setTimeout(function () {
          var el = document.getElementById(sect);
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }, 40);
      } });
    }""",
    'jump(): an alerts sub-view, and a section to land on',
)

once(
    r""" long-standing identities route more weight. ', jump('see certificates', 'econ/money')),""",
    r""" long-standing identities route more weight. ', jump('see certificates', 'alerts/record')),""",
    "the certificates button points at Alerts -> The record",
)

once(
    r"""        P('Both doors stay open, and neither replaces the other. ', jump('open the pool', 'econ/money'))),""",
    r"""        P('Both doors stay open, and neither replaces the other. ', jump('open the pool', 'econ/money/econ-trades'))),""",
    'the pool button lands on the pool',
)

# Two sentences still send readers to a screen that stopped existing when the
# Record became an Alerts sub-view. Not this pass's doing; it is what the
# button above was quietly agreeing with.
once(
    r"""      more: 'Closing also checks the wall and the door, advances self-edge tenure, and writes a certificate into Economy → Record. Anyone replaying the log computes the same certificate.',""",
    r"""      more: 'Closing also checks the wall and the door, advances self-edge tenure, and writes a certificate into Alerts → The record. Anyone replaying the log computes the same certificate.',""",
    'the epoch glossary entry names the screen that exists',
)

once(
    r""" and the door (act-weighted mean ≥ ' + PART_FLOOR + '), and records a certificate in Economy → Record.'),""",
    r""" and the door (act-weighted mean ≥ ' + PART_FLOOR + '), and records a certificate in Alerts → The record.'),""",
    'the guide names the screen that exists',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
