# The Economy tab goes from six sub-tabs to four.
#
# The six were: Wallet, Network, Pools & ads, Epoch chain, Layer 0,
# Transactions. Three of them were one subject asked at three distances —
# what you hold, where it trades, what moved — so checking a balance meant
# opening one lane, trading meant another, and the history a third. Two of
# them were two names for the same machinery under the log. And Ads was not a
# lane at all: it was the last card of the pools lane, which is the last place
# somebody meaning to buy a placement would look.
#
#   MONEY      wallet + the pool + the transaction list, in that order
#   NETWORK    unchanged
#   ADS        the placement card, moved out intact
#   MACHINERY  the epoch chain + Layer 0
#
# This is a REGROUPING. Every card that existed still exists, still says the
# same thing and still works; nothing was reimplemented. Two branches merged,
# one block was split off at a boundary it already had, and the transaction
# list moved up to the end of the money lane so the source reads in the order
# the screen does. The only copy that changed is copy the move made false —
# five sentences that named a lane by a name it no longer has.
#
# The migration is the part nobody sees until it breaks: econView is persisted
# under 'peer-sandbox-view-v1', so every browser that has opened this app has
# one of the OLD six saved. ECON_WAS maps each to the lane that swallowed its
# content, and anything unrecognised falls to the first lane rather than to a
# blank screen. jump() (the guide's buttons) goes through the same map, so a
# link written against 'econ/pools' still lands somewhere true.
#
# Run:  python tools/patch-econ-regroup.py && node social/assemble.mjs
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


# ── 1. The four names, the migration map, and the reader for it ───────────
once(
    r"""  var GEEK_TABS = ['feed', 'chat', 'alerts', 'econ', 'profile'];
  var econView = 'wallet';   // + 'net'  — the graph lives here now
""",
    r"""  var GEEK_TABS = ['feed', 'chat', 'alerts', 'econ', 'profile'];
  // ── The Economy tab's four lanes, and where the old six went ────────────
  //
  //   money      what you hold, where it trades, what moved
  //   net        the graph — a way of LOOKING at the economy
  //   ads        the only thing in this network that is for sale
  //   machinery  the epoch chain, and Layer 0 underneath it
  //
  // ECON_WAS is the migration, and it is a MAP rather than a filter on
  // purpose. 'wallet', 'pools', 'ledger', 'chain' and 'layer0' were real
  // lanes for months and are sitting in the localStorage of every browser
  // that has ever opened this app; a filter would drop them all to the
  // default, and a saved value from a version that no longer exists is
  // exactly the bug that looks like "the app is broken" and reproduces for
  // nobody else. Each old name lands on the lane that swallowed its content.
  // Anything unrecognised — a hand-edited key, a link from a build that does
  // not exist yet — lands on the first lane rather than on a blank tab.
  var ECON_VIEWS = ['money', 'net', 'ads', 'machinery'];
  var ECON_WAS = {
    wallet: 'money',      // balances, the epoch token, the claim, both burn doors
    pools: 'money',       // the pool on Base and the sandbox pools under it
    ledger: 'money',      // the transaction list, now that lane's last section
    chain: 'machinery',   // the epoch chain
    layer0: 'machinery',  // the reserve receipt underneath it
    net: 'net',           // unchanged — named here so the map is complete
  };
  /**
   * A stored or linked econView name, translated into one that exists.
   *
   * hasOwnProperty rather than a plain lookup: 'constructor' and 'toString'
   * are strings a URL or a corrupted key can carry, and both would otherwise
   * come back as a function and be assigned to econView.
   */
  function econViewFrom(v) {
    var k = String(v || '');
    if (ECON_VIEWS.indexOf(k) >= 0) return k;
    if (Object.prototype.hasOwnProperty.call(ECON_WAS, k)) return ECON_WAS[k];
    return ECON_VIEWS[0];
  }
  var econView = 'money';
""",
    'ECON_VIEWS, ECON_WAS, econViewFrom',
)


# ── 2. The restore maps instead of filtering ──────────────────────────────
once(
    r"""      if (['wallet', 'net', 'pools', 'chain', 'layer0', 'ledger'].indexOf(v0.econView) >= 0) econView = v0.econView;
""",
    r"""      // Mapped, never dropped: a browser that was last standing on 'pools'
      // or 'ledger' opens on Money, one that was on 'chain' or 'layer0'
      // opens on Machinery, and anything else opens on the first lane. The
      // table is ECON_WAS, up beside the tab list.
      if (typeof v0.econView === 'string' && v0.econView) econView = econViewFrom(v0.econView);
""",
    'the restored econView goes through the map',
)


