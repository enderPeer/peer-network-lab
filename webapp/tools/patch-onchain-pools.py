# -*- coding: utf-8 -*-
# Adds the one-click named-pools UI (PeerPools.sol on Base) to the economy
# tab of template.html. Three patches:
#   1. a module-level l2Wallet variable (survives re-renders)
#   2. the on-chain pools card, above the in-log sandbox card
#   3. the sandbox empty-state note now points up at the card above
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


# ── patch 1: module-level wallet address ────────────────────────────────────
once(
    "  var econView = 'wallet';   // + 'net'  — the graph lives here now\n",
    "  var econView = 'wallet';   // + 'net'  — the graph lives here now\n"
    "  // The connected Base wallet address, module-level so it survives the\n"
    "  // re-render that follows every act. An address is public information;\n"
    "  // no key is ever in this variable — or anywhere else in this file.\n"
    "  var l2Wallet = null;\n",
    'module-level l2Wallet')

# ── patch 2: the on-chain pools card, above the sandbox card ────────────────
BLOCK = r'''
      // ── pools on Base — the ones that are real ──
      // This card sits above the sandbox because it is the one that costs
      // and pays actual money: the PEER ERC-20 against cbBTC — bitcoin held
      // in Coinbase custody and issued as a token on Base. The pools below
      // it settle inside this log and nowhere else; a swap here moves value
      // that exists whether or not this page does.
      //
      // The division of labour is strict, and worth stating. The HOST only
      // reads: /api/token/onchain comes from chain-l2/onchain.mjs, which
      // contains no signing code and accepts no key. The WALLET only signs:
      // every write below is encoded by hand in this file — a 4-byte
      // selector plus 32-byte words, no ABI library — and handed to
      // window.ethereum for the user to approve or refuse. The page never
      // sees a key, so there is nothing here worth stealing.
      var ocCard = h('div', { class: 'card', style: 'margin-top:14px' },
        h('h2', { text: 'Pools \u2014 PEER / BTC on Base' }),
        h('p', { class: 'smallnote', text: 'These pools settle on the real chain: the PEER token against cbBTC \u2014 bitcoin custodied by Coinbase and issued as an ERC-20 on Base. The sandbox pools below settle only in this log; everything in this card is actual money.' }));
      var ocBody = h('div', {});
      ocCard.appendChild(ocBody);
      wrap.appendChild(ocCard);

      // Hardcoded 4-byte selectors, each with the signature it hashes from —
      // the same policy as chain-l2/onchain.mjs: no keccak library in the
      // page. The pool ones match PeerPools.build.json's methodIdentifiers;
      // recompute any of them with `cast sig '<signature>'` if you do not
      // want to take them on trust, which you should not.
      var OC_SEL = {
        createPool: '0xb3a2199d',      // createPool(bytes32,uint256,uint256)
        addLiquidity: '0x422f1043',    // addLiquidity(uint256,uint256,uint256)
        removeLiquidity: '0x9d7de6b3', // removeLiquidity(uint256,uint256)
        swap: '0x7a9d1ac4',            // swap(uint256,bool,uint256,uint256)
        sharesOf: '0xe78307ca',        // sharesOf(uint256,address)
        peer: '0x11cda415',            // peer()
        btc: '0xa28d57d8',             // btc()
        approve: '0x095ea7b3',         // approve(address,uint256)
        allowance: '0xdd62ed3e'        // allowance(address,address)
      };
      var OC_CHAIN = '0x2105'; // Base mainnet, 8453

      // One 32-byte ABI word from a BigInt (a bool is just 0n or 1n), one
      // from an address. This plus the selectors above is the whole encoder
      // this card needs.
      function ocWord(v) { return BigInt(v).toString(16).padStart(64, '0'); }
      function ocAddr(a) { return String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
      function ocErr(e) { return String((e && e.message) || e).slice(0, 140); }

      // Decimal text -> raw BigInt at `dec` decimals, or null. NEVER
      // parseFloat for an amount that will be signed: a double carries 53
      // bits, a token amount carries 256, and the difference is somebody's
      // money. The fraction is truncated rather than rounded — pulling a
      // hair less than typed is a non-event; pulling more would be theft.
      function ocUnits(sIn, dec) {
        var t = String(sIn == null ? '' : sIn).trim();
        if (t === '' || t === '.' || !/^\d*(\.\d*)?$/.test(t)) return null;
        var dot = t.split('.');
        var frac = (dot[1] || '').slice(0, dec);
        while (frac.length < dec) frac += '0';
        var v = BigInt((dot[0] || '0') + frac);
        return v > 0n ? v : null;
      }
      // Raw -> a number for the screen. Precision dies here by design, so
      // nothing computed from this ever goes into a transaction.
      function ocFmt(raw, dec) {
        var n = Number(raw) / Math.pow(10, dec);
        if (!isFinite(n)) return '?';
        if (n === 0) return '0';
        return n >= 0.001 ? String(Math.round(n * 1e6) / 1e6) : n.toExponential(3);
      }
      // The UniswapV2 integer quote, exactly as the contract computes it and
      // as replay.cjs mirrors it for the sandbox (eff = amt * 0.997): fee on
      // the way in, integer division, the 0.3% staying in the pool. Run in
      // BigInt so the number on this screen is the number the chain would
      // produce against the same reserves — not a float that agrees with the
      // contract until the amounts get interesting.
      function ocQuote(amtIn, resIn, resOut) {
        var fee = amtIn * 997n;
        var den = resIn * 1000n + fee;
        return den === 0n ? 0n : (resOut * fee) / den;
      }

      function ocEth(method, params) { return window.ethereum.request({ method: method, params: params || [] }); }

      // Connecting is its own deliberate press, deploy-page style: the list
      // is readable without a wallet, and the address shown afterwards is
      // the wallet's current answer, never something remembered for it.
      async function ocConnect() {
        if (!window.ethereum) return null;
        var accs = await ocEth('eth_requestAccounts');
        if (!accs || !accs[0]) return null;
        var chain = await ocEth('eth_chainId');
        if (chain !== OC_CHAIN) {
          // The wrong network is the failure that looks most like success —
          // same shapes, different chain — so nothing proceeds until the
          // wallet itself confirms Base.
          try { await ocEth('wallet_switchEthereumChain', [{ chainId: OC_CHAIN }]); }
          catch (e) { toast('That wallet is not on Base and would not switch. Switch it by hand, then connect again.'); return null; }
        }
        l2Wallet = String(accs[0]).toLowerCase();
        return l2Wallet;
      }

      // Wait for the receipt the way deploy.html does: poll. A plain
      // provider has no push channel, and two seconds of latency on a
      // confirmation nobody is racing costs nothing.
      async function ocSend(to, data, label) {
        toast(label + ' \u2014 approve it in the wallet.');
        var tx = await ocEth('eth_sendTransaction', [{ from: l2Wallet, to: to, data: data }]);
        var rc = null;
        for (var i = 0; i < 120 && !rc; i++) {
          await new Promise(function (res) { setTimeout(res, 2000); });
          rc = await ocEth('eth_getTransactionReceipt', [tx]);
        }
        if (!rc) throw new Error('not mined after four minutes \u2014 check ' + tx + ' on basescan.org, it may yet land');
        if (rc.status !== '0x1') throw new Error('reverted on chain \u2014 nothing moved, gas was paid (' + tx + ')');
        return rc;
      }

      // Allowance first, approve only if short — and approve the exact
      // amount rather than infinity: one more signature per trade, one
      // fewer standing permission over the user's coins. This network takes
      // that trade every time.
      async function ocAllow(token, spender, need, symbol) {
        var have = 0n;
        try { have = BigInt(await ocEth('eth_call', [{ to: token, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(spender) }, 'latest'])); } catch (e) {}
        if (have >= need) return;
        await ocSend(token, OC_SEL.approve + ocAddr(spender) + ocWord(need), 'Approving ' + symbol);
      }

      // Which two tokens get approved? Asked of the factory itself, not
      // taken from this host's env: peer() and btc() are immutables the
      // factory was deployed with, and an approve aimed anywhere else is a
      // wasted signature.
      var ocTokens = null;
      async function ocGetTokens(factory) {
        if (ocTokens) return ocTokens;
        var pw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.peer }, 'latest']);
        var bw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.btc }, 'latest']);
        ocTokens = { peer: '0x' + String(pw).slice(-40), btc: '0x' + String(bw).slice(-40) };
        return ocTokens;
      }

      // One fetch per render of this tab. The host caches the answer for 30
      // seconds, so flipping between tabs cannot become load on the public
      // Base RPC.
      function ocLoad() {
        fetch(API + '/api/token/onchain', { cache: 'no-store' })
          .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
          .then(function (x) { ocRender(x.status, x.d); })
          .catch(function () {
            ocBody.innerHTML = '';
            ocBody.appendChild(h('p', { class: 'smallnote', text: 'Could not reach this host to ask about the chain. The sandbox below still works; it never leaves this log.' }));
          });
      }

      function ocRender(status, d) {
        ocBody.innerHTML = '';
        // Branch honestly. "Switched off", "misconfigured", "unreachable"
        // and "empty" are four different sentences, and blurring them is
        // how a wrong-chain RPC gets read as an empty pool. Where the
        // endpoint sent its own error sentence, it is shown verbatim —
        // never replaced with an invented zero.
        if (status === 404 || !d || d.code === 'ONCHAIN_OFF') {
          ocBody.appendChild(h('p', { class: 'smallnote', text: 'Off. The operator has not pointed this host at a deployment \u2014 PEER_TOKEN_ADDR is unset, and an address baked into source is one nobody verified. chain-l2/DEPLOY.md is the recipe.' }));
          return;
        }
        if (d.error) {
          ocBody.appendChild(h('p', { class: 'smallnote', text: d.error }));
          return;
        }
        if (!d.namedPools) {
          ocBody.appendChild(h('p', { class: 'smallnote', text: 'The token is deployed, but the pools factory is not configured (PEER_POOLS_ADDR is unset) \u2014 so there is nothing here to trade in yet.' }));
          return;
        }
        var np = d.namedPools;
        if (np.error) {
          // The factory address is set but did not answer like a factory.
          // That is the endpoint's own sentence too, and "unreadable" must
          // not be dressed up as "empty" — an empty factory invites a
          // deposit; an unreadable one is a misconfiguration to fix first.
          ocBody.appendChild(h('p', { class: 'smallnote', text: np.error }));
          return;
        }
        var factory = np.factory;
        var pdec = np.peerDecimals == null ? 18 : Number(np.peerDecimals);
        var bdec = np.btcDecimals == null ? 8 : Number(np.btcDecimals);

        var walletRow = h('div', { class: 'mini-form persistent' });
        ocBody.appendChild(walletRow);
        function drawWallet() {
          walletRow.innerHTML = '';
          if (l2Wallet) {
            walletRow.appendChild(h('span', { class: 'smallnote mono', text: l2Wallet.slice(0, 6) + '\u2026' + l2Wallet.slice(-4) + ' \u00b7 Base' }));
          } else if (window.ethereum) {
            walletRow.appendChild(h('button', { class: 'btn small', text: 'Connect wallet', onclick: function () {
              ocConnect().then(function (a) { if (a) { drawWallet(); drawPools(); } })
                .catch(function (e) { toast('Connect failed: ' + ocErr(e)); });
            } }));
            walletRow.appendChild(h('span', { class: 'smallnote', text: 'Prices are public; only signing needs the wallet. It signs, this page never sees a key.' }));
          } else {
            walletRow.appendChild(h('span', { class: 'smallnote', text: 'No wallet detected \u2014 the list stays readable, but swapping, adding or opening a pool needs one on Base.' }));
          }
        }

        var listBox = h('div', {});
        ocBody.appendChild(listBox);
        function drawPools() {
          listBox.innerHTML = '';
          if (!np.pools || !np.pools.length) {
            listBox.appendChild(h('p', { class: 'smallnote', text: 'The factory is live and empty. The first pool is opened below \u2014 its starting ratio IS its starting price.' }));
            return;
          }
          np.pools.forEach(function (p) { listBox.appendChild(poolRow(p)); });
        }

        function poolRow(p) {
          var rp = BigInt(p.resPeerRaw || '0'), rb = BigInt(p.resBtcRaw || '0');
          var label = p.name || ('#' + p.id);
          var box = h('div', {});
          var kv = h('div', { class: 'kv' },
            h('span', { text: label }),
            h('b', { class: 'num', text: ocFmt(rp, pdec) + ' PEER / ' + ocFmt(rb, bdec) + ' BTC' }));
          if (rp > 0n && rb > 0n) {
            // Display-only float; the raw integers above are the truth.
            var px = (Number(rb) / Math.pow(10, bdec)) / (Number(rp) / Math.pow(10, pdec));
            kv.appendChild(h('span', { text: 'price' }));
            kv.appendChild(h('b', { class: 'num', text: '1 PEER = ' + (px >= 0.001 ? Math.round(px * 1e8) / 1e8 : px.toExponential(3)) + ' BTC' }));
          }
          box.appendChild(kv);

          var sellSel = h('select', {}, h('option', { value: 'PEER', text: 'sell PEER' }), h('option', { value: 'BTC', text: 'sell BTC' }));
          var amtIn = h('input', { type: 'text', placeholder: 'amount', style: 'width:90px', inputmode: 'decimal' });
          var quote = h('span', { class: 'smallnote' });
          function quoteNow() {
            var sellPeer = sellSel.value === 'PEER';
            var vin = ocUnits(amtIn.value, sellPeer ? pdec : bdec);
            if (vin === null) return null;
            return { sellPeer: sellPeer, vin: vin, out: ocQuote(vin, sellPeer ? rp : rb, sellPeer ? rb : rp) };
          }
          function requote() {
            var q = quoteNow();
            quote.textContent = !q ? '' : (q.out <= 0n ? 'the pool cannot fill this'
              : '\u2192 ' + ocFmt(q.out, q.sellPeer ? bdec : pdec) + ' ' + (q.sellPeer ? 'BTC' : 'PEER') + ' (incl. 0.3% fee)');
          }
          amtIn.addEventListener('input', requote);
          sellSel.addEventListener('change', requote);
          box.appendChild(h('div', { class: 'mini-form' }, sellSel, amtIn,
            h('button', { class: 'btn small primary', text: 'Swap on Base', onclick: function () {
              var q = quoteNow();
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
              })();
            } }), quote));

          var addP = h('input', { type: 'text', placeholder: 'PEER', style: 'width:90px', inputmode: 'decimal' });
          var addB = h('input', { type: 'text', placeholder: 'cbBTC', style: 'width:90px', inputmode: 'decimal' });
          var slot = h('span', {});
          box.appendChild(h('div', { class: 'mini-form' }, addP, addB,
            h('button', { class: 'btn small', text: 'Add liquidity', onclick: function () {
              var vp = ocUnits(addP.value, pdec), vb = ocUnits(addB.value, bdec);
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
              })();
            } }), slot));

          // The withdraw button appears only when the connected wallet
          // actually holds shares in this pool — asked of the chain each
          // render, never remembered. Shares are internal accounting inside
          // the factory, not a token, so this is the only place they show.
          if (l2Wallet && window.ethereum) {
            ocEth('eth_call', [{ to: factory, data: OC_SEL.sharesOf + ocWord(p.id) + ocAddr(l2Wallet) }, 'latest'])
              .then(function (res) {
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
              })
              .catch(function () { /* a provider that refuses eth_call just means no button */ });
          }
          return box;
        }

        // ── open a pool ──
        // The pair is preset: every pool this factory can make is PEER
        // against cbBTC, fixed at its deployment. The name is the only
        // choice, which is the point — one press, two amounts, a pool.
        // Several pools of the same pair under different names is
        // deliberate; liquidity fragmentation was the accepted price of
        // pools people can NAME.
        var cName = h('input', { type: 'text', placeholder: 'pool name', style: 'flex:1', maxlength: '32' });
        var cPeer = h('input', { type: 'text', placeholder: 'PEER', style: 'width:90px', inputmode: 'decimal' });
        var cBtc = h('input', { type: 'text', placeholder: 'cbBTC', style: 'width:90px', inputmode: 'decimal' });
        ocBody.appendChild(h('p', { class: 'eyebrow', style: 'margin:10px 0 0', text: 'open a pool \u2014 PEER / cbBTC, named by you' }));
        ocBody.appendChild(h('div', { class: 'mini-form persistent' }, cName, cPeer, cBtc,
          h('button', { class: 'btn small primary', text: 'Open pool on Base', onclick: function () {
            var nm = String(cName.value || '').trim();
            if (!nm) { toast('A pool needs a name.'); return; }
            var nb = new TextEncoder().encode(nm);
            if (nb.length > 32) { toast('That name is ' + nb.length + ' bytes as UTF-8; 32 is all a bytes32 holds.'); return; }
            var vp = ocUnits(cPeer.value, pdec), vb = ocUnits(cBtc.value, bdec);
            if (vp === null || vb === null) { toast('Both starting amounts, please.'); return; }
            // bytes32: the UTF-8 bytes hex-encoded, right-padded with NULs —
            // the exact shape the host strips back off to show the name.
            var hexName = '';
            for (var i = 0; i < nb.length; i++) hexName += nb[i].toString(16).padStart(2, '0');
            while (hexName.length < 64) hexName += '0';
            (async function () {
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
            })();
          } })));
        ocBody.appendChild(h('p', { class: 'smallnote', text: 'The first 1000 raw share units of every pool are locked forever \u2014 the standard guard that stops the first depositor being robbed by rounding. Names must be new; the factory pulls amounts only after your wallet approves each token, and your wallet shows you every one before it signs.' }));

        drawWallet();
        drawPools();
      }

      ocBody.appendChild(h('p', { class: 'smallnote', text: 'Reading the chain\u2026' }));
      ocLoad();

'''

once(
    "    if (econView === 'pools') {\n      // \u2500\u2500 pools \u2500\u2500\n",
    "    if (econView === 'pools') {" + BLOCK + "      // \u2500\u2500 pools \u2500\u2500\n",
    'on-chain pools card')

# ── patch 3: the sandbox empty-state points up, not at Uniswap ──────────────
once(
    "text: 'No pools yet. PEER trades on Base, against cbBTC — that pool is the real one. Anything opened here trades minted assets against each other and settles nothing outside this log.'",
    "text: 'No pools in this log yet. The real ones \\u2014 PEER against cbBTC, settling on Base \\u2014 are in the card above. Anything opened here trades minted assets against each other and settles nothing outside this log.'",
    'sandbox empty-state note')

_data = s.encode('utf-8')
io.open(TP, 'wb').write(_data)
print('applied:', applied)
print('size: %d -> %d (+%d)' % (orig_len, len(s), len(s) - orig_len))
