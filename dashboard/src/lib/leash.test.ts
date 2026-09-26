import { describe, expect, test } from "bun:test";
import { namehash as viemNamehash } from "viem";
import { packetToBytes } from "viem/ens";
import { toHex, type Hex } from "viem";
import {
  blockRanges,
  childNode,
  computeStatus,
  configToSearch,
  decodeText,
  dnsEncode,
  formatAmount,
  formatCountdown,
  labelId,
  namehash,
  parseConfig,
  parseDeployments,
  parseSlippageRecord,
  parseTokenList,
  slippageInputError,
  remaining,
  spentFraction,
  textCalldata,
} from "./leash";

describe("namehash", () => {
  test("eth", () => {
    expect(namehash("eth")).toBe(
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
    );
  });
  test("foo.eth", () => {
    expect(namehash("foo.eth")).toBe(
      "0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f",
    );
  });
  test("empty name is the zero node", () => {
    expect(namehash("")).toBe(`0x${"00".repeat(32)}`);
  });
  test("matches viem for a three label name", () => {
    expect(namehash("trader-1.acme.eth")).toBe(viemNamehash("trader-1.acme.eth"));
  });
  test("childNode composes with namehash", () => {
    expect(childNode(namehash("acme.eth"), "trader-1")).toBe(namehash("trader-1.acme.eth"));
  });
});

describe("dnsEncode", () => {
  test("trader-1.acme.eth", () => {
    const expected: Hex = `0x08${"7472616465722d31"}04${"61636d65"}03${"657468"}00`;
    expect(dnsEncode("trader-1.acme.eth")).toBe(expected);
  });
  test("matches viem packetToBytes including the trailing zero byte", () => {
    const viemBytes = toHex(packetToBytes("trader-1.acme.eth"));
    expect(viemBytes.endsWith("00")).toBe(true);
    expect(dnsEncode("trader-1.acme.eth")).toBe(viemBytes);
  });
});

describe("labelId", () => {
  test("is uint256(keccak256(label))", () => {
    // keccak256("eth"), the well known labelhash of the eth TLD.
    expect(labelId("eth")).toBe(
      BigInt("0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0"),
    );
  });
});

describe("resolver calldata", () => {
  test("text selector and round trip", () => {
    const data = textCalldata("leash.quote");
    expect(data.startsWith("0x59d1d43c")).toBe(true);
    expect(decodeText(`0x${"0".repeat(62)}20${"0".repeat(63)}3${"616263"}${"0".repeat(58)}`)).toBe(
      "abc",
    );
  });
  test("parseTokenList ignores junk", () => {
    expect(
      parseTokenList(
        " 0x0000000000000000000000000000000000000001, nope,0x0000000000000000000000000000000000000002 ",
      ),
    ).toEqual([
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    ]);
  });
});

describe("config", () => {
  test("defaults", () => {
    expect(parseConfig("")).toEqual({
      rpc: "http://127.0.0.1:8545",
      deployments: "/deployments.json",
      label: "trader-1",
    });
  });
  test("overrides and round trip", () => {
    const cfg = parseConfig("?rpc=https%3A%2F%2Frpc.example&label=trader-2");
    expect(cfg.rpc).toBe("https://rpc.example");
    expect(cfg.label).toBe("trader-2");
    expect(parseConfig(configToSearch(cfg))).toEqual(cfg);
    expect(configToSearch(parseConfig(""))).toBe("");
  });
  test("parseDeployments requires the core keys", () => {
    expect(() => parseDeployments({ chainId: "1" })).toThrow('missing "parentName"');
    const d = parseDeployments({
      chainId: "11155111",
      parentName: "leashdemo.eth",
      orgRegistry: "0x0000000000000000000000000000000000000001",
      hook: "0x0000000000000000000000000000000000000002",
    });
    expect(d.parentNode).toBe(namehash("leashdemo.eth"));
    const zero = parseDeployments({ ...d, parentNode: `0x${"00".repeat(32)}` });
    expect(zero.parentNode).toBe(namehash("leashdemo.eth"));
  });
});

