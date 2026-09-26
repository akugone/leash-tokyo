// Pure helpers for the Leash dashboard: naming, config, formatting, status. No RPC here.
import {
  decodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  isAddress,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { resolverInnerAbi } from "./abi";

// ============ Naming ============

/// DNS wire encoding of a dotted name, e.g. "trader-1.acme.eth" -> 0x08trader-1 04acme 03eth 00.
export function dnsEncode(name: string): Hex {
  const labels = name.split(".").filter((l) => l.length > 0);
  let out = "0x";
  for (const label of labels) {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length > 255) throw new Error(`label too long: ${label}`);
    out += toHex(bytes.length).slice(2).padStart(2, "0") + stringToHex(label).slice(2);
  }
  return (out + "00") as Hex;
}

/// ENS namehash. Empty name is the zero node.
export function namehash(name: string): Hex {
  let node: Hex = `0x${"00".repeat(32)}`;
  if (name.length === 0) return node;
  const labels = name.split(".");
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelHash = keccak256(stringToHex(labels[i]));
    node = keccak256(encodePacked(["bytes32", "bytes32"], [node, labelHash]));
  }
  return node;
}

/// `uint256(keccak256(label))`, the anyId the registry expects.
export function labelId(label: string): bigint {
  return BigInt(keccak256(stringToHex(label)));
}

/// Node of `label` under `parentNode`.
export function childNode(parentNode: Hex, label: string): Hex {
  return keccak256(
    encodePacked(["bytes32", "bytes32"], [parentNode, keccak256(stringToHex(label))]),
  );
}

// ============ Resolver calldata ============

export const ZERO_NODE: Hex = `0x${"00".repeat(32)}`;

export function textCalldata(key: string): Hex {
  return encodeFunctionData({
    abi: resolverInnerAbi,
    functionName: "text",
    args: [ZERO_NODE, key],
  });
}

export function addrCalldata(): Hex {
  return encodeFunctionData({ abi: resolverInnerAbi, functionName: "addr", args: [ZERO_NODE] });
}

export function decodeText(ret: Hex): string {
  return decodeAbiParameters([{ type: "string" }], ret)[0];
}

export function decodeAddr(ret: Hex): Address {
  return decodeAbiParameters([{ type: "address" }], ret)[0];
}

/// `leash.tokens` is a comma separated list of addresses.
export function parseTokenList(value: string): Address[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isAddress(s)) as Address[];
}

/// `leash.maxSlippageBps` as the hook parses it: empty means not enforced, otherwise a base 10 integer below 10000.
/// Anything else makes the hook revert `InvalidRecord` on every swap, so it is reported, never shown as "no bound".
export type SlippageRecord = { bps: bigint | null; error: string | null };

export function parseSlippageRecord(value: string): SlippageRecord {
  if (value === "") return { bps: null, error: null };
  if (!/^[0-9]{1,78}$/.test(value)) return { bps: null, error: `malformed record "${value}"` };
  const bps = BigInt(value);
  if (bps >= 10_000n) return { bps: null, error: `out of range "${value}" (max 9999)` };
  return { bps, error: null };
}

/// Validation of a slippage value typed in the dashboard, before the owner writes it. Stricter than the record:
/// empty would switch the bound off and 0 would freeze every swap, so the UI only offers 1 to 9999.
export function slippageInputError(value: string): string | null {
  if (value.trim() === "") return "enter a value in basis points";
  const { bps, error } = parseSlippageRecord(value.trim());
  if (error) return "whole number of basis points, 1 to 9999";
  if (bps === 0n) return "0 would block every swap, use 1 to 9999";
  return null;
}

// ============ Config ============

export type DashboardConfig = {
  rpc: string;
  deployments: string;
  label: string;
};

export const DEFAULT_CONFIG: DashboardConfig = {
  rpc: "http://127.0.0.1:8545",
  deployments: "/deployments.json",
  label: "trader-1",
};

export function parseConfig(
  search: string,
  defaults: DashboardConfig = DEFAULT_CONFIG,
): DashboardConfig {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    rpc: params.get("rpc") || defaults.rpc,
    deployments: params.get("deployments") || defaults.deployments,
    label: params.get("label") || defaults.label,
  };
}

