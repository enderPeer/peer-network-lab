# Five confirmed defects, all of them places where the interface says
# something that is not true of the thing the user is about to press.
#
#  1. The advert card told a reader holding no epoch PEER to "buy some from
#     the pool on Base" — the one bridge this whole change existed to deny.
#     Log PEER is credited in exactly two places (the epoch distribution and
#     an in-log pool swap); nothing on Base credits it, ever. So the card
#     invited somebody to spend real cbBTC on an ERC-20 that cannot pay for
#     the placement, on the same screen where the purchase is two clicks
#     away. replay.cjs said the same thing in its refusal AND in the design
#     comment that states the intent, so all three are corrected.
#
#  2. "This account holds every PEER in existence" was drawn only for the
#     wallet that holds it — i.e. for the one reader who already knew. Every
#     other reader saw a supply, a 0.00% share and no word about how the
#     other 100% is held, then read a price off a pool ratio. The fact is
#     stated unconditionally now (without needing an indexer: the card says
#     what it cannot see, and links the holders list), and repeated wherever
#     a price is printed.
#
#  3. The token card printed the HOST's chain id and the HOST's supply, then
#     read balanceOf on Base, because the required wallet chain was a
#     constant in this file. On a host configured for any other EVM chain
#     that prints another token's balance under the PEER name — same
#     deployer, same nonce, same address is ordinary — and "Add to MetaMask"
#     would list a foreign-chain address permanently. The wallet chain is
#     derived from what the host serves now. The pools card had the same
#     hole with worse consequences (it SIGNS), and refuses to draw rather
#     than translating itself, since every button on it says "on Base".
#
#  4. Every slippage guard was a percentage of reserves frozen at render
#     time, and the reserves were never re-read before signing — with up to
#     two approvals, each polled for four minutes, in between. The old
#     comment claimed thirty seconds and claimed a stale guard "can only
#     revert, never fill worse". Both halves are wrong: a pool that moved in
#     the user's FAVOUR leaves minOut far under the fair output, and a
#     sandwicher keeps the difference while the 2% band holds perfectly.
#     poolInfo is re-read after the last approval confirms, the guard is
#     computed from the fresh numbers AND floored at what the screen
#     promised, and a move outside the band stops rather than signs.
#
#  5. Swap, Add liquidity and Withdraw had no re-entry lock, so a second
#     press while MetaMask showed the APPROVAL prompt started a second
#     signing sequence — two approves, and whichever mining order restores
#     the allowance lets both trades through. createPool was locked but left
#     its inputs live, so the "You are setting the price" line could drift
#     away from the amounts actually being signed.
#
# Run:  python tools/patch-two-peers-and-pool-guards.py && node social/assemble.mjs
import io

TP = 'social/template.html'
RP = 'social/replay.cjs'


class File(object):
    def __init__(self, path):
        self.path = path
        self.s = io.open(path, encoding='utf-8').read()
        self.before = len(self.s)

    def once(self, old, new, label):
        n = self.s.count(old)
        assert n == 1, 'anchor %r matched %d times in %s, expected exactly 1' % (label, n, self.path)
        self.s = self.s.replace(old, new, 1)
        print('  patched: ' + label)

    def write(self):
        _data = self.s.encode('utf-8')      # own line, FIRST: open(wb) truncates
        io.open(self.path, 'wb').write(_data)
        print('%s %d -> %d chars' % (self.path, self.before, len(self.s)))


t = File(TP)
r = File(RP)

# ══════════════════════════════════════════════════════════════════════════
# 1. The two PEERs, said where somebody is about to act on the wrong one
# ══════════════════════════════════════════════════════════════════════════

t.once(
    "PEER is earned by drawing engagement, or bought from the pool on Base, "
    "so buying attention means buying it from the people who earned it. It goes live immediately.' }));\n",
    "This is the EPOCH token \\u2014 the number counted in the Wallet tab, earned by drawing engagement or bought in "
    "one of the sandbox pools further down this page, which settle in this log and nowhere else. "
    "Buying attention means buying it from the people who earned it. It goes live immediately.' }));\n"
    "      adCard2.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text:\n"
    "        'Not the PEER on Base. The ERC-20 in the Wallet tab shares this name and this symbol and nothing else: it cannot pay for a placement, "
    "and no act, no host and no contract in this network turns one into the other. Buying it will not buy you this box.' }));\n",
    'advert intro names the epoch token and denies the bridge instead of selling it',
)

t.once(
    "'You hold no PEER. It arrives when an epoch closes",
    "'You hold no epoch PEER. It arrives when an epoch closes",
    'the empty-balance warning says WHICH PEER is empty',
)
t.once(
    "or buy some from the pool on Base.' }));\n",
    "or from a sandbox pool in this log, which is where this PEER lives. The PEER on Base is a different token that shares the name: "
    "it cannot pay for a placement, and nothing here converts it into one that can.' }));\n",
    'the empty-balance warning stops pointing at Base for a coin Base cannot supply',
)

