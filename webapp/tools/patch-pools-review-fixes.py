# -*- coding: utf-8 -*-
# Review fixes for the on-chain named-pools card in template.html, after the
# contract grew deadlines, minimums and a creator field and after a read of
# the card found four ways it could lie to somebody about their own money.
#
# What this patch changes, and why each one is not cosmetic:
#
#   1. THE CHAIN IS RE-CHECKED, NOT REMEMBERED. l2Wallet survives re-renders
#      by design, so the chain check at connect time said nothing about the
#      chain five minutes later. Switch MetaMask to mainnet, come back, press
#      Swap: the allowance read hits a codeless address, the old code read
#      that empty answer as an allowance of zero, an approve was signed on
#      the wrong chain, the call that followed returned status 0x1 because a
#      data-carrying call to a codeless address always does, and the card
#      said "Swapped". Now: eth_chainId is asked at the top of every send,
#      chainId travels in every eth_sendTransaction so the wallet refuses a
#      mismatch itself, the wallet's own chainChanged/accountsChanged events
#      drop everything learned under the old connection, and a read that
#      answers nothing raises instead of being counted as a zero.
#
#   2. A HALF-FINISHED SEQUENCE SAYS WHERE YOU STAND. An approval that landed
#      before a refusal is not undone by the refusal. Each flow now carries a
#      ledger of what actually landed and the catch reads it back. The two
#      refusals createPool can hand out — a name you already used, and a
#      starting deposit under MIN_LIQ — are asked for free BEFORE the first
#      approval, so a doomed create costs nothing.
#
#   3. THE SLIPPAGE GUARD HAS A FLOOR. 98/100 of a few raw sats is zero, and
#      a minimum of zero is not a loose guard, it is none.
#
#   4. NAMES ARE LABELS. Names are claimed per creator, so two people can
#      both have a pool called "main". The list ranks by BTC depth, names
#      every creator, marks shared names, and repeats what the reader says
#      about its own truncation instead of showing a partial list as whole.
#
# Discipline (see the 0-byte truncation incident): every anchor must match
# EXACTLY once, all patches are applied to the in-memory string, and the
# encode happens on its own line BEFORE any file is opened for writing.
import io

TP = r'C:/Users/User/Desktop/ToRuleThemAll/webapp/social/template.html'
s = io.open(TP, 'r', encoding='utf-8').read()
orig_len = len(s)
applied = []


