// The human actions of the demo as plain contract calls, shared by the dev server (keys from .env) and the
// browser (connected wallet). Each builder returns what viem's writeContract / simulateContract take.
import {
  BaseError,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem";
import { dnsEncode, labelId } from "./leash";

export const EAC_UNAUTHORIZED = "0x4b27a133"; // EACUnauthorizedAccountRoles(uint256,uint256,address)

export const resolverWriteAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addr)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
]);

export const registryWriteAbi = parseAbi([
  "function register(string label, address owner, address subregistry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256 tokenId)",
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

// ============ Issuing an agent ============

/// `LeashOrgLib.agentTokenRoles()`: ROLE_UNREGISTER | ROLE_RENEW | ROLE_SET_RESOLVER, granted to the owner on the token.
export const AGENT_TOKEN_ROLES = (1n << 12n) | (1n << 16n) | (1n << 24n);

/// A new agent name and its whole policy, as the owner types it.
export type AgentSpec = {
  label: string;
  /// Address the agent signs with, written as the name's ETH address record.
  agent: Address;
  /// Holds the subname token and the org roles.
  owner: Address;
  quote: Address;
  tokens: Address[];
  capHuman: string;
  maxSlippageBps: string;
  /// Seconds from now until the name expires and the hook stops accepting the agent.
  ttlSeconds: bigint;
};

/// One DNS label: lowercase letters, digits and inner hyphens, 1 to 63 characters.
export function agentLabelError(label: string): string | null {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    return "lowercase letters, digits and inner hyphens, up to 63 characters";
  }
  return null;
}

/// The two owner transactions of `script/ens/IssueAgent.s.sol`: register the subname on the org registry, then
/// write its policy on the org resolver in one multicall. `now` is the chain time in seconds.
export function issueCalls(
  org: { parentName: string; registry: Address; resolver: Address },
  spec: AgentSpec,
  now: bigint,
) {
  const dnsName = name({ ...org, label: spec.label });
  const expiry = now + spec.ttlSeconds;
  const text = (key: string, value: string) =>
    encodeFunctionData({
      abi: resolverWriteAbi,
      functionName: "setText",
      args: [dnsName, key, value],
    });
  const records = [
    encodeFunctionData({
      abi: resolverWriteAbi,
      functionName: "setAddress",
      args: [dnsName, 60n, spec.agent],
    }),
    text("leash.quote", getAddress(spec.quote)),
    text("leash.dailyNotional", parseUnits(spec.capHuman, 18).toString()),
    text("leash.tokens", spec.tokens.map((t) => getAddress(t)).join(",")),
    text("leash.maxSlippageBps", spec.maxSlippageBps),
  ];
  return {
    expiry,
    register: {
      address: org.registry,
      abi: registryWriteAbi,
      functionName: "register",
      args: [spec.label, spec.owner, zeroAddress, org.resolver, AGENT_TOKEN_ROLES, expiry],
    } as const,
    policy: {
      address: org.resolver,
      abi: resolverWriteAbi,
      functionName: "multicall",
      args: [records],
    } as const,
  };
}

// ============ Funding the vault ============

/// `LeashTestToken.mint`: open to anyone, the demo tokens have no value.
export const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

/// Test tokens minted to the vault per pool token by "Fund vault".
export const FUND_AMOUNT = "10000";

/// One `mint` per pool token, straight to the vault.
export function fundCalls(vault: Address, tokens: Address[], amountHuman = FUND_AMOUNT) {
  const amount = parseUnits(amountHuman, 18);
  return tokens.map(
    (token) =>
      ({
        address: token,
        abi: mintAbi,
        functionName: "mint",
        args: [vault, amount],
      }) as const,
  );
}

/// `trader-<n+1>` after the highest `trader-<n>` in use, `trader-2` when there is none.
export function nextAgentLabel(labels: readonly string[]): string {
  const numbers = labels
    .map((l) => /^trader-(\d+)$/.exec(l)?.[1])
    .filter(Boolean)
    .map(Number);
  return `trader-${Math.max(1, ...numbers) + 1}`;
}
