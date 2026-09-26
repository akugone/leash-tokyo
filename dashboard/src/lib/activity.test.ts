import { describe, expect, test } from "bun:test";
import { encodeErrorResult, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { buildActivity, explainRefusal } from "./activity";
import { childNode, namehash, type Deployments } from "./leash";

const errors = parseAbi([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error DailyCapExceeded(bytes32 node, uint256 attempted, uint256 cap)",
]);

const d: Deployments = {
  chainId: "11155111",
  parentLabel: "leash",
  parentName: "leash.eth",
  parentNode: namehash("leash.eth"),
  orgRegistry: "0xe614c0f0D9Ce98Aaf986Fce5f5Ef46614DF64fE9",
  hook: "0x8c1f16B42C75190316636a956A4C85F8D1c440c0",
  vault: "0x3Ee1b2a02CA8a87572B6d172913Db37bd3C37022",
  quote: "0x3EC79AB413c942159218358dfb6EB83Fa1F59C4E",
  riskManager: "0x1045752bA6d1D88C6B97Ae91A3da6b91F4790E47",
  orgOwner: "0x703c9e946882859A749B704AFde861D47ED4f8c2",
};
const node2 = childNode(d.parentNode, "trader-2");
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const RESOLVER_2 = "0x78281a48fD11C65891db5531c20274a15Ab25016" as Address;
const log = (
  eventName: string,
  args: Record<string, unknown>,
  block: number,
  i = 0,
  hash = tx(block),
  address: Address = d.hook,
) => ({
  eventName,
  args,
  blockNumber: BigInt(block),
  logIndex: i,
  transactionHash: hash,
  address,
});

describe("explainRefusal", () => {
  test("unwraps the PoolManager's WrappedError down to the hook error", () => {
    const inner = encodeErrorResult({
      abi: errors,
      errorName: "DailyCapExceeded",
      args: [node2, 325n * 10n ** 18n, 100n * 10n ** 18n],
    });
    const wrapped = encodeErrorResult({
      abi: errors,
      errorName: "WrappedError",
      args: [d.hook, "0xb47b2fb1", inner, "0xa9e35b2f"],
    });
    expect(explainRefusal(wrapped)).toBe("DailyCapExceeded (would reach 325 lUSD of cap 100 lUSD)");
  });
  test("an unknown error keeps its selector", () => {
    expect(explainRefusal("0xdeadbeef")).toBe("revert 0xdeadbeef");
  });
});

describe("buildActivity", () => {
  // trader-2's own resolver: records numbered from 1 in it, like in any other agent's resolver.
  const r2 = (eventName: string, args: Record<string, unknown>, block: number, i = 0) =>
    log(eventName, args, block, i, tx(block), RESOLVER_2);
  const logs = [
    log("ResolverUpdated", { tokenId: 7n, resolver: RESOLVER_2 }, 10, 0),
    log("LabelRegistered", { tokenId: 7n, label: "trader-2", expiry: 1_800_000_000n }, 10, 1),
    r2("Linked", { recordId: 1n, node: node2 }, 11),
    r2(
      "TextUpdated",
      { recordId: 1n, key: "leash.dailyNotional", value: "100000000000000000000" },
      11,
      1,
    ),
    r2("TextUpdated", { recordId: 1n, key: "leash.maxSlippageBps", value: "50" }, 11, 2),
    // Another agent's resolver also numbers its first record 1: it must not be read as trader-2.
    log(
      "Linked",
      { recordId: 1n, node: childNode(d.parentNode, "trader-1") },
      11,
      3,
      tx(11),
      d.vault!,
    ),
    r2(
      "TextUpdated",
      { recordId: 1n, key: "leash.dailyNotional", value: "10000000000000000000" },
      12,
      0,
    ),
    log("LeashSwap", { node: node2, notional: 5n * 10n ** 18n, spentToday: 5n * 10n ** 18n }, 13),
    log("TransferSingle", { to: zeroAddress, id: 7n }, 14),
  ];
  const senders = new Map<Hex, Address>([
    [tx(11), d.orgOwner!],
    [tx(12), d.riskManager!],
  ]);
  const items = buildActivity(logs, d, senders);

  test("newest first, one line per resolver transaction, attributed to its role and agent", () => {
    expect(items.map((i) => i.kind)).toEqual(["cut", "swap", "policy", "policy", "issued"]);
    expect(items[4].text).toBe(
      "trader-2.leash.eth issued with its own resolver 0x7828…5016, mandate until 2027-01-15 08:00 UTC",
    );
    expect(items[2].text).toBe("risk manager set cap 10 lUSD on trader-2.leash.eth");
    expect(items[3].text).toBe("owner set cap 100 lUSD, max slippage 50 bps on trader-2.leash.eth");
    expect(items.every((i) => i.node === node2)).toBe(true);
  });

  test("a name issued on the resolver agents used to share says so", () => {
    const legacy = buildActivity(logs, { ...d, orgResolverPrevious: RESOLVER_2 }, senders);
    expect(legacy[4].text).toBe(
      "trader-2.leash.eth issued on the org's shared resolver 0x7828…5016, mandate until 2027-01-15 08:00 UTC",
    );
  });

  test("a name moved to a new resolver reads as such", () => {
    const moved = buildActivity(
      [...logs, log("ResolverUpdated", { tokenId: 7n << 0n, resolver: d.hook }, 15)],
      d,
      senders,
    );
    expect(moved[0].kind).toBe("resolver");
    expect(moved[0].text).toBe(
      "trader-2.leash.eth moved to its own resolver 0x8c1f…40c0: its records, its roles",
    );
  });

  test("a burned name token reads as a cut", () => {
    expect(items[0].text).toBe("trader-2.leash.eth cut: the hook refuses every swap from now on");
  });
});
