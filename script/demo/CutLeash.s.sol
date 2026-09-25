// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {DeploymentsScript} from "../Deployments.sol";

/// @notice Demo act 5: the owner cuts the leash. One transaction, the agent is dead on the next swap.
/// @dev `unregister` sets the subname expiry to `block.timestamp` and burns the token. The hook reads
///      `getExpiry(labelId) > block.timestamp` on every swap, so no other state needs to change.
///      Usage: forge script script/demo/CutLeash.s.sol --rpc-url $RPC --broadcast
///      Optional: LABEL env var to cut another subname than `agentLabel`.
contract CutLeash is DeploymentsScript {
    function run() external {
        IPermissionedRegistry registry = IPermissionedRegistry(_readAddress("orgRegistry"));
        string memory label = vm.envOr("LABEL", _readString("agentLabel"));
        uint256 labelId = EnsNameLib.labelId(label);

        console2.log("cutting", string.concat(label, ".", _readString("parentName")));
        console2.log("expiry before:", registry.getExpiry(labelId));
        console2.log("resolver before:", registry.getResolver(label));

        vm.startBroadcast(vm.envUint("OWNER_PK"));
        registry.unregister(labelId);
        vm.stopBroadcast();

        console2.log("expiry after: ", registry.getExpiry(labelId));
        console2.log("resolver after: ", registry.getResolver(label));
        require(registry.getResolver(label) == address(0), "leash still attached");
    }
}
