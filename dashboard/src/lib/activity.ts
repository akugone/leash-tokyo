// The org's activity, read from the contracts' own events: nothing here comes from a server. Swaps (hook),
// refused swaps recorded by `LeashVault.trySwap`, policy writes (each agent's own resolver), agents issued, moved
// to a resolver and cut (registry), and test tokens minted to the vault. Every item carries its transaction.
import {
  decodeErrorResult,
  formatUnits,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  childNode,
  ENS_PERMISSIONED_RESOLVER_IMPL,
  ENS_VERIFIABLE_FACTORY,
  formatAmount,
  labelKey,
  shortHex,
  type Deployments,
} from "./leash";

export const activityEvents = parseAbi([
  "event LeashSwap(bytes32 indexed node, address indexed agent, bytes32 indexed poolId, uint256 notional, uint256 spentToday)",
  "event SwapRefused(address indexed agent, bytes32 indexed node, int256 amountSpecified, bytes reason)",
  "event Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)",
  "event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)",
  "event AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes)",
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
  "event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
]);

const proxyDeployedEvent = parseAbi([
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
])[0];

const transferEvent = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
])[0];

/// What a refused swap can carry: the PoolManager's wrapper around a hook error, the hook's errors, and the
/// pool or token errors a swap can hit on its own.
const refusalAbi = parseAbi([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
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
  "error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

export type ActivityKind = "swap" | "refused" | "policy" | "issued" | "resolver" | "cut" | "funded";

export type ActivityItem = {
  kind: ActivityKind;
  block: bigint;
  logIndex: number;
  txHash: Hex;
  /// Agent node the item belongs to, null for org level items (vault funding).
  node: Hex | null;
  text: string;
  /// Resolver writes only: who sent the transaction, to tell the risk manager from the owner.
  from?: Address;
};

type Decoded = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  address: Address;
};

/// Every log of the org's contracts in `[from, to]`. Each agent has its own resolver: `resolvers` holds the ones
/// found so far and grows with the resolvers the owner deploys (`ProxyDeployed`, whose `initialize` writes the
/// policy in the same transaction) and the ones the registry points a name to (`ResolverUpdated`).
export async function fetchActivityLogs(
  client: PublicClient,
  d: Deployments,
  from: bigint,
  to: bigint,
  resolvers: Set<Address>,
): Promise<Decoded[]> {
  const add = (a: Address) => resolvers.add(a.toLowerCase() as Address);
  if (d.orgResolverPrevious) add(d.orgResolverPrevious);
  if (d.agentResolver) add(d.agentResolver);
  if (d.orgOwner) {
    const deployed = await client.getLogs({
      address: ENS_VERIFIABLE_FACTORY,
      event: proxyDeployedEvent,
      args: { sender: d.orgOwner },
      fromBlock: from,
      toBlock: to,
    });
    for (const l of deployed) {
      if (l.args.implementation?.toLowerCase() === ENS_PERMISSIONED_RESOLVER_IMPL.toLowerCase())
        add(l.args.proxyAddress!);
    }
  }
  const org = [d.hook, d.vault, d.vaultPrevious, d.orgRegistry].filter((a): a is Address => !!a);
  const tokens = [d.token0, d.token1].filter((a): a is Address => !!a);
  const [events, mints] = await Promise.all([
    client.getLogs({
      address: [...org, ...resolvers],
      events: activityEvents,
      fromBlock: from,
      toBlock: to,
    }),
    d.vault && tokens.length
      ? client.getLogs({
          address: tokens,
          event: transferEvent,
          args: { from: zeroAddress, to: d.vault },
          fromBlock: from,
          toBlock: to,
        })
      : Promise.resolve([]),
  ]);
  // A name pointed to a resolver nobody announced: read that resolver's logs of the range too.
  const unseen = [
    ...new Set(
      events
        .filter((l) => l.eventName === "ResolverUpdated")
        .map((l) => (l.args as { resolver: Address }).resolver.toLowerCase() as Address)
        .filter((a) => a !== zeroAddress && !resolvers.has(a)),
    ),
  ];
  unseen.forEach(add);
  const late = unseen.length
    ? await client.getLogs({
        address: unseen,
        events: activityEvents,
        fromBlock: from,
        toBlock: to,
      })
    : [];
  return [...events, ...late, ...mints].map((l) => ({
    eventName: l.eventName,
    args: l.args as Record<string, unknown>,
    blockNumber: l.blockNumber,
    logIndex: l.logIndex,
    transactionHash: l.transactionHash,
    address: l.address,
  }));
}

/// Turn raw logs into feed items, newest first. `senders` maps a transaction to its sender, for resolver writes.
export function buildActivity(
  logs: readonly Decoded[],
  d: Deployments,
  senders: ReadonlyMap<Hex, Address>,
): ActivityItem[] {
  // Record ids are numbered per resolver, and every agent has its own: key them by resolver.
  const record = (l: Decoded) => `${l.address.toLowerCase()}:${String(l.args.recordId)}`;
  const nodeOfRecord = new Map<string, Hex>();
  const labelOfToken = new Map<string, string>();
  const labelOfKey = new Map<bigint, string>();
  const labelOfNode = new Map<Hex, string>();
  const issuedInTx = new Set<Hex>();
  for (const l of logs) {
    if (l.eventName === "Linked") nodeOfRecord.set(record(l), l.args.node as Hex);
    if (l.eventName === "LabelRegistered") {
      const label = l.args.label as string;
      labelOfToken.set(String(l.args.tokenId), label);
      labelOfKey.set(labelKey(BigInt(l.args.tokenId as bigint)), label);
      labelOfNode.set(childNode(d.parentNode, label), label);
      issuedInTx.add(l.transactionHash);
    }
  }
  // Resolver a name got in the transaction that registered it, for the "issued" line.
  const resolverAtIssue = new Map<Hex, Address>();
  const name = (node: Hex | null) =>
    node && labelOfNode.has(node) ? `${labelOfNode.get(node)}.${d.parentName}` : "the agent";
  const quote = (raw: unknown) => `${formatAmount(BigInt(raw as bigint))} lUSD`;

  const items: ActivityItem[] = [];
  // Resolver writes of one transaction (an issuance writes five records) read as one line.
  const policyByTx = new Map<Hex, { node: Hex | null; parts: string[]; first: Decoded }>();

  const sorted = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : Number(a.blockNumber - b.blockNumber),
  );
  for (const l of sorted) {
    const base = { block: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash };
    switch (l.eventName) {
      case "LeashSwap": {
        const node = l.args.node as Hex;
        items.push({
          ...base,
          kind: "swap",
          node,
          text: `${name(node)} swapped ${quote(l.args.notional)}, spent today ${quote(l.args.spentToday)}`,
        });
        break;
      }
      case "SwapRefused": {
        const node = l.args.node as Hex;
        const amount = BigInt(l.args.amountSpecified as bigint);
        items.push({
          ...base,
          kind: "refused",
          node,
          text: `${name(node)} tried ${quote(amount < 0n ? -amount : amount)}: refused, ${explainRefusal(l.args.reason as Hex)}`,
        });
        break;
      }
      case "TextUpdated":
      case "AddressUpdated": {
        const node = nodeOfRecord.get(record(l)) ?? null;
        const entry = policyByTx.get(l.transactionHash) ?? { node, parts: [], first: l };
        entry.parts.push(policyPart(l));
        policyByTx.set(l.transactionHash, entry);
        break;
      }
      case "ResolverUpdated": {
        const resolver = l.args.resolver as Address;
        if (issuedInTx.has(l.transactionHash)) {
          resolverAtIssue.set(l.transactionHash, resolver);
          break;
        }
        const label = labelOfKey.get(labelKey(BigInt(l.args.tokenId as bigint)));
        if (!label || resolver === zeroAddress) break;
        items.push({
          ...base,
          kind: "resolver",
          node: childNode(d.parentNode, label),
          text: `${label}.${d.parentName} moved to its own resolver ${shortHex(resolver)}: its records, its roles`,
        });
        break;
      }
      case "LabelRegistered": {
        const label = l.args.label as string;
        const until = new Date(Number(l.args.expiry as bigint) * 1000).toISOString().slice(0, 16);
        items.push({
          ...base,
          kind: "issued",
          node: childNode(d.parentNode, label),
          text: `${label}.${d.parentName} issued, mandate until ${until.replace("T", " ")} UTC`,
        });
        break;
      }
      case "TransferSingle": {
        // `unregister` burns the name's token.
        if (l.args.to !== zeroAddress) break;
        const label = labelOfToken.get(String(l.args.id));
        if (!label) break;
        items.push({
          ...base,
          kind: "cut",
          node: childNode(d.parentNode, label),
          text: `${label}.${d.parentName} cut: the hook refuses every swap from now on`,
        });
        break;
      }
      case "Transfer": {
        const symbol = l.address.toLowerCase() === d.quote?.toLowerCase() ? "lUSD" : "lETH";
        items.push({
          ...base,
          kind: "funded",
          node: null,
          text: `org vault funded with ${formatAmount(BigInt(l.args.value as bigint))} ${symbol}`,
        });
        break;
      }
    }
  }
  // The registry emits ResolverUpdated before LabelRegistered: name the resolver on the issued line afterwards.
  // Names issued before every agent had its own resolver point to the org's shared one.
  const namesPerResolver = new Map<string, number>();
  for (const r of resolverAtIssue.values()) {
    namesPerResolver.set(r.toLowerCase(), (namesPerResolver.get(r.toLowerCase()) ?? 0) + 1);
  }
  const shared = (r: Address) =>
    (namesPerResolver.get(r.toLowerCase()) ?? 0) > 1 ||
    r.toLowerCase() === d.orgResolverPrevious?.toLowerCase();
  for (const item of items) {
    const resolver = item.kind === "issued" ? resolverAtIssue.get(item.txHash) : undefined;
    if (resolver && resolver !== zeroAddress) {
      const where = shared(resolver)
        ? `on the org's shared resolver ${shortHex(resolver)}`
        : `with its own resolver ${shortHex(resolver)}`;
      item.text = item.text.replace(" issued,", ` issued ${where},`);
    }
  }
  for (const [txHash, entry] of policyByTx) {
    const who = roleOf(senders.get(txHash), d);
    items.push({
      block: entry.first.blockNumber,
      logIndex: entry.first.logIndex,
      txHash,
      kind: "policy",
      node: entry.node,
      from: senders.get(txHash),
      text: `${who ? `${who} set ` : ""}${entry.parts.join(", ")}${entry.node ? ` on ${name(entry.node)}` : ""}`,
    });
  }
  return items.sort((a, b) =>
    a.block === b.block ? b.logIndex - a.logIndex : Number(b.block - a.block),
  );
}

