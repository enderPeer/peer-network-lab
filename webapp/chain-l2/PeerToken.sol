// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PEER — the Peer Network epoch token, on Base.
 *
 * Deliberately the most boring ERC-20 that can exist. No owner, no mint
 * function, no pause, no blacklist, no upgrade proxy, no transfer fee, no
 * rebasing. The entire supply is created once, in the constructor, to the
 * address that deploys it, and after that the contract can never do anything
 * an ERC-20 does not do.
 *
 * That is a security decision, not laziness. Every one of those omitted
 * features is a privileged function, and a privileged function is a key that
 * can be lost, phished, or coerced — and on a token somebody has paired real
 * bitcoin against, "the deployer can mint more" is indistinguishable from a
 * rug pull whether or not anyone intends one. A reader can verify what this
 * contract can do by reading eighty lines, which is the point: the network's
 * whole claim is that its numbers are checkable.
 *
 * No imports on purpose. This compiles standalone in Remix with nothing to
 * resolve, so what you deploy is exactly what you read here — no dependency
 * fetched at compile time that a reader would have to go and audit as well.
 *
 * Deploy: Remix -> Solidity 0.8.24 -> optimizer ON, 200 runs -> Base (8453).
 * Constructor takes the whole supply in WHOLE tokens; decimals are added for
 * you, so passing 18250000 mints 18,250,000 PEER — the cap TOKEN.md sets for
 * the epoch emission schedule.
 */
contract PeerToken {
    string public constant name = "Peer Network";
    string public constant symbol = "PEER";
    uint8 public constant decimals = 18;

    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 wholeTokens) {
        require(wholeTokens > 0, "supply must be positive");
        uint256 supply = wholeTokens * (10 ** uint256(decimals));
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        // The zero-address `from` is the ERC-20 convention for a mint, and
        // indexers rely on it to see the supply come into existence.
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // An infinite allowance is left untouched rather than decremented —
        // the near-universal convention, and what routers expect.
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance exceeded");
            unchecked { allowance[from][msg.sender] = allowed - value; }
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        // Burning by sending to address(0) is refused rather than silently
        // allowed: this token's burn story lives on Bitcoin, at a dead address
        // whose unspendability is provable, and two different burn mechanisms
        // with two different meanings would make the supply figure a lie.
        require(to != address(0), "transfer to the zero address");
        uint256 bal = balanceOf[from];
        require(bal >= value, "balance too low");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }
}
