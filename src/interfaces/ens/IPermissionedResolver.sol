// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Grant} from "./IEACGrantInitializable.sol";
import {IEnhancedAccessControl} from "./IEnhancedAccessControl.sol";

/// @notice ENSIP-10 extended resolver read path. This is the only read path of the deployed resolver.
interface IExtendedResolver {
    /// @param name DNS-encoded name. The resolver derives the node from it.
    /// @param data ABI-encoded profile call, e.g. `text(bytes32,string)`; the `bytes32 node` argument is ignored.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @notice Minimal view of the ENSv2 `PermissionedResolver` as deployed on Sepolia.
/// @dev Setters are keyed by DNS-encoded `name`. Scoped roles are granted with `grantSetterRoles`;
///      `grantRoles` is disabled on this contract and always reverts.
interface IPermissionedResolver is IExtendedResolver, IEnhancedAccessControl {
    event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value);
    event AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes);

    /// @dev Error selector: `0x8d666f60`
    error InvalidEVMAddress(bytes addressBytes);
    /// @dev Error selector: `0x7b1c461b`
    error UnsupportedResolverProfile(bytes4 selector);

    /// @param grants Accounts and roles granted on root.
    /// @param calls Setter calldata executed without permission checks.
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;

    /// @notice Set a text record. Requires `ROLE_SET_TEXT` on `keccak256(bytes(key))` or on root.
    function setText(bytes calldata name, string calldata key, string calldata value) external;

    /// @notice Set an address record. `coinType` 60 is ETH, `addressBytes` must be 20 bytes.
    ///         Requires `ROLE_SET_ADDRESS` on `keccak256(abi.encodePacked(coinType))` or on root.
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;

    /// @notice Grant the role matching `setter` calldata, scoped to its argument (text key, coin type...).
    ///         Caller needs the corresponding admin role on that resource or on root.
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);

    /// @notice Decode setter calldata into the resource and role it maps to.
    function decodeSetter(bytes calldata setter)
        external
        pure
        returns (bytes memory arg, uint256 resource, uint256 roleBitmap);

    function multicall(bytes[] calldata calls) external returns (bytes[] memory results);
    function getRecordId(bytes32 node) external view returns (uint256);
}
