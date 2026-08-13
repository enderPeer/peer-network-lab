# The pools card becomes THE pool card.
#
# The operator asked for one official pool: one address, no names, anybody may
# add liquidity, every add makes it bigger, and it may be seeded arbitrarily
# small. PeerPool.sol is that contract. This patch takes the consequences out
# of the interface rather than leaving them lying around switched off, because
# defensive code that is no longer defending anything still reads as a defence
# that is running.
#
# WHAT GOES, AND WHY IT WAS THERE
#   the name field, the “a name confers no trust” warnings, the shared-name
#   marker, the per-creator claim check (taken()) — names were front-runnable
#   on a public mempool, so PeerPools claimed them per creator, which made a
#   name identify nothing and forced every screen to say so. There is no name
#   now, so there is nothing to squat and nothing to disclaim.
#
#   the ranked list, the scan report, the “showing N of M” counters, the
#   find-a-pool-by-id door — discovery over a growing array was censorable by
#   opening 256 dust pools, so it became a chunked resumable log scan with a
#   depth-ranked pre-filter and a manual door for whatever the scan missed. One
#   address has no discovery problem: you either have it or you do not.
#
#   the creator row, the pool id in every sentence — the id was the identity
#   because a name could not be. The address is the identity now.
#
# WHAT REPLACES IT
#   the pool's two reserves and the price they imply, both ways round; how far
#   that pool is from the depth the PEER-burn door requires, in satoshis; your
#   own share of it; an ADD form, a REMOVE form and a SWAP form. And when the
#   pool has never been funded — three zeros, which is a real state and not an
#   error — the FIRST ADD, which is the deposit that sets the opening price and
#   says so in the strongest terms this file has, with the implied rate printed
#   both ways as the amounts are typed.
#
# WHAT IS KEPT BECAUSE IT IS STILL TRUE
#   a thin pool moves a long way on one trade; the two first amounts ARE the
#   price; the PEER-burn door needs 1,000,000 satoshis of depth and this pool
#   is some distance from it; every write is hand-encoded here and signed by
#   the user's own wallet; the host only ever reads.
#
# THE HOST INTERFACE THIS CARD READS, written down because it is a contract
# between this file and chain-l2/onchain.mjs, and because a page that guesses
# is the failure this whole card exists to prevent. GET /api/token/onchain:
#
#   d.pool absent, d.namedPools present   this host is OLDER than this page: it
#                                         still reads the superseded factory
#   d.pool = { configured: false, why }   PEER_POOL_ADDR unset — OFF, in words
#   d.pool = { address, error }           set, and it did not read
#   d.pool = { address, resPeerRaw, resBtcRaw, totalSharesRaw, seeded,
#              decimals: { peer, btc } }
#
# resPeerRaw / resBtcRaw / totalSharesRaw are decimal strings of the three
# static words reserves() returns, in the order PeerPool.sol's own comment
# fixes. totalSharesRaw === '0' means UNSEEDED, which is the state the FIRST
# ADD panel exists for. Those four states are four different sentences and
# this card never blurs them into one.
#
# Run:  python tools/patch-one-pool.py && node social/assemble.mjs
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


def span(start, end, new, label):
    """Replace everything from `start` to the end of `end`, inclusive.

    Used where the region being replaced is hundreds of lines long and
    transcribing all of it as an anchor would be its own source of error. Both
    markers must be unique in the file, `end` must come after `start`, and the
    length of what was cut is printed so a runaway match is visible rather than
    silent."""
    global s
    assert s.count(start) == 1, 'span start %r matched %d times' % (label, s.count(start))
    assert s.count(end) == 1, 'span end %r matched %d times' % (label, s.count(end))
    i = s.index(start)
    j = s.index(end)
    assert j > i, 'span %r: the end marker comes before the start' % label
    cut = (j + len(end)) - i
    s = s[:i] + new + s[j + len(end):]
    print('  patched: ' + label + ' (cut %d chars, wrote %d)' % (cut, len(new)))


# ══ 1. TERMS ══════════════════════════════════════════════════════════════
# The glossary described the design that has been withdrawn. Both file rules
# hold for every entry below: the one-liner is answerable without knowing
# another term, and `sect` names a section that exists in guideTab.

once(
    r"""      more: 'The ratio between what it holds is the price, and a trade moves it. This app has its own pools; the same pair can also have a pool on Uniswap, which is a different contract with different coins in it. Nothing here routes a trade to Uniswap or reads a price from it.',""",
    r"""      more: 'The ratio between what it holds is the price, and a trade moves it. This app has exactly one pool of its own, at one address; the same pair can also have a pool on Uniswap, which is a different contract with different coins in it. Nothing here routes a trade to Uniswap or reads a price from it.',""",
    'TERMS: pool is singular here',
)

once(
    r"""    officialPool: {
      t: 'the official pool',
      one: 'The one named PEER/cbBTC pool a host prices a PEER burn against, picked by its number.',
      more: 'Anyone can open a pool in the same contract and call it anything, so a name is not an identity — the number is. A burn records which pool it was priced against and what that pool held, so a reader recomputes the price instead of taking the host’s word for it. Nothing is re-read afterwards: replay does arithmetic on the numbers the burn recorded and asks no chain anything, which is why a published epoch still reproduces years later.',
      sect: 'The coin on Base: pools, prices and explorers',
    },""",
    r"""    officialPool: {
      t: 'the official pool',
      one: 'The single PEER/cbBTC pool this network has — one contract at one address, and the one a PEER burn is priced against.',
      more: 'There is no second one and no way to make one inside it: no name, no id, no factory holding a list. So “which pool” is answered by an address rather than by a label anyone could copy, and there is nothing to squat, nothing to enumerate and nothing to choose. Anyone may add liquidity to it, and every add makes it bigger. A burn records the address it was priced against and what that pool held, so a reader recomputes the price instead of taking the host’s word for it. Nothing is re-read afterwards: replay does arithmetic on the numbers the burn recorded and asks no chain anything, which is why a published epoch still reproduces years later.',
      sect: 'The coin on Base: pools, prices and explorers',
    },
    poolShare: {
      t: 'a share of the pool',
      one: 'What adding liquidity gives you back: a claim on a fraction of both sides of the pool.',
      more: 'Shares are accounting inside the pool contract, not a token — they cannot be sent, so there is nothing to approve and nothing to phish. Adding mints them in proportion to what went in; removing burns them and pays out that fraction of BOTH reserves as they stand at that moment, which is not what you deposited if the price moved while you were in. The first 1000 raw units ever minted are locked at an address nobody can sign from, so the pool can thin but never close and can never be re-opened at a new invented price.',
      sect: 'The coin on Base: pools, prices and explorers',
    },""",
    'TERMS: officialPool rewritten, poolShare added',
)


# ══ 2. The guide ══════════════════════════════════════════════════════════
once(
    r"""This app has its own — named pools in its own contract, which is what every button in Pools calls.""",
    r"""This app has one of its own — a single pool contract at a single address, which is what every button in Pools calls.""",
    'the guide: one pool, not named pools',
)


# ══ 3. The contracts card ═════════════════════════════════════════════════
once(
    r"""        kRow('the pools factory — this app’s own pools', oc.namedPools && oc.namedPools.factory, 'address',
          'PEER_POOLS_ADDR is unset on this host, so this app has no pools of its own here.');""",
    r"""        kRow('the pool — this app’s own PEER/cbBTC market', oc.pool && oc.pool.address, 'address',
          (oc.pool && oc.pool.why) || 'PEER_POOL_ADDR is unset on this host, so this app has no pool of its own here.');""",
    'contracts card: the pool, not the factory',
)


# ══ 4. dexCard ════════════════════════════════════════════════════════════
# The card that keeps two markets over one pair from being read as one. Its
# subject is unchanged; what changed is that this side of the comparison is now
# a single contract, and that the outside-pair paragraph has nothing left to
# describe — `pool` in the host's answer means THIS app's pool now, which the
# card above already draws in full.
once(
    r"""      'The card above is this app’s own pools: named pools inside one contract, opened by whoever wanted one, trading PEER against cbBTC. Every button on it calls that contract and nothing else.'));""",
    r"""      'The card above is this app’s own pool: one contract at one address, trading PEER against cbBTC, which anyone may add liquidity to. Every button on it calls that contract and nothing else.'));""",
    'dexCard: one pool above',
)

once(
    r"""      if (!d.namedPools) {
        out.appendChild(h('p', { class: 'smallnote', text: 'This host has no pools factory configured, so this app has no pools of its own — the card above says so. A Uniswap pool for the same pair would be a separate thing that needs nothing from this host.' }));
      }""",
    r"""      if (!d.pool || d.pool.configured === false || !d.pool.address) {
        out.appendChild(h('p', { class: 'smallnote', text: 'This host has no pool address configured, so this app has no pool of its own — the card above says so. A Uniswap pool for the same pair would be a separate thing that needs nothing from this host.' }));
      }""",
    'dexCard: the missing-pool sentence',
)

