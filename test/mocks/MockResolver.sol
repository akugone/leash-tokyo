// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IExtendedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";

/// @notice Offline stand-in for the ENSIP-10 read path of the deployed ENSv2 `PermissionedResolver`.
/// @dev Records are keyed by `keccak256(dnsEncodedName)`. `resolve` answers `text(bytes32,string)` and
///      `addr(bytes32)` exactly like the real contract: the `bytes32 node` argument is ignored, the name decides.
contract MockResolver is IExtendedResolver {
    /// @dev `text(bytes32,string)`
    bytes4 internal constant TEXT_SELECTOR = 0x59d1d43c;
    /// @dev `addr(bytes32)`
    bytes4 internal constant ADDR_SELECTOR = 0x3b3b57de;

    error UnsupportedResolverProfile(bytes4 selector);

    mapping(bytes32 nameHash => mapping(string key => string value)) internal _texts;
    mapping(bytes32 nameHash => address) internal _addrs;

    // ============ External functions ============

    /// @notice Set text record `key` on DNS-encoded `name`.
    function setText(bytes memory name, string memory key, string memory value) external {
        _texts[keccak256(name)][key] = value;
    }

    /// @notice Set the ETH address record on DNS-encoded `name`.
    function setAddr(bytes memory name, address a) external {
        _addrs[keccak256(name)] = a;
    }

    /// @inheritdoc IExtendedResolver
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        bytes4 selector = bytes4(data[:4]);
        if (selector == TEXT_SELECTOR) {
            (, string memory key) = abi.decode(data[4:], (bytes32, string));
            return abi.encode(_texts[keccak256(name)][key]);
        }
        if (selector == ADDR_SELECTOR) {
            return abi.encode(_addrs[keccak256(name)]);
        }
        revert UnsupportedResolverProfile(selector);
    }
}
