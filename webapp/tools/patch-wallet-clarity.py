# Two different things in this app are called PEER, and the interface never
# said so.
#
#   1. The EPOCH token. A number in this network's act log, minted when an
#      epoch closes and distributed by engagement weight. It is on no chain,
#      it is in no wallet, and no wallet can be shown it. The Wallet tab has
#      always printed it as "you hold N PEER".
#   2. The ERC-20 on Base. Real, transferable, in a wallet, and the only one
#      of the two that a pool can trade.
#
# They share a name and a symbol and nothing else. A reader who saw "you hold
# 5000 PEER" in the Wallet tab and then could not find it in MetaMask was
# misled by this interface, not by their own mistake — and the operator's own
# question was exactly that: "the token is just a number, is it in their
# wallets, where is it".
#
# So the Wallet tab gets a card that says which is which, in that order, and
# then answers "where is it" with the only three things that can answer it:
# the token's address as this HOST reports it (never a constant in this file —
# a different operator runs a different token), a wallet_watchAsset button
# (the coins are already in the account; MetaMask does not list a token it has
# not been told about, which is the whole of the mystery), and the account's
# live PEER and cbBTC balances read by eth_call through the user's own wallet.
#
# There is no bridge between the two tokens and neither converts into the
# other. Inventing the impression of one would be worse than saying nothing,
# so the card says the opposite outright.
#
# The wallet plumbing moves out to module scope in the same pass: connecting,
# the Base chain check and the read encoders now sit beside the l2Wallet they
# write, because there are two cards that need them rather than one. The pools
# card's own copies (ocConnect, ocEth, ocWord...) still exist inside its block
# and are left alone here — it writes the same module-level l2Wallet, so a
# wallet connected in either card is connected in both.
#
# Run:  python tools/patch-wallet-clarity.py && node social/assemble.mjs
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


# ── 1. one clipboard call in the file, not two ────────────────────────────
# The burn card had the only copy-to-clipboard in the app, written inline and
# with nothing catching it: navigator.clipboard is undefined on a plain-http
# origin (this app is served over LAN http routinely) and writeText rejects
# when the document is not focused, so the button could do nothing at all and
# still say "address copied". One helper, used by both callers, and a failure
# that tells the reader to copy it by hand instead of lying to them.
once(
    """    setTimeout(function () { t.remove(); }, 4600);
  }
""",
    """    setTimeout(function () { t.remove(); }, 4600);
  }

  /**
   * Put `text` on the clipboard and say so — or say plainly that it did not.
   *
   * navigator.clipboard exists only on a secure origin, so on http over a LAN
   * (which is how this app is usually reached) it is simply not there, and
   * writeText rejects outright when the document is not focused. Both failures
   * are silent, and a button that reports success either way is worse than no
   * button: the reader pastes whatever was on the clipboard before, and an
   * address is precisely the thing nobody re-reads after pasting.
   *
   * `ok` is a sentence to toast, or a function for callers that report into
   * their own status line.
   */
  function copyLine(text, ok) {
    var said = function () { if (typeof ok === 'function') ok(); else toast(ok || 'Copied.'); };
    var failed = function () { toast('This browser would not let the page reach the clipboard \\u2014 it is on screen above, select it and copy it by hand.'); };
    if (!navigator.clipboard || !navigator.clipboard.writeText) { failed(); return; }
    navigator.clipboard.writeText(text).then(said, failed);
  }
""",
    'copyLine — one clipboard implementation, and a failure that admits it',
)

once(
    """      var copy = h('button', { class: 'btn small', text: 'Copy address', onclick: function () {
        navigator.clipboard.writeText(info.address); say('address copied');
      } });""",
    """      var copy = h('button', { class: 'btn small', text: 'Copy address', onclick: function () {
        copyLine(info.address, function () { say('address copied'); });
      } });""",
    'the burn card copies through the shared helper',
)