once(
    r"""      // PEER_POOL_ADDR: an outside pair this host was pointed at. It is read
      // and reported, and it is still not this app's pool — naming it without
      // that sentence would be the exact blur this card exists to prevent.
      var pool = d.pool ? (typeof d.pool === 'string' ? d.pool : d.pool.address) : null;
      if (pool) {
        var pl = l2ScanLink(chainId, 'address', pool, 'on basescan');
        out.appendChild(h('p', { class: 'smallnote' },
          'This host is also pointed at an outside pair at ',
          h('span', { class: 'num', style: 'word-break:break-all', text: String(pool) }), ' ', pl,
          ' — a UniswapV2-style contract it reads and never trades. No button here touches it, and this page cannot say which exchange it belongs to; the explorer can.'));
        if (d.pool && d.pool.error) out.appendChild(h('p', { class: 'smallnote', text: d.pool.error }));
      }""",
    r"""      // This app's pool, named again HERE rather than only in the card above,
      // because this is the card about telling two markets apart and an
      // address is the only thing that tells them apart. The reserves are not
      // repeated: they are drawn in full one card up, and a second copy would
      // be a second number to keep true.
      var pool = d.pool && typeof d.pool === 'object' ? d.pool.address : null;
      if (pool) {
        var pl = l2ScanLink(chainId, 'address', pool, 'on basescan');
        out.appendChild(h('p', { class: 'smallnote' },
          'This app’s pool is the contract at ',
          h('span', { class: 'num', style: 'word-break:break-all', text: String(pool) }), ' ', pl,
          ' — that address IS which pool this app means, and it is the only one every button above sends to. A pool anywhere else over the same two tokens is a different contract holding different coins, whatever it is called.'));
        if (d.pool.error) out.appendChild(h('p', { class: 'smallnote', text: d.pool.error }));
      }""",
    'dexCard: the address is the identity',
)


# ══ 5. The PEER-burn door ═════════════════════════════════════════════════
# Three of its four “why there is no price” sentences were about the factory,
# the list and choosing an official pool out of it. One address answers all
# three, so what is left is the honest pair: no pool configured, or a pool that
# nobody has funded yet.
once(
    r"""      } else if (!o.namedPools) {
        lines.push('The PEER token is deployed at ' + String(o.token) + ', but no pools factory is: PEER_POOLS_ADDR is unset on this host, so there is no contract holding a PEER/cbBTC pool, no official pool to name, and therefore no price to read. That is the operator’s move and not yours — chain-l2/DEPLOY.md is the runbook for it.');
      } else if (o.namedPools.error) {
        lines.push('The pools factory this host names did not read: ' + String(o.namedPools.error));
      } else if (!(o.namedPools.pools && o.namedPools.pools.length)) {
        lines.push('A pools factory is configured and it holds no pool yet, so there are no reserves anywhere to price a burn against.');
      } else {
        lines.push('Pools exist on this host, but it names no official one to price a burn against — and a page that picked one for itself would be choosing whose price counts, which is precisely what this door must never do.');
      }""",
    r"""      } else if (!o.pool || o.pool.configured === false || !o.pool.address) {
        lines.push('The PEER token is deployed at ' + String(o.token) + ', but no pool is: PEER_POOL_ADDR is unset on this host, so there is no contract holding PEER against cbBTC, and therefore no reserves and no price to read. That is the operator’s move and not yours — chain-l2/DEPLOY.md is the runbook for it.');
      } else if (o.pool.error) {
        lines.push('The pool this host names did not read: ' + String(o.pool.error));
      } else if (String(o.pool.totalSharesRaw || '0') === '0') {
        lines.push('The pool contract exists at ' + String(o.pool.address) + ' and nobody has funded it yet — three zeros where its reserves go. An empty pool has no ratio, so there is nothing to price a burn against until somebody makes the first deposit, and that deposit is what sets the opening price.');
      } else {
        lines.push('The pool exists and holds coins, and this host still published no quote. That is the host’s own reading to explain, not this page’s to guess at: the door stays shut rather than pricing a burn against a number nobody stood behind.');
      }""",
    'peerBurn: the two honest reasons there is no price',
)

once(
    r"""      if (pool && pool.poolId != null) {
        stateBox.appendChild(h('div', { class: 'kv' },
          h('span', {}, term('officialPool', 'the official pool')), h('b', { class: 'num', text: 'id ' + String(pool.poolId) }),
          h('span', { text: 'in the factory' }), h('b', { class: 'num', text: l2ShortHex(String(pool.factory || '—')) }),
          h('span', { text: 'opened by' }), h('b', { class: 'num', text: l2ShortHex(String(pool.creator || '—')) })));
        if (pool.nameNote) stateBox.appendChild(h('p', { class: 'smallnote', text: String(pool.nameNote) }));
      } else {
        stateBox.appendChild(h('p', { class: 'smallnote', text: 'This host did not say WHICH pool it prices against, and two reserve numbers with no pool behind them are not an auditable price — anyone may open a pool and give it any name. Nothing is quoted until it says.' }));
        return;
      }""",
    r"""      // Which pool priced this, in the only terms that identify one: the
      // address. There is no id to print beside it and no creator to weigh,
      // because there is no second pool for either to distinguish it from —
      // but the address is still printed rather than assumed, because a host
      // that will not say what it priced against has not published a price.
      var poolAddr = pool && /^0x[0-9a-fA-F]{40}$/.test(String(pool.address)) ? String(pool.address) : '';
      if (poolAddr) {
        var pRow = h('p', { class: 'smallnote' },
          term('officialPool', 'the official pool'), ' · ',
          h('span', { class: 'num', style: 'word-break:break-all', text: poolAddr }), ' ');
        var pSc = l2ScanLink(8453, 'address', poolAddr, 'on basescan');
        if (pSc) pRow.appendChild(pSc);
        stateBox.appendChild(pRow);
      } else {
        stateBox.appendChild(h('p', { class: 'smallnote', text: 'This host did not say WHICH pool it prices against, and two reserve numbers with no address behind them are not an auditable price — nothing here can be recomputed by a reader who cannot find the contract. Nothing is quoted until it says.' }));
        return;
      }""",
    'peerBurn: the pool is named by its address',
)


# ══ 6. The card itself ════════════════════════════════════════════════════

once(
    r"""    if (econView === 'pools') {
      // ── pools on Base — the ones that are real ──
      // This card sits above the sandbox because it is the one that costs
      // and pays actual money: the PEER ERC-20 against cbBTC — bitcoin held
      // in Coinbase custody and issued as a token on Base. The pools below
      // it settle inside this log and nowhere else; a swap here moves value
      // that exists whether or not this page does.""",
    r"""    if (econView === 'pools') {
      // ── THE pool on Base — one address, and the only one ──
      // This card sits above the sandbox because it is the one that costs
      // and pays actual money: the PEER ERC-20 against cbBTC — bitcoin held
      // in Coinbase custody and issued as a token on Base. The pools below
      // it settle inside this log and nowhere else; a swap here moves value
      // that exists whether or not this page does.
      //
      // There is ONE pool and there is no way to make a second inside it: no
      // name, no id, no factory holding a list. Everything this card used to
      // spend on telling pools apart — ranking them by depth so dust could not
      // bury a real one, naming every creator, marking a name two people were
      // using, keeping a door open for a pool the scan never reached — was
      // machinery for a question that no longer has two answers. It is gone
      // rather than left switched off, because a defence still drawn on screen
      // reads as a defence still running.""",
    'the card: one pool, and what left with the list',
)

span(
    r"""        h('h2', { text: 'Pools """,
    r"""everything in this card is actual money.' }));""",
    r"""        h('h2', { text: 'The pool — PEER / cbBTC on Base' }),
        h('p', { class: 'smallnote', text: 'One pool, at one address, and there is no second one: nothing to name, nothing to choose between, nothing to search. It settles on the real chain — the PEER token against cbBTC, bitcoin custodied by Coinbase and issued as an ERC-20 on Base. Anyone may add liquidity to it, and every add makes it bigger. The sandbox pools below settle only in this log; everything in this card is actual money.' }));""",
    'the card: heading and standfirst',
)

# ── the selectors ─────────────────────────────────────────────────────────
once(
    r"""      // Hardcoded 4-byte selectors, each with the signature it hashes from —
      // the same policy as chain-l2/onchain.mjs: no keccak library in the
      // page. The pool ones match PeerPools.build.json's methodIdentifiers;
      // recompute any of them with `cast sig '<signature>'` if you do not
      // want to take them on trust, which you should not.
      //
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
        // The two READ selectors this card grew. poolInfo is how a pool the
        // host's scan never reached can still be opened here by its id — the
        // reader's own note promises exactly that, and a promise with no door
        // is worse than no promise. balanceOf is how a wallet that cannot
        // cover a trade finds out before it signs an approval for one. Both
        // are copied from the table in chain-l2/onchain.mjs, which took them
        // from the compiler's own methodIdentifiers rather than from memory.
        poolInfo: '0x1526fe27',        // poolInfo(uint256)
        balanceOf: '0x70a08231',       // balanceOf(address)
        taken: '0xd174c832',           // taken(address,bytes32)
        minLiq: '0x5731bb0a',          // MIN_LIQ()
        peer: '0x11cda415',            // peer()
        btc: '0xa28d57d8',             // btc()
        approve: '0x095ea7b3',         // approve(address,uint256)
        allowance: '0xdd62ed3e'        // allowance(address,address)
      };""",
    r"""      // Hardcoded 4-byte selectors, each with the signature it hashes from —
      // the same policy as chain-l2/onchain.mjs: no keccak library in the
      // page. The pool ones are copied from PeerPool.build.json's `hashes`,
      // which is solc's own methodIdentifiers table; recompute any of them
      // with `cast sig '<signature>'` if you do not want to take them on
      // trust, which you should not.
      //
      // A selector is keccak of the name and the INPUT types only, so every
      // one of these changed when the contract did: PeerPool's add, remove and
      // swap take one argument fewer than PeerPools' did, because none of them
      // needs to say WHICH pool any more. Sending a PeerPools selector to this
      // contract does not misbehave subtly — it reaches no function at all —
      // but the signature beside each one is the only thing that says which is
      // which, so read them together.
      //
      // peer(), btc() and MIN_LIQ() kept their selectors, because their
      // signatures are unchanged. That is a coincidence of the arithmetic and
      // not a sign the contracts are related; it is written down here so
      // nobody reads the sameness as an argument that the others should match.
      var OC_SEL = {
        add: '0xe022d77c',             // add(uint256,uint256,uint256,uint256)
        remove: '0x7ed72fda',          // remove(uint256,uint256,uint256)
        swap: '0x59542ca9',            // swap(bool,uint256,uint256,uint256)
        reserves: '0x75172a8b',        // reserves()
        sharesOf: '0xf5eb42dc',        // sharesOf(address)
        minLiq: '0x5731bb0a',          // MIN_LIQ()
        peer: '0x11cda415',            // peer()
        btc: '0xa28d57d8',             // btc()
        // The ERC-20 side. balanceOf is how a wallet that cannot cover a
        // deposit finds out before it signs an approval for one, and allowance
        // is how one that already approved avoids paying for the permission
        // twice. Both are the constants this repo already uses everywhere.
        balanceOf: '0x70a08231',       // balanceOf(address)
        approve: '0x095ea7b3',         // approve(address,uint256)
        allowance: '0xdd62ed3e'        // allowance(address,address)
      };""",
    'the card: the selector table',
)

