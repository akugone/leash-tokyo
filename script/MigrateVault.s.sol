// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {LeashHook} from "../src/LeashHook.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {SepoliaAddresses} from "./Addresses.sol";
import {DeploymentsScript} from "./Deployments.sol";

/// @notice Replaces the org vault with a fresh build of `LeashVault` and moves every pool token over.
/// @dev Reads `hook`, `vault`, `token0`, `token1` from the deployments JSON; writes the new `vault` and keeps the
///      old one as `vaultPrevious`, whose past events stay on chain. The owner signs all three transactions: the
///      deploy and one `withdraw` per token (withdraw is owner only on the old vault).
///      Run: `LEASH_NETWORK=sepolia script/demo.sh migrate-vault`.
contract MigrateVault is DeploymentsScript {
    function run() external {
        LeashHook hook = LeashHook(_readAddress("hook"));
        LeashVault previous = LeashVault(_readAddress("vault"));
        IERC20 token0 = IERC20(_readAddress("token0"));
        IERC20 token1 = IERC20(_readAddress("token1"));
        uint256 ownerPk = vm.envUint("OWNER_PK");
        address owner = vm.addr(ownerPk);
        require(previous.owner() == owner, "MigrateVault: OWNER_PK does not own the current vault");

        uint256 amount0 = token0.balanceOf(address(previous));
        uint256 amount1 = token1.balanceOf(address(previous));

        vm.startBroadcast(ownerPk);
        LeashVault vault = new LeashVault(hook, PoolSwapTest(SepoliaAddresses.UNI_POOL_SWAP_TEST), owner);
        if (amount0 > 0) previous.withdraw(token0, address(vault), amount0);
        if (amount1 > 0) previous.withdraw(token1, address(vault), amount1);
        vm.stopBroadcast();

        require(token0.balanceOf(address(vault)) == amount0, "MigrateVault: token0 not moved");
        require(token1.balanceOf(address(vault)) == amount1, "MigrateVault: token1 not moved");
        _writeAddress("vaultPrevious", address(previous));
        _writeAddress("vault", address(vault));

        console.log("previous vault", address(previous));
        console.log("new vault", address(vault));
        console.log("token0 moved", amount0);
        console.log("token1 moved", amount1);
    }
}
