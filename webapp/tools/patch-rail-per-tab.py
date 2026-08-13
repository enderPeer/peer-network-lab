# The left rail becomes a function of the tab you are standing on.
#
# It was the feed's rail on every screen: search, seven feed orders and two
# rows of content filters, drawn unconditionally beside Chats, Alerts,
# Economy and Profile — screens with no feed in them for any of it to order.
# The comment above the line even said so ("Left rail: how the feed is read"),
# written when there was one screen and never made tab-aware.
#
# What replaces it is one dispatcher, railLeftFor(tab, st, me), and a set of
# cards per tab. The dispatcher exists so the failure cannot come back: a
# sixth tab added later has to name its rail there, and until it does the
# fallback is stated out loud rather than inherited by accident.
#
# The rule every card here was written against: it must answer a question a
# reader of THAT tab is actually asking, from state the app already computes,
# and it must not be a second copy of what the centre column already shows in
# full. A rail is a summary and a way in.
#
#   FEED     unchanged — search, sorting, filters, the build's paperwork,
#            the network's age, the epoch clock. Those controls work and this
#            is the screen they belong to.
#   CHATS    what a message IS here (an act in the public log, priced, not
#            private — the thing people most often get wrong about this
#            network, printed beside the box they type into), who is waiting
#            on a reply, and what saying it costs.
#   ALERTS   the shape of the list beside it, broken down by kind, plus who
#            is naming you and where alerts come from at all.
#   ECONOMY  the affordability question, because that is what somebody on
#            this tab is deciding: reserve, rate, acts it covers, how close
#            the wall is. Then the PEER held with the value/standing wall
#            restated, the epoch clock, and which on-chain surfaces this host
#            actually has — with OFF said in words rather than shown as a
#            zero that reads like a balance.
#   PROFILE  your own record: standing and what produced it, what your acts
#            are made of, who can act as this handle, and where it is paid.
#
# Nothing here invents a number. Every figure is one the app already computes
# (wallState, notificationsFor, dmThreads, st.tokens, st.bundles, st.g.edges,
# st.addresses) or one this host answers for (/api/token/onchain,
# /api/auth/status), and where a question has no answer the card says which
# piece is missing instead of printing a zero.
#
# Run:  python tools/patch-rail-per-tab.py && node social/assemble.mjs
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


# ── 1. One new term ───────────────────────────────────────────────────────
# The Chats rail asserts the one thing this network most needs understood,
# and the glossary had no entry for the word it asserts it about. Both TERMS
# rules hold: the one-liner is answerable without knowing another term, and
# `sect` names a section that exists — and patch 2 gives that section a
# paragraph about messages, so the help link lands somewhere that discusses
# the thing rather than merely existing.
once(
    r"""      sect: 'The coin on Base: pools, prices and explorers',
    },
  };
""",
    r"""      sect: 'The coin on Base: pools, prices and explorers',
    },
    dm: {
      t: 'direct message',
      one: 'A message addressed to one person and recorded in the public log, where anyone can read it.',
      more: 'A Send act carries the sender, the recipient and the text into the same append-only record as every post — served by this host, copied into every mirror, and published in the archive. It costs θ like any other act and enters no score. “Direct” says who it is addressed to; it has never meant hidden, and nothing in this app can make it so.',
      sect: 'Acting: post, react, review, tag',
    },
  };
""",
    'TERMS: direct message',
)


# ── 2. The guide section that term points at now discusses messages ───────
once(
    r"""        P('Sliders run −1…+1. Negative values are real records too — the geometry routes them differently (see the red edges in Economy → Network).')),""",
    r"""        P('Sliders run −1…+1. Negative values are real records too — the geometry routes them differently (see the red edges in Economy → Network).'),
        P(B('A message is one of them. '), 'A direct message is a ', K('Send'), ' act: sender, recipient and text, appended to the same public log as everything else and readable by anybody — including through the ', K('Everyone'), ' lane on the Chats tab, which browses other people’s conversations. It debits θ like any other act and enters no score. “Direct” names who it is addressed to and has never meant hidden.')),""",
    'the guide: a message is an act, and public',
)