# ── the bytes32 name decoder has nothing left to decode ───────────────────
once(
    r"""      // A bytes32 name as text: UTF-8 bytes up to the first NUL. This is
      // chain-l2/onchain.mjs's bytes32Name transcribed rather than
      // reinvented, so a pool read here by id renders under exactly the same
      // name the list gives it — two spellings of one pool would be a worse
      // bug than no lookup at all. Nothing is stripped, for the same reason:
      // the name on screen is the name on chain. It reaches the page only
      // through textContent, so bytes chosen by a stranger stay text.
      function ocName(hexWord) {
        var bytes = [];
        for (var i = 0; i + 2 <= hexWord.length && i < 64; i += 2) {
          var b = parseInt(hexWord.slice(i, i + 2), 16);
          if (!b) break;
          bytes.push(b);
        }
        return new TextDecoder().decode(new Uint8Array(bytes));
      }

""",
    r"""""",
    'the card: the bytes32 name decoder goes with the names',
)

# ── the square root's provenance ──────────────────────────────────────────
once(
    r"""      // Integer square root, rounding down — PeerPools._sqrt transcribed line
      // for line, including its small-input branch, so the pre-check below
      // refuses exactly what the contract refuses and nothing else. Written""",
    r"""      // Integer square root, rounding down — PeerPool._sqrt transcribed line
      // for line, including its small-input branch, so the pre-check below
      // refuses exactly what the contract refuses and nothing else. Written""",
    'the card: ocSqrt names the contract it copies',
)

# ── the approval clause ───────────────────────────────────────────────────
once(
    r"""        await ocSend(token, OC_SEL.approve + ocAddr(spender) + ocWord(need), 'Approving ' + symbol, led,
          'your approval of ' + ocFmt(need, dec) + ' ' + symbol + ' to the pools contract');""",
    r"""        await ocSend(token, OC_SEL.approve + ocAddr(spender) + ocWord(need), 'Approving ' + symbol, led,
          'your approval of ' + ocFmt(need, dec) + ' ' + symbol + ' to the pool');""",
    'the card: an approval names the pool it went to',
)

# ── which two tokens, MIN_LIQ, the fresh read ─────────────────────────────
span(
    r"""      // Which two tokens get approved? Asked of the factory itself, not""",
    r"""        return l2Tokens;
      }""",
    r"""      // Which two tokens get approved? Asked of the pool itself, not taken
      // from this host's env: peer() and btc() are immutables the pool was
      // deployed with, and an approve aimed anywhere else is a wasted
      // signature over somebody's coins.
      //
      // The cache lives at module level so a chainChanged can empty it: an
      // address read off a contract on Base is not an address anywhere else.
      // And a word that is not there is not an address — slicing the last
      // 40 characters off '0x' yields something that LOOKS addressable, and an
      // approve aimed at it is a signature spent on nothing.
      // The cache is keyed on the contract that answered it. It used to be
      // keyed on nothing, which made it true of "some contract, once": a tab
      // left open while the operator repointed PEER_POOL_ADDR would go on
      // approving the OLD pool's tokens — to the NEW pool's address, over
      // coins the new one never pulls, one signature and one standing
      // permission spent on nothing. The address is normalised because a
      // checksummed and a lowercase spelling of one address must not read as
      // two.
      async function ocGetTokens(pool) {
        var key = String(pool || '').toLowerCase();
        if (l2Tokens && l2Tokens.factory === key) return l2Tokens;
        var pw = await ocEth('eth_call', [{ to: pool, data: OC_SEL.peer }, 'latest']);
        var bw = await ocEth('eth_call', [{ to: pool, data: OC_SEL.btc }, 'latest']);
        var pa = ocUint(pw, 'the pool’s peer() address'), ba = ocUint(bw, 'the pool’s btc() address');
        if (pa === 0n || ba === 0n || pa >> 160n !== 0n || ba >> 160n !== 0n) throw new Error('that address did not answer with two token addresses — nothing was signed');
        l2Tokens = { factory: key, peer: '0x' + pa.toString(16).padStart(40, '0'), btc: '0x' + ba.toString(16).padStart(40, '0') };
        return l2Tokens;
      }""",
    'the card: ocGetTokens asks the pool',
)

span(
    r"""      // Both refusals createPool can hand back are knowable for FREE, and""",
    r"""'the name claim') !== 0n;
      }""",
    r"""      // The one refusal an opening deposit can hit is knowable for FREE, and
      // it is asked before the first approval is signed. An approval that
      // lands ahead of a revert costs gas and leaves a standing permission
      // over somebody's coins; an eth_call and a square root cost neither.
      //
      // MIN_LIQ is read from the deployed pool rather than pasted from
      // PeerPool.sol. The constant in the source is 1000, but the number that
      // matters is the one the contract about to take the money answers with;
      // a page that hardcodes it is pre-checking a different contract than it
      // is paying.
      //
      // And it is not a minimum investment, whatever it looks like. It floors
      // sqrt(amtPeer × amtBtc) — a SHARE count — and PEER carries
      // 18 decimals against cbBTC's 8, so one whole PEER against one satoshi
      // mints a billion of them and clears 1000 by six orders of magnitude.
      // The only opening it refuses is the degenerate one nobody wants. That
      // sentence is on screen beside the form, not just here.
      var ocMin = null;
      async function ocMinLiq(pool) {
        var key = String(pool || '').toLowerCase();
        if (!ocMin || ocMin.factory !== key) {
          ocMin = { factory: key, value: ocUint(await ocEth('eth_call', [{ to: pool, data: OC_SEL.minLiq }, 'latest']), 'the pool’s MIN_LIQ') };
        }
        return ocMin.value;
      }""",
    'the card: MIN_LIQ from the pool, and no name to claim',
)

span(
    r"""      // So the pool is asked again, from the factory itself, after the last""",
    r"""          ts: BigInt('0x' + body.slice(192, 256))
        };
      }""",
    r"""      // So the pool is asked again, directly, after the last approval has
      // confirmed. reserves() answers THREE static words in the order
      // PeerPool.sol's own comment fixes — resPeer, resBtc, totalShares
      // — and that comment is the only thing saying where to cut, which is
      // why it is named here rather than paraphrased. It is a free read and it
      // signs nothing.
      async function ocFresh(pool) {
        var ret = await ocEth('eth_call', [{ to: pool, data: OC_SEL.reserves }, 'latest']);
        var body = String(ret == null ? '' : ret).replace(/^0x/, '');
        if (body.length < 64 * 3) throw new Error('the pool would not read back before signing, so the guard could not be set against a live price — nothing was signed');
        return {
          rp: BigInt('0x' + body.slice(0, 64)),
          rb: BigInt('0x' + body.slice(64, 128)),
          ts: BigInt('0x' + body.slice(128, 192))
        };
      }""",
    'the card: ocFresh reads reserves()',
)


# ══ 7. ocRender — four states, four sentences ═════════════════════════════
span(
    r"""        if (!d.namedPools) {""",
    r"""worse than no button.' }));
          return;
        }""",
    r"""        // Four states, four sentences, and none of them blurred into another:
        // a host older than this page, a pool that is switched off, a pool
        // address that would not read, and the pool. The first is the one that
        // would otherwise be silently wrong — an old host answering with
        // its named-pool factory would look exactly like "no pool configured",
        // which is the reading that sends an operator to fix the wrong thing.
        if (d.namedPools && !d.pool) {
          ocBody.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text: 'This host still reads the superseded named-pool factory: it answers with a list of pools inside one contract, which is the design this app no longer has. Nothing is drawn from it, because every button here calls a single pool contract that the old factory is not. This is a host to update, not a pool to fix — and nothing on chain is wrong: the factory it names is simply not what this page trades.' }));
          return;
        }
        var po = d.pool && typeof d.pool === 'object' ? d.pool : null;
        if (!po || po.configured === false || !po.address) {
          ocBody.appendChild(h('p', { class: 'smallnote', text: (po && po.why) || 'The PEER token is deployed, and no pool is: PEER_POOL_ADDR is unset on this host, so there is no contract here holding PEER against cbBTC — nothing to read, no reserves, no price, and no button that could work. An address written into source is one nobody verified, so this stays off until an operator points it at a deployment they made themselves. chain-l2/DEPLOY.md is the runbook, and it is the operator’s move rather than yours.' }));
          ocBody.appendChild(h('p', { class: 'smallnote', text: 'Off is a state, not a fault, and nothing above this card depends on it: the epoch token, your reserve and every bitcoin burn ever recorded live in the act log rather than on a chain. Burning bitcoin needs no pool and no price at all, and it works.' }));
          return;
        }
        if (po.error) {
          // Set, and it did not read. An unreadable address must never be
          // dressed up as an empty pool: an empty pool invites the first
          // deposit, and this is a configuration to fix before anybody signs.
          ocBody.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text: String(po.error) }));
          ocBody.appendChild(h('p', { class: 'smallnote' },
            h('span', { class: 'num', style: 'word-break:break-all', text: String(po.address) }),
            ' · the address this host was pointed at. That is a misconfiguration to settle rather than an empty pool to deposit into, so no form is drawn. ',
            l2ScanLink(8453, 'address', String(po.address), 'on basescan')));
          return;
        }""",
    'ocRender: the four states of the pool',
)

