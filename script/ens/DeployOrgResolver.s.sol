// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {ResolverRoles} from "../../src/libraries/EnsRoles.sol";
import {SepoliaAddresses} from "../Addresses.sol";
import {EnsScriptBase} from "./EnsScriptBase.s.sol";
import {LeashOrgLib} from "./LeashOrgLib.sol";

/// @notice Deploy the org `PermissionedResolver` proxy (ticket L-05).
/// @dev The owner receives `ROLE_SET_ADDRESS | ROLE_SET_TEXT` and their admin bits on the root resource,
///      so it can write every record and delegate single text keys with `grantSetterRoles`.
contract DeployOrgResolver is EnsScriptBase {
    // ============ External functions ============

    function run() external {
        address owner = _owner();

        vm.startBroadcast(_ownerPk());
        address proxy = FACTORY.deployProxy(
            SepoliaAddresses.ENS_PERMISSIONED_RESOLVER_IMPL,
            LeashOrgLib.RESOLVER_SALT,
            LeashOrgLib.resolverInitData(owner)
        );
        vm.stopBroadcast();

        IPermissionedResolver orgResolver = IPermissionedResolver(proxy);
        require(
            orgResolver.hasRootRoles(ResolverRoles.ROLE_SET_TEXT_ADMIN, owner),
            "DeployOrgResolver: owner missing ROLE_SET_TEXT_ADMIN"
        );
        require(
            orgResolver.hasRootRoles(ResolverRoles.ORG_OWNER_ROOT_ROLES, owner),
            "DeployOrgResolver: owner missing root roles"
        );
        _writeAddress("orgResolver", proxy);

        _logAddress("DeployOrgResolver: orgResolver", proxy);
    }
}