# ── 2. the wallet on Base, hoisted beside the state it writes ─────────────
once(
    """  var l2Watching = false;
  var alertView = 'inbound'; // | 'record'
""",
    """  var l2Watching = false;
  // The last balances read off the chain for one account, so a re-render is
  // not three more eth_calls through somebody's wallet. Keyed on the account
  // AND the token: a number read for one address must never be reprinted
  // under another, and this is cache, never a source of truth — the card
  // prints the clock time it was read at and offers to read again.
  var l2Bal = null;
  var alertView = 'inbound'; // | 'record'

  // ── the wallet on Base: connecting, the chain check, the read encoders ──
  //
  // These live out here with the state they write because two cards need them
  // now: the on-chain pools card in the Pools tab, and the token card in the
  // Wallet tab. The pools card grew its own copies (ocConnect, ocEth, ocWord…)
  // inside its own block, back when there was only one caller; both sets write
  // THIS l2Wallet, so a wallet connected in either card is connected in both.
  // The copies down there should be deleted in favour of these rather than
  // kept in step by hand.
  //
  // Nothing here signs and nothing here holds a key. eth_call is a read; the
  // one call in this file that writes anything, wallet_watchAsset, writes to
  // the WALLET's list of tokens and touches no chain.
  var L2_CHAIN = '0x2105'; // Base mainnet, 8453
  // Hardcoded 4-byte selectors, each beside the signature it hashes from —
  // the same policy as chain-l2/onchain.mjs, whose table these three are
  // copied from: no keccak library in the page. Recompute any of them with
  // `cast sig 'balanceOf(address)'` if you would rather not take them on
  // trust, which you should not.
  var L2_SEL = {
    balanceOf: '0x70a08231',   // balanceOf(address)
    decimals: '0x313ce567',    // decimals()
    symbol: '0x95d89b41'       // symbol()
  };

  function l2Eth(method, params) { return window.ethereum.request({ method: method, params: params || [] }); }
  function l2Addr(a) { return String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
  // A wallet's error can be a paragraph of JSON-RPC, so it is cut — visibly.
  function l2Err(e) {
    var t = String((e && e.message) || e);
    return t.length > 140 ? t.slice(0, 139) + '\\u2026' : t;
  }
  // A 32-byte answer as a BigInt, or a refusal in a plain sentence. An
  // eth_call that reaches an address holding no code answers '0x' — EMPTY,
  // not zero — and reading that as a balance of nothing is how a page on the
  // wrong network prints a confident number about a token that is not there.
  function l2Uint(res, what) {
    var body = String(res == null ? '' : res).replace(/^0x/, '');
    if (body.length < 64) throw new Error(what + ' answered nothing \\u2014 that call reached no contract. Check the wallet is on Base.');
    return BigInt('0x' + body.slice(0, 64));
  }
  // A raw integer amount as a decimal string, by string surgery rather than
  // division. 18,250,000 PEER at 18 decimals is 1.825e25, which no double
  // holds exactly: Number(raw)/1e18 prints a supply wrong in its last digits,
  // on the one card whose whole job is being exact about what a number means.
  // Nothing is rounded here; trailing zeros in the fraction are dropped.
  function l2Human(raw, dec) {
    var v = BigInt(raw), neg = v < 0n;
    if (neg) v = -v;
    var t = v.toString(), d = Number(dec) || 0, frac = '';
    if (d > 0) {
      while (t.length <= d) t = '0' + t;
      frac = t.slice(t.length - d).replace(/0+$/, '');
      t = t.slice(0, t.length - d);
    }
    // Grouped: the number this most often prints is eight digits of supply,
    // and an ungrouped one is not read, it is squinted at. The raw integer is
    // always printed beside it, so nothing is lost by making this one legible.
    t = t.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
    return (neg ? '-' : '') + t + (frac ? '.' + frac : '');
  }
  // symbol() answers a dynamically sized string: an offset word, a length
  // word, then the bytes. A handful of older tokens answer a bare bytes32
  // instead. Both are read here, and anything else returns '' so the caller
  // can refuse — the symbol is the name a wallet will print beside somebody's
  // balance from then on, and one this page made up would be worse than a
  // button that did nothing.
  function l2Symbol(res) {
    var body = String(res == null ? '' : res).replace(/^0x/, ''), bytes = [], i, b;
    if (body.length === 64) {
      for (i = 0; i + 2 <= 64; i += 2) {
        b = parseInt(body.slice(i, i + 2), 16);
        if (!b) break;
        bytes.push(b);
      }
    } else if (body.length >= 128) {
      var off = Number(BigInt('0x' + body.slice(0, 64))) * 2;
      if (!(off >= 64 && off + 64 <= body.length)) return '';
      var len = Number(BigInt('0x' + body.slice(off, off + 64)));
      if (!(len > 0 && len <= 64) || body.length < off + 64 + len * 2) return '';
      for (i = 0; i < len; i++) bytes.push(parseInt(body.slice(off + 64 + i * 2, off + 66 + i * 2), 16));
    }
    var t = new TextDecoder().decode(new Uint8Array(bytes));
    return /^[\\x20-\\x7e]{1,32}$/.test(t) ? t : '';
  }
  // The wallet is not a thing this page can hold still: a user can switch
  // network or account at any moment, including while a card sits open, and
  // an address left on screen after the wallet moved on is a lie the page is
  // telling for free. Registered once per page — l2Watching is the same flag
  // the pools card checks, so whichever of the two runs first installs the
  // one pair of handlers and the other skips.
  function l2WatchWallet() {
    if (!window.ethereum || !window.ethereum.on || l2Watching) return;
    l2Watching = true;
    var forget = function (why) {
      var had = l2Wallet;
      l2Wallet = null;
      l2Tokens = null;
      if (had) toast(why);
      if (l2Redraw) l2Redraw();
    };
    window.ethereum.on('chainChanged', function () { forget('The wallet left Base. Nothing here signs until it is back on Base and connected again.'); });
    window.ethereum.on('accountsChanged', function () { forget('The wallet switched accounts. Connect again \\u2014 the address shown here is only ever the one that connected.'); });
  }
  // Connecting is its own deliberate press: every card is readable without a
  // wallet. The wrong network is the failure that looks most like success —
  // same shapes, different chain — so nothing proceeds until the wallet
  // itself answers for Base, and a switch is never believed on the strength
  // of the request resolving: that means the wallet accepted the ASK, not
  // that the network moved.
  async function l2Connect() {
    if (!window.ethereum) return null;
    l2WatchWallet();
    var accs = await l2Eth('eth_requestAccounts');
    if (!accs || !accs[0]) return null;
    var chain = await l2Eth('eth_chainId');
    if (chain !== L2_CHAIN) {
      try { await l2Eth('wallet_switchEthereumChain', [{ chainId: L2_CHAIN }]); }
      catch (e) { toast('That wallet is not on Base and would not switch. Switch it by hand, then connect again.'); return null; }
      chain = await l2Eth('eth_chainId');
      if (chain !== L2_CHAIN) { toast('The wallet still answers for chain ' + chain + ', not Base. Nothing here will read or sign until it does.'); return null; }
    }
    l2Wallet = String(accs[0]).toLowerCase();
    return l2Wallet;
  }
""",
    'module-level wallet plumbing beside the l2Wallet it writes',
)

