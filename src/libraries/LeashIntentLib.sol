// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What an agent signs before every swap. Carried in Uniswap v4 `hookData`.
/// @dev `node` binds the intent to the agent's ENS name, `poolId` + `zeroForOne` + `amountSpecified` bind it to
///      the exact swap, `nonce` prevents replay, `deadline` bounds how long a signed intent stays valid.
struct SwapIntent {
    bytes32 node;
    bytes32 poolId;
    bool zeroForOne;
    int256 amountSpecified;
    uint256 nonce;
    uint256 deadline;
}

/// @notice EIP-712 hashing for `SwapIntent` and the `hookData` codec shared by the hook and the agent.
/// @dev Domain: name "Leash", version "1", chainId = block.chainid, verifyingContract = the LeashHook.
///      hookData = abi.encode(string label, SwapIntent intent, bytes signature).
library LeashIntentLib {
    string internal constant NAME = "Leash";
    string internal constant VERSION = "1";

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant SWAP_INTENT_TYPEHASH = keccak256(
        "SwapIntent(bytes32 node,bytes32 poolId,bool zeroForOne,int256 amountSpecified,uint256 nonce,uint256 deadline)"
    );

    /// @notice Domain separator for `verifyingContract` on the current chain.
    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                verifyingContract
            )
        );
    }

    /// @notice EIP-712 struct hash of `intent`.
    function hashIntent(SwapIntent memory intent) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SWAP_INTENT_TYPEHASH,
                intent.node,
                intent.poolId,
                intent.zeroForOne,
                intent.amountSpecified,
                intent.nonce,
                intent.deadline
            )
        );
    }

    /// @notice Final digest the agent signs.
    function digest(bytes32 domainSeparator_, SwapIntent memory intent) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator_, hashIntent(intent)));
    }

    /// @notice Build `hookData` for a swap.
    function encodeHookData(string memory label, SwapIntent memory intent, bytes memory signature)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(label, intent, signature);
    }

    /// @notice Decode `hookData`. Reverts on malformed input, which is the desired fail closed behaviour.
    function decodeHookData(bytes memory hookData)
        internal
        pure
        returns (string memory label, SwapIntent memory intent, bytes memory signature)
    {
        return abi.decode(hookData, (string, SwapIntent, bytes));
    }
}
