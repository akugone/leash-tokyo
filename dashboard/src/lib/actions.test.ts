import { describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address } from "viem";
import { AGENT_TOKEN_ROLES, agentLabelError, issueCalls, resolverWriteAbi } from "./actions";
import { dnsEncode } from "./leash";

const org = {
  parentName: "leash.eth",
  registry: "0xe614c0f0D9Ce98Aaf986Fce5f5Ef46614DF64fE9" as Address,
  resolver: "0x5112C1F6bF910DC0B127BE2B109Dc484168c668F" as Address,
};
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
  test("registers the label under the org resolver with the owner roles and expiry", () => {
    const calls = issueCalls(org, spec, 1_000n);
    expect(calls.expiry).toBe(4_600n);
    expect(calls.register.address).toBe(org.registry);
    expect(calls.register.args).toEqual([
      "trader-2",
      spec.owner,
      "0x0000000000000000000000000000000000000000",
      org.resolver,
      AGENT_TOKEN_ROLES,
      4_600n,
    ]);
    expect(AGENT_TOKEN_ROLES).toBe((1n << 12n) | (1n << 16n) | (1n << 24n));
  });

  test("writes the whole policy in one multicall, in the format the hook parses", () => {
    const [records] = issueCalls(org, spec, 1_000n).policy.args;
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
