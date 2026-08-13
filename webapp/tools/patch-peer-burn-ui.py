# The second door into reserve, on screen: burning PEER on Base.
#
# The app already had one door and explained it well: burn bitcoin at an
# address with no key, the host watches the address, reserve is credited. This
# adds the surface for the other door beside it — PEER destroyed at a dead
# address, priced by the official PEER/cbBTC pool — and it is deliberately not
# a copy of the first, because the two are not the same kind of thing:
#
#   * a bitcoin burn has no price in it, so nothing about it can be
#     manipulated; a PEER burn has a price, and a price can be lied to. Every
#     fence on this card exists for that one difference.
#   * the bitcoin address is unspendable by ARITHMETIC anybody can check; the
#     dead EVM address is unspendable because nobody knows a key for it. That
#     sentence is printed wherever the two are visible together — here, and in
#     the bitcoin panel, which now names the other door.
#   * and the PEER it destroys is the ERC-20 on Base, NOT the epoch token this
#     same tab counts. The tab already says at length that the two do not
#     convert; a door that quietly implied otherwise would undo all of it, so
#     the card says it again in its own words.
#
# What it renders TODAY is the honest state and nothing more: no pools factory
# is deployed anywhere, so there is no official pool, no reserves to read and
# no price — and with no price there is no amount box and no button, only the
# paragraph saying which piece is missing and the bitcoin door, which works.
# Same rule as the pool-opening form further down this tab: a control that
# cannot work is worse than none.
#
# Run:  python tools/patch-peer-burn-ui.py && node social/assemble.mjs
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


# ── 1. Four new terms ─────────────────────────────────────────────────────
# The file's two rules, followed: each one-liner is answerable without knowing
# another term, and every `sect` names a section that exists in guideTab. All
# four point at 'The coin on Base: pools, prices and explorers', which patch 2
# extends with the paragraphs these ideas need — a help link into a section
# that does not discuss the thing is the same failure as one into a section
# that does not exist, only harder to notice.
once(
    r"""      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
  };
""",
    r"""      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
    officialPool: {
      t: 'the official pool',
      one: 'The one named PEER/cbBTC pool a host prices a PEER burn against, picked by its number.',
      more: 'Anyone can open a pool in the same contract and call it anything, so a name is not an identity — the number is. A burn records which pool it was priced against and what that pool held, so a reader recomputes the price instead of taking the host’s word for it. Nothing is re-read afterwards: replay does arithmetic on the numbers the burn recorded and asks no chain anything, which is why a published epoch still reproduces years later.',
      sect: 'The coin on Base: pools, prices and explorers',
    },
    twap: {
      t: 'time-weighted price',
      one: 'A price averaged over a stretch of time, so no single trade decides it.',
      more: 'A pool prices at whatever the last trade left behind, and one trade lasts one block — cheap to buy. Averaging over a window means holding the price against every arbitrageur for the whole window at your own expense. How long the window is, and how many readings it needs, are choices about the price of speech rather than discovered quantities.',
      sect: 'The coin on Base: pools, prices and explorers',
    },
    poolDepth: {
      t: 'pool depth',
      one: 'How much bitcoin a pool actually holds — below a floor, a burn is refused instead of priced.',
      more: 'The less a pool holds, the further one trade moves it: pump a thin pool, burn at the inflated rate, take the reserve, let it fall. So there is a minimum bitcoin side a pool must hold before this network reads any price off it, and under that the answer is a refusal in words, never a worse price.',
      sect: 'The coin on Base: pools, prices and explorers',
    },
    deadAddr: {
      t: 'dead address',
      one: 'An address nobody is believed to hold a key for: coins sent there stop moving.',
      more: 'It is weaker than the bitcoin burn address beside it, and the difference is worth knowing. That one pays a script that cannot be satisfied — unspendable by arithmetic, checkable by anyone. A dead address is unspendable only because no key for it is known. It is used because the deployed PEER token refuses transfers to address(0) on purpose, so a nonzero sink is all there is. Both destroy value; only one of them is a proof.',
      sect: 'The coin on Base: pools, prices and explorers',
    },
  };
""",
    'TERMS: official pool, time-weighted price, pool depth, dead address',
)