# The engine says it twice — once to the user, once to the next reader of the
# source — and the comment is the worse of the two, because it states the
# falsehood as the design's intent rather than as a stale phrasing.
r.once(
    "  // PEER is the network's own scarce thing now: minted only by the epoch\n"
    "  // distribution, and obtainable by anyone else only from the pool on Base.\n",
    "  // PEER is the network's own scarce thing now: minted only by the epoch\n"
    "  // distribution, and obtainable by anyone else only from a pool INSIDE\n"
    "  // this log. It is NOT the ERC-20 called PEER on Base. That token shares\n"
    "  // the name and the symbol and nothing else: there is no bridge in either\n"
    "  // direction, and nothing in this engine, on any host, or on any chain\n"
    "  // credits this balance from anything held in a wallet. tokCredit at the\n"
    "  // epoch close and an in-log poolSwap are the only two writers there are.\n",
    'the engine comment states the intent that is actually implemented',
)
r.once(
    "          + '. PEER is earned by drawing engagement, or bought from the pool.';\n",
    "          + '. This PEER is the epoch token in this log: it is earned by drawing engagement, or bought in a pool inside this log. "
    "The PEER on Base is a different token that shares the name and cannot pay for a placement.';\n",
    'the engine refusal names the log rather than sending somebody to Base',
)

# ══════════════════════════════════════════════════════════════════════════
# 2. The chain the wallet must be on is the chain the HOST serves
# ══════════════════════════════════════════════════════════════════════════

t.once(
    "  var L2_CHAIN = '0x2105'; // Base mainnet, 8453\n",
    "  var L2_CHAIN = '0x2105'; // Base mainnet, 8453\n"
    "  // Which chain a wallet must be on to answer for this token is the chain\n"
    "  // THIS HOST serves, and it used to be the constant above. The token card\n"
    "  // prints the host's chain id and the host's supply and then read\n"
    "  // balanceOf on Base regardless: with PEER_CHAIN_ID set to anything else\n"
    "  // that prints a DIFFERENT token's balance under this token's name and\n"
    "  // divides it by another chain's supply — and the same deployer at the\n"
    "  // same nonce lands on the same address on every EVM chain, so this is an\n"
    "  // ordinary configuration, not a corner. l2Uint only refuses when the\n"
    "  // address is codeless on Base, which is exactly the case that does not\n"
    "  // arise. Derived from the host now, and where the host names no chain\n"
    "  // this page reads no balance at all rather than reading one somewhere.\n"
    "  function l2ChainHex(n) {\n"
    "    var v = Number(n);\n"
    "    if (!isFinite(v) || v <= 0 || Math.floor(v) !== v) return null;\n"
    "    return '0x' + v.toString(16);\n"
    "  }\n"
    "  function l2ChainName(n) { return Number(n) === 8453 ? 'Base' : 'chain ' + Number(n); }\n"
    "  // Compared as numbers, not as text: a wallet answering '0x2105' and one\n"
    "  // answering '0x02105' mean the same chain, and a false MISMATCH only ever\n"
    "  // refuses. Anything unparseable is not a match, which is the safe way\n"
    "  // round — the dangerous error here is a false match, and BigInt cannot\n"
    "  // produce one.\n"
    "  function l2OnChain(got, wantHex) {\n"
    "    try { return BigInt(got) === BigInt(wantHex); } catch (e) { return false; }\n"
    "  }\n",
    'the required wallet chain is derivable from the host rather than constant',
)

t.once(
    "  async function l2Connect() {\n"
    "    if (!window.ethereum) return null;\n"
    "    l2WatchWallet();\n"
    "    var accs = await l2Eth('eth_requestAccounts');\n"
    "    if (!accs || !accs[0]) return null;\n"
    "    var chain = await l2Eth('eth_chainId');\n"
    "    if (chain !== L2_CHAIN) {\n"
    "      try { await l2Eth('wallet_switchEthereumChain', [{ chainId: L2_CHAIN }]); }\n"
    "      catch (e) { toast('That wallet is not on Base and would not switch. Switch it by hand, then connect again.'); return null; }\n"
    "      chain = await l2Eth('eth_chainId');\n"
    "      if (chain !== L2_CHAIN) { toast('The wallet still answers for chain ' + chain + ', not Base. Nothing here will read or sign until it does.'); return null; }\n"
    "    }\n"
    "    l2Wallet = String(accs[0]).toLowerCase();\n"
    "    return l2Wallet;\n"
    "  }\n",
    "  async function l2Connect(wantHex, wantName) {\n"
    "    if (!window.ethereum) return null;\n"
    "    var want = wantHex || L2_CHAIN, name = wantName || 'Base';\n"
    "    l2WatchWallet();\n"
    "    var accs = await l2Eth('eth_requestAccounts');\n"
    "    if (!accs || !accs[0]) return null;\n"
    "    var chain = await l2Eth('eth_chainId');\n"
    "    if (!l2OnChain(chain, want)) {\n"
    "      try { await l2Eth('wallet_switchEthereumChain', [{ chainId: want }]); }\n"
    "      catch (e) { toast('That wallet is not on ' + name + ' and would not switch. Switch it by hand, then connect again.'); return null; }\n"
    "      chain = await l2Eth('eth_chainId');\n"
    "      if (!l2OnChain(chain, want)) { toast('The wallet still answers for chain ' + chain + ', not ' + name + '. Nothing here will read or sign until it does.'); return null; }\n"
    "    }\n"
    "    l2Wallet = String(accs[0]).toLowerCase();\n"
    "    return l2Wallet;\n"
    "  }\n",
    'l2Connect takes the chain it must reach instead of assuming Base',
)

