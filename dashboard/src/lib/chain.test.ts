import { describe, expect, test } from "bun:test";
import { advanceClock, chainNow, sticky, type Field } from "./chain";

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
