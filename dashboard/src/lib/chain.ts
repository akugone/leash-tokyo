// RPC layer: turns a config + deployments into one Snapshot per poll. Every field is fetched
// independently so a single failing call never blanks the page.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  erc20Abi,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { hookAbi, leashSwapEvent, registryAbi, resolverAbi } from "./abi";
import {
  addrCalldata,
  blockRanges,
  childNode,
  decodeAddr,
  decodeText,
  dnsEncode,
  labelId,
  labelKey,
  lookbackStart,
  parseSlippageRecord,
  parseTokenList,
  ROLE_SET_TEXT,
  textCalldata,
  textResource,
  type Deployments,
} from "./leash";

export const POLL_MS = 5_000;
export const LOG_LOOKBACK = 5_000n;
export const LOG_CHUNK = 1_000n;
export const MAX_SWAPS = 10;

/// Blocks read again on every incremental scan. A public RPC balances requests across nodes: the head can come
/// from a node a block or two ahead of the one that serves the logs, whose last blocks then read empty. Without
/// the overlap those events would never be read. Callers dedupe what they read twice.
export const RESCAN_BLOCKS = 8n;

/// Start of the next incremental scan after `scannedTo`, overlapping the last `RESCAN_BLOCKS`.
export function rescanFrom(scannedTo: bigint): bigint {
  return scannedTo >= RESCAN_BLOCKS ? scannedTo - RESCAN_BLOCKS + 1n : 0n;
}

export type Policy = {
  agent: Address;
  quote: Address;
  cap: bigint;
  tokens: Address[];
  expiry: bigint;
  /// `leash.maxSlippageBps`, null when the record is empty (or the hook predates the bound) and nothing is enforced.
  maxSlippageBps: bigint | null;
  /// Set when the record is malformed: the hook then reverts `InvalidRecord` on every swap.
  maxSlippageError: string | null;
  /// "hook" when read through `policy()`, "resolver" when read directly (the hook reverted).
  source: "hook" | "resolver";
};

export type SwapRow = {
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  notional: bigint;
  spentToday: bigint;
  agent: Address;
};

/// One pool token held by the vault.
export type VaultHolding = { token: Address; symbol: string; balance: bigint };

/// `transient` marks a failed read that says nothing about the chain (rate limit, timeout, network), as opposed
/// to a contract revert. A transient failure keeps the last known value on screen.
export type Field<T> =
  { value: T; error: null } | { value: null; error: string; transient?: boolean };

/// Chain time anchor: `timestamp` of a block seen at local time `at` (ms). Chain now is
/// `timestamp + (Date.now() - at) / 1000`.
export type ChainClock = { timestamp: bigint; at: number };

export type Snapshot = {
  fetchedAt: number;
  blockNumber: bigint | null;
  blockTimestamp: bigint | null;
  /// Monotonic chain clock for countdowns, see `advanceClock`.
  clock: ChainClock | null;
  node: Hex;
  labelIdValue: bigint;
  owner: Field<Address>;
  expiry: Field<bigint>;
  /// What the registry answers now: the agent's own resolver, zero once the name is cut or expired.
  resolver: Field<Address>;
  /// The agent's own resolver, still known after the name was cut (from the registry's `ResolverUpdated` events).
  lastResolver: Address | null;
  /// Whether the deployment's risk manager holds `ROLE_SET_TEXT` on `leash.dailyNotional` in this agent's own
  /// resolver. Null when the record names no risk manager or the resolver is unknown.
  riskDelegated: Field<boolean> | null;
  policy: Field<Policy>;
  /// True when `policy()` reverted with LeashRevoked.
  revokedByHook: boolean;
  spentToday: Field<bigint>;
  /// From `remainingToday(label)`; the hook returns 0 when the name is revoked or has no resolver.
  remainingToday: Field<bigint>;
  nonce: Field<bigint>;
  /// Null when the deployment has no vault.
  vault: Field<VaultHolding[]> | null;
  swaps: SwapRow[];
  swapsError: string | null;
  scannedTo: bigint | null;
};

/// Multicall3, deployed at the same address on Sepolia and therefore on any anvil fork of it.
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/// One poll reads about ten views. Multicall batching folds them into one `eth_call` on the same block, which
/// keeps a public RPC under its rate limit and makes spent, remaining and cap consistent with each other.
export function makeClient(rpc: string, chainId: number): PublicClient {
  return createPublicClient({
    chain: {
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
      contracts: { multicall3: { address: MULTICALL3 } },
    },
    batch: { multicall: { wait: 16 } },
    transport: http(rpc, { timeout: 8_000, retryCount: 2, retryDelay: 400 }),
  });
}

