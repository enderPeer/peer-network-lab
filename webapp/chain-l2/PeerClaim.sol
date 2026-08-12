// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PeerClaim — epoch earnings, paid on-chain, out of PEER that already exists.
 *
 * The network closes an epoch and distributes an epoch token by engagement
 * weight (social/replay.cjs, tokenDist). Until now that number lived only in
 * the act log: replayable, checkable, and worth exactly nothing to anybody who
 * had not agreed in advance to care about the log. This contract is the other
 * half — the epoch's distribution, published as a merkle root, claimable as
 * the real ERC-20 on Base.
 *
 * WHERE THE PEER COMES FROM, because this is the question the whole design
 * turns on: PeerToken.sol has no mint function and no owner, so the supply is
 * fixed forever and NOTHING here can create a token. Every PEER this contract
 * ever pays out was pulled from the steward's own holdings when the epoch was
 * opened. "Epoch earnings" on-chain therefore means a transfer out of one
 * existing pile, never an issuance — and if the steward stops funding epochs,
 * epochs stop being claimable, which is an honest failure mode with no hidden
 * inflation underneath it.
 *
 * ── THE STEWARD ────────────────────────────────────────────────────────────
 * This is the first privileged role anywhere in this codebase, and it is not
 * going to be smuggled past a reader in a modifier. Stated exactly:
 *
 * The steward CAN
 *   - open an epoch: publish a root, a total, and a claim deadline, once per
 *     epoch number, and thereby direct PEER THAT THE STEWARD THEMSELVES just
 *     deposited into this contract to whichever addresses that root commits to;
 *   - publish a root whose leaves OVERSUM the deposit. Nothing on-chain has
 *     the tree, only its root, so this contract cannot add the leaves up and
 *     does not pretend to. Such an epoch pays first-come and then reverts for
 *     everyone after the deposit runs out — including, at the sharp end, by
 *     the steward putting an address they control in the root and claiming it
 *     first, which is a complete one-transaction censoring of that epoch's
 *     other claimants. It is bounded to that epoch's own deposit (see the
 *     arithmetic note far below) and it is checkable off-chain BEFORE the
 *     first claim: the leaf list is published beside the root, so a stranger
 *     can sum it against `total` and see an oversum coming rather than
 *     discovering it when their claim reverts. That check is the guarantee.
 *     It lives outside this contract because it cannot live inside one;
 *   - reclaim, after the deadline, whatever nobody claimed (sweep) — which is
 *     the same PEER they deposited, minus what was paid out.
 *
 * The steward CANNOT
 *   - mint anything. There is no mint. The token cannot grow.
 *   - touch any balance outside this contract, or any epoch's deposit other
 *     than through the root that epoch was opened with.
 *   - take back a claim already made. Paid is paid, in the same transaction.
 *   - alter, replace, or re-open a root already published. openEpoch reverts
 *     on an epoch number that exists, and there is no setter anywhere.
 *   - reach into an OPEN epoch to stop one claimant. There is no pause, no
 *     allowlist and no per-claimant switch, so once a root is published there
 *     is no lever here to point at a particular address. Everything the
 *     steward decides about who gets paid, they decide in the root — which is
 *     the bullet above, and it is a bullet in the CAN list on purpose.
 *   - sweep early, or open an epoch that is over almost as soon as it starts.
 *     Before the deadline sweep reverts for everyone including the steward,
 *     and openEpoch refuses a deadline less than MIN_WINDOW away, so "before
 *     the deadline" is a span this contract fixes rather than one the steward
 *     picks freely. Without that floor the bullet would have been empty: a
 *     deadline of now+1 passed the old check, and the next Base block could
 *     sweep the deposit straight back.
 *
 * EXPOSURE IS BOUNDED BY WHAT WAS ACTUALLY DEPOSITED. openEpoch pulls the
 * whole total up front with transferFrom rather than trusting a transfer to
 * arrive later, so an epoch is either fully funded from the first second or it
 * does not exist. What that does NOT promise, because the paragraph above says
 * otherwise and the two must not contradict each other: it does not promise
 * that the deposit covers the tree. `total` is the steward's number, the tree
 * is the steward's tree, and this contract compares them only as claims arrive.
 *
 * WHY THE ROLE IS UNAVOIDABLE. A contract that pays out must have something
 * deciding who is owed what. If publishing a root were open to anyone, the
 * first passer-by would publish a root paying themselves the entire deposit —
 * so "no privileged role" here does not mean "more decentralised", it means
 * "the money goes to whoever is quickest". The alternative designs all move
 * the trust rather than remove it: an oracle committee is a steward with more
 * keys, an on-chain replay of the act log is a rewrite of the whole engine in
 * Solidity paid for by every claimant, and a governance vote is a steward
 * elected by whoever holds the most tokens. What this contract does instead is
 * make the role SMALL and its every use PUBLIC: the steward's authority
 * extends to money they put in themselves, each epoch is a single irreversible
 * publication, and PeerAnchor timestamps the root so that "the root was fixed
 * before the claims" is checkable by a stranger rather than asserted here.
 *
 * ── THE MERKLE TREE, EXACTLY ───────────────────────────────────────────────
 * One implementation of this tree exists in this project and it is
 * chain/merkle.mjs, unchanged. This contract is the Solidity reader of that
 * same format — SHA-256 over lowercase ASCII HEX STRINGS, with 'L' and 'N'
 * domain separation. An independent implementer can reproduce every byte from
 * what follows.
 *
 *   leaf string  h = <40 lowercase hex chars: the claimant's address, no "0x">
 *                 ++ <64 lowercase hex chars: the amount in raw PEER units
 *                     (18 decimals), zero-padded>
 *   leaf node      = sha256( "L" ++ h )              — 105 ASCII bytes hashed
 *   interior node  = sha256( "N" ++ hex(left) ++ hex(right) )
 *                                                     — 129 ASCII bytes hashed
 *                    where hex(x) is the 64-char lowercase hex of the node
 *   odd node       carried up unchanged, hashed with nothing
 *   empty tree     sha256("peer-merkle-empty") — a root with no leaf under it,
 *                  so nothing is claimable against it, by construction
 *
 * In JS that is exactly merkleRoot(leaves) with leaves = [h, h, …]: the 'L'
 * pass, the 'N' pairing and the carry rule all live in merkle.mjs and none of
 * them are reimplemented here — only read back.
 *
 * THE COST OF ONE IMPLEMENTATION, named plainly. Hashing hex TEXT means this
 * contract converts each 32-byte node into 64 ASCII characters before every
 * sha256, which costs a few thousand gas per proof step that a raw-bytes tree
 * would not. On Base that is a fraction of a cent per claim. The alternative
 * was a second tree format — raw 32-byte concatenation on-chain, hex strings
 * in JS — and two merkle implementations that must agree forever, where the
 * failure mode of a disagreement is that every claim in production reverts
 * (or worse, that some do not). One format checked by a parity test is worth
 * far more than the gas. SHA-256 is a precompile (0x02) and cheap; keccak
 * would have been marginally cheaper still and would have made the JS side
 * import a keccak library, which is the house rule this repo does not break.
 *
 * THE PROOF ENCODING. merkle.mjs is position-dependent: 'N' ++ left ++ right
 * is not the same as 'N' ++ right ++ left, so a proof must say which side each
 * sibling was on. The signature this contract publishes takes one bytes32
 * array and nothing else, so the directions ride inside it:
 *
 *   proof[0]      the PATH WORD — not a hash. Bit i (counting from the least
 *                 significant) is 1 when the i-th sibling is the LEFT input
 *                 and the running node is the right one, 0 when it is the
 *                 other way round. Bits above the sibling count must be zero,
 *                 so one claim has exactly one valid encoding.
 *   proof[1…]     the siblings, bottom of the tree first. Levels where the
 *                 node was carried up unchanged contribute NO sibling, which
 *                 is why the path word is a bitmask over siblings and not the
 *                 leaf index.
 *
 * A one-leaf tree is the degenerate case and it is real (an epoch where
 * exactly one handle is bound): the root IS the leaf, and the proof is a
 * single word — the path word, zero, with no siblings after it.
 *
 * ── WHAT THIS CONTRACT CANNOT CHECK, SO NOBODY ASSUMES IT DOES ─────────────
 * It cannot verify that the leaves sum to `total`. Nothing on-chain has the
 * tree, only its root, and summing it would mean posting every leaf. So the
 * guard is on the other side: claims are refused once paid + amount would
 * exceed the epoch's total. A root whose leaves oversum its deposit therefore
 * pays out first-come and then reverts — bad for the late claimants of that
 * epoch, and deliberately fatal to nobody else, because it cannot reach into
 * another epoch's deposit. Epochs share one token balance and are kept apart
 * by that arithmetic alone; it is the invariant to preserve if this contract
 * is ever edited. This is the same fact the steward's CAN list opens with, and
 * it is written twice on purpose: a reader who stops at the role summary must
 * not come away believing something this paragraph then takes back.
 *
 * It cannot verify that a leaf's address belongs to the handle that earned
 * it. That binding happens in the log, as a signed 'bindAddress' act under
 * the handle's own credential, and the earnings tree is built over the
 * addresses that binding produced. The consequence, said plainly rather than
 * hidden: A HANDLE WITH NO BOUND ADDRESS HAS NO LEAF THAT EPOCH. Its share is
 * not redistributed to everyone else and is not held in escrow — it simply is
 * not in the tree, so it stays in the unclaimed remainder and returns to the
 * steward at sweep. Rebinding is allowed in the log and takes effect for
 * FUTURE epochs only, because a root already published cannot change, which
 * is the entire point of publishing it.
 *
 * Reserves-style accounting note, the same one PeerPools makes: this contract
 * credits the amount REQUESTED, not the balance delta. PEER is this repo's own
 * eighty-line ERC-20, has never taken a fee on transfer and can never start,
 * because it has no owner to change it. The token address is immutable, so
 * that assumption is fixed at deployment and cannot be redirected to some
 * other token later.
 *
 * No imports, no upgrade path, no pause. IERC20 is declared locally and every
 * call to it is wrapped in a require, so a token that answers `false` reverts
 * the whole act rather than leaving this contract believing coins moved.
 *
 * Deploy: Remix -> Solidity 0.8.24 -> optimizer ON, 200 runs -> Base (8453).
 * Constructor: the PEER token address
 * (0x5d63786095d09210011fd382c0710a7a1bc90e6f on Base) and the steward
 * address. The steward must approve this contract for each epoch's total
 * before calling openEpoch — an approval is the steward's own transaction, so
 * nothing here can pull funds that were never offered. `claimUntil` is an
 * absolute unix SECOND (not milliseconds, and MAX_WINDOW refuses that mistake)
 * and must land between MIN_WINDOW and MAX_WINDOW from the opening block.
 */