# ── 3. The stylesheet: the wrap stops being load-bearing, and headings ────
once(
    r"""   Add beside `lanes` when the strip carries more lanes than a narrow column
   can hold. The Economy switcher needed 688px inside a 600px column at
   1280x720 and 652px inside 355px on a phone, which put its last tab off the
   edge behind a scrollbar that is deliberately invisible.
""",
    r"""   Add beside `lanes` when the strip carries more lanes than a narrow column
   can hold. The Economy switcher needed 688px inside a 600px column at
   1280x720 and 652px inside 355px on a phone, which put its last tab off the
   edge behind a scrollbar that is deliberately invisible.

   That strip carries FOUR lanes now - Money, Network, Ads, Machinery - and
   four fit one row in the centre column at 1280 and above. So nothing here is
   load-bearing today, and it stays anyway: this rule is what makes a FIFTH
   lane safe to add. Without it a fifth would not appear cramped, it would
   disappear, which is how three of the six were lost the first time.
""",
    'stylesheet: four lanes fit, the wrap is insurance',
)

once(
    r"""   The 120px floor is measured, not picked: the widest label in the strip is
   'Transactions' at 119.2px with this font, padding and letter-spacing, so
   120px is that rounded up. It holds at the tightest packing there is - the""",
    r"""   The 120px floor is measured, not picked: it is the widest label this strip
   has ever carried - 'Transactions' at 119.2px with this font, padding and
   letter-spacing - rounded up. The widest of the four now is 'Machinery',
   comfortably inside it, and the floor deliberately stays at the larger
   number: it is a floor for whatever a later lane gets called, not a
   measurement of the current set. It holds at the tightest packing there is - the""",
    'stylesheet: the 120px floor, and why it stays',
)

once(
    r""".lanes-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  overflow-x: visible; }
""",
    r""".lanes-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  overflow-x: visible; }

/* -- a heading BETWEEN cards, for a lane that holds more than one subject --
   The Money lane is three subjects in one column and about fifteen hundred
   lines of render. A wall of concatenated cards would be a worse tab than the
   three it replaced, so each subject gets a rule, a name and one line saying
   what the cards under it are for.

   Deliberately not a card: no background, no border box, so it cannot be read
   as one more panel in the stack - it is the gap between panels, named. The
   lane strip is always the first thing on a tab, and a rule immediately under
   the button you just pressed reads as a mistake rather than as a divider, so
   that one case drops the border and keeps the name. */
.sect { margin: 26px 0 12px; padding-top: 16px; border-top: 1px solid var(--line-2); }
.sect h2 { font-family: var(--display); font-size: 13px; margin: 0 0 5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink); }
.sect p { margin: 0; }
.lanes + .sect { border-top: 0; padding-top: 0; margin-top: 4px; }
""",
    'stylesheet: .sect, the between-cards heading',
)


# ── 4. The four lanes, and why each is called what it is ──────────────────
once(
    r"""    // The economy screen had grown into one long scroll holding four
    // unrelated jobs: what you hold, what the pools are doing, the Layer-0
    // receipt system, and the history. Splitting them means the wallet is
    // reachable without scrolling past a ledger of raw addresses.
    // Six of them do not fit one row, and until this strip wrapped they did
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
""",
    r"""    // Six lanes said six subjects and three of them were one: what you hold,
    // where it trades and what moved are the same question asked at three
    // distances, and answering it cost three lanes, three scrolls and a guess
    // about which one held the answer. Two more were two names for the same
    // machinery under the log. Ads was not a lane at all - it was the last
    // card of the pools lane, which is the last place a person meaning to buy
    // one would look for it.
    //
    // The names are chosen for a reader who never saw the six.
    //
    //   MONEY, not 'Wallet'. The lane holds what you hold, the pool where it
    //   trades and the list of what moved, so 'Wallet' would name the first
    //   third and hide the other two - and nobody who came to trade, or to
    //   check a transaction, would open a tab called Wallet to do it. FIRST,
    //   because it is the lane this screen is opened for.
    //
    //   NETWORK, unchanged. The graph is a way of looking at the economy, its
    //   name was never the problem, and it is a different subject from the
    //   other three rather than a part of any of them.
    //
    //   ADS, as itself. 'Advertising' is the same word with three more
    //   syllables and 'Placements' names the act rather than the thing a
    //   reader wants, which is a box in the feed.
    //
    //   MACHINERY, not 'Layer 0 & epoch chain'. Those are two names for one
    //   subject - what is underneath the log - and a slash-joined pair makes
    //   a reader learn both names before they can decide whether the tab is
    //   for them. LAST, because it is the one fewest people need.
    //
    // Four lanes are 4 x 120px of grid at most, which the 600px centre column
    // at 1280 holds in one row with room to spare. `.lanes-wrap` stays - see
    // its comment in the stylesheet - but it is now insurance for a fifth
    // lane rather than the thing keeping the fourth on screen.
    var views = [['money', 'Money'], ['net', 'Network'], ['ads', 'Ads'], ['machinery', 'Machinery']];
""",
    'the four lanes',
)


