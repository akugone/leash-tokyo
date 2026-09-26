// The human actions of the demo as plain contract calls, shared by the dev server (keys from .env) and the
// browser (connected wallet). Each builder returns what viem's writeContract / simulateContract take.
import {
  BaseError,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Address,
  type Log,
  type PublicClient,
} from "viem";
import {
  dnsEncode,
  ENS_PERMISSIONED_RESOLVER_IMPL,
  ENS_VERIFIABLE_FACTORY,
  labelId,
} from "./leash";

export const EAC_UNAUTHORIZED = "0x4b27a133"; // EACUnauthorizedAccountRoles(uint256,uint256,address)

export const resolverWriteAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addr)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
]);

export const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);

export const registryWriteAbi = parseAbi([
  "function register(string label, address owner, address subregistry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256 tokenId)",
  "function unregister(uint256 anyId)",
  "function getExpiry(uint256 anyId) view returns (uint64)",
  "function getResolver(string label) view returns (address)",
]);

/// The agent's own resolver, read from the registry when the action runs, so a write never lands on another
/// agent's resolver. Throws once the name is cut or expired: the registry then answers zero.
export async function liveResolver(
  client: Pick<PublicClient, "readContract">,
  registry: Address,
  label: string,
): Promise<Address> {
  const resolver = await client.readContract({
    address: registry,
    abi: registryWriteAbi,
    functionName: "getResolver",
    args: [label],
  });
  if (resolver === zeroAddress)
    throw new Error(`${label} has no resolver: the name is cut or expired.`);
  return resolver;
}

/// Where the agent's name lives: its label under `parentName`, the org registry, and the agent's own resolver.
export type LeashTarget = {
  label: string;
  parentName: string;
  registry: Address;
  resolver: Address;
};

function name(t: Pick<LeashTarget, "label" | "parentName">) {
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

/// `ResolverRoles.ORG_OWNER_ROOT_ROLES`: ROLE_SET_ADDRESS and ROLE_SET_TEXT with their admin bits, on the agent's
/// own resolver, so the owner writes every record and delegates single keys.
export const RESOLVER_OWNER_ROOT_ROLES = (1n << 0n) | (1n << 128n) | (1n << 4n) | (1n << 132n);

/// Keys the risk manager may write, `LeashOrgLib.riskManagerKeys()`.
export const RISK_MANAGER_KEYS = ["leash.dailyNotional", "leash.tokens"] as const;

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

/// `LeashOrgLib.agentResolverSalt`: a re-issued name gets a fresh resolver, the factory refuses a reused salt.
export function agentResolverSalt(label: string, expiry: bigint): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "string" }, { type: "uint64" }],
        ["leash.agent-resolver.v1", label, expiry],
      ),
    ),
  );
}

/// The owner transactions of `script/ens/IssueAgent.s.sol` (and `GrantRiskManager`): deploy the agent's own
/// resolver with its policy written in `initialize`, register the subname pointing to it, then optionally let the
/// risk manager edit its cap and tokens, on that resolver only. `now` is the chain time in seconds.
export function issueCalls(
  org: { parentName: string; registry: Address },
  spec: AgentSpec,
  now: bigint,
) {
  const dnsName = name({ label: spec.label, parentName: org.parentName });
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
  const init = encodeFunctionData({
    abi: resolverWriteAbi,
    functionName: "initialize",
    args: [[{ account: spec.owner, roleBitmap: RESOLVER_OWNER_ROOT_ROLES }], records],
  });
  return {
    expiry,
    deployResolver: {
      address: ENS_VERIFIABLE_FACTORY,
      abi: factoryAbi,
      functionName: "deployProxy",
      args: [ENS_PERMISSIONED_RESOLVER_IMPL, agentResolverSalt(spec.label, expiry), init],
    } as const,
    register: (resolver: Address) =>
      ({
        address: org.registry,
        abi: registryWriteAbi,
        functionName: "register",
        args: [spec.label, spec.owner, zeroAddress, resolver, AGENT_TOKEN_ROLES, expiry],
      }) as const,
  };
}

/// Owner: `ROLE_SET_TEXT` on `leash.dailyNotional` and `leash.tokens` for `riskManager`, on one agent's resolver.
export function grantRiskManagerCall(resolver: Address, riskManager: Address) {
  const setters = RISK_MANAGER_KEYS.map((key) =>
    encodeFunctionData({ abi: resolverWriteAbi, functionName: "setText", args: ["0x", key, ""] }),
  );
  return {
    address: resolver,
    abi: resolverWriteAbi,
    functionName: "multicall",
    args: [
      setters.map((setter) =>
        encodeFunctionData({
          abi: resolverWriteAbi,
          functionName: "grantSetterRoles",
          args: [setter, riskManager],
        }),
      ),
    ],
  } as const;
}

/// The resolver `deployProxy` created, from its receipt's `ProxyDeployed` event.
export function deployedResolver(logs: Log[]): Address {
  const deployed = parseEventLogs({ abi: factoryAbi, eventName: "ProxyDeployed", logs }).find(
    (l) =>
      isAddressEqual(l.address, ENS_VERIFIABLE_FACTORY) &&
      isAddressEqual(l.args.implementation, ENS_PERMISSIONED_RESOLVER_IMPL),
  );
  if (!deployed) throw new Error("No ProxyDeployed event in the resolver deployment.");
  return deployed.args.proxyAddress;
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
