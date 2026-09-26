// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {LeashHook} from "../src/LeashHook.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {LeashTestToken} from "../src/mocks/LeashTestToken.sol";
import {SepoliaAddresses} from "./Addresses.sol";
import {DeploymentsScript} from "./Deployments.sol";

/// @notice Deploys the two demo tokens, initializes the hooked pool at 1:1, seeds liquidity, deploys the org vault
///         and funds it. The agent holds no tokens: it signs intents and trades through the vault.
/// @dev Reads `hook` from the deployments JSON, writes token0, token1, quote, fee, tickSpacing, poolId, vault.
///      Run: `forge script script/SetupPool.s.sol --rpc-url sepolia --broadcast`.
contract SetupPool is DeploymentsScript {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    /// @dev sqrt(1) * 2^96, price 1:1.
    uint160 internal constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336;
    int24 internal constant TICK_LOWER = -887_220;
    int24 internal constant TICK_UPPER = 887_220;
    /// @dev Deep enough that a 300 lUSD swap moves the price about 0.3%, well inside the 1% `leash.maxSlippageBps`.
    int256 internal constant LIQUIDITY_DELTA = 200_000e18;
    uint256 internal constant OWNER_MINT = 1_000_000e18;
    uint256 internal constant VAULT_MINT = 100_000e18;

    // ============ External functions ============

    function run() external {
        IHooks hook = IHooks(_readAddress("hook"));
        uint256 ownerPk = vm.envUint("OWNER_PK");
        address owner = vm.addr(ownerPk);
        IPoolManager poolManager = IPoolManager(SepoliaAddresses.UNI_POOL_MANAGER);
        PoolModifyLiquidityTest liquidityRouter =
            PoolModifyLiquidityTest(SepoliaAddresses.UNI_POOL_MODIFY_LIQUIDITY_TEST);

        // ---- Owner: tokens, pool, liquidity, vault ----
        vm.startBroadcast(ownerPk);

        LeashTestToken lUSD = new LeashTestToken("Leash USD", "lUSD");
        LeashTestToken lETH = new LeashTestToken("Leash Wrapped ETH", "lETH");
        (LeashTestToken token0, LeashTestToken token1) = address(lUSD) < address(lETH) ? (lUSD, lETH) : (lETH, lUSD);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
        poolManager.initialize(key, SQRT_PRICE_1_1);

        token0.mint(owner, OWNER_MINT);
        token1.mint(owner, OWNER_MINT);
        token0.approve(address(liquidityRouter), type(uint256).max);
        token1.approve(address(liquidityRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: LIQUIDITY_DELTA, salt: 0
            }),
            ""
        );

        LeashVault vault =
            new LeashVault(LeashHook(address(hook)), PoolSwapTest(SepoliaAddresses.UNI_POOL_SWAP_TEST), owner);
        token0.mint(address(vault), VAULT_MINT);
        token1.mint(address(vault), VAULT_MINT);

        vm.stopBroadcast();

        // ---- Record ----
        PoolId poolId = key.toId();
        _writeAddress("token0", address(token0));
        _writeAddress("token1", address(token1));
        _writeAddress("quote", address(lUSD));
        _writeUint("fee", FEE);
        _writeUint("tickSpacing", uint256(int256(TICK_SPACING)));
        _writeBytes32("poolId", PoolId.unwrap(poolId));
        _writeAddress("vault", address(vault));

        console.log("lUSD (quote)", address(lUSD));
        console.log("lETH", address(lETH));
        console.log("token0", address(token0));
        console.log("token1", address(token1));
        console.log("hook", address(hook));
        console.log("fee", uint256(FEE));
        console.log("tickSpacing", uint256(int256(TICK_SPACING)));
        console.log("poolId", vm.toString(PoolId.unwrap(poolId)));
        console.log("vault", address(vault));
        console.log("owner", owner);
    }
}