# ── 5. The heading helper the merged lanes are built out of ──────────────
once(
    r"""    var bar = h('div', { class: 'lanes lanes-wrap' });
""",
    r"""    /**
     * A heading between cards, for a lane that holds more than one subject.
     *
     * Somebody arriving to check a balance must not have to scroll past the
     * whole pool card to find it, and somebody arriving to trade must not
     * have to hunt: these are what make that possible, so the tab can be
     * skimmed in three jumps instead of read in one long fall. `.sect` draws
     * a rule and a name and no box - it is the gap between cards, named,
     * rather than another card.
     */
    function econHead(title, note) {
      return h('div', { class: 'sect' },
        h('h2', { text: title }),
        h('p', { class: 'smallnote', text: note }));
    }

    var bar = h('div', { class: 'lanes lanes-wrap' });
""",
    'econHead',
)


# ── 6. MONEY, 1 of 3 — the two wallet branches become one, with a heading ─
once(
    r"""    if (econView === 'wallet') {
      wrap.appendChild(walletView(st));
    }

    if (econView === 'wallet') {
      var tCard = h('div', { class: 'card', style: 'margin-top:14px' },
""",
    r"""    // ── MONEY, 1 of 3: what you hold ───────────────────────────────────
    // First because it is the question this screen is opened with. The two
    // 'wallet' branches this replaces were adjacent and identical; they are
    // one block now, in the order they always rendered in - balances, the
    // epoch token, the ERC-20 that shares its name, the claim that pays one
    // against a list of the other, and the second door into reserve. Not one
    // line of them was rewritten.
    if (econView === 'money') {
      wrap.appendChild(econHead('What you hold',
        'Your balances, what generated them, and the two doors into reserve. Everything in this section is value: none of it is standing, and no amount of it buys a point of standing.'));
      wrap.appendChild(walletView(st));
      var tCard = h('div', { class: 'card', style: 'margin-top:14px' },
""",
    'MONEY 1 of 3: the merged wallet block',
)


# ── 7. MONEY, 2 of 3 — the pools branch, with a heading ──────────────────
once(
    r"""    if (econView === 'pools') {
""",
    r"""    // ── MONEY, 2 of 3: where it trades ─────────────────────────────────
    // The old Pools lane, unchanged, minus the advert card that used to sit
    // at the bottom of it (its own tab now) and plus a heading.
    if (econView === 'money') {
      wrap.appendChild(econHead('Where it trades',
        'One pool on Base, which settles in real money, and the sandbox pools under it, which settle in this log and nowhere else.'));
""",
    'MONEY 2 of 3: the pool block',
)