# ── 3. The layout section stops describing a rail that no longer exists ───
once(
    r"""' is how you READ: search, the order the feed is in, and the filters for what a card carries. '""",
    r"""' follows the tab you are standing on: on the feed it is how you READ — search, the order the feed is in, the filters for what a card carries — and on Chats, Alerts, Economy and Profile it carries that screen’s own summary instead, because an order for a feed governs nothing on a screen with no feed in it. '""",
    'the guide: the left column follows the tab',
)

once(
    r""" an event with a photograph is both.')),""",
    r""" an event with a photograph is both.'),
        P(B('This rail is the feed’s. '), 'Sorting and filters govern a list of cards, so they are drawn where that list is and nowhere else. On Chats, Alerts, Economy and Profile the left column carries that screen’s own summary instead — who is waiting on a reply, what shape your alerts are in, whether your reserve still covers an act, what your standing is made of. Nothing was hidden: those controls never did anything on those screens.')),""",
    'the guide: the left rail belongs to the feed',
)

once(
    r"""search, order, filters. Right column is you""",
    r"""search, order, filters, and on every other tab that screen’s own summary instead. Right column is you""",
    'aboutCard: the layout sentence',
)


# ── 4. The dispatcher and the per-tab cards ───────────────────────────────
once(
    r"""  /**
   * Search, at the top of the left rail. The query is where you are LOOKING,
""",
    r"""  /**
   * The left rail, decided by the tab.
   *
   * This is a dispatcher rather than a list at the call site for one reason:
   * every tab used to inherit the feed's rail by default, and nobody chose
   * that for any of them. Search, seven feed orders and two rows of content
   * filters were drawn beside the Economy tab, where there is no feed for any
   * of it to order. A dispatcher makes the choice explicit and makes a sixth
   * tab impossible to add without making it — which is the actual defect,
   * because the wrong rail was never a decision, it was an omission.
   *
   * The fallback below is the feed's rail, and it is stated rather than
   * implied: the centre column falls back to feedTab(st) for a tab it does
   * not know, so the rail has to fall back to the same screen's controls or
   * the two columns would disagree about where you are standing. A new tab
   * therefore has to be named twice — once in the centre dispatch, once here
   * — and that is the point.
   *
   * Returns an array; the caller builds the rail element from it.
   */
  function railLeftFor(tab2, st, me) {
    if (tab2 === 'chat') return chatRailCards(st, me);
    if (tab2 === 'alerts') return alertsRailCards(st);
    if (tab2 === 'econ') return econRailCards(st, me);
    if (tab2 === 'profile') return profileRailCards(st, me);
    // The feed. aboutCard() and ageWidget(st) stay HERE and only here: one is
    // the build's paperwork and the invitation to change it, the other is how
    // old this network is — both questions about the place as a whole, which
    // is the feed's subject. epochCard(st) stays too, and is drawn again on
    // Economy, because the epoch clock is the one instrument both screens are
    // genuinely about: it decides when the record is stamped and when the
    // mint pays.
    return [railSearchCard(), railSortCard(), railFilterCard(), aboutCard(), ageWidget(st), epochCard(st)];
  }

  /**
   * A GET this rail may ask on every repaint, asked at most once every 30
   * seconds.
   *
   * The rail is rebuilt by every render — a poll landing, a keystroke, a tab
   * change — and a request per rebuild would spend the operator's RPC quota
   * on a card nobody pressed. Thirty seconds is not a guess: /api/token/onchain
   * answers from a cache of exactly that length, so asking faster returns the
   * same bytes.
   *
   * Every waiter is answered, including the ones that arrived while a request
   * was in flight — the first version answered only the first, so a card built
   * during someone else's request sat on "asking this host…" until the next
   * repaint. A superseded question (the handle changed) is dropped rather than
   * answered with the new handle's reply.
   */
  function railAsk(memo, path, done) {
    if (memo.at && memo.path === path && Date.now() - memo.at < 30000) { done(memo.r); return; }
    if (memo.inflight === path) { memo.waiting.push(done); return; }
    memo.inflight = path;
    memo.waiting = [done];
    var finish = function (r) {
      if (memo.inflight !== path) return;      // a later question replaced this one
      memo.at = Date.now(); memo.path = path; memo.r = r; memo.inflight = null;
      var q = memo.waiting;
      memo.waiting = [];
      q.forEach(function (f) { try { f(r); } catch (e) {} });
    };
    // status 0 means 'nothing was reached', which is a different sentence from
    // any status a host can answer with. try/catch as well as a rejection
    // handler: a browser with no fetch, or a page opened from a file, throws
    // on the call itself rather than rejecting.
    try {
      fetch(API + path, { cache: 'no-store' })
        .then(function (x) {
          return x.json().then(function (d) { return { status: x.status, d: d }; },
            function () { return { status: x.status, d: null }; });
        })
        .then(finish, function () { finish({ status: 0, d: null }); });
    } catch (e) { finish({ status: 0, d: null }); }
  }
  var railChainMemo = { at: 0, path: null, r: null, inflight: null, waiting: [] };
  var railAuthMemo = { at: 0, path: null, r: null, inflight: null, waiting: [] };

  /** How many more acts a reserve covers. One act, one θ, whatever it is. */
  function railAffords(me) { return Math.floor(me.burnBal / THETA); }

  /**
   * The wall, in the rail's words.
   *
   * wallState() already computes it for the identity card's banner, which is
   * only drawn when it is nearly too late. Here the answer is printed whether
   * or not it is bad news, because on these two tabs it is the question being
   * asked rather than an interruption.
   */
  function railWallNote(st) {
    var w = wallState(st, who);
    if (!w) return null;
    if (w.below) {
      return h('p', { class: 'smallnote', style: 'color:var(--bad)' },
        'Your x* is under the ', term('wall', 'W2a wall'), ' — the network refuses your writes until standing comes back or you burn more. Nothing is deleted and nothing is lost; you cannot write.');
    }
    if (w.actsLeft <= 0) {
      return h('p', { class: 'smallnote', style: 'color:var(--bad)' },
        'One more act drops your own rate under the ', term('wall', 'wall'), '. Burn first, then say it.');
    }
    return h('p', { class: 'smallnote' },
      'About ' + w.actsLeft + ' more act' + (w.actsLeft === 1 ? '' : 's') + ' before your own rate alone would fall under the ',
      term('wall', 'wall'), ' — acting raises N, so every act drags x* down. Burning is what pushes it back up.');
  }

  /**
   * Chats.
   *
   * The centre column shows the conversations; it does not say what a
   * conversation IS on this network, and on an open thread it says nothing at
   * all — the warning about messages being public is drawn on the list screen
   * and then disappears at exactly the moment somebody starts typing. So it
   * lives here, beside the box, on both screens.
   */
  function chatRailCards(st, me) {
    var cards = [];

    cards.push(h('div', { class: 'card' },
      h('p', { class: 'eyebrow', text: 'what a message is here' }),
      h('p', { class: 'smallnote' },
        'A ', term('dm', 'direct message'), ' is an act in the public record, exactly like a post: the sender, the recipient and the text, appended to the same log, served to everyone, copied into every mirror and published in the archive. The ',
        h('b', { text: 'Everyone' }), ' lane on this tab reads other people’s conversations — and yours are in it on the same terms. Nothing here is private, and nothing in this app can make it so.'),
      h('p', { class: 'smallnote' },
        'It costs ', term('theta', 'θ'), ' ' + fmt(THETA, 4) + ' like every other act, and it enters no score: messaging somebody moves neither your ',
        term('standing'), ' nor theirs. Vouching is the act that does.')));

    // ── who has the ball ──
    // Deliberately NOT 'unread': nothing in this network records what you have
    // read, and the one marker that exists (the alerts seen mark) is cleared
    // by the right rail on every repaint, so a card built on it would read
    // zero almost always. Who spoke last is in the log, is stable, and is the
    // same question a person actually has.
    var threads = dmThreads(st, who);
    var peers = Object.keys(threads);
    var waiting = [];
    peers.forEach(function (p) {
      var last = threads[p][threads[p].length - 1];
      if (!last || last.from === who) return;
      if (p === chatPeer) return;              // open in the middle: you are reading it
      waiting.push({ id: p, last: last });
    });
    waiting.sort(function (a, b) { return b.last.idx - a.last.idx; });
    var wCard = h('div', { class: 'card' }, h('h2', { text: 'Waiting on you' }));
    if (!waiting.length) {
      wCard.appendChild(h('p', { class: 'smallnote', text: peers.length
        ? 'Every conversation you are in ended with you. Nothing is waiting on a reply.'
        : 'No conversations yet. Anyone here can be opened from the list beside this, or from their profile.' }));
    } else {
      wCard.appendChild(h('p', { class: 'smallnote', text: 'They spoke last, newest first. Nothing in this network records what you have read, so this is whose turn it is rather than what is unopened.' }));
      // No term() inside these rows: each row is a <button>, and a button
      // inside a button stops responding to clicks.
      waiting.slice(0, 6).forEach(function (r) {
        wCard.appendChild(h('button', { class: 'rail-opt', onclick: function () { chatPeer = r.id; tab = 'chat'; render(); } },
          h('b', { text: st.handles[r.id] || r.id }),
          h('span', { class: 'smallnote', text: (r.last.call ? callLabel(r.last.call) : String(r.last.text || '').slice(0, 44))
            + ' · ' + (relAgo(actStamp(r.last.idx)) || 'act #' + r.last.idx) })));
      });
      if (waiting.length > 6) {
        wCard.appendChild(h('p', { class: 'smallnote', text: 'and ' + (waiting.length - 6) + ' more in the list beside this.' }));
      }
    }
    cards.push(wCard);

    // ── the price, beside the box that charges it ──
    var afford = railAffords(me);
    var cost = h('div', { class: 'card' }, h('h2', { text: 'What saying it costs' }),
      h('div', { class: 'kv' },
        h('span', {}, term('reserve')), h('b', { class: 'num', text: fmt(me.burnBal, 3) }),
        h('span', { text: 'messages it covers' }), h('b', { class: 'num', text: String(afford) })));
    if (afford <= 0) {
      cost.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'Nothing left to send with. The composer refuses the act rather than accepting it and undoing it afterwards.' }));
    }
    var wall = railWallNote(st);
    if (wall) cost.appendChild(wall);
    if (afford <= 3 || (wallState(st, who) || {}).near) {
      cost.appendChild(h('button', { class: 'btn small primary', style: 'margin-top:8px',
        text: 'Burn bitcoin →', onclick: function () { burnDialog(); } }));
    }
    cards.push(cost);
    return cards;
  }

  /**
   * Alerts.
   *
   * The middle column is one flat list of up to forty rows in append order.
   * What it never says is what SHAPE it is — forty reactions and forty
   * mentions read identically until you have read them. That is the whole job
   * of this rail: the same forty acts, counted by kind, before you start.
   * Nothing here is a second copy of the list; there are no rows in it.
   */
  function alertsRailCards(st) {
    var cards = [];
    var notifs = notificationsFor(st, who);
    var count = {}, byWho = {};
    notifs.forEach(function (n) {
      count[n.kind] = (count[n.kind] || 0) + 1;
      byWho[n.who] = (byWho[n.who] || 0) + 1;
    });
    // Ordered by what an act cost the person who made it, loosely: the ones
    // that moved something first.
    var KINDS = [
      ['vouch', 'backings', 'the only kind here that moved your rate'],
      ['comment', 'comments', 'a priced act, and a card of its own'],
      ['react', 'reactions', 'commitment spent on something you made'],
      ['quote', 'quotes', 'your post carried inside another'],
      ['mention', 'mentions', 'your handle named in somebody’s text'],
      ['tag', 'tags', 'your work filed under a commons type'],
      ['dm', 'messages', 'public acts, like everything — Chats holds them'],
      ['call', 'calls', 'the call was never in the log; that it happened is'],
    ];
    // No "N new" chip here, and that is deliberate rather than an omission:
    // the centre column marks this list seen while it draws, and the centre
    // column is built before this rail is, so a count of unseen acts read
    // here would be zero on the one tab where it would mean something. The
    // fresh rows are marked in the list itself, which can still tell.
    var shape = h('div', { class: 'card' }, h('h2', { text: 'What has reached you' }));
    if (!notifs.length) {
      shape.appendChild(h('p', { class: 'smallnote', text: 'Nothing inbound yet. Alerts appear when somebody acts on something you made or wrote to you — there is nothing to configure and nothing that could have been missed.' }));
    } else {
      var kv = h('div', { class: 'kv' });
      KINDS.forEach(function (k) {
        if (!count[k[0]]) return;
        kv.appendChild(h('span', { text: k[1] }));
        kv.appendChild(h('b', { class: 'num', text: String(count[k[0]]) }));
      });
      shape.appendChild(kv);
      KINDS.forEach(function (k) {
        if (!count[k[0]]) return;
        shape.appendChild(h('p', { class: 'smallnote', style: 'margin:2px 0', text: k[1] + ' — ' + k[2] }));
      });
      shape.appendChild(h('p', { class: 'smallnote', text: 'Counted over the ' + notifs.length + ' most recent inbound acts, which is exactly the list beside this — nothing older is in either.' }));
    }
    cards.push(shape);

    if (notifs.length) {
      var names = Object.keys(byWho).sort(function (a, b) { return byWho[b] - byWho[a]; });
      var whoCard = h('div', { class: 'card' }, h('h2', { text: 'Who is naming you' }));
      names.slice(0, 6).forEach(function (id) {
        whoCard.appendChild(h('button', { class: 'rail-opt', onclick: function () { openProfile(id); } },
          h('b', { text: st.handles[id] || id }),
          h('span', { class: 'smallnote', text: byWho[id] + ' of these ' + notifs.length + ' acts' })));
      });
      whoCard.appendChild(h('p', { class: 'smallnote', text: 'How often somebody appears here is not a ranking and enters nothing: it is a count of acts in this list. Open one to see their standing, vouch, or start a conversation.' }));
      cards.push(whoCard);
    }

    cards.push(h('div', { class: 'card' },
      h('p', { class: 'eyebrow', text: 'where these come from' }),
      h('p', { class: 'smallnote' },
        'Nothing in the log ever says “notify me”. Every alert is read back out of the graph by asking which edges point at something you wrote — so anyone ',
        term('replay', 'replaying'), ' the log computes the same list, and it cannot drift out of step with what actually happened.'),
      h('p', { class: 'smallnote' },
        'Inbound acts enter no feed ranking: the ', term('S', 'feed score'), ' is computed from YOUR position in the graph, and being named by somebody does not move it. This list is the only place they surface.')));
    return cards;
  }

  /**
   * Economy.
   *
   * Somebody standing here is deciding whether they can afford to speak, so
   * that is the first card and it is a question rather than a readout. The
   * three figures come from the same places the identity card reads — this
   * restates them beside the money, with the one thing the identity card does
   * not carry until it is nearly too late: how many acts are left before the
   * wall, printed whether or not it is bad news.
   *
   * The last card is the honest state of every on-chain surface. OFF is said
   * in words, because a zero next to "pools" reads like a balance.
   */
  function econRailCards(st, me) {
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

    // The epoch clock, the same card the feed carries. It earns its place on
    // both: on the feed it is when the record gets stamped, here it is when
    // the mint pays and when a pending act starts counting.
    cards.push(epochCard(st));
    cards.push(railChainCard());
    return cards;
  }

  /**
   * Which on-chain surfaces this host actually has.
   *
   * Four independent switches, and the app behaved as though they were one:
   * a reader on this tab meets pools, claims and anchors with no way of
   * telling "nobody has deployed this" from "it is broken" from "there is
   * nothing here yet". Each line says which, and an unset one says OFF in
   * words — a zero beside "pools" reads like a balance.
   *
   * Everything is read from the host's own answer. This page holds no
   * address: a different operator runs a different deployment, and an
   * address baked into source is one nobody verified.
   */
  function railChainCard() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'On the chain, here' }));
    var box = h('div', {});
    card.appendChild(box);
    box.appendChild(h('p', { class: 'smallnote', text: 'Asking this host what is deployed…' }));

    railAsk(railChainMemo, '/api/token/onchain', function (r) {
      box.innerHTML = '';
      function line(label, addr, off) {
        box.appendChild(h('div', { class: 'kv' }, h('span', { text: label }),
          addr ? h('b', { class: 'num', text: l2ShortHex(addr) })
            : h('b', { class: 'num', style: 'color:var(--muted)', text: 'off' })));
        if (!addr && off) box.appendChild(h('p', { class: 'smallnote', style: 'margin:2px 0', text: off }));
      }
      var d = r && r.d && typeof r.d === 'object' ? r.d : null;
      if (!d) {
        box.appendChild(h('p', { class: 'smallnote', text: r && r.status === 0
          ? 'Nothing answered at ' + (API || 'this origin') + '/api/token/onchain, so this page cannot say what is deployed — and it will not guess.'
          : 'This host answered ' + (r ? r.status : '—') + ' with nothing this page could read, so nothing is claimed here.' }));
        return;
      }
      if (d.deployed === false || !d.token) {
        line('the PEER token', null, String(d.why || d.error || 'no on-chain token is configured for this host.'));
        box.appendChild(h('p', { class: 'smallnote', text: 'With no token there is nothing for the other three to be about. Everything above this card is unaffected: the epoch token, your reserve and every burn ever recorded live in the log, not on a chain.' }));
        return;
      }
      line('the PEER token', d.token, null);
      if (d.chainIdMatches === false) {
        box.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: String(d.error || 'the RPC this host reads answered for a different chain, so it refuses to report numbers from it.') }));
        return;
      }
      var np = d.namedPools;
      line('the pools factory', np && !np.error ? np.factory : null,
        np && np.error ? 'The factory this host names did not read: ' + String(np.error)
          : 'No pools factory is configured, so there is no on-chain PEER/cbBTC pool here, no price to read, and the PEER door into reserve stays shut. Burning bitcoin needs no price and is unaffected.');
      var cs = d.claimState;
      line('the claim contract', cs && cs.configured !== false && !cs.error ? cs.contract : null,
        cs && cs.error ? 'The claim contract did not read: ' + String(cs.error)
          : 'No claim contract, so epoch earnings are a figure computed from the log and nothing on a chain. Binding an address still matters — a payout list is built from the bindings as they stood at each close.');
      var an = d.anchors;
      line('epoch anchors', an && an.configured !== false && !an.error ? an.contract : null,
        an && an.error ? 'The anchor contract did not read: ' + String(an.error)
          : 'This host reads no epoch anchors. That is not a claim that none exist — only that nothing here checks for them.');
      box.appendChild(h('p', { class: 'smallnote', text: 'Off is a choice, not a fault: an address written into source is one nobody verified, so each of these stays off until an operator points it at a deployment they made themselves. Read at most once every 30 seconds, which is the length of this host’s own cache.' }));
    });
    return card;
  }

  /**
   * Profile.
   *
   * The centre column shows who you are to other people — handle, bio,
   * follows, what you published. What it never showed is your own record:
   * where your standing came from, what your act count is made of, whether
   * anybody but you can act as this handle, and whether an address is bound
   * for the epoch that closes next. Those are the four questions somebody
   * opens their own profile with, and every one of them was unanswered.
   */
  function profileRailCards(st, me) {
    var cards = [];
    var myX = st.xById[who] || 0;
    var rate = me.burnBal / Math.max(me.actCount, 1);

    // ── standing, and what produced it ──
    var backers = [];
    for (var k in st.bundles) {
      var b = st.bundles[k];
      if (b.rcp !== who) continue;
      var pd = Math.max(-1, Math.min(1, b.pd)), pi = Math.max(-1, Math.min(1, b.pi));
      if (pd > 0 && pi > 0) backers.push({ id: b.src, coeff: Math.sqrt(pd * pi) });
    }
    backers.sort(function (a, b2) { return b2.coeff - a.coeff; });
    var rec = h('div', { class: 'card' }, h('h2', { text: 'Your record' }),
      h('div', { class: 'kv' },
        h('span', {}, term('standing')), h('b', { class: 'num', text: fmt(NU * myX, 4) }),
        h('span', {}, term('rate', 'rate burn/N')), h('b', { class: 'num', text: fmt(rate, 3) }),
        h('span', {}, term('acts', 'acts N')), h('b', { class: 'num', text: String(me.actCount) }),
        h('span', {}, term('reserve')), h('b', { class: 'num', text: fmt(me.burnBal, 3) })));
    if (!backers.length) {
      rec.appendChild(h('p', { class: 'smallnote' },
        'Nobody is vouching for you, so your standing IS your own rate: ν × rate, and nothing else. It moves when somebody routes theirs to you — and a voucher with a lower rate than yours pulls you ',
        h('b', { text: 'down' }), '. Nothing you can do alone creates a point of it.'));
    } else {
      rec.appendChild(h('p', { class: 'smallnote', text: backers.length + ' account' + (backers.length === 1 ? '' : 's') + ' route rate to you. Standing is transported, never minted — this is where yours came from.' }));
      backers.slice(0, 5).forEach(function (v) {
        rec.appendChild(h('button', { class: 'rail-opt', onclick: function () { openProfile(v.id); } },
          h('b', { text: st.handles[v.id] || v.id }),
          h('span', { class: 'smallnote', text: 'coefficient ' + fmt(v.coeff, 3) })));
      });
      if (backers.length > 5) rec.appendChild(h('p', { class: 'smallnote', text: 'and ' + (backers.length - 5) + ' more.' }));
    }
    cards.push(rec);

    // ── what the act count is made of ──
    // N is the denominator of the rate, so "why is my rate falling" is a
    // question about this breakdown and nothing else on the page answers it.
    // The published count uses the very predicate profileTab uses for its own
    // list, so the two can never print different numbers for one thing.
    var notes = 0, comments = 0;
    Object.keys(st.payloads).forEach(function (cid) {
      var meta = st.postMeta[cid];
      if (st.creators[cid] !== who || !meta || !st.g.nodes.get(cid)) return;
      if (meta.comment) comments++; else notes++;
    });
    var reactions = 0, vouches = 0;
    st.g.edges.forEach(function (e) {
      if (e.family !== 'Opinion' || e.src !== who) return;
      if (String(e.tgt).indexOf('prof_') === 0) vouches++; else reactions++;
    });
    var msgs = 0;
    (st.dms || []).forEach(function (m) { if (m.from === who && !m.call) msgs++; });
    var named = notes + comments + reactions + vouches + msgs;
    var rest = Math.max(0, me.actCount - named);
    var mk = h('div', { class: 'card' }, h('h2', { text: 'What your acts are made of' }),
      h('div', { class: 'kv' },
        h('span', { text: 'published' }), h('b', { class: 'num', text: String(notes) }),
        h('span', { text: 'comments' }), h('b', { class: 'num', text: String(comments) }),
        h('span', { text: 'reactions' }), h('b', { class: 'num', text: String(reactions) }),
        h('span', { text: 'vouches given' }), h('b', { class: 'num', text: String(vouches) }),
        h('span', { text: 'messages sent' }), h('b', { class: 'num', text: String(msgs) }),
        h('span', { text: 'everything else' }), h('b', { class: 'num', text: String(rest) })));
    mk.appendChild(h('p', { class: 'smallnote' },
      'Every one of them spent ', term('theta', 'θ'), ' and raised ', term('acts', 'N'),
      ' — which is why talking lowers your rate and burning is the only thing that raises it. “Everything else” is the acts with no line of their own here: tags, gatherings, value moves.'));
    cards.push(mk);

    // ── who can act as this handle ──
    var sec = h('div', { class: 'card' }, h('h2', { text: 'Who can act as this handle' }));
    var secured = !!st.pinHash[who];
    sec.appendChild(h('div', { class: 'kv' },
      h('span', { text: 'PIN' }),
      h('b', { class: 'num', style: secured ? '' : 'color:var(--bad)', text: secured ? 'set' : 'none' })));
    if (!secured) {
      sec.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'Anyone who knows this handle’s name can post, message and vouch as it — that has already happened to somebody here. Editing or deleting your own posts is refused for the same reason: the host cannot tell it is you.' }));
      sec.appendChild(h('button', { class: 'btn small primary', style: 'margin-top:6px', text: 'Secure this handle', onclick: function () { setPinFlow(st, false); } }));
    } else if (sessionLocked()) {
      sec.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'This browser has forgotten the PIN — it is dropped whenever the browser closes, on purpose, so a shared machine cannot keep it. You are still signed in and nothing you posted is affected; you cannot act until you prove it is you.' }));
      sec.appendChild(h('button', { class: 'btn small primary', style: 'margin-top:6px', text: 'Unlock', onclick: function () { withUnlock(function () {}); } }));
    }
    // Passkeys are not in the log — replay carries pinHash and nothing about
    // them — so the only honest source is the host that holds them. Asked
    // only when there is a host; on a browser-local network there is nobody
    // to authenticate against and saying otherwise would be theatre.
    if (REMOTE && who) {
      var keyBox = h('div', {});
      sec.appendChild(keyBox);
      keyBox.appendChild(h('p', { class: 'smallnote', text: 'Asking this host what credentials it holds…' }));
      railAsk(railAuthMemo, '/api/auth/status?as=' + encodeURIComponent(who), function (r) {
        keyBox.innerHTML = '';
        var d = r && r.d && typeof r.d === 'object' ? r.d : null;
        if (!d || String(d.as || '') !== String(who)) {
          keyBox.appendChild(h('p', { class: 'smallnote', text: 'This host did not answer for this handle, so what it holds is not stated here.' }));
          return;
        }
        var n = d.passkeys && d.passkeys.length ? d.passkeys.length : 0;
        keyBox.appendChild(h('div', { class: 'kv' },
          h('span', { text: 'passkeys' }), h('b', { class: 'num', text: String(n) })));
        if (d.pinStorage) keyBox.appendChild(h('p', { class: 'smallnote', style: 'margin:2px 0', text: 'PIN stored as ' + String(d.pinStorage) + '.' }));
        keyBox.appendChild(h('p', { class: 'smallnote', text: n
          ? 'A passkey is not a shared secret and its hash is not in the public log, which a PIN’s is. Either one lets this handle act.'
          : 'A PIN is a shared secret whose hash sits in the public log, and four digits are worth ten thousand guesses offline. A passkey is not a secret at all — add one if this device offers it.' }));
      });
    } else if (!REMOTE) {
      sec.appendChild(h('p', { class: 'smallnote', text: 'No host answers here: this network lives in this browser alone, so there is nobody to check a credential against. On the shared instance a PIN or a passkey is what stops anyone else being you.' }));
    }
    sec.appendChild(h('div', { class: 'mini-form persistent' },
      h('button', { class: 'btn small', text: '⚙ Settings', onclick: function () { settingsDrawer(); } })));
    cards.push(sec);

    // ── where this handle is paid ──
    var bound = (st.addresses || {})[who] || '';
    var pay = h('div', { class: 'card' }, h('h2', {}, 'Where you are paid'));
    if (bound) {
      pay.appendChild(h('p', { class: 'smallnote num', style: 'word-break:break-all', text: bound }));
      pay.appendChild(h('p', { class: 'smallnote' },
        'Whoever holds that address collects this handle’s ', term('earnings', 'epoch earnings'),
        ' from the closes to come. The ', term('binding', 'binding'), ' is an act in this log like everything else, so it is public and it applies forward only.'));
    } else {
      pay.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)' },
        'No address is bound. A payout list is built from the bindings as they stood AT THE CLOSE, and a handle with no address gets no line in it — not a line worth zero, no line. That share is not held for you: it returns to whoever funded the epoch at the ',
        term('sweep', 'sweep'), '.'));
      pay.appendChild(h('button', { class: 'btn small primary', style: 'margin-top:6px', text: 'Bind an address →',
        onclick: function () { tab = 'econ'; econView = 'wallet'; saveView(); render(); } }));
    }
    cards.push(pay);
    return cards;
  }

  /**
   * Search, at the top of the left rail. The query is where you are LOOKING,
""",
    'railLeftFor and the four per-tab rails',
)


