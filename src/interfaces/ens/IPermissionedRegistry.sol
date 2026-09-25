// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IEnhancedAccessControl} from "./IEnhancedAccessControl.sol";

/// @notice Minimal view of ENSv2 `PermissionedRegistry` / `UserRegistry`, as deployed on Sepolia.
/// @dev `anyId` accepts a labelhash (`uint256(keccak256(bytes(label)))`), a token id or a resource id.
///      `IRegistry` parameters are typed as `address` here; the ABI is identical.
interface IPermissionedRegistry is IEnhancedAccessControl {
    enum Status {
        AVAILABLE,
        RESERVED,
        REGISTERED
    }

    struct State {
        Status status;
        uint64 expiry;
        address latestOwner;
        uint256 tokenId;
        uint256 resource;
    }

    error LabelAlreadyRegistered(string label);
    error LabelExpired(uint256 tokenId);
    error CannotReduceExpiry(uint64 oldExpiry, uint64 newExpiry);
    error CannotSetPastExpiry(uint64 expiry);

    /// @notice Register `label`. Requires `ROLE_REGISTRAR` on the root resource.
    function register(
        string calldata label,
        address owner,
        address subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    /// @notice Revoke a name. Sets expiry to `block.timestamp` and burns the token.
    ///         Requires `ROLE_UNREGISTER` on the token or on root.
    function unregister(uint256 anyId) external;

    function renew(uint256 anyId, uint64 newExpiry) external;
    function setSubregistry(uint256 anyId, address registry) external;
    function setResolver(uint256 anyId, address resolver) external;

    /// @notice Expiry timestamp. A name is live while `block.timestamp < expiry`.
    function getExpiry(uint256 anyId) external view returns (uint64 expiry);
    /// @notice Resolver for `label`, or `address(0)` once expired or revoked.
    function getResolver(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
    function getOwner(uint256 anyId) external view returns (address owner);
    function getTokenId(uint256 anyId) external view returns (uint256 tokenId);
    function getState(uint256 anyId) external view returns (State memory state);
    function LABEL_STORE() external view returns (address);
}
