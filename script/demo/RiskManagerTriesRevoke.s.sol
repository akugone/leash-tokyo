// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IEnhancedAccessControl} from "../../src/interfaces/ens/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {DeploymentsScript} from "../Deployments.sol";

/// @notice Demo act 4, second beat: the risk-manager tries to do what only the owner may do.
/// @dev Both attempts are expected to revert with `EACUnauthorizedAccountRoles`. The script uses static calls so
///      it never needs `--broadcast`; it prints PASS when Enhanced Access Control rejected the call.
///      Usage: forge script script/demo/RiskManagerTriesRevoke.s.sol --rpc-url $RPC
contract RiskManagerTriesRevoke is DeploymentsScript {
    function run() external {
        address riskManager = vm.addr(vm.envUint("RISK_MANAGER_PK"));
        IPermissionedRegistry registry = IPermissionedRegistry(_readAddress("orgRegistry"));
        IPermissionedResolver resolver = IPermissionedResolver(_readAddress("orgResolver"));
        string memory label = _readString("agentLabel");
        bytes memory name = EnsNameLib.dnsEncode(label, EnsNameLib.dnsEncodeName(_readString("parentName")));

        // 1. Revoke the agent: registry says no, the risk-manager holds no registry role at all.
        vm.prank(riskManager);
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeCall(IPermissionedRegistry.unregister, (EnsNameLib.labelId(label))));
        _report("unregister(trader) by risk-manager", ok, ret);

        // 2. Re-point the agent address: resolver says no, ROLE_SET_ADDRESS was never granted.
        vm.prank(riskManager);
        (ok, ret) = address(resolver)
            .call(abi.encodeCall(IPermissionedResolver.setAddress, (name, 60, abi.encodePacked(riskManager))));
        _report("setAddress(agent) by risk-manager", ok, ret);

        // 3. Change the quote token: resolver says no, only leash.dailyNotional and leash.tokens are delegated.
        vm.prank(riskManager);
        (ok, ret) = address(resolver)
            .call(abi.encodeCall(IPermissionedResolver.setText, (name, "leash.quote", vm.toString(riskManager))));
        _report("setText(leash.quote) by risk-manager", ok, ret);
    }

    function _report(string memory what, bool ok, bytes memory ret) internal pure {
        if (ok) {
            console2.log("FAIL", what, "-> unexpectedly succeeded");
            revert("risk-manager should not be able to do this");
        }
        bytes4 selector = bytes4(ret);
        if (selector == IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector) {
            console2.log("PASS", what, "-> EACUnauthorizedAccountRoles");
        } else {
            console2.log("PASS", what, "-> reverted with selector", vm.toString(selector));
        }
    }
}
