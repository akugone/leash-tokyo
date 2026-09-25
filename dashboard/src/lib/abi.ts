import { parseAbi } from "viem";

export const hookAbi = parseAbi([
  "function nonces(bytes32 node) view returns (uint256)",
  "function spentToday(bytes32 node) view returns (uint256)",
  "function remainingToday(string label) view returns (uint256)",
  "function policy(string label) view returns (address agent, address quote, uint256 cap, address[] tokens, uint64 expiry)",
  "function agentName(string label) view returns (bytes dnsName, bytes32 node)",
  "function PARENT_NODE() view returns (bytes32)",
  "function ORG_REGISTRY() view returns (address)",
  "function currentDay() view returns (uint256)",
  "event LeashSwap(bytes32 indexed node, address indexed agent, bytes32 indexed poolId, uint256 notional, uint256 spentToday)",
  "error LeashRevoked(bytes32 node, uint64 expiry)",
  "error NoResolver(bytes32 node)",
  "error NoAgent(bytes32 node)",
]);

export const registryAbi = parseAbi([
  "function getExpiry(uint256 labelId) view returns (uint64)",
  "function getResolver(string label) view returns (address)",
  "function getOwner(uint256 labelId) view returns (address)",
]);

export const resolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
]);

/// Inner calls wrapped in `resolve(name, data)`. The node argument is ignored by the resolver.
export const resolverInnerAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
]);

export const leashSwapEvent = hookAbi.find(
  (item) => item.type === "event" && item.name === "LeashSwap",
)!;
