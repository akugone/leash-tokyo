// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {LeashHook} from "../src/LeashHook.sol";
import {EnsNameLib} from "../src/libraries/EnsNameLib.sol";
import {LeashIntentLib, SwapIntent} from "../src/libraries/LeashIntentLib.sol";
import {LeashPolicyLib} from "../src/libraries/LeashPolicyLib.sol";
import {LeashHookBase} from "./utils/LeashHookBase.sol";

contract LeashHookTest is LeashHookBase {
    using StateLibrary for IPoolManager;

    // ============ Constructor Tests ============

    function test_Constructor() public view {
        assertEq(address(hook.ORG_REGISTRY()), address(registry));
        assertEq(hook.PARENT_NODE(), EnsNameLib.namehash(PARENT_NAME));
        assertEq(hook.parentDnsName(), EnsNameLib.dnsEncodeName(PARENT_NAME));
        assertEq(hook.DOMAIN_SEPARATOR(), LeashIntentLib.domainSeparator(address(hook)));
    }

    // ============ getHookPermissions Tests ============

    function test_GetHookPermissions() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeSwap);
        assertTrue(p.afterSwap);
        assertFalse(p.beforeInitialize);
        assertFalse(p.afterInitialize);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);
        assertFalse(p.beforeSwapReturnDelta);
        assertFalse(p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta);
        assertFalse(p.afterRemoveLiquidityReturnDelta);
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
    }

    // ============ remainingToday Tests ============

    function test_RemainingToday() public {
        assertEq(hook.remainingToday(LABEL), CAP);
        _swap(-int256(400e18), 0);
        assertEq(hook.remainingToday(LABEL), CAP - 400e18);
    }

    function test_RemainingToday_ZeroWhenRevoked() public {
        registry.revoke(LABEL);
        assertEq(hook.remainingToday(LABEL), 0);
    }

    function test_RemainingToday_ZeroWhenNoResolver() public {
        registry.setName(LABEL, expiry, address(0));
        assertEq(hook.remainingToday(LABEL), 0);
    }

    function test_RemainingToday_ZeroWhenCapExhausted() public {
        _swap(-int256(CAP), 0);
        assertEq(hook.remainingToday(LABEL), 0);
    }

    // ============ policy Tests ============

    function test_Policy() public view {
        (address agent_, address quote, uint256 cap, address[] memory tokens, uint64 expiry_) = hook.policy(LABEL);
        assertEq(agent_, agent);
        assertEq(quote, token0);
        assertEq(cap, CAP);
        assertEq(tokens.length, 2);
        assertEq(tokens[0], token0);
        assertEq(tokens[1], token1);
        assertEq(expiry_, expiry);
    }

    function test_RevertWhen_Policy_LeashRevoked() public {
        registry.revoke(LABEL);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(LeashHook.LeashRevoked.selector, node, now_));
        hook.policy(LABEL);
    }

    function test_RevertWhen_Policy_NoResolver() public {
        registry.setName(LABEL, expiry, address(0));
        vm.expectRevert(abi.encodeWithSelector(LeashHook.NoResolver.selector, node));
        hook.policy(LABEL);
    }

    // ============ hashIntent Tests ============

    function test_HashIntent() public view {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        assertEq(hook.hashIntent(intent), LeashIntentLib.digest(hook.DOMAIN_SEPARATOR(), intent));
    }

    // ============ spentToday / currentDay Tests ============

    function test_SpentToday_StartsAtZero() public view {
        assertEq(hook.spentToday(node), 0);
        assertEq(hook.currentDay(), vm.getBlockTimestamp() / 1 days);
    }

    // ============ agentName Tests ============

    function test_AgentName() public view {
        (bytes memory dns, bytes32 n) = hook.agentName(LABEL);
        assertEq(dns, EnsNameLib.dnsEncodeName("trader-1.leash.eth"));
        assertEq(n, EnsNameLib.namehash("trader-1.leash.eth"));
    }

    // ============ beforeSwap / afterSwap (swap) Tests ============

    function test_Swap_WithinCap() public {
        int256 amount = -int256(100e18);
        SwapIntent memory intent = _intent(amount, 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);

        vm.expectEmit(true, true, true, true, address(hook));
        emit LeashHook.LeashSwap(node, agent, poolId, 100e18, 100e18);
        BalanceDelta delta = _swapRaw(intent, hookData);

        assertEq(int256(delta.amount0()), amount);
        assertEq(hook.spentToday(node), 100e18);
        assertEq(hook.spent(node, hook.currentDay()), 100e18);
        assertEq(hook.nonces(node), 1);
    }

    function test_Swap_TwiceWithinCap() public {
        _swap(-int256(400e18), 0);
        _swap(-int256(500e18), 1);
        assertEq(hook.spentToday(node), 900e18);
        assertEq(hook.nonces(node), 2);
    }

    function test_Swap_QuoteIsCurrency1() public {
        resolver.setText(dnsName, hook.KEY_QUOTE(), vm.toString(token1));
        // Exact input of currency1 (oneForZero) so the quote delta is exactly the input.
        SwapIntent memory intent = _intent(-int256(300e18), 0);
        intent.zeroForOne = false;
        _swapRaw(intent, _signedHookData(LABEL, intent, agentPk));
        assertEq(hook.spentToday(node), 300e18);
    }

    function test_Swap_CounterResetsNextDay() public {
        _swap(-int256(600e18), 0);
        uint256 day = hook.currentDay();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(hook.currentDay(), day + 1);
        assertEq(hook.spentToday(node), 0);
        _swap(-int256(600e18), 1);
        assertEq(hook.spentToday(node), 600e18);
        assertEq(hook.spent(node, day), 600e18);
    }

    function test_RevertWhen_Swap_DailyCapExceeded() public {
        _swap(-int256(400e18), 0);
        _swap(-int256(500e18), 1);
        SwapIntent memory intent = _intent(-int256(200e18), 2);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        _expectHookRevert(
            IHooks.afterSwap.selector,
            abi.encodeWithSelector(LeashHook.DailyCapExceeded.selector, node, uint256(1100e18), CAP)
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_NodeMismatch() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        intent.node = keccak256("other");
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.NodeMismatch.selector, node, intent.node)
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_LeashRevoked() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        registry.revoke(LABEL);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.LeashRevoked.selector, node, now_)
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_Expired() public {
        vm.warp(expiry);
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.LeashRevoked.selector, node, expiry)
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_NoResolver() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        registry.setName(LABEL, expiry, address(0));
        _expectHookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.NoResolver.selector, node));
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_NoAgent() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        resolver.setAddr(dnsName, address(0));
        _expectHookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.NoAgent.selector, node));
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_IntentExpired() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        intent.deadline = vm.getBlockTimestamp() - 1;
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(LeashHook.IntentExpired.selector, intent.deadline, vm.getBlockTimestamp())
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_BadNonce() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        _swapRaw(intent, hookData);
        assertEq(hook.nonces(node), 1);

        _expectHookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.BadNonce.selector, node, 1, 0));
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_IntentMismatch() public {
        SwapIntent memory signed = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, signed, agentPk);
        SwapIntent memory swapped = _intent(-int256(2e18), 0);
        _expectHookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.IntentMismatch.selector));
        _swapRaw(swapped, hookData);
    }

    function test_RevertWhen_Swap_BadSignature() public {
        uint256 otherPk = 0xB0B;
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, otherPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.BadSignature.selector, agent, vm.addr(otherPk))
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_TokenNotAllowed() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        resolver.setText(dnsName, hook.KEY_TOKENS(), vm.toString(token0));
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.TokenNotAllowed.selector, token1)
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_QuoteNotInPool() public {
        address stranger = makeAddr("stranger");
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        resolver.setText(dnsName, hook.KEY_QUOTE(), vm.toString(stranger));
        _expectHookRevert(
            IHooks.afterSwap.selector, abi.encodeWithSelector(LeashHook.QuoteNotInPool.selector, stranger)
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_InvalidRecord() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        string memory keyName = hook.KEY_DAILY_NOTIONAL();
        resolver.setText(dnsName, keyName, "abc");
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, keyName)
        );
        _swapRaw(intent, hookData);
    }

    function testFuzz_Swap_WithinCap(uint256 amount) public {
        amount = bound(amount, 1, CAP);
        // forge-lint: disable-next-line(unsafe-typecast)
        _swap(-int256(amount), 0);
        assertEq(hook.spentToday(node), amount);
        assertEq(hook.remainingToday(LABEL), CAP - amount);
        assertEq(hook.nonces(node), 1);
    }

    // ============ Slippage Tests ============

    function test_MaxSlippageBps_NotEnforcedWhenEmpty() public view {
        (bool enforced, uint256 bps) = hook.maxSlippageBps(LABEL);
        assertFalse(enforced);
        assertEq(bps, 0);
    }

    function test_MaxSlippageBps() public {
        _setMaxSlippage("100");
        (bool enforced, uint256 bps) = hook.maxSlippageBps(LABEL);
        assertTrue(enforced);
        assertEq(bps, 100);
    }

    function test_RevertWhen_MaxSlippageBps_LeashRevoked() public {
        registry.revoke(LABEL);
        vm.expectRevert(abi.encodeWithSelector(LeashHook.LeashRevoked.selector, node, uint64(vm.getBlockTimestamp())));
        hook.maxSlippageBps(LABEL);
    }

    function test_PriceLimit() public view {
        // Pool starts at price 1: sqrtPriceX96 = 2^96. 1% down is sqrt(0.99), 1% up is sqrt(1.01).
        assertApproxEqRel(hook.priceLimit(poolId, true, 100), uint256(SQRT_PRICE_1_1) * 994_987 / 1_000_000, 1e12);
        assertApproxEqRel(hook.priceLimit(poolId, false, 100), uint256(SQRT_PRICE_1_1) * 1_004_987 / 1_000_000, 1e12);
        assertEq(hook.priceLimit(poolId, true, 0), SQRT_PRICE_1_1);
        assertEq(hook.priceLimit(poolId, false, 0), SQRT_PRICE_1_1);
    }

    function test_PriceLimit_WholeRange() public view {
        assertEq(hook.priceLimit(poolId, true, 9999), uint256(SQRT_PRICE_1_1) / 100);
        assertEq(hook.priceLimit(poolId, true, 10_000), TickMath.MIN_SQRT_PRICE + 1);
        assertEq(hook.priceLimit(poolId, true, type(uint256).max), TickMath.MIN_SQRT_PRICE + 1);
    }

    function test_PriceLimit_ClampedAtMaxPrice() public {
        // From a high price, a huge move up lands past MAX_SQRT_PRICE and is clamped.
        (, PoolId highId) = initPool(currency0, currency1, IHooks(hook), 500, TickMath.getSqrtPriceAtTick(800_000));
        assertEq(hook.priceLimit(highId, false, type(uint256).max), TickMath.MAX_SQRT_PRICE - 1);
    }

    function testFuzz_PriceLimit_NeverReverts(bool zeroForOne, uint256 bps) public view {
        uint160 limit = hook.priceLimit(poolId, zeroForOne, bps);
        assertGt(limit, TickMath.MIN_SQRT_PRICE);
        assertLt(limit, TickMath.MAX_SQRT_PRICE);
    }

    function test_Swap_NoSlippageRecordAcceptsAnyLimit() public {
        _swap(-int256(1e18), 0);
        assertEq(hook.nonces(node), 1);
    }

    function test_Swap_AtPolicyLimit() public {
        _setMaxSlippage("100");
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        _swapWithLimit(intent, _signedHookData(LABEL, intent, agentPk), hook.priceLimit(poolId, true, MAX_SLIPPAGE_BPS));
        assertEq(hook.spentToday(node), 1e18);
    }

    function test_Swap_TighterThanPolicy() public {
        _setMaxSlippage("100");
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        _swapWithLimit(intent, _signedHookData(LABEL, intent, agentPk), hook.priceLimit(poolId, true, 30));
        assertEq(hook.spentToday(node), 1e18);
    }

    function test_Swap_OneForZeroAtPolicyLimit() public {
        _setMaxSlippage("100");
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        intent.zeroForOne = false;
        _swapWithLimit(
            intent, _signedHookData(LABEL, intent, agentPk), hook.priceLimit(poolId, false, MAX_SLIPPAGE_BPS)
        );
        assertGt(hook.spentToday(node), 0);
    }

    /// @dev A limit inside the bound stops the swap there: exact input is filled partially, the cap counts what moved.
    function test_Swap_PartialFillStopsAtLimit() public {
        _setMaxSlippage("100");
        uint160 limit = hook.priceLimit(poolId, true, 10);
        SwapIntent memory intent = _intent(-int256(CAP), 0);
        _swapWithLimit(intent, _signedHookData(LABEL, intent, agentPk), limit);
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(poolId);
        assertEq(sqrtPriceX96, limit);
        assertGt(hook.spentToday(node), 0);
        assertLt(hook.spentToday(node), CAP);
    }

    function test_RevertWhen_Swap_SlippageTooLoose() public {
        _setMaxSlippage("100");
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        uint160 bound = hook.priceLimit(poolId, true, MAX_SLIPPAGE_BPS);
        _expectHookRevert(
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(LeashHook.SlippageTooLoose.selector, MIN_PRICE_LIMIT, bound)
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_SlippageTooLoose_OneForZero() public {
        _setMaxSlippage("100");
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        intent.zeroForOne = false;
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        uint160 bound = hook.priceLimit(poolId, false, MAX_SLIPPAGE_BPS);
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.SlippageTooLoose.selector, bound + 1, bound)
        );
        _swapWithLimit(intent, hookData, bound + 1);
    }

    function test_RevertWhen_Swap_SlippageRecordOutOfRange() public {
        _setMaxSlippage("10000");
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        string memory keyName = hook.KEY_MAX_SLIPPAGE_BPS();
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, keyName)
        );
        _swapRaw(intent, hookData);
    }

    function test_RevertWhen_Swap_SlippageRecordMalformed() public {
        _setMaxSlippage("1%");
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        string memory keyName = hook.KEY_MAX_SLIPPAGE_BPS();
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, keyName)
        );
        _swapRaw(intent, hookData);
    }

    function testFuzz_Swap_SlippageBound(uint256 bps) public {
        bps = bound(bps, 1, 9999);
        _setMaxSlippage(vm.toString(bps));
        uint160 limit = hook.priceLimit(poolId, true, bps);

        SwapIntent memory loose = _intent(-int256(1e18), 0);
        bytes memory looseData = _signedHookData(LABEL, loose, agentPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.SlippageTooLoose.selector, limit - 1, limit)
        );
        _swapWithLimit(loose, looseData, limit - 1);

        SwapIntent memory ok = _intent(-int256(1e18), 0);
        _swapWithLimit(ok, _signedHookData(LABEL, ok, agentPk), limit);
        assertEq(hook.nonces(node), 1);
    }

    // ============ Helpers ============

    /// @dev Exact input zeroForOne swap of `amountSpecified` (negative) signed by the agent with `nonce`.
    function _swap(int256 amountSpecified, uint256 nonce) internal returns (BalanceDelta) {
        SwapIntent memory intent = _intent(amountSpecified, nonce);
        return _swapRaw(intent, _signedHookData(LABEL, intent, agentPk));
    }

    /// @dev Swap the parameters described by `intent` with arbitrary `hookData`. This is the only external call
    ///      after `_expectHookRevert`, so build `hookData` before expecting a revert.
    function _swapRaw(SwapIntent memory intent, bytes memory hookData) internal returns (BalanceDelta) {
        return swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: intent.zeroForOne,
                amountSpecified: intent.amountSpecified,
                sqrtPriceLimitX96: intent.zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    /// @dev Same as `_swapRaw` with an explicit `sqrtPriceLimitX96`.
    function _swapWithLimit(SwapIntent memory intent, bytes memory hookData, uint160 sqrtPriceLimitX96)
        internal
        returns (BalanceDelta)
    {
        return swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: intent.zeroForOne,
                amountSpecified: intent.amountSpecified,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    function _setMaxSlippage(string memory value) internal {
        resolver.setText(dnsName, hook.KEY_MAX_SLIPPAGE_BPS(), value);
    }
}
