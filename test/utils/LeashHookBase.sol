// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {LeashHook} from "../../src/LeashHook.sol";
import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {LeashIntentLib, SwapIntent} from "../../src/libraries/LeashIntentLib.sol";
import {MockRegistry} from "../mocks/MockRegistry.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

/// @notice Shared fixture: a Leash hook on a v4 pool, mock ENS registry and resolver, one agent with a policy.
/// @dev Uses `vm.getBlockTimestamp()` instead of `block.timestamp` in test code: via-IR may cache
///      `block.timestamp` within a call, which breaks `vm.warp` in the middle of a test.
abstract contract LeashHookBase is Deployers {
    string internal constant PARENT_NAME = "acme.eth";
    string internal constant LABEL = "trader-1";
    uint256 internal constant CAP = 1000e18;
    uint64 internal constant NAME_DURATION = 7 days;
    uint256 internal constant MAX_SLIPPAGE_BPS = 100;

    LeashHook internal hook;
    MockRegistry internal registry;
    MockResolver internal resolver;
    PoolId internal poolId;

    uint256 internal agentPk = 0xA11CE;
    address internal agent;
    uint64 internal expiry;
    bytes32 internal node;
    bytes internal dnsName;
    address internal token0;
    address internal token1;

    function setUp() public virtual {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        token0 = Currency.unwrap(currency0);
        token1 = Currency.unwrap(currency1);

        agent = vm.addr(agentPk);
        expiry = uint64(vm.getBlockTimestamp() + NAME_DURATION);

        registry = new MockRegistry();
        resolver = new MockResolver();
        registry.setName(LABEL, expiry, address(resolver));

        address flagged = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG) ^ (0x4444 << 144));
        deployCodeTo(
            "LeashHook.sol:LeashHook",
            abi.encode(manager, IPermissionedRegistry(address(registry)), PARENT_NAME),
            flagged
        );
        hook = LeashHook(flagged);

        (dnsName, node) = hook.agentName(LABEL);
        resolver.setAddr(dnsName, agent);
        resolver.setText(dnsName, hook.KEY_QUOTE(), vm.toString(token0));
        resolver.setText(dnsName, hook.KEY_DAILY_NOTIONAL(), vm.toString(CAP));
        resolver.setText(dnsName, hook.KEY_TOKENS(), _tokenList(token0, token1));

        (key, poolId) = initPoolAndAddLiquidity(currency0, currency1, IHooks(hook), 3000, SQRT_PRICE_1_1);
        // Deep full range liquidity so exact input swaps up to the cap consume the whole input.
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 10_000e18, salt: 0}),
            ZERO_BYTES
        );

        vm.label(address(this), "owner");
        vm.label(agent, "agent");
        vm.label(address(hook), "LeashHook");
        vm.label(address(registry), "MockRegistry");
        vm.label(address(resolver), "MockResolver");
        vm.label(address(manager), "PoolManager");
        vm.label(address(swapRouter), "PoolSwapTest");
        vm.label(address(modifyLiquidityRouter), "PoolModifyLiquidityTest");
        vm.label(token0, "currency0");
        vm.label(token1, "currency1");
    }

    // ============ Helpers ============

    function _intent(int256 amountSpecified, uint256 nonce) internal view returns (SwapIntent memory) {
        return SwapIntent({
            node: node,
            poolId: PoolId.unwrap(poolId),
            zeroForOne: true,
            amountSpecified: amountSpecified,
            nonce: nonce,
            deadline: vm.getBlockTimestamp() + 1 hours
        });
    }

    function _signedHookData(string memory label, SwapIntent memory intent, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = LeashIntentLib.digest(hook.DOMAIN_SEPARATOR(), intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return LeashIntentLib.encodeHookData(label, intent, abi.encodePacked(r, s, v));
    }

    /// @dev PoolManager wraps hook reverts in `CustomRevert.WrappedError(hook, hookSelector, reason, HookCallFailed)`.
    function _expectHookRevert(bytes4 hookSelector, bytes memory reason) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                hookSelector,
                reason,
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
    }

    function _tokenList(address a, address b) internal pure returns (string memory) {
        return string.concat(vm.toString(a), ",", vm.toString(b));
    }
}