# ── 2. The guide section those four terms point at ────────────────────────
once(
    r"""', jump('open pools', 'econ/pools'))),""",
    r"""'),
        P(B('Reserve has a second door, and it is the one with a price. '), 'Burning bitcoin destroys satoshis and there is nothing to argue about: the amount destroyed IS the amount credited. Burning the coin on Base destroys PEER, and PEER has to be valued before it can credit anything — so the ', B('official pool'), ' is asked what that many PEER would fetch in cbBTC, that answer is already in satoshis (cbBTC has 8 decimals, so one raw unit is one satoshi), and the same rate applies as at the bitcoin door. A euro figure never enters that arithmetic anywhere; where one is shown it is a label for humans and nothing else depends on it.'),
        P(B('Which is why the second door is fenced and the first is not. '), 'A pool price is whatever the last trade left behind, so a shallow pool can be pushed for the length of one block — and what it would buy here is the one thing this network says cannot be bought. Four fences answer that: the price is ', B('time-weighted'), ' over a window instead of read off one moment, a pool below a minimum ', B('depth'), ' is refused in words rather than priced badly, the reserve one account can create this way in one epoch is capped, and the burn must be a transfer that really happened on Base. The numbers are printed on the card itself.'),
        P(B('And the two burns are not equally provable. '), 'The bitcoin address is a commitment to a script that cannot be satisfied: unspendable by arithmetic, and anyone can check the arithmetic. The PEER sink is a ', B('dead address'), ' — unspendable because nobody knows a key for it, which rests on the size of a search space rather than on a proof. The deployed token refuses transfers to the zero address deliberately, so a nonzero dead address is the only sink available. Note also what a PEER burn never buys: it credits reserve, the right to act, and adds nothing to the satoshis destroyed on the Bitcoin chain — which is the weight the epoch mint shares out and the weight the writer election counts.'),
        P('Both doors stay open, and neither replaces the other. ', jump('open pools', 'econ/pools'))),""",
    'the guide explains the second door where the four new terms point',
)