export function configToSearch(
  config: DashboardConfig,
  defaults: DashboardConfig = DEFAULT_CONFIG,
): string {
  const params = new URLSearchParams();
  if (config.rpc !== defaults.rpc) params.set("rpc", config.rpc);
  if (config.deployments !== defaults.deployments) params.set("deployments", config.deployments);
  if (config.label !== defaults.label) params.set("label", config.label);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export type Deployments = {
  chainId: string;
  parentLabel: string;
  parentName: string;
  parentNode: Hex;
  orgOwner?: Address;
  riskManager?: Address;
  agent?: Address;
  agentLabel?: string;
  orgRegistry: Address;
  orgResolver?: Address;
  hook: Address;
  token0?: Address;
  token1?: Address;
  quote?: Address;
  fee?: string;
  tickSpacing?: string;
  poolId?: Hex;
};

const REQUIRED_KEYS: (keyof Deployments)[] = ["chainId", "parentName", "orgRegistry", "hook"];

/// Validates a deployments JSON blob. Throws a readable message on missing keys.
export function parseDeployments(json: unknown): Deployments {
  if (typeof json !== "object" || json === null)
    throw new Error("deployments must be a JSON object");
  const obj = json as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (typeof obj[key] !== "string" || (obj[key] as string).length === 0) {
      throw new Error(`deployments.json is missing "${key}"`);
    }
  }
  for (const key of ["orgRegistry", "hook", "orgResolver", "orgOwner", "agent", "quote"] as const) {
    const v = obj[key];
    if (v !== undefined && !isAddress(v as string))
      throw new Error(`deployments.${key} is not an address`);
  }
  const out = obj as unknown as Deployments;
  const hasParentNode =
    typeof out.parentNode === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(out.parentNode) &&
    out.parentNode !== ZERO_NODE;
  return { ...out, parentNode: hasParentNode ? out.parentNode : namehash(out.parentName) };
}

// ============ Status ============

export type LeashStatus = "live" | "expiring" | "revoked" | "unknown";

export const EXPIRING_WINDOW_SECONDS = 10n * 60n;

/// `expiry` in seconds, `now` in seconds (chain time). `revokedByHook` is true when `policy()` reverted
/// with LeashRevoked. The registry treats `now >= expiry` as expired.
export function computeStatus(args: {
  expiry: bigint | null;
  now: bigint;
  revokedByHook: boolean;
}): LeashStatus {
  const { expiry, now, revokedByHook } = args;
  if (revokedByHook) return "revoked";
  if (expiry === null) return "unknown";
  if (expiry <= now) return "revoked";
  if (expiry - now < EXPIRING_WINDOW_SECONDS) return "expiring";
  return "live";
}

export function remaining(cap: bigint | null, spent: bigint | null): bigint | null {
  if (cap === null || spent === null) return null;
  return cap > spent ? cap - spent : 0n;
}

/// Fraction of the cap spent, clamped to [0, 1]. Returns 0 when cap is 0 or unknown.
export function spentFraction(cap: bigint | null, spent: bigint | null): number {
  if (cap === null || spent === null || cap === 0n) return 0;
  if (spent >= cap) return 1;
  return Number((spent * 10_000n) / cap) / 10_000;
}

// ============ Formatting ============

/// Human readable 18 decimal amount: thousands separators, at most `maxFrac` fraction digits, trailing zeros trimmed.
export function formatAmount(raw: bigint, decimals = 18, maxFrac = 4): string {
  const s = formatUnits(raw, decimals);
  const [int, frac = ""] = s.split(".");
  const negative = int.startsWith("-");
  const digits = negative ? int.slice(1) : int;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  return (negative ? "-" : "") + grouped + (trimmed ? `.${trimmed}` : "");
}

export function shortHex(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/// "1d 02:03:04" or "02:03:04" or "expired".
export function formatCountdown(seconds: bigint): string {
  if (seconds <= 0n) return "expired";
  const s = Number(seconds);
  const days = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const clock = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

export function formatUtc(seconds: bigint): string {
  return new Date(Number(seconds) * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

// ============ Block ranges ============

/// Splits [from, to] into inclusive chunks of at most `chunk` blocks, oldest first.
export function blockRanges(
  from: bigint,
  to: bigint,
  chunk: bigint,
): { from: bigint; to: bigint }[] {
  if (chunk <= 0n) throw new Error("chunk must be positive");
  const out: { from: bigint; to: bigint }[] = [];
  let start = from;
  while (start <= to) {
    const end = start + chunk - 1n < to ? start + chunk - 1n : to;
    out.push({ from: start, to: end });
    start = end + 1n;
  }
  return out;
}

export function lookbackStart(latest: bigint, lookback: bigint): bigint {
  return latest > lookback ? latest - lookback : 0n;
}