# Both copies of the wallet watcher say the same neutral thing, because only
# ONE of the two ever registers (whichever card renders first) and a message
# naming Base would be wrong on a host that serves anything else.
t.once(
    "    window.ethereum.on('chainChanged', function () { forget('The wallet left Base. Nothing here signs until it is back on Base and connected again.'); });\n",
    "    window.ethereum.on('chainChanged', function () { forget('The wallet changed network. Nothing here reads or signs until it is back on the chain this host serves and connected again.'); });\n",
    'the shared wallet watcher stops naming a chain it cannot know',
)
t.once(
    "        window.ethereum.on('chainChanged', function () { ocForget('The wallet left Base. Nothing here signs until it is back on Base and connected again.'); });\n",
    "        window.ethereum.on('chainChanged', function () { ocForget('The wallet changed network. Nothing here reads or signs until it is back on the chain this host serves and connected again.'); });\n",
    'the pools card copy of the watcher says the same thing',
)

t.once(
    "      var chainId = Number(d.chainId);\n",
    "      var chainId = Number(d.chainId);\n"
    "      // Everything below that touches a wallet is anchored to THIS, never\n"
    "      // to the constant at the top of the file. Null where the host named\n"
    "      // no usable chain, and then no balance is read at all: a number read\n"
    "      // off some other chain and printed under this token's name is worse\n"
    "      // than no number, because it looks exactly like an answer.\n"
    "      var chainHex = l2ChainHex(chainId);\n"
    "      var chainName = l2ChainName(chainId);\n",
    'the token card derives its wallet chain from what the host answered',
)

t.once(
    "      if (window.ethereum) {\n"
    "        addRow.appendChild(h('button', { class: 'btn small primary', text: 'Add to MetaMask', onclick: function () {\n",
    "      if (!chainHex) {\n"
    "        addRow.appendChild(h('span', { class: 'smallnote', text: 'This host did not answer with a chain id, so this page cannot tell a wallet which network to ask \\u2014 and a balance read on the wrong one would be some other token\\u2019s, printed under this name. The address and the supply above are what the host reported; nothing here is read through a wallet until the host says which chain it serves.' }));\n"
    "      } else if (window.ethereum) {\n"
    "        addRow.appendChild(h('button', { class: 'btn small primary', text: 'Add to MetaMask', onclick: function () {\n",
    'no wallet row where the host named no chain to point it at',
)
t.once(
    "'No wallet in this browser. Anything sent to an account on Base is in it regardless ",
    "'No wallet in this browser. Anything sent to an account on ' + chainName + ' is in it regardless ",
    'the no-wallet sentence names the chain the host serves (first half)',
)
t.once(
    "open that account in a wallet on Base and paste the address above under ",
    "open that account in a wallet on ' + chainName + ' and paste the address above under ",
    'the no-wallet sentence names the chain the host serves (second half)',
)

t.once(
    "      if (window.ethereum) body.appendChild(wRow);\n",
    "      if (window.ethereum && chainHex) body.appendChild(wRow);\n",
    'the connect row is drawn only where there is a chain to connect to',
)

t.once(
    "        var acct = l2Wallet || await l2Connect();\n",
    "        var acct = l2Wallet || await l2Connect(chainHex, chainName);\n",
    'add-to-wallet connects to the host’s chain',
)
t.once(
    "        var chain = await l2Eth('eth_chainId');\n"
    "        if (chain !== L2_CHAIN) {\n"
    "          l2Wallet = null;\n"
    "          drawWallet();\n",
    "        var chain = await l2Eth('eth_chainId');\n"
    "        if (!chainHex || !l2OnChain(chain, chainHex)) {\n"
    "          l2Wallet = null;\n"
    "          drawWallet();\n",
    'add-to-wallet re-checks the host’s chain, not Base',
)
t.once(
    "toast('The wallet is on chain ' + chain + ', not Base ",
    "toast('The wallet is on chain ' + chain + ', not ' + chainName + ' ",
    'the add-to-wallet refusal names the chain it wanted',
)
t.once(
    "Put it on Base and connect again.');\n",
    "Put it on ' + chainName + ' and connect again.');\n",
    'the add-to-wallet refusal says which chain to switch to',
)

t.once(
    "          if (chain !== L2_CHAIN) {\n"
    "            l2Wallet = null;\n"
    "            l2Bal = null;\n",
    "          if (!chainHex || !l2OnChain(chain, chainHex)) {\n"
    "            l2Wallet = null;\n"
    "            l2Bal = null;\n",
    'the balance read re-checks the host’s chain, not Base',
)
t.once(
    "+ chain + ' now, not Base. Nothing was read ",
    "+ chain + ' now, not ' + chainName + '. Nothing was read ",
    'the balance refusal names the chain it wanted',
)

