import {
  BaseError,
  ContractFunctionRevertedError,
  RawContractError,
  decodeErrorResult,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { LEASH_HOOK_ABI, WRAPPED_ERROR_ABI } from "./abi.ts";

export type DecodedRevert = {
  /** Error name, `Unknown` when the selector matches nothing we know. */
  name: string;
  args: readonly unknown[];
  /** Contract that reverted, from the innermost `WrappedError`. */
  target?: Address;
  /** Raw innermost revert data. */
  data: Hex;
};

/** Context used to render node hashes as human readable names. */
export type NameContext = {
  label: string;
  parentName: string;
  /** Quote token decimals and symbol: when set, amounts are rendered in human units instead of raw wei. */
  decimals?: number;
  symbol?: string;
};

const WRAPPED_ERROR_SELECTOR = "0x90bfb865" as const; // WrappedError(address,bytes4,bytes,bytes)
const ERROR_STRING_SELECTOR = "0x08c379a0" as const; // Error(string)
const PANIC_SELECTOR = "0x4e487b71" as const; // Panic(uint256)

/**
 * Unwrap nested ERC-7751 `WrappedError` payloads and decode the innermost reason with the hook ABI.
 * Falls back to `Error(string)` and `Panic(uint256)` so plain reverts also get a name.
 */
export function decodeRevertData(data: Hex): DecodedRevert {
  let current: Hex = data;
  let target: Address | undefined;
  // Bounded loop: the PoolManager wraps at most a handful of levels (unlock -> callback -> hook).
  for (let depth = 0; depth < 8; depth++) {
    if (!current.toLowerCase().startsWith(WRAPPED_ERROR_SELECTOR)) break;
    const wrapped = decodeErrorResult({ abi: WRAPPED_ERROR_ABI, data: current });
    const [wrappedTarget, , reason] = wrapped.args as readonly [Address, Hex, Hex, Hex];
    target = wrappedTarget;
    if (reason === "0x" || reason.length < 10) {
      return { name: "EmptyRevert", args: [], target, data: reason };
    }
    current = reason;
  }
  const selector = current.slice(0, 10).toLowerCase();
  if (selector === ERROR_STRING_SELECTOR) {
    const decoded = decodeErrorResult({ abi: ERROR_STRING_ABI, data: current });
    return { name: "Error", args: decoded.args ?? [], target, data: current };
  }
  if (selector === PANIC_SELECTOR) {
    const decoded = decodeErrorResult({ abi: PANIC_ABI, data: current });
    return { name: "Panic", args: decoded.args ?? [], target, data: current };
  }
  try {
    const decoded = decodeErrorResult({ abi: LEASH_HOOK_ABI, data: current });
    return { name: decoded.errorName, args: decoded.args ?? [], target, data: current };
  } catch {
    return { name: "Unknown", args: [], target, data: current };
  }
}

/** Pull the raw revert bytes out of a viem error thrown by `simulateContract` or `writeContract`. */
export function revertDataFromError(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
  const raw = err.walk((e) => e instanceof RawContractError);
  if (raw instanceof RawContractError) {
    const d = raw.data;
    if (typeof d === "string") return d as Hex;
    if (d && typeof d === "object" && "data" in d && typeof d.data === "string") return d.data as Hex;
  }
  return undefined;
}

/** One line, demo friendly explanation of a decoded revert. */
export function explainRevert(decoded: DecodedRevert, ctx: NameContext): string {
  const fullName = `${ctx.label}.${ctx.parentName}`;
  const a = decoded.args;
  switch (decoded.name) {
    case "LeashRevoked":
      return `LeashRevoked: ${fullName} was cut at ${formatTimestamp(a[1] as bigint)} (node ${short(a[0])})`;
    case "DailyCapExceeded":
      return `DailyCapExceeded: ${fullName} would reach ${amount(a[1], ctx)} of cap ${amount(a[2], ctx)} today`;
    case "NodeMismatch":
      return `NodeMismatch: hook derived ${short(a[0])} but intent carries ${short(a[1])}`;
    case "NoResolver":
      return `NoResolver: ${fullName} has no resolver (expired or never registered)`;
    case "NoAgent":
      return `NoAgent: ${fullName} has no addr record, nobody may sign for it`;
    case "IntentExpired":
      return `IntentExpired: deadline ${formatTimestamp(a[0] as bigint)} is before block time ${formatTimestamp(a[1] as bigint)}`;
    case "BadNonce":
      return `BadNonce: ${fullName} expects nonce ${a[1]}, intent has ${a[2]}`;
    case "IntentMismatch":
      return "IntentMismatch: signed intent does not match the swap params (poolId, direction or amount)";
    case "BadSignature":
      return `BadSignature: agent record is ${a[0]} but the intent was signed by ${a[1]}`;
    case "TokenNotAllowed":
      return `TokenNotAllowed: ${a[0]} is not in leash.tokens`;
    case "QuoteNotInPool":
      return `QuoteNotInPool: leash.quote ${a[0]} is not one of the pool currencies`;
    case "InvalidRecord":
      return `InvalidRecord: text record "${a[0]}" is malformed, the hook fails closed`;
    case "Error":
      return `Error: ${a[0]}`;
    case "Panic":
      return `Panic: code ${a[0]}`;
    case "EmptyRevert":
      return `Revert without data${decoded.target ? ` from ${decoded.target}` : ""}`;
    default:
      return `${decoded.name}: ${decoded.data.slice(0, 10)}${decoded.target ? ` from ${decoded.target}` : ""}`;
  }
}

function amount(v: unknown, ctx: NameContext): string {
  if (ctx.decimals === undefined || typeof v !== "bigint") return String(v);
  return `${formatUnits(v, ctx.decimals)}${ctx.symbol ? ` ${ctx.symbol}` : ""}`;
}

function short(v: unknown): string {
  const s = String(v);
  return s.length > 14 ? `${s.slice(0, 8)}..${s.slice(-4)}` : s;
}

function formatTimestamp(ts: bigint): string {
  return `${ts} (${new Date(Number(ts) * 1000).toISOString()})`;
}

const ERROR_STRING_ABI = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as const;
const PANIC_ABI = [{ type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] }] as const;
