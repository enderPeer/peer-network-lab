// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * SUPERSEDED by PeerPool.sol — singular. Read that file first; this one is
 * kept in the tree so the contract already on Base can be read against the
 * source it was compiled from, not so it can be deployed again.
 *
 * WHAT REPLACED IT AND WHY. The network runs ONE official pool now: one
 * address, no name, no id, no factory, anybody may add liquidity to it and
 * every add makes it bigger. Everything below about per-creator names, the
 * front-running they were namespaced to survive, and enumerating a growing
 * array of pools exists to solve problems that a single address does not have.
 * That is the whole argument for the change — the defensive machinery was
 * correct, and it was correct about a design that has been withdrawn.
 *
 * THE DEPLOYED ADDRESS IS DEAD. A PeerPools was deployed once at
 * 0x5112b892cf190d583f1acc86224812a8fad257ee on Base and it is broken beyond
 * use: its immutable `peer` was set to the operator's wallet address rather
 * than to the PEER token, so every pull from the PEER side calls transferFrom
 * on an account with no code. Nothing in this repository points at it, no pool
 * was ever opened in it, and no funds are in it. If you found it on a block
 * explorer, that is what it is; do not send anything to it.
 *
 * ONE CONSEQUENCE OF THIS HEADER, SAID PLAINLY. solc appends a hash of the
 * source to the bytecode it emits, so adding these paragraphs changed the last
 * 43 bytes of PeerPools.build.json — code, ABI and selectors all byte-identical,
 * metadata digest not. A source-verification of the dead address above against
 * this file will therefore MISMATCH, and that is the trade taken knowingly: the
 * artifact in this tree is kept reproducible from the source in this tree
 * (rerun build-pools.js and diff), rather than frozen to match a deployment
 * that is broken, empty, and referenced by nothing. To reproduce the deployed
 * bytecode exactly, compile this file with the header above removed.
 *
 * PeerPools — named constant-product pools for exactly one pair: PEER/BTC.
 *
 * The same shape as PeerToken: no owner, no admin, no pause, no fee switch,
 * no upgrade proxy, no privileged function of any kind. Anyone can open a
 * pool, anyone can trade against one, and nothing this contract does can be
 * turned off, redirected, or skimmed by anybody — including whoever deployed
 * it. Every omitted knob is a key that cannot be lost, phished, or coerced,
 * and on a contract holding other people's PEER and bitcoin that is the only
 * acceptable number of keys.
 *
 * Both token addresses are fixed at deployment, immutable, and that is the
 * entire configuration. This is not a general factory for arbitrary pairs:
 * the network trades PEER against BTC and nothing else, so the contract
 * refuses to be more general than the network is. What varies is the NAME.
 * Pools are named — a bytes32 — and several pools over the same pair under
 * different names is deliberate, not an oversight. The user chose named
 * pools: a name is a place you can point at ("trade in `main`", "the
 * burn-club pool"), and the price of that is liquidity fragmentation, which
 * is accepted with eyes open. Arbitrage between same-pair pools is anyone's
 * to take; the contract does not try to prevent a thing that is not wrong.
 *
 * A name is claimed PER CREATOR, never globally: your `main` and someone
 * else's `main` are two pools and both are allowed. The id is the identity,
 * the creator is the provenance, and the name is a label — see `taken`
 * below for why a global namespace on a public mempool is a gift to whoever
 * pays the higher priority fee.
 *
 * The arithmetic is UniswapV2's, on purpose, because it is also the in-log
 * AMM's (social/replay.cjs): x·y = k, a 0.3% fee that stays in the pool —
 * amtInWithFee = amtIn·997; out = resOut·amtInWithFee / (resIn·1000 +
 * amtInWithFee) — which is the integer-exact form of replay's
 * `eff = amt * 0.997`. The fee is how liquidity providers get paid: k grows
 * on every swap and no separate fee balance exists to administer or steal.
 * Initial shares are sqrt(amtPeer·amtBtc), of which MIN_LIQ = 1000 raw share
 * units are locked forever at address(0). That is UniswapV2's guard against
 * the first-depositor inflation attack (deposit dust, donate to skew the
 * share price, rob the next depositor by rounding); shares here are internal
 * accounting rather than a token, so parking them at address(0) — an address
 * nobody can call from — is exactly as final as burning.
 *
 * Reserves are STORED accounting, not balanceOf() reads, and they credit
 * the amount REQUESTED, never the amount that actually landed. Say the
 * assumption out loud, because it is one: both tokens must move exactly
 * what they are told to move. PEER is this repo's own eighty-line ERC-20
 * and can never change; cbBTC is an upgradeable Coinbase proxy, so its
 * behaviour is Coinbase's to change and this contract's to trust. If cbBTC
 * ever started taking a fee on transfer, every pool here would credit more
 * BTC than it received, the stored reserve would sit above the real
 * balance, and the last withdrawals out would revert on the token's own
 * balance check — the shortfall lands on whoever leaves last instead of
 * being shared, and no swap price in between would be right either.
 *
 * The fix would be balance-delta accounting: read balanceOf before and
 * after each pull and credit the difference. It is not here on purpose. It
 * costs two extra external calls on every deposit leg, and it swaps a
 * one-line invariant ("reserves are what people put in") for a conditional
 * one ("reserves are whatever the token chose to hand over"), which is
 * harder to check by reading and buys nothing for a pair where neither
 * token has ever taken a fee. If cbBTC ever becomes fee-on-transfer it is
 * a different asset than this contract was written for, and the honest
 * answer that day is a new pools contract people migrate to with their eyes
 * open — not a defensive branch here pretending it was ready.
 *
 * A donation sent straight to this contract simply does not count, instead
 * of silently repricing a pool. Rounding, everywhere it appears, favors the
 * pool: minted shares round down, amounts pulled in round up, amounts paid
 * out round down. The dust this strands is the pool's, i.e. every
 * shareholder's pro rata — never a particular caller's to extract.
 *
 * No imports on purpose, like everything else in this directory. The IERC20
 * below is declared locally, this file compiles standalone in Remix, and
 * what you deploy is exactly what you read here.
 *
 * Deploy: Remix -> Solidity 0.8.24 -> optimizer ON, 200 runs -> Base (8453).
 * Constructor: the PEER token address and the cbBTC address
 * (0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf on Base).
 */

interface IERC20 {
    // Declared with `returns (bool)` and every call below is wrapped in a
    // require: a token that answers false must revert the whole act, never
    // leave a pool believing coins arrived that did not.
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract PeerPools {
    address public immutable peer;
    address public immutable btc;

    /**
     * Raw share units locked at address(0) when a pool opens. Small enough
     * to be worthless (1000 units of an 18-decimal-scale quantity), large
     * enough that inflating the share price to attack-worthy levels costs
     * more than the attack earns — UniswapV2's own constant, kept.
     */
    uint256 public constant MIN_LIQ = 1000;

    struct Pool {
        bytes32 name;
        uint256 resPeer;
        uint256 resBtc;
        uint256 totalShares;
        /// Who opened it. Written once, never writable again: there is no
        /// transfer, no rename, no admin. It exists so a UI can say WHOSE
        /// pool this is, which is the only thing that disambiguates two
        /// pools sharing a name.
        address creator;
    }

    Pool[] private pools;

    /**
     * Names are claimed PER CREATOR: creator => name => used. You cannot
     * open two of your own pools called `main`, and that is the entire rule.
     *
     * A global first-come namespace was the obvious design and it is the
     * wrong one on a chain with a public mempool. Anyone watching the
     * operator broadcast createPool("main", <real amounts>) could copy the
     * name into their own transaction, pay a higher priority fee, land
     * first, and the honest transaction would revert on a name that now
     * belonged — permanently, with no reclaim path this contract is willing
     * to grow — to a pool holding dust. The attack costs a fee and buys a
     * word. Namespacing by creator makes it buy nothing: claiming `main`
     * takes `main` away from nobody.
     *
     * The deliberate consequence, stated plainly: two DIFFERENT creators can
     * both have a pool called `main`. A name is a LABEL and never an
     * identifier. The id identifies; the creator (returned by poolInfo) is
     * the provenance; a UI that shows a bare name without saying whose it is
     * is lying by omission. This contract does not pretend a name confers
     * trust, because the only way to make it confer trust would be to hand
     * somebody the power to arbitrate names — the one thing nothing here has.
     *
     * Within one creator a name is still claimed forever, even after the
     * pool is drained to its locked MIN_LIQ: reusing your own dead name
     * would let a pool people point at quietly change referent.
     */
    mapping(address => mapping(bytes32 => bool)) public taken;

    /// Pool id => holder => share units. Internal accounting, not a token:
    /// shares do not transfer, so there is nothing here to approve or phish.
    mapping(uint256 => mapping(address => uint256)) private shares;

    event PoolCreated(uint256 indexed id, bytes32 name, address indexed by, uint256 amtPeer, uint256 amtBtc);
    event LiquidityAdded(uint256 indexed id, address indexed by, uint256 usedPeer, uint256 usedBtc, uint256 minted);
    event LiquidityRemoved(uint256 indexed id, address indexed by, uint256 outPeer, uint256 outBtc, uint256 shareAmt);
    event Swapped(uint256 indexed id, address indexed by, bool sellPeer, uint256 amtIn, uint256 amtOut);

    /**
     * The reentrancy guard is one storage flag, checked and toggled by hand.
     * Neither PEER nor cbBTC has transfer hooks today, so nothing here can
     * currently re-enter — but "currently" is not an argument a contract
     * gets to make about the future, and the flag costs a few hundred gas
     * to close the question permanently.
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
     * Open a named pool and seed both sides. The deposit ratio IS the
     * opening price — with no market yet, that number is the creator's
     * invention, exactly as DEPLOY.md says of the Uniswap pool. Shares
     * minted: sqrt(amtPeer·amtBtc), the geometric mean, so the initial
     * share count is independent of which side you call PEER — MIN_LIQ of
     * them locked at address(0), the rest to the creator.
     *
     * No deadline parameter here, unlike swap and addLiquidity: the opening
     * ratio is the creator's own invention and no other transaction can
     * move it, so a createPool that sits in the mempool and lands an hour
     * late opens exactly the pool that was signed for.
     */
    function createPool(bytes32 name, uint256 amtPeer, uint256 amtBtc) external nonReentrant returns (uint256 id) {
        require(name != bytes32(0), "a pool needs a name");
        require(!taken[msg.sender][name], "you already have a pool with that name");
        require(amtPeer > 0 && amtBtc > 0, "both starting amounts must be positive");
        uint256 s0 = _sqrt(amtPeer * amtBtc);
        // Strictly greater: the creator must end up holding at least one
        // share unit, or the pool would open belonging to nobody.
        require(s0 > MIN_LIQ, "starting liquidity too small");
        taken[msg.sender][name] = true;
        id = pools.length;
        pools.push(Pool({name: name, resPeer: amtPeer, resBtc: amtBtc, totalShares: s0, creator: msg.sender}));
        shares[id][address(0)] = MIN_LIQ;
        shares[id][msg.sender] = s0 - MIN_LIQ;
        _pull(peer, amtPeer);
        _pull(btc, amtBtc);
        emit PoolCreated(id, name, msg.sender, amtPeer, amtBtc);
    }

    /**
     * Add liquidity at the pool's current ratio. Like replay.cjs poolAdd,
     * the binding side is the smaller of the two offers measured in shares:
     * you state ceilings, the pool computes the largest proportional deposit
     * that fits under both, and pulls ONLY those used amounts — the excess
     * side never leaves your wallet, so there is nothing to refund and no
     * refund path to get wrong.
     *
     * minted rounds DOWN and the pulled amounts round UP, so each rounding
     * favors the pool. Neither ceiling can be exceeded by the round-up:
     * minted <= amt·t/res on both sides (that is what min enforces), so
     * ceil(minted·res/t) <= ceil(amt) = amt, both sides being integers.
     *
     * minShares is your guard against being sandwiched: a swap landing just
     * ahead of you moves the ratio, which changes WHICH side binds and can
     * mint you fewer shares for the same coins. Requiring minted >=
     * minShares turns that from a surprise into a revert. 0 means no guard —
     * fine when you are the only one who can see the pool yet, careless
     * anywhere else.
     *
     * deadline is the other half: a signed transaction can sit in the
     * mempool (or in a builder's pocket) until the price it was computed
     * against is history, and this refuses to execute after the second you
     * name. Passing a far-future deadline opts out of that protection
     * knowingly; the contract cannot tell a deliberate forever from a
     * careless one and does not try to guess.
     */
    function addLiquidity(uint256 id, uint256 amtPeer, uint256 amtBtc, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        returns (uint256 minted)
    {
        require(block.timestamp <= deadline, "too late");
        Pool storage p = _pool(id);
        require(amtPeer > 0 && amtBtc > 0, "both amounts must be positive");
        uint256 t = p.totalShares;
        uint256 byPeer = (amtPeer * t) / p.resPeer;
        uint256 byBtc = (amtBtc * t) / p.resBtc;
        minted = byPeer < byBtc ? byPeer : byBtc;
        require(minted > 0, "deposit too small to mint a share");
        require(minted >= minShares, "fewer shares than your minimum - the ratio moved");
        uint256 usedPeer = _ceilDiv(minted * p.resPeer, t);
        uint256 usedBtc = _ceilDiv(minted * p.resBtc, t);
        p.resPeer += usedPeer;
        p.resBtc += usedBtc;
        p.totalShares = t + minted;
        shares[id][msg.sender] += minted;
        _pull(peer, usedPeer);
        _pull(btc, usedBtc);
        emit LiquidityAdded(id, msg.sender, usedPeer, usedBtc, minted);
    }

    /**
     * Burn shares, receive the proportional slice of both reserves, rounded
     * down. totalShares can never reach zero — the MIN_LIQ at address(0) is
     * unremovable because nobody can call from address(0) — so the division
     * below cannot divide by zero and a pool never closes, only thins.
     *
     * minPeer and minBtc are the withdrawal-side guard. Your slice is
     * proportional whatever happens, but a swap landing ahead of you changes
     * what that slice is MADE OF — more of the side someone just sold in,
     * less of the side they bought out — so a withdrawal aimed at a
     * particular coin can be sandwiched into the other one. Say what you
     * will accept on each side; 0 on a side means no guard there.
     *
     * No deadline parameter here, deliberately, though swap and addLiquidity
     * have one. A late removal is not priced: it pays your pro-rata slice of
     * whatever the reserves are, and these two minimums already describe the
     * only outcome you could object to. A third number to get wrong would
     * buy protection the two already give.
     */
    function removeLiquidity(uint256 id, uint256 shareAmt, uint256 minPeer, uint256 minBtc)
        external
        nonReentrant
        returns (uint256 outPeer, uint256 outBtc)
    {
        Pool storage p = _pool(id);
        require(shareAmt > 0, "shares to remove must be positive");
        uint256 held = shares[id][msg.sender];
        require(held >= shareAmt, "more shares than you hold");
        uint256 t = p.totalShares;
        outPeer = (shareAmt * p.resPeer) / t;
        outBtc = (shareAmt * p.resBtc) / t;
        require(outPeer >= minPeer && outBtc >= minBtc, "below your minimum - the pool moved");
        shares[id][msg.sender] = held - shareAmt;
        p.totalShares = t - shareAmt;
        p.resPeer -= outPeer;
        p.resBtc -= outBtc;
        _push(peer, outPeer);
        _push(btc, outBtc);
        emit LiquidityRemoved(id, msg.sender, outPeer, outBtc, shareAmt);
    }

    /**
     * Constant-product swap, UniswapV2 integer arithmetic, 0.3% fee staying
     * in the pool. This is byte-for-byte the formula the in-log AMM applies
     * (replay.cjs: eff = amt·0.997; out = rout·eff/(rin+eff)) with the
     * division deferred so integers never lose the fee to truncation.
     *
     * minOut is the caller's own price protection against being reordered
     * behind another trade; the contract has no oracle and wants none — the
     * only price it knows is its reserves. amtOut is strictly less than
     * resOut by construction (the fraction is < 1), so a swap can thin a
     * reserve but never empty it.
     *
     * deadline covers what minOut cannot. minOut says "not at a worse price
     * than this"; it says nothing about WHEN, so a transaction held back and
     * replayed hours later still executes if the price happens to be inside
     * the bound — at a moment you no longer wanted to trade at all. Naming
     * a second past which the trade is void is the caller's own clock. A
     * far-future deadline opts out of it knowingly.
     */
    function swap(uint256 id, bool sellPeer, uint256 amtIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 amtOut)
    {
        require(block.timestamp <= deadline, "too late");
        Pool storage p = _pool(id);
        require(amtIn > 0, "amount in must be positive");
        (uint256 resIn, uint256 resOut) = sellPeer ? (p.resPeer, p.resBtc) : (p.resBtc, p.resPeer);
        uint256 amtInWithFee = amtIn * 997;
        amtOut = (resOut * amtInWithFee) / (resIn * 1000 + amtInWithFee);
        require(amtOut > 0, "too small a trade to buy anything");
        require(amtOut >= minOut, "below your minimum - the price moved");
        if (sellPeer) {
            p.resPeer += amtIn;
            p.resBtc -= amtOut;
            _pull(peer, amtIn);
            _push(btc, amtOut);
        } else {
            p.resBtc += amtIn;
            p.resPeer -= amtOut;
            _pull(btc, amtIn);
            _push(peer, amtOut);
        }
        emit Swapped(id, msg.sender, sellPeer, amtIn, amtOut);
    }

    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    /**
     * FIVE static words, in this order and no other:
     *
     *   word 0  name          bytes32
     *   word 1  resPeer       uint256
     *   word 2  resBtc        uint256
     *   word 3  totalShares   uint256
     *   word 4  creator       address, left-padded into the low 20 bytes
     *
     * so a reader with curl and no ABI library can decode it by cutting the
     * hex into 32-byte slices — the same standard onchain.mjs holds itself
     * to, which is exactly why the order is written down here: the JS side
     * hand-decodes by offset and nothing but this comment tells it where to
     * cut. creator is LAST on purpose. A selector is keccak of the name and
     * the INPUT types only, so poolInfo(uint256) keeps the selector it
     * always had while the answer grows by a word, and every offset a
     * reader already hardcoded still points at the same field. Anything
     * added later goes on the end for the same reason.
     */
    function poolInfo(uint256 id)
        external
        view
        returns (bytes32 name, uint256 resPeer, uint256 resBtc, uint256 totalShares, address creator)
    {
        Pool storage p = _pool(id);
        return (p.name, p.resPeer, p.resBtc, p.totalShares, p.creator);
    }

    function sharesOf(uint256 id, address who) external view returns (uint256) {
        return shares[id][who];
    }

    function _pool(uint256 id) internal view returns (Pool storage) {
        require(id < pools.length, "no such pool");
        return pools[id];
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

    /// a/b rounded up; the zero case is spelled out so a==0 cannot underflow.
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
