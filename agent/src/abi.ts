import { parseAbi } from "viem";

/** LeashHook surface the bot reads from and the errors it decodes. Kept by hand so we never depend on `out/`. */
export const LEASH_HOOK_ABI = parseAbi([
  "struct SwapIntent { bytes32 node; bytes32 poolId; bool zeroForOne; int256 amountSpecified; uint256 nonce; uint256 deadline; }",
  "function nonces(bytes32 node) view returns (uint256)",
  "function spentToday(bytes32 node) view returns (uint256)",
  "function remainingToday(string label) view returns (uint256)",
  "function policy(string label) view returns (address agent, address quote, uint256 cap, address[] tokens, uint64 expiry)",
  "function maxSlippageBps(string label) view returns (bool enforced, uint256 bps)",
  "function priceLimit(bytes32 poolId, bool zeroForOne, uint256 bps) view returns (uint160)",
  "function agentName(string label) view returns (bytes dnsName, bytes32 node)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function hashIntent(SwapIntent intent) view returns (bytes32)",
  "function PARENT_NODE() view returns (bytes32)",
  "function ORG_REGISTRY() view returns (address)",
  "event LeashSwap(bytes32 indexed node, address indexed agent, bytes32 indexed poolId, uint256 notional, uint256 spentToday)",
  "error NodeMismatch(bytes32 expected, bytes32 actual)",
  "error LeashRevoked(bytes32 node, uint64 expiry)",
  "error NoResolver(bytes32 node)",
  "error NoAgent(bytes32 node)",
  "error IntentExpired(uint256 deadline, uint256 now)",
  "error BadNonce(bytes32 node, uint256 expected, uint256 actual)",
  "error IntentMismatch()",
  "error BadSignature(address expected, address actual)",
  "error TokenNotAllowed(address token)",
  "error QuoteNotInPool(address quote)",
  "error DailyCapExceeded(bytes32 node, uint256 attempted, uint256 cap)",
  "error InvalidRecord(string key)",
  "error SlippageTooLoose(uint160 sqrtPriceLimitX96, uint160 bound)",
]);

/** v4-core `CustomRevert.WrappedError` (ERC-7751): how hook reverts bubble through the PoolManager. */
export const WRAPPED_ERROR_ABI = parseAbi([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
]);

/**
 * `LeashVault.swap`, the vault's own errors, and the ERC20 error a vault short of funds bubbles up from the
 * token transfer inside the PoolManager.
 */
export const LEASH_VAULT_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
  "function swap(PoolKey key, SwapParams params, bytes hookData) returns (int256 delta)",
  "error NotLeashPool(address hooks)",
  "error NotSigner(address signer, address caller)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
