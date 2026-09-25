// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Role bitmaps of the ENSv2 `PermissionedRegistry`, copied from `RegistryRolesLib`.
/// @dev Admin bit of a role is `role << 128`.
library RegistryRoles {
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128;
    uint256 internal constant ROLE_REGISTER_RESERVED = 1 << 4;
    uint256 internal constant ROLE_SET_PARENT = 1 << 8;
    uint256 internal constant ROLE_UNREGISTER = 1 << 12;
    uint256 internal constant ROLE_UNREGISTER_ADMIN = ROLE_UNREGISTER << 128;
    uint256 internal constant ROLE_RENEW = 1 << 16;
    uint256 internal constant ROLE_RENEW_ADMIN = ROLE_RENEW << 128;
    uint256 internal constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant ROLE_SET_SUBREGISTRY_ADMIN = ROLE_SET_SUBREGISTRY << 128;
    uint256 internal constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 internal constant ROLE_SET_RESOLVER_ADMIN = ROLE_SET_RESOLVER << 128;

    /// @dev Everything an org owner needs on its own registry: issue, revoke, renew, point names.
    uint256 internal constant ORG_OWNER_ROOT_ROLES =
        ROLE_REGISTRAR | ROLE_REGISTRAR_ADMIN | ROLE_UNREGISTER | ROLE_UNREGISTER_ADMIN | ROLE_RENEW | ROLE_RENEW_ADMIN
        | ROLE_SET_SUBREGISTRY | ROLE_SET_SUBREGISTRY_ADMIN | ROLE_SET_RESOLVER | ROLE_SET_RESOLVER_ADMIN;
}

/// @notice Role bitmaps of the ENSv2 `PermissionedResolver`, copied from `PermissionedResolverLib`.
library ResolverRoles {
    uint256 internal constant ROLE_SET_ADDRESS = 1 << 0;
    uint256 internal constant ROLE_SET_ADDRESS_ADMIN = ROLE_SET_ADDRESS << 128;
    uint256 internal constant ROLE_SET_TEXT = 1 << 4;
    uint256 internal constant ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128;
    uint256 internal constant ROLE_SET_CONTENTHASH = 1 << 8;
    uint256 internal constant ROLE_SET_ABI = 1 << 12;
    uint256 internal constant ROLE_SET_INTERFACE = 1 << 16;
    uint256 internal constant ROLE_SET_NAME = 1 << 20;
    uint256 internal constant ROLE_SET_DATA = 1 << 24;
    uint256 internal constant ROLE_LINK = 1 << 28;

    /// @dev Everything an org owner needs on its resolver: write every record and delegate per key.
    uint256 internal constant ORG_OWNER_ROOT_ROLES =
        ROLE_SET_ADDRESS | ROLE_SET_ADDRESS_ADMIN | ROLE_SET_TEXT | ROLE_SET_TEXT_ADMIN;

    /// @notice EAC resource the resolver derives for a text key: `keccak256(bytes(key))`.
    function textResource(string memory key) internal pure returns (uint256) {
        return uint256(keccak256(bytes(key)));
    }

    /// @notice EAC resource the resolver derives for an address coin type.
    function addressResource(uint256 coinType) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(coinType)));
    }
}