/// Block timestamps lag real time by up to a block interval, by a different amount on every poll. Re-anchoring on
/// each block would make a countdown jump back and forth. Keep the anchor that puts chain time furthest ahead:
/// the freshest block seen so far, so chain time only moves forward.
export function advanceClock(
  previous: ChainClock | null,
  block: { timestamp: bigint } | null,
  at: number,
): ChainClock | null {
  if (!block) return previous;
  const next = { timestamp: block.timestamp, at };
  if (!previous) return next;
  // Compare `timestamp - at / 1000` without fractions: in milliseconds.
  const lead = (c: ChainClock) => c.timestamp * 1000n - BigInt(c.at);
  return lead(next) >= lead(previous) ? next : previous;
}

/// Chain now in seconds from a clock, at local time `nowMs`.
export function chainNow(clock: ChainClock | null, nowMs: number): bigint | null {
  if (!clock) return null;
  return clock.timestamp + BigInt(Math.floor((nowMs - clock.at) / 1000));
}

/// `next`, unless it is a transient failure and `previous` still holds a value.
export function sticky<T>(previous: Field<T> | null | undefined, next: Field<T>): Field<T> {
  if (next.error !== null && next.transient && previous?.value != null) return previous;
  return next;
}

function isRevert(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk((e) => e instanceof ContractFunctionRevertedError) instanceof
      ContractFunctionRevertedError
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? "revert";
      const args = revert.data?.args?.map((a) => String(a)).join(", ") ?? "";
      return args ? `${name}(${args})` : name;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

function isLeashRevoked(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return (
    revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "LeashRevoked"
  );
}

/// `maxSlippageBps(label)` result for the policy. A revert without a known error is a hook deployed before the
/// bound existed: nothing enforced. `InvalidRecord` means every swap fails, so it is kept as an error.
function slippageFromHook(
  res: Field<readonly [boolean, bigint]>,
): Pick<Policy, "maxSlippageBps" | "maxSlippageError"> {
  if (res.value)
    return { maxSlippageBps: res.value[0] ? res.value[1] : null, maxSlippageError: null };
  if (res.error.startsWith("InvalidRecord")) {
    return {
      maxSlippageBps: null,
      maxSlippageError: "malformed record, the hook rejects every swap",
    };
  }
  return { maxSlippageBps: null, maxSlippageError: null };
}

async function field<T>(p: Promise<T>): Promise<Field<T>> {
  try {
    return { value: await p, error: null };
  } catch (err) {
    return { value: null, error: errorMessage(err), transient: !isRevert(err) };
  }
}

/// Reads the policy straight from the resolver, the same path the hook takes. Used as a fallback when the
/// hook refuses to answer (revoked name) so the last known leash length is still visible.
async function readPolicyFromResolver(
  client: PublicClient,
  resolver: Address,
  dnsName: Hex,
  expiry: bigint,
): Promise<Policy> {
  const call = (data: Hex) =>
    client.readContract({
      address: resolver,
      abi: resolverAbi,
      functionName: "resolve",
      args: [dnsName, data],
    });
  const [agentRaw, quoteRaw, capRaw, tokensRaw, slippageRaw] = await Promise.all([
    call(addrCalldata()),
    call(textCalldata("leash.quote")),
    call(textCalldata("leash.dailyNotional")),
    call(textCalldata("leash.tokens")),
    call(textCalldata("leash.maxSlippageBps")),
  ]);
  const capText = decodeText(capRaw).trim();
  const slippage = parseSlippageRecord(decodeText(slippageRaw));
  return {
    agent: decodeAddr(agentRaw),
    quote: decodeText(quoteRaw).trim() as Address,
    cap: capText ? BigInt(capText) : 0n,
    tokens: parseTokenList(decodeText(tokensRaw)),
    expiry,
    maxSlippageBps: slippage.bps,
    maxSlippageError: slippage.error,
    source: "resolver",
  };
}

async function fetchSwaps(
  client: PublicClient,
  hook: Address,
  node: Hex,
  from: bigint,
  to: bigint,
): Promise<SwapRow[]> {
  const rows: SwapRow[] = [];
  for (const range of blockRanges(from, to, LOG_CHUNK)) {
    const logs = await client.getLogs({
      address: hook,
      event: leashSwapEvent,
      args: { node },
      fromBlock: range.from,
      toBlock: range.to,
    });
    for (const log of logs) {
      rows.push({
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        txHash: log.transactionHash,
        notional: log.args.notional!,
        spentToday: log.args.spentToday!,
        agent: log.args.agent!,
      });
    }
  }
  return rows;
}

export function mergeSwaps(previous: SwapRow[], fresh: SwapRow[]): SwapRow[] {
  const seen = new Map<string, SwapRow>();
  for (const row of [...previous, ...fresh]) seen.set(`${row.txHash}:${row.logIndex}`, row);
  return [...seen.values()]
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? b.logIndex - a.logIndex
        : Number(b.blockNumber - a.blockNumber),
    )
    .slice(0, MAX_SWAPS);
}