# ── 8. MONEY, 3 of 3 — the transaction list, and the ads tab split off ───
#
# The split point is a boundary the file already had: the advert block begins
# at its own comment and runs to the end of the branch, and it reads nothing
# the pool cards above it declared — which is what made the move a matter of
# where the braces go rather than a matter of moving 120 lines of code.
once(
    r"""            tryAct(who, { t: 'assetCreate', author: who, sym: (faSym.value || '').trim().toUpperCase(), name: (faName.value || '').trim(), supply: sup }, 'Minted. Now give it a pool, or it stays a number on your own screen.');
          } }))));
""",
    r"""            tryAct(who, { t: 'assetCreate', author: who, sym: (faSym.value || '').trim().toUpperCase(), name: (faName.value || '').trim(), supply: sup }, 'Minted. Now give it a pool, or it stays a number on your own screen.');
          } }))));

      // ── MONEY, 3 of 3: what moved ────────────────────────────────────
      // Last, because it is the question you ask after you know what you
      // hold and what it is worth. valueLedger reads the act log rather than
      // a stored list, so this section cannot drift from the two above it.
      wrap.appendChild(econHead('What moved',
        'Every value movement in this log, newest first: the mints an epoch pays out, and every act somebody spent θ on to move something.'));
      wrap.appendChild(valueLedger(st));
    }

    // ── ADS ──────────────────────────────────────────────────────────────
    // A tab of its own, because a card at the bottom of the pools lane is
    // not a place anybody looks for the one thing here that is for sale.
    //
    // The block below is the old one, moved intact at a boundary it already
    // had: it declares everything it uses and reads nothing from the pool
    // cards it used to follow. What DID depend on its old neighbours is the
    // copy - two sentences pointed at 'the Wallet tab' and at 'the sandbox
    // pools further down this page', and both now name the Money tab, which
    // is where those things actually are.
    if (econView === 'ads') {
""",
    'MONEY 3 of 3 + the ads branch opens',
)


# ── 9. The advert copy that pointed at its old neighbours ────────────────
once(
    r"""the number counted in the Wallet tab, earned by drawing engagement or bought in one of the sandbox pools further down this page, which settle in this log and nowhere else.""",
    r"""the number counted on the Money tab, earned by drawing engagement or bought in one of the sandbox pools there, which settle in this log and nowhere else.""",
    'ads: where epoch PEER comes from now names the Money tab',
)

once(
    r"""'Not the PEER on Base. The ERC-20 in the Wallet tab shares this name""",
    r"""'Not the PEER on Base. The ERC-20 on the Money tab shares this name""",
    'ads: the ERC-20 sentence names the Money tab',
)

# The two claims this card exists to make - it cannot be bought with the coin
# on Base, and it buys no standing - were printed beside the pool cards that
# make them concrete. Alone on a tab they are the entire context a buyer gets,
# so the second one gets the same mark the first one has rather than reading
# as one more grey line.
once(
    r"""      adCard2.appendChild(h('p', { class: 'smallnote', text:
        'What it buys: the box, and only the box.""",
    r"""      adCard2.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text:
        'What it buys: the box, and only the box.""",
    'ads: an advert holds no standing, marked as prominently as the other claim',
)


# ── 10. MACHINERY — the chain and Layer 0, and what they are to each other ─
once(
    r"""      wrap.appendChild(adCard2);

    }

    if (econView === 'chain') {
      wrap.appendChild(epochChainView());
    }

    if (econView === 'layer0') {
      wrap.appendChild(h('div', { class: 'card' },
        h('h2', { text: 'Layer 0 — the reserve receipt' }),
""",
    r"""      wrap.appendChild(adCard2);

    }

    // ── MACHINERY ────────────────────────────────────────────────────────
    // Two lanes that were two names for one subject. A reader now meets them
    // together, so the relation between them is stated once at the top -
    // without it this tab is a chain viewer with an unexplained ledger of
    // addresses underneath. Both blocks are unchanged below the headings.
    if (econView === 'machinery') {
      wrap.appendChild(econHead('Under the log',
        'The epoch chain is what becomes of the record: every closed epoch sealed into one signed block, each carrying the id of the one before it. Layer 0 is the other end of the same machine — where the reserve those acts were debited from comes from, value destroyed and recorded as an attestation Layer 1 reads. One prices acting; the other publishes what acting produced. Neither of them settles anything: replay does.'));
      wrap.appendChild(epochChainView());

      wrap.appendChild(econHead('Layer 0, and where reserve came from',
        'The receipt system underneath the network. Its controls are gone — the acts they submitted are refused now — and the arithmetic stays because the acts already in the record still replay.'));
      wrap.appendChild(h('div', { class: 'card' },
        h('h2', { text: 'Layer 0 — the reserve receipt' }),
""",
    'MACHINERY: the epoch chain and Layer 0 in one lane',
)


# ── 11. The transaction list is no longer a branch of its own ────────────
once(
    r"""    if (econView === 'ledger') {
      wrap.appendChild(valueLedger(st));
    }

    return wrap;
""",
    r"""    // (the transaction list is the third section of the Money lane, drawn up
    //  there beside the balances and the pool it is the history of)
    return wrap;
""",
    'the ledger branch is gone, having moved into Money',
)


