// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PeerAnchor — the epoch chain's public clock.
 *
 * webapp/chain/ already seals one signed certificate per closed epoch: a
 * hash-linked block naming the producer, the act range it observed, and the
 * state package replayed from it. That chain makes a silent rewrite
 * DETECTABLE by anyone holding an older copy — but "anyone holding an older
 * copy" is the catch. A producer who rewrote history and reissued every block
 * from the fork point would hand a self-consistent chain to a reader who was
 * not watching at the time, and nothing inside the chain could tell that
 * reader which of the two versions existed first.
 *
 * This contract is the outside witness for exactly that one gap. Post an
 * epoch's block id and its earnings merkle root, and Base timestamps the pair
 * in a place the poster cannot reach back into. Afterwards the claim is
 * checkable by a stranger with no relationship to the network: whatever the
 * log says today, THESE two 32-byte words were committed to at THAT block, by
 * THAT address.
 *
 * What an anchor does NOT say — a contract that overstates itself is worse
 * than no contract at all — is everything else. It does not say the block is
 * correct, that the epoch was computed honestly, that the earnings in that
 * root are deserved, or that the poster is anybody in particular. It is a
 * timestamp over two hashes. Truth stays where block.mjs says it stays: in
 * replay of the public log, by anyone who disagrees. The only thing this adds
 * is the one fact replay cannot reconstruct on its own — WHEN a commitment
 * was made, attested by a chain with no stake in the answer.
 *
 * ANYONE MAY POST, and that is the design rather than an oversight. There is
 * no owner, no producer allowlist, no pause, no privileged function of any
 * kind. Records are keyed by (poster, epoch): my epoch 12 and your epoch 12
 * are two separate rows, and neither can touch the other — the same rule
 * PeerPools applies to pool names, for the same reason. A contract that
 * admitted only one address would be claiming an authority it has no way to
 * enforce: it could not stop that key being lost or coerced, could not check
 * that what the key posted was ever replayed, and would hand readers the
 * false comfort of an "official" row. Readers decide whose anchors mean
 * anything by choosing whose address to read — exactly as they already decide
 * whose blocks to trust by choosing whose signature to verify. An impostor
 * anchoring garbage is not an attack on this contract; their garbage sits
 * under their own address, next to nothing.
 *
 * ONE ANCHOR PER (POSTER, EPOCH), FOREVER. A second attempt REVERTS: it does
 * not overwrite, and it does not quietly no-op. The entire value of the
 * record is that it cannot be revised after the fact, and a contract that let
 * a poster swap yesterday's root for today's would be an expensive way to
 * store a mutable variable while implying otherwise. If a poster anchors the
 * wrong hash there is no repair inside this contract by design; the honest
 * repair is to anchor the corrected epoch from a NEW address and say plainly
 * why. The mistake stays visible, which is the point of the whole mechanism.
 *
 * No imports, no upgrade path, no constructor arguments — the same shape as
 * PeerToken and PeerPools, so what you deploy is exactly what you read here
 * and there is nothing to configure afterwards. No reentrancy guard either,
 * and that is not an omission: this contract makes no external call and moves
 * no value, so there is nothing to re-enter and a guard would only cost gas
 * to defend against nothing.
 *
 * Deploy: Remix -> Solidity 0.8.24 -> optimizer ON, 200 runs -> Base (8453).
 */
contract PeerAnchor {
    struct Anchor {
        /// The block id from chain/block.mjs: sha256 over the sealed block,
        /// signature included. Thirty-two bytes, so it drops straight into a
        /// word with no encoding decision to get wrong later.
        bytes32 blockId;
        /// The merkle root of that epoch's earnings, built by chain/merkle.mjs
        /// and consumed by PeerClaim. Anchoring it here is what makes "the
        /// payout root was fixed before anyone claimed" a checkable sentence
        /// rather than a promise.
        bytes32 earningsRoot;
        /// The chain's own timestamp, never the poster's — a poster-supplied
        /// time would be a number the poster could lie about, which is the
        /// exact thing this contract exists to remove. Doubles as the
        /// presence flag: at == 0 means no anchor.
        uint64 at;
    }

    /// poster => epoch => the one row that poster ever gets for that epoch.
    /// Private with an explicit reader below rather than public, so the
    /// return shape is written down in one place (see anchorOf).
    mapping(address => mapping(uint256 => Anchor)) private anchors;

    event Anchored(address indexed by, uint256 indexed epoch, bytes32 blockId, bytes32 earningsRoot, uint64 at);

    /**
     * Record this epoch's two commitments under msg.sender, once.
     *
     * Both words must be non-zero. Zero is refused not because a zero hash
     * would be dangerous but because it is not a hash anybody can produce:
     * sha256 output is zero only by an accident nobody will see, so a zero
     * word means the caller's encoder dropped an argument. Since the record
     * is permanent and unrevisable, reverting on an obviously-empty argument
     * is worth far more than accepting it. Note the honest consequence of
     * that rule: an epoch whose earnings tree is EMPTY still has a real root
     * to post — chain/merkle.mjs gives the empty tree
     * sha256("peer-merkle-empty"), a perfectly ordinary non-zero hash — so
     * "nobody earned anything this epoch" is anchorable, and only a missing
     * argument is not.
     *
     * The epoch number is not validated against anything. This contract has
     * no idea what an epoch is, cannot see the log, and refuses to pretend:
     * an anchor for an epoch that never closed is simply a poster committing
     * to two hashes that will match nothing, which readers discover the
     * moment they check. Guessing at plausibility here would buy nothing and
     * would let this contract reject a future numbering it was never told
     * about.
     */
    function anchor(uint256 epoch, bytes32 blockId, bytes32 earningsRoot) external {
        require(blockId != bytes32(0), "blockId is zero");
        require(earningsRoot != bytes32(0), "earningsRoot is zero");
        Anchor storage a = anchors[msg.sender][epoch];
        require(a.at == 0, "you already anchored this epoch");
        // uint64 of seconds overflows some hundreds of billions of years from
        // now; the cast cannot lose anything in any world this code runs in,
        // and a uint64 is what the event and the view signature publish.
        uint64 at = uint64(block.timestamp);
        anchors[msg.sender][epoch] = Anchor({blockId: blockId, earningsRoot: earningsRoot, at: at});
        emit Anchored(msg.sender, epoch, blockId, earningsRoot, at);
    }

    /**
     * THREE static words, in this order and no other:
     *
     *   word 0  blockId        bytes32
     *   word 1  earningsRoot   bytes32
     *   word 2  at             uint64, right-aligned in the low 8 bytes
     *
     * so a reader with curl and no ABI library can decode the answer by
     * cutting the hex into 32-byte slices — the standard onchain.mjs already
     * holds itself to. Anything added later goes on the END, so the offsets a
     * reader hardcoded today keep pointing at the same fields.
     *
     * An address/epoch that was never anchored reads back as three zeros: a
     * plain mapping read, not an invention. `at == 0` is the emptiness test,
     * and a caller that skips it will happily believe in an anchor of
     * 0x000…0 that nobody ever posted.
     */
    function anchorOf(address poster, uint256 epoch)
        external
        view
        returns (bytes32 blockId, bytes32 earningsRoot, uint64 at)
    {
        Anchor storage a = anchors[poster][epoch];
        return (a.blockId, a.earningsRoot, a.at);
    }
}
