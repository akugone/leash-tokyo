// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {ResolverRoles} from "../../src/libraries/EnsRoles.sol";
import {EnsScriptBase} from "./EnsScriptBase.s.sol";
import {LeashOrgLib} from "./LeashOrgLib.sol";

/// @notice Give the risk manager `ROLE_SET_TEXT` on `leash.dailyNotional`, `leash.tokens` and `leash.maxSlippageBps`
///         only (ticket L-07).
/// @dev `grantRoles` is disabled on the deployed resolver; `grantSetterRoles` decodes a setter calldata,
///      derives the resource from the text key and grants the matching role. Scoping is per key, not per name:
///      the risk manager can edit these three keys on every agent served by the org resolver, nothing else,
///      and holds no role on the registry.
contract GrantRiskManager is EnsScriptBase {
    // ============ External functions ============

    function run() external {
        address riskManager = _riskManager();
        IPermissionedResolver orgResolver = _orgResolver();
        bytes[] memory setters = LeashOrgLib.riskManagerSetters();
        string[] memory keys = LeashOrgLib.riskManagerKeys();

        vm.startBroadcast(_ownerPk());
        for (uint256 i = 0; i < setters.length; i++) {
            orgResolver.grantSetterRoles(setters[i], riskManager);
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < keys.length; i++) {
            require(
                orgResolver.hasRoles(ResolverRoles.textResource(keys[i]), ResolverRoles.ROLE_SET_TEXT, riskManager),
                string.concat("GrantRiskManager: role missing on ", keys[i])
            );
            console2.log("GrantRiskManager: ROLE_SET_TEXT granted on", keys[i]);
        }
        require(
            !orgResolver.hasRoles(
                ResolverRoles.textResource(LeashOrgLib.KEY_QUOTE), ResolverRoles.ROLE_SET_TEXT, riskManager
            ),
            "GrantRiskManager: risk manager must not write leash.quote"
        );
        _logAddress("GrantRiskManager: riskManager", riskManager);
    }
}
