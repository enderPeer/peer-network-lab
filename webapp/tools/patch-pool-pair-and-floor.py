# The pool card says which two coins it is actually about, and the first-add
# panel says what the floor costs.
#
# TWO DEFECTS, both of the same kind: a number on screen that is right about
# something other than what the buttons underneath it do.
#
# 1. THE PAIR. Every approve, add and swap on this card targets the two tokens
#    read off the POOL — ocGetTokens asks it for peer() and btc(), its own
#    immutables — but the decimals the amounts were SCALED by came from the
#    host's configured addresses. Those are two different pairs and nothing
#    checked that they agree. The comment above the scaling asserted the
#    opposite ("the two decimals come from the reader, which asked the two
#    token contracts") and then, two lines down, named the exact hazard: a
#    display scaled by the wrong figure is wrong by a hundred million while
#    looking perfectly ordinary.
#
#    The reader now asks the pool (chain-l2/onchain.mjs, checkPair) and hands
#    over three things this file did not have: pool.tokens, decimals derived
#    from THOSE two contracts, and pool.mismatch when they disagree with what
#    the operator configured. The factory reader that this design replaced did
#    exactly this and printed the sentence FIRST, above everything; the check
#    went out with the factory and it was never the factory's. It comes back
#    here, in the same position and for the same reason.
#
# 2. THE FLOOR. openingPanel says "1000 share units are locked forever" as a
#    COUNT with no denominator, beside an invitation to seed the pool as small
#    as you like. Both are true and together they mislead: the locked amount is
#    FIXED, so it is 0.000000003% of a serious seed and 95.4% of one just over
#    the floor. Somebody who takes the invitation literally donates most of
#    their money to an address nobody can sign from, having read three
#    documents that told them the floor was free. The live ratio line — which
#    already recomputes on every keystroke — now prints the fraction, and gets
#    louder when it is above one percent.
#
#    MIN_LIQ is read from the deployed contract, never pasted from the source,
#    for the reason the button path already reads it: a page that hardcodes it
#    is describing a different contract than the one taking the money. Until
#    that read answers — or if there is no wallet to ask through — the clause
#    is simply left out. An invented percentage on that line would be worse
#    than none.
#
# Run:  python tools/patch-pool-pair-and-floor.py && node social/assemble.mjs
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


# ══ 1. Where the scaling comes from ═══════════════════════════════════════
once(
    r"""        // The two decimals come from the reader, which asked the two token
        // contracts. 18 and 8 are the expected answers and never the assumed
        // ones: cbBTC carries 8, which is why one raw unit of it is one
        // satoshi, and a display scaled by the wrong figure is wrong by a
        // hundred million while looking perfectly ordinary.""",
    r"""        // The two decimals come from the reader, which asked the POOL which
        // two tokens it moves — peer() and btc(), the immutables it was
        // deployed with — and then asked those two contracts for their
        // decimals. That is the same pair ocGetTokens reads below for every
        // approve, every add and every swap, and it has to be: for one release
        // the scaling came from this host's configured addresses while the
        // signatures went to the pool's own pair, so this card displayed one
        // market and signed against another. 18 and 8 are the expected answers
        // and never the assumed ones: cbBTC carries 8, which is why one raw
        // unit of it is one satoshi, and a display scaled by the wrong figure
        // is wrong by a hundred million while looking perfectly ordinary.""",
    'ocRender: the decimals come from the pool’s own pair',
)