describe("status", () => {
  const now = 1_000_000n;
  test("live", () => {
    expect(computeStatus({ expiry: now + 3600n, now, revokedByHook: false })).toBe("live");
  });
  test("expiring under ten minutes", () => {
    expect(computeStatus({ expiry: now + 599n, now, revokedByHook: false })).toBe("expiring");
    expect(computeStatus({ expiry: now + 600n, now, revokedByHook: false })).toBe("live");
  });
  test("revoked when expiry <= now or the hook says so", () => {
    expect(computeStatus({ expiry: now, now, revokedByHook: false })).toBe("revoked");
    expect(computeStatus({ expiry: now + 3600n, now, revokedByHook: true })).toBe("revoked");
  });
  test("unknown without expiry", () => {
    expect(computeStatus({ expiry: null, now, revokedByHook: false })).toBe("unknown");
  });
  test("remaining and fraction", () => {
    expect(remaining(100n, 30n)).toBe(70n);
    expect(remaining(100n, 130n)).toBe(0n);
    expect(spentFraction(100n, 25n)).toBe(0.25);
    expect(spentFraction(100n, 250n)).toBe(1);
    expect(spentFraction(0n, 5n)).toBe(0);
  });
});

describe("formatting", () => {
  test("formatAmount groups and trims", () => {
    expect(formatAmount(1_234_567n * 10n ** 18n)).toBe("1,234,567");
    expect(formatAmount(1_500_000_000_000_000_000n)).toBe("1.5");
    expect(formatAmount(123_456_789_012_345_678n)).toBe("0.1234");
    expect(formatAmount(0n)).toBe("0");
    expect(formatAmount(25_000_000n)).toBe("<0.0001");
    expect(formatAmount(100_000_000_000_000n)).toBe("0.0001");
  });
  test("formatCountdown", () => {
    expect(formatCountdown(0n)).toBe("expired");
    expect(formatCountdown(59n)).toBe("00:00:59");
    expect(formatCountdown(90_061n)).toBe("1d 01:01:01");
  });
});

describe("blockRanges", () => {
  test("chunks inclusively", () => {
    expect(blockRanges(0n, 9n, 4n)).toEqual([
      { from: 0n, to: 3n },
      { from: 4n, to: 7n },
      { from: 8n, to: 9n },
    ]);
    expect(blockRanges(5n, 5n, 1000n)).toEqual([{ from: 5n, to: 5n }]);
    expect(blockRanges(6n, 5n, 1000n)).toEqual([]);
  });
});

describe("parseSlippageRecord", () => {
  test("empty means not enforced", () => {
    expect(parseSlippageRecord("")).toEqual({ bps: null, error: null });
  });
  test("base 10 below 10000", () => {
    expect(parseSlippageRecord("100")).toEqual({ bps: 100n, error: null });
    expect(parseSlippageRecord("0")).toEqual({ bps: 0n, error: null });
    expect(parseSlippageRecord("9999")).toEqual({ bps: 9999n, error: null });
  });
  test("anything the hook rejects is an error, never 'not bounded'", () => {
    expect(parseSlippageRecord("1%").error).toContain("malformed");
    expect(parseSlippageRecord(" 100").error).toContain("malformed");
    expect(parseSlippageRecord("10000").error).toContain("out of range");
    expect(parseSlippageRecord("10000").bps).toBeNull();
  });
});

describe("slippageInputError", () => {
  test("1 to 9999 basis points", () => {
    expect(slippageInputError("50")).toBeNull();
    expect(slippageInputError("1")).toBeNull();
    expect(slippageInputError("9999")).toBeNull();
    expect(slippageInputError(" 25 ")).toBeNull();
  });
  test("refuses what would switch the bound off, freeze swaps or revert", () => {
    expect(slippageInputError("")).not.toBeNull();
    expect(slippageInputError("0")).toContain("block every swap");
    expect(slippageInputError("10000")).not.toBeNull();
    expect(slippageInputError("0.5")).not.toBeNull();
    expect(slippageInputError("1%")).not.toBeNull();
  });
});
