// RPC layer: turns a config + deployments into one Snapshot per poll. Every field is fetched
// independently so a single failing call never blanks the page.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
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
  lookbackStart,
  parseTokenList,
  textCalldata,
  type Deployments,
} from "./leash";

export const POLL_MS = 5_000;
export const LOG_LOOKBACK = 5_000n;
export const LOG_CHUNK = 1_000n;
export const MAX_SWAPS = 10;

export type Policy = {
  agent: Address;
  quote: Address;
  cap: bigint;
  tokens: Address[];
  expiry: bigint;
  /// `leash.maxSlippageBps`, null when the record is empty and the hook does not bound slippage.
  maxSlippageBps: bigint | null;
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

export type Field<T> = { value: T; error: null } | { value: null; error: string };

export type Snapshot = {
  fetchedAt: number;
  blockNumber: bigint | null;
  blockTimestamp: bigint | null;
  node: Hex;
  labelIdValue: bigint;
  owner: Field<Address>;
  expiry: Field<bigint>;
  resolver: Field<Address>;
  policy: Field<Policy>;
  /// True when `policy()` reverted with LeashRevoked.
  revokedByHook: boolean;
  spentToday: Field<bigint>;
  /// From `remainingToday(label)`; the hook returns 0 when the name is revoked or has no resolver.
  remainingToday: Field<bigint>;
  nonce: Field<bigint>;
  swaps: SwapRow[];
  swapsError: string | null;
  scannedTo: bigint | null;
};

export function makeClient(rpc: string, chainId: number): PublicClient {
  return createPublicClient({
    chain: {
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    },
    transport: http(rpc, { timeout: 8_000, retryCount: 1 }),
  });
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

async function field<T>(p: Promise<T>): Promise<Field<T>> {
  try {
    return { value: await p, error: null };
  } catch (err) {
    return { value: null, error: errorMessage(err) };
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
  const slippageText = decodeText(slippageRaw).trim();
  return {
    agent: decodeAddr(agentRaw),
    quote: decodeText(quoteRaw).trim() as Address,
    cap: capText ? BigInt(capText) : 0n,
    tokens: parseTokenList(decodeText(tokensRaw)),
    expiry,
    maxSlippageBps: /^\d+$/.test(slippageText) ? BigInt(slippageText) : null,
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

  const blockP = field(client.getBlock({ blockTag: "latest" }));
  const [block, owner, expiry, resolver, policyRaw, spentToday, remainingToday, nonce, slippage] =
    await Promise.all([
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
    ]);

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
        maxSlippageBps: slippage.value && slippage.value[0] ? slippage.value[1] : null,
        source: "hook",
      },
      error: null,
    };
  } else {
    revokedByHook = isLeashRevoked(policyRaw.err);
    const hookError = errorMessage(policyRaw.err);
    // Fall back to the org resolver so the last known leash length stays on screen.
    const fallbackResolver =
      resolver.value && resolver.value !== "0x0000000000000000000000000000000000000000"
        ? resolver.value
        : deployments.orgResolver;
    if (fallbackResolver) {
      const fromResolver = await field(
        readPolicyFromResolver(client, fallbackResolver, dnsName, expiry.value ?? 0n),
      );
      policy = fromResolver.value
        ? { value: fromResolver.value, error: null }
        : { value: null, error: `${hookError}; resolver: ${fromResolver.error}` };
    } else {
      policy = { value: null, error: hookError };
    }
  }

  // Swap log scan: full lookback on the first poll, incremental afterwards.
  let swaps = previous?.swaps ?? [];
  let swapsError: string | null = null;
  let scannedTo = previous?.scannedTo ?? null;
  if (block.value) {
    const latest = block.value.number;
    const from = scannedTo !== null ? scannedTo + 1n : lookbackStart(latest, LOG_LOOKBACK);
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
    blockNumber: block.value?.number ?? null,
    blockTimestamp: block.value?.timestamp ?? null,
    node,
    labelIdValue: id,
    owner,
    expiry: expiry.value !== null ? { value: BigInt(expiry.value), error: null } : expiry,
    resolver,
    policy,
    revokedByHook,
    spentToday,
    remainingToday,
    nonce,
    swaps,
    swapsError,
    scannedTo,
  };
}