/// Balances of the pool tokens in the vault. Symbols are read each poll, cheap next to the log scan.
async function fetchVault(
  client: PublicClient,
  vault: Address,
  deployments: Deployments,
): Promise<VaultHolding[]> {
  const tokens = [deployments.token0, deployments.token1].filter((t): t is Address => !!t);
  return Promise.all(
    tokens.map(async (token) => {
      const [symbol, balance] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [vault],
        }),
      ]);
      return { token, symbol, balance };
    }),
  );
}

// ============ Agents of the org ============

/// Emitted by the org registry on every `register`, with the label in clear.
export const labelRegisteredEvent = parseAbiItem(
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
);

/// Emitted by the org registry when a name is registered with a resolver, and on every `setResolver`: each agent
/// points to its own resolver.
export const resolverUpdatedEvent = parseAbiItem(
  "event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)",
);

/// Public RPCs accept wide log ranges when the query is filtered on one address: 50k blocks is about a week.
export const AGENT_LOG_CHUNK = 50_000n;

/// What the registry's logs in a range say about the org's agents: labels in first registration order, no
/// duplicates (a re-issued name appears once), and each name's resolver in the order it was set, keyed by
/// `labelKey` (the token id changes when a name is re-issued, its key does not).
export type AgentLogs = {
  labels: string[];
  resolvers: { key: bigint; resolver: Address }[];
};

export async function fetchAgentLabels(
  client: PublicClient,
  registry: Address,
  from: bigint,
  to: bigint,
): Promise<AgentLogs> {
  const out: AgentLogs = { labels: [], resolvers: [] };
  for (const range of blockRanges(from, to, AGENT_LOG_CHUNK)) {
    const logs = await client.getLogs({
      address: registry,
      events: [labelRegisteredEvent, resolverUpdatedEvent],
      fromBlock: range.from,
      toBlock: range.to,
    });
    for (const log of logs) {
      if (log.eventName === "LabelRegistered") {
        const label = log.args.label;
        if (label && !out.labels.includes(label)) out.labels.push(label);
      } else if (log.args.tokenId !== undefined && log.args.resolver) {
        out.resolvers.push({ key: labelKey(log.args.tokenId), resolver: log.args.resolver });
      }
    }
  }
  return out;
}

/// The last resolver the registry pointed `label` to, zero address excluded. Null when it never had one.
export function lastResolverOf(resolvers: AgentLogs["resolvers"], label: string): Address | null {
  const key = labelKey(labelId(label));
  const set = resolvers.filter(
    (r) => r.key === key && r.resolver !== "0x0000000000000000000000000000000000000000",
  );
  return set.length ? set[set.length - 1].resolver : null;
}

/// Current expiry of each label, read in one multicall. Zero once cut.
export async function fetchExpiries(
  client: PublicClient,
  registry: Address,
  labels: readonly string[],
): Promise<bigint[]> {
  return Promise.all(
    labels.map((label) =>
      client
        .readContract({
          address: registry,
          abi: registryAbi,
          functionName: "getExpiry",
          args: [labelId(label)],
        })
        .then(BigInt),
    ),
  );
}