t.once(
    "        // The row is not in the document at all without a wallet.\n"
    "        if (!window.ethereum) return;\n",
    "        // The row is not in the document at all without a wallet, nor\n"
    "        // without a chain from the host to point one at.\n"
    "        if (!window.ethereum || !chainHex) return;\n",
    'the wallet row refuses to draw with no chain to read on',
)
t.once(
    "            l2Connect().then(function (a) { if (a) drawWallet(); })\n",
    "            l2Connect(chainHex, chainName).then(function (a) { if (a) drawWallet(); })\n",
    'the connect button asks for the host’s chain',
)
t.once(
    "text: l2Wallet + ' \\u00b7 Base' }));\n",
    "text: l2Wallet + ' \\u00b7 ' + chainName }));\n",
    'the connected address is labelled with the chain it was read on',
)

# ══════════════════════════════════════════════════════════════════════════
# 3. How the supply is held, stated to everybody rather than to its holder
# ══════════════════════════════════════════════════════════════════════════

t.once(
    "      body.appendChild(h('div', { class: 'kv', style: 'margin-top:10px' },\n"
    "        h('span', { text: 'total supply' }), h('b', { class: 'num', text: l2Human(supply, dec) + ' PEER' }),\n"
    "        h('span', { text: 'raw, at ' + dec + ' decimals' }), h('b', { class: 'num', text: supply.toString() })));\n",
    "      body.appendChild(h('div', { class: 'kv', style: 'margin-top:10px' },\n"
    "        h('span', { text: 'total supply' }), h('b', { class: 'num', text: l2Human(supply, dec) + ' PEER' }),\n"
    "        h('span', { text: 'raw, at ' + dec + ' decimals' }), h('b', { class: 'num', text: supply.toString() })));\n"
    "      // Said to EVERY reader, not only to the one address that holds it.\n"
    "      // The note further down (\\u201cthis account holds every PEER in\n"
    "      // existence\\u201d) is drawn only when the connected wallet IS that\n"
    "      // address \\u2014 which is the one person who already knew. Everybody\n"
    "      // else saw a supply, a 0.00% share, and then a pool ratio a few\n"
    "      // hundred pixels below, with nothing between the two to stop the\n"
    "      // ratio being read as a market. This page cannot count holders\n"
    "      // without an indexer, so it says exactly that and links the list\n"
    "      // rather than inventing a distribution.\n"
    "      body.appendChild(h('p', { class: 'smallnote', text: 'How that supply is HELD is not something this card can show. It reads one balance \\u2014 the connected wallet\\u2019s \\u2014 and nothing about who holds the rest, so a token sitting entirely in one address and a token spread over thousands look identical here. A newly deployed token is normally the former, and a ratio in a pool is then a price its one holder chose rather than one a market found.' }));\n"
    "      if (chainId === 8453) {\n"
    "        body.appendChild(h('p', { class: 'smallnote' },\n"
    "          h('a', { target: '_blank', rel: 'noopener', href: 'https://basescan.org/token/' + token + '#balances', text: 'who holds it, on basescan' })));\n"
    "      }\n",
    'the distribution this card cannot see is stated to every reader, with the holders list beside it',
)

# ══════════════════════════════════════════════════════════════════════════
# 4. The pools card only signs against the chain it names on its buttons
# ══════════════════════════════════════════════════════════════════════════

t.once(
    "        var np = d.namedPools;\n",
    "        // Every button below says \\u201con Base\\u201d and every check below\n"
    "        // compares against OC_CHAIN, but the factory address comes from a\n"
    "        // host that can be configured for any EVM chain. Pointing a Base\n"
    "        // wallet at another chain's factory address does not fail loudly:\n"
    "        // the same deployer at the same nonce lands on the same address\n"
    "        // everywhere, so it either reaches nothing \\u2014 and a data-carrying\n"
    "        // call to a codeless address returns status 0x1, which this card\n"
    "        // would report as a trade \\u2014 or it reaches somebody else's\n"
    "        // contract with a real approval already standing in front of it.\n"
    "        // So this card refuses rather than quietly translating itself.\n"
    "        if (Number(d.chainId) !== 8453) {\n"
    "          ocBody.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text: 'This host serves chain ' + d.chainId + ', and everything in this card is written for Base (8453): the addresses, the checks and every signature. The factory address would be read and approved on the wrong chain, where it can hold nothing at all or hold a different contract entirely, so nothing is drawn here rather than drawn wrong. The sandbox pools below are unaffected \\u2014 they never leave this log.' }));\n"
    "          return;\n"
    "        }\n"
    "        var np = d.namedPools;\n",
    'the pools card will not sign against Base for a host that serves another chain',
)

# ══════════════════════════════════════════════════════════════════════════
# 5. Reserves re-read after the last approval and before the calldata
# ══════════════════════════════════════════════════════════════════════════

