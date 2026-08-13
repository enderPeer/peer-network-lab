// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PeerPool — THE pool. One constant-product market over PEER/cbBTC, at one
 * address, with no name, no id, and no factory above it.
 *
 * The same shape as PeerToken and PeerPools: no owner, no admin, no pause, no
 * fee switch, no upgrade proxy, no privileged function of any kind. Anyone can
 * add liquidity, anyone can trade, and nothing in THIS contract can be turned
 * off, redirected, or skimmed by anybody — including whoever deployed it. Every
 * omitted knob is a key that cannot be lost, phished, or coerced, and on a
 * contract holding other people's PEER and bitcoin that is the only acceptable
 * number of keys.
 *
 * Read that sentence with its boundary, because the boundary is real: it is a
 * claim about this file, not about the pair. The cbBTC side belongs to
 * Coinbase's upgradeable proxy, and the paragraph on transfer behaviour below
 * says exactly what that costs — including that Coinbase can halt this pool
 * outright and that there is deliberately no lever here to answer it with.
 *
 * Both token addresses are fixed at deployment, immutable, and that is the
 * ENTIRE configuration. Not a factory, not a registry, not a list: one pool.
 *
 * ── WHAT THIS GIVES UP, AND WHAT IT BUYS ───────────────────────────────────
 * This supersedes PeerPools.sol, which held many pools distinguished by a
 * bytes32 name. Read that file for the design being replaced; the trade is
 * worth stating in both directions because it is a real trade.
 *
 * GIVEN UP: anybody opening their own market. Under PeerPools a stranger could
 * create a pool over the pair at a price of their own choosing, on their own
 * terms, and let the market arbitrage the difference. Here they cannot. If you
 * want a second PEER/BTC market you deploy your own contract and persuade
 * people to use it — which is exactly as available as it always was, and
 * exactly as much work as it should be. Liquidity fragmentation was the price
 * of that freedom; concentration is the price of taking it away.
 *
 * BOUGHT, four things, each of which cost real defensive code under the old
 * design and now cost none:
 *
 *   - No name to squat. Names were front-runnable on a public mempool, so
 *     PeerPools claimed them PER CREATOR, which meant a name identified
 *     nothing and every UI had to say whose pool it was or be lying by
 *     omission. There is no name here, so there is nothing to squat and
 *     nothing to disclaim.
 *   - No list to enumerate. Discovery over a growing array was CENSORABLE:
 *     open 256 dust pools and the honest one falls off the end of whatever a
 *     client was willing to scan. That forced a chunked, resumable eth_getLogs
 *     scan with a depth-ranked pre-filter. One address has no discovery
 *     problem — you either have the address or you do not.
 *   - No configuration deciding which pool counts. "Which is the official
 *     one?" was two environment variables (a factory plus a pool id) precisely
 *     because a name could not be trusted to answer it. The address IS the
 *     answer now, and an address that is wrong is wrong loudly rather than
 *     pointing at somebody else's dust.
 *   - One address that is either the pool or is not. No id to mistype into a
 *     different market, no second pool with the same label, no ambiguity for a
 *     block explorer reader to resolve.
 *
 * ── ANY OPENING SIZE, AND WHAT MIN_LIQ ACTUALLY REFUSES ────────────────────
 * The pool may be seeded arbitrarily small. This is a requirement, not a
 * tolerance: the first add can be whatever the first liquidity provider can
 * afford, and every later add makes the pool bigger.
 *
 * MIN_LIQ = 1000 is NOT a minimum investment and must never be read as one. It
 * is a floor on the SHARE COUNT, which is the geometric mean of the two raw
 * deposits — sqrt(amtPeer · amtBtc) — and PEER carries 18 decimals against
 * cbBTC's 8. In raw units, measured, with what the floor costs the seeder in
 * the last column, since the 1000 locked units are minted to address(0) and
 * every share is a pro-rata claim on both sides:
 *
 *     100k PEER + 10k satoshi -> 31,622,776,601,683 shares  0.000000003% locked
 *     1 PEER    +   1 satoshi ->      1,000,000,000 shares      0.0001% locked
 *     0.001 PEER+   1 satoshi ->         31,622,776 shares       0.003% locked
 *     10,000,000 wei + 1 sat  ->              3,162 shares         31.6% locked
 *     1,100,000 wei  + 1 sat  ->              1,048 shares         95.4% locked
 *     1 wei     +   1 satoshi ->                  1 share            refused
 *
 * So the floor permits arbitrarily small REAL amounts and refuses only the
 * degenerate one: a "pool" holding a single indivisible wei against a single
 * satoshi, which nobody could add to or trade against without every division
 * collapsing to zero.
 *
 * The cost is a FIXED 1000 share units, never a fraction, so the bottom of
 * that table is the whole of the bad news: negligible at every size anybody
 * would actually seed, and dominant only within a factor of a few of the floor
 * itself, where the seeder is donating most of a deposit worth a rounding
 * error to an address nobody can sign from. "Seed it as small as you like" is
 * true and this is its fine print — the app's first-add panel prints the
 * percentage live as the two amounts are typed, rather than printing 1000 as a
 * count with no denominator and letting it read as free.
 *
 * What the floor buys, since it costs nothing anyone would want to do: the
 * 1000 locked share units sit at address(0) forever, so totalShares can never
 * return to zero once the pool is open. "Forever" rests on two independent
 * facts, and it is worth knowing that it is not one: nobody can sign as
 * address(0), and — even if somebody could — remove() pays the PEER leg out
 * first and PeerToken refuses any transfer to the zero address, so the
 * withdrawal reverts on the token's own rule. That rule lives in this
 * repository and cannot change; it is not borrowed from cbBTC's upgradeable
 * proxy. Locking totalShares above zero makes the seeding branch in add() a
 * ONE-TIME branch. Without it, whoever removed the last share could re-seed
 * this address at a price of their own invention — the pool would still be
 * "the pool", at the same address people had bookmarked, with a brand new
 * opening price and no trace in its state that anything had happened. It is
 * also the standard guard (UniswapV2's own constant, kept) against the
 * first-depositor share-inflation attack: open with one share unit, donate
 * directly to the contract to skew the share price, and the next depositor's
 * shares round to zero while their coins stay. That attack has a second lock
 * on it here — see the donation paragraph below — but one lock is not a reason
 * to remove the other.
 *
 * ── A TINY POOL IS LEGITIMATE, AND ITS PRICE IS ONLY ITS LAST TRADE ────────
 * A pool seeded with a handful of satoshis is a real pool and this contract
 * treats it as one. What it is NOT is a price anyone should quote. The only
 * price here is the ratio of the reserves, which is whatever the last trade
 * left behind, and in a thin pool one ordinary trade moves that ratio a long
 * way: the constant-product curve does not care that the reserves are small,
 * it just charges the same proportional slippage on a much smaller base.
 *
 * The network's PEER-burn door already refuses to price against a pool below
 * 1,000,000 satoshis of depth, and that floor is not this contract's to relax.
 * A pool can legitimately exist far below it and still not be allowed to set
 * the burn price — those are two different questions, and the app says so in
 * words rather than quietly using whatever depth it finds.
 *
 * ── THE ARITHMETIC ─────────────────────────────────────────────────────────
 * UniswapV2's, on purpose, because it is also the in-log AMM's
 * (social/replay.cjs): x·y = k, a 0.3% fee that stays in the pool —
 * amtInWithFee = amtIn·997; out = resOut·amtInWithFee / (resIn·1000 +
 * amtInWithFee) — the integer-exact form of replay's `eff = amt * 0.997`. The
 * fee is how liquidity providers get paid: k grows on every swap and no
 * separate fee balance exists to administer or steal.
 *
 * Reserves are STORED accounting, not balanceOf() reads, and they credit the
 * amount REQUESTED, never the amount that actually landed. Say the assumption
 * out loud, because it is one: both tokens must move exactly what they are
 * told to move. PEER is this repo's own eighty-line ERC-20 and can never
 * change; cbBTC is an upgradeable Coinbase proxy, so its behaviour is
 * Coinbase's to change and this contract's to trust. If cbBTC ever started
 * taking a fee on transfer, this pool would credit more BTC than it received,
 * the stored reserve would sit above the real balance, and the last
 * withdrawals out would revert on the token's own balance check — the
 * shortfall landing on whoever leaves last instead of being shared, with every
 * swap price in between wrong too.
 *
 * The fix would be balance-delta accounting: read balanceOf before and after
 * each pull and credit the difference. It is not here on purpose. It costs two
 * extra external calls on every deposit leg and swaps a one-line invariant
 * ("reserves are what people put in") for a conditional one ("reserves are
 * whatever the token chose to hand over"), which is harder to check by reading
 * and buys nothing for a pair where neither token has ever taken a fee. If
 * cbBTC ever becomes fee-on-transfer it is a different asset than this
 * contract was written for, and the honest answer that day is a new pool
 * people migrate to with their eyes open — not a defensive branch here
 * pretending it was ready.
 *
 * THE SHARPER VERSION OF THE SAME DEPENDENCY: cbBTC's admin can stop this
 * pool. If transfers out of this address ever revert — a global pause, a
 * blacklist naming this contract — then remove() reverts, because it pays the
 * PEER leg and then the BTC leg and one call either does both or does neither;
 * swap() reverts in both directions; add() reverts. Liquidity providers cannot
 * withdraw even the PEER side, and the halt is imposed by an actor the top of
 * this file says does not exist. It does not exist HERE. It exists one token
 * over, and remove()'s two legs are what carry it across.
 *
 * There is deliberately no single-sided exit to answer that with. A function
 * that paid one leg when the other would not is a lever over other people's
 * money — who may pull it, at what price, in whose favour — and a lever is
 * precisely the thing every other line of this file refuses to have. The
 * honest position is that this contract is exactly as available as cbBTC is,
 * that this is knowable before you deposit rather than after, and that the
 * remedy for a frozen leg is the same as for a bad ratio: it is the ordinary
 * one anybody has, not a special one somebody holds.
 *
 * A donation sent straight to this address simply does not count. Nothing here
 * ever reads its own balance, so tokens pushed at the contract change no
 * price, mint no shares, and are not withdrawable by anyone: they are a gift
 * to nobody. That is the second lock on the inflation attack described above,
 * and it is worth knowing before you send anything here by hand.
 *
 * Rounding, everywhere it appears, favors the pool: minted shares round down,
 * amounts pulled in round up, amounts paid out round down. The dust this
 * strands is the pool's, i.e. every shareholder's pro rata — never a
 * particular caller's to extract.
 *
 * No imports on purpose, like everything else in this directory. The IERC20
 * below is declared locally, this file compiles standalone in Remix, and what
 * you deploy is exactly what you read here.
 *
 * Deploy: Remix -> Solidity 0.8.24 -> optimizer ON, 200 runs -> Base (8453).
 * Constructor: the PEER token address (0x5d63786095d09210011fd382c0710a7a1bc90e6f)
 * and cbBTC (0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf on Base).
 */

interface IERC20 {
    // Declared with `returns (bool)` and every call below is wrapped in a
    // require: a token that answers false must revert the whole act, never
    // leave the pool believing coins arrived that did not.
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract PeerPool {
    address public immutable peer;
    address public immutable btc;

    /**
     * Raw share units locked at address(0) when the pool is seeded. Read the
     * header before reading this as a minimum deposit — it is a floor on
     * sqrt(amtPeer · amtBtc), which 1 PEER against 1 satoshi clears by six
     * orders of magnitude.
     */
    uint256 public constant MIN_LIQ = 1000;

    /// Stored accounting, never balanceOf(). Read through reserves().
    uint256 private peerReserve;
    uint256 private btcReserve;
    uint256 private shareSupply;

    /// Holder => share units. Internal accounting, not a token: shares do not
    /// transfer, so there is nothing here to approve or phish.
    mapping(address => uint256) private shares;

    /**
     * There is no pool id any more, so the events are as simple as the thing
     * they describe: who acted, and what moved. `by` is indexed because
     * filtering by actor is the only filter left worth having.
     *
     * On the OPENING add, `minted` is what the caller received —
     * sqrt(amtPeer·amtBtc) minus the MIN_LIQ locked at address(0). The lock is
     * not a separate event because it happens exactly once and reserves()
     * reports the true total from the first block onward.
     */
    event Added(address indexed by, uint256 usedPeer, uint256 usedBtc, uint256 minted);
    event Removed(address indexed by, uint256 outPeer, uint256 outBtc, uint256 burned);
    event Swapped(address indexed by, bool sellPeer, uint256 amtIn, uint256 amtOut);

    /**
     * The reentrancy guard is one storage flag, checked and toggled by hand.
     * Neither PEER nor cbBTC has transfer hooks today, so nothing here can
     * currently re-enter — but "currently" is not an argument a contract gets
     * to make about the future, and the flag costs a few hundred gas to close
     * the question permanently.
     */
    uint256 private unlocked = 1;
    modifier nonReentrant() {
        require(unlocked == 1, "reentered");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(address peer_, address btc_) {
        require(peer_ != address(0) && btc_ != address(0), "token address is zero");
        require(peer_ != btc_, "the two tokens must differ");
        peer = peer_;
        btc = btc_;
    }

    /**
     * Add liquidity. Two behaviours in one function on purpose — there is no
     * separate "create", because there is nothing to create: this address is
     * the pool whether or not anybody has funded it yet.
     *
     * THE FIRST add SEEDS THE POOL. With no reserves there is no ratio, so the
     * two amounts you deposit ARE the opening price — a number of the seeder's
     * own invention, exactly as DEPLOY.md says of the Uniswap pool. Shares
     * minted: sqrt(amtPeer·amtBtc), the geometric mean, so the initial share
     * count does not depend on which side you call PEER. MIN_LIQ of them are
     * locked at address(0) forever and the rest are yours; the return value
     * and the event report YOUR shares, so totalShares is minted + MIN_LIQ for
     * this one call and exactly minted for every call after it. Seed it as
     * small as you like — see the header for what the floor actually refuses.
     *
     * EVERY LATER add IS PROPORTIONAL at the current ratio. Like replay.cjs
     * poolAdd, the binding side is the smaller of the two offers measured in
     * shares: you state ceilings, the pool computes the largest proportional
     * deposit that fits under both, and pulls ONLY those used amounts — the
     * excess side never leaves your wallet, so there is nothing to refund and
     * no refund path to get wrong.
     *
     * minted rounds DOWN and the pulled amounts round UP, so each rounding
     * favors the pool. Neither ceiling can be exceeded by the round-up:
     * minted <= amt·t/res on both sides (that is what min enforces), so
     * ceil(minted·res/t) <= ceil(amt) = amt, both sides being integers.
     *
     * minShares is your guard against being sandwiched: a swap landing just
     * ahead of you moves the ratio, which changes WHICH side binds and can
     * mint you fewer shares for the same coins. Requiring minted >= minShares
     * turns that from a surprise into a revert.
     *
     * THE SEEDING CALL IS THE ONE WHERE THIS NUMBER MATTERS MOST, which is the
     * opposite of how it looks. Under a factory a pool was CREATED by the
     * transaction that opened it, so there was a moment nobody could see; here
     * the contract exists at a PUBLISHED address before it holds anything —
     * the runbook has the operator curl reserves() at it, and the app renders
     * it to every visitor — and the seeding branch runs ONCE, EVER, with no
     * second pool to arbitrage against. Whoever gets there first sets the only
     * price this network will ever have, permanently.
     *
     * The theft, in the numbers it actually costs. A stranger seeds 1,100,000
     * wei of PEER against 1 satoshi: sqrt = 1048, one unit clear of the floor,
     * a price of a trillion PEER to the bitcoin. The intended opening deposit
     * — say 100,000 PEER against 10,000 satoshis — then lands in the
     * PROPORTIONAL branch, where the BTC side binds: it mints 10,480,000
     * shares, pulls all 10,000 satoshis and just 11,000,000,000 wei of PEER,
     * and SUCCEEDS. One swap of 1,100,000,000,000 wei of PEER takes 9,901 of
     * those satoshis straight back out.
     *
     * minShares = 0 is the whole of what let that through: with no minimum
     * named, any share count is acceptable — including 10,480,000, which is
     * six orders of magnitude under what those same two amounts mint on an
     * unseeded pool. And note WHERE the right minimum has to come from,
     * because it is not where a proportional add gets its one: a caller who
     * intends to seed has no reserves to quote against, so a number read off
     * the pool is either unavailable or already the front-runner's. It has to
     * be computed from the caller's own two amounts.
     *
     * The value that DOES catch it is exact, and is what both of this repo's
     * own screens send: sqrt(amtPeer · amtBtc) - MIN_LIQ, which is precisely
     * what the seeding branch below mints. The proportional branch can never
     * reach it — for a pool already at some ratio, the same two amounts mint
     * sqrt(amtPeer · amtBtc) · min(r, 1/r) where r is how far that ratio is
     * from the one you named — so the call reverts unless the pool is still
     * unseeded, or somebody seeded it at your ratio to within MIN_LIQ/s0 (three
     * parts in a hundred billion, for the deposit above), at which point they
     * have taken nothing. On the seeding call that is the only correct value.
     * Never 0.
     *
     * 0 means no guard at all, and it is a choice rather than a default: it is
     * defensible on a small proportional top-up at a ratio you have just read
     * and do not mind moving under you. It is careless anywhere else and it is
     * wrong on the first add.
     *
     * deadline is the other half: a signed transaction can sit in the mempool
     * (or in a builder's pocket) until the price it was computed against is
     * history, and this refuses to execute after the second you name. Passing
     * a far-future deadline opts out of that protection knowingly; the
     * contract cannot tell a deliberate forever from a careless one and does
     * not try to guess. It is checked on the seeding call too, where no other
     * transaction could have moved anything — one rule, no exception to
     * remember.
     */
    function add(uint256 amtPeer, uint256 amtBtc, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        returns (uint256 minted)
    {
        require(block.timestamp <= deadline, "too late");
        require(amtPeer > 0 && amtBtc > 0, "both amounts must be positive");
        uint256 t = shareSupply;
        uint256 usedPeer;
        uint256 usedBtc;
        if (t == 0) {
            // Seeding. This branch can run exactly once in the life of the
            // contract: MIN_LIQ is locked at address(0), an address nobody can
            // call from, so shareSupply never comes back to zero.
            uint256 s0 = _sqrt(amtPeer * amtBtc);
            // Strictly greater: the seeder must end up holding at least one
            // share unit, or the pool would open belonging to nobody.
            require(s0 > MIN_LIQ, "opening deposit too small");
            usedPeer = amtPeer;
            usedBtc = amtBtc;
            minted = s0 - MIN_LIQ;
            shares[address(0)] = MIN_LIQ;
            shareSupply = s0;
        } else {
            minted = _min((amtPeer * t) / peerReserve, (amtBtc * t) / btcReserve);
            require(minted > 0, "deposit too small to mint a share");
            usedPeer = _ceilDiv(minted * peerReserve, t);
            usedBtc = _ceilDiv(minted * btcReserve, t);
            shareSupply = t + minted;
        }
        require(minted >= minShares, "fewer shares than your minimum - the ratio moved");
        peerReserve += usedPeer;
        btcReserve += usedBtc;
        shares[msg.sender] += minted;
        _pull(peer, usedPeer);
        _pull(btc, usedBtc);
        emit Added(msg.sender, usedPeer, usedBtc, minted);
    }

    /**
     * Burn shares, receive the proportional slice of both reserves, rounded
     * down. shareSupply can never reach zero once the pool is seeded — the
     * MIN_LIQ at address(0) is unremovable because nobody can call from
     * address(0) — so the division below cannot divide by zero and the pool
     * never closes, only thins.
     *
     * minPeer and minBtc are the withdrawal-side guard. Your slice is
     * proportional whatever happens, but a swap landing ahead of you changes
     * what that slice is MADE OF — more of the side someone just sold in, less
     * of the side they bought out — so a withdrawal aimed at a particular coin
     * can be sandwiched into the other one. Say what you will accept on each
     * side; 0 on a side means no guard there.
     *
     * No deadline parameter here, deliberately, though add and swap have one.
     * A late removal is not priced: it pays your pro-rata slice of whatever
     * the reserves are, and these two minimums already describe the only
     * outcome you could object to. A third number to get wrong would buy
     * protection the two already give.
     */
    function remove(uint256 shareAmt, uint256 minPeer, uint256 minBtc)
        external
        nonReentrant
        returns (uint256 outPeer, uint256 outBtc)
    {
        require(shareAmt > 0, "shares to remove must be positive");
        uint256 held = shares[msg.sender];
        require(held >= shareAmt, "more shares than you hold");
        uint256 t = shareSupply;
        outPeer = (shareAmt * peerReserve) / t;
        outBtc = (shareAmt * btcReserve) / t;
        require(outPeer >= minPeer && outBtc >= minBtc, "below your minimum - the pool moved");
        shares[msg.sender] = held - shareAmt;
        shareSupply = t - shareAmt;
        peerReserve -= outPeer;
        btcReserve -= outBtc;
        _push(peer, outPeer);
        _push(btc, outBtc);
        emit Removed(msg.sender, outPeer, outBtc, shareAmt);
    }

    /**
     * Constant-product swap, UniswapV2 integer arithmetic, 0.3% fee staying in
     * the pool. This is byte-for-byte the formula the in-log AMM applies
     * (replay.cjs: eff = amt·0.997; out = rout·eff/(rin+eff)) with the
     * division deferred so integers never lose the fee to truncation.
     *
     * minOut is the caller's own price protection against being reordered
     * behind another trade; the contract has no oracle and wants none — the
     * only price it knows is its reserves, and in a thin pool that price is
     * whatever the last trade left. amtOut is strictly less than resOut by
     * construction (the fraction is < 1), so a swap can thin a reserve but
     * never empty it.
     *
     * deadline covers what minOut cannot. minOut says "not at a worse price
     * than this"; it says nothing about WHEN, so a transaction held back and
     * replayed hours later still executes if the price happens to be inside
     * the bound — at a moment you no longer wanted to trade at all. Naming a
     * second past which the trade is void is the caller's own clock. A
     * far-future deadline opts out of it knowingly.
     */
    function swap(bool sellPeer, uint256 amtIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 amtOut)
    {
        require(block.timestamp <= deadline, "too late");
        require(shareSupply > 0, "nobody has seeded this pool yet");
        require(amtIn > 0, "amount in must be positive");
        (uint256 resIn, uint256 resOut) = sellPeer ? (peerReserve, btcReserve) : (btcReserve, peerReserve);
        uint256 amtInWithFee = amtIn * 997;
        amtOut = (resOut * amtInWithFee) / (resIn * 1000 + amtInWithFee);
        require(amtOut > 0, "too small a trade to buy anything");
        require(amtOut >= minOut, "below your minimum - the price moved");
        if (sellPeer) {
            peerReserve += amtIn;
            btcReserve -= amtOut;
            _pull(peer, amtIn);
            _push(btc, amtOut);
        } else {
            btcReserve += amtIn;
            peerReserve -= amtOut;
            _pull(btc, amtIn);
            _push(peer, amtOut);
        }
        emit Swapped(msg.sender, sellPeer, amtIn, amtOut);
    }

    /**
     * THREE static words, in this order and no other:
     *
     *   word 0  resPeer       uint256
     *   word 1  resBtc        uint256
     *   word 2  totalShares   uint256
     *
     * so a reader with curl and no ABI library can decode it by cutting the
     * hex into 32-byte slices — the same standard onchain.mjs holds itself to,
     * which is exactly why the order is written down here: the JS side
     * hand-decodes by offset and nothing but this comment tells it where to
     * cut. A selector is keccak of the name and the INPUT types only, so
     * anything added later goes on the END, where it cannot move an offset a
     * reader already hardcoded.
     *
     * All zeros means the pool has never been seeded — which is a real state,
     * not an error, and the only state from which add() sets an opening price.
     */
    function reserves() external view returns (uint256 resPeer, uint256 resBtc, uint256 totalShares) {
        return (peerReserve, btcReserve, shareSupply);
    }

    function sharesOf(address who) external view returns (uint256) {
        return shares[who];
    }

    function _pull(address token, uint256 amount) internal {
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "token transfer in failed");
    }

    function _push(address token, uint256 amount) internal {
        require(IERC20(token).transfer(msg.sender, amount), "token transfer out failed");
    }

    /// Babylonian integer square root — UniswapV2's own, rounding down.
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// a/b rounded up; the zero case is spelled out so a==0 cannot underflow.
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
