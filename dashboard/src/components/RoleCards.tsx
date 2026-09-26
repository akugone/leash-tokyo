import { useState } from "react";
import { shortHex, slippageInputError } from "../lib/leash";
import { errorText, useSigner, type Outcome } from "./signer";

type Props = {
  revoked: boolean;
  onChanged: () => void;
  /// Revoked name: open the New agent page prefilled with this name and its last policy.
  onReissue: () => void;
};

/// The two human roles of the story on the selected agent: the risk manager tightens, the owner narrows the
/// slippage, cuts the leash, or issues the name again once cut.
export function RoleCards({ revoked, onChanged, onReissue }: Props) {
  const signer = useSigner();
  const [cap, setCap] = useState("10");
  const [slippage, setSlippage] = useState("50");
  const [busy, setBusy] = useState<string | null>(null);
  const [riskOut, setRiskOut] = useState<Outcome>(null);
  const [ownerOut, setOwnerOut] = useState<Outcome>(null);

  if (!signer) return null;
  const { actions, riskGate, ownerGate, riskManager, owner, walletBar, txUrl } = signer;

  const run = async (key: string, set: (o: Outcome) => void, action: () => Promise<Outcome>) => {
    setBusy(key);
    set({ tone: "info", text: "Sending…" });
    try {
      set(await action());
      onChanged();
    } catch (err) {
      set({ tone: "bad", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const riskOff = busy !== null || revoked || !riskGate.canSign;
  const ownerOff = busy !== null || revoked || !ownerGate.canSign;

  return (
    <section className="controls" aria-label="controls">
      {walletBar}
      <div className="role">
        <div className="role-head">
          <h2 className="role-name">Risk manager</h2>
          {riskManager && (
            <span className="addr hint" title={riskManager}>
              {shortHex(riskManager)}
            </span>
          )}
        </div>
        <p className="role-hint">
          Can edit two records of the agent's name, <code>leash.dailyNotional</code> and{" "}
          <code>leash.tokens</code>. Nothing else, not even <code>leash.maxSlippageBps</code>.
        </p>
        <div className="role-row">
          <label className="field">
            <span>daily cap</span>
            <input
              id="risk-cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              inputMode="decimal"
              size={8}
              disabled={riskOff}
            />
            <span className="unit">lUSD</span>
          </label>
          <button
            className="btn"
            disabled={riskOff || !/^\d+(\.\d+)?$/.test(cap)}
            onClick={() => run("tighten", setRiskOut, () => actions.tighten(cap))}
          >
            {busy === "tighten" ? "Sending…" : "Tighten the leash"}
          </button>
          <button
            className="ghost"
            disabled={busy !== null}
            title="Simulate unregister, setAddress, setText(leash.quote) and clearing leash.maxSlippageBps as the risk manager. All four must revert."
            onClick={() => run("forbid", setRiskOut, actions.forbid)}
          >
            {busy === "forbid" ? "Trying…" : "Try to revoke"}
          </button>
        </div>
        {!riskGate.canSign && <p className="role-gate">{riskGate.reason}</p>}
        <OutcomeLine outcome={riskOut} txUrl={txUrl} />
      </div>

      <div className="role owner">
        <div className="role-head">
          <h2 className="role-name">Owner</h2>
          {owner && (
            <span className="addr hint" title={owner}>
              {shortHex(owner)}
            </span>
          )}
        </div>
        <p className="role-hint">
          Owns the parent name and the org registry. Revoking is one transaction, no key rotation.
          The only one who can set <code>leash.maxSlippageBps</code>.
        </p>
        <div className="role-row">
          <label className="field">
            <span>max slippage</span>
            <input
              id="owner-slippage"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              inputMode="numeric"
              size={6}
              disabled={ownerOff}
              title={slippageInputError(slippage) ?? `${Number(slippage) / 100}% of the pool price`}
            />
            <span className="unit">bps</span>
          </label>
          <button
            className="btn"
            disabled={ownerOff || slippageInputError(slippage) !== null}
            onClick={() => run("slippage", setOwnerOut, () => actions.slippage(slippage))}
          >
            {busy === "slippage" ? "Sending…" : "Set slippage"}
          </button>
          {revoked ? (
            <button
              className="btn"
              disabled={busy !== null || !ownerGate.canSign}
              title="Register this name again with a new mandate"
              onClick={onReissue}
            >
              Re-issue
            </button>
          ) : (
            <button
              className="btn danger"
              disabled={ownerOff}
              onClick={() => run("cut", setOwnerOut, actions.cut)}
            >
              {busy === "cut" ? "Cutting…" : "Cut the leash"}
            </button>
          )}
        </div>
        {!ownerGate.canSign && <p className="role-gate">{ownerGate.reason}</p>}
        <OutcomeLine outcome={ownerOut} txUrl={txUrl} />
      </div>
    </section>
  );
}

export function OutcomeLine({ outcome, txUrl }: { outcome: Outcome; txUrl?: string }) {
  if (!outcome) return null;
  return (
    <div className={`outcome ${outcome.tone}`}>
      {outcome.text}
      {outcome.txHash && (
        <>
          {" "}
          Tx{" "}
          {txUrl ? (
            <a href={`${txUrl}${outcome.txHash}`} target="_blank" rel="noreferrer">
              {shortHex(outcome.txHash, 10, 6)}
            </a>
          ) : (
            shortHex(outcome.txHash, 10, 6)
          )}
        </>
      )}
      {outcome.link && (
        <>
          {" "}
          <a href={outcome.link.href}>{outcome.link.text}</a>
        </>
      )}
    </div>
  );
}