interface IERC20 {
    // Declared with `returns (bool)` and every call below wrapped in a
    // require: a token that answers false must revert the act, never leave an
    // epoch believing it was funded or a claimant believing they were paid.
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract PeerClaim {
    /// The ERC-20 paid out. Immutable: an epoch opened against one token can
    /// never be settled in another.
    address public immutable token;
    /// The only privileged address, fixed at deployment. There is no transfer
    /// function for this role — a steward key that can hand itself to another
    /// address is a steward key one phishing email wider than it looks. If the
    /// role must move, deploy a new contract, and let the old epochs finish
    /// under the address they were opened by.
    address public immutable steward;

    /**
     * The shortest and longest claim window openEpoch will accept, measured
     * from the block that opens the epoch. Both are constants, both are
     * public, and a claimant can read either from the chain rather than
     * believing a sentence in a comment.
     *
     * MIN_WINDOW is the one that carries weight. "The steward cannot sweep
     * early" is worth nothing when the steward also picks the deadline and
     * nothing sets a floor under it: `claimUntil = block.timestamp + 1` used
     * to be a legal epoch, and Base makes a block every two seconds, so the
     * whole deposit could come back before anybody's wallet had refreshed. A
     * week is long enough that a claimant who was not watching on the day
     * still gets there, and short enough that a steward funding an epoch is
     * not lending it out for a season.
     *
     * MAX_WINDOW guards the other direction, which harms the steward rather
     * than the claimants: the deposit is locked until the deadline, openEpoch
     * cannot be re-run, and there is no rescue function anywhere in here by
     * design — so a mistyped deadline (a millisecond timestamp, say, or a
     * uint64 max) would strand the steward's own PEER with no way back for
     * anyone. A year is far past any real claim window and still finite.
     */
    uint64 public constant MIN_WINDOW = 7 days;
    uint64 public constant MAX_WINDOW = 365 days;

    struct Epoch {
        /// The earnings root. Non-zero for every opened epoch, and the
        /// existence test everywhere below: openEpoch refuses a zero root, so
        /// root == 0 means "this epoch was never opened", full stop.
        bytes32 root;
        /// What the steward deposited when opening. Never changes.
        uint256 total;
        /// What claimants have taken so far. Only ever grows, only ever by an
        /// amount a proof justified.
        uint256 paid;
        /// The last second at which a claim is accepted — `<=`, so a claim
        /// landing in the deadline's own second is in time.
        uint64 claimUntil;
        /// Set once by sweep. Packs into the same slot as claimUntil.
        bool swept;
    }

    mapping(uint256 => Epoch) private epochs;

    /**
     * epoch => claimant => already paid. Public, so the generated getter IS
     * the `claimed(uint256,address)` view the rest of the pipeline reads —
     * one source for the answer instead of a hand-written copy that could
     * drift from the flag the code actually checks.
     */
    mapping(uint256 => mapping(address => bool)) public claimed;

    event EpochOpened(uint256 indexed epoch, bytes32 root, uint256 total, uint64 claimUntil);
    event Claimed(uint256 indexed epoch, address indexed who, uint256 amount);
    event Swept(uint256 indexed epoch, uint256 amount);

    /**
     * One storage flag, checked and toggled by hand, on every function that
     * moves value. PEER has no transfer hooks and cannot grow any, so nothing
     * here can re-enter today — but "today" is not an argument a contract gets
     * to make about the future, and the flag costs a few hundred gas to close
     * the question permanently. The state writes already precede every
     * external call (claimed set before the transfer, paid before it, swept
     * before it); the guard is the second lock on a door that is already
     * bolted.
     */
    uint256 private unlocked = 1;
    modifier nonReentrant() {
        require(unlocked == 1, "reentered");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(address token_, address steward_) {
        require(token_ != address(0), "token address is zero");
        require(steward_ != address(0), "steward address is zero");
        token = token_;
        steward = steward_;
    }

    /**
     * Publish an epoch's earnings root and fund it in the same transaction.
     *
     * ONCE PER EPOCH NUMBER, FOREVER. A second call reverts — it does not top
     * up, replace the root, or extend the deadline. Everything the epoch means
     * is fixed here, in one irreversible act, which is what lets PeerAnchor's
     * timestamp of the same root mean anything at all.
     *
     * The total is pulled up front, deliberately. Opening an epoch and
     * promising to fund it later would create exactly the state this contract
     * refuses to have: a published root that people can compute proofs
     * against, backed by nothing, where the first claimants are paid out of
     * some other epoch's deposit and the last ones find an empty contract. The
     * steward's exposure is what they have actually deposited, and a claimant's
     * assurance is the same fact from the other side.
     *
     * The deadline is bounded on both sides, and only one of those bounds is
     * about the steward's convenience.
     *
     * MIN_WINDOW is the honest one. A deadline in the past was already refused
     * — that would be an epoch nobody could ever claim from, just a receipt for
     * a round trip — but refusing only the past left the identical outcome one
     * second away: `block.timestamp + 1` passed, and the very next Base block
     * could sweep the whole deposit back while every valid claim in that epoch
     * reverted as too late. So the floor is a real span, and the header's
     * "cannot sweep early" now means something a claimant can rely on instead
     * of describing a door the steward holds the hinge of.
     *
     * MAX_WINDOW costs the claimants nothing and protects the steward from a
     * one-way mistake: this call cannot be re-run, the deposit is locked until
     * the deadline, and nothing in this contract can rescue it early.
     *
     * Between the two, how far ahead the deadline sits is the steward's call
     * and this contract has no opinion. It cannot be changed afterwards, in
     * either direction, and that is the price of it being a promise.
     */
    function openEpoch(uint256 epoch, bytes32 root, uint256 total, uint64 claimUntil) external nonReentrant {
        require(msg.sender == steward, "only the steward opens an epoch");
        require(root != bytes32(0), "root is zero");
        require(total > 0, "total must be positive");
        require(claimUntil >= block.timestamp + MIN_WINDOW, "a claim window must be at least MIN_WINDOW long");
        require(claimUntil <= block.timestamp + MAX_WINDOW, "a claim window must be at most MAX_WINDOW long");
        Epoch storage e = epochs[epoch];
        require(e.root == bytes32(0), "this epoch is already open");
        e.root = root;
        e.total = total;
        e.claimUntil = claimUntil;
        require(IERC20(token).transferFrom(msg.sender, address(this), total), "PEER transfer in failed");
        emit EpochOpened(epoch, root, total, claimUntil);
    }

    /**
     * Claim your own leaf. The proof is verified over MSG.SENDER — never over
     * an address passed in as an argument — so there is no version of this
     * call that pays somebody else's earnings anywhere, including to them.
     * The cost of that choice, stated: nobody can submit a claim on a
     * claimant's behalf, so a claimant with no ETH for gas cannot be helped by
     * a relayer. The alternative is a function that takes a beneficiary, and
     * every such function is one argument away from being a redirection bug.
     * Gas on Base is small enough that this is the cheaper trade.
     *
     * Amount must be positive: a zero leaf would be a transfer of nothing that
     * permanently burns the claimant's one claim for that epoch. Builders of
     * the tree must therefore skip zero earnings rather than emit an
     * unclaimable leaf for them.
     *
     * There is no need to check `swept` here. sweep requires the deadline to
     * have passed and this requires it not to have, so the two can never both
     * be true of the same epoch — an invariant worth keeping if either
     * deadline test is ever edited.
     */
    function claim(uint256 epoch, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Epoch storage e = epochs[epoch];
        require(e.root != bytes32(0), "no such epoch");
        require(block.timestamp <= e.claimUntil, "too late - this epoch's claim window has closed");
        require(amount > 0, "amount must be positive");
        require(!claimed[epoch][msg.sender], "already claimed");
        require(_verify(e.root, msg.sender, amount, proof), "proof does not match this epoch's root");
        uint256 paid = e.paid + amount;
        // The only thing standing between an oversummed root and another
        // epoch's deposit. See the header: nothing on-chain can add the leaves
        // up, so the contract refuses to pay past what this epoch was funded
        // with instead of pretending it verified the sum.
        require(paid <= e.total, "this epoch cannot pay that - the root oversums its deposit");
        e.paid = paid;
        claimed[epoch][msg.sender] = true;
        require(IERC20(token).transfer(msg.sender, amount), "PEER transfer out failed");
        emit Claimed(epoch, msg.sender, amount);
    }

    /**
     * After the deadline, return what nobody claimed to the steward.
     *
     * Callable by ANYONE, on purpose. The destination is fixed in code — the
     * steward, who deposited it — so who pushes the button cannot change where
     * the money goes, and making it permissionless means an epoch cannot sit
     * un-swept because one key went quiet. Nothing is taken from claimants by
     * a sweep: their window is already closed by the time it can run at all.
     *
     * Strictly after: claim accepts the deadline's own second, so sweep must
     * refuse it, or the last second of an epoch would be a race between a
     * claimant and a sweeper.
     *
     * Once. A swept epoch is finished — its remainder has left, and a second
     * sweep would have to take another epoch's deposit to succeed, which is
     * exactly what must never happen.
     */
    function sweep(uint256 epoch) external nonReentrant returns (uint256 rest) {
        Epoch storage e = epochs[epoch];
        require(e.root != bytes32(0), "no such epoch");
        require(block.timestamp > e.claimUntil, "too early - the claim window is still open");
        require(!e.swept, "already swept");
        e.swept = true;
        rest = e.total - e.paid; // paid <= total is enforced on every claim
        // A fully-claimed epoch sweeps to zero. The flag still flips and the
        // event still fires — the epoch is closed either way — but no token
        // call is made for nothing.
        if (rest > 0) {
            require(IERC20(token).transfer(steward, rest), "PEER transfer out failed");
        }
        emit Swept(epoch, rest);
    }

    /**
     * FIVE static words, in this order and no other:
     *
     *   word 0  root         bytes32
     *   word 1  total        uint256
     *   word 2  paid         uint256
     *   word 3  claimUntil   uint64, right-aligned in the low 8 bytes
     *   word 4  open         bool, 0 or 1
     *
     * so a reader with curl and no ABI library can decode it by cutting the
     * hex into 32-byte slices. Anything added later goes on the END.
     *
     * `open` means one thing and it is worth being exact, because the obvious
     * other reading is wrong: it is TRUE only while a valid claim would
     * actually be paid right now — the epoch exists, the deadline has not
     * passed, and the remainder has not been swept. It is deliberately NOT
     * "has been opened". For that question, read word 0: root != 0 is the
     * existence test, and an epoch with a root and open == false is one whose
     * window has closed.
     */
    function epochInfo(uint256 epoch)
        external
        view
        returns (bytes32 root, uint256 total, uint256 paid, uint64 claimUntil, bool open)
    {
        Epoch storage e = epochs[epoch];
        return (
            e.root,
            e.total,
            e.paid,
            e.claimUntil,
            e.root != bytes32(0) && !e.swept && block.timestamp <= e.claimUntil
        );
    }

    /**
     * The leaf node a claimant's (address, amount) hashes to — sha256("L" ++
     * the 104-char hex string described in the header). Exposed as a view so
     * an independent tree builder can check its own leaf against the contract
     * that will read it, without spending a failed claim to find out.
     */
    function leafOf(address who, uint256 amount) external pure returns (bytes32) {
        return _leaf(who, amount);
    }

    /**
     * Dry-run a claim: true only if calling claim() with these arguments from
     * this address would be paid right now. It folds in everything claim()
     * checks — the epoch exists, the window is open, the amount is positive
     * and not already taken, the proof matches, and the epoch has enough left
     * — so a UI can refuse to offer a transaction that would revert. It grants
     * nothing and changes nothing; the answer can go stale the moment another
     * claim lands.
     */
    function checkClaim(uint256 epoch, address who, uint256 amount, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0) || block.timestamp > e.claimUntil) return false;
        if (amount == 0 || claimed[epoch][who]) return false;
        if (e.paid + amount > e.total) return false;
        return _verify(e.root, who, amount, proof);
    }

