import { parseAbi } from "viem";

/** LeashHook surface the bot reads from and the errors it decodes. Kept by hand so we never depend on `out/`. */
export const LEASH_HOOK_ABI = parseAbi([
  "struct SwapIntent { bytes32 node; bytes32 poolId; bool zeroForOne; int256 amountSpecified; uint256 nonce; uint256 deadline; }",
  "function nonces(bytes32 node) view returns (uint256)",
  "function spentToday(bytes32 node) view returns (uint256)",
  "function remainingToday(string label) view returns (uint256)",
  "function policy(string label) view returns (address agent, address quote, uint256 cap, address[] tokens, uint64 expiry)",
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
]);

/** v4-core `CustomRevert.WrappedError` (ERC-7751): how hook reverts bubble through the PoolManager. */
export const WRAPPED_ERROR_ABI = parseAbi([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
]);

/** `PoolSwapTest.swap` from v4-core. */
export const POOL_SWAP_TEST_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
  "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
  "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256 delta)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
