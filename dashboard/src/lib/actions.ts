// The human actions of the demo as plain contract calls, shared by the dev server (keys from .env) and the
// browser (connected wallet). Each builder returns what viem's writeContract / simulateContract take.
import { BaseError, parseAbi, parseUnits, type Address } from "viem";
import { dnsEncode, labelId } from "./leash";

export const EAC_UNAUTHORIZED = "0x4b27a133"; // EACUnauthorizedAccountRoles(uint256,uint256,address)

export const resolverWriteAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addr)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
]);

export const registryWriteAbi = parseAbi([
  "function unregister(uint256 anyId)",
  "function getExpiry(uint256 anyId) view returns (uint64)",
]);

/// Where the agent's name lives: its label under `parentName`, the org registry and resolver.
export type LeashTarget = {
  label: string;
  parentName: string;
  registry: Address;
  resolver: Address;
};

function name(t: LeashTarget) {
  return dnsEncode(`${t.label}.${t.parentName}`);
}

/// Risk manager: `leash.dailyNotional` to `capHuman` quote tokens (18 decimals).
export function tightenCall(t: LeashTarget, capHuman: string) {
  const raw = parseUnits(capHuman, 18).toString();
  return {
    address: t.resolver,
    abi: resolverWriteAbi,
    functionName: "setText",
    args: [name(t), "leash.dailyNotional", raw],
  } as const;
}

/// Owner only: the risk manager holds no role on this key (clearing it would switch the bound off).
export function slippageCall(t: LeashTarget, bps: string) {
  return {
    address: t.resolver,
    abi: resolverWriteAbi,
    functionName: "setText",
    args: [name(t), "leash.maxSlippageBps", bps],
  } as const;
}

/// Owner: `unregister` sets the name's expiry to now, the hook refuses the next swap.
export function cutCall(t: LeashTarget) {
  return {
    address: t.registry,
    abi: registryWriteAbi,
    functionName: "unregister",
    args: [labelId(t.label)],
  } as const;
}

/// What the risk manager must not be able to do. Simulated only: every one must revert.
export function forbiddenCalls(t: LeashTarget, riskManager: Address) {
  return [
    { what: "unregister(trader) by risk-manager", call: cutCall(t) },
    {
      what: "setAddress(agent) by risk-manager",
      call: {
        address: t.resolver,
        abi: resolverWriteAbi,
        functionName: "setAddress",
        args: [name(t), 60n, riskManager],
      } as const,
    },
    {
      what: "setText(leash.quote) by risk-manager",
      call: {
        address: t.resolver,
        abi: resolverWriteAbi,
        functionName: "setText",
        args: [name(t), "leash.quote", riskManager],
      } as const,
    },
    { what: "setText(leash.maxSlippageBps) by risk-manager", call: slippageCall(t, "") },
  ];
}

/// First four bytes of the revert data carried by a viem error, lowercased.
export function revertSelector(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const found = err.walk(
    (e) =>
      typeof (e as { data?: unknown }).data === "string" ||
      typeof (e as { raw?: unknown }).raw === "string",
  );
  const data =
    (found as { raw?: string; data?: string } | null)?.raw ??
    (found as { data?: string } | null)?.data;
  return typeof data === "string" && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
}

/// "PASS <what> -> EACUnauthorizedAccountRoles" when the simulation reverted as it must.
export function forbiddenOutcome(what: string, err: unknown | null): { ok: boolean; text: string } {
  if (err === null) return { ok: false, text: `FAIL ${what} -> unexpectedly allowed` };
  const sel = revertSelector(err);
  const reason =
    sel === EAC_UNAUTHORIZED ? "EACUnauthorizedAccountRoles" : `reverted${sel ? ` (${sel})` : ""}`;
  return { ok: true, text: `PASS ${what} -> ${reason}` };
}