    /// sha256("L" ++ 40 hex chars of the address ++ 64 hex chars of the
    /// amount) — 105 ASCII bytes. The 'L' is what stops any interior node,
    /// which is always hashed under 'N', from ever being presented as a leaf.
    function _leaf(address who, uint256 amount) private pure returns (bytes32) {
        return sha256(abi.encodePacked("L", _hex(uint256(uint160(who)), 40), _hex(amount, 64)));
    }

    /**
     * Walk the proof from the leaf up and report whether it lands on the root.
     * Returns false rather than reverting, so checkClaim can ask the same
     * question a claim asks; claim() turns the false into its own revert with
     * a message that says which check failed.
     */
    function _verify(bytes32 root, address who, uint256 amount, bytes32[] calldata proof)
        private
        pure
        returns (bool)
    {
        // proof[0] is the path word, so even a one-leaf tree needs one entry.
        if (proof.length == 0) return false;
        uint256 path = uint256(proof[0]);
        uint256 steps = proof.length - 1;
        // Bits above the sibling count carry no meaning, so they must be zero:
        // otherwise one claim would have 2^k valid encodings, and "the proof
        // that was published" and "the proof that was used" could differ
        // without either being wrong. (A shift of 256 or more yields 0 in
        // Solidity, so an absurdly long proof passes this line and then simply
        // fails to reach the root.)
        if ((path >> steps) != 0) return false;
        bytes32 node = _leaf(who, amount);
        for (uint256 i = 0; i < steps; i++) {
            bytes32 sib = proof[i + 1];
            // 'N' ++ left ++ right, both as 64-char lowercase hex, exactly as
            // merkle.mjs writes it. Carried levels contributed no sibling, so
            // there is nothing to skip here — every entry is a real pairing.
            if ((path >> i) & 1 == 1) {
                node = sha256(abi.encodePacked("N", _hex(uint256(sib), 64), _hex(uint256(node), 64)));
            } else {
                node = sha256(abi.encodePacked("N", _hex(uint256(node), 64), _hex(uint256(sib), 64)));
            }
        }
        return node == root;
    }

    /**
     * The low `nibbles` nibbles of v as lowercase ASCII hex, most significant
     * first — 40 for an address, 64 for a 32-byte node. This is the whole cost
     * of sharing one merkle format with chain/merkle.mjs, and the header names
     * the tradeoff. The digit arithmetic is spelled out rather than table
     * lookups so a reader can check it by eye: 48 is '0' and 87 + 10 is 97,
     * which is 'a'. Lowercase is not cosmetic — 'A' is a different byte to
     * sha256, and the JS side writes lowercase.
     */
    function _hex(uint256 v, uint256 nibbles) private pure returns (bytes memory out) {
        out = new bytes(nibbles);
        for (uint256 i = nibbles; i > 0; i--) {
            uint256 d = v & 0xf;
            out[i - 1] = bytes1(uint8(d < 10 ? 48 + d : 87 + d));
            v >>= 4;
        }
    }
}