t.once(
    "      async function ocTaken(factory, who, hexName) {\n"
    "        return ocUint(await ocEth('eth_call', [{ to: factory, data: OC_SEL.taken + ocAddr(who) + hexName }, 'latest']), 'the name claim') !== 0n;\n"
    "      }\n",
    "      async function ocTaken(factory, who, hexName) {\n"
    "        return ocUint(await ocEth('eth_call', [{ to: factory, data: OC_SEL.taken + ocAddr(who) + hexName }, 'latest']), 'the name claim') !== 0n;\n"
    "      }\n"
    "\n"
    "      // The reserves every quote and every guard on a pool row is computed\n"
    "      // from are frozen into that row's closure when it is drawn, and\n"
    "      // between the press and the signature sit up to two approvals, each\n"
    "      // polled for as long as four minutes. This screen's own repaint is\n"
    "      // suppressed the whole time \\u2014 safeToRepaint() returns false while\n"
    "      // any non-persistent mini-form is in the document, and this view\n"
    "      // always has several \\u2014 so ocLoad() does not re-run and those\n"
    "      // integers can be hours old, not the half-minute the old comment\n"
    "      // claimed. A minOut that is 98% of a stale quote is not a loose\n"
    "      // guard: if the pool moved the user's WAY it sits far below the fair\n"
    "      // output, the user is never shown the better number, and a\n"
    "      // sandwicher can push the fill down to it and keep the rest \\u2014 with\n"
    "      // the 2% band holding perfectly the whole time.\n"
    "      //\n"
    "      // So the pool is asked again, from the factory itself, after the last\n"
    "      // approval has confirmed. Five static words: name, resPeer, resBtc,\n"
    "      // totalShares, creator \\u2014 the same decode the id lookup does. It is\n"
    "      // a free read and it signs nothing.\n"
    "      async function ocFresh(factory, id) {\n"
    "        var ret = await ocEth('eth_call', [{ to: factory, data: OC_SEL.poolInfo + ocWord(id) }, 'latest']);\n"
    "        var body = String(ret == null ? '' : ret).replace(/^0x/, '');\n"
    "        if (body.length < 64 * 5) throw new Error('the pool would not read back before signing, so the guard could not be set against a live price \\u2014 nothing was signed');\n"
    "        return {\n"
    "          rp: BigInt('0x' + body.slice(64, 128)),\n"
    "          rb: BigInt('0x' + body.slice(128, 192)),\n"
    "          ts: BigInt('0x' + body.slice(192, 256))\n"
    "        };\n"
    "      }\n"
    "      // Did the number on screen survive the wait? Inside the 2% band is\n"
    "      // what the reader agreed to; outside it is a different trade, and\n"
    "      // they get to look at it before pressing again. BOTH directions: a\n"
    "      // move in their favour is exactly the one a stale minimum gives away.\n"
    "      function ocDrift(shown, now) {\n"
    "        if (shown <= 0n) return false;\n"
    "        if (now <= 0n) return true;\n"
    "        return now < shown * 98n / 100n || now > shown * 102n / 100n;\n"
    "      }\n"
    "      // The guard actually sent: 2% under what the pool pays NOW, but never\n"
    "      // under what the line on screen promised. Those are two different\n"
    "      // protections and the trade needs both \\u2014 the first against a pool\n"
    "      // that moved since the quote, the second against this page quietly\n"
    "      // lowering a minimum somebody read.\n"
    "      function ocFloor(shown, now) {\n"
    "        var a = ocGuard(now), b = ocGuard(shown);\n"
    "        return a > b ? a : b;\n"
    "      }\n",
    'a live re-read of a pool, and the two guards it feeds',
)