once(
    r"""        var np = d.namedPools;
        // One field, np.error, carries two failures that deserve opposite
        // treatment, and telling them apart is the difference between a card
        // that degrades and a card that disappears:
        //
        //   · the address answered poolCount() but the POOL SCAN failed. The
        //     scan is the fragile part — most public RPCs refuse a getLogs
        //     range this wide — and NOTHING else on this card is derived from
        //     it. Collapsing the whole card here meant that the moment the
        //     scan broke, a user could not open a pool either, on a form that
        //     never touched the scan. So it degrades: the endpoint's own
        //     sentence goes where the list would be, and everything that
        //     speaks to Base directly keeps working.
        //
        //   · nothing at that address answered poolCount() at all. Then there
        //     is no factory: no decimals to scale an amount by, and nothing
        //     for a create to create in. That one still collapses, and says
        //     which of the two it is.
        //
        // The test is whether the factory answered anything before the scan.
        // A host that later reports its scan under new names still trips it,
        // because tokens/total/decimals are read off the factory itself.
        var answered = np.total != null || np.tokens != null || np.pools != null ||
          np.peerDecimals != null || np.btcDecimals != null || np.scan != null;
        if (np.error && !answered) {
          // The factory address is set but did not answer like a factory.
          // That is the endpoint's own sentence too, and "unreadable" must
          // not be dressed up as "empty" — an empty factory invites a
          // deposit; an unreadable one is a misconfiguration to fix first.
          ocBody.appendChild(h('p', { class: 'smallnote', text: np.error }));
          return;
        }
        // Held, not returned on. drawPools prints it in place of the list.
        var scanError = np.error || null;
        var factory = np.factory;
        var pdec = np.peerDecimals == null ? 18 : Number(np.peerDecimals);
        var bdec = np.btcDecimals == null ? 8 : Number(np.btcDecimals);""",
    r"""        // From here the pool read. There is no scan to have half-failed and no
        // list to be short: one eth_call answered three words, or the branch
        // above already said what went wrong instead.
        var pool = String(po.address);
        // The two decimals come from the reader, which asked the two token
        // contracts. 18 and 8 are the expected answers and never the assumed
        // ones: cbBTC carries 8, which is why one raw unit of it is one
        // satoshi, and a display scaled by the wrong figure is wrong by a
        // hundred million while looking perfectly ordinary.
        var pdecs = (po.decimals && typeof po.decimals === 'object') ? po.decimals : {};
        var pdec = pdecs.peer == null ? 18 : Number(pdecs.peer);
        var bdec = pdecs.btc == null ? 8 : Number(pdecs.btc);
        var resPeer = BigInt(po.resPeerRaw || '0');
        var resBtc = BigInt(po.resBtcRaw || '0');
        var totalShares = BigInt(po.totalSharesRaw || '0');""",
    'ocRender: the scan report has nothing left to report',
)

once(
    r"""        // The factory names its own two tokens and the reader checks them
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

        // The address every button below sends to, printed and linkable. It
        // was the one address on this card a reader could not check, which is
        // backwards: a pool list is judged by its reserves and its creators,
        // and the factory holding all of them is judged by being readable.
        ocBody.appendChild(h('p', { class: 'smallnote' },
          h('span', { class: 'num', style: 'word-break:break-all', text: String(factory) }),
          ' · the pools contract this host reads, on Base. ',
          l2ScanLink(8453, 'address', factory, 'on basescan')));""",
    r"""        // The address, printed and linkable, because with one pool the address
        // IS the identity. There is no name to check it against, which also
        // means there is no name to be fooled by: a reader either has this
        // address or does not, and an explorer settles the rest.
        ocBody.appendChild(h('p', { class: 'smallnote' },
          h('span', { class: 'num', style: 'word-break:break-all', text: pool }),
          ' · the pool, on Base — the address every button below sends to, and the only thing that says which pool this is. ',
          l2ScanLink(8453, 'address', pool, 'on basescan')));""",
    'ocRender: the address is the identity',
)

span(
    r"""            walletRow.appendChild(h('span', { class: 'smallnote', text: 'No wallet detected """,
    r"""adding or opening a pool needs one on Base.' }));""",
    r"""            walletRow.appendChild(h('span', { class: 'smallnote', text: 'No wallet detected — the pool stays readable, but swapping, adding and withdrawing need one on Base.' }));""",
    'ocRender: the wallet row',
)


# ══ 8. The list machinery, replaced by one pool ═══════════════════════════
once(
    r"""        // A name here is a LABEL and never an identifier. PeerPools claims
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
        ocBody.appendChild(listBox);""",
    r"""        // One pool, drawn once. What used to be here — a ranked list, a
        // shared-name marker, a scan report, an id lookup for whatever the
        // scan missed — answered the question "which of these is the one I
        // mean?", and that question now has an address for an answer.
        var listBox = h('div', {});
        ocBody.appendChild(listBox);

        // How far this pool is from the door a PEER burn needs, read from the
        // engine's own rules rather than typed here — one number to keep
        // true instead of two. Null when this build carries no burn rules, and
        // then the line is left out rather than invented.
        var minSats = (function () {
          var lim = st && st.peerBurn && st.peerBurn.limits;
          var v = lim && lim.minPoolSats;
          return /^[0-9]+$/.test(String(v)) ? BigInt(String(v)) : null;
        })();""",
    'the card: one pool where the list was',
)

span(
    r"""        function drawPools() {""",
    r"""          list.forEach(function (p) { listBox.appendChild(poolRow(p, byName[String(p.nameRaw || p.name || '')] || 1)); });
        }""",
    r"""        function drawPools() {
          listBox.innerHTML = '';
          listBox.appendChild(totalShares > 0n ? poolPanel() : openingPanel());
        }""",
    'the card: drawPools draws the pool',
)

# The scan-report helpers have nothing to report about a single eth_call.
span(
    r"""        // Everything the reader says about its own reading gets said again""",
    r"""          return listed ? n : n + 1;
        }
""",
    r"""        // What a thin pool is, said once, above both panels: it is the
        // sentence that survives the redesign unchanged, because it was never
        // about which pool you were looking at.
        function thinNote() {
          return h('p', { class: 'smallnote', text: 'A price here is this pool’s own ratio and nothing more: what went in, moved by whoever has traded since. It is not a market price. The less the pool holds, the further one ordinary trade moves it — the curve charges the same proportional slippage on a much smaller base — and this page cannot show how the PEER supply is held, so a ratio one holder chose is a number rather than a valuation.' });
        }

        // How far the bitcoin side is from the depth the PEER-burn door
        // demands, in the units the door actually counts: raw satoshis. The
        // door is not this card's to open or relax, and a pool below the floor
        // is perfectly legitimate — those are two different questions, and
        // saying so is the whole point of printing the gap.
        function depthNote(rb) {
          if (minSats === null) return null;
          if (rb >= minSats) {
            return h('p', { class: 'smallnote' },
              'Deep enough for the PEER-burn door on ', term('poolDepth', 'depth'), ': it refuses to price against a pool holding under ' + l2Human(minSats.toString(), 0) + ' sat, and this one holds ' + l2Human(rb.toString(), 0) + '. Depth is not the only condition — the host still needs its own time-weighted reading before it will quote anything — but this fence is cleared.');
          }
          return h('p', { class: 'smallnote' },
            'Not deep enough to price a PEER burn, and that is not a fault in the pool. The door needs ' + l2Human(minSats.toString(), 0) + ' sat of ', term('poolDepth', 'depth'),
            ' and this pool holds ' + l2Human(rb.toString(), 0) + ' — ' + l2Human((minSats - rb).toString(), 0) + ' short. A pool this size is a real pool and trades normally; what it may not do is set the rate at which the right to speak is sold, because one trade moves a thin pool a long way and that is exactly what the fence is for. Burning bitcoin needs no pool and is unaffected.');
        }

""",
    'the card: the two notes that replace the scan report',
)


