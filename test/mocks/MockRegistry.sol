// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Offline stand-in for the subset of ENSv2 `PermissionedRegistry` that `LeashHook` reads.
/// @dev Same ABI shapes as the real contract: `getExpiry(uint256 anyId)` where `anyId` is
///      `uint256(keccak256(label))`, and `getResolver(string label)` which returns zero once expired.
contract MockRegistry {
    struct Name {
        uint64 expiry;
        address resolver;
    }

    mapping(uint256 labelId => Name) internal _names;

    // ============ External functions ============

    /// @notice Register or update `label`.
    function setName(string memory label, uint64 expiry, address resolver) external {
        _names[_labelId(label)] = Name({expiry: expiry, resolver: resolver});
    }

    /// @notice Mirror of `unregister`: expiry becomes `block.timestamp`, so the name is expired at once.
    function revoke(string memory label) external {
        _names[_labelId(label)].expiry = uint64(block.timestamp);
    }

    /// @notice Expiry timestamp of `anyId`. Zero for unknown names.
    function getExpiry(uint256 anyId) external view returns (uint64) {
        return _names[anyId].expiry;
    }

    /// @notice Resolver of `label`, or zero once expired (`block.timestamp >= expiry`), like the real registry.
    function getResolver(string memory label) external view returns (address) {
        Name memory name = _names[_labelId(label)];
        if (block.timestamp >= name.expiry) return address(0);
        return name.resolver;
    }

    // ============ Internal functions ============

    function _labelId(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }
}
