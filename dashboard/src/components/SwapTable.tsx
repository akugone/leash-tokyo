import type { SwapRow } from "../lib/chain";
import { formatAmount, shortHex } from "../lib/leash";

export function SwapTable({
  swaps,
  error,
  scannedTo,
}: {
  swaps: SwapRow[];
  error: string | null;
  scannedTo: bigint | null;
}) {
  return (
    <section className="swaps">
      <div className="section-head">
        <h2>Swaps</h2>
        <span className="hint">
          {scannedTo !== null ? `scanned to block ${scannedTo.toString()}` : "not scanned yet"}
        </span>
      </div>
      {error && <div className="card-error">logs: {error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>block</th>
              <th>tx</th>
              <th className="right">notional</th>
              <th className="right">spent today</th>
            </tr>
          </thead>
          <tbody>
            {swaps.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty">
                  No swaps yet in the scanned range.
                </td>
              </tr>
            ) : (
              swaps.map((s) => (
                <tr key={`${s.txHash}:${s.logIndex}`}>
                  <td className="num">{s.blockNumber.toString()}</td>
                  <td className="num" title={s.txHash}>
                    {shortHex(s.txHash, 10, 6)}
                  </td>
                  <td className="num right" title={s.notional.toString()}>
                    {formatAmount(s.notional)}
                  </td>
                  <td className="num right" title={s.spentToday.toString()}>
                    {formatAmount(s.spentToday)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