# ── 3. The card ───────────────────────────────────────────────────────────
once(
    r"""  function econTab(st) {
""",
    r"""  /**
   * Burning PEER for reserve — the second door, and the only one with a price.
   *
   * The sentences on this card are in this order for a reason:
   *
   *   1. Reserve is value destroyed. Bitcoin at an address with no key is one
   *      way; the PEER ERC-20 at a dead address is a second. Same rate.
   *   2. It is NOT the epoch token. This tab counts PEER that lives in the act
   *      log and on no chain, and says at length that the two do not convert.
   *      A door that quietly implied otherwise would undo that in one card.
   *   3. The two doors are NOT equally provable, and this tab is where both are
   *      visible. The wording comes from the engine
   *      (st.peerBurn.limits.provenance) rather than being phrased here, so
   *      there is one sentence to keep true instead of two to keep matching.
   *   4. The price MOVES. Anything quoted here is one moment's answer from a
   *      contract anybody can trade against; what gets credited is what the
   *      HOST verified when it verified it.
   *   5. What it never buys: reserve only. Never a share of the epoch mint,
   *      never a vote in the writer election — those read satoshis proved
   *      destroyed on the Bitcoin chain, and this door does not write them.
   *
   * Every constant printed comes from the shared engine, never from this file:
   * the page, the host door and replay must refuse in the same words with the
   * same numbers, and a screen that says 'at most 100' while replay enforces
   * something else is the interface lying on the network's behalf.
   *
   * And when there is no price the card draws no amount box and no button. That
   * is today's real state everywhere — no pools factory is deployed, so there
   * is no official pool to read — and it is rendered as the paragraph it is,
   * beside the bitcoin door, which works. Same rule as the pool-opening form
   * further down this tab.
   */
  function peerBurnCard(st) {
    var card = h('div', { class: 'card', style: 'margin-top:14px' },
      h('h2', { text: 'Burn PEER for reserve — the second door' }));
    var lim = st && st.peerBurn && st.peerBurn.limits;
    if (!lim) {
      // An engine with no peerBurn rules in it. Everything below would be this
      // page inventing what a host will accept, which is the one thing a card
      // about a price must never do.
      card.appendChild(h('p', { class: 'smallnote', text: 'This page is running an engine with no PEER burn rules in it, so every limit and every rate this card would print would be one the page made up. Nothing is drawn. The bitcoin door is unaffected and works as it always did.' }));
      return card;
    }
    var satsPer = Math.max(1, Number(lim.satsPerReserve) || 100);
    var minPoolSats = /^[0-9]+$/.test(String(lim.minPoolSats)) ? String(lim.minPoolSats) : '0';
    var twapMs = Number(lim.twapMs) || 0;
    var twapObs = Number(lim.twapObs) || 0;
    var perEpoch = Number(lim.reservePerEpoch) || 0;
    var dead = String(lim.addr || '');

    // ── the two doors ──
    card.appendChild(h('p', { class: 'smallnote' },
      term('reserve', 'Reserve'), ' is value destroyed, and it is the only thing here that buys the right to act. There are two ways to destroy value. Burning bitcoin at an address with no key is the door this network opened with. Destroying the PEER token on Base is the second: the ',
      term('officialPool', 'official pool'), ' is asked what that many PEER would fetch in cbBTC, which is already a number of satoshis, and the burn credits reserve at ' + satsPer + ' sat to 1 — the same rate the bitcoin door uses. Both doors stay open; neither replaces the other.'));

    // ── which PEER this is, said again rather than assumed ──
    card.appendChild(h('p', { class: 'smallnote', text: 'The PEER destroyed here is the ERC-20 on Base — the coin in the card above, the one a wallet can hold. It is not the epoch token counted further up this tab, and this door does not join them: no epoch PEER is spent, none is created, and there is still no exchange rate between the two and no bridge in either direction. What crosses here is value, not either token.' }));

    // ── the provenance difference, in the engine's words ──
    card.appendChild(h('p', { class: 'smallnote' },
      h('b', { text: 'The two burns are not equally provable. ' }),
      String(lim.provenance || ''), ' The sink is a ', term('deadAddr', 'dead address'),
      ' and it has to be: the deployed PEER token refuses transfers to address(0) on purpose, so there is no zero-address burn to be had.'));
    if (dead) {
      var addrRow = h('p', { class: 'smallnote' },
        h('span', { class: 'num', style: 'word-break:break-all', text: dead }),
        ' · where a PEER burn must pay. A burn to anywhere else is not a burn here, whatever it cost. ');
      var sc = l2ScanLink(8453, 'address', dead, 'on basescan');
      if (sc) addrRow.appendChild(sc);
      card.appendChild(addrRow);
    }

    // ── what it never buys ──
    card.appendChild(h('p', { class: 'smallnote' },
      h('b', { text: 'What this door never buys. ' }),
      'A PEER burn credits reserve — the right to speak — and touches nothing else. It adds nothing to the satoshis you have proved destroyed on the Bitcoin chain, and that is the weight the epoch mint shares out and the weight the writer election counts. So the most a pushed price could ever buy through here is speech, capped per account per epoch. It can never buy a share of the mint or a vote for the writer.'));

    // ── the price moves ──
    card.appendChild(h('p', { class: 'smallnote' },
      h('b', { text: 'Any quote here is one moment’s answer. ' }),
      'The pool is a contract anyone may trade against, so its price moves, and a thin one moves a long way on a single trade. What gets credited is what the HOST verifies at the moment it verifies it, from its own ',
      term('twap', 'time-weighted'), ' reading of the pool — not what this screen showed when the button was pressed. If those differ, the host’s reading is the one that enters the log, and it is the one replay checks the act against.'));

    // ── the arithmetic, because this is the number that decides who can speak ──
    card.appendChild(h('p', { class: 'eyebrow', style: 'margin:14px 0 4px', text: 'the arithmetic' }));
    card.appendChild(fbox('sats    = floor( N × poolBTC / (poolPEER + N) )\nreserve = sats / ' + satsPer));
    card.appendChild(h('p', { class: 'smallnote', text: 'N is the raw PEER destroyed and poolPEER / poolBTC are the pool’s two sides, all as whole numbers. That is what the pool would actually PAY for N PEER — not the ratio between its two sides. The ratio is a price no trade can get: a burn big enough to move the pool would credit satoshis nobody could ever have realised. It also gives a ceiling for free — no burn, however enormous, is worth more than the whole bitcoin side of the pool. Nothing is taken off for a fee, because nothing is sold: the PEER is destroyed and the pool’s reserves do not move.' }));
    card.appendChild(h('p', { class: 'smallnote', text: 'There is no conversion constant in that line and no euro anywhere in it. cbBTC has 8 decimals, so one raw cbBTC unit IS one satoshi, and PEER’s 18 decimals cancel between the top and the bottom.' }));

    // ── the fences, with their numbers ──
    card.appendChild(h('p', { class: 'eyebrow', style: 'margin:14px 0 4px', text: 'the rules this door runs under' }));
    var rules = h('div', { class: 'kv' });
    function rule(label, value) {
      rules.appendChild(label);
      rules.appendChild(h('b', { class: 'num', text: value }));
    }
    rule(h('span', {}, 'credited at'), satsPer + ' sat = 1 reserve');
    rule(h('span', {}, 'the pool’s bitcoin side, at least (', term('poolDepth', 'depth'), ')'),
      l2Human(minPoolSats, 0) + ' sat · ' + (Number(minPoolSats) / 1e8).toFixed(8) + ' cbBTC');
    rule(h('span', {}, 'the price, ', term('twap', 'time-weighted'), ' over'),
      Math.round(twapMs / 60000) + ' min · ' + twapObs + '+ readings');
    rule(h('span', {}, 'most reserve this door creates'), perEpoch + ' per account per epoch');
    // The ceiling is keyed by the number of epochs CLOSED, which is one less
    // than epochNow — epochNow counts the open one. Reading it with the wrong
    // key would print a full allowance to somebody who had just spent it.
    if (who) {
      var used = (st.peerBurn.usedThisEpoch && st.peerBurn.usedThisEpoch[who + '@' + (st.epochNow - 1)]) || 0;
      rule(h('span', {}, 'your headroom this epoch'), fmt(Math.max(0, perEpoch - used), 2) + ' reserve');
    }
    card.appendChild(rules);
    card.appendChild(h('p', { class: 'smallnote', text: 'Every one of those is a choice about the price of speech, not a discovered quantity, and each is read from the shared engine rather than written into this page — so what this card refuses and what replay refuses cannot drift apart. A burn over the ceiling is not trimmed to fit and not lost: it stays on the chain and stays valid, and the rest is claimable after the next epoch closes.' }));

    // ── and then: what is actually possible on this host, right now ──
    //
    // The host door, which this page reads and never second-guesses:
    //
    //   GET  /api/peerburn?peer=<amount>&as=<handle>
    //          { accepting, address, provenance, priceMayMove,
    //            pool:  { poolId, factory, creator, nameNote },
    //            quote: { available, amtRaw, resPeerRaw, resBtcRaw,
    //                     twapMs, observations, sats, reserve }
    //                   | { available: false, code, why },
    //            you:   { boundAddress, reserveLeftThisEpoch } }
    //          404  { code: 'PEERBURN_OFF', accepting: false, why, missing[],
    //                 bitcoinDoor }
    //   POST /api/peerburn/claim  { id, auth, txid }
    //
    // The price is the HOST's reading, over its own window, and this page does
    // not fetch a pool itself: a spot price read here would carry none of the
    // fences and would still look exactly like a quote. What the page DOES do
    // is recheck — the satoshis are recomputed from the reserves the same
    // answer published, and a disagreement is printed loudly rather than
    // smoothed over, because that disagreement is precisely what replay
    // refuses a filed act for.
    var DOOR = '/api/peerburn';
    var stateBox = h('div', { style: 'margin-top:12px' });
    card.appendChild(stateBox);
    drawState();
    return card;

    /** A formula in the figure face. `.guide .formula` is scoped to the guide. */
    function fbox(text) {
      return h('div', { class: 'num', style: 'font-size:12px; background:var(--card-2); border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin:8px 0; overflow-x:auto; white-space:pre-wrap' , text: text });
    }
    function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
    function rawStr(v) { return typeof v === 'string' && /^[0-9]+$/.test(v) ? v : null; }
    /** An amount of PEER as text, or null — the only thing sent to the host. */
    function amtText(t) {
      var v = String(t == null ? '' : t).trim();
      return /^[0-9]{0,12}(\.[0-9]{0,18})?$/.test(v) && v !== '' && v !== '.' && Number(v) > 0 ? v : null;
    }
    /**
     * The constant-product OUTPUT, in satoshis — transcribed from the engine's
     * peerBurnSats rather than reinvented. It exists here to CHECK the host's
     * answer against the host's own published reserves, not to price anything:
     * a page that quoted one number while the host credited another would
     * leave every reader thinking one of the two was cheating.
     */
    function quoteSats(amtRaw, rpRaw, rbRaw) {
      try {
        var amt = BigInt(amtRaw), rp = BigInt(rpRaw), rb = BigInt(rbRaw);
        if (amt <= 0n || rp <= 0n || rb <= 0n) return null;
        var n = (amt * rb) / (rp + amt);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        return Number(n);
      } catch (e) { return null; }
    }
    // status 0 means 'nothing was reached', which is a different sentence from
    // any status a host can answer with. try/catch as well as .catch: a browser
    // with no fetch at all, or an archive page opened from a file, throws on
    // the call itself rather than rejecting — and a card that threw here would
    // take the whole Economy tab down with it.
    function askJSON(path) {
      try {
        return fetch(API + path, { cache: 'no-store' })
          .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; },
            function () { return { status: r.status, d: null }; }); })
          .catch(function () { return { status: 0, d: null }; });
      } catch (e) { return Promise.resolve({ status: 0, d: null }); }
    }
    function askDoor(amount) {
      var q = [];
      if (amount) q.push('peer=' + encodeURIComponent(amount));
      if (who) q.push('as=' + encodeURIComponent(who));
      return askJSON(DOOR + (q.length ? '?' + q.join('&') : ''));
    }

    function drawState() {
      stateBox.appendChild(h('p', { class: 'smallnote', text: 'Asking this host what it can price…' }));
      // One PEER, so the answer carries a quote object whose reserves and
      // window can be shown and checked before anybody types anything.
      Promise.all([askDoor('1'), askJSON('/api/token/onchain')]).then(function (r) {
        var d = obj(r[0].d);
        if (d && d.accepting === true) drawOpen(d, obj(r[1].d));
        else drawShut(r[0], r[1]);
      });
    }

    /**
     * No price. Which piece is missing is asked of BOTH the burn door and the
     * chain config, and both answers are printed: 'this host serves no PEER
     * door' and 'nobody has deployed a pool to price against' are different
     * failures with different people who can fix them, and one sentence
     * covering both would send the operator after the wrong one.
     */
    function drawShut(door, oc) {
      stateBox.innerHTML = '';
      stateBox.appendChild(h('p', { class: 'eyebrow', style: 'margin:0 0 6px', text: 'right now: there is no price, so this door is shut' }));
      var lines = [];
      var d = obj(door.d);
      if (!d || door.status === 0) {
        lines.push(door.status === 0
          ? 'This page could not reach the host at all, so it cannot say whether a PEER burn would be accepted — and it will not guess.'
          : 'This host serves no PEER burn door: nothing answers at ' + DOOR + '. There is nothing here that could verify a transfer or read a pool, and a page cannot open a door the host does not have.');
      } else {
        lines.push('The host’s own answer: ' + String(d.why || d.error || 'it is not accepting PEER burns, and it did not say why.'));
        if (Array.isArray(d.missing) && d.missing.length) {
          lines.push('It named what is missing: ' + d.missing.map(String).join(', ') + '. Those are the operator’s to set, not yours.');
        }
      }
      var o = obj(oc.d);
      if (!o) {
        lines.push('It also could not be asked what is deployed on the chain, so this card cannot even name which piece is missing.');
      } else if (!o.token) {
        lines.push('No PEER token is configured on this host (PEER_TOKEN_ADDR is unset), so there is no ERC-20 here to destroy.');
      } else if (!o.namedPools) {
        lines.push('The PEER token is deployed at ' + String(o.token) + ', but no pools factory is: PEER_POOLS_ADDR is unset on this host, so there is no contract holding a PEER/cbBTC pool, no official pool to name, and therefore no price to read. That is the operator’s move and not yours — chain-l2/DEPLOY.md is the runbook for it.');
      } else if (o.namedPools.error) {
        lines.push('The pools factory this host names did not read: ' + String(o.namedPools.error));
      } else if (!(o.namedPools.pools && o.namedPools.pools.length)) {
        lines.push('A pools factory is configured and it holds no pool yet, so there are no reserves anywhere to price a burn against.');
      } else {
        lines.push('Pools exist on this host, but it names no official one to price a burn against — and a page that picked one for itself would be choosing whose price counts, which is precisely what this door must never do.');
      }
      lines.forEach(function (t) { stateBox.appendChild(h('p', { class: 'smallnote', text: t })); });
      stateBox.appendChild(h('p', { class: 'smallnote', text: 'So there is no amount box here and no button: a control that cannot work is worse than none, and a price this page invented would be exactly the number nobody should trust. Nothing above is affected — the reserve you hold and every bitcoin burn ever recorded are untouched by this door being shut.' }));
      stateBox.appendChild(h('div', { class: 'mini-form persistent' },
        h('span', { class: 'smallnote', text: 'The other door needs no pool and no price, and it is open:' }),
        h('button', { class: 'btn small primary', text: 'Burn bitcoin →', onclick: function () { burnDialog(); } })));
    }

    /**
     * The door is on. That is still not the same as a usable price — a pool can
     * be too thin or a window too short to have one — so the quote's own
     * verdict decides whether an amount box is drawn at all.
     */
    function drawOpen(d, oc) {
      stateBox.innerHTML = '';
      var pool = obj(d.pool), you = obj(d.you), q = obj(d.quote);
      var sink = /^0x[0-9a-fA-F]{40}$/.test(String(d.address)) ? String(d.address) : dead;

      stateBox.appendChild(h('p', { class: 'eyebrow', style: 'margin:0 0 6px', text: 'this host prices PEER burns' }));
      if (pool && pool.poolId != null) {
        stateBox.appendChild(h('div', { class: 'kv' },
          h('span', {}, term('officialPool', 'the official pool')), h('b', { class: 'num', text: 'id ' + String(pool.poolId) }),
          h('span', { text: 'in the factory' }), h('b', { class: 'num', text: l2ShortHex(String(pool.factory || '—')) }),
          h('span', { text: 'opened by' }), h('b', { class: 'num', text: l2ShortHex(String(pool.creator || '—')) })));
        if (pool.nameNote) stateBox.appendChild(h('p', { class: 'smallnote', text: String(pool.nameNote) }));
      } else {
        stateBox.appendChild(h('p', { class: 'smallnote', text: 'This host did not say WHICH pool it prices against, and two reserve numbers with no pool behind them are not an auditable price — anyone may open a pool and give it any name. Nothing is quoted until it says.' }));
        return;
      }

      if (!q || q.available !== true) {
        stateBox.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'There is no usable price at this moment: ' + String((q && (q.why || q.code)) || 'the host published no quote.') }));
        stateBox.appendChild(h('p', { class: 'smallnote', text: 'The door is on and the pool exists; what is missing is a price this network will stand behind. No amount box is drawn for a quote that does not exist, and nothing here will offer to destroy PEER at a number nobody would honour.' }));
        stateBox.appendChild(h('div', { class: 'mini-form persistent' },
          h('span', { class: 'smallnote', text: 'The bitcoin door has no price to lose:' }),
          h('button', { class: 'btn small primary', text: 'Burn bitcoin →', onclick: function () { burnDialog(); } })));
        return;
      }

      // How the burn finds its owner. Said BEFORE the box, because it is the
      // one thing that decides whether destroyed PEER credits anybody at all.
      stateBox.appendChild(h('p', { class: 'smallnote', text: 'A PEER burn is credited to whichever handle has BOUND the address it was sent from — the same binding the epoch-earnings card above uses, read out of the public act log. Nothing needs to stay open: the host watches the dead address on its own tick and credits any transfer from a bound address whether or not this page exists. PEER sent from an address no handle has bound is destroyed and credited to nobody.' }));
      if (who && you && you.boundAddress) {
        stateBox.appendChild(h('p', { class: 'smallnote', text: 'This handle is bound to ' + String(you.boundAddress) + ' — that is the only address whose burns count as yours.' }));
      } else if (who) {
        stateBox.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'This handle has no address bound to it, so a burn made now would credit nobody. Bind one in the card above first — it is free and costs no θ.' }));
      }

      var winMs = Number(q.twapMs) || 0, obs = Number(q.observations) || 0;
      var amt = h('input', { type: 'text', value: '', placeholder: '0', style: 'width:130px', inputmode: 'decimal' });
      stateBox.appendChild(h('div', { class: 'mini-form persistent' },
        h('span', { class: 'smallnote', text: 'PEER to destroy' }), amt,
        h('span', { class: 'smallnote', text: 'the host re-quotes as you type' })));
      var work = h('div', {});
      var actions = h('div', { class: 'mini-form persistent' });
      var euroLine = h('p', { class: 'smallnote' });
      var log = h('div', { style: 'margin-top:8px' });
      stateBox.appendChild(work);
      stateBox.appendChild(actions);
      // The euro figure lives here, after the arithmetic and after the button,
      // and is never spoken in the same breath as the reserve maths. It is a
      // label: when its source is down, a label is what is lost.
      stateBox.appendChild(euroLine);
      stateBox.appendChild(log);
      // var(--bad) inline: `.bad` was never a rule in this stylesheet, so a
      // refusal styled with it renders in the same grey as everything else.
      function say(t, cls) { log.appendChild(h('div', { class: 'smallnote', style: cls === 'bad' ? 'color:var(--bad)' : (cls === 'ok' ? 'color:var(--moss)' : ''), text: t })); }

      var cur = q;            // the host's latest quote
      var ready = null;       // what may be burned right now, or null
      var timer = null;

      draw();
      amt.addEventListener('input', function () {
        var text = amtText(amt.value);
        ready = null;
        actions.innerHTML = '';
        if (timer) clearTimeout(timer);
        if (!text) { draw(); return; }
        work.innerHTML = '';
        work.appendChild(h('p', { class: 'smallnote', text: 'Asking the host what ' + text + ' PEER is worth…' }));
        // Debounced, because every keystroke is a chain read on the host's
        // side. The screen says it is asking rather than leaving a stale
        // number sitting under a changed amount.
        timer = setTimeout(function () {
          askDoor(text).then(function (r) {
            var d2 = obj(r.d);
            if (amtText(amt.value) !== text) return;      // typed on since
            if (d2 && obj(d2.quote)) { cur = d2.quote; if (obj(d2.you)) you = obj(d2.you); }
            draw();
          });
        }, 450);
      });

      function draw() {
        work.innerHTML = '';
        euroLine.textContent = '';
        ready = null;
        var rp = rawStr(cur.resPeerRaw), rb = rawStr(cur.resBtcRaw), raw = rawStr(cur.amtRaw);
        if (!rp || !rb) {
          work.appendChild(h('p', { class: 'smallnote', text: 'The host answered without readable reserves, so there is nothing to check its price against and nothing is shown. Two numbers that cannot be rechecked are worse than none.' }));
          drawActions();
          return;
        }
        // What the pool holds, and over what window — printed whatever the
        // amount is, because these are the numbers the quote is made of.
        work.appendChild(h('div', { class: 'kv' },
          h('span', { text: 'the pool holds' }), h('b', { class: 'num', text: l2Human(rp, 18) + ' PEER · ' + l2Human(rb, 0) + ' sat' }),
          h('span', {}, term('twap', 'averaged'), ' over'), h('b', { class: 'num', text: Math.round((Number(cur.twapMs) || winMs) / 60000) + ' min · ' + (Number(cur.observations) || obs) + ' readings' })));
        if (!amtText(amt.value)) {
          work.appendChild(h('p', { class: 'smallnote', text: 'Say how much PEER to destroy and the whole calculation appears here, from the host’s reading, before anything is signed.' }));
          drawActions();
          return;
        }
        if (!raw) {
          work.appendChild(h('p', { class: 'smallnote', text: 'The host did not answer with a raw amount for that figure, so there is nothing to price. Nothing is shown.' }));
          drawActions();
          return;
        }
        var mine = quoteSats(raw, rp, rb);
        var theirs = Number(cur.sats);
        work.appendChild(fbox(
          'N       = ' + raw + '  (' + l2Human(raw, 18) + ' PEER)\n' +
          'pool    = ' + rp + ' PEER raw\n' +
          '          ' + rb + ' sat\n' +
          'sats    = floor(' + raw + ' × ' + rb + ' / (' + rp + ' + ' + raw + '))\n' +
          '        = ' + mine + ' sat\n' +
          'reserve = ' + mine + ' / ' + satsPer + ' = ' + (mine === null ? '—' : mine / satsPer)));
        if (mine === null) {
          work.appendChild(h('p', { class: 'smallnote', text: 'That is more satoshis than will ever exist, so nothing is offered.' }));
          drawActions();
          return;
        }
        // The recheck. This is the whole reason the reserves are published.
        if (isFinite(theirs) && theirs !== mine) {
          work.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'This host quotes ' + theirs + ' sat, and its own published reserves produce ' + mine + '. A host that disagrees with itself is not evidence of anything, and an act recording that pair is one replay refuses outright. Nothing is offered here until the two agree.' }));
          drawActions();
          return;
        }
        var reserve = mine / satsPer;
        work.appendChild(h('p', { class: 'smallnote', text: 'That reserve is ' + Math.floor(reserve / THETA) + ' act' + (Math.floor(reserve / THETA) === 1 ? '' : 's') + ' at θ ' + fmt(THETA, 4) + ' each. It is the host’s reading as of a moment ago; what gets credited is what it reads when it verifies the transfer.' }));
        var refuse = [];
        try {
          if (BigInt(rb) < BigInt(minPoolSats)) refuse.push('This pool holds ' + l2Human(rb, 0) + ' sat and a burn needs at least ' + l2Human(minPoolSats, 0) + ' — below that a pool has no price, only a last trade, so a burn is refused rather than priced badly.');
        } catch (e) { /* unreadable reserves were caught above */ }
        var w2 = Number(cur.twapMs) || 0, o2 = Number(cur.observations) || 0;
        if (!(w2 >= twapMs) || !(o2 >= twapObs)) refuse.push('This price was averaged over ' + Math.round(w2 / 60000) + ' min from ' + o2 + ' reading(s), and this network requires ' + Math.round(twapMs / 60000) + ' min from ' + twapObs + '. A spot price can be bought for the length of one block.');
        var left = you && isFinite(Number(you.reserveLeftThisEpoch)) ? Number(you.reserveLeftThisEpoch) : null;
        if (who && left !== null && reserve > left) refuse.push('This would create ' + reserve + ' reserve and you have ' + fmt(left, 2) + ' of your ' + perEpoch + ' left this epoch. A burn over the ceiling is refused whole rather than trimmed — so burn less now, or burn this much after the next epoch closes.');
        refuse.forEach(function (t) { work.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: t })); });
        if (!refuse.length) ready = { raw: raw, sats: mine, reserve: reserve };
        // The label, and only where the host quoted a rate to make it from.
        var eurPerBtc = Number(d.eurPerBtc);
        if (isFinite(eurPerBtc) && eurPerBtc > 0) {
          euroLine.textContent = 'For humans only: about €' + (mine / 1e8 * eurPerBtc).toFixed(2) + ' at the €' + eurPerBtc.toFixed(0) + '/BTC rate this host quoted' + (d.eurSource ? ' from ' + String(d.eurSource) : '') + '. It is a label. It enters none of the arithmetic above, and if that source goes down this line disappears and nothing else changes.';
        } else {
          euroLine.textContent = 'This host quotes no euro rate, so there is no euro figure here. Nothing is missing: a euro number never enters any of the arithmetic above.';
        }
        drawActions();
      }

      function drawActions() {
        actions.innerHTML = '';
        var token = oc && typeof oc.token === 'string' ? oc.token : null;
        var chainHex = oc ? l2ChainHex(Number(oc.chainId)) : null;
        function note(t) { actions.appendChild(h('span', { class: 'smallnote', text: t })); }
        if (!who) { note('Sign in to a handle first: a burn is credited to a handle, and there is none here to credit.'); return; }
        if (!you || !you.boundAddress) { note('No button until this handle has an address bound to it — PEER destroyed from an unbound address credits nobody, and no host can undo that.'); return; }
        if (!token || !chainHex) { note('This host did not say which token on which chain to send, so nothing here will build a transfer: an ERC-20 transfer aimed at a guess is money destroyed for nothing.'); return; }
        if (!window.ethereum) { note('No wallet in this browser, so nothing here can sign. The transfer is an ordinary ERC-20 send of PEER to the address above, from the bound address, in any wallet — the host credits it on its own tick.'); return; }
        if (l2Wallet && String(l2Wallet).toLowerCase() !== String(you.boundAddress).toLowerCase()) {
          note('The connected wallet is ' + l2ShortHex(l2Wallet) + ' and this handle is bound to ' + l2ShortHex(String(you.boundAddress)) + '. A burn from the connected one would not be yours, so no button is drawn: switch the wallet, or bind that address above.');
          return;
        }
        if (!ready) { note('No button until there is an amount this network would accept.'); return; }
        var go = h('button', { class: 'btn small danger', text: 'Destroy ' + l2Human(ready.raw, 18) + ' PEER →', onclick: function () {
          go.disabled = true;
          send(ready, token, chainHex).catch(function (e) { say('not sent: ' + l2Err(e), 'bad'); go.disabled = false; });
        } });
        actions.appendChild(go);
        note('Red because it cannot be undone. It transfers the PEER to the dead address; nobody receives it, and no host can give it back. The reserve credited is whatever the host verifies afterwards from its own reading of the pool — not the figure above.');
      }

      /**
       * One ERC-20 transfer, signed by the user's own wallet, and then the hash
       * handed over. The page verifies nothing and prices nothing: the host
       * reads the transfer and the pool itself, which is the only reason the
       * number it records is worth anything. Filing the hash only hurries it —
       * the watcher credits a transfer from a bound address on its own tick.
       */
      async function send(r, token, chainHex) {
        var acct = l2Wallet || await l2Connect(chainHex, l2ChainName(Number(oc.chainId)));
        if (!acct) return;                       // l2Connect already said why
        if (String(acct).toLowerCase() !== String(you.boundAddress).toLowerCase()) {
          say('That wallet is ' + acct + ', and this handle is bound to ' + you.boundAddress + '. Nothing was sent — a burn from the wrong address is destroyed PEER credited to somebody else, or to nobody.', 'bad');
          drawActions();
          return;
        }
        var chain = await l2Eth('eth_chainId');
        if (!l2OnChain(chain, chainHex)) { say('That wallet is on chain ' + chain + ' now. Nothing was sent — a transfer on the wrong chain moves some other token.', 'bad'); return; }
        // transfer(address,uint256) — the selector beside its signature, this
        // file's standing policy: no keccak library in the page.
        var data = '0xa9059cbb' + l2Addr(sink) + BigInt(r.raw).toString(16).padStart(64, '0');
        say('The wallet will ask you to confirm. Check the destination against the dead address above before approving.');
        var txid = await l2Eth('eth_sendTransaction', [{ from: acct, to: token, data: data }]);
        say('sent: ' + String(txid), 'ok');
        var link = l2ScanLink(8453, 'tx', txid, 'check it on basescan');
        if (link) log.appendChild(h('div', {}, link));
        say('The PEER is gone from here on. It is credited when the host verifies the transfer — you can close this page: the watcher does it without you.');
        withUnlock(function () {
          fetch(API + DOOR + '/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: who, auth: pins[who] || '', txid: txid }) })
            .then(function (x) { return x.json().then(function (b) { return { ok: x.ok, b: b }; }); })
            .then(function (x) {
              if (!x.ok) {
                say('The host did not record it yet: ' + String((x.b && (x.b.error || x.b.why)) || 'refused') + ' — keep that hash. The burn is on the chain and stays valid, so the watcher or a later claim can still take it.', 'bad');
                return;
              }
              say('Recorded: ' + String(x.b.sats) + ' sat → ' + String(x.b.reserve) + ' reserve, at the pool the host read itself.', 'ok');
              pollRemote();
            })
            .catch(function () { say('Could not reach the host to file the hash — keep it. The burn is on the chain and the watcher credits it anyway.', 'bad'); });
        }, function () {
          say('Not filed from here: the session is locked. The burn is still on the chain and the watcher still credits it, because it is attributed by the address it came from, not by this page.', 'bad');
        });
      }
    }
  }

  function econTab(st) {
""",
    'peerBurnCard: the second door, with its arithmetic and its shut state',
)