# ── the swap ──────────────────────────────────────────────────────────────
t.once(
    "          box.appendChild(h('div', { class: 'mini-form' }, sellSel, amtIn,\n"
    "            h('button', { class: 'btn small primary', text: 'Swap on Base', onclick: function () {\n"
    "              var q = quoteNow();\n"
    "              if (!q) { toast('Say how much.'); return; }\n"
    "              if (q.out <= 0n) { toast('The pool cannot fill this.'); return; }\n"
    "              var led = ocLedger();\n",
    # A second press while MetaMask shows the APPROVAL prompt used to start a
    # second, independent sequence: two ocLedgers, both reading the allowance
    # before either approve had mined, both broadcasting one. approve()
    # OVERWRITES rather than adds, so whether the user trades once or twice
    # comes down to mining order — and the card's own copy already warns that
    # "pressing again can pay for the same thing twice".
    "          var swapBusy = false;\n"
    "          var swapBtn = h('button', { class: 'btn small primary', text: 'Swap on Base', onclick: function () {\n"
    "              var q = quoteNow();\n"
    "              if (!q) { toast('Say how much.'); return; }\n"
    "              if (q.out <= 0n) { toast('The pool cannot fill this.'); return; }\n"
    "              if (swapBusy) { toast('That swap is already going through \\u2014 the wallet may be asking for an approval before the trade itself. Pressing again would start a second one, and an approval that lands after the first swap lets the second one through too.'); return; }\n"
    "              var led = ocLedger();\n"
    "              swapBusy = true;\n"
    "              swapBtn.disabled = true;\n"
    "              swapBtn.textContent = 'Working\\u2026';\n",
    'the swap button cannot start a second signing sequence',
)
t.once(
    "                  // minOut says nothing about WHEN. These reserves may be up\n"
    "                  // to thirty seconds old, which can only make the trade\n"
    "                  // revert, never fill worse than the line above promised.\n",
    "                  // minOut says nothing about WHEN. And it is only worth\n"
    "                  // what it is measured against, so the pool is asked again\n"
    "                  // HERE \\u2014 after the approval above has confirmed, not\n"
    "                  // before it \\u2014 and the minimum is set from what it pays\n"
    "                  // now, floored at what the quote line promised.\n",
    'the swap comment stops claiming a stale guard can only revert',
)
t.once(
    "                  var data = OC_SEL.swap + ocWord(p.id) + ocWord(q.sellPeer ? 1n : 0n) + ocWord(q.vin) + ocWord(q.min) + ocWord(await ocDeadline());\n",
    "                  var fr = await ocFresh(factory, p.id);\n"
    "                  var nowOut = ocQuote(q.vin, q.sellPeer ? fr.rp : fr.rb, q.sellPeer ? fr.rb : fr.rp);\n"
    "                  if (ocDrift(q.out, nowOut)) {\n"
    "                    ocRefresh();\n"
    "                    throw new Error('the pool moved while this was waiting \\u2014 ' + ocFmt(q.out, q.dec) + ' ' + q.sym + ' was quoted and it would fill ' + ocFmt(nowOut, q.dec) + ' ' + q.sym + ' now. Nothing was signed against the old number; press Swap again to trade at a price you can see.');\n"
    "                  }\n"
    "                  var data = OC_SEL.swap + ocWord(p.id) + ocWord(q.sellPeer ? 1n : 0n) + ocWord(q.vin) + ocWord(ocFloor(q.out, nowOut)) + ocWord(await ocDeadline());\n",
    'the swap minimum is computed from reserves read after the approval, never from the render',
)
t.once(
    "                } catch (e) { toast(led.sentence('The swap stopped', e)); }\n"
    "              })();\n"
    "            } }), quote));\n",
    "                } catch (e) { toast(led.sentence('The swap stopped', e)); }\n"
    "                finally {\n"
    "                  swapBusy = false;\n"
    "                  swapBtn.disabled = false;\n"
    "                  swapBtn.textContent = 'Swap on Base';\n"
    "                }\n"
    "              })();\n"
    "            } });\n"
    "          box.appendChild(h('div', { class: 'mini-form' }, sellSel, amtIn, swapBtn, quote));\n",
    'the swap lock is released however the sequence ends',
)

# ── adding liquidity ──────────────────────────────────────────────────────
t.once(
    "          box.appendChild(h('div', { class: 'mini-form' }, addP, addB,\n"
    "            h('button', { class: 'btn small', text: 'Add liquidity', onclick: function () {\n"
    "              var vp = ocUnits(addP.value, pdec), vb = ocUnits(addB.value, bdec);\n"
    "              if (vp === null || vb === null) { toast('Both amounts, please.'); return; }\n",
    "          var addBusy = false;\n"
    "          var addBtn = h('button', { class: 'btn small', text: 'Add liquidity', onclick: function () {\n"
    "              var vp = ocUnits(addP.value, pdec), vb = ocUnits(addB.value, bdec);\n"
    "              if (vp === null || vb === null) { toast('Both amounts, please.'); return; }\n"
    "              if (addBusy) { toast('That deposit is already going through \\u2014 it takes up to two approvals and the wallet asks for each in turn. Pressing again would start a second deposit.'); return; }\n",
    'the add-liquidity button cannot start a second signing sequence',
)
t.once(
    "              var led = ocLedger();\n"
    "              (async function () {\n"
    "                try {\n"
    "                  if (!l2Wallet && !(await ocConnect())) { toast('Adding liquidity needs a wallet on Base.'); return; }\n",
    "              var led = ocLedger();\n"
    "              addBusy = true;\n"
    "              addBtn.disabled = true;\n"
    "              addBtn.textContent = 'Working\\u2026';\n"
    "              (async function () {\n"
    "                try {\n"
    "                  if (!l2Wallet && !(await ocConnect())) { toast('Adding liquidity needs a wallet on Base.'); return; }\n",
    'the add-liquidity lock is taken before the first await',
)
t.once(
    "                  await ocSend(factory, OC_SEL.addLiquidity + ocWord(p.id) + ocWord(vp) + ocWord(vb) + ocWord(ocGuard(expect)) + ocWord(await ocDeadline()), 'Adding liquidity to ' + label, led, 'the deposit into ' + label);\n",
    # `expect` came from render-time reserves and TWO approvals have been
    # waited on since, each polled for up to four minutes.
    "                  var fr = await ocFresh(factory, p.id);\n"
    "                  var nowExp = 0n;\n"
    "                  if (fr.ts > 0n && fr.rp > 0n && fr.rb > 0n) {\n"
    "                    var nP = vp * fr.ts / fr.rp, nB = vb * fr.ts / fr.rb;\n"
    "                    nowExp = nP < nB ? nP : nB;\n"
    "                    if (nowExp <= 0n) {\n"
    "                      ocRefresh();\n"
    "                      throw new Error('that deposit is too small to mint a share in ' + label + ' at the ratio the pool holds NOW, so the contract would refuse it \\u2014 nothing was signed');\n"
    "                    }\n"
    "                  }\n"
    "                  if (ocDrift(expect, nowExp)) {\n"
    "                    ocRefresh();\n"
    "                    throw new Error('the pool moved while this was waiting: this deposit was going to mint ' + expect + ' raw share units and it would mint ' + nowExp + ' now. Nothing was signed \\u2014 press Add liquidity again against the ratio it holds now.');\n"
    "                  }\n"
    "                  await ocSend(factory, OC_SEL.addLiquidity + ocWord(p.id) + ocWord(vp) + ocWord(vb) + ocWord(ocFloor(expect, nowExp)) + ocWord(await ocDeadline()), 'Adding liquidity to ' + label, led, 'the deposit into ' + label);\n",
    'the minimum-shares guard is computed from reserves read after both approvals',
)
t.once(
    "                } catch (e) { toast(led.sentence('The deposit stopped', e)); }\n"
    "              })();\n"
    "            } }), slot));\n",
    "                } catch (e) { toast(led.sentence('The deposit stopped', e)); }\n"
    "                finally {\n"
    "                  addBusy = false;\n"
    "                  addBtn.disabled = false;\n"
    "                  addBtn.textContent = 'Add liquidity';\n"
    "                }\n"
    "              })();\n"
    "            } });\n"
    "          box.appendChild(h('div', { class: 'mini-form' }, addP, addB, addBtn, slot));\n",
    'the add-liquidity lock is released however the sequence ends',
)

