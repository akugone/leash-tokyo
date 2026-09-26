// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {RegistryRoles} from "../../src/libraries/EnsRoles.sol";
import {SepoliaAddresses} from "../Addresses.sol";
import {EnsScriptBase} from "./EnsScriptBase.s.sol";
import {LeashOrgLib} from "./LeashOrgLib.sol";

/// @notice Deploy the org `UserRegistry` proxy and hang it under the parent `.eth` name (ticket L-04).
/// @dev `VerifiableFactory.deployProxy` mixes `msg.sender` into the CREATE2 salt, so the proxy address is
///      deterministic per owner: a second run from the same owner reverts. `setSubregistry` works because
///      the registrar granted the owner `ROLE_SET_SUBREGISTRY` on its `.eth` token at registration.
contract DeployOrgRegistry is EnsScriptBase {
    // ============ External functions ============

    function run() external {
        address owner = _owner();
        string memory parentLabel = _parentLabel();
        uint256 parentId = EnsNameLib.labelId(parentLabel);
        require(ETH_REGISTRY.getOwner(parentId) == owner, "DeployOrgRegistry: owner does not hold the parent name");

        vm.startBroadcast(_ownerPk());
        address proxy = FACTORY.deployProxy(
            SepoliaAddresses.ENS_USER_REGISTRY_IMPL, LeashOrgLib.REGISTRY_SALT, LeashOrgLib.registryInitData(owner)
        );
        ETH_REGISTRY.setSubregistry(parentId, proxy);
        vm.stopBroadcast();

        IPermissionedRegistry orgRegistry = IPermissionedRegistry(proxy);
        require(ETH_REGISTRY.getSubregistry(parentLabel) == proxy, "DeployOrgRegistry: subregistry not set");
        require(
            orgRegistry.hasRootRoles(RegistryRoles.ORG_OWNER_ROOT_ROLES, owner),
            "DeployOrgRegistry: owner missing root roles"
        );
        _writeAddress("orgRegistry", proxy);
        // Lower bound for scanning the registry's events (the dashboard lists agents from `LabelRegistered`).
        _writeUint("orgRegistryBlock", block.number);

        _logAddress("DeployOrgRegistry: orgRegistry", proxy);
        console2.log("DeployOrgRegistry: subregistry of", _parentName());
    }
}
