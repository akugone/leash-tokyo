// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {LeashHook} from "../src/LeashHook.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {SwapIntent} from "../src/libraries/LeashIntentLib.sol";
import {LeashHookBase} from "./utils/LeashHookBase.sol";

/// @dev Build `hookData` before `vm.prank`: signing reads the hook's domain, an external call that would consume it.
contract LeashVaultTest is LeashHookBase {
    uint256 internal constant VAULT_FUNDS = 10_000e18;

    LeashVault internal vault;
    address internal owner = makeAddr("vaultOwner");
    address internal stranger = makeAddr("stranger");

    function setUp() public override {
        super.setUp();
        vault = new LeashVault(hook, swapRouter, owner);
        assertTrue(IERC20(token0).transfer(address(vault), VAULT_FUNDS));
        assertTrue(IERC20(token1).transfer(address(vault), VAULT_FUNDS));
        vm.label(address(vault), "LeashVault");
    }

    // ============ Constructor Tests ============

    function test_Constructor() public view {
        assertEq(address(vault.HOOK()), address(hook));
        assertEq(address(vault.ROUTER()), address(swapRouter));
        assertEq(vault.owner(), owner);
    }

    // ============ swap Tests ============

    function test_Swap_PaysFromVault() public {
        int256 amount = -int256(100e18);
        SwapIntent memory intent = _intent(amount, 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);

        vm.prank(agent);
        BalanceDelta delta = vault.swap(key, _params(intent), hookData);

        assertEq(int256(delta.amount0()), amount);
        assertEq(IERC20(token0).balanceOf(address(vault)), VAULT_FUNDS - 100e18);
        assertEq(IERC20(token1).balanceOf(address(vault)), VAULT_FUNDS + uint256(int256(delta.amount1())));
        assertEq(IERC20(token0).balanceOf(agent), 0);
        assertEq(IERC20(token1).balanceOf(agent), 0);
        assertEq(hook.spentToday(node), 100e18);
        assertEq(hook.nonces(node), 1);
    }

    function test_Swap_EmitsVaultSwap() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        vm.expectEmit(true, true, false, false, address(vault));
        emit LeashVault.VaultSwap(agent, node, intent.amountSpecified, BalanceDelta.wrap(0));
        vm.prank(agent);
        vault.swap(key, _params(intent), hookData);
    }

    function test_Swap_BothDirections() public {
        SwapIntent memory buy = _intent(-int256(50e18), 0);
        bytes memory buyData = _signedHookData(LABEL, buy, agentPk);
        vm.prank(agent);
        vault.swap(key, _params(buy), buyData);

        SwapIntent memory sell = _intent(-int256(10e18), 1);
        sell.zeroForOne = false;
        bytes memory sellData = _signedHookData(LABEL, sell, agentPk);
        vm.prank(agent);
        vault.swap(key, _params(sell), sellData);
        assertEq(hook.nonces(node), 2);
    }

    function test_RevertWhen_Swap_NotLeashPool() public {
        PoolKey memory plain = key;
        plain.hooks = IHooks(address(0));
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.NotLeashPool.selector, address(0)));
        vm.prank(agent);
        vault.swap(plain, _params(intent), hookData);
    }

    /// @dev A third party replaying the agent's signed intent cannot spend the vault.
    function test_RevertWhen_Swap_NotSigner() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.NotSigner.selector, agent, stranger));
        vm.prank(stranger);
        vault.swap(key, _params(intent), hookData);
    }

    /// @dev Signing and sending with a key that is not the `addr` record passes the vault, the hook refuses it.
    function test_RevertWhen_Swap_HookRefusesOtherKey() public {
        uint256 otherPk = 0xB0B;
        address other = vm.addr(otherPk);
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, otherPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(LeashHook.BadSignature.selector, agent, other)
        );
        vm.prank(other);
        vault.swap(key, _params(intent), hookData);
    }

    function test_RevertWhen_Swap_LeashRevoked() public {
        registry.revoke(LABEL);
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        _expectHookRevert(
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(LeashHook.LeashRevoked.selector, node, uint64(vm.getBlockTimestamp()))
        );
        vm.prank(agent);
        vault.swap(key, _params(intent), hookData);
    }

    function test_RevertWhen_Swap_DailyCapExceeded() public {
        // forge-lint: disable-next-line(unsafe-typecast)
        SwapIntent memory intent = _intent(-int256(CAP + 1), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        _expectHookRevert(
            IHooks.afterSwap.selector, abi.encodeWithSelector(LeashHook.DailyCapExceeded.selector, node, CAP + 1, CAP)
        );
        vm.prank(agent);
        vault.swap(key, _params(intent), hookData);
    }

    // ============ trySwap Tests ============

    function test_TrySwap_Swaps() public {
        SwapIntent memory intent = _intent(-int256(100e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        vm.expectEmit(true, true, false, false, address(vault));
        emit LeashVault.VaultSwap(agent, node, intent.amountSpecified, BalanceDelta.wrap(0));
        vm.prank(agent);
        (bool ok, BalanceDelta delta) = vault.trySwap(key, _params(intent), hookData);

        assertTrue(ok);
        assertEq(int256(delta.amount0()), intent.amountSpecified);
        assertEq(IERC20(token0).balanceOf(address(vault)), VAULT_FUNDS - 100e18);
        assertEq(hook.spentToday(node), 100e18);
        assertEq(hook.nonces(node), 1);
    }

    /// @dev Over the cap: the call succeeds, nothing moves, and the hook's own error is on chain.
    function test_TrySwap_RecordsDailyCapExceeded() public {
        // forge-lint: disable-next-line(unsafe-typecast)
        SwapIntent memory intent = _intent(-int256(CAP + 1), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        bytes memory reason = _wrappedHookError(
            IHooks.afterSwap.selector, abi.encodeWithSelector(LeashHook.DailyCapExceeded.selector, node, CAP + 1, CAP)
        );
        vm.expectEmit(true, true, false, true, address(vault));
        emit LeashVault.SwapRefused(agent, node, intent.amountSpecified, reason);
        vm.prank(agent);
        (bool ok, BalanceDelta delta) = vault.trySwap(key, _params(intent), hookData);

        assertFalse(ok);
        assertEq(BalanceDelta.unwrap(delta), 0);
        assertEq(IERC20(token0).balanceOf(address(vault)), VAULT_FUNDS);
        assertEq(IERC20(token1).balanceOf(address(vault)), VAULT_FUNDS);
        assertEq(hook.spentToday(node), 0);
        assertEq(hook.nonces(node), 0);
    }

    function test_TrySwap_RecordsLeashRevoked() public {
        registry.revoke(LABEL);
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        bytes memory reason = _wrappedHookError(
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(LeashHook.LeashRevoked.selector, node, uint64(vm.getBlockTimestamp()))
        );
        vm.expectEmit(true, true, false, true, address(vault));
        emit LeashVault.SwapRefused(agent, node, intent.amountSpecified, reason);
        vm.prank(agent);
        (bool ok,) = vault.trySwap(key, _params(intent), hookData);
        assertFalse(ok);
    }

    /// @dev A refused attempt consumes no nonce: the same nonce trades once the order fits the mandate.
    function test_TrySwap_NonceUsableAfterRefusal() public {
        // forge-lint: disable-next-line(unsafe-typecast)
        SwapIntent memory tooBig = _intent(-int256(CAP + 1), 0);
        bytes memory tooBigData = _signedHookData(LABEL, tooBig, agentPk);
        vm.prank(agent);
        (bool refused,) = vault.trySwap(key, _params(tooBig), tooBigData);
        assertFalse(refused);

        SwapIntent memory fits = _intent(-int256(10e18), 0);
        bytes memory fitsData = _signedHookData(LABEL, fits, agentPk);
        vm.prank(agent);
        (bool ok,) = vault.trySwap(key, _params(fits), fitsData);
        assertTrue(ok);
        assertEq(hook.nonces(node), 1);
    }

    /// @dev The vault's own checks are not attempts: they revert, nothing is recorded.
    function test_RevertWhen_TrySwap_NotSigner() public {
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.NotSigner.selector, agent, stranger));
        vm.prank(stranger);
        vault.trySwap(key, _params(intent), hookData);
    }

    function test_RevertWhen_TrySwap_NotLeashPool() public {
        PoolKey memory plain = key;
        plain.hooks = IHooks(address(0));
        SwapIntent memory intent = _intent(-int256(1e18), 0);
        bytes memory hookData = _signedHookData(LABEL, intent, agentPk);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.NotLeashPool.selector, address(0)));
        vm.prank(agent);
        vault.trySwap(plain, _params(intent), hookData);
    }

    // ============ withdraw Tests ============

    function test_Withdraw() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit LeashVault.Withdrawn(token0, owner, 1000e18);
        vm.prank(owner);
        vault.withdraw(IERC20(token0), owner, 1000e18);
        assertEq(IERC20(token0).balanceOf(owner), 1000e18);
        assertEq(IERC20(token0).balanceOf(address(vault)), VAULT_FUNDS - 1000e18);
    }

    function test_RevertWhen_Withdraw_ByAgent() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vm.prank(agent);
        vault.withdraw(IERC20(token0), agent, 1);
    }

    // ============ Helpers ============

    function _params(SwapIntent memory intent) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: intent.zeroForOne,
            amountSpecified: intent.amountSpecified,
            sqrtPriceLimitX96: intent.zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }
}