# ══ 2. The disagreement, said first ═══════════════════════════════════════
once(
    r"""        // The address, printed and linkable, because with one pool the address
        // IS the identity. There is no name to check it against, which also
        // means there is no name to be fooled by: a reader either has this
        // address or does not, and an explorer settles the rest.""",
    r"""        // The pool names its own two tokens and the reader checks them against
        // the two this host was configured with. Where they disagree that
        // sentence is the endpoint's own, and it goes FIRST — above the
        // address, above the wallet row, above every form — because it means
        // the buttons below move coins the operator did not mean to serve.
        // Nothing is hidden and nothing is disabled: this page cannot know
        // which of the two addresses is the wrong one, and the trades are
        // perfectly real either way. But nobody should approve a token here
        // without having read it. Where the pool would not say at all, that is
        // a weaker statement and gets a quieter line — the amounts are still
        // scaled by something, and this is the disclosure that nothing checked
        // it.
        if (po.mismatch && po.mismatch.error) {
          ocBody.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text: String(po.mismatch.error) }));
        } else if (po.tokensNote) {
          ocBody.appendChild(h('p', { class: 'smallnote', text: String(po.tokensNote) }));
        }

        // The address, printed and linkable, because with one pool the address
        // IS the identity. There is no name to check it against, which also
        // means there is no name to be fooled by: a reader either has this
        // address or does not, and an explorer settles the rest.""",
    'ocRender: a pair that disagrees is said before anything else',
)


# ══ 3. What the floor costs, live, as a fraction ══════════════════════════
once(
    r"""          function cRatio() {
            var vp = ocUnits(cPeer.value, pdec), vb = ocUnits(cBtc.value, bdec);
            if (vp === null || vb === null) {
              cPrice.textContent = 'The two amounts ARE the opening price — there is no market to take one from. Fill both in and the rate they set appears here, both ways round, before anything is signed.';
              return;
            }
            var pf = Number(vp) / Math.pow(10, pdec), bf = Number(vb) / Math.pow(10, bdec);
            cPrice.textContent = 'You are setting the price: 1 PEER = ' + ocPx(bf / pf) + ' BTC, and 1 BTC = ' + ocPx(pf / bf) + ' PEER. That is ' + vb.toString() + ' satoshis against ' + vp.toString() + ' wei, as whole numbers, which is what the contract stores. Nothing else prices PEER against bitcoin, so this ratio is the price until somebody trades against it — and against a pool this thin the first trade moves it a long way, in whichever direction pays the trader. This page also cannot show how the PEER supply is held, so nothing outside this form agrees with the number you are about to set.';
          }""",
    r"""          // MIN_LIQ from the deployed pool, asked once on the way in, so the
          // fraction below is the one THIS contract will lock rather than the
          // one the source happens to say. Null until it answers and null
          // forever if there is no wallet to ask through, and in both cases the
          // sentence is left out: a percentage this page invented would be
          // worse on this line than no percentage at all. When it lands the
          // ratio line is redrawn, because by then somebody may already be
          // typing into it.
          var cMinLiq = null;
          if (window.ethereum) {
            ocMinLiq(pool).then(function (v) { cMinLiq = v; cRatio(); }).catch(function () { /* the clause stays out */ });
          }
          // A percentage for the eye, at every scale this one actually takes:
          // 95.4 down to three billionths of one percent, and never rounded to
          // a flat zero, which would say the opposite of what it means.
          function cPct(x) {
            if (!isFinite(x) || x <= 0) return '0%';
            if (x >= 10) return x.toFixed(1) + '%';
            if (x >= 0.1) return x.toFixed(2) + '%';
            if (x >= 0.0001) return x.toFixed(5).replace(/0+$/, '') + '%';
            return x.toExponential(1) + '%';
          }

          function cRatio() {
            var vp = ocUnits(cPeer.value, pdec), vb = ocUnits(cBtc.value, bdec);
            if (vp === null || vb === null) {
              cPrice.textContent = 'The two amounts ARE the opening price — there is no market to take one from. Fill both in and the rate they set appears here, both ways round, before anything is signed.';
              return;
            }
            var pf = Number(vp) / Math.pow(10, pdec), bf = Number(vb) / Math.pow(10, bdec);
            // What the floor costs THIS deposit, as a fraction rather than as
            // a count. The locked amount is fixed, so it is nothing at any
            // size worth seeding and nearly everything within a factor of a
            // few of the floor — and the count on its own has no denominator
            // to say which of those you are looking at.
            var lock = '';
            if (cMinLiq !== null) {
              var s0 = ocSqrt(vp * vb);
              if (s0 > cMinLiq) {
                var pct = Number(cMinLiq) / Number(s0) * 100;
                lock = ' This opens ' + s0.toString() + ' raw share units, of which ' + cMinLiq.toString() + ' — ' + cPct(pct) + ' of everything you are putting in — is minted to an address nobody can sign from and is gone for good.';
                if (pct >= 1) lock += ' READ THAT FIGURE. It is a real fraction of this deposit, not a rounding error: the locked amount is a fixed number of share units, so it costs nothing at any size worth seeding and almost everything this close to the floor. Raising either amount shrinks it fast.';
              } else {
                lock = ' This is below the only opening the contract refuses: it would mint ' + s0.toString() + ' raw share units, which is sqrt(PEER × cbBTC), and ' + cMinLiq.toString() + ' of them are locked forever — so an opening deposit has to mint more than that. Raising either amount even slightly clears it.';
              }
            }
            cPrice.textContent = 'You are setting the price: 1 PEER = ' + ocPx(bf / pf) + ' BTC, and 1 BTC = ' + ocPx(pf / bf) + ' PEER. That is ' + vb.toString() + ' satoshis against ' + vp.toString() + ' wei, as whole numbers, which is what the contract stores. Nothing else prices PEER against bitcoin, so this ratio is the price until somebody trades against it — and against a pool this thin the first trade moves it a long way, in whichever direction pays the trader. This page also cannot show how the PEER supply is held, so nothing outside this form agrees with the number you are about to set.' + lock;
          }""",
    'openingPanel: the floor is printed as a fraction, live',
)