# ══ 9. The panels ════════════════════════════════════════════════════════
# poolRow (a row in a list, keyed by id, carrying a creator and a name), the
# find-a-pool-by-id door and the open-a-pool form are replaced by exactly two
# panels: the pool as it stands, and — when nobody has funded it — the first
# add. The span is cut by its two ends rather than transcribed, because five
# hundred lines of anchor is five hundred lines that can be mistyped.
span(
    r"""        // `foundById` marks a row that was read from the chain a second ago""",
    r"""and your wallet shows you every transaction before it signs it.' }));""",
    r"""        /**
         * The pool as it stands, and everything anyone can do to it.
         *
         * ONE panel, because there is one pool. Every sentence the row version
         * carried about WHICH pool this was — the id in every message, the
         * creator under every price, the marker where two pools shared a name
         * — had a job only while there were several, and that job is now done
         * by the address printed above this panel.
         *
         * The reserves it draws are this host's reading and up to half a
         * minute old. Nothing is SIGNED against them: every write below
         * re-reads the pool from Base at the last moment, after the last
         * approval has confirmed, and refuses if what it finds has moved
         * outside the band the reader agreed to. That rule matters more here
         * than it did in a list, not less — this screen holds forms the whole
         * time it is open, so its own repaint is suppressed and these integers
         * can be hours behind rather than seconds.
         */
        function poolPanel() {
          var rp = resPeer, rb = resBtc, ts = totalShares;
          var box = h('div', {});
          var kv = h('div', { class: 'kv' },
            h('span', { text: 'the pool holds' }),
            h('b', { class: 'num', text: ocFmt(rp, pdec) + ' PEER / ' + ocFmt(rb, bdec) + ' cbBTC' }));
          if (rp > 0n && rb > 0n) {
            // Display-only floats, both ways round, because half a price is a
            // price somebody has to do arithmetic on before they can read it.
            // The raw integers below are what every quote is computed from.
            var px = (Number(rb) / Math.pow(10, bdec)) / (Number(rp) / Math.pow(10, pdec));
            kv.appendChild(h('span', { text: 'so one PEER is' }));
            kv.appendChild(h('b', { class: 'num', text: ocPx(px) + ' BTC' }));
            kv.appendChild(h('span', { text: 'and one BTC is' }));
            kv.appendChild(h('b', { class: 'num', text: ocPx(1 / px) + ' PEER' }));
          }
          kv.appendChild(h('span', {}, term('poolShare', 'shares in issue')));
          kv.appendChild(h('b', { class: 'num', text: ts.toString() }));
          box.appendChild(kv);
          box.appendChild(h('p', { class: 'smallnote', text: 'Raw: ' + rp.toString() + ' wei of PEER against ' + rb.toString() + ' satoshis — cbBTC carries 8 decimals, so one raw unit of it IS one satoshi. Those two integers are what every quote below is computed from; the decimal figures above them have been through a double, and nothing that has been through a double is ever signed.' }));
          box.appendChild(thinNote());
          var dn = depthNote(rb);
          if (dn) box.appendChild(dn);

          // ── your share of it ──
          // Shares are accounting inside the contract and not a token, so no
          // wallet screen and no explorer shows them: this read is the only
          // place they surface. Asked of the chain on every draw, never
          // remembered.
          var mineBox = h('div', {});
          box.appendChild(mineBox);
          function drawMine() {
            mineBox.innerHTML = '';
            if (!l2Wallet || !window.ethereum) {
              mineBox.appendChild(h('p', { class: 'smallnote' },
                'Connect a wallet to see whether this address holds any ', term('poolShare', 'shares'),
                ' of this pool. They are accounting inside the contract rather than a token, so nothing else shows them — not a wallet, not an explorer.'));
              return;
            }
            mineBox.appendChild(h('p', { class: 'smallnote', text: 'Asking the pool what this address holds…' }));
            ocEth('eth_call', [{ to: pool, data: OC_SEL.sharesOf + ocAddr(l2Wallet) }, 'latest'])
              .then(function (res) {
                var sh = 0n;
                try { sh = ocUint(res, 'your share balance'); }
                catch (e) {
                  // An unanswered call and an empty position look identical as
                  // a number and are opposite as a fact, so neither is printed
                  // as the other.
                  mineBox.innerHTML = '';
                  mineBox.appendChild(h('p', { class: 'smallnote', text: 'That read did not answer, so nothing is claimed here about your share. Check the wallet is on Base; a zero is not printed for a question nobody answered.' }));
                  return;
                }
                mineBox.innerHTML = '';
                if (sh <= 0n) {
                  mineBox.appendChild(h('p', { class: 'smallnote', text: 'This address holds no share of this pool. Adding liquidity below is what mints one, at whatever ratio the pool holds when it lands.' }));
                  return;
                }
                var outP = ts > 0n ? sh * rp / ts : 0n;
                var outB = ts > 0n ? sh * rb / ts : 0n;
                mineBox.appendChild(h('div', { class: 'kv' },
                  h('span', {}, term('poolShare', 'your shares')), h('b', { class: 'num', text: sh.toString() }),
                  h('span', { text: 'of the pool' }), h('b', { class: 'num', text: ts > 0n ? (Number(sh * 1000000n / ts) / 10000).toFixed(4) + '%' : '—' }),
                  h('span', { text: 'worth, right now' }), h('b', { class: 'num', text: ocFmt(outP, pdec) + ' PEER + ' + ocFmt(outB, bdec) + ' cbBTC' })));
                mineBox.appendChild(h('p', { class: 'smallnote', text: 'That slice is what withdrawing everything would pay AT THIS RATIO, and the ratio is not yours: a trade landing before your withdrawal turns some of one side into the other, so the slice stays proportional while what it is made of changes. It is also not what you deposited, if the price moved while you were in.' }));
                mineBox.appendChild(removeForm(sh, outP, outB));
              })
              .catch(function () {
                mineBox.innerHTML = '';
                mineBox.appendChild(h('p', { class: 'smallnote', text: 'This wallet refused the share-balance read, so nothing is said about your position here.' }));
              });
          }

          // ── take liquidity back out ──
          // remove(shareAmt, minPeer, minBtc). No deadline in this one, which
          // is the contract's own choice and worth knowing: a late removal is
          // not priced, it pays the pro-rata slice of whatever is there, and
          // the two minimums already describe the only outcome anybody could
          // object to.
          function removeForm(sh, expP, expB) {
            var amt = h('input', { type: 'text', placeholder: 'shares', style: 'width:130px', inputmode: 'numeric' });
            var maxBtn = h('button', { class: 'btn small', text: 'all of it', onclick: function () { amt.value = sh.toString(); } });
            var wdBusy = false;
            var wdBtn = h('button', { class: 'btn small', text: 'Withdraw', onclick: function () {
              var t = String(amt.value || '').trim();
              if (!/^[0-9]+$/.test(t) || BigInt(t) <= 0n) { toast('How many shares? They are whole raw units — “all of it” fills in everything this address holds.'); return; }
              var want = BigInt(t);
              if (want > sh) { toast('This address holds ' + sh.toString() + ' share units and that asks for ' + want.toString() + '. The contract would refuse it, so nothing was signed.'); return; }
              if (wdBusy) { toast('That withdrawal is already going through. Pressing again would sign a second one.'); return; }
              // Both minimums are 2% under what the pool pays for THESE shares
              // when this is signed — read again below rather than taken from
              // the render — and floored at what this panel printed, so
              // neither a stale number nor a live one can lower what was
              // promised on screen.
              var mineP = ts > 0n ? want * rp / ts : 0n;
              var mineB = ts > 0n ? want * rb / ts : 0n;
              var led = ocLedger();
              wdBusy = true; wdBtn.disabled = true; wdBtn.textContent = 'Working…';
              (async function () {
                try {
                  var fr = await ocFresh(pool);
                  var nowP = fr.ts > 0n ? want * fr.rp / fr.ts : 0n;
                  var nowB = fr.ts > 0n ? want * fr.rb / fr.ts : 0n;
                  if (ocDrift(mineP, nowP) || ocDrift(mineB, nowB)) {
                    ocRefresh();
                    throw new Error('the pool moved while this panel sat open: those shares read ' + ocFmt(nowP, pdec) + ' PEER and ' + ocFmt(nowB, bdec) + ' cbBTC now, not ' + ocFmt(mineP, pdec) + ' and ' + ocFmt(mineB, bdec) + '. Nothing was signed — press Withdraw again against what it holds now.');
                  }
                  await ocSend(pool, OC_SEL.remove + ocWord(want) + ocWord(ocFloor(mineP, nowP)) + ocWord(ocFloor(mineB, nowB)), 'Withdrawing from the pool', led, 'the withdrawal of ' + want.toString() + ' share units');
                  toast('Withdrew from the pool — both sides, proportional to the shares burned. ' + OC_LAG);
                  ocTxRecord(led, 'Withdrawal from the pool');
                  ocRefresh();
                } catch (e) { toast(led.sentence('The withdrawal stopped', e)); ocTxRecord(led, 'Withdrawal from the pool — stopped'); }
                finally { wdBusy = false; wdBtn.disabled = false; wdBtn.textContent = 'Withdraw'; }
              })();
            } });
            var wrap2 = h('div', {});
            wrap2.appendChild(h('p', { class: 'eyebrow', style: 'margin:10px 0 0', text: 'take liquidity back out' }));
            wrap2.appendChild(h('div', { class: 'mini-form' }, amt, maxBtn, wdBtn));
            wrap2.appendChild(h('p', { class: 'smallnote', text: 'Burning shares pays out that fraction of BOTH sides. Nothing here can be withdrawn as one coin: the pool pays PEER and cbBTC together, in whatever proportion it happens to hold them. Two minimums are sent with it, each 2% under the slice above, so a trade landing in front of the withdrawal makes it revert rather than fill into the other side.' }));
            return wrap2;
          }

          // ── swap ──
          var sellSel = h('select', {}, h('option', { value: 'PEER', text: 'sell PEER' }), h('option', { value: 'BTC', text: 'sell cbBTC' }));
          var amtIn = h('input', { type: 'text', placeholder: 'amount', style: 'width:90px', inputmode: 'decimal' });
          var quote = h('span', { class: 'smallnote' });
          function quoteNow() {
            var sellPeer = sellSel.value === 'PEER';
            var vin = ocUnits(amtIn.value, sellPeer ? pdec : bdec);
            if (vin === null) return null;
            var out = ocQuote(vin, sellPeer ? rp : rb, sellPeer ? rb : rp);
            return { sellPeer: sellPeer, vin: vin, out: out, min: ocGuard(out), dec: sellPeer ? bdec : pdec, sym: sellPeer ? 'cbBTC' : 'PEER' };
          }
          function requote() {
            var q = quoteNow();
            if (!q) { quote.textContent = ''; return; }
            if (q.out <= 0n) { quote.textContent = 'the pool cannot fill this'; return; }
            var t = '→ ' + ocFmt(q.out, q.dec) + ' ' + q.sym + ' (incl. 0.3% fee); it reverts below ' + ocFmt(q.min, q.dec) + ' ' + q.sym;
            // Below about fifty raw units a percentage is not expressible at
            // all: 2% of three sats is nothing an integer can hold. The guard
            // is floored at one unit there, which makes the trade
            // all-or-nothing, and saying so is the difference between a tight
            // guard and a guard the user thinks they have.
            if (q.out < 50n) t += ' — that output is only ' + q.out + ' raw units, too small to protect by percentage, so any move at all makes it revert. Trade more if you want room.';
            quote.textContent = t;
          }
          amtIn.addEventListener('input', requote);
          sellSel.addEventListener('change', requote);
          var swapBusy = false;
          var swapBtn = h('button', { class: 'btn small primary', text: 'Swap on Base', onclick: function () {
              var q = quoteNow();
              if (!q) { toast('Say how much.'); return; }
              if (q.out <= 0n) { toast('The pool cannot fill this.'); return; }
              if (swapBusy) { toast('That swap is already going through — the wallet may be asking for an approval before the trade itself. Pressing again would start a second one, and an approval that lands after the first swap lets the second one through too.'); return; }
              var led = ocLedger();
              swapBusy = true;
              swapBtn.disabled = true;
              swapBtn.textContent = 'Working…';
              (async function () {
                try {
                  if (!l2Wallet && !(await ocConnect())) { toast('Trading needs a wallet on Base.'); return; }
                  drawWallet();
                  var toks = await ocGetTokens(pool);
                  var sellTok = q.sellPeer ? toks.peer : toks.btc;
                  var sellSym = q.sellPeer ? 'PEER' : 'cbBTC';
                  var sellDec = q.sellPeer ? pdec : bdec;
                  await ocHave(sellTok, q.vin, sellSym, sellDec);
                  await ocAllow(sellTok, pool, q.vin, sellSym, sellDec, led);
                  // Two guards, both the caller's own, and the pool is asked
                  // again HERE — after the approval above has confirmed, not
                  // before it — so the minimum is set from what it pays now
                  // and floored at what the quote line promised.
                  var fr = await ocFresh(pool);
                  var nowOut = ocQuote(q.vin, q.sellPeer ? fr.rp : fr.rb, q.sellPeer ? fr.rb : fr.rp);
                  if (ocDrift(q.out, nowOut)) {
                    ocRefresh();
                    throw new Error('the pool moved while this was waiting — ' + ocFmt(q.out, q.dec) + ' ' + q.sym + ' was quoted and it would fill ' + ocFmt(nowOut, q.dec) + ' ' + q.sym + ' now. Nothing was signed against the old number; press Swap again to trade at a price you can see.');
                  }
                  var data = OC_SEL.swap + ocWord(q.sellPeer ? 1n : 0n) + ocWord(q.vin) + ocWord(ocFloor(q.out, nowOut)) + ocWord(await ocDeadline());
                  await ocSend(pool, data, 'Swapping in the pool', led, 'the swap of ' + ocFmt(q.vin, sellDec) + ' ' + sellSym);
                  toast('Swapped. ' + OC_LAG);
                  ocTxRecord(led, 'Swap in the pool');
                  ocRefresh();
                } catch (e) { toast(led.sentence('The swap stopped', e)); ocTxRecord(led, 'Swap in the pool — stopped'); }
                finally {
                  swapBusy = false;
                  swapBtn.disabled = false;
                  swapBtn.textContent = 'Swap on Base';
                }
              })();
            } });
          box.appendChild(h('p', { class: 'eyebrow', style: 'margin:10px 0 0', text: 'trade against it' }));
          box.appendChild(h('div', { class: 'mini-form' }, sellSel, amtIn, swapBtn, quote));

          // ── add liquidity ──
          var addP = h('input', { type: 'text', placeholder: 'PEER', style: 'width:90px', inputmode: 'decimal' });
          var addB = h('input', { type: 'text', placeholder: 'cbBTC', style: 'width:90px', inputmode: 'decimal' });
          var addNote = h('span', { class: 'smallnote' });
          function addQuote() {
            var vp = ocUnits(addP.value, pdec), vb = ocUnits(addB.value, bdec);
            if (vp === null || vb === null || ts <= 0n || rp <= 0n || rb <= 0n) { addNote.textContent = ''; return null; }
            var byP = vp * ts / rp, byB = vb * ts / rb;
            var mint = byP < byB ? byP : byB;
            if (mint <= 0n) { addNote.textContent = 'too small to mint a share at this ratio — the contract would refuse it'; return 0n; }
            // Which side BINDS is the thing nobody expects, so it is named
            // rather than left to be discovered by the amount that vanished.
            var usedP = mint * rp / ts, usedB = mint * rb / ts;
            addNote.textContent = '→ ' + mint.toString() + ' share units, and it would take about ' + ocFmt(usedP, pdec) + ' PEER and ' + ocFmt(usedB, bdec) + ' cbBTC. The ' + (byP < byB ? 'PEER' : 'cbBTC') + ' side binds; the rest of the other one never leaves your wallet.';
            return mint;
          }
          addP.addEventListener('input', addQuote);
          addB.addEventListener('input', addQuote);
          var addBusy = false;
          var addBtn = h('button', { class: 'btn small', text: 'Add liquidity', onclick: function () {
              var vp = ocUnits(addP.value, pdec), vb = ocUnits(addB.value, bdec);
              if (vp === null || vb === null) { toast('Both amounts, please — a pool has two sides and they go in together.'); return; }
              if (addBusy) { toast('That deposit is already going through — it takes up to two approvals and the wallet asks for each in turn. Pressing again would start a second deposit.'); return; }
              var expect = 0n;
              if (ts > 0n && rp > 0n && rb > 0n) {
                var byP = vp * ts / rp, byB = vb * ts / rb;
                expect = byP < byB ? byP : byB;
                if (expect <= 0n) { toast('That deposit is too small to mint a share at this ratio — the contract would refuse it, so nothing was signed.'); return; }
              }
              var led = ocLedger();
              addBusy = true;
              addBtn.disabled = true;
              addBtn.textContent = 'Working…';
              (async function () {
                try {
                  if (!l2Wallet && !(await ocConnect())) { toast('Adding liquidity needs a wallet on Base.'); return; }
                  drawWallet();
                  var toks = await ocGetTokens(pool);
                  // Both sides asked for free before either is approved:
                  // approving PEER and then discovering the wallet has no
                  // cbBTC leaves a paid-for permission and no deposit.
                  await ocHave(toks.peer, vp, 'PEER', pdec);
                  await ocHave(toks.btc, vb, 'cbBTC', bdec);
                  await ocAllow(toks.peer, pool, vp, 'PEER', pdec, led);
                  await ocAllow(toks.btc, pool, vb, 'cbBTC', bdec, led);
                  var fr = await ocFresh(pool);
                  var nowExp = 0n;
                  if (fr.ts > 0n && fr.rp > 0n && fr.rb > 0n) {
                    var nP = vp * fr.ts / fr.rp, nB = vb * fr.ts / fr.rb;
                    nowExp = nP < nB ? nP : nB;
                    if (nowExp <= 0n) {
                      ocRefresh();
                      throw new Error('that deposit is too small to mint a share at the ratio the pool holds NOW, so the contract would refuse it — nothing was signed');
                    }
                  }
                  if (ocDrift(expect, nowExp)) {
                    ocRefresh();
                    throw new Error('the pool moved while this was waiting: this deposit was going to mint ' + expect + ' raw share units and it would mint ' + nowExp + ' now. Nothing was signed — press Add liquidity again against the ratio it holds now.');
                  }
                  await ocSend(pool, OC_SEL.add + ocWord(vp) + ocWord(vb) + ocWord(ocFloor(expect, nowExp)) + ocWord(await ocDeadline()), 'Adding liquidity', led, 'the deposit into the pool');
                  toast('Added to the pool — the proportional part of what you offered. ' + OC_LAG);
                  ocTxRecord(led, 'Deposit into the pool');
                  ocRefresh();
                } catch (e) { toast(led.sentence('The deposit stopped', e)); ocTxRecord(led, 'Deposit into the pool — stopped'); }
                finally {
                  addBusy = false;
                  addBtn.disabled = false;
                  addBtn.textContent = 'Add liquidity';
                }
              })();
            } });
          box.appendChild(h('p', { class: 'eyebrow', style: 'margin:10px 0 0', text: 'add liquidity — anyone may, and every add makes it bigger' }));
          box.appendChild(h('div', { class: 'mini-form' }, addP, addB, addBtn, addNote));
          box.appendChild(h('p', { class: 'smallnote', text: 'Every deposit after the first is PROPORTIONAL at the ratio the pool already holds, so it moves no price: you state a ceiling on each side, the contract takes the largest proportional deposit that fits under both, and the excess never leaves your wallet — there is no refund because there is nothing to refund. What you get back is shares, and what shares pay out is a fraction of both sides at whatever ratio exists when you leave.' }));
          box.appendChild(h('p', { class: 'smallnote', text: 'A minimum-share guard goes with it, 2% under the number above and never under what this panel printed. A trade landing just ahead of a deposit changes WHICH side binds, which can mint fewer shares for the same coins; the guard turns that from a surprise into a revert.' }));

          drawMine();
          return box;
        }

        /**
         * Nobody has funded this pool yet.
         *
         * Three zeros where the reserves go is a real state and not an error:
         * the contract is deployed, it is at the address above, and nothing
         * has been put into it. This is the only deposit in the life of this
         * contract that is not priced by anything — with no reserves there is
         * no ratio, so the two amounts ARE the opening price, and every later
         * trade starts from the number chosen here. The contract's seeding
         * branch can run exactly once, ever, because MIN_LIQ shares are locked
         * at an address nobody can sign from; there is no second first time.
         *
         * So this panel says that as loudly as this file knows how, prints the
         * implied rate BOTH ways as the amounts are typed, and refuses to
         * suggest a number — a default here would be this page picking a price
         * with somebody else's money.
         *
         * ANY SIZE. That is the operator's requirement and it is true: the
         * only opening the contract refuses is the degenerate one, because
         * sqrt(amtPeer × amtBtc) must clear a floor of 1000 raw share units
         * and one whole PEER against one satoshi clears it by six orders of
         * magnitude. The floor is on the SHARE COUNT and never a minimum
         * investment, and the note below the form says so in those words so
         * nobody reads it as one.
         */
        function openingPanel() {
          var box = h('div', {});
          box.appendChild(h('p', { class: 'eyebrow', style: 'margin:0 0 4px', text: 'nobody has funded this pool yet' }));
          box.appendChild(h('p', { class: 'smallnote', text: 'Its reserves are three zeros. That is a real state rather than a fault or an outage: the contract exists at the address above, it has never held a coin, and the first deposit is the one that opens it.' }));
          box.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text: 'THE FIRST DEPOSIT SETS THE PRICE, and nothing else does. There is no market in PEER against bitcoin to take a number from, so the two amounts you put in ARE the opening ratio — a price of your own invention that every trade after it starts from. It happens once: the contract can never be re-opened, because the first 1000 share units are locked at an address nobody can sign from, so even a pool drained to that floor is added to at the ratio the dust already has rather than re-priced. Nobody can undo this and no host can give it back.' }));
          box.appendChild(h('p', { class: 'smallnote', text: 'Seed it as small as you like. The contract refuses exactly one opening — a single wei of PEER against a single satoshi — because the opening shares are sqrt(PEER × cbBTC) and that has to clear a floor of 1000 raw units. One whole PEER against one satoshi mints a billion of them. The floor is a floor on the SHARE COUNT, not a minimum investment, and it is there to stop the first depositor being robbed by rounding.' }));

          var cPeer = h('input', { type: 'text', placeholder: 'PEER', style: 'width:104px', inputmode: 'decimal' });
          var cBtc = h('input', { type: 'text', placeholder: 'cbBTC', style: 'width:104px', inputmode: 'decimal' });
          var cPrice = h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px' });
          var cBtn = h('button', { class: 'btn small primary', text: 'Open the pool on Base' });
          var cBusy = false;

          var NO_PEER = 'This wallet holds no PEER token on Base at all. The PEER counted in the Wallet tab is a different thing that happens to share the name: a number in this network’s own log, not in any wallet, and there is no bridge that turns one into the other. Funding this pool needs the Base token itself, in this address.';
          var NO_BTC = 'This wallet holds no cbBTC at all. A pool has two sides and cbBTC is the other one: it is bitcoin on Base — an ERC-20 that stands for BTC — and no amount of PEER becomes it. It has to be bought or bridged onto Base, into this address, before the pool can be opened.';

          function cSay(t, warn) {
            ocSeq.appendChild(h('p', { class: 'smallnote', style: warn ? 'border-left:2px solid var(--ember); padding-left:9px' : 'padding-left:9px', text: t }));
          }

          // The most consequential line on this screen, said live and both
          // ways round before anything is signed. A price you learn afterwards
          // is a price you did not choose.
          function cRatio() {
            var vp = ocUnits(cPeer.value, pdec), vb = ocUnits(cBtc.value, bdec);
            if (vp === null || vb === null) {
              cPrice.textContent = 'The two amounts ARE the opening price — there is no market to take one from. Fill both in and the rate they set appears here, both ways round, before anything is signed.';
              return;
            }
            var pf = Number(vp) / Math.pow(10, pdec), bf = Number(vb) / Math.pow(10, bdec);
            cPrice.textContent = 'You are setting the price: 1 PEER = ' + ocPx(bf / pf) + ' BTC, and 1 BTC = ' + ocPx(pf / bf) + ' PEER. That is ' + vb.toString() + ' satoshis against ' + vp.toString() + ' wei, as whole numbers, which is what the contract stores. Nothing else prices PEER against bitcoin, so this ratio is the price until somebody trades against it — and against a pool this thin the first trade moves it a long way, in whichever direction pays the trader. This page also cannot show how the PEER supply is held, so nothing outside this form agrees with the number you are about to set.';
          }
          cPeer.addEventListener('input', cRatio);
          cBtc.addEventListener('input', cRatio);
          cRatio();

          // "The number of coins you have", as one tap rather than arithmetic.
          // Exact to the last raw unit, because this value is parsed straight
          // back into the transaction. Gas is paid in ETH, so emptying either
          // of these two balances strands nothing.
          function cMax(input, sym) {
            return h('button', { class: 'btn small', text: 'max ' + sym, onclick: function () {
              if (cBusy) { toast('The pool is being opened with the amounts already captured — the fields are held still until that finishes.'); return; }
              (async function () {
                try {
                  if (!l2Wallet && !(await ocConnect())) { toast('Reading your balance needs the wallet connected on Base. It signs nothing.'); return; }
                  drawWallet();
                  var toks = await ocGetTokens(pool);
                  var isPeer = sym === 'PEER';
                  var raw = await ocBal(isPeer ? toks.peer : toks.btc, sym);
                  input.value = ocDec(raw, isPeer ? pdec : bdec);
                  cRatio();
                  if (raw === 0n) cSay(isPeer ? NO_PEER : NO_BTC, true);
                } catch (e) { toast('Could not read your ' + sym + ' balance: ' + ocErr(e)); }
              })();
            } });
          }
          var cMaxP = cMax(cPeer, 'PEER'), cMaxB = cMax(cBtc, 'cbBTC');

          cBtn.addEventListener('click', function () {
            if (cBusy) return;
            ocSeq.innerHTML = '';
            var vp = ocUnits(cPeer.value, pdec), vb = ocUnits(cBtc.value, bdec);
            if (vp === null || vb === null) { cSay('Both starting amounts, both above zero — a pool has two sides and they go in together. “max PEER” and “max cbBTC” fill in what this wallet actually holds.', true); return; }
            var led = ocLedger();
            cBusy = true;
            cBtn.disabled = true;
            cBtn.textContent = 'Working…';
            // Everything the price line is computed from goes still with it:
            // vp and vb are captured above and the wallet is about to be asked
            // about exactly those two numbers, so a field that could still be
            // typed into would leave a sentence on screen describing a deposit
            // nobody is making.
            cPeer.disabled = true;
            cBtc.disabled = true;
            cMaxP.disabled = true;
            cMaxB.disabled = true;
            (async function () {
              try {
                cSay('Checking everything that can be checked for free. Nothing is signed and no gas is spent until all of it passes.');
                if (!l2Wallet && !(await ocConnect())) { cSay('Opening the pool needs a wallet connected on Base. Nothing was signed.', true); return; }
                drawWallet();
                var chain = await ocEth('eth_chainId');
                if (chain !== OC_CHAIN) {
                  l2Wallet = null;
                  l2Tokens = null;
                  if (l2Redraw) l2Redraw();
                  cSay('That wallet answers for chain ' + chain + ', not Base (' + OC_CHAIN + '). Every check below would be about a different chain, so none of them ran and nothing was signed. Put the wallet on Base and connect again.', true);
                  return;
                }
                var toks = await ocGetTokens(pool);
                // The dead-contract check, and it is free. A pool deployed
                // with a wrong immutable — a plain wallet address where the
                // token address belonged — answers peer() with something
                // perfectly well formed that no ERC-20 lives at. Every later
                // failure then blames the wrong thing: balanceOf answers '0x',
                // which reads as "check you are on Base", and an approve sent
                // there costs gas and permits nothing. This has happened on
                // this network once already.
                var codeP = await ocEth('eth_getCode', [toks.peer, 'latest']);
                var codeB = await ocEth('eth_getCode', [toks.btc, 'latest']);
                var dead = [];
                if (!codeP || codeP === '0x') dead.push('PEER as ' + toks.peer);
                if (!codeB || codeB === '0x') dead.push('cbBTC as ' + toks.btc);
                if (dead.length) {
                  cSay('This pool names ' + dead.join(' and ') + ', and no contract lives at that address. A pool pointed at something that is not a token can never trade, and an approval sent there would cost gas and permit nothing. Nothing was signed. Fixing it means deploying the pool again, which is the operator’s move — chain-l2/DEPLOY.md.', true);
                  return;
                }
                // MIN_LIQ from the deployed contract rather than from the
                // source, and the square root in BigInt: sqrt of an
                // 18-decimal amount times an 8-decimal one leaves Math.sqrt's
                // exactness far behind.
                var s0 = ocSqrt(vp * vb);
                var minLiq = await ocMinLiq(pool);
                if (s0 <= minLiq) {
                  cSay('Too small to open, and this is the only size this contract refuses. The opening shares are sqrt(PEER × cbBTC) = ' + s0 + ' raw units and the pool locks ' + minLiq + ' of them forever, so an opening deposit has to mint more than that. One whole PEER against one satoshi mints a billion, so raising either amount even slightly clears it. Nothing was signed.', true);
                  return;
                }
                var haveP = await ocBal(toks.peer, 'PEER');
                var haveB = await ocBal(toks.btc, 'cbBTC');
                if (haveP === 0n) { cSay(NO_PEER + ' Nothing was signed.', true); return; }
                if (haveP < vp) {
                  cSay('This wallet holds ' + ocDec(haveP, pdec) + ' PEER on Base and this asks for ' + ocDec(vp, pdec) + '. “max PEER” fills in the figure it actually holds. Nothing was signed.', true);
                  return;
                }
                if (haveB === 0n) { cSay(NO_BTC + ' Nothing was signed.', true); return; }
                if (haveB < vb) {
                  cSay('This wallet holds ' + ocDec(haveB, bdec) + ' cbBTC and this asks for ' + ocDec(vb, bdec) + '. Both sides go in together, so the smaller side is what caps the pool. Nothing was signed.', true);
                  return;
                }
                var alwP = ocUint(await ocEth('eth_call', [{ to: toks.peer, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(pool) }, 'latest']), 'the PEER allowance');
                var alwB = ocUint(await ocEth('eth_call', [{ to: toks.btc, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(pool) }, 'latest']), 'the cbBTC allowance');
                var need = (alwP < vp ? 1 : 0) + (alwB < vb ? 1 : 0) + 1;
                var step = 0;
                cSay('Every check passed. ' + need + ' signature' + (need === 1 ? '' : 's') + ' from here, and the wallet asks for each one in turn.' + (need < 3 ? ' An approval you gave earlier still stands, so it is not asked for again.' : ''));
                if (alwP < vp) {
                  step++;
                  cSay(step + ' of ' + need + ': approving PEER. This permits the pool to pull exactly ' + ocDec(vp, pdec) + ' PEER — that amount, once, and nothing else you hold. Confirm it in the wallet.');
                  await ocSend(toks.peer, OC_SEL.approve + ocAddr(pool) + ocWord(vp), 'Approving PEER', led,
                    'your approval of ' + ocFmt(vp, pdec) + ' PEER to the pool');
                  cSay(step + ' of ' + need + ': PEER approved, and confirmed on chain.');
                }
                if (alwB < vb) {
                  step++;
                  cSay(step + ' of ' + need + ': approving cbBTC. Exactly ' + ocDec(vb, bdec) + ' cbBTC — that amount, once, and nothing else. Confirm it in the wallet.');
                  await ocSend(toks.btc, OC_SEL.approve + ocAddr(pool) + ocWord(vb), 'Approving cbBTC', led,
                    'your approval of ' + ocFmt(vb, bdec) + ' cbBTC to the pool');
                  cSay(step + ' of ' + need + ': cbBTC approved, and confirmed on chain.');
                }
                // Asked again, on the line before the signature: has somebody
                // else opened it while these approvals were confirming? If
                // they have, this is no longer an opening deposit — it would
                // land in the proportional branch, at THEIR price, which is
                // the one thing this panel promises is not happening. Refuse
                // and send the reader to the panel that tells the truth.
                var fresh = await ocFresh(pool);
                if (fresh.ts > 0n) {
                  ocRefresh();
                  cSay('Somebody funded this pool while those approvals were confirming, so it now holds ' + ocFmt(fresh.rp, pdec) + ' PEER against ' + ocFmt(fresh.rb, bdec) + ' cbBTC. The opening price is no longer yours to set: a deposit now would be proportional at THEIR ratio, which is a different decision than the one you were making. Nothing was signed for it. The approvals above stand and are reused. This card is re-reading the pool now — add liquidity from the panel that appears, at a ratio you can see.', true);
                  return;
                }
                step++;
                cSay(step + ' of ' + need + ': opening the pool. This is the one that moves the coins — both amounts go in, the pool opens at the price above, and the shares are minted to this address.');
                // minShares is the opening share count minus the locked floor:
                // exactly what the seeding branch mints. If anything at all
                // has changed by the time this lands, it refuses rather than
                // filling at a number nobody read.
                await ocSend(pool, OC_SEL.add + ocWord(vp) + ocWord(vb) + ocWord(s0 - minLiq) + ocWord(await ocDeadline()), 'Opening the pool', led, 'opening the pool');
                cSay('Done. The pool is open on Base holding ' + ocDec(vp, pdec) + ' PEER against ' + ocDec(vb, bdec) + ' cbBTC, and that ratio is its price until somebody trades against it. ' + (s0 - minLiq).toString() + ' share units are yours and ' + minLiq.toString() + ' are locked forever at an address nobody can sign from.');
                cSay(OC_LAG + ' This card is being re-read now and once more when that window rolls — you do not have to reload the page.');
                ocTxRecord(led, 'Opening the pool');
                toast('The pool is open on Base.');
                ocRefresh();
              } catch (e) {
                // Never "it did not work". The ledger knows which legs landed,
                // which were broadcast and never seen again, and which never
                // went out at all — and an approval that landed cost gas and
                // still stands.
                cSay(led.sentence('Opening the pool stopped', e), true);
                ocTxRecord(led, 'Opening the pool — stopped');
                cSay('Press it again once that is dealt with: the free checks run again from the top, and an approval that already stands is reused rather than signed and paid for twice — that is a prompt your wallet simply will not show a second time.');
                toast('The pool did not open — what landed and what did not is written under the button.');
              } finally {
                cBusy = false;
                cBtn.disabled = false;
                cBtn.textContent = 'Open the pool on Base';
                cPeer.disabled = false;
                cBtc.disabled = false;
                cMaxP.disabled = false;
                cMaxB.disabled = false;
              }
            })();
          });

          box.appendChild(h('p', { class: 'eyebrow', style: 'margin:10px 0 0', text: 'the first add — one press, PEER against cbBTC' }));
          box.appendChild(h('div', { class: 'mini-form persistent' }, cPeer, cMaxP, cBtc, cMaxB));
          box.appendChild(cPrice);
          box.appendChild(h('div', { class: 'mini-form persistent' }, cBtn,
            h('span', { class: 'smallnote', text: 'Up to three signatures in one press: approve PEER, approve cbBTC, then the deposit itself. Each is named as your wallet asks for it, and everything that could refuse it is checked — for free — before the first one.' })));
          var dn2 = depthNote(0n);
          if (dn2) box.appendChild(dn2);
          box.appendChild(h('p', { class: 'smallnote', text: 'There is no name field and no pair to choose. Both sides were fixed in this contract’s immutables the day it was deployed — the PEER token on Base against cbBTC — so the two amounts are the only choices here, and they are the whole decision.' }));
          return box;
        }""",
    'the panels: the pool as it stands, and the first add',
)