# ── 4. Where it sits ──────────────────────────────────────────────────────
once(
    r"""      wrap.appendChild(l2ClaimCard(st));
""",
    r"""      wrap.appendChild(l2ClaimCard(st));
      // The second door into reserve, under BOTH of them, because it needs
      // both to have been read first: it prices the coin on Base (the card
      // above) and it must not be taken for the epoch token (the card above
      // that). Last rather than between them, so the token card's sentence
      // about 'the card below this one' still names the claim card.
      wrap.appendChild(peerBurnCard(st));
""",
    'the card is drawn in Economy > Wallet, under the coin and the claim',
)


# ── 5. The bitcoin panel names the other door ─────────────────────────────
# This is the second place both doors are visible, so it owes the reader the
# same sentence about which of the two is a proof.
once(
    r"""    var amt = h('input', { type: 'text', value: '2000', style: 'width:110px', inputmode: 'numeric' });
""",
    r"""    var second = h('div', { class: 'smallnote', style: 'margin-top:8px' },
      h('b', { text: 'There is a second door. ' }),
      'Destroying PEER on Base credits reserve too, priced by the official PEER/cbBTC pool. It is not the same kind of thing as this one, and the difference is worth knowing before choosing: this address is a commitment to a script that cannot be satisfied, so it is unspendable by arithmetic anyone can check, while the PEER sink is unspendable only because nobody knows a key for it. A PEER burn also buys the right to speak and nothing more — no share of the epoch mint and no vote in the writer election, both of which this burn does buy. ');
    second.appendChild(h('button', { class: 'btn small ghost', text: 'the PEER door →', onclick: function () {
      box.remove();
      tab = 'econ'; econView = 'wallet'; saveView(); render();
    } }));
    box.appendChild(second);
    var amt = h('input', { type: 'text', value: '2000', style: 'width:110px', inputmode: 'numeric' });
""",
    'the bitcoin panel names the PEER door, and the difference between them',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
