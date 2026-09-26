// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {ResolverRoles} from "../../src/libraries/EnsRoles.sol";
import {EnsScriptBase} from "./EnsScriptBase.s.sol";
import {LeashOrgLib} from "./LeashOrgLib.sol";

/// @notice Give the risk manager `ROLE_SET_TEXT` on `leash.dailyNotional` and `leash.tokens` of one agent, on that
///         agent's own resolver (ticket L-07). `leash.quote` and `leash.maxSlippageBps` stay owner-only: clearing
///         the slippage record disables the bound.
/// @dev `grantRoles` is disabled on the deployed resolver; `grantSetterRoles` decodes a setter calldata,
///      derives the resource from the text key and grants the matching role. The resolver scopes roles per key,
///      and every agent has its own resolver, so the grant covers these two keys of this one agent: the risk
///      manager gets no power over any other agent, and holds no role on the registry.
///      Entrypoints: `run()` uses `AGENT_LABEL` (default `trader-1`); `grant(string)` takes the label.
contract GrantRiskManager is EnsScriptBase {
    // ============ External functions ============

    function run() external {
        grant(_agentLabel());
    }

    // ============ Public functions ============

    /// @param label Agent subname label, e.g. `trader-1`. Must be live: its resolver is read from the registry.
    function grant(string memory label) public {
        address riskManager = _riskManager();
        IPermissionedResolver resolver = _agentResolver(label);
        string[] memory keys = LeashOrgLib.riskManagerKeys();

        vm.startBroadcast(_ownerPk());
        resolver.multicall(LeashOrgLib.riskManagerGrantCalls(riskManager));
        vm.stopBroadcast();

        for (uint256 i = 0; i < keys.length; i++) {
            require(
                resolver.hasRoles(ResolverRoles.textResource(keys[i]), ResolverRoles.ROLE_SET_TEXT, riskManager),
                string.concat("GrantRiskManager: role missing on ", keys[i])
            );
            console2.log("GrantRiskManager: ROLE_SET_TEXT granted on", keys[i]);
        }
        require(
            !resolver.hasRoles(
                ResolverRoles.textResource(LeashOrgLib.KEY_QUOTE), ResolverRoles.ROLE_SET_TEXT, riskManager
            ),
            "GrantRiskManager: risk manager must not write leash.quote"
        );
        require(
            !resolver.hasRoles(
                ResolverRoles.textResource(LeashOrgLib.KEY_MAX_SLIPPAGE_BPS), ResolverRoles.ROLE_SET_TEXT, riskManager
            ),
            "GrantRiskManager: risk manager must not write leash.maxSlippageBps"
        );
        console2.log("GrantRiskManager: on", string.concat(label, ".", _parentName()));
        _logAddress("GrantRiskManager: agent resolver", address(resolver));
        _logAddress("GrantRiskManager: riskManager", riskManager);
    }
}
