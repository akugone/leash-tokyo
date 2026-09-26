// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {LeashOrgLib} from "../../script/ens/LeashOrgLib.sol";
import {SepoliaAddresses} from "../../script/Addresses.sol";
import {LeashHook} from "../../src/LeashHook.sol";
import {IEnhancedAccessControl} from "../../src/interfaces/ens/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {RegistryRoles} from "../../src/libraries/EnsRoles.sol";
import {LeashIntentLib, SwapIntent} from "../../src/libraries/LeashIntentLib.sol";
import {LeashTestToken} from "../../src/mocks/LeashTestToken.sol";
import {ForkEnsFixture} from "./ForkEnsFixture.sol";

/// @notice Ticket L-14: the full Leash flow on a Sepolia fork, against the real ENSv2 contracts and the real
///         Uniswap v4 PoolManager and test routers. Only the hook and the two demo tokens are deployed here.
/// @dev Test code uses `vm.getBlockTimestamp()` rather than `block.timestamp`: via-IR may cache the latter
///      across `vm.warp`.
contract LeashHookForkTest is ForkEnsFixture {
    using PoolIdLibrary for PoolKey;

    // ============ Constants ============

    uint256 internal constant CAP = 250e18;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336;
    int256 internal constant LIQUIDITY_DELTA = 10_000e18;
    uint256 internal constant OWNER_MINT = 1_000_000e18;
    uint256 internal constant AGENT_MINT = 100_000e18;

    // ============ Handles ============

    IPoolManager internal poolManager = IPoolManager(SepoliaAddresses.UNI_POOL_MANAGER);
    PoolSwapTest internal swapRouter = PoolSwapTest(SepoliaAddresses.UNI_POOL_SWAP_TEST);
    PoolModifyLiquidityTest internal liquidityRouter =
        PoolModifyLiquidityTest(SepoliaAddresses.UNI_POOL_MODIFY_LIQUIDITY_TEST);

    LeashHook internal hook;
    LeashTestToken internal token0;
    LeashTestToken internal token1;
    PoolKey internal key;
    PoolId internal poolId;
    uint256 internal agentId;

    function setUp() public {
        _forkSepolia();

        // Demo tokens first: the policy references them.
        LeashTestToken lUSD = new LeashTestToken("Leash USD", "lUSD");
        LeashTestToken lETH = new LeashTestToken("Leash Wrapped ETH", "lETH");
        (token0, token1) = address(lUSD) < address(lETH) ? (lUSD, lETH) : (lETH, lUSD);

        // Real ENSv2: parent name, org registry and resolver, agent subname with the real policy, risk manager.
        // Quote is token0 so an exact input zeroForOne swap spends exactly `amountSpecified` of quote.
        address[] memory tokens = new address[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);
        setUpEns(address(token0), CAP, tokens);
        agentId = EnsNameLib.labelId(agentLabel);

        // Hook against the real PoolManager, etched at an address carrying the beforeSwap | afterSwap flags.
        address flagged = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG) ^ (0x4444 << 144));
        deployCodeTo("LeashHook.sol:LeashHook", abi.encode(poolManager, orgRegistry, parentName), flagged);
        hook = LeashHook(flagged);

        // Pool and liquidity through the real routers, from the owner.
        key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        poolId = key.toId();

        vm.startPrank(owner);
        poolManager.initialize(key, SQRT_PRICE_1_1);
        token0.mint(owner, OWNER_MINT);
        token1.mint(owner, OWNER_MINT);
        token0.approve(address(liquidityRouter), type(uint256).max);
        token1.approve(address(liquidityRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -887_220, tickUpper: 887_220, liquidityDelta: LIQUIDITY_DELTA, salt: 0}),
            ""
        );
        token0.mint(agent, AGENT_MINT);
        token1.mint(agent, AGENT_MINT);
        vm.stopPrank();

        vm.startPrank(agent);
        token0.approve(address(swapRouter), type(uint256).max);
        token1.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();

        vm.label(address(hook), "LeashHook");
        vm.label(address(token0), "token0");
        vm.label(address(token1), "token1");
        vm.label(address(poolManager), "PoolManager");
        vm.label(address(swapRouter), "PoolSwapTest");
        vm.label(address(liquidityRouter), "PoolModifyLiquidityTest");
    }

    // ============ Swap Tests ============

    function test_Swap_WithinCap() public {
        assertEq(hook.remainingToday(agentLabel), CAP, "remaining before");
        SwapIntent memory intent = _intent(agentNode, -int256(100e18), 0);
        bytes memory hookData = _signedHookData(agentLabel, intent, agentPk);

        vm.expectEmit(true, true, true, true, address(hook));
        emit LeashHook.LeashSwap(agentNode, agent, poolId, 100e18, 100e18);
        BalanceDelta delta = _swapAs(agent, intent, hookData);

        assertEq(int256(delta.amount0()), -int256(100e18), "quote delta");
        assertEq(hook.spentToday(agentNode), 100e18, "spentToday");
        assertEq(hook.remainingToday(agentLabel), CAP - 100e18, "remaining after");
        assertEq(hook.nonces(agentNode), 1, "nonce");
    }

    function test_RevertWhen_Swap_DailyCapExceeded() public {
        _swap(-int256(100e18), 0);
        _swap(-int256(100e18), 1);
        SwapIntent memory intent = _intent(agentNode, -int256(100e18), 2);
        bytes memory hookData = _signedHookData(agentLabel, intent, agentPk);
        _expectHookRevert(
            IHooks.afterSwap.selector,
            abi.encodeWithSelector(LeashHook.DailyCapExceeded.selector, agentNode, uint256(300e18), CAP)
        );
        _swapAs(agent, intent, hookData);
    }

    function test_RevertWhen_Swap_BadSignature() public {
        uint256 strangerPk = uint256(keccak256("leash.fixture.stranger"));
        SwapIntent memory intent = _intent(agentNode, -int256(10e18), 0);
        bytes memory hookData = _signedHookData(agentLabel, intent, strangerPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(LeashHook.BadSignature.selector, agent, vm.addr(strangerPk))
        );
        _swapAs(agent, intent, hookData);
    }

    function test_RevertWhen_Swap_ReplayedNonce() public {
        SwapIntent memory intent = _intent(agentNode, -int256(10e18), 0);
        bytes memory hookData = _signedHookData(agentLabel, intent, agentPk);
        _swapAs(agent, intent, hookData);
        assertEq(hook.nonces(agentNode), 1, "nonce consumed");

        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.BadNonce.selector, agentNode, 1, 0)
        );
        _swapAs(agent, intent, hookData);
    }

    function test_RevertWhen_Swap_IntentMismatch() public {
        SwapIntent memory signed = _intent(agentNode, -int256(10e18), 0);
        bytes memory hookData = _signedHookData(agentLabel, signed, agentPk);
        SwapIntent memory swapped = _intent(agentNode, -int256(20e18), 0);
        _expectHookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.IntentMismatch.selector));
        _swapAs(agent, swapped, hookData);
    }

    function test_RevertWhen_Swap_TokenNotAllowed() public {
        address[] memory onlyToken0 = new address[](1);
        onlyToken0[0] = address(token0);
        vm.prank(riskManager);
        agentResolver.setText(agentDnsName, LeashOrgLib.KEY_TOKENS, LeashOrgLib.tokenListString(onlyToken0));

        SwapIntent memory intent = _intent(agentNode, -int256(10e18), 0);
        bytes memory hookData = _signedHookData(agentLabel, intent, agentPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.TokenNotAllowed.selector, address(token1))
        );
        _swapAs(agent, intent, hookData);
    }

    function test_RevertWhen_Swap_LeashRevoked() public {
        SwapIntent memory intent = _intent(agentNode, -int256(10e18), 0);
        bytes memory hookData = _signedHookData(agentLabel, intent, agentPk);

        vm.prank(owner);
        orgRegistry.unregister(agentId);
        uint64 expiry = orgRegistry.getExpiry(agentId);
        assertLe(expiry, vm.getBlockTimestamp(), "unregister expires the name");

        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.LeashRevoked.selector, agentNode, expiry)
        );
        _swapAs(agent, intent, hookData);
    }

    function test_RevertWhen_Swap_Expired() public {
        string memory label = "trader-2";
        uint64 ttl = 180;
        _issueAgent(label, ttl, address(token0), CAP, policyTokens);
        bytes32 node = EnsNameLib.namehash(string.concat(label, ".", parentName));
        uint256 labelId = EnsNameLib.labelId(label);

        // Alive: a swap under the short lived name goes through.
        SwapIntent memory first = _intent(node, -int256(10e18), 0);
        _swapAs(agent, first, _signedHookData(label, first, agentPk));
        assertEq(hook.spentToday(node), 10e18, "spent while alive");

        vm.warp(vm.getBlockTimestamp() + ttl + 1);
        uint64 expiry = orgRegistry.getExpiry(labelId);
        assertLe(expiry, vm.getBlockTimestamp(), "expired");

        SwapIntent memory second = _intent(node, -int256(10e18), 1);
        bytes memory hookData = _signedHookData(label, second, agentPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.LeashRevoked.selector, node, expiry)
        );
        _swapAs(agent, second, hookData);
    }

    function test_Swap_AfterRiskManagerTightensCap() public {
        _swap(-int256(100e18), 0);
        assertEq(hook.spentToday(agentNode), 100e18, "first swap");

        uint256 newCap = 150e18;
        vm.prank(riskManager);
        agentResolver.setText(agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL, LeashOrgLib.capString(newCap));
        assertEq(hook.remainingToday(agentLabel), newCap - 100e18, "remaining under new cap");

        SwapIntent memory intent = _intent(agentNode, -int256(100e18), 1);
        bytes memory hookData = _signedHookData(agentLabel, intent, agentPk);
        _expectHookRevert(
            IHooks.afterSwap.selector,
            abi.encodeWithSelector(LeashHook.DailyCapExceeded.selector, agentNode, uint256(200e18), newCap)
        );
        _swapAs(agent, intent, hookData);
    }

    // ============ RiskManager Tests ============

    function test_RevertWhen_RiskManager_Unregister() public {
        IPermissionedRegistry.State memory state = orgRegistry.getState(agentId);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                state.resource,
                RegistryRoles.ROLE_UNREGISTER,
                riskManager
            )
        );
        vm.prank(riskManager);
        orgRegistry.unregister(agentId);

        // The leash still holds: the agent keeps swapping.
        _swap(-int256(10e18), 0);
        assertEq(hook.spentToday(agentNode), 10e18, "swap after failed unregister");
    }

    // ============ Helpers ============

    function _intent(bytes32 node, int256 amountSpecified, uint256 nonce) internal view returns (SwapIntent memory) {
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

    /// @dev Exact input zeroForOne swap of the default agent name, signed by the agent with `nonce`.
    function _swap(int256 amountSpecified, uint256 nonce) internal returns (BalanceDelta) {
        SwapIntent memory intent = _intent(agentNode, amountSpecified, nonce);
        return _swapAs(agent, intent, _signedHookData(agentLabel, intent, agentPk));
    }

    /// @dev Swap the parameters described by `intent` through the real PoolSwapTest as `from`. This is the only
    ///      external call after `_expectHookRevert`, so build `hookData` before expecting a revert.
    function _swapAs(address from, SwapIntent memory intent, bytes memory hookData) internal returns (BalanceDelta) {
        vm.prank(from);
        return swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: intent.zeroForOne,
                amountSpecified: intent.amountSpecified,
                sqrtPriceLimitX96: intent.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
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
}