# ══ 4. And the note under the form stops implying the count is free ═══════
once(
    r"""          box.appendChild(h('p', { class: 'smallnote', text: 'Seed it as small as you like. The contract refuses exactly one opening — a single wei of PEER against a single satoshi — because the opening shares are sqrt(PEER × cbBTC) and that has to clear a floor of 1000 raw units. One whole PEER against one satoshi mints a billion of them. The floor is a floor on the SHARE COUNT, not a minimum investment, and it is there to stop the first depositor being robbed by rounding.' }));""",
    r"""          box.appendChild(h('p', { class: 'smallnote', text: 'Seed it as small as you like. The contract refuses exactly one opening — a single wei of PEER against a single satoshi — because the opening shares are sqrt(PEER × cbBTC) and that has to clear a floor of 1000 raw units. One whole PEER against one satoshi mints a billion of them. The floor is a floor on the SHARE COUNT, not a minimum investment, and it is there to stop the first depositor being robbed by rounding.' }));
          box.appendChild(h('p', { class: 'smallnote', text: 'What that floor costs you is a different question from what it refuses, and the line above prints it: those locked units are minted to an address nobody can sign from, so they are a share of this deposit that never comes back. It is a FIXED number of units, which makes it three billionths of one percent of a serious seed and 95% of one a whisker over the floor. Both of those are allowed; only one of them is a good idea.' }));""",
    'openingPanel: the floor’s cost said in prose as well',
)


# ══ 5. The other opening path, one press away, says the same thing ════════
once(
    r"""                if (s0 <= minLiq) {""",
    r"""                // The same fraction the ratio line has been printing, said
                // once more where it is about to become irreversible. Anyone
                // who reached this button read it; nobody should be able to say
                // afterwards that it was only on a line they scrolled past.
                if (s0 > minLiq) {
                  var lockPct = Number(minLiq) / Number(s0) * 100;
                  if (lockPct >= 1) {
                    cSay('This opening mints ' + s0.toString() + ' raw share units and locks ' + minLiq.toString() + ' of them — ' + cPct(lockPct) + ' of this deposit — at an address nobody can sign from. That is not a rounding error at this size. It is allowed and it is not a fault; it is what seeding within a factor of a few of the floor costs, and raising either amount shrinks it fast.', true);
                  }
                }
                if (s0 <= minLiq) {""",
    'openingPanel: the button repeats the fraction when it is large',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
