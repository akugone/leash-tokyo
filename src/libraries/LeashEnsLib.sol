// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IExtendedResolver} from "../interfaces/ens/IPermissionedResolver.sol";

/// @notice ENSIP-10 reads against the deployed ENSv2 `PermissionedResolver`.
/// @dev The resolver only exposes `resolve(name, data)`. The `bytes32 node` inside `data` is ignored,
///      the resolver derives the node from the DNS-encoded `name`.
library LeashEnsLib {
    /// @dev `text(bytes32,string)`
    bytes4 internal constant TEXT_SELECTOR = 0x59d1d43c;
    /// @dev `addr(bytes32)`
    bytes4 internal constant ADDR_SELECTOR = 0x3b3b57de;
    /// @dev ENSIP-9 coin type for Ethereum mainnet addresses.
    uint256 internal constant COIN_TYPE_ETH = 60;

    /// @notice Read text record `key` for DNS-encoded `name`.
    function readText(IExtendedResolver resolver, bytes memory name, string memory key)
        internal
        view
        returns (string memory)
    {
        bytes memory ret = resolver.resolve(name, abi.encodeWithSelector(TEXT_SELECTOR, bytes32(0), key));
        return abi.decode(ret, (string));
    }

    /// @notice Read the ETH address record for DNS-encoded `name`. Zero when unset.
    function readAddr(IExtendedResolver resolver, bytes memory name) internal view returns (address) {
        bytes memory ret = resolver.resolve(name, abi.encodeWithSelector(ADDR_SELECTOR, bytes32(0)));
        return abi.decode(ret, (address));
    }
}
