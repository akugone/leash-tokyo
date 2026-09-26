import { useEffect, useState } from "react";
import { shortHex } from "../lib/leash";

type Status = { enabled: boolean; riskManager: string | null; owner: string | null; name: string };

type Outcome = { tone: "ok" | "bad" | "info"; text: string } | null;

/// The two human roles of the story, acting through the dev server which holds their keys (demo only).
export function Controls({ onChanged, revoked }: { onChanged: () => void; revoked: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [cap, setCap] = useState("10");
  const [busy, setBusy] = useState<string | null>(null);
  const [riskOut, setRiskOut] = useState<Outcome>(null);
  const [ownerOut, setOwnerOut] = useState<Outcome>(null);

  useEffect(() => {
    fetch("/api/demo/status", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  if (!status?.enabled) return null;

  const call = async (
    key: string,
    path: string,
    body: Record<string, unknown>,
    set: (o: Outcome) => void,
    render: (r: Record<string, unknown>) => Outcome,
  ) => {
    setBusy(key);
    set({ tone: "info", text: "Sending…" });
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
      set(render(data));
      onChanged();
    } catch (err) {
      set({ tone: "bad", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="controls" aria-label="controls">
      <div className="role">
        <div className="role-head">
          <h2 className="role-name">Risk manager</h2>
          {status.riskManager && (
            <span className="addr hint" title={status.riskManager}>
              {shortHex(status.riskManager)}
            </span>
          )}
        </div>
        <p className="role-hint">
          Can edit three records of the agent's name, <code>leash.dailyNotional</code>,{" "}
          <code>leash.tokens</code> and <code>leash.maxSlippageBps</code>. Nothing else.
        </p>
        <div className="role-row">
          <label className="field">
            <span>daily cap</span>
            <input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              inputMode="decimal"
              size={8}
              disabled={busy !== null || revoked}
            />
            <span className="unit">lUSD</span>
          </label>
          <button
            className="btn"
            disabled={busy !== null || revoked || !/^\d+(\.\d+)?$/.test(cap)}
            onClick={() =>
              call("tighten", "/api/demo/tighten", { cap }, setRiskOut, (r) => ({
                tone: r.status === "success" ? "ok" : "bad",
                text: `Cap set to ${cap} lUSD. Tx ${shortHex(String(r.txHash), 10, 6)}`,
              }))
            }
          >
            {busy === "tighten" ? "Sending…" : "Tighten the leash"}
          </button>
          <button
            className="ghost"
            disabled={busy !== null}
            title="Try unregister, setAddress and setText(leash.quote) as the risk manager. All three must revert."
            onClick={() =>
              call("forbid", "/api/demo/forbid", {}, setRiskOut, (r) => {
                const results = r.results as { ok: boolean; text: string }[];
                return {
                  tone: results.every((x) => x.ok) ? "ok" : "bad",
                  text: results.map((x) => x.text).join(" · "),
                };
              })
            }
          >
            {busy === "forbid" ? "Trying…" : "Try to revoke"}
          </button>
        </div>
        {riskOut && <div className={`outcome ${riskOut.tone}`}>{riskOut.text}</div>}
      </div>

      <div className="role owner">
        <div className="role-head">
          <h2 className="role-name">Owner</h2>
          {status.owner && (
            <span className="addr hint" title={status.owner}>
              {shortHex(status.owner)}
            </span>
          )}
        </div>
        <p className="role-hint">
          Owns the parent name and the org registry. Revoking is one transaction, no key rotation.
        </p>
        <div className="role-row">
          <button
            className="btn danger"
            disabled={busy !== null || revoked}
            onClick={() =>
              call("cut", "/api/demo/cut", {}, setOwnerOut, (r) => ({
                tone: r.status === "success" ? "ok" : "bad",
                text: `${status.name} cut. Tx ${shortHex(String(r.txHash), 10, 6)}, expiry ${String(r.expiry)}`,
              }))
            }
          >
            {busy === "cut" ? "Cutting…" : revoked ? "Leash cut" : "Cut the leash"}
          </button>
        </div>
        {ownerOut && <div className={`outcome ${ownerOut.tone}`}>{ownerOut.text}</div>}
      </div>
    </section>
  );
}
