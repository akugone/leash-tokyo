import { useEffect, useState } from "react";
import { slippageInputError } from "../lib/leash";
import { errorText, useSigner, type Outcome } from "./signer";
import { CopyHex } from "./CopyHex";

type Props = {
  revoked: boolean;
  onChanged: () => void;
  /// Revoked name: open the New agent page prefilled with this name and its last policy.
  onReissue: () => void;
  /// The selected agent's policy as the hook reads it, to prefill the inputs. Null until read, or when the
  /// record is empty (no slippage bound).
  currentCap: string | null;
  currentBps: string | null;
  /// Whether the risk manager holds its role on this agent's own resolver. Null until read.
  riskDelegated: boolean | null;
};

/// The two human roles of the story on the selected agent: the risk manager tightens, the owner narrows the
/// slippage, cuts the leash, or issues the name again once cut.
export function RoleCards({
  revoked,
  onChanged,
  onReissue,
  currentCap,
  currentBps,
  riskDelegated,
}: Props) {
  const signer = useSigner();
  const [cap, setCap] = useState("10");
  const [slippage, setSlippage] = useState("50");
  const [busy, setBusy] = useState<string | null>(null);
  const [riskOut, setRiskOut] = useState<Outcome>(null);
  const [ownerOut, setOwnerOut] = useState<Outcome>(null);

  // Start from the agent's real policy, and follow it when it changes on chain or another tab is selected.
  // A poll that reads the same value leaves what the user is typing alone.
  useEffect(() => {
    if (currentCap !== null) setCap(currentCap);
  }, [currentCap]);
  useEffect(() => {
    if (currentBps !== null) setSlippage(currentBps);
  }, [currentBps]);

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

  // No role on this agent: "tighten the leash" only simulates, so it needs no wallet and shows ENS refusing.
  const simulateOnly = riskDelegated === false;
  const riskOff = busy !== null || revoked || (!riskGate.canSign && !simulateOnly);
  const ownerOff = busy !== null || revoked || !ownerGate.canSign;

  return (
    <section className="controls" aria-label="controls">
      {walletBar}
      <div className="role">
        <div className="role-head">
          <h2 className="role-name">Risk manager</h2>
          {riskManager && (
            <span className="hint">
              <CopyHex value={riskManager} />
            </span>
          )}
        </div>
        <p className="role-hint">
          Can edit two records of this agent, <code>leash.dailyNotional</code> and{" "}
          <code>leash.tokens</code>, granted on the agent's own resolver: no power over any other
          agent. Nothing else, not even <code>leash.maxSlippageBps</code>.
        </p>
        {simulateOnly && (
          <p className="role-gate">
            No role on this agent's resolver: the owner issued it without giving the risk manager
            its role. <b>Tighten the leash</b> is simulated first, ENS answers{" "}
            <code>EACUnauthorizedAccountRoles</code>, and nothing is sent. No wallet needed.
          </p>
        )}
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
            title={
              simulateOnly
                ? "Simulated as the risk manager: ENS refuses, nothing is sent"
                : "Simulated first, then signed by the risk manager"
            }
            onClick={() => run("tighten", setRiskOut, () => actions.tighten(cap))}
          >
            {busy === "tighten" ? (simulateOnly ? "Simulating…" : "Sending…") : "Tighten the leash"}
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
        {!riskGate.canSign && !simulateOnly && <p className="role-gate">{riskGate.reason}</p>}
        <OutcomeLine outcome={riskOut} txUrl={txUrl} />
      </div>

      <div className="role owner">
        <div className="role-head">
          <h2 className="role-name">Owner</h2>
          {owner && (
            <span className="hint">
              <CopyHex value={owner} />
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
          <CopyHex
            value={outcome.txHash}
            head={10}
            tail={6}
            what="hash"
            href={txUrl ? `${txUrl}${outcome.txHash}` : undefined}
          />
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