def once(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, 'anchor for %s matches %d times, need exactly 1' % (label, n)
    s = s.replace(old, new)
    applied.append(label)


# ── 1. module-level state that a wallet event can clear ─────────────────────
once(
    r'''  // no key is ever in this variable — or anywhere else in this file.
  var l2Wallet = null;
''',
    r'''  // no key is ever in this variable — or anywhere else in this file.
  //
  // The three below it are cache that is only true WHILE that connection is.
  // l2Tokens holds the two token addresses read off the pools factory, which
  // are meaningless on any other chain; l2Redraw is the hook the on-chain
  // card installs so the wallet's own events can reach the screen; l2Watching
  // stops those event handlers stacking up one per visit to the tab. When the
  // wallet changes network or account they are dropped together, because an
  // address left on screen after the wallet moved on is a lie the page is
  // telling for free.
  var l2Wallet = null;
  var l2Tokens = null;
  var l2Redraw = null;
  var l2Watching = false;
''',
    'module-level wallet cache + redraw hook')

# ── 2. selectors: the contract grew guard parameters, so three changed ──────
once(
    r'''      var OC_SEL = {
        createPool: '0xb3a2199d',      // createPool(bytes32,uint256,uint256)
        addLiquidity: '0x422f1043',    // addLiquidity(uint256,uint256,uint256)
        removeLiquidity: '0x9d7de6b3', // removeLiquidity(uint256,uint256)
        swap: '0x7a9d1ac4',            // swap(uint256,bool,uint256,uint256)
        sharesOf: '0xe78307ca',        // sharesOf(uint256,address)
        peer: '0x11cda415',            // peer()
        btc: '0xa28d57d8',             // btc()
        approve: '0x095ea7b3',         // approve(address,uint256)
        allowance: '0xdd62ed3e'        // allowance(address,address)
      };''',
    r'''      //
      // A selector is keccak of the name and the INPUT types, so the three
      // functions that grew a guard parameter grew new selectors with them:
      // swap, addLiquidity and removeLiquidity are NOT the four-argument ones
      // this card first shipped against. Sending an old selector to the new
      // contract does not misbehave subtly — it reaches no function at all —
      // but the signature beside each one is the only thing that says which
      // is which, so read them together.
      var OC_SEL = {
        createPool: '0xb3a2199d',      // createPool(bytes32,uint256,uint256)
        addLiquidity: '0xa360501c',    // addLiquidity(uint256,uint256,uint256,uint256,uint256)
        removeLiquidity: '0xf88bf15a', // removeLiquidity(uint256,uint256,uint256,uint256)
        swap: '0x0b719a65',            // swap(uint256,bool,uint256,uint256,uint256)
        sharesOf: '0xe78307ca',        // sharesOf(uint256,address)
        taken: '0xd174c832',           // taken(address,bytes32)
        minLiq: '0x5731bb0a',          // MIN_LIQ()
        peer: '0x11cda415',            // peer()
        btc: '0xa28d57d8',             // btc()
        approve: '0x095ea7b3',         // approve(address,uint256)
        allowance: '0xdd62ed3e'        // allowance(address,address)
      };''',
    'selectors for the five-argument swap / addLiquidity, four-argument removeLiquidity')

# ── 3. the small honest helpers this card was missing ───────────────────────
once(
    r'''      function ocWord(v) { return BigInt(v).toString(16).padStart(64, '0'); }
      function ocAddr(a) { return String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
      function ocErr(e) { return String((e && e.message) || e).slice(0, 140); }
''',
    r'''      function ocWord(v) { return BigInt(v).toString(16).padStart(64, '0'); }
      function ocAddr(a) { return String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
      // A wallet's error can be a paragraph of JSON-RPC, so it is cut — but
      // the cut is now visible. A silent slice at 140 turns a sentence into a
      // fragment that ends mid-clause, and the sentences this card composes
      // itself get read back to somebody deciding what to press.
      function ocErr(e) {
        var t = String((e && e.message) || e);
        return t.length > 140 ? t.slice(0, 139) + '…' : t;
      }
      // An address as a human can carry it in their head, or '' if the thing
      // handed over is not an address. Empty rather than a shortened piece of
      // garbage: half an address on screen would read as provenance.
      function ocShort(a) {
        var t = String(a == null ? '' : a);
        return /^0x[0-9a-fA-F]{40}$/.test(t) ? t.slice(0, 6) + '\u2026' + t.slice(-4) : '';
      }

      // A 32-byte answer as a BigInt, or a refusal in a plain sentence. An
      // eth_call that reaches an address holding no code answers '0x' —
      // EMPTY, not zero — and the difference is the whole failure this card
      // was capable of: on the wrong network the allowance read comes back
      // empty, reading it as 0 makes the page approve into the void, and the
      // data-carrying call that follows returns status 0x1 because a call to
      // a codeless address always does. Nothing here turns "no answer" into a
      // number.
      function ocUint(res, what) {
        var body = String(res == null ? '' : res).replace(/^0x/, '');
        // Kept short on purpose: this sentence is read back through ocErr,
        // and one that overruns its cut arrives as a fragment.
        if (body.length < 64) throw new Error(what + ' answered nothing \u2014 that call reached no contract. Check the wallet is on Base.');
        return BigInt('0x' + body.slice(0, 64));
      }

      // The 2% slippage guard, in raw units, with a floor. Percentages die on
      // small integers: 98/100 of three sats is two, of one sat is ZERO, and
      // a minimum of zero is not a loose guard but no guard at all. cbBTC
      // carries 8 decimals, so quotes of a few raw units are ordinary here,
      // not a corner case — and they are exactly the trades a sandwich costs
      // least to steal. The floor never lets a nonzero expected amount go out
      // with a zero minimum; where that makes the trade all-or-nothing the
      // quote line says so rather than letting the user find out on chain.
      function ocGuard(expected) {
        if (expected <= 0n) return 0n;
        var m = expected * 98n / 100n;
        return m < 1n ? 1n : m;
      }

      // Integer square root, rounding down — PeerPools._sqrt transcribed line
      // for line, including its small-input branch, so the pre-check below
      // refuses exactly what the contract refuses and nothing else. Written
      // out rather than paraphrased on purpose: the tidier Newton loop most
      // people reach for returns 2 for an input of 2, where this contract
      // returns 1, and a pre-check that disagrees with the contract about
      // anything is worse than no pre-check. BigInt throughout because
      // Math.sqrt stops being exact at 2^53 and the product of an
      // 18-decimal and an 8-decimal amount starts well past it.
      function ocSqrt(y) {
        if (y > 3n) {
          var z = y, x = y / 2n + 1n;
          while (x < z) { z = x; x = (y / x + x) / 2n; }
          return z;
        }
        return y === 0n ? 0n : 1n;
      }

      // Where a half-finished sequence actually left somebody. Approving a
      // token and then refusing the next signature does not undo the
      // approval: it landed, it cost gas, and it still stands. A catch that
      // says "did not go through" about the whole press tells a user their
      // coins are un-approved when they are not — which is how the same
      // approval gets signed, and paid for, twice. Each leg that lands is
      // recorded as a clause the failure reads back.
      function ocLedger() {
        var landed = [];
        return {
          landed: function (clause) { if (clause) landed.push(clause); },
          sentence: function (headline, e) {
            var head = headline + ': ' + ocErr(e);
            if (!landed.length) return head + ' Nothing else was signed, so nothing else of yours moved.';
            return head + ' What DID land and still stands: ' + landed.join('; ') + '. Pressing again reuses it \u2014 your wallet will not ask for that approval a second time.';
          }
        };
      }
''',
    'ocShort / ocUint / ocGuard / ocSqrt / ocLedger')

# ── 4. the wallet's own events, and a deadline off the chain's clock ────────
once(
    r'''      function ocEth(method, params) { return window.ethereum.request({ method: method, params: params || [] }); }
''',
    r'''      function ocEth(method, params) { return window.ethereum.request({ method: method, params: params || [] }); }

      // The wallet is not a thing this page can hold still. A user can switch
      // network or account in MetaMask at any moment, including while this
      // card sits open, and a chain verified at connect time says nothing
      // about the chain a minute later. So the wallet's own event channel is
      // the authority: on either change everything learned under the old
      // connection is dropped — the address, and the token addresses read off
      // a factory that only exists on Base — and the row redraws to what is
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
        window.ethereum.on('chainChanged', function () { ocForget('The wallet left Base. Nothing here signs until it is back on Base and connected again.'); });
        window.ethereum.on('accountsChanged', function () { ocForget('The wallet switched accounts. Connect again \u2014 the address shown here is only ever the one that connected.'); });
      }

      // A deadline is a second on the CHAIN's clock, so it is read off the
      // chain rather than off this computer: a browser an hour slow would
      // sign deadlines already expired (every trade reverts, gas each time)
      // and one an hour fast would sign a protection that does not begin for
      // an hour. Ten minutes is the window — long enough for somebody to walk
      // away from a wallet prompt, short enough that a transaction held back
      // by a builder and replayed later is void rather than merely late. If
      // the block will not answer, this machine's clock stands in; that is a
      // worse clock, and this comment is the disclosure.
      async function ocDeadline() {
        var secs = Math.floor(Date.now() / 1000);
        try {
          var blk = await ocEth('eth_getBlockByNumber', ['latest', false]);
          if (blk && blk.timestamp) secs = Number(BigInt(blk.timestamp));
        } catch (e) { /* the local clock stands in */ }
        return BigInt(secs + 600);
      }
''',
    'chainChanged/accountsChanged wiring + ocDeadline')

# ── 5. connecting: believe the chain, not the switch request ────────────────
once(
    r'''          try { await ocEth('wallet_switchEthereumChain', [{ chainId: OC_CHAIN }]); }
          catch (e) { toast('That wallet is not on Base and would not switch. Switch it by hand, then connect again.'); return null; }
        }''',
    r'''          try { await ocEth('wallet_switchEthereumChain', [{ chainId: OC_CHAIN }]); }
          catch (e) { toast('That wallet is not on Base and would not switch. Switch it by hand, then connect again.'); return null; }
          // Ask again rather than believing the switch. That call resolving
          // means the wallet accepted the request, not that the network
          // moved — and this is the one question where accepting a promise
          // instead of an answer puts a signature on the wrong chain.
          chain = await ocEth('eth_chainId');
          if (chain !== OC_CHAIN) { toast('The wallet still answers for chain ' + chain + ', not Base. Nothing here will sign until it does.'); return null; }
        }''',
    'connect re-reads eth_chainId after the switch')

# ── 6. every send re-asks the chain, and names it ───────────────────────────
once(
    r'''      async function ocSend(to, data, label) {
        toast(label + ' \u2014 approve it in the wallet.');
        var tx = await ocEth('eth_sendTransaction', [{ from: l2Wallet, to: to, data: data }]);''',
    r'''      //
      // The chain is re-asked here, at the last moment before anything is
      // signed, and named in the transaction itself. l2Wallet outlives the
      // check made at connect time on purpose — it has to survive the
      // re-render after every act — so between connecting and pressing, a
      // user can move MetaMask to another network and this page would never
      // hear about it. On the wrong chain the factory address holds no code:
      // an approve is signed to nothing, the call that follows returns status
      // 0x1 (which is what ANY data-carrying call to a codeless address
      // returns), and the card congratulates a trade that never existed, with
      // real gas burned twice. Two cheap defences, both here: ask eth_chainId
      // again, and put chainId in the params so the wallet refuses a mismatch
      // itself rather than trusting this page to have asked.
      async function ocSend(to, data, label) {
        var chain = await ocEth('eth_chainId');
        if (chain !== OC_CHAIN) {
          l2Wallet = null;
          l2Tokens = null;
          if (l2Redraw) l2Redraw();
          throw new Error('the wallet is on chain ' + chain + ', not Base (' + OC_CHAIN + ') \u2014 nothing was signed. Put it back on Base and connect again.');
        }
        toast(label + ' \u2014 approve it in the wallet.');
        var tx = await ocEth('eth_sendTransaction', [{ from: l2Wallet, to: to, data: data, chainId: OC_CHAIN }]);''',
    'ocSend re-checks the chain and sends chainId')

# ── 7. the allowance read stops swallowing, and reports what it signed ──────
once(
    r'''      async function ocAllow(token, spender, need, symbol) {
        var have = 0n;
        try { have = BigInt(await ocEth('eth_call', [{ to: token, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(spender) }, 'latest'])); } catch (e) {}
        if (have >= need) return;
        await ocSend(token, OC_SEL.approve + ocAddr(spender) + ocWord(need), 'Approving ' + symbol);
      }''',
    r'''      //
      // The read is no longer wrapped in a swallow. An allowance that cannot
      // be read is not an allowance of zero — it is a call that hit nothing,
      // and the only safe move is to stop rather than to approve. When it
      // does sign, it hands back the clause the ledger needs, so a refusal
      // further down the sequence can say that this approval stands.
      async function ocAllow(token, spender, need, symbol, dec) {
        var have = ocUint(await ocEth('eth_call', [{ to: token, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(spender) }, 'latest']), 'the ' + symbol + ' allowance');
        if (have >= need) return null;
        await ocSend(token, OC_SEL.approve + ocAddr(spender) + ocWord(need), 'Approving ' + symbol);
        return 'your approval of ' + ocFmt(need, dec) + ' ' + symbol + ' to the pools contract';
      }''',
    'ocAllow surfaces an unreadable allowance and reports its approval')

# ── 8. token addresses: cached per connection, checked for being addresses ──
once(
    r'''      var ocTokens = null;
      async function ocGetTokens(factory) {
        if (ocTokens) return ocTokens;
        var pw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.peer }, 'latest']);
        var bw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.btc }, 'latest']);
        ocTokens = { peer: '0x' + String(pw).slice(-40), btc: '0x' + String(bw).slice(-40) };
        return ocTokens;
      }''',
    r'''      //
      // The cache lives at module level so a chainChanged can empty it: an
      // address read off a factory on Base is not an address anywhere else.
      // And a word that is not there is not an address — slicing the last 40
      // characters off '0x' yields something that LOOKS addressable, and an
      // approve aimed at it is a signature spent on nothing.
      async function ocGetTokens(factory) {
        if (l2Tokens) return l2Tokens;
        var pw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.peer }, 'latest']);
        var bw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.btc }, 'latest']);
        var pa = ocUint(pw, 'the factory\u2019s peer() address'), ba = ocUint(bw, 'the factory\u2019s btc() address');
        if (pa === 0n || ba === 0n || pa >> 160n !== 0n || ba >> 160n !== 0n) throw new Error('that factory did not answer with two token addresses \u2014 nothing was signed');
        l2Tokens = { peer: '0x' + pa.toString(16).padStart(40, '0'), btc: '0x' + ba.toString(16).padStart(40, '0') };
        return l2Tokens;
      }

      // Both refusals createPool can hand back are knowable for FREE, and
      // both are asked before the first approval is signed. An approval that
      // lands ahead of a revert costs gas and leaves a standing permission
      // over somebody's coins; an eth_call and a square root cost neither.
      //
      // MIN_LIQ is read from the deployed factory rather than pasted from
      // PeerPools.sol. The constant in the source is 1000, but the number
      // that matters is the one the contract about to take the money answers
      // with; a page that hardcodes it is pre-checking a different contract
      // than it is paying.
      var ocMin = null;
      async function ocMinLiq(factory) {
        if (ocMin === null) ocMin = ocUint(await ocEth('eth_call', [{ to: factory, data: OC_SEL.minLiq }, 'latest']), 'the factory\u2019s MIN_LIQ');
        return ocMin;
      }

      // taken(creator, name) — the name-claim mapping's own getter. It asks
      // about THIS wallet only, which is the whole design: the name you
      // cannot have is one you already used, never one a stranger used.
      async function ocTaken(factory, who, hexName) {
        return ocUint(await ocEth('eth_call', [{ to: factory, data: OC_SEL.taken + ocAddr(who) + hexName }, 'latest']), 'the name claim') !== 0n;
      }''',
    'ocGetTokens hardening + ocMinLiq + ocTaken pre-checks')

# ── 9. a refresh that keeps the promise the toast makes ─────────────────────
once(
    r'''      function ocRender(status, d) {''',
    r'''      // The host answers /api/token/onchain from a 30-second cache, so the
      // reload fired the instant a transaction lands usually redraws the very
      // snapshot that was taken before it: same numbers, and a card that
      // looks like it did not notice. The old toast promised the card would
      // follow and nothing in the code made it. So: read now (the cache may
      // be about to turn over anyway) and once more after the window has
      // certainly rolled, and say the half-minute out loud. The second read
      // is skipped if the card has since been navigated away from — nobody's
      // tab should keep polling a page they left.
      var OC_LAG = 'This card catches up when the host\u2019s 30-second read of the chain rolls over, about half a minute from now.';
      function ocRefresh() {
        ocLoad();
        setTimeout(function () { if (ocBody.isConnected) ocLoad(); }, 31000);
      }

      function ocRender(status, d) {''',
    'ocRefresh + the honest lag sentence')

# ── 9b. the factory's own tokens, when they are not the host's ─────────────
once(
    r'''        var factory = np.factory;
        var pdec = np.peerDecimals == null ? 18 : Number(np.peerDecimals);
        var bdec = np.btcDecimals == null ? 8 : Number(np.btcDecimals);
''',
    r'''        var factory = np.factory;
        var pdec = np.peerDecimals == null ? 18 : Number(np.peerDecimals);
        var bdec = np.btcDecimals == null ? 8 : Number(np.btcDecimals);

        // The factory names its own two tokens and the reader checks them
        // against the ones this host was configured with. Where they
        // disagree, that sentence is the endpoint's own and it goes FIRST,
        // before the wallet row: it means the pools below are over coins the
        // operator did not mean to serve. Nothing is hidden and nothing is
        // disabled — this page cannot know which of the two addresses is the
        // wrong one, and the trades are perfectly real either way — but
        // nobody should approve a token here without having read it.
        if (np.mismatch && np.mismatch.error) {
          ocBody.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text: np.mismatch.error }));
        } else if (np.tokensNote) {
          ocBody.appendChild(h('p', { class: 'smallnote', text: np.tokensNote }));
        }
''',
    'surface the factory/host token mismatch verbatim')

# ── 10. the wallet row used a class that does not exist ─────────────────────
once(
    r'''            walletRow.appendChild(h('span', { class: 'smallnote mono', text: l2Wallet.slice(0, 6) + '\u2026' + l2Wallet.slice(-4) + ' \u00b7 Base' }));''',
    r'''            // .num is the stylesheet's monospace face (var(--mono), tabular
            // figures); .mono was never a rule in this file, so the address
            // used to render in the body font like ordinary prose.
            walletRow.appendChild(h('span', { class: 'smallnote num', text: (ocShort(l2Wallet) || l2Wallet) + ' \u00b7 Base' }));''',
    'wallet row uses .num, a class that exists')

# ── 11a. the list: ranked, provenanced, honest about being partial ──────────
once(
    r'''        var listBox = h('div', {});
        ocBody.appendChild(listBox);
        function drawPools() {
          listBox.innerHTML = '';
          if (!np.pools || !np.pools.length) {
            listBox.appendChild(h('p', { class: 'smallnote', text: 'The factory is live and empty. The first pool is opened below \u2014 its starting ratio IS its starting price.' }));
            return;
          }
          np.pools.forEach(function (p) { listBox.appendChild(poolRow(p)); });
        }''',
    r'''        // A name here is a LABEL and never an identifier. PeerPools claims
        // names per creator on purpose — a global namespace on a public
        // mempool just sells the word "main" to whoever pays the higher
        // priority fee — and the deliberate consequence is that two different
        // people can both have a pool called "main". So this list refuses to
        // present a name as canonical: it ranks by BTC depth, which is the
        // one property of a pool nobody can simply type in; it names the
        // creator of every row; it marks a name more than one pool is using;
        // and every call any button sends is keyed by id, which is the only
        // part of a pool that is unique.
        var listBox = h('div', {});
        ocBody.appendChild(listBox);
        function drawPools() {
          listBox.innerHTML = '';
          var list = (np.pools || []).slice();
          if (!list.length) {
            listBox.appendChild(h('p', { class: 'smallnote', text: 'The factory is live and empty. The first pool is opened below \u2014 its starting ratio IS its starting price.' }));
            return;
          }
          // Deepest BTC reserve first. The reader ranks the same way; this
          // sorts again rather than trusting the order it arrived in, because
          // an order that silently depends on a host being current is one
          // that quietly puts a dust pool at the top of somebody's screen.
          list.sort(function (a, b) {
            var A = BigInt(a.resBtcRaw || '0'), B = BigInt(b.resBtcRaw || '0');
            if (A !== B) return A > B ? -1 : 1;
            return Number(a.id) - Number(b.id);
          });
          // How many pools in THIS list wear each name, keyed by the raw
          // bytes32 where the host sends it: two names that render alike but
          // differ by a byte are still two names, and the raw word is what
          // the chain actually holds. A null-prototype object because the
          // keys are somebody else's chosen text — a pool named __proto__
          // must count as a pool, not reach into this page's object model.
          var byName = Object.create(null);
          list.forEach(function (p) {
            var k = String(p.nameRaw || p.name || '');
            byName[k] = (byName[k] || 0) + 1;
          });
          listBox.appendChild(h('p', { class: 'smallnote', text: 'Deepest BTC reserve first. A pool\u2019s name was chosen by whoever opened it and is claimed per creator \u2014 two different people can each have one called \u201cmain\u201d, and both are legitimate. A name carries no trust and no endorsement here: read the creator and the reserves, and note that the id beside it is what every button below actually sends.' }));

          // What this list is NOT. The reader stops fetching past its own cap
          // and reports the cap it hit; a partial list drawn as though it
          // were the whole factory is exactly the omission that sends a
          // deposit into the wrong pool.
          var total = np.total == null ? np.count : np.total;
          var shown = np.returned == null ? list.length : Number(np.returned);
          var skipped = Array.isArray(np.skipped) ? np.skipped.length : Number(np.skipped || 0);
          if (np.truncated || (total != null && Number(total) > shown)) {
            // Where the reader wrote its own account of what is missing and
            // why \u2014 seen but not read this round, unreadable, or never seen
            // at all \u2014 it is shown verbatim, because it knows things about
            // its own scan that this page does not. The counted sentence is
            // the fallback for a host older than this card.
            listBox.appendChild(h('p', { class: 'smallnote', text: np.note ? np.note : ('Showing ' + shown + ' of ' + total + ' pools on this factory \u2014 this host stops reading at its own cap, so the rest exist on chain and are simply not here.' + (skipped > 0 ? ' Another ' + skipped + ' would not decode and were skipped.' : '')) }));
          } else if (skipped > 0) {
            listBox.appendChild(h('p', { class: 'smallnote', text: skipped + ' pool' + (skipped === 1 ? '' : 's') + ' on this factory would not decode and ' + (skipped === 1 ? 'was' : 'were') + ' skipped \u2014 what follows is the rest, not all of it.' }));
          }

          list.forEach(function (p) { listBox.appendChild(poolRow(p, byName[String(p.nameRaw || p.name || '')] || 1)); });
        }''',
    'pool list: rank, dedupe names, surface truncation')

# ── 11b. the row header carries id and creator ──────────────────────────────
once(
    r'''        function poolRow(p) {
          var rp = BigInt(p.resPeerRaw || '0'), rb = BigInt(p.resBtcRaw || '0');
          var label = p.name || ('#' + p.id);
          var box = h('div', {});
          var kv = h('div', { class: 'kv' },
            h('span', { text: label }),''',
    r'''        function poolRow(p, sharing) {
          var rp = BigInt(p.resPeerRaw || '0'), rb = BigInt(p.resBtcRaw || '0');
          var ts = BigInt(p.totalSharesRaw || '0');
          // Every sentence about this pool says its id, because the id is the
          // identity; the name is only what it is called.
          var label = (p.name ? '\u201c' + p.name + '\u201d' : 'the unnamed pool') + ' #' + p.id;
          var box = h('div', {});
          var kv = h('div', { class: 'kv' },
            h('span', { text: (p.name || '(no name)') + ' \u00b7 #' + p.id }),''',
    'pool row header shows the id')

once(
    r'''            kv.appendChild(h('b', { class: 'num', text: '1 PEER = ' + (px >= 0.001 ? Math.round(px * 1e8) / 1e8 : px.toExponential(3)) + ' BTC' }));
          }
          box.appendChild(kv);
''',
    r'''            kv.appendChild(h('b', { class: 'num', text: '1 PEER = ' + (px >= 0.001 ? Math.round(px * 1e8) / 1e8 : px.toExponential(3)) + ' BTC' }));
          }
          box.appendChild(kv);
          // Provenance on every row, not only the ambiguous ones: a creator
          // shown only where there is a clash would make its absence read
          // like a guarantee. Where the host reports no creator, that is what
          // it says — an unknown opener is not a trustworthy one.
          var who = ocShort(p.creator);
          var prov = who ? 'opened by ' + who : 'opened by an address this host did not report';
          if (sharing > 1) prov += ' \u00b7 ' + sharing + ' pools in this list share the name \u201c' + (p.name || '') + '\u201d \u2014 different pools with different creators, one word between them';
          box.appendChild(h('p', { class: 'smallnote', text: prov }));
''',
    'pool row shows creator and marks a shared name')

# ── 11c. the swap row: floored guard, deadline, ledger ──────────────────────
once(
    r'''          function quoteNow() {
            var sellPeer = sellSel.value === 'PEER';
            var vin = ocUnits(amtIn.value, sellPeer ? pdec : bdec);
            if (vin === null) return null;
            return { sellPeer: sellPeer, vin: vin, out: ocQuote(vin, sellPeer ? rp : rb, sellPeer ? rb : rp) };
          }
          function requote() {
            var q = quoteNow();
            quote.textContent = !q ? '' : (q.out <= 0n ? 'the pool cannot fill this'
              : '\u2192 ' + ocFmt(q.out, q.sellPeer ? bdec : pdec) + ' ' + (q.sellPeer ? 'BTC' : 'PEER') + ' (incl. 0.3% fee)');
          }''',
    r'''          function quoteNow() {
            var sellPeer = sellSel.value === 'PEER';
            var vin = ocUnits(amtIn.value, sellPeer ? pdec : bdec);
            if (vin === null) return null;
            var out = ocQuote(vin, sellPeer ? rp : rb, sellPeer ? rb : rp);
            return { sellPeer: sellPeer, vin: vin, out: out, min: ocGuard(out), dec: sellPeer ? bdec : pdec, sym: sellPeer ? 'BTC' : 'PEER' };
          }
          function requote() {
            var q = quoteNow();
            if (!q) { quote.textContent = ''; return; }
            if (q.out <= 0n) { quote.textContent = 'the pool cannot fill this'; return; }
            var t = '\u2192 ' + ocFmt(q.out, q.dec) + ' ' + q.sym + ' (incl. 0.3% fee); it reverts below ' + ocFmt(q.min, q.dec) + ' ' + q.sym;
            // Below about fifty raw units a percentage is not expressible at
            // all: 2% of three sats is nothing an integer can hold. The guard
            // is floored at one unit there, which makes the trade
            // all-or-nothing, and saying so is the difference between a tight
            // guard and a guard the user thinks they have.
            if (q.out < 50n) t += ' \u2014 that output is only ' + q.out + ' raw units, too small to protect by percentage, so any move at all makes it revert. Trade more if you want room.';
            quote.textContent = t;
          }''',
    'swap quote shows the floored guard and says when it is all-or-nothing')

once(
    r'''              var q = quoteNow();
              if (!q) { toast('Say how much.'); return; }
              if (q.out <= 0n) { toast('The pool cannot fill this.'); return; }
              (async function () {
                try {
                  if (!l2Wallet && !(await ocConnect())) { toast('Trading needs a wallet on Base.'); return; }
                  drawWallet();
                  var toks = await ocGetTokens(factory);
                  await ocAllow(q.sellPeer ? toks.peer : toks.btc, factory, q.vin, q.sellPeer ? 'PEER' : 'cbBTC');
                  // The same 2% slippage guard the sandbox pools use, in
                  // integer arithmetic: if the chain moved between this
                  // quote and the fill, the contract refuses rather than
                  // filling at a price this screen never showed.
                  var data = OC_SEL.swap + ocWord(p.id) + ocWord(q.sellPeer ? 1n : 0n) + ocWord(q.vin) + ocWord(q.out * 98n / 100n);
                  await ocSend(factory, data, 'Swapping in ' + label);
                  toast('Swapped in ' + label + '. The host re-reads the chain within 30 seconds; the card follows.');
                  ocLoad();
                } catch (e) { toast('Swap did not go through: ' + ocErr(e)); }
              })();''',
    r'''              var q = quoteNow();
              if (!q) { toast('Say how much.'); return; }
              if (q.out <= 0n) { toast('The pool cannot fill this.'); return; }
              var led = ocLedger();
              (async function () {
                try {
                  if (!l2Wallet && !(await ocConnect())) { toast('Trading needs a wallet on Base.'); return; }
                  drawWallet();
                  var toks = await ocGetTokens(factory);
                  led.landed(await ocAllow(q.sellPeer ? toks.peer : toks.btc, factory, q.vin, q.sellPeer ? 'PEER' : 'cbBTC', q.sellPeer ? pdec : bdec));
                  // Two guards, both the caller's own. minOut is the 2% band
                  // with a floor under it, so if the chain moved between this
                  // quote and the fill the contract refuses rather than
                  // filling at a price this screen never showed. deadline is
                  // ten minutes on the chain's clock, so a transaction held
                  // back and replayed later is void rather than merely late —
                  // minOut says nothing about WHEN. These reserves may be up
                  // to thirty seconds old, which can only make the trade
                  // revert, never fill worse than the line above promised.
                  var data = OC_SEL.swap + ocWord(p.id) + ocWord(q.sellPeer ? 1n : 0n) + ocWord(q.vin) + ocWord(q.min) + ocWord(await ocDeadline());
                  await ocSend(factory, data, 'Swapping in ' + label);
                  toast('Swapped in ' + label + '. ' + OC_LAG);
                  ocRefresh();
                } catch (e) { toast(led.sentence('The swap stopped', e)); }
              })();''',
    'swap sends minOut + deadline and reports where a stopped sequence left off')

# ── 11d. the add-liquidity row: free pre-check, minShares, deadline ─────────
once(
    r'''              var vp = ocUnits(addP.value, pdec), vb = ocUnits(addB.value, bdec);
              if (vp === null || vb === null) { toast('Both amounts, please.'); return; }
              (async function () {
                try {
                  if (!l2Wallet && !(await ocConnect())) { toast('Adding liquidity needs a wallet on Base.'); return; }
                  drawWallet();
                  var toks = await ocGetTokens(factory);
                  // The allowance covers the full offer; the contract pulls
                  // only the ratio-matched part of it, rounding in the
                  // pool's favour. What the ratio is right now is the
                  // chain's business, not this page's guess.
                  await ocAllow(toks.peer, factory, vp, 'PEER');
                  await ocAllow(toks.btc, factory, vb, 'cbBTC');
                  await ocSend(factory, OC_SEL.addLiquidity + ocWord(p.id) + ocWord(vp) + ocWord(vb), 'Adding liquidity to ' + label);
                  toast('Added to ' + label + ' \u2014 the proportional part of what you offered.');
                  ocLoad();
                } catch (e) { toast('Add did not go through: ' + ocErr(e)); }
              })();''',
    r'''              var vp = ocUnits(addP.value, pdec), vb = ocUnits(addB.value, bdec);
              if (vp === null || vb === null) { toast('Both amounts, please.'); return; }
              // What the pool would mint, computed the way the contract does:
              // the smaller of the two offers measured in shares. Free
              // arithmetic, and it catches the deposit too small to mint
              // anything BEFORE it costs two approvals.
              var expect = 0n;
              if (ts > 0n && rp > 0n && rb > 0n) {
                var byP = vp * ts / rp, byB = vb * ts / rb;
                expect = byP < byB ? byP : byB;
                if (expect <= 0n) { toast('That deposit is too small to mint a share in ' + label + ' \u2014 the contract would refuse it, so nothing was signed.'); return; }
              }
              var led = ocLedger();
              (async function () {
                try {
                  if (!l2Wallet && !(await ocConnect())) { toast('Adding liquidity needs a wallet on Base.'); return; }
                  drawWallet();
                  var toks = await ocGetTokens(factory);
                  // The allowance covers the full offer; the contract pulls
                  // only the ratio-matched part of it, rounding in the
                  // pool's favour. What the ratio is right now is the
                  // chain's business, not this page's guess.
                  led.landed(await ocAllow(toks.peer, factory, vp, 'PEER', pdec));
                  led.landed(await ocAllow(toks.btc, factory, vb, 'cbBTC', bdec));
                  // minShares is the sandwich guard: a swap landing just
                  // ahead of this moves the ratio, which changes WHICH side
                  // binds and can mint fewer shares for the same coins. 2%
                  // under what these reserves say, floored — and a deadline,
                  // for the same reason the swap has one.
                  await ocSend(factory, OC_SEL.addLiquidity + ocWord(p.id) + ocWord(vp) + ocWord(vb) + ocWord(ocGuard(expect)) + ocWord(await ocDeadline()), 'Adding liquidity to ' + label);
                  toast('Added to ' + label + ' \u2014 the proportional part of what you offered. ' + OC_LAG);
                  ocRefresh();
                } catch (e) { toast(led.sentence('The deposit stopped', e)); }
              })();''',
    'add liquidity: pre-check, minShares, deadline, ledger')

once(
    r'''            } }), slot));

          // The withdraw button appears only when the connected wallet''',
    r'''            } }), slot));
          if (ts <= 0n) {
            // No total-shares figure, nothing to compute a minimum from, and
            // 0 means no guard — the contract says so and so does this row.
            box.appendChild(h('p', { class: 'smallnote', text: 'This host did not report this pool\u2019s total shares, so an add here goes in with no minimum-shares guard: the ratio can move under you between pressing and mining.' }));
          }

          // The withdraw button appears only when the connected wallet''',
    'add row says when it has no share guard')

# ── 11e. withdrawing: minimums on both sides, ledger, honest refresh ────────
once(
    r'''              .then(function (res) {
                var sh = 0n;
                try { sh = BigInt(res); } catch (e) {}
                if (sh <= 0n) return;
                slot.appendChild(h('button', { class: 'btn small', text: 'Withdraw all', onclick: function () {
                  (async function () {
                    try {
                      await ocSend(factory, OC_SEL.removeLiquidity + ocWord(p.id) + ocWord(sh), 'Withdrawing from ' + label);
                      toast('Withdrew from ' + label + ' \u2014 both sides, proportional to your shares.');
                      ocLoad();
                    } catch (e) { toast('Withdraw did not go through: ' + ocErr(e)); }
                  })();
                } }));
              })''',
    r'''              .then(function (res) {
                var sh = 0n;
                // Here an unreadable answer really does just mean no button:
                // nothing is signed off this read, so the honest response to
                // silence is to offer nothing rather than to raise.
                try { sh = ocUint(res, 'your share balance'); } catch (e) { return; }
                if (sh <= 0n) return;
                slot.appendChild(h('button', { class: 'btn small', text: 'Withdraw all', onclick: function () {
                  // The slice is proportional whatever happens, but WHAT it
                  // is made of moves with the pool: a swap landing ahead of
                  // this turns some of one side into the other, so a
                  // withdrawal aimed at one coin can be sandwiched into the
                  // other. Both minimums are 2% under what these reserves
                  // say the slice is, floored so a tiny side still gets a
                  // minimum. The reserves may be half a minute old, which can
                  // only cause a revert, never a worse payout than shown.
                  var expP = ts > 0n ? sh * rp / ts : 0n;
                  var expB = ts > 0n ? sh * rb / ts : 0n;
                  var led = ocLedger();
                  (async function () {
                    try {
                      await ocSend(factory, OC_SEL.removeLiquidity + ocWord(p.id) + ocWord(sh) + ocWord(ocGuard(expP)) + ocWord(ocGuard(expB)), 'Withdrawing from ' + label);
                      toast('Withdrew from ' + label + ' \u2014 both sides, proportional to your shares. ' + OC_LAG);
                      ocRefresh();
                    } catch (e) { toast(led.sentence('The withdrawal stopped', e)); }
                  })();
                } }));
              })''',
    'withdraw sends both minimums and keeps its shares on a refusal')

# ── 12. opening a pool: free pre-checks before the first approval ───────────
once(
    r'''        // The pair is preset: every pool this factory can make is PEER
        // against cbBTC, fixed at its deployment. The name is the only
        // choice, which is the point — one press, two amounts, a pool.
        // Several pools of the same pair under different names is
        // deliberate; liquidity fragmentation was the accepted price of
        // pools people can NAME.''',
    r'''        // The pair is preset: every pool this factory can make is PEER
        // against cbBTC, fixed at its deployment. The name is the only
        // choice, which is the point — one press, two amounts, a pool.
        // Several pools of the same pair is deliberate; liquidity
        // fragmentation was the accepted price of pools people can NAME.
        //
        // The name is yours alone in one direction only: you cannot reuse one
        // of your own, and somebody else opening theirs under the same word
        // takes nothing from you. That is what stops a watcher copying a name
        // out of the mempool and paying a higher fee to steal it.''',
    'open-a-pool comment states the per-creator rule')

once(
    r'''            (async function () {
              try {
                if (!l2Wallet && !(await ocConnect())) { toast('Opening a pool needs a wallet on Base.'); return; }
                drawWallet();
                var toks = await ocGetTokens(factory);
                await ocAllow(toks.peer, factory, vp, 'PEER');
                await ocAllow(toks.btc, factory, vb, 'cbBTC');
                await ocSend(factory, OC_SEL.createPool + hexName + ocWord(vp) + ocWord(vb), 'Opening "' + nm + '"');
                toast('Opened "' + nm + '" on Base. The starting ratio IS the starting price.');
                ocLoad();
              } catch (e) { toast('Open did not go through: ' + ocErr(e)); }
            })();''',
    r'''            var led = ocLedger();
            (async function () {
              try {
                if (!l2Wallet && !(await ocConnect())) { toast('Opening a pool needs a wallet on Base.'); return; }
                drawWallet();
                // Both ways createPool can refuse, asked for free and asked
                // FIRST. An approval that lands ahead of a revert costs gas
                // and leaves a standing permission behind; a square root and
                // one eth_call cost neither.
                var s0 = ocSqrt(vp * vb);
                var minLiq = await ocMinLiq(factory);
                if (s0 <= minLiq) { toast('Too small to open: the opening shares are sqrt(PEER \u00d7 cbBTC) = ' + s0 + ' raw units and this factory locks ' + minLiq + ' of them forever, so an opener has to mint more than that. Nothing was signed.'); return; }
                if (await ocTaken(factory, l2Wallet, hexName)) { toast('You already have a pool called \u201c' + nm + '\u201d \u2014 your own names are claimed once and never reused, even after a pool is drained. Pick another; nothing was signed.'); return; }
                var toks = await ocGetTokens(factory);
                led.landed(await ocAllow(toks.peer, factory, vp, 'PEER', pdec));
                led.landed(await ocAllow(toks.btc, factory, vb, 'cbBTC', bdec));
                await ocSend(factory, OC_SEL.createPool + hexName + ocWord(vp) + ocWord(vb), 'Opening \u201c' + nm + '\u201d');
                toast('Opened \u201c' + nm + '\u201d on Base \u2014 the starting ratio IS the starting price. The name is yours, not the network\u2019s: somebody else may open one called the same thing. ' + OC_LAG);
                ocRefresh();
              } catch (e) { toast(led.sentence('Opening the pool stopped', e)); }
            })();''',
    'open a pool: free collision + MIN_LIQ pre-checks, ledger')

# ── 13. the closing note: names are per creator, not first-come ─────────────
once(
    r'''        ocBody.appendChild(h('p', { class: 'smallnote', text: 'The first 1000 raw share units of every pool are locked forever \u2014 the standard guard that stops the first depositor being robbed by rounding. Names must be new; the factory pulls amounts only after your wallet approves each token, and your wallet shows you every one before it signs.' }));

        drawWallet();
        drawPools();''',
    r'''        ocBody.appendChild(h('p', { class: 'smallnote', text: 'The first 1000 raw share units of every pool are locked forever \u2014 the standard guard that stops the first depositor being robbed by rounding, and the reason an opening deposit has to mint more than that. A name is claimed per creator: you cannot reuse one of your own, and a stranger using the same word neither takes anything from you nor gains anything by it. The factory pulls amounts only after your wallet approves each token, and your wallet shows you every one before it signs.' }));

        // The wallet's own events reach the screen through here. Assigned on
        // every render so the handler always drives the card that is actually
        // on screen, and never the one three renders ago.
        l2Redraw = function () { drawWallet(); drawPools(); };
        drawWallet();
        drawPools();''',
    'closing note + l2Redraw hook')

_data = s.encode('utf-8')
io.open(TP, 'wb').write(_data)
print('applied:', applied)
print('size: %d -> %d (+%d)' % (orig_len, len(s), len(s) - orig_len))