# ── withdrawing ───────────────────────────────────────────────────────────
t.once(
    "                slot.appendChild(h('button', { class: 'btn small', text: 'Withdraw all', onclick: function () {\n",
    "                var wdBusy = false;\n"
    "                var wdBtn = h('button', { class: 'btn small', text: 'Withdraw all', onclick: function () {\n"
    "                  if (wdBusy) { toast('That withdrawal is already going through. Pressing again would sign a second one.'); return; }\n",
    'the withdraw button cannot start a second signing sequence',
)
t.once(
    "                  // other. Both minimums are 2% under what these reserves\n"
    "                  // say the slice is, floored so a tiny side still gets a\n"
    "                  // minimum. The reserves may be half a minute old, which can\n"
    "                  // only cause a revert, never a worse payout than shown.\n",
    "                  // other. Both minimums are 2% under what the pool holds\n"
    "                  // WHEN THIS IS SIGNED \\u2014 read again below rather than\n"
    "                  // taken from the render, which on a screen that has stopped\n"
    "                  // repainting can be hours behind \\u2014 and floored at the\n"
    "                  // slice printed above, so neither a stale number nor a live\n"
    "                  // one can lower what was promised.\n",
    'the withdraw comment stops claiming render-time reserves are half a minute old',
)
t.once(
    "                  var led = ocLedger();\n"
    "                  (async function () {\n"
    "                    try {\n"
    "                      await ocSend(factory, OC_SEL.removeLiquidity + ocWord(p.id) + ocWord(sh) + ocWord(ocGuard(expP)) + ocWord(ocGuard(expB)), 'Withdrawing from ' + label, led, 'the withdrawal of your whole share of ' + label);\n",
    "                  var led = ocLedger();\n"
    "                  wdBusy = true;\n"
    "                  wdBtn.disabled = true;\n"
    "                  wdBtn.textContent = 'Working\\u2026';\n"
    "                  (async function () {\n"
    "                    try {\n"
    "                      var fr = await ocFresh(factory, p.id);\n"
    "                      var nowP = fr.ts > 0n ? sh * fr.rp / fr.ts : 0n;\n"
    "                      var nowB = fr.ts > 0n ? sh * fr.rb / fr.ts : 0n;\n"
    "                      if (ocDrift(expP, nowP) || ocDrift(expB, nowB)) {\n"
    "                        ocRefresh();\n"
    "                        throw new Error('the pool moved while this row sat open: your slice reads ' + ocFmt(nowP, pdec) + ' PEER and ' + ocFmt(nowB, bdec) + ' BTC now, not ' + ocFmt(expP, pdec) + ' and ' + ocFmt(expB, bdec) + '. Nothing was signed \\u2014 press Withdraw all again against what it holds now.');\n"
    "                      }\n"
    "                      await ocSend(factory, OC_SEL.removeLiquidity + ocWord(p.id) + ocWord(sh) + ocWord(ocFloor(expP, nowP)) + ocWord(ocFloor(expB, nowB)), 'Withdrawing from ' + label, led, 'the withdrawal of your whole share of ' + label);\n",
    'both withdrawal minimums are computed from reserves read at signing time',
)
t.once(
    "                    } catch (e) { toast(led.sentence('The withdrawal stopped', e)); }\n"
    "                  })();\n"
    "                } }));\n",
    "                    } catch (e) { toast(led.sentence('The withdrawal stopped', e)); }\n"
    "                    finally {\n"
    "                      wdBusy = false;\n"
    "                      wdBtn.disabled = false;\n"
    "                      wdBtn.textContent = 'Withdraw all';\n"
    "                    }\n"
    "                  })();\n"
    "                } });\n"
    "                slot.appendChild(wdBtn);\n",
    'the withdraw lock is released however the sequence ends',
)