# ── two headings that still counted pools ────────────────────────────────
once(
    r"""      h('h2', { text: 'This app’s pools, and Uniswap' }));""",
    r"""      h('h2', { text: 'This app’s pool, and Uniswap' }));""",
    'dexCard: the heading is singular',
)

once(
    r"""      if (!pids.length) pCard.appendChild(h('p', { class: 'smallnote', text: 'No pools in this log yet. The real ones \u2014 PEER against cbBTC, settling on Base \u2014 are in the card above. Anything opened here trades minted assets against each other and settles nothing outside this log.' }));""",
    r"""      if (!pids.length) pCard.appendChild(h('p', { class: 'smallnote', text: 'No pools in this log yet. The real one \u2014 PEER against cbBTC, settling on Base \u2014 is in the card above, and there is exactly one of it. Anything opened here trades minted assets against each other and settles nothing outside this log.' }));""",
    'the sandbox card: one real pool above it',
)


# ══ 10. The Economy rail's line about what is deployed ═══════════════════
# One of four lines saying which on-chain surfaces this host actually has, and
# the only one that named a factory. Same rule as everywhere else on that card:
# OFF is said in words, because a blank beside "the pool" reads like a balance.
once(
    r"""      var np = d.namedPools;
      line('the pools factory', np && !np.error ? np.factory : null,
        np && np.error ? 'The factory this host names did not read: ' + String(np.error)
          : 'No pools factory is configured, so there is no on-chain PEER/cbBTC pool here, no price to read, and the PEER door into reserve stays shut. Burning bitcoin needs no price and is unaffected.');""",
    r"""      var po = d.pool;
      line('the pool', po && po.configured !== false && !po.error ? po.address : null,
        po && po.error ? 'The pool this host names did not read: ' + String(po.error)
          : 'No pool is configured, so there is no on-chain PEER/cbBTC market here, no price to read, and the PEER door into reserve stays shut. Burning bitcoin needs no price and is unaffected.');""",
    'the Economy rail: the pool, not the factory',
)

# The last sentence in the card that still named a function this contract does
# not have. ocHave's comment earned its place by explaining why a free read
# comes before a signature; the example it reached for is gone.
once(
    r"""      // the user does not have is left behind. createPool already spends two
      // free reads to make its knowable refusals free; this is the third, and
      // it belongs to swapping and depositing just as much.""",
    r"""      // the user does not have is left behind. The opening deposit already
      // spends its refusals as free reads for the same reason; this is the
      // same rule applied to swapping and to every later deposit.""",
    'the card: ocHave stops naming createPool',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
