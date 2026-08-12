# Opening a pool becomes one press instead of a form and three unexplained
# popups.
#
# The complaint this answers, in the operator's words: "there is no eassy way
# in the app to generate them put a easy one click solution where just you
# enter the number of peer tokens you have and then become the lp pool with
# entering also your btc and then signing a contract".
#
# The old form had the right three fields and none of the walkthrough. What it
# actually asked of somebody was: work out your own balances, type them, press
# once, and then answer up to THREE MetaMask prompts arriving with no account
# of which is which — approve PEER, approve cbBTC, createPool. That is the
# shape people abandon halfway through, and abandoning it halfway is not free:
# an approval that landed cost gas and stands, and the old card said so only
# through a toast that vanishes in four seconds.
#
# Five things change, and every one of them is about the press being
# understandable rather than about it being shorter:
#
#   · "max PEER" / "max cbBTC" fill each amount from the wallet's own balance,
#     exactly — ocDec prints every digit, where ocFmt goes through a double
#     and is display only. A max that rounds up reverts after costing gas; one
#     that rounds down silently strands the remainder.
#   · the opening ratio is priced out loud, live, both ways round, directly
#     above the button. With no market the two amounts ARE the price, and that
#     is the most consequential fact on the screen; it was stated nowhere.
#   · the button runs the whole sequence and narrates it: "1 of 3: approving
#     PEER", each leg named while the wallet is asking for it.
#   · every knowable refusal is asked by eth_call BEFORE the first approval,
#     because an approval costs real gas: wrong chain, a factory whose token
#     addresses hold no code (the dead-factory case — a factory deployed with
#     an EOA where the token address belonged answers peer() with a perfectly
#     well-formed address that no ERC-20 lives at), MIN_LIQ, the per-creator
#     name claim, and both balances. The two zero-balance sentences say what
#     the zero MEANS: no cbBTC is the pool's missing second side, and no PEER
#     on Base is not the same fact as the PEER counted in the Wallet tab.
#   · the running account lives OUTSIDE ocBody, because success ends in
#     ocRefresh() which rebuilds ocBody — the sentence saying which legs
#     landed would be wiped by the very redraw that proves it.
#
# House convention in this card, followed here: comments carry real Unicode,
# JS string literals carry backslash-u escapes.
#
# Run:  python tools/patch-one-click-pool.py && node social/assemble.mjs
import io

TP = 'social/template.html'
s = io.open(TP, encoding='utf-8').read()
before = len(s)


def once(old, new, label):
    global s
    old, new = ascii_code(old), ascii_code(new)
    n = s.count(old)
    assert n == 1, 'anchor %r matched %d times, expected exactly 1' % (label, n)
    s = s.replace(old, new, 1)
    print('  patched: ' + label)


def ascii_code(block):
    """The convention this card is written in: COMMENTS carry real Unicode,
    CODE carries backslash-u escapes — 45 of them in this one card already.
    Mixing the two would be worse than either, because the next patch script
    anchors on these lines and has to know which spelling to type.

    Applied to the ANCHORS as well as to the new text, and that is the point:
    this script is written with real dashes and quotes throughout, and every
    string that meets the file is put through here first, so an anchor is
    spelled the way the file spells it without anyone hand-typing an escape.

    Every comment line in the blocks below starts with // and no code line
    carries a trailing comment, so the rule is decidable a line at a time.
    Asserted afterwards rather than assumed."""
    out = []
    for line in block.split('\n'):
        if line.lstrip().startswith('//'):
            out.append(line)
        else:
            out.append(''.join(c if ord(c) < 128 else '\\u%04x' % ord(c) for c in line))
    done = '\n'.join(out)
    for line in done.split('\n'):
        if not line.lstrip().startswith('//'):
            assert all(ord(c) < 128 for c in line), 'a code line kept a raw non-ASCII character: %r' % line
    return done


