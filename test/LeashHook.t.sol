// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {LeashHook} from "../src/LeashHook.sol";
import {IPermissionedRegistry} from "../src/interfaces/ens/IPermissionedRegistry.sol";
import {EnsNameLib} from "../src/libraries/EnsNameLib.sol";
import {LeashIntentLib, SwapIntent} from "../src/libraries/LeashIntentLib.sol";
import {LeashPolicyLib} from "../src/libraries/LeashPolicyLib.sol";
import {MockRegistry} from "./mocks/MockRegistry.sol";
import {MockResolver} from "./mocks/MockResolver.sol";

/// @dev Uses `vm.getBlockTimestamp()` instead of `block.timestamp` in test code: via-IR may cache
///      `block.timestamp` within a call, which breaks `vm.warp` in the middle of a test.
contract LeashHookTest is Deployers {
    using PoolIdLibrary for PoolKey;

    string internal constant PARENT_NAME = "acme.eth";
    string internal constant LABEL = "trader-1";
    uint256 internal constant CAP = 1000e18;
    uint64 internal constant NAME_DURATION = 7 days;

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

    function setUp() public {
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
        assertEq(dns, EnsNameLib.dnsEncodeName("trader-1.acme.eth"));
        assertEq(n, EnsNameLib.namehash("trader-1.acme.eth"));
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
