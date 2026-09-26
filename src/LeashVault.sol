// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {LeashHook} from "./LeashHook.sol";
import {LeashIntentLib, SwapIntent} from "./libraries/LeashIntentLib.sol";

/// @title LeashVault
/// @notice Org treasury the agents trade from: the agent holds no tokens, it signs intents and the vault pays.
/// @dev `swap` only reaches pools gated by `HOOK`, so every trade still goes through the hook's checks. The caller
///      must be the intent signer: without it, anyone could replay an agent's pending intent against the org's funds
///      with a price limit of their choice. The hook then checks that signer against the name's `addr` record.
///      The router pulls the input from its caller and pays the output back to it, so the vault settles nothing
///      itself. ERC20 pools only. Only the owner withdraws. `trySwap` records a refused swap as an event instead of
///      reverting, so an agent's attempts beyond its mandate are provable on chain.
contract LeashVault is Ownable {
    using SafeERC20 for IERC20;

    // ============ Immutables ============

    /// @notice The only hook whose pools the vault trades on.
    LeashHook public immutable HOOK;
    /// @notice Uniswap v4 test router the vault swaps through.
    PoolSwapTest public immutable ROUTER;

    // ============ Errors ============

    error NotLeashPool(address hooks);
    error NotSigner(address signer, address caller);
    /// @dev `trySwap` got no policy answer: the inner call ran out of gas, or reverted without data (directly or
    ///      wrapped by the PoolManager). Recording it would let a caller forge refusals by starving the hook of gas.
    error EmptyRefusal();

    // ============ Events ============

    event VaultSwap(address indexed agent, bytes32 indexed node, int256 amountSpecified, BalanceDelta delta);
    /// @notice A swap the hook (or the pool) refused, recorded by `trySwap`. `reason` is the raw revert data, a
    ///         `WrappedError` from the PoolManager around the hook's own error, e.g. `DailyCapExceeded`.
    event SwapRefused(address indexed agent, bytes32 indexed node, int256 amountSpecified, bytes reason);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    // ============ Constructor ============

    constructor(LeashHook hook, PoolSwapTest router, address owner) Ownable(owner) {
        HOOK = hook;
        ROUTER = router;
    }

    // ============ External functions ============

    /// @notice Swaps the vault's tokens on a Leash pool. `hookData` is the signed intent, passed to the hook as is.
    /// @dev Hook reverts bubble up unchanged, wrapped by the PoolManager.
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (BalanceDelta delta)
    {
        bytes32 node = _authorize(key, params, hookData);
        delta = ROUTER.swap(key, params, _settings(), hookData);
        emit VaultSwap(msg.sender, node, params.amountSpecified, delta);
    }

    /// @notice Same as `swap`, but a refusal by the hook or the pool is recorded on chain instead of reverting:
    ///         the call succeeds, nothing moves, and `SwapRefused` carries the reason. The caller pays the gas of
    ///         the attempt, which makes every attempt beyond the mandate public and costly to the agent, never to
    ///         the org. The vault's own checks (`NotLeashPool`, `NotSigner`) still revert: they are not attempts.
    /// @dev The refused swap reverts inside the router call, so the hook's nonce and daily counter are untouched.
    function trySwap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (bool ok, BalanceDelta delta)
    {
        bytes32 node = _authorize(key, params, hookData);
        uint256 gasBefore = gasleft();
        try ROUTER.swap(key, params, _settings(), hookData) returns (BalanceDelta swapped) {
            emit VaultSwap(msg.sender, node, params.amountSpecified, swapped);
            return (true, swapped);
        } catch (bytes memory reason) {
            // Out of gas: the call gets 63/64 of what is left, so after it runs dry about 1/64 remains.
            if (gasleft() <= gasBefore / 63 || _isEmptyReason(reason)) revert EmptyRefusal();
            emit SwapRefused(msg.sender, node, params.amountSpecified, reason);
            return (false, BalanceDelta.wrap(0));
        }
    }

    /// @notice Sends `amount` of `token` to `to`.
    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
        emit Withdrawn(address(token), to, amount);
    }

    // ============ Private functions ============

    /// @dev The vault's own checks: a Leash pool, and the caller signed the intent. Returns the intent's node.
    function _authorize(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        private
        returns (bytes32)
    {
        if (address(key.hooks) != address(HOOK)) revert NotLeashPool(address(key.hooks));
        (, SwapIntent memory intent, bytes memory signature) = LeashIntentLib.decodeHookData(hookData);
        address signer = ECDSA.recover(HOOK.hashIntent(intent), signature);
        if (signer != msg.sender) revert NotSigner(signer, msg.sender);
        _approveRouter(params.zeroForOne ? key.currency0 : key.currency1);
        return intent.node;
    }

    /// @dev No data, or a PoolManager `WrappedError` around no data (a hook that ran dry reverts empty).
    function _isEmptyReason(bytes memory reason) private pure returns (bool) {
        if (reason.length == 0) return true;
        if (reason.length < 4 || bytes4(reason) != CustomRevert.WrappedError.selector) return false;
        (,, bytes memory inner,) = abi.decode(_slice4(reason), (address, bytes4, bytes, bytes));
        return inner.length == 0;
    }

    /// @dev `data` without its 4 byte selector.
    function _slice4(bytes memory data) private pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[i + 4];
        }
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev Unlimited approval, set once per token: the router only ever pulls from its own caller.
    function _approveRouter(Currency currency) private {
        IERC20 token = IERC20(Currency.unwrap(currency));
        if (token.allowance(address(this), address(ROUTER)) != type(uint256).max) {
            token.forceApprove(address(ROUTER), type(uint256).max);
        }
    }
}