def span(start, end, new, label, must_contain):
    """Replace start..end inclusive. Both bounds must match exactly once, in
    that order, and the region being removed must contain every landmark
    named — so a span can never quietly swallow a region other than the one
    that was read."""
    global s
    start, end, new = ascii_code(start), ascii_code(end), ascii_code(new)
    assert s.count(start) == 1, 'start anchor for %r matched %d times' % (label, s.count(start))
    assert s.count(end) == 1, 'end anchor for %r matched %d times' % (label, s.count(end))
    i = s.index(start)
    j = s.index(end, i) + len(end)
    assert j > i, 'end anchor precedes start anchor for %r' % label
    cut = s[i:j]
    for m in must_contain:
        assert m in cut, 'the region for %r does not contain %r — wrong span' % (label, m)
    s = s[:i] + new + s[j:]
    print('  patched: %s (%d chars -> %d)' % (label, len(cut), len(new)))


# ── 1. a place to speak that survives the redraw ──────────────────────────
# ocRefresh() re-reads the host and ocRender() rebuilds ocBody from scratch.
# Anything the create sequence wrote into the form is gone the moment it
# succeeds — which is exactly when "here is what you signed, and here is when
# the list catches up" needs to still be on screen. ocSeq is a sibling of
# ocBody, so a redraw of the list leaves it standing.
once(
    r"""      var ocBody = h('div', {});
      ocCard.appendChild(ocBody);
      wrap.appendChild(ocCard);
""",
    r"""      var ocBody = h('div', {});
      ocCard.appendChild(ocBody);
      // Where a multi-step sequence says what it is doing and what it did.
      // Outside ocBody on purpose: ocRefresh() rebuilds ocBody, so an account
      // written inside the form would be erased by the very redraw that shows
      // the pool it opened — and a half-finished sequence's account of which
      // approvals landed is the one thing nobody should have to remember.
      var ocSeq = h('div', {});
      ocCard.appendChild(ocSeq);
      wrap.appendChild(ocCard);
""",
    'ocSeq — a running account that outlives the list redraw',
)

# ── 2. an EXACT decimal, and a price for the eye ──────────────────────────
once(
    r"""        return n >= 0.001 ? String(Math.round(n * 1e6) / 1e6) : n.toExponential(3);
      }
""",
    r"""        return n >= 0.001 ? String(Math.round(n * 1e6) / 1e6) : n.toExponential(3);
      }
      // Raw -> the exact decimal string, every digit of it. This is the one
      // for a FIELD, where ocFmt is the one for a sentence: what sits in an
      // input is parsed straight back into a transaction by ocUnits, and a
      // "max" filled from a double is not the balance. Rounded up it reverts
      // after costing gas; rounded down it silently strands the remainder.
      // This round-trips through ocUnits exactly, by construction.
      function ocDec(raw, dec) {
        var t = BigInt(raw).toString().padStart(dec + 1, '0');
        var whole = t.slice(0, t.length - dec);
        var frac = dec ? t.slice(t.length - dec).replace(/0+$/, '') : '';
        return frac ? whole + '.' + frac : whole;
      }
      // A price for the eye only, in the two shapes the pool rows already
      // use. Nothing that has been through a double is ever signed.
      function ocPx(n) {
        if (!isFinite(n) || n <= 0) return '?';
        return n >= 0.001 ? String(Math.round(n * 1e8) / 1e8) : n.toExponential(3);
      }
""",
    'ocDec (exact) and ocPx (display) beside ocFmt',
)

# ── 3. the balance itself, not just the verdict on it ─────────────────────
once(
    r"""        throw new Error('that wallet holds ' + ocFmt(have, dec) + ' ' + symbol + ' and this needs ' + ocFmt(need, dec) + ' — nothing was signed');
      }
""",
    r"""        throw new Error('that wallet holds ' + ocFmt(have, dec) + ' ' + symbol + ' and this needs ' + ocFmt(need, dec) + ' — nothing was signed');
      }

      // The balance as a number rather than as a verdict. ocHave above asks
      // "is it enough" and throws if it is not, which is the right shape for
      // a trade; opening a pool needs the figure itself — to fill a max field
      // with it, and to tell a wallet that is SHORT from one holding none of
      // that coin at all. Those two want opposite sentences.
      async function ocBal(token, symbol) {
        return ocUint(await ocEth('eth_call', [{ to: token, data: OC_SEL.balanceOf + ocAddr(l2Wallet) }, 'latest']), 'your ' + symbol + ' balance');
      }
""",
    'ocBal — the figure, beside ocHave which is the verdict',
)