# ── 5. The call site ──────────────────────────────────────────────────────
once(
    r"""    // Left rail: how the feed is read (search, order, filters) plus the
    // build's paperwork. Right rail: who you are, then one instrument at a
    // time behind the Alerts/Network/Tags toggle.
    shell.appendChild(h('div', { class: 'cols' },
      h('div', { class: 'rail rail-left' }, railSearchCard(), railSortCard(), railFilterCard(), aboutCard(), ageWidget(st), epochCard(st)),
      // (the same three reading controls render again inside feedTab for
      //  phones — CSS shows exactly one of the two copies per breakpoint)
      h('div', { class: 'geek-center' }, center),
""",
    r"""    // Left rail: whatever the tab you are on is about — the feed's reading
    // controls on the feed, and each other screen's own summary elsewhere;
    // railLeftFor is the one place that decides. Right rail: who you are,
    // then one instrument at a time behind the Alerts/Network/Tags toggle,
    // on every tab, unchanged.
    var railLeft = h('div', { class: 'rail rail-left' });
    railLeftFor(tab, st, me).forEach(function (c) { if (c) railLeft.appendChild(c); });
    shell.appendChild(h('div', { class: 'cols' },
      railLeft,
      // (on the feed, the same three reading controls render again inside
      //  feedTab for phones — CSS shows exactly one of the two copies per
      //  breakpoint. Nothing else needs the trick: the cards a per-tab rail
      //  draws are summaries, and a summary below the thing it summarises is
      //  still readable.)
      h('div', { class: 'geek-center' }, center),
""",
    'the call site asks the dispatcher',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