export async function fetchSnapshot(
  client: PublicClient,
  deployments: Deployments,
  label: string,
  previous: Snapshot | null,
): Promise<Snapshot> {
  const id = labelId(label);
  const node = childNode(deployments.parentNode, label);
  const dnsName = dnsEncode(`${label}.${deployments.parentName}`);
  const registry = { address: deployments.orgRegistry, abi: registryAbi } as const;
  const hook = { address: deployments.hook, abi: hookAbi } as const;

  let blockAt = Date.now();
  const blockP = field(
    client.getBlock({ blockTag: "latest" }).then((b) => {
      blockAt = Date.now();
      return b;
    }),
  );
  const [
    block,
    owner,
    expiry,
    resolver,
    policyRaw,
    spentToday,
    remainingToday,
    nonce,
    slippage,
    vault,
  ] = await Promise.all([
    blockP,
    field(client.readContract({ ...registry, functionName: "getOwner", args: [id] })),
    field(client.readContract({ ...registry, functionName: "getExpiry", args: [id] })),
    field(client.readContract({ ...registry, functionName: "getResolver", args: [label] })),
    client
      .readContract({ ...hook, functionName: "policy", args: [label] })
      .then((r) => ({ ok: true as const, value: r }))
      .catch((err: unknown) => ({ ok: false as const, err })),
    field(client.readContract({ ...hook, functionName: "spentToday", args: [node] })),
    field(client.readContract({ ...hook, functionName: "remainingToday", args: [label] })),
    field(client.readContract({ ...hook, functionName: "nonces", args: [node] })),
    field(client.readContract({ ...hook, functionName: "maxSlippageBps", args: [label] })),
    deployments.vault ? field(fetchVault(client, deployments.vault, deployments)) : null,
  ]);

  // The agent's own resolver. A cut name reads zero from the registry: find the one it had in the registry's logs.
  const liveResolver =
    resolver.value && resolver.value !== "0x0000000000000000000000000000000000000000"
      ? resolver.value
      : null;
  let lastResolver = liveResolver ?? previous?.lastResolver ?? null;
  // A name never issued has expiry zero: nothing to look for.
  if (!lastResolver && resolver.value !== null && expiry.value && block.value) {
    const from = deployments.orgRegistryBlock
      ? BigInt(deployments.orgRegistryBlock)
      : lookbackStart(block.value.number, LOG_LOOKBACK);
    const history = await field(
      fetchAgentLabels(client, deployments.orgRegistry, from, block.value.number),
    );
    lastResolver = history.value ? lastResolverOf(history.value.resolvers, label) : null;
  }
  const riskDelegated =
    lastResolver && deployments.riskManager
      ? sticky(
          previous?.riskDelegated,
          await field(
            client.readContract({
              address: lastResolver,
              abi: resolverAbi,
              functionName: "hasRoles",
              args: [textResource("leash.dailyNotional"), ROLE_SET_TEXT, deployments.riskManager],
            }),
          ),
        )
      : null;

  let policy: Field<Policy>;
  let revokedByHook = false;
  if (policyRaw.ok) {
    const [agent, quote, cap, tokens, exp] = policyRaw.value;
    policy = {
      value: {
        agent,
        quote,
        cap,
        tokens: [...tokens],
        expiry: BigInt(exp),
        ...slippageFromHook(slippage),
        source: "hook",
      },
      error: null,
    };
  } else {
    revokedByHook = isLeashRevoked(policyRaw.err);
    const hookError = errorMessage(policyRaw.err);
    // Fall back to the agent's own resolver so the last known leash length stays on screen.
    if (lastResolver) {
      const fromResolver = await field(
        readPolicyFromResolver(client, lastResolver, dnsName, expiry.value ?? 0n),
      );
      policy = fromResolver.value
        ? { value: fromResolver.value, error: null }
        : { value: null, error: `${hookError}; resolver: ${fromResolver.error}` };
    } else {
      policy = { value: null, error: hookError };
    }
    // A rate limited read is not a revoked name: keep what was on screen.
    if (!isRevert(policyRaw.err) && policy.value === null && previous?.policy.value) {
      policy = previous.policy;
      revokedByHook = previous.revokedByHook;
    }
  }

  // Swap log scan: full lookback on the first poll, incremental afterwards.
  let swaps = previous?.swaps ?? [];
  let swapsError: string | null = null;
  let scannedTo = previous?.scannedTo ?? null;
  if (block.value) {
    const latest = block.value.number;
    const from = scannedTo !== null ? rescanFrom(scannedTo) : lookbackStart(latest, LOG_LOOKBACK);
    if (from <= latest) {
      try {
        swaps = mergeSwaps(swaps, await fetchSwaps(client, deployments.hook, node, from, latest));
        scannedTo = latest;
      } catch (err) {
        swapsError = errorMessage(err);
      }
    }
  } else {
    swapsError = block.error;
  }

  return {
    fetchedAt: Date.now(),
    blockNumber: block.value?.number ?? previous?.blockNumber ?? null,
    blockTimestamp: block.value?.timestamp ?? previous?.blockTimestamp ?? null,
    clock: advanceClock(previous?.clock ?? null, block.value, blockAt),
    node,
    labelIdValue: id,
    owner: sticky(previous?.owner, owner),
    expiry: sticky(
      previous?.expiry,
      expiry.value !== null ? { value: BigInt(expiry.value), error: null } : expiry,
    ),
    resolver: sticky(previous?.resolver, resolver),
    lastResolver,
    riskDelegated,
    policy,
    revokedByHook,
    spentToday: sticky(previous?.spentToday, spentToday),
    remainingToday: sticky(previous?.remainingToday, remainingToday),
    nonce: sticky(previous?.nonce, nonce),
    vault: vault && previous?.vault ? sticky(previous.vault, vault) : vault,
    swaps,
    swapsError,
    scannedTo,
  };
}
