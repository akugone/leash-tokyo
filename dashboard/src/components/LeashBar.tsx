import {
  formatAmount,
  formatCountdown,
  formatUtc,
  remaining,
  spentFraction,
  type LeashStatus,
} from "../lib/leash";

type Props = {
  cap: bigint | null;
  spent: bigint | null;
  left: bigint | null;
  expiry: bigint | null;
  now: bigint | null;
  status: LeashStatus;
  symbol: string;
};

/// The hero: the leash itself, a line from the post (0) to the cap with the collar at today's spend,
/// framed by the numbers that matter and the time left on the mandate.
export function LeashBar({ cap, spent, left, expiry, now, status, symbol }: Props) {
  const frac = spentFraction(cap, spent);
  const pct = Math.round(frac * 100);
  const cut = status === "revoked";
  const remainingToday = cut ? 0n : (left ?? remaining(cap, spent));

  return (
    <section className={`leash ${cut ? "cut" : ""} tone-${status}`} aria-label="leash">
      <div className="leash-top">
        <div className="leash-figure">
          {spent !== null && cap !== null ? (
            <>
              <span className="leash-spent-num num">{formatAmount(spent)}</span>
              <span className="leash-of">
                / {formatAmount(cap)} {symbol} spent today
              </span>
            </>
          ) : (
            <span className="leash-spent-num pending">…</span>
          )}
        </div>
        <div className="leash-expiry">
          {expiry !== null && now !== null ? (
            cut ? (
              <>
                <span className="leash-expiry-num">cut</span>
                <span className="leash-expiry-hint">{formatUtc(expiry)}</span>
              </>
            ) : (
              <>
                <span className="leash-expiry-num num">{formatCountdown(expiry - now)}</span>
                <span className="leash-expiry-hint">
                  {expiry === 0n ? "never registered" : `mandate ends ${formatUtc(expiry)}`}
                </span>
              </>
            )
          ) : (
            <span className="pending">…</span>
          )}
        </div>
      </div>

      <div className="leash-row">
        <span className="post" title="0" />
        <div className="leash-track">
          <div className="leash-spent" style={{ width: `${pct}%` }} />
          <span
            className="collar"
            style={{ left: `${pct}%` }}
            title={spent !== null ? spent.toString() : ""}
          />
        </div>
        <span className="cap-mark num" title={cap !== null ? cap.toString() : ""}>
          {cap !== null ? formatAmount(cap) : "?"}
        </span>
      </div>

      <div className="leash-caption">
        {cut ? (
          <span className="danger">Leash cut. The hook reverts every swap with LeashRevoked.</span>
        ) : (
          <>
            <span>
              <b>{pct}%</b> of the daily cap
            </span>
            <span>
              <b className="num">
                {remainingToday !== null ? formatAmount(remainingToday) : "?"} {symbol}
              </b>{" "}
              left today
            </span>
          </>
        )}
      </div>
    </section>
  );
}
