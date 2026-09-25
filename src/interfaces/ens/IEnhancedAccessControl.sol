// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal view of ENSv2 Enhanced Access Control, as deployed on Sepolia.
/// @dev Roles are nybble-packed bitmaps. Admin bit of a role is `role << 128`.
interface IEnhancedAccessControl {
    event EACRolesChanged(
        uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap
    );

    /// @dev Error selector: `0x4b27a133`
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
    /// @dev Error selector: `0xd1a3b355`
    error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account);
    /// @dev Error selector: `0xa604e318`
    error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account);

    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function ROOT_RESOURCE() external view returns (uint256);
    function roles(uint256 resource, address account) external view returns (uint256);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
}