# ── 4. no factory: say whose move it is, and draw no button ───────────────
once(
    r"""          ocBody.appendChild(h('p', { class: 'smallnote', text: 'The token is deployed, but the pools factory is not configured (PEER_POOLS_ADDR is unset) — so there is nothing here to trade in yet.' }));
""",
    r"""          ocBody.appendChild(h('p', { class: 'smallnote', text: 'The PEER token is deployed, but no pools factory is: PEER_POOLS_ADDR is unset on this host, so there is no contract here to open a pool in and nothing to trade against. That is the operator’s move and not yours — chain-l2/DEPLOY.md is the runbook for it. The form for opening a pool is deliberately not drawn below, because a button that cannot work is worse than no button.' }));
""",
    'unset PEER_POOLS_ADDR names whose move it is and points at DEPLOY.md',
)

# ── 5. the one-press create ───────────────────────────────────────────────
NEW_CREATE = r"""        // ── open a pool — one press, all the way through ──
        // Three fields and one button. The pair is not one of the fields:
        // every pool this factory can make is PEER against cbBTC, fixed in
        // its immutables at deployment, so offering a choice would be
        // offering a lie.
        //
        // Opening a pool is not one action on chain. It is up to three —
        // approve PEER, approve cbBTC, createPool — and three wallet prompts
        // arriving with no account of which is which is exactly where people
        // stop, having paid for an approval and got no pool. So the button
        // carries all three and names each one while it is on screen.
        //
        // Everything that can refuse this is asked FIRST and asked for FREE.
        // An eth_call costs nothing; an approval costs gas and leaves a
        // standing permission behind, so any refusal discovered after it is a
        // refusal somebody paid for:
        //   · the wallet is connected and answering for Base
        //   · the factory's two token addresses hold actual code
        //   · sqrt(PEER × cbBTC) clears the factory's own MIN_LIQ
        //   · this creator has not used this name before
        //   · this wallet holds both amounts
        //
        // The name is yours alone in one direction only: you cannot reuse one
        // of your own, and somebody else opening theirs under the same word
        // takes nothing from you. That is what stops a watcher copying a name
        // out of the mempool and paying a higher fee to steal it.
        var cName = h('input', { type: 'text', placeholder: 'pool name', style: 'flex:1; min-width:110px', maxlength: '32' });
        var cPeer = h('input', { type: 'text', placeholder: 'PEER', style: 'width:104px', inputmode: 'decimal' });
        var cBtc = h('input', { type: 'text', placeholder: 'cbBTC', style: 'width:104px', inputmode: 'decimal' });
        var cPrice = h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px' });
        var cBtn = h('button', { class: 'btn small primary', text: 'Open pool on Base' });
        var cBusy = false;

        // The two sentences a zero balance has to be answered with, because a
        // field filled with 0 and no explanation is the dead end this card
        // exists to remove. Neither invents a way to get the coin: where to
        // buy bitcoin is not this page's business, and a page that points
        // somewhere is a page that has picked somebody.
        var NO_PEER = 'This wallet holds no PEER token on Base at all. The PEER counted in the Wallet tab is a different thing that happens to share the name: a number in this network’s own log, not in any wallet, and there is no bridge that turns one into the other. Opening a pool needs the Base token itself, in this address.';
        var NO_BTC = 'This wallet holds no cbBTC at all. A pool has two sides and cbBTC is the other one: it is bitcoin on Base — an ERC-20 that stands for BTC — and no amount of PEER becomes it. It has to be bought or bridged onto Base, into this address, before a pool can be opened.';

        function cSay(t, warn) {
          ocSeq.appendChild(h('p', { class: 'smallnote', style: warn ? 'border-left:2px solid var(--ember); padding-left:9px' : 'padding-left:9px', text: t }));
        }

        // The most consequential line on this screen, and it used to be
        // nowhere at all. There is no market in PEER/BTC, so nothing prices
        // this pool but the two numbers above it: whatever ratio goes in is
        // what the first trader pays, and against a pool this thin the first
        // trade moves it a long way. Said live, both ways round, before
        // anything is signed — a price you learn afterwards is a price you
        // did not choose.
        function cRatio() {
          var vp = ocUnits(cPeer.value, pdec), vb = ocUnits(cBtc.value, bdec);
          if (vp === null || vb === null) {
            cPrice.textContent = 'The two amounts ARE the opening price — there is no market to take one from. Fill both in and the price they set appears here, before anything is signed.';
            return;
          }
          var pf = Number(vp) / Math.pow(10, pdec), bf = Number(vb) / Math.pow(10, bdec);
          cPrice.textContent = 'You are setting the price: 1 PEER = ' + ocPx(bf / pf) + ' BTC, and 1 BTC = ' + ocPx(pf / bf) + ' PEER. Nothing else prices PEER against bitcoin, so this ratio is the market until somebody trades against it — and against a pool this thin the first trade moves it a long way, in whichever direction pays the trader.';
        }
        cPeer.addEventListener('input', cRatio);
        cBtc.addEventListener('input', cRatio);
        cRatio();

        // "The number of peer tokens you have", as one tap rather than
        // arithmetic. Exact to the last raw unit, because this value is
        // parsed straight back into the transaction. Gas is paid in ETH, so
        // emptying either of these two balances strands nothing.
        function cMax(input, sym) {
          return h('button', { class: 'btn small', text: 'max ' + sym, onclick: function () {
            (async function () {
              try {
                if (!l2Wallet && !(await ocConnect())) { toast('Reading your balance needs the wallet connected on Base. It signs nothing.'); return; }
                drawWallet();
                var toks = await ocGetTokens(factory);
                var isPeer = sym === 'PEER';
                var raw = await ocBal(isPeer ? toks.peer : toks.btc, sym);
                input.value = ocDec(raw, isPeer ? pdec : bdec);
                cRatio();
                if (raw === 0n) cSay(isPeer ? NO_PEER : NO_BTC, true);
              } catch (e) { toast('Could not read your ' + sym + ' balance: ' + ocErr(e)); }
            })();
          } });
        }

        cBtn.addEventListener('click', function () {
          if (cBusy) return;
          ocSeq.innerHTML = '';
          var nm = String(cName.value || '').trim();
          if (!nm) { cSay('A pool needs a name — it is the label this one is listed under, and it is claimed for you alone: a stranger opening theirs under the same word takes nothing from you.', true); return; }
          var nb = new TextEncoder().encode(nm);
          if (nb.length > 32) { cSay('That name is ' + nb.length + ' bytes as UTF-8, and 32 is all a bytes32 holds. Nothing was signed.', true); return; }
          var vp = ocUnits(cPeer.value, pdec), vb = ocUnits(cBtc.value, bdec);
          if (vp === null || vb === null) { cSay('Both starting amounts, both above zero — a pool has two sides and they go in together. “max PEER” and “max cbBTC” fill in what this wallet actually holds.', true); return; }
          // bytes32: the UTF-8 bytes hex-encoded, right-padded with NULs —
          // the exact shape the host strips back off to show the name.
          var hexName = '';
          for (var bi = 0; bi < nb.length; bi++) hexName += nb[bi].toString(16).padStart(2, '0');
          while (hexName.length < 64) hexName += '0';
          var led = ocLedger();
          cBusy = true;
          cBtn.disabled = true;
          cBtn.textContent = 'Working…';
          (async function () {
            try {
              cSay('Checking everything that can be checked for free. Nothing is signed and no gas is spent until all of it passes.');
              if (!l2Wallet && !(await ocConnect())) { cSay('Opening a pool needs a wallet connected on Base. Nothing was signed.', true); return; }
              drawWallet();
              // Asked before the READS, not only before the signature. On
              // another chain every check below answers about a different
              // world — eth_getCode comes back empty at an address that holds
              // a token on Base — and a page that blamed the operator's
              // factory for the user's network switch would be confidently
              // wrong about whose problem it is.
              var chain = await ocEth('eth_chainId');
              if (chain !== OC_CHAIN) {
                l2Wallet = null;
                l2Tokens = null;
                if (l2Redraw) l2Redraw();
                cSay('That wallet answers for chain ' + chain + ', not Base (' + OC_CHAIN + '). Every check below would be about a different chain, so none of them ran and nothing was signed. Put the wallet on Base and connect again.', true);
                return;
              }
              var toks = await ocGetTokens(factory);
              // The dead-factory check, and it is free. A factory deployed
              // with a wrong immutable — a plain wallet address where the
              // token address belonged — answers peer() with something
              // perfectly well formed that no ERC-20 lives at. Every later
              // failure then blames the wrong thing: balanceOf answers '0x',
              // which reads as "check you are on Base", and an approve sent
              // there costs gas and permits nothing.
              var codeP = await ocEth('eth_getCode', [toks.peer, 'latest']);
              var codeB = await ocEth('eth_getCode', [toks.btc, 'latest']);
              var dead = [];
              if (!codeP || codeP === '0x') dead.push('PEER as ' + toks.peer);
              if (!codeB || codeB === '0x') dead.push('cbBTC as ' + toks.btc);
              if (dead.length) {
                cSay('This factory names ' + dead.join(' and ') + ', and no contract lives at that address. A factory pointed at something that is not a token cannot open a pool at all, and an approval sent there would cost gas and permit nothing. Nothing was signed. Fixing it means redeploying the factory, which is the operator’s move — chain-l2/DEPLOY.md.', true);
                return;
              }
              // MIN_LIQ from the deployed factory rather than from the
              // source, and the square root in BigInt: sqrt of an 18-decimal
              // amount times an 8-decimal one leaves Math.sqrt's exactness
              // far behind.
              var s0 = ocSqrt(vp * vb);
              var minLiq = await ocMinLiq(factory);
              if (s0 <= minLiq) {
                cSay('Too small to open. The opening shares are sqrt(PEER × cbBTC) = ' + s0 + ' raw units, and this factory locks ' + minLiq + ' of them forever, so an opening deposit has to mint more than that. Raise either amount. Nothing was signed.', true);
                return;
              }
              if (await ocTaken(factory, l2Wallet, hexName)) {
                cSay('You already opened a pool called “' + nm + '”. Your own names are claimed once and never reused, even after a pool is drained — pick another word. Nothing was signed.', true);
                return;
              }
              var haveP = await ocBal(toks.peer, 'PEER');
              var haveB = await ocBal(toks.btc, 'cbBTC');
              if (haveP === 0n) { cSay(NO_PEER + ' Nothing was signed.', true); return; }
              if (haveP < vp) {
                cSay('This wallet holds ' + ocDec(haveP, pdec) + ' PEER on Base and the pool asks for ' + ocDec(vp, pdec) + '. “max PEER” fills in the figure it actually holds. Nothing was signed.', true);
                return;
              }
              if (haveB === 0n) { cSay(NO_BTC + ' Nothing was signed.', true); return; }
              if (haveB < vb) {
                cSay('This wallet holds ' + ocDec(haveB, bdec) + ' cbBTC and the pool asks for ' + ocDec(vb, bdec) + '. Both sides go in together, so the smaller side is what caps the pool. Nothing was signed.', true);
                return;
              }
              // How many signatures this actually is, asked rather than
              // assumed. An approval that already stands is not asked for
              // again by the wallet, so promising three prompts and showing
              // one is its own small lie — and this is the count the steps
              // below are numbered against.
              var alwP = ocUint(await ocEth('eth_call', [{ to: toks.peer, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(factory) }, 'latest']), 'the PEER allowance');
              var alwB = ocUint(await ocEth('eth_call', [{ to: toks.btc, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(factory) }, 'latest']), 'the cbBTC allowance');
              var need = (alwP < vp ? 1 : 0) + (alwB < vb ? 1 : 0) + 1;
              var step = 0;
              cSay('Every check passed. ' + need + ' signature' + (need === 1 ? '' : 's') + ' from here, and the wallet asks for each one in turn.' + (need < 3 ? ' An approval you gave earlier still stands, so it is not asked for again.' : ''));
              if (alwP < vp) {
                step++;
                cSay(step + ' of ' + need + ': approving PEER. This permits the pools contract to pull exactly ' + ocDec(vp, pdec) + ' PEER — that amount, once, and nothing else you hold. Confirm it in the wallet.');
                await ocSend(toks.peer, OC_SEL.approve + ocAddr(factory) + ocWord(vp), 'Approving PEER', led,
                  'your approval of ' + ocFmt(vp, pdec) + ' PEER to the pools contract');
                cSay(step + ' of ' + need + ': PEER approved, and confirmed on chain.');
              }
              if (alwB < vb) {
                step++;
                cSay(step + ' of ' + need + ': approving cbBTC. Exactly ' + ocDec(vb, bdec) + ' cbBTC — that amount, once, and nothing else. Confirm it in the wallet.');
                await ocSend(toks.btc, OC_SEL.approve + ocAddr(factory) + ocWord(vb), 'Approving cbBTC', led,
                  'your approval of ' + ocFmt(vb, bdec) + ' cbBTC to the pools contract');
                cSay(step + ' of ' + need + ': cbBTC approved, and confirmed on chain.');
              }
              step++;
              cSay(step + ' of ' + need + ': opening “' + nm + '”. This is the one that moves the coins — both amounts go in, the pool opens at the price above, and the shares are minted to this address.');
              await ocSend(factory, OC_SEL.createPool + hexName + ocWord(vp) + ocWord(vb), 'Opening “' + nm + '”', led, 'opening the pool “' + nm + '”');
              cSay('Done. “' + nm + '” is open on Base holding ' + ocDec(vp, pdec) + ' PEER against ' + ocDec(vb, bdec) + ' cbBTC, and that ratio is its price until somebody trades against it. The name is yours and not the network’s: somebody else may open one called the same thing.');
              cSay(OC_LAG + ' The list above is being re-read now and once more when that window rolls — you do not have to reload the page.');
              toast('Opened “' + nm + '” on Base.');
              ocRefresh();
            } catch (e) {
              // Never "it did not work". The ledger knows which legs landed,
              // which were broadcast and never seen again, and which never
              // went out at all — and an approval that landed cost gas and
              // still stands.
              cSay(led.sentence('Opening the pool stopped', e), true);
              cSay('Press Open pool again once that is dealt with: the free checks run again from the top, and an approval that already stands is reused rather than signed and paid for twice — that is a prompt your wallet simply will not show a second time.');
              toast('The pool did not open — what landed and what did not is written under the button.');
            } finally {
              cBusy = false;
              cBtn.disabled = false;
              cBtn.textContent = 'Open pool on Base';
            }
          })();
        });

        ocBody.appendChild(h('p', { class: 'eyebrow', style: 'margin:10px 0 0', text: 'open a pool — one press, PEER against cbBTC' }));
        ocBody.appendChild(h('p', { class: 'smallnote', text: 'Name it, say how much of each side goes in, press once. Both sides are fixed by the factory — every pool it makes is the PEER token on Base against cbBTC — so the name and the two amounts are the only choices here.' }));
        ocBody.appendChild(h('div', { class: 'mini-form persistent' }, cName, cPeer, cMax(cPeer, 'PEER'), cBtc, cMax(cBtc, 'cbBTC')));
        ocBody.appendChild(cPrice);
        ocBody.appendChild(h('div', { class: 'mini-form persistent' }, cBtn,
          h('span', { class: 'smallnote', text: 'Up to three signatures in one press: approve PEER, approve cbBTC, then open the pool. Each is named here as your wallet asks for it, and everything that could refuse it is checked — for free — before the first one.' })));
        ocBody.appendChild(h('p', { class: 'smallnote', text: 'The first 1000 raw share units of every pool are locked forever — the standard guard that stops the first depositor being robbed by rounding, and the reason an opening deposit has to mint more than that. A name is claimed per creator: you cannot reuse one of your own, and a stranger using the same word neither takes anything from you nor gains anything by it. The factory pulls each amount only after your wallet approves that token, and your wallet shows you every transaction before it signs it.' }));
"""

span(
    r"""        // ── open a pool ──""",
    r"""your wallet shows you every one before it signs.' }));
""",
    NEW_CREATE,
    'one-press create: max fills, live opening price, narrated three-leg sequence',
    ['createPool', 'ocTaken', 'ocMinLiq', "class: 'btn small primary', text: 'Open pool on Base'"],
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