/// Transactions whose sender the feed wants to show: resolver writes.
export function txsNeedingSender(logs: readonly Decoded[]): Hex[] {
  return [
    ...new Set(
      logs
        .filter((l) => l.eventName === "TextUpdated" || l.eventName === "AddressUpdated")
        .map((l) => l.transactionHash),
    ),
  ];
}

function roleOf(from: Address | undefined, d: Deployments): string | null {
  if (!from) return null;
  if (from.toLowerCase() === d.riskManager?.toLowerCase()) return "risk manager";
  if (from.toLowerCase() === d.orgOwner?.toLowerCase()) return "owner";
  return shortHex(from);
}

function policyPart(l: Decoded): string {
  if (l.eventName === "AddressUpdated")
    return `agent address ${shortHex(l.args.addressBytes as string)}`;
  const key = l.args.key as string;
  const value = l.args.value as string;
  switch (key) {
    case "leash.dailyNotional":
      return /^\d+$/.test(value) ? `cap ${formatAmount(BigInt(value))} lUSD` : `cap "${value}"`;
    case "leash.maxSlippageBps":
      return value === "" ? "no slippage bound" : `max slippage ${value} bps`;
    case "leash.tokens":
      return `allowed tokens (${value.split(",").filter(Boolean).length})`;
    case "leash.quote":
      return `quote ${shortHex(value)}`;
    default:
      return `${key} = ${value}`;
  }
}

