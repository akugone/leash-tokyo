import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeErrorResult, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LEASH_HOOK_ABI, WRAPPED_ERROR_ABI } from "./abi.ts";
import { FORCE_DEFAULT_AMOUNT, chooseAmount, chooseSlippage, parseCliArgs, slippageText } from "./bot.ts";
import { decodeRevertData, explainRevert } from "./errors.ts";
import { bpsText } from "./leash.ts";
import {
  dnsEncode,
  domainSeparator,
  encodeHookData,
  hashIntent,
  intentDigest,
  labelhash,
  leashDomain,
  namehash,
  signIntent,
  type SwapIntent,
} from "./intent.ts";

type Fixture = {
  name: string;
  label: string;
  signer: Address;
  chainId: string;
  verifyingContract: Address;
  domainSeparator: Hex;
  structHash: Hex;
  digest: Hex;
  signature: Hex;
  intent: { node: Hex; poolId: Hex; zeroForOne: boolean; amountSpecified: string; nonce: string; deadline: string };
  hookData: Hex;
};

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../test/fixtures/intent.json"), "utf8"),
) as Fixture;

const intent: SwapIntent = {
  node: fixture.intent.node,
  poolId: fixture.intent.poolId,
  zeroForOne: fixture.intent.zeroForOne,
  amountSpecified: BigInt(fixture.intent.amountSpecified),
  nonce: BigInt(fixture.intent.nonce),
  deadline: BigInt(fixture.intent.deadline),
};
const domain = leashDomain(Number(fixture.chainId), fixture.verifyingContract);
const ctx = { label: "trader-1", parentName: "leashdemo.eth" };

describe("intent", () => {
  test("namehash and dnsEncode match ENS wire formats", () => {
    expect(namehash("trader-1.leashdemo.eth")).toBe(fixture.intent.node);
    expect(dnsEncode("trader-1.leashdemo.eth")).toBe("0x087472616465722d31096c6561736864656d6f0365746800");
    expect(labelhash("trader-1")).toBe(keccak256(toHex("trader-1")));
  });

  test("hashes match the fixture", () => {
    expect(domainSeparator(domain)).toBe(fixture.domainSeparator);
    expect(hashIntent(intent)).toBe(fixture.structHash);
    expect(intentDigest(domain, intent)).toBe(fixture.digest);
  });

  test("signature is deterministic for anvil #0", async () => {
    const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    expect(account.address).toBe(fixture.signer);
    expect(await signIntent(account, domain, intent)).toBe(fixture.signature);
  });

  test("encodeHookData matches abi.encode(string, SwapIntent, bytes)", () => {
    const hookData = encodeHookData(fixture.label, intent, fixture.signature);
    expect(hookData).toBe(fixture.hookData);
    // head: offset(label) = 0x100 (8 words), 6 inline struct words, offset(signature) = 0x140.
    const words = hookData.slice(2).match(/.{64}/g)!;
    expect(BigInt(`0x${words[0]}`)).toBe(0x100n);
    expect(`0x${words[1]}`).toBe(intent.node);
    expect(BigInt(`0x${words[7]}`)).toBe(0x140n);
  });
});

