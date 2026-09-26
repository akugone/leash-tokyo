// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {LeashEnsLib} from "../../src/libraries/LeashEnsLib.sol";
import {DeploymentsScript} from "../Deployments.sol";

/// @notice Demo act 4: the risk-manager tightens the agent's daily cap.
/// @dev Signs with `RISK_MANAGER_PK`, which only holds `ROLE_SET_TEXT` on the `leash.dailyNotional` and
///      `leash.tokens` keys of the agent's own resolver. `NEW_CAP` env var, default 1 (raw quote units), so the
///      next swap must fail. `LABEL` env var picks another agent than `agentLabel`.
///      Usage: forge script script/demo/TightenCap.s.sol --rpc-url $RPC --broadcast
contract TightenCap is DeploymentsScript {
    string internal constant KEY = "leash.dailyNotional";

    function run() external {
        string memory label = vm.envOr("LABEL", _readString("agentLabel"));
        // The agent's own resolver, as the org registry points to it.
        IPermissionedResolver resolver =
            IPermissionedResolver(IPermissionedRegistry(_readAddress("orgRegistry")).getResolver(label));
        bytes memory name = EnsNameLib.dnsEncode(label, EnsNameLib.dnsEncodeName(_readString("parentName")));
        string memory newCap = vm.toString(vm.envOr("NEW_CAP", uint256(1)));

        console2.log("before:", KEY, LeashEnsLib.readText(resolver, name, KEY));

        vm.startBroadcast(vm.envUint("RISK_MANAGER_PK"));
        resolver.setText(name, KEY, newCap);
        vm.stopBroadcast();

        console2.log("after: ", KEY, LeashEnsLib.readText(resolver, name, KEY));
    }
}