# ── 3. name the epoch token where the balance is first read ───────────────
# This is the sentence that had to exist: "Your balances" is the first thing
# in the tab, and it was the number people went looking for in MetaMask.
once(
    """    hold.appendChild(kv);
    if (!anyHeld) {
      hold.appendChild(h('p', { class: 'smallnote', text: 'Nothing yet. PEER arrives when an epoch closes and someone has engaged with what you made — or from the pool, if somebody is selling.' }));
    }
    wrap.appendChild(hold);
""",
    """    hold.appendChild(kv);
    if (!anyHeld) {
      hold.appendChild(h('p', { class: 'smallnote', text: 'Nothing yet. PEER arrives when an epoch closes and someone has engaged with what you made — or from the pool, if somebody is selling.' }));
    }
    hold.appendChild(h('p', { class: 'smallnote', text: 'These are epoch tokens: numbers in this network\\u2019s act log, which anyone can replay and check. They are not on any chain and not in any wallet \\u2014 a wallet cannot be shown them. The ERC-20 called PEER on Base is a separate token that shares the name; it has its own card at the bottom of this tab.' }));
    wrap.appendChild(hold);
""",
    'the balances card names what it is counting',
)

# ── 4. the card ───────────────────────────────────────────────────────────
once(
    """  function econTab(st) {
    var l0 = st.l0;
""",
    """  /**
   * PEER on Base — the ERC-20, which is NOT the epoch token above it.
   *
   * Two different things in this app are called PEER and the interface did not
   * say so anywhere. The cards above print "you hold N PEER" out of the act
   * log: a number in a ledger anyone can replay, minted when an epoch closes,
   * on no chain and in no wallet — a wallet cannot even be shown it. The PEER
   * here is an ERC-20 deployed on Base: it sits in an account, it moves when
   * its holder signs, and it is the only one of the two that a pool can trade.
   * They share a name and a symbol and nothing else. There is no bridge, no
   * claim and no conversion in either direction, and nothing in this codebase
   * could make one — so this card says that outright, first, rather than
   * leaving two tokens to be read as one.
   *
   * Everything shown is read, never assumed. The address, its decimals and
   * the supply come from this host's /api/token/onchain and are NEVER
   * constants in this file: a different operator runs a different token, and
   * an address baked into source is one nobody verified. The balances come
   * from eth_call through the user's own wallet, so they are the chain's
   * answer rather than this host's 30-second cache. The one call that writes
   * anything, wallet_watchAsset, writes to the WALLET's list of tokens: it
   * touches no chain, no balance and no coin, and the button says so, because
   * a button next to a balance looks like it does something to the balance.
   */
  function l2TokenCard() {
    var card = h('div', { class: 'card', style: 'margin-top:14px' },
      h('h2', { text: 'PEER on Base \\u2014 the coin in your wallet' }));
    var body = h('div', {});
    card.appendChild(body);

    function only(text) {
      body.innerHTML = '';
      body.appendChild(h('p', { class: 'smallnote', text: text }));
    }

    function draw(status, d) {
      body.innerHTML = '';
      // Four different sentences, and blurring them is how "switched off"
      // gets read as "empty". Where the endpoint sent its own error, it is
      // shown verbatim and never replaced with an invented zero.
      if (status === 404 || !d || d.code === 'ONCHAIN_OFF' || !d.token) {
        only('The operator of this host has not deployed a token \\u2014 PEER_TOKEN_ADDR is unset, and an address baked into source is one nobody verified, so this card will not print one. There is no ERC-20 called PEER here; the PEER counted above is the epoch token in this network\\u2019s log, and it was never on a chain.');
        return;
      }
      if (d.error) { only(d.error); return; }
      if (d.decimals == null || d.totalSupplyRaw == null) {
        only('This host names a token at ' + d.token + ' but could not read its decimals or its supply off the chain, so every number here would be a guess. Nothing else is shown until it can.');
        return;
      }

      var token = String(d.token);
      var btc = d.btc ? String(d.btc) : null;
      var dec = Number(d.decimals);
      var supply = BigInt(d.totalSupplyRaw);
      var chainId = Number(d.chainId);

      // ── which token is which, before anything else on the card ──
      body.appendChild(h('p', { class: 'smallnote', text: 'The PEER counted further up this tab is the EPOCH token: a number in this network\\u2019s act log, minted when an epoch closes and shared out by engagement. It is not on a chain, it is not in a wallet, and no wallet can be pointed at it.' }));
      body.appendChild(h('p', { class: 'smallnote', text: 'The PEER below is a different token that happens to share the name: an ERC-20 on Base. That is the one a wallet holds and the only one an on-chain pool can trade. There is no bridge between the two and neither converts into the other \\u2014 nothing in this app can turn epoch PEER into the coin below, or the coin below into epoch PEER.' }));

      // ── the address, in full, because half an address reads as provenance ──
      body.appendChild(h('p', { class: 'eyebrow', style: 'margin:14px 0 4px',
        text: isFinite(chainId) ? 'the contract, on chain ' + chainId : 'the contract' }));
      var addrRow = h('div', { class: 'mini-form persistent' },
        h('span', { class: 'num', style: 'word-break:break-all', text: token }),
        h('button', { class: 'btn small', text: 'Copy address', onclick: function () {
          copyLine(token, 'Token address copied.');
        } }));
      // Only where the explorer is the one for this chain. An operator running
      // this app against another network gets no link rather than a wrong one.
      if (chainId === 8453) {
        addrRow.appendChild(h('a', { class: 'smallnote', target: '_blank', rel: 'noopener',
          href: 'https://basescan.org/token/' + token, text: 'check it on basescan' }));
      }
      body.appendChild(addrRow);
      body.appendChild(h('p', { class: 'smallnote', text: 'Read from this host, not from anything written into the page \\u2014 whoever runs this app points it at their own deployment, so an address in the source would be one nobody checked.' }));

      // ── the actual answer to "where is it" ──
      var addRow = h('div', { class: 'mini-form persistent' });
      if (window.ethereum) {
        addRow.appendChild(h('button', { class: 'btn small primary', text: 'Add to MetaMask', onclick: function () {
          addToWallet().catch(function (e) { toast('The wallet refused: ' + l2Err(e)); });
        } }));
        addRow.appendChild(h('span', { class: 'smallnote', text: 'This only tells the wallet that the token exists. It moves nothing, mints nothing and changes no balance: coins sent to an account are in it whether or not the wallet lists them, and MetaMask simply does not show a token it has never been told about. That is the whole of \\u201cwhere is it\\u201d.' }));
      } else {
        addRow.appendChild(h('span', { class: 'smallnote', text: 'No wallet in this browser. Anything sent to an account on Base is in it regardless \\u2014 open that account in a wallet on Base and paste the address above under \\u201cimport token\\u201d to see it listed.' }));
      }
      body.appendChild(addRow);

      // ── connect, then read the two balances that decide what is possible ──
      var wRow = h('div', { class: 'mini-form persistent' });
      var balBox = h('div', {});
      body.appendChild(wRow);
      body.appendChild(balBox);

      // ── supply, so no share is read without its denominator ──
      body.appendChild(h('div', { class: 'kv', style: 'margin-top:10px' },
        h('span', { text: 'total supply' }), h('b', { class: 'num', text: l2Human(supply, dec) + ' PEER' }),
        h('span', { text: 'raw, at ' + dec + ' decimals' }), h('b', { class: 'num', text: supply.toString() })));

      async function addToWallet() {
        if (!window.ethereum) { toast('There is no wallet in this browser to add it to.'); return; }
        var acct = l2Wallet || await l2Connect();
        if (!acct) return;              // l2Connect already said why
        // MetaMask adds a token to the network the wallet is ON. Asked on the
        // wrong one it would list this address against a chain where nothing
        // is deployed at it, which is a permanent wrong entry in somebody's
        // wallet, so the chain is re-asked here rather than assumed from the
        // check made at connect time.
        var chain = await l2Eth('eth_chainId');
        if (chain !== L2_CHAIN) {
          l2Wallet = null;
          drawWallet();
          toast('The wallet is on chain ' + chain + ', not Base \\u2014 a token added there would point at an address with nothing behind it. Put it on Base and connect again.');
          return;
        }
        // The symbol comes off the token itself. Not from this file: a wallet
        // listing somebody else's name for this contract is worse than a
        // button that refuses.
        var sym = l2Symbol(await l2Eth('eth_call', [{ to: token, data: L2_SEL.symbol }, 'latest']));
        if (!sym) { toast('That contract did not answer symbol() with a readable name, so nothing was added \\u2014 a token listed under a name this page invented would be worse than one not listed.'); return; }
        var ok = await l2Eth('wallet_watchAsset', { type: 'ERC20', options: { address: token, symbol: sym, decimals: dec } });
        toast(ok === false
          ? 'The wallet declined to add it. Nothing changed \\u2014 the coins are wherever they were either way.'
          : sym + ' is now listed in that wallet. No coin moved: this told the wallet the token exists, nothing more.');
      }

      async function readBalances() {
        var acct = l2Wallet;
        if (!acct) return;
        balBox.innerHTML = '';
        balBox.appendChild(h('p', { class: 'smallnote', text: 'Reading the chain\\u2026' }));
        try {
          // Asked again at the last moment: l2Wallet outlives the check made
          // at connect time on purpose, so between connecting and now the
          // wallet may have moved to a network where these addresses hold no
          // code — or, worse, hold something else.
          var chain = await l2Eth('eth_chainId');
          if (chain !== L2_CHAIN) {
            l2Wallet = null;
            l2Bal = null;
            drawWallet();
            toast('That wallet is on chain ' + chain + ' now, not Base. Nothing was read \\u2014 a balance from the wrong chain is not this token\\u2019s balance.');
            return;
          }
          var peerRaw = l2Uint(await l2Eth('eth_call', [{ to: token, data: L2_SEL.balanceOf + l2Addr(acct) }, 'latest']), 'that account\\u2019s PEER balance');
          var btcRaw = null, btcDec = 8;
          if (btc) {
            btcDec = Number(l2Uint(await l2Eth('eth_call', [{ to: btc, data: L2_SEL.decimals }, 'latest']), 'the cbBTC decimals'));
            btcRaw = l2Uint(await l2Eth('eth_call', [{ to: btc, data: L2_SEL.balanceOf + l2Addr(acct) }, 'latest']), 'that account\\u2019s cbBTC balance');
          }
          // The wallet can switch accounts mid-read. Numbers read for one
          // address must never be printed under another.
          if (l2Wallet !== acct) return;
          l2Bal = { acct: acct, token: token, peer: peerRaw.toString(), btc: btcRaw === null ? null : btcRaw.toString(), btcDec: btcDec, at: Date.now() };
        } catch (e) {
          if (l2Wallet !== acct) return;
          balBox.innerHTML = '';
          balBox.appendChild(h('p', { class: 'smallnote', text: 'Could not read the balances: ' + l2Err(e) }));
          return;
        }
        showBalances();
      }

      function showBalances() {
        balBox.innerHTML = '';
        if (!l2Bal || l2Bal.acct !== l2Wallet || l2Bal.token !== token) return;
        var peerRaw = BigInt(l2Bal.peer);
        var kv = h('div', { class: 'kv' },
          h('span', { text: 'this account holds' }), h('b', { class: 'num', text: l2Human(peerRaw, dec) + ' PEER' }),
          h('span', { text: 'raw, at ' + dec + ' decimals' }), h('b', { class: 'num', text: peerRaw.toString() }));
        // Share of supply in basis points by integer division, so a hundred
        // per cent is a hundred per cent and a dust balance does not round up
        // into looking like one.
        if (supply > 0n) {
          var bp = peerRaw * 10000n / supply;
          kv.appendChild(h('span', { text: 'share of the whole supply' }));
          kv.appendChild(h('b', { class: 'num', text: bp === 0n && peerRaw > 0n ? 'under 0.01%' : (Number(bp) / 100).toFixed(2) + '%' }));
        }
        balBox.appendChild(kv);
        if (supply > 0n && peerRaw === supply) {
          // Neutral, and worth the sentence: a token one address holds all of
          // has never been priced by anybody, and a reader should know that
          // before reading a price into any number on this page.
          balBox.appendChild(h('p', { class: 'smallnote', text: 'This account holds every PEER in existence. Nobody else has any, no pool has ever traded it, and nothing has ever priced it \\u2014 which is the ordinary state of a token on the day it is deployed, and not a claim about what it is worth.' }));
        }
        if (!btc) {
          balBox.appendChild(h('p', { class: 'smallnote', text: 'This host has no cbBTC address configured (PEER_BTC_ADDR is unset), so this card cannot say whether that account holds any. A pool trades PEER against cbBTC, so it is the other number to know before opening one.' }));
        } else if (l2Bal.btc === null) {
          balBox.appendChild(h('p', { class: 'smallnote', text: 'The cbBTC balance was not read.' }));
        } else {
          var btcRaw = BigInt(l2Bal.btc);
          var btcKv = h('div', { class: 'kv' });
          btcKv.appendChild(h('span', { text: 'and cbBTC' }));
          btcKv.appendChild(h('b', { class: 'num', text: l2Human(btcRaw, l2Bal.btcDec) + ' cbBTC' }));
          btcKv.appendChild(h('span', { text: 'raw, at ' + l2Bal.btcDec + ' decimals' }));
          btcKv.appendChild(h('b', { class: 'num', text: btcRaw.toString() }));
          balBox.appendChild(btcKv);
          if (btcRaw === 0n) {
            // Said here, where it is cheap, rather than three clicks later at
            // a wallet prompt that reverts.
            balBox.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text: 'This account holds no cbBTC. Every pool here is PEER against cbBTC \\u2014 bitcoin custodied by Coinbase and issued as a token on Base \\u2014 so opening a pool or adding to one needs some in this same account. Nothing in this app can create it: it is bridged or bought on Base like any other coin.' }));
          }
        }
        balBox.appendChild(h('p', { class: 'smallnote', text: 'Read from the chain by this browser at ' + new Date(l2Bal.at).toLocaleTimeString() + ', through the connected wallet \\u2014 not from this host, and not from the log.' }));
      }

      function drawWallet() {
        wRow.innerHTML = '';
        balBox.innerHTML = '';
        if (!window.ethereum) {
          wRow.appendChild(h('span', { class: 'smallnote', text: 'No wallet here to read a balance with. The supply below still comes from the chain.' }));
          return;
        }
        if (!l2Wallet) {
          wRow.appendChild(h('button', { class: 'btn small', text: 'Connect wallet', onclick: function () {
            l2Connect().then(function (a) { if (a) drawWallet(); })
              .catch(function (e) { toast('Connect failed: ' + l2Err(e)); });
          } }));
          wRow.appendChild(h('span', { class: 'smallnote', text: 'Connecting shows an address and reads two balances. It signs nothing, and this page never sees a key.' }));
          return;
        }
        wRow.appendChild(h('span', { class: 'smallnote num', style: 'word-break:break-all', text: l2Wallet + ' \\u00b7 Base' }));
        wRow.appendChild(h('button', { class: 'btn small', text: 'Read again', onclick: function () { readBalances(); } }));
        // A remembered read is shown at once and its clock time with it; a
        // stale or missing one is re-read. Re-rendering this tab should not
        // cost three more calls through somebody's wallet.
        if (l2Bal && l2Bal.acct === l2Wallet && l2Bal.token === token && Date.now() - l2Bal.at < 60000) showBalances();
        else readBalances();
      }

      // The wallet's own events reach whichever card is on screen through
      // this one slot; the pools card sets it the same way when it renders,
      // and the two are never mounted at once. Only claimed if this card is
      // actually in the document — a fetch that lands after the reader has
      // moved on must not take the hook away from the card they moved to.
      if (card.isConnected) l2Redraw = function () { drawWallet(); };
      drawWallet();
    }

    only('Asking this host which token it serves\\u2026');
    // One fetch per render of this tab, like the pools card: the host answers
    // from a 30-second cache, so flipping between tabs cannot become load on
    // the public Base RPC.
    fetch(API + '/api/token/onchain', { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (x) { draw(x.status, x.d); })
      .catch(function () {
        only('Could not reach this host to ask which token it serves, so there is no address here that anybody verified \\u2014 and this card will not print one from memory. Nothing above is affected: that PEER is the epoch token in this network\\u2019s log and was never on a chain.');
      });
    return card;
  }

  function econTab(st) {
    var l0 = st.l0;
""",
    'the PEER-on-Base card',
)

once(
    """      wrap.appendChild(tCard);

    }
""",
    """      wrap.appendChild(tCard);
      // Directly under the epoch token, because the two are only confusable
      // while they are apart.
      wrap.appendChild(l2TokenCard());

    }
""",
    'the card is mounted under the epoch-token card',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