# ── 12. The guide's buttons go through the same map ──────────────────────
once(
    r"""        tab = toTab;
        if (sub) econView = sub;
""",
    r"""        tab = toTab;
        // Through the same map a stored view goes through, so a link written
        // against the old six ('econ/pools', 'econ/ledger') lands where that
        // content lives now instead of on a lane that does not exist.
        if (sub) econView = econViewFrom(sub);
""",
    'jump() maps its sub-view',
)

once(r"""jump('see certificates', 'econ/ledger')""",
     r"""jump('see certificates', 'econ/money')""",
     'guide: certificates -> the money lane')

once(r"""jump('open the epoch chain', 'econ/chain')""",
     r"""jump('open the epoch chain', 'econ/machinery')""",
     'guide: the epoch chain -> machinery')

once(r"""jump('open the wallet', 'econ/wallet')""",
     r"""jump('open the money tab', 'econ/money')""",
     'guide: the wallet -> the money lane')

once(r"""jump('open pools', 'econ/pools')""",
     r"""jump('open the pool', 'econ/money')""",
     'guide: pools -> the money lane')

once(
    r"""a single pool contract at a single address, which is what every button in Pools calls.""",
    r"""a single pool contract at a single address, which is what every button on the pool card calls.""",
    'guide: no lane is called Pools any more',
)


# ── 13. The rail follows ─────────────────────────────────────────────────
once(
    r"""    // Lane-aware, and only because the Wallet lane already answers it in
    // full: its centre column prints 'you hold' and 'your share of everything
    // minted' in the same words and the same formatting this card used, with
    // a third copy of the balance under 'Your balances' above it. Three
    // copies of one number on one screen is not a summary. On the other five
    // lanes the centre column is about pools, the graph, the chain, Layer 0
    // or the transaction list, and none of them says what you hold — so there
    // the card is the only answer on screen and it earns its place.
    if (econView !== 'wallet') {
""",
    r"""    // Lane-aware, and only because the Money lane already answers it in
    // full: its 'what you hold' section prints 'you hold' and 'your share of
    // everything minted' in the same words and the same formatting this card
    // used, with a third copy of the balance under 'Your balances' above it.
    // Three copies of one number on one screen is not a summary. On the other
    // three lanes the centre column is about the graph, an advert, or the
    // machinery under the log, and none of them says what you hold — so there
    // the card is the only answer on screen and it earns its place.
    if (econView !== 'money') {
""",
    'the rail: the PEER card is suppressed on Money, drawn on the other three',
)

once(
    r"""'The Wallet lane holds this in full, with what generated it.'""",
    r"""'The Money lane holds this in full, with what generated it.'""",
    'the rail: which lane holds it in full',
)


# ── 14. Every other button and sentence that named a lane ────────────────
once(
    r"""      tab = 'econ'; econView = 'wallet'; saveView(); render();
""",
    r"""      tab = 'econ'; econView = 'money'; saveView(); render();
""",
    'the burn dialog: the PEER door ->',
)

once(
    r"""      pay.appendChild(h('button', { class: 'btn small primary', style: 'margin-top:6px', text: 'Bind an address →',
        onclick: function () { tab = 'econ'; econView = 'wallet'; saveView(); render(); } }));
""",
    r"""      pay.appendChild(h('button', { class: 'btn small primary', style: 'margin-top:6px', text: 'Bind an address →',
        onclick: function () { tab = 'econ'; econView = 'money'; saveView(); render(); } }));
""",
    'the profile rail: bind an address ->',
)

once(
    r"""  // now: the on-chain pools card in the Pools tab, and the token card in the
  // Wallet tab. The pools card grew its own copies""",
    r"""  // now: the on-chain pool card and the token card, which are both on the
  // Money lane (they were the Pools and Wallet lanes). The pool card grew its
  // own copies""",
    'the l2 wallet comment names lanes that exist',
)

once(
    r"""The PEER counted in the Wallet tab is a different thing that happens to share the name""",
    r"""The PEER counted at the top of this tab is a different thing that happens to share the name""",
    'the pool card: the epoch token is now on the same tab',
)

once(
    r"""it has its own card at the bottom of this tab.""",
    r"""it has its own card further down this section.""",
    'walletView: the ERC-20 card is no longer the bottom of the tab',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
