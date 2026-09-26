// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {BaseHook} from "./base/BaseHook.sol";
import {IPermissionedRegistry} from "./interfaces/ens/IPermissionedRegistry.sol";
import {IExtendedResolver} from "./interfaces/ens/IPermissionedResolver.sol";
import {EnsNameLib} from "./libraries/EnsNameLib.sol";
import {LeashEnsLib} from "./libraries/LeashEnsLib.sol";
import {LeashIntentLib, SwapIntent} from "./libraries/LeashIntentLib.sol";
import {LeashPolicyLib} from "./libraries/LeashPolicyLib.sol";

/// @title LeashHook
/// @notice Uniswap v4 hook that gates every swap on an ENSv2 subname and the risk policy stored in its resolver.
/// @dev `beforeSwap` authenticates the agent (name alive, EIP-712 intent signed by the name's `addr` record, tokens
///      allowed, price limit within `leash.maxSlippageBps`). `afterSwap` counts the real quote token delta against the
///      daily cap read from `leash.dailyNotional`.
///      The hook ignores `sender`: any v4 router works, authentication is carried in `hookData`.
contract LeashHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ============ Constants ============

    string public constant KEY_QUOTE = "leash.quote";
    string public constant KEY_DAILY_NOTIONAL = "leash.dailyNotional";
    string public constant KEY_TOKENS = "leash.tokens";
    /// @notice Optional. Maximum price impact of one swap, in basis points of the pool price at execution: the swap's
    ///         `sqrtPriceLimitX96` may not let the price move further than that. It does not guard against a price
    ///         already moved before the swap (no reference price is signed). Empty: not enforced. Owner-only key: the
    ///         risk manager holds no role on it, so nobody below the owner can clear it.
    string public constant KEY_MAX_SLIPPAGE_BPS = "leash.maxSlippageBps";

    uint256 internal constant BPS = 10_000;
    /// @dev 1e40 bps scales sqrtPrice by 1e18, more than MAX_SQRT_PRICE / MIN_SQRT_PRICE (~3.4e38) allows.
    uint256 internal constant MAX_BPS_UP = 1e40;

    /// @dev Transient storage slots bridging `beforeSwap` and `afterSwap` (EIP-1153, `tstore`/`tload`).
    uint256 private constant T_NODE = 0x00;
    uint256 private constant T_AGENT = 0x01;
    uint256 private constant T_QUOTE = 0x02;
    uint256 private constant T_CAP = 0x03;

    // ============ Immutables ============

    /// @notice Org registry that issues agent subnames under `PARENT_NODE`.
    IPermissionedRegistry public immutable ORG_REGISTRY;
    /// @notice `namehash(parentName)`, e.g. `namehash("leash.eth")`.
    bytes32 public immutable PARENT_NODE;

    // ============ Storage ============

    /// @dev DNS-encoded parent name, e.g. `\x05leash\x03eth\x00`. Exposed through `parentDnsName()`.
    bytes internal _parentDnsName;

    /// @notice Next expected intent nonce per agent node.
    mapping(bytes32 node => uint256) public nonces;
    /// @notice Quote token notional spent per agent node and UTC day (`block.timestamp / 1 days`).
    mapping(bytes32 node => mapping(uint256 day => uint256)) public spent;

    // ============ Errors ============

    error NodeMismatch(bytes32 expected, bytes32 actual);
    error LeashRevoked(bytes32 node, uint64 expiry);
    error NoResolver(bytes32 node);
    error NoAgent(bytes32 node);
    error IntentExpired(uint256 deadline, uint256 now_);
    error BadNonce(bytes32 node, uint256 expected, uint256 actual);
    error IntentMismatch();
    error BadSignature(address expected, address recovered);
    error TokenNotAllowed(address token);
    error QuoteNotInPool(address quote);
    error DailyCapExceeded(bytes32 node, uint256 spent, uint256 cap);
    error SlippageTooLoose(uint160 sqrtPriceLimitX96, uint160 bound);

    // ============ Events ============

    event LeashSwap(
        bytes32 indexed node, address indexed agent, PoolId indexed poolId, uint256 notional, uint256 spentToday
    );

    // ============ Constructor ============

    /// @param poolManager Uniswap v4 PoolManager.
    /// @param orgRegistry ENSv2 registry holding the agent subnames.
    /// @param parentName Dotted parent name, e.g. `leash.eth`.
    constructor(IPoolManager poolManager, IPermissionedRegistry orgRegistry, string memory parentName)
        BaseHook(poolManager)
    {
        ORG_REGISTRY = orgRegistry;
        PARENT_NODE = EnsNameLib.namehash(parentName);
        _parentDnsName = EnsNameLib.dnsEncodeName(parentName);
    }

    // ============ External functions ============

    /// @notice DNS-encoded parent name the hook prefixes every label with.
    function parentDnsName() external view returns (bytes memory) {
        return _parentDnsName;
    }

    /// @notice Quote notional `label` may still spend today. Zero when the name is revoked, expired, has no
    ///         resolver or the cap is exhausted.
    /// @dev Takes the label rather than the node because the registry resolves resolvers by label.
    function remainingToday(string memory label) external view returns (uint256) {
        uint256 labelId = EnsNameLib.labelId(label);
        bytes32 node = EnsNameLib.childNode(PARENT_NODE, label);
        if (ORG_REGISTRY.getExpiry(labelId) <= block.timestamp) return 0;
        address resolver = ORG_REGISTRY.getResolver(label);
        if (resolver == address(0)) return 0;
        bytes memory dnsName = EnsNameLib.dnsEncode(label, _parentDnsName);
        uint256 cap = LeashPolicyLib.parseUint(
            LeashEnsLib.readText(IExtendedResolver(resolver), dnsName, KEY_DAILY_NOTIONAL), KEY_DAILY_NOTIONAL
        );
        uint256 used = spentToday(node);
        return cap > used ? cap - used : 0;
    }

    /// @notice Dashboard helper: the full policy of `label` as the hook reads it.
    /// @dev Reverts `LeashRevoked` when the name is expired or revoked, `NoResolver` when it has no resolver.
    function policy(string memory label)
        external
        view
        returns (address agent, address quote, uint256 cap, address[] memory tokens, uint64 expiry)
    {
        uint256 labelId = EnsNameLib.labelId(label);
        bytes32 node = EnsNameLib.childNode(PARENT_NODE, label);
        expiry = ORG_REGISTRY.getExpiry(labelId);
        if (expiry <= block.timestamp) revert LeashRevoked(node, expiry);
        address resolver = ORG_REGISTRY.getResolver(label);
        if (resolver == address(0)) revert NoResolver(node);
        bytes memory dnsName = EnsNameLib.dnsEncode(label, _parentDnsName);
        agent = LeashEnsLib.readAddr(IExtendedResolver(resolver), dnsName);
        (quote, cap, tokens) = _readPolicy(IExtendedResolver(resolver), dnsName);
    }

    /// @notice Slippage bound of `label`: `enforced` is false when `leash.maxSlippageBps` is empty.
    /// @dev Reverts like `policy`: `LeashRevoked`, `NoResolver`, `InvalidRecord`.
    function maxSlippageBps(string memory label) external view returns (bool enforced, uint256 bps) {
        uint256 labelId = EnsNameLib.labelId(label);
        bytes32 node = EnsNameLib.childNode(PARENT_NODE, label);
        uint64 expiry = ORG_REGISTRY.getExpiry(labelId);
        if (expiry <= block.timestamp) revert LeashRevoked(node, expiry);
        address resolver = ORG_REGISTRY.getResolver(label);
        if (resolver == address(0)) revert NoResolver(node);
        return _readMaxSlippage(IExtendedResolver(resolver), EnsNameLib.dnsEncode(label, _parentDnsName));
    }

    /// @notice Widest `sqrtPriceLimitX96` a swap in `poolId` may use for a `bps` slippage, from the current price.
    ///         The hook compares against `priceLimit(poolId, zeroForOne, leash.maxSlippageBps)`; agents call it with
    ///         their own `bps` (at most the policy) to build a limit the hook accepts.
    function priceLimit(PoolId poolId, bool zeroForOne, uint256 bps) public view returns (uint160) {
        if (zeroForOne && bps >= BPS) return TickMath.MIN_SQRT_PRICE + 1;
        // Beyond this the limit is past MAX_SQRT_PRICE from any price, and the product below would overflow.
        if (bps > MAX_BPS_UP) bps = MAX_BPS_UP;
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        // Price is sqrtPrice^2, so a `bps` price move scales sqrtPrice by sqrt(1 -/+ bps / BPS), here with 18 decimals.
        uint256 scale = FixedPointMathLib.sqrt((zeroForOne ? BPS - bps : BPS + bps) * 1e36 / BPS);
        uint256 limit = FullMath.mulDiv(sqrtPriceX96, scale, 1e18);
        // Both casts are bounded by the TickMath comparison on the same line.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (zeroForOne) return limit > TickMath.MIN_SQRT_PRICE ? uint160(limit) : TickMath.MIN_SQRT_PRICE + 1;
        // forge-lint: disable-next-line(unsafe-typecast)
        return limit < TickMath.MAX_SQRT_PRICE ? uint160(limit) : TickMath.MAX_SQRT_PRICE - 1;
    }

    /// @notice Full EIP-712 digest of `intent` under this hook's domain, i.e. what the agent signs.
    function hashIntent(SwapIntent memory intent) external view returns (bytes32) {
        return LeashIntentLib.digest(DOMAIN_SEPARATOR(), intent);
    }

    // ============ Public functions ============

    /// @inheritdoc BaseHook
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice EIP-712 domain separator (name "Leash", version "1", current chain, this hook).
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return LeashIntentLib.domainSeparator(address(this));
    }

    /// @notice Quote notional already spent by `node` in the current UTC day.
    function spentToday(bytes32 node) public view returns (uint256) {
        return spent[node][currentDay()];
    }

    /// @notice Current UTC day index, `block.timestamp / 1 days`.
    function currentDay() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice DNS-encoded full name and ENS node of `label` under the parent name.
    function agentName(string memory label) public view returns (bytes memory dnsName, bytes32 node) {
        dnsName = EnsNameLib.dnsEncode(label, _parentDnsName);
        node = EnsNameLib.childNode(PARENT_NODE, label);
    }

    // ============ Internal functions ============

    /// @dev Authenticates the agent and validates the intent. Stashes what `afterSwap` needs in transient storage.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // 1. Decode and bind the intent to the name.
        (string memory label, SwapIntent memory intent, bytes memory sig) = LeashIntentLib.decodeHookData(hookData);
        uint256 labelId = EnsNameLib.labelId(label);
        bytes32 node = EnsNameLib.childNode(PARENT_NODE, label);
        if (intent.node != node) revert NodeMismatch(node, intent.node);

        // 2. The name must be alive: `unregister` sets expiry to now, natural expiry does the rest.
        uint64 expiry = ORG_REGISTRY.getExpiry(labelId);
        if (expiry <= block.timestamp) revert LeashRevoked(node, expiry);

        // 3. + 4. Resolve the agent address from the name's `addr` record.
        address resolver = ORG_REGISTRY.getResolver(label);
        if (resolver == address(0)) revert NoResolver(node);
        bytes memory dnsName = EnsNameLib.dnsEncode(label, _parentDnsName);
        address agent = LeashEnsLib.readAddr(IExtendedResolver(resolver), dnsName);
        if (agent == address(0)) revert NoAgent(node);

        // 5. + 6. Intent freshness and replay protection.
        if (intent.deadline < block.timestamp) revert IntentExpired(intent.deadline, block.timestamp);
        uint256 expectedNonce = nonces[node];
        if (intent.nonce != expectedNonce) revert BadNonce(node, expectedNonce, intent.nonce);
        nonces[node] = expectedNonce + 1;

        // 7. The intent must describe exactly this swap.
        if (
            intent.poolId != PoolId.unwrap(key.toId()) || intent.zeroForOne != params.zeroForOne
                || intent.amountSpecified != params.amountSpecified
        ) revert IntentMismatch();

        // 8. Signature check against the `addr` record.
        address recovered = ECDSA.recover(LeashIntentLib.digest(DOMAIN_SEPARATOR(), intent), sig);
        if (recovered != agent) revert BadSignature(agent, recovered);

        // 9. Policy: both pool tokens allowed, then quote and cap for afterSwap.
        (address quote, uint256 cap, address[] memory tokens) = _readPolicy(IExtendedResolver(resolver), dnsName);
        address token0 = Currency.unwrap(key.currency0);
        address token1 = Currency.unwrap(key.currency1);
        if (!LeashPolicyLib.contains(tokens, token0)) revert TokenNotAllowed(token0);
        if (!LeashPolicyLib.contains(tokens, token1)) revert TokenNotAllowed(token1);

        // 10. Price impact: the swap's price limit may not be wider than the policy allows from the current price.
        (bool enforced, uint256 bps) = _readMaxSlippage(IExtendedResolver(resolver), dnsName);
        if (enforced) {
            uint160 bound = priceLimit(key.toId(), params.zeroForOne, bps);
            if (params.zeroForOne ? params.sqrtPriceLimitX96 < bound : params.sqrtPriceLimitX96 > bound) {
                revert SlippageTooLoose(params.sqrtPriceLimitX96, bound);
            }
        }

        // 11. Hand over to afterSwap.
        _tstore(T_NODE, uint256(node));
        _tstore(T_AGENT, uint256(uint160(agent)));
        _tstore(T_QUOTE, uint256(uint160(quote)));
        _tstore(T_CAP, cap);

        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @dev Counts the real quote delta against today's cap.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        bytes32 node = bytes32(_tload(T_NODE));
        address agent = address(uint160(_tload(T_AGENT)));
        address quote = address(uint160(_tload(T_QUOTE)));
        uint256 cap = _tload(T_CAP);
        _tstore(T_NODE, 0);
        _tstore(T_AGENT, 0);
        _tstore(T_QUOTE, 0);
        _tstore(T_CAP, 0);

        int256 amount;
        if (Currency.unwrap(key.currency0) == quote) {
            amount = int256(delta.amount0());
        } else if (Currency.unwrap(key.currency1) == quote) {
            amount = int256(delta.amount1());
        } else {
            revert QuoteNotInPool(quote);
        }
        uint256 notional = SignedMath.abs(amount);

        uint256 day = currentDay();
        uint256 newSpent = spent[node][day] + notional;
        if (newSpent > cap) revert DailyCapExceeded(node, newSpent, cap);
        spent[node][day] = newSpent;

        emit LeashSwap(node, agent, key.toId(), notional, newSpent);
        return (BaseHook.afterSwap.selector, 0);
    }

    /// @dev Reads and parses the three `leash.*` text records of `dnsName`.
    function _readPolicy(IExtendedResolver resolver, bytes memory dnsName)
        internal
        view
        returns (address quote, uint256 cap, address[] memory tokens)
    {
        tokens = LeashPolicyLib.parseAddressList(LeashEnsLib.readText(resolver, dnsName, KEY_TOKENS), KEY_TOKENS);
        quote = LeashPolicyLib.parseAddress(LeashEnsLib.readText(resolver, dnsName, KEY_QUOTE), KEY_QUOTE);
        cap = LeashPolicyLib.parseUint(LeashEnsLib.readText(resolver, dnsName, KEY_DAILY_NOTIONAL), KEY_DAILY_NOTIONAL);
    }

    /// @dev Reads `leash.maxSlippageBps`: empty means not enforced, otherwise a base 10 integer below `BPS`.
    function _readMaxSlippage(IExtendedResolver resolver, bytes memory dnsName)
        internal
        view
        returns (bool enforced, uint256 bps)
    {
        string memory raw = LeashEnsLib.readText(resolver, dnsName, KEY_MAX_SLIPPAGE_BPS);
        if (bytes(raw).length == 0) return (false, 0);
        bps = LeashPolicyLib.parseUint(raw, KEY_MAX_SLIPPAGE_BPS);
        if (bps >= BPS) revert LeashPolicyLib.InvalidRecord(KEY_MAX_SLIPPAGE_BPS);
        return (true, bps);
    }

    // ============ Private functions ============

    function _tstore(uint256 slot, uint256 value) private {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function _tload(uint256 slot) private view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }
}
