import { describe, expect, test } from "bun:test";
import {
  advanceClock,
  chainNow,
  isWideLogQuery,
  rescanFrom,
  RESCAN_BLOCKS,
  sticky,
  type Field,
} from "./chain";

describe("advanceClock", () => {
  test("keeps the anchor that puts chain time furthest ahead", () => {
    // Block 100 seen at t=0, then an older-looking view: block 105 seen 9 s later lags by 4 s.
    const first = advanceClock(null, { timestamp: 100n }, 0);
    const lagging = advanceClock(first, { timestamp: 105n }, 9_000);
    expect(lagging).toEqual({ timestamp: 100n, at: 0 });
    // Block 112 seen 10 s after the first anchor is fresher: chain time moves ahead to it.
    const fresher = advanceClock(lagging, { timestamp: 112n }, 10_000);
    expect(fresher).toEqual({ timestamp: 112n, at: 10_000 });
  });

  test("a failed block read keeps the previous anchor", () => {
    const clock = { timestamp: 100n, at: 0 };
    expect(advanceClock(clock, null, 5_000)).toBe(clock);
    expect(advanceClock(null, null, 5_000)).toBeNull();
  });

  test("chain now never goes backwards across polls", () => {
    let clock = advanceClock(null, { timestamp: 1_000n }, 0);
    let last = chainNow(clock, 0)!;
    // Poll every 5 s; each block lags real time by 0 to 11 s.
    const lags = [11, 0, 7, 3, 11, 1, 9];
    lags.forEach((lag, i) => {
      const at = (i + 1) * 5_000;
      clock = advanceClock(clock, { timestamp: 1_000n + BigInt(at / 1000 - lag) }, at);
      const now = chainNow(clock, at)!;
      expect(now >= last).toBe(true);
      last = now;
    });
  });
});

describe("sticky", () => {
  const ok: Field<bigint> = { value: 25n, error: null };
  test("keeps the last value through a transient failure", () => {
    expect(sticky(ok, { value: null, error: "HTTP 429", transient: true })).toBe(ok);
  });
  test("shows a revert, and any failure with nothing to keep", () => {
    const revert: Field<bigint> = { value: null, error: "LeashRevoked", transient: false };
    expect(sticky(ok, revert)).toBe(revert);
    const failed: Field<bigint> = { value: null, error: "HTTP 429", transient: true };
    expect(sticky(null, failed)).toBe(failed);
  });
  test("a fresh value always wins", () => {
    const next: Field<bigint> = { value: 30n, error: null };
    expect(sticky(ok, next)).toBe(next);
  });
});

describe("rescanFrom", () => {
  test("reads the last blocks again, so a lagging RPC node cannot hide their events", () => {
    expect(rescanFrom(100n)).toBe(100n - RESCAN_BLOCKS + 1n);
    expect(rescanFrom(100n) <= 100n).toBe(true);
  });
  test("never goes below block zero", () => {
    expect(rescanFrom(3n)).toBe(0n);
  });
});

describe("isWideLogQuery", () => {
  test("up to 10 blocks stays on the main rpc", () => {
    expect(isWideLogQuery([{ fromBlock: "0x1", toBlock: "0xa" }])).toBe(false);
    expect(isWideLogQuery([{ fromBlock: "0x1", toBlock: "0xb" }])).toBe(true);
  });
  test("a block hash is narrow, a tag or a missing bound is wide", () => {
    expect(isWideLogQuery([{ blockHash: "0xabc" }])).toBe(false);
    expect(isWideLogQuery([{ fromBlock: "0x1", toBlock: "latest" }])).toBe(true);
    expect(isWideLogQuery([{ toBlock: "0x5" }])).toBe(true);
  });
  test("the poll tail fits: rescan window plus two new blocks", () => {
    const scannedTo = 1000n;
    const from = rescanFrom(scannedTo);
    const head = scannedTo + 2n;
    expect(
      isWideLogQuery([{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}` }]),
    ).toBe(false);
  });
});
