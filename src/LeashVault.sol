// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
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
///      itself. ERC20 pools only. Only the owner withdraws.
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

    // ============ Events ============

    event VaultSwap(address indexed agent, bytes32 indexed node, int256 amountSpecified, BalanceDelta delta);
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
        if (address(key.hooks) != address(HOOK)) revert NotLeashPool(address(key.hooks));
        (, SwapIntent memory intent, bytes memory signature) = LeashIntentLib.decodeHookData(hookData);
        address signer = ECDSA.recover(HOOK.hashIntent(intent), signature);
        if (signer != msg.sender) revert NotSigner(signer, msg.sender);

        _approveRouter(params.zeroForOne ? key.currency0 : key.currency1);
        delta =
            ROUTER.swap(key, params, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), hookData);
        emit VaultSwap(msg.sender, intent.node, params.amountSpecified, delta);
    }

    /// @notice Sends `amount` of `token` to `to`.
    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
        emit Withdrawn(address(token), to, amount);
    }

    // ============ Private functions ============

    /// @dev Unlimited approval, set once per token: the router only ever pulls from its own caller.
    function _approveRouter(Currency currency) private {
        IERC20 token = IERC20(Currency.unwrap(currency));
        if (token.allowance(address(this), address(ROUTER)) != type(uint256).max) {
            token.forceApprove(address(ROUTER), type(uint256).max);
        }
    }
}
