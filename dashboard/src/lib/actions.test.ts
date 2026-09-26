import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Address,
  type Hex,
  type Log,
} from "viem";
import {
  AGENT_TOKEN_ROLES,
  agentLabelError,
  agentResolverSalt,
  deployedResolver,
  factoryAbi,
  grantRiskManagerCall,
  issueCalls,
  RESOLVER_OWNER_ROOT_ROLES,
  resolverWriteAbi,
} from "./actions";
import { dnsEncode, ENS_PERMISSIONED_RESOLVER_IMPL, ENS_VERIFIABLE_FACTORY } from "./leash";

const org = {
  parentName: "leash.eth",
  registry: "0xe614c0f0D9Ce98Aaf986Fce5f5Ef46614DF64fE9" as Address,
};
const resolver = "0x78281a48fD11C65891db5531c20274a15Ab25016" as Address;
const riskManager = "0x1045752bA6d1D88C6B97Ae91A3da6b91F4790E47" as Address;
const spec = {
  label: "trader-2",
  agent: "0xa162dbffd5c4171fb7058feaa7a28f5c63c44a0d" as Address,
  owner: "0x703c9e946882859A749B704AFde861D47ED4f8c2" as Address,
  quote: "0x3ec79ab413c942159218358dfb6eb83fa1f59c4e" as Address,
  tokens: [
    "0x3ec79ab413c942159218358dfb6eb83fa1f59c4e",
    "0x9e63305f38825e126bbd7a9582a53bd516431c02",
  ] as Address[],
  capHuman: "100",
  maxSlippageBps: "50",
  ttlSeconds: 3600n,
};

describe("issueCalls", () => {
  test("deploys the agent's own resolver through the ENS factory, salted by label and expiry", () => {
    const { deployResolver, expiry } = issueCalls(org, spec, 1_000n);
    expect(expiry).toBe(4_600n);
    expect(deployResolver.address).toBe(ENS_VERIFIABLE_FACTORY);
    expect(deployResolver.args[0]).toBe(ENS_PERMISSIONED_RESOLVER_IMPL);
    expect(deployResolver.args[1]).toBe(agentResolverSalt("trader-2", 4_600n));
    // Same salt as LeashOrgLib.agentResolverSalt: keccak256(abi.encode("leash.agent-resolver.v1", label, expiry)).
    expect(agentResolverSalt("trader-2", 4_600n)).toBe(
      BigInt(
        keccak256(
          encodeAbiParameters(
            [{ type: "string" }, { type: "string" }, { type: "uint64" }],
            ["leash.agent-resolver.v1", "trader-2", 4_600n],
          ),
        ),
      ),
    );
  });

  test("registers the label pointing to that resolver, with the owner roles and expiry", () => {
    const register = issueCalls(org, spec, 1_000n).register(resolver);
    expect(register.address).toBe(org.registry);
    expect(register.args).toEqual([
      "trader-2",
      spec.owner,
      "0x0000000000000000000000000000000000000000",
      resolver,
      AGENT_TOKEN_ROLES,
      4_600n,
    ]);
    expect(AGENT_TOKEN_ROLES).toBe((1n << 12n) | (1n << 16n) | (1n << 24n));
  });

  test("initialize gives the owner the root roles and writes the whole policy, as the hook parses it", () => {
    const init = issueCalls(org, spec, 1_000n).deployResolver.args[2];
    const { functionName, args } = decodeFunctionData({ abi: resolverWriteAbi, data: init });
    expect(functionName).toBe("initialize");
    const [grants, records] = args as unknown as [
      { account: Address; roleBitmap: bigint }[],
      Hex[],
    ];
    expect(grants).toEqual([{ account: spec.owner, roleBitmap: RESOLVER_OWNER_ROOT_ROLES }]);
    const decoded = records.map((data) => decodeFunctionData({ abi: resolverWriteAbi, data }));
    const name = dnsEncode("trader-2.leash.eth");
    expect(decoded.map((d) => d.functionName)).toEqual([
      "setAddress",
      "setText",
      "setText",
      "setText",
      "setText",
    ]);
    expect(decoded[0].args).toEqual([name, 60n, spec.agent]);
    expect(decoded[1].args).toEqual([
      name,
      "leash.quote",
      "0x3EC79AB413c942159218358dfb6EB83Fa1F59C4E",
    ]);
    expect(decoded[2].args).toEqual([name, "leash.dailyNotional", "100000000000000000000"]);
    expect(decoded[3].args).toEqual([
      name,
      "leash.tokens",
      "0x3EC79AB413c942159218358dfb6EB83Fa1F59C4E,0x9E63305f38825e126BBD7A9582a53bd516431C02",
    ]);
    expect(decoded[4].args).toEqual([name, "leash.maxSlippageBps", "50"]);
  });
});

describe("grantRiskManagerCall", () => {
  test("grants the two risk keys on that one resolver, in one multicall", () => {
    const call = grantRiskManagerCall(resolver, riskManager);
    expect(call.address).toBe(resolver);
    const grants = call.args[0].map((data) => decodeFunctionData({ abi: resolverWriteAbi, data }));
    expect(grants.map((g) => g.functionName)).toEqual(["grantSetterRoles", "grantSetterRoles"]);
    const keys = grants.map((g) => {
      const setter = decodeFunctionData({ abi: resolverWriteAbi, data: g.args![0] as Hex });
      expect(g.args![1]).toBe(riskManager);
      return setter.args![1];
    });
    expect(keys).toEqual(["leash.dailyNotional", "leash.tokens"]);
  });
});

describe("deployedResolver", () => {
  const proxyLog = (implementation: Address, proxy: Address): Log =>
    ({
      address: ENS_VERIFIABLE_FACTORY,
      topics: encodeEventTopics({
        abi: factoryAbi,
        eventName: "ProxyDeployed",
        args: { sender: spec.owner, proxyAddress: proxy },
      }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [1n, implementation]),
    }) as unknown as Log;

  test("reads the new resolver from the factory's ProxyDeployed event", () => {
    expect(deployedResolver([proxyLog(ENS_PERMISSIONED_RESOLVER_IMPL, resolver)])).toBe(resolver);
  });
  test("ignores a proxy of another implementation", () => {
    expect(() => deployedResolver([proxyLog(org.registry, resolver)])).toThrow();
  });
});

describe("agentLabelError", () => {
  test("accepts one lowercase DNS label", () => {
    for (const label of ["trader-2", "a", "desk-7-eu"]) expect(agentLabelError(label)).toBeNull();
  });
  test("refuses dots, capitals, edge hyphens and empty labels", () => {
    for (const label of ["", "Trader", "a.b", "-x", "x-", "a".repeat(64)]) {
      expect(agentLabelError(label)).not.toBeNull();
    }
  });
});
