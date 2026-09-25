// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {LeashHook} from "../src/LeashHook.sol";
import {IPermissionedRegistry} from "../src/interfaces/ens/IPermissionedRegistry.sol";
import {SepoliaAddresses} from "./Addresses.sol";
import {DeploymentsScript} from "./Deployments.sol";

/// @notice Deploys `LeashHook` on Sepolia at a CREATE2 address carrying the `BEFORE_SWAP | AFTER_SWAP` flags.
/// @dev Reads `orgRegistry` and `parentName` from the deployments JSON, writes `hook`.
///      Run: `forge script script/DeployHook.s.sol --rpc-url sepolia --broadcast --verify`.
contract DeployHook is DeploymentsScript {
    uint160 internal constant FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);

    // ============ External functions ============

    function run() external {
        IPoolManager poolManager = IPoolManager(SepoliaAddresses.UNI_POOL_MANAGER);
        IPermissionedRegistry orgRegistry = IPermissionedRegistry(_readAddress("orgRegistry"));
        string memory parentName = _readString("parentName");

        bytes memory constructorArgs = abi.encode(poolManager, orgRegistry, parentName);
        (address expected, bytes32 salt) =
            HookMiner.find(SepoliaAddresses.CREATE2_DEPLOYER, FLAGS, type(LeashHook).creationCode, constructorArgs);

        vm.startBroadcast(vm.envUint("OWNER_PK"));
        LeashHook hook = new LeashHook{salt: salt}(poolManager, orgRegistry, parentName);
        vm.stopBroadcast();

        require(address(hook) == expected, "DeployHook: address mismatch");
        _writeAddress("hook", address(hook));

        console.log("LeashHook deployed at", address(hook));
        console.log("  salt", vm.toString(salt));
        console.log("  orgRegistry", address(orgRegistry));
        console.log("  parentName", parentName);
        console.log("  parentNode", vm.toString(hook.PARENT_NODE()));
    }
}