/// One line for a refusal reason: the innermost error of the `WrappedError` chain, with its figures.
export function explainRefusal(reason: Hex): string {
  let data = reason;
  for (let depth = 0; depth < 8; depth++) {
    try {
      const d = decodeErrorResult({ abi: refusalAbi, data });
      if (d.errorName !== "WrappedError") return describe(d.errorName, d.args ?? []);
      data = (d.args as readonly unknown[])[2] as Hex;
    } catch {
      return `revert ${data.slice(0, 10)}`;
    }
  }
  return "revert";
}

function describe(name: string, args: readonly unknown[]): string {
  const q = (v: unknown) => `${formatUnits(BigInt(v as bigint), 18)} lUSD`;
  switch (name) {
    case "DailyCapExceeded":
      return `DailyCapExceeded (would reach ${q(args[1])} of cap ${q(args[2])})`;
    case "LeashRevoked":
      return "LeashRevoked (the name was cut or expired)";
    case "SlippageTooLoose":
      return "SlippageTooLoose (price limit wider than leash.maxSlippageBps)";
    case "BadSignature":
      return "BadSignature (not signed by the name's addr record)";
    case "TokenNotAllowed":
      return `TokenNotAllowed (${shortHex(String(args[0]))})`;
    default:
      return name;
  }
}