describe("errors", () => {
  const hook: Address = "0x1000000000000000000000000000000000000001";
  const beforeSwapSelector = "0x575e24b4" as const;
  const hookCallFailed = "0xa9e35b2f" as const;

  function wrap(reason: Hex, target: Address = hook): Hex {
    return encodeErrorResult({
      abi: WRAPPED_ERROR_ABI,
      errorName: "WrappedError",
      args: [target, beforeSwapSelector, reason, hookCallFailed],
    });
  }

  test("unwraps WrappedError and decodes DailyCapExceeded", () => {
    const reason = encodeErrorResult({
      abi: LEASH_HOOK_ABI,
      errorName: "DailyCapExceeded",
      args: [intent.node, 1500n, 1000n],
    });
    const decoded = decodeRevertData(wrap(reason));
    expect(decoded.name).toBe("DailyCapExceeded");
    expect(decoded.target).toBe(hook);
    expect(decoded.args).toEqual([intent.node, 1500n, 1000n]);
    expect(explainRevert(decoded, ctx)).toBe(
      "DailyCapExceeded: trader-1.leashdemo.eth would reach 1500 of cap 1000 today",
    );
  });

  test("decodes SlippageTooLoose", () => {
    const reason = encodeErrorResult({ abi: LEASH_HOOK_ABI, errorName: "SlippageTooLoose", args: [4295128740n, 7n] });
    const decoded = decodeRevertData(wrap(reason));
    expect(decoded.name).toBe("SlippageTooLoose");
    expect(explainRevert(decoded, ctx)).toBe(
      "SlippageTooLoose: price limit 4295128740 is wider than leash.maxSlippageBps allows (bound 7)",
    );
  });

  test("unwraps two nested WrappedError levels", () => {
    const reason = encodeErrorResult({
      abi: LEASH_HOOK_ABI,
      errorName: "LeashRevoked",
      args: [intent.node, 1_800_000_000n],
    });
    const decoded = decodeRevertData(wrap(wrap(reason), "0x2000000000000000000000000000000000000002"));
    expect(decoded.name).toBe("LeashRevoked");
    expect(decoded.target).toBe(hook);
    expect(explainRevert(decoded, ctx)).toContain("LeashRevoked: trader-1.leashdemo.eth was cut at 1800000000");
  });

  test("decodes an unwrapped hook error", () => {
    const decoded = decodeRevertData(encodeErrorResult({ abi: LEASH_HOOK_ABI, errorName: "IntentMismatch", args: [] }));
    expect(decoded.name).toBe("IntentMismatch");
    expect(decoded.target).toBeUndefined();
  });

  test("decodes Error(string) and unknown selectors", () => {
    const errorString = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "m", type: "string" }] }],
      errorName: "Error",
      args: ["nope"],
    });
    expect(explainRevert(decodeRevertData(wrap(errorString)), ctx)).toBe("Error: nope");
    const unknown = decodeRevertData("0xdeadbeef00000000000000000000000000000000000000000000000000000000000000ff");
    expect(unknown.name).toBe("Unknown");
    expect(explainRevert(unknown, ctx)).toBe("Unknown: 0xdeadbeef");
  });

  test("empty reason inside WrappedError", () => {
    const decoded = decodeRevertData(wrap("0x"));
    expect(decoded.name).toBe("EmptyRevert");
    expect(decoded.target).toBe(hook);
  });
});

describe("bot", () => {
  test("chooseAmount honest mode", () => {
    expect(chooseAmount(1000n, 1000n, { misbehave: false })).toBe(100n);
    expect(chooseAmount(1000n, 50n, { misbehave: false })).toBe(50n);
    expect(chooseAmount(1000n, 1000n, { misbehave: false, amount: 250n })).toBe(250n);
    expect(chooseAmount(1000n, 0n, { misbehave: false })).toBe(0n);
  });

  test("chooseAmount misbehave mode always exceeds what is left", () => {
    expect(chooseAmount(1000n, 400n, { misbehave: true })).toBe(401n);
    expect(chooseAmount(1000n, 0n, { misbehave: true })).toBe(1001n);
  });

  test("chooseAmount force mode ignores cap and remaining", () => {
    expect(chooseAmount(1000n, 0n, { misbehave: false, force: true })).toBe(FORCE_DEFAULT_AMOUNT);
    expect(chooseAmount(0n, 0n, { misbehave: false, force: true, amount: 7n })).toBe(7n);
    // force wins over misbehave and over the honest clamp
    expect(chooseAmount(1000n, 400n, { misbehave: true, force: true, amount: 7n })).toBe(7n);
    expect(chooseAmount(1000n, 400n, { misbehave: false, force: false, amount: 5000n })).toBe(400n);
  });

  test("parseCliArgs", () => {
    const opts = parseCliArgs(["--once", "--misbehave", "--amount", "123", "--label", "trader-2", "--interval", "5"]);
    expect(opts).toEqual({ once: true, misbehave: true, force: false, amount: 123n, label: "trader-2", interval: 5 });
    expect(parseCliArgs([])).toEqual({
      once: false,
      misbehave: false,
      force: false,
      amount: undefined,
      label: undefined,
      interval: 15,
    });
    expect(parseCliArgs(["--force"]).force).toBe(true);
    expect(parseCliArgs(["--slippage-bps", "50"]).slippageBps).toBe(50n);
    expect(parseCliArgs([]).slippageBps).toBeUndefined();
  });

  test("chooseSlippage: request, else policy, never clamped", () => {
    expect(chooseSlippage(undefined, 100n)).toBe(100n);
    expect(chooseSlippage(30n, 100n)).toBe(30n);
    // wider than the policy goes out as is: the hook answers SlippageTooLoose
    expect(chooseSlippage(500n, 100n)).toBe(500n);
    expect(chooseSlippage(undefined, null)).toBeNull();
    expect(chooseSlippage(0n, null)).toBe(0n);
  });

  test("slippage texts", () => {
    expect(slippageText(50n, 100n)).toBe("slippage 50 bps (policy max 100)");
    expect(slippageText(null, null)).toBe("slippage unbounded (no policy)");
    expect(bpsText(100n)).toBe("100 bps (1%)");
    expect(bpsText(25n)).toBe("25 bps (0.25%)");
    expect(bpsText(null)).toBe("none");
  });
});