# ── the price a row prints is one holder's ratio, not a market ────────────
t.once(
    "            kv.appendChild(h('b', { class: 'num', text: '1 PEER = ' + (px >= 0.001 ? Math.round(px * 1e8) / 1e8 : px.toExponential(3)) + ' BTC' }));\n"
    "          }\n"
    "          box.appendChild(kv);\n",
    "            kv.appendChild(h('b', { class: 'num', text: '1 PEER = ' + (px >= 0.001 ? Math.round(px * 1e8) / 1e8 : px.toExponential(3)) + ' BTC' }));\n"
    "          }\n"
    "          box.appendChild(kv);\n"
    "          // Beside every price, because a price is the thing people read\n"
    "          // meaning into. A pool's ratio is whatever its opener put in,\n"
    "          // moved by whoever has traded since \\u2014 and neither this card nor\n"
    "          // the token card above can see how the PEER supply is held, so\n"
    "          // nothing here establishes that anybody but one holder has ever\n"
    "          // agreed to this number.\n"
    "          if (rp > 0n && rb > 0n) box.appendChild(h('p', { class: 'smallnote', text: 'That price is this pool\\u2019s own ratio and nothing more: what its opener deposited, moved by whoever has traded since. It is not a market price, and this page cannot show how the PEER supply is held \\u2014 a ratio one holder chose is a number, not a valuation.' }));\n",
    'a pool row says what its price is and is not',
)
t.once(
    "in whichever direction pays the trader.';\n",
    "in whichever direction pays the trader. Nor can this page show how the PEER supply is held, so nothing outside this form agrees with the number you are about to set.';\n",
    'the opening-price line says the supply concentration is unknown to it',
)

# ══════════════════════════════════════════════════════════════════════════
# 6. The open-pool sequence holds its own fields still while it signs
# ══════════════════════════════════════════════════════════════════════════

t.once(
    "          return h('button', { class: 'btn small', text: 'max ' + sym, onclick: function () {\n"
    "            (async function () {\n",
    "          return h('button', { class: 'btn small', text: 'max ' + sym, onclick: function () {\n"
    "            // Not during the open-pool sequence. This rewrites the amount\n"
    "            // field and the price line under it, while the amounts being\n"
    "            // signed were captured when Open pool was pressed \\u2014 so the\n"
    "            // \\u201cYou are setting the price\\u201d sentence on screen would\n"
    "            // drift away from the transaction in the wallet, which is the\n"
    "            // one thing this form exists to prevent.\n"
    "            if (cBusy) { toast('The pool is being opened with the amounts already captured \\u2014 the fields are held still until that finishes.'); return; }\n"
    "            (async function () {\n",
    'the max buttons refuse to move the price line mid-signature',
)
t.once(
    "        ocBody.appendChild(h('div', { class: 'mini-form persistent' }, cName, cPeer, cMax(cPeer, 'PEER'), cBtc, cMax(cBtc, 'cbBTC')));\n",
    "        var cMaxP = cMax(cPeer, 'PEER'), cMaxB = cMax(cBtc, 'cbBTC');\n"
    "        ocBody.appendChild(h('div', { class: 'mini-form persistent' }, cName, cPeer, cMaxP, cBtc, cMaxB));\n",
    'the max buttons are held rather than created anonymously',
)
t.once(
    "          var led = ocLedger();\n"
    "          cBusy = true;\n"
    "          cBtn.disabled = true;\n"
    "          cBtn.textContent = 'Working\\u2026';\n",
    "          var led = ocLedger();\n"
    "          cBusy = true;\n"
    "          cBtn.disabled = true;\n"
    "          cBtn.textContent = 'Working\\u2026';\n"
    "          // Everything the price line is computed from goes still with it.\n"
    "          // vp and vb are captured above and the wallet is about to be\n"
    "          // asked about exactly those two numbers; a field that can still\n"
    "          // be typed into leaves a sentence on screen describing a trade\n"
    "          // nobody is making.\n"
    "          cName.disabled = true;\n"
    "          cPeer.disabled = true;\n"
    "          cBtc.disabled = true;\n"
    "          cMaxP.disabled = true;\n"
    "          cMaxB.disabled = true;\n",
    'the open-pool inputs are held still for the duration of the sequence',
)
t.once(
    "            } finally {\n"
    "              cBusy = false;\n"
    "              cBtn.disabled = false;\n"
    "              cBtn.textContent = 'Open pool on Base';\n"
    "            }\n",
    "            } finally {\n"
    "              cBusy = false;\n"
    "              cBtn.disabled = false;\n"
    "              cBtn.textContent = 'Open pool on Base';\n"
    "              cName.disabled = false;\n"
    "              cPeer.disabled = false;\n"
    "              cBtc.disabled = false;\n"
    "              cMaxP.disabled = false;\n"
    "              cMaxB.disabled = false;\n"
    "            }\n",
    'the open-pool inputs come back however the sequence ends',
)

t.write()
r.write()
