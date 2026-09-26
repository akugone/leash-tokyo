import { useState } from "react";
import { OutcomeLine } from "./RoleCards";
import { errorText, issueFormError, useSigner, type IssueForm, type Outcome } from "./signer";

type Props = {
  parentName: string;
  /// Prefilled form: the next free name with default rules, or a revoked name with its last policy.
  draft: IssueForm;
  /// Called once both owner transactions landed, with the new label.
  onIssued: (label: string) => void;
};

/// The "+ New agent" tab: the owner issues a subname with its own mandate in two transactions.
export function IssueAgent({ parentName, draft, onIssued }: Props) {
  const signer = useSigner();
  const [form, setForm] = useState<IssueForm>(draft);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const setField = <K extends keyof IssueForm>(key: K, value: IssueForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const gate = signer?.ownerGate ?? {
    canSign: false as const,
    reason:
      "Nothing can sign here: run the dashboard locally, or connect a wallet on the hosted site.",
  };
  const off = busy || !gate.canSign;
  const formError = issueFormError(form);

  const issue = async () => {
    if (!signer) return;
    setBusy(true);
    setOutcome({ tone: "info", text: "Two owner transactions: register, then the policy…" });
    try {
      const result = await signer.actions.issue(form);
      setOutcome(result);
      if (result?.tone === "ok") onIssued(form.label);
    } catch (err) {
      setOutcome({ tone: "bad", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="issue-page" aria-label="new agent">
      {signer?.walletBar}
      <div className="role issue">
        <div className="role-head">
          <h2 className="role-name">New agent</h2>
          <span className="hint">signed by the owner</span>
        </div>
        <p className="role-hint">
          Issue a subname of {parentName} with its own mandate: address record, daily cap, max
          slippage and expiry. Two transactions, no new contract. The risk manager's roles cover it
          at once, and it trades from the org vault within its own cap.
        </p>
        <div className="issue-fields">
          <label className="field">
            <span>name</span>
            <input
              id="issue-label"
              className="wide"
              value={form.label}
              onChange={(e) => setField("label", e.target.value.trim().toLowerCase())}
              disabled={off}
            />
            <span className="unit">.{parentName}</span>
          </label>
          <label className="field">
            <span>agent</span>
            <input
              id="issue-agent"
              className="wide addr"
              value={form.agent}
              onChange={(e) => setField("agent", e.target.value.trim())}
              disabled={off}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>daily cap</span>
            <input
              id="issue-cap"
              value={form.cap}
              onChange={(e) => setField("cap", e.target.value)}
              inputMode="decimal"
              disabled={off}
            />
            <span className="unit">lUSD</span>
          </label>
          <label className="field">
            <span>max slippage</span>
            <input
              id="issue-bps"
              value={form.bps}
              onChange={(e) => setField("bps", e.target.value)}
              inputMode="numeric"
              disabled={off}
            />
            <span className="unit">bps</span>
          </label>
          <label className="field">
            <span>mandate</span>
            <input
              id="issue-duration"
              value={form.duration}
              onChange={(e) => setField("duration", e.target.value)}
              inputMode="decimal"
              disabled={off}
            />
            <select
              id="issue-unit"
              value={form.unit}
              onChange={(e) => setField("unit", e.target.value as IssueForm["unit"])}
              disabled={off}
            >
              <option value="minutes">minutes</option>
              <option value="days">days</option>
            </select>
          </label>
        </div>
        <div className="role-row">
          <button
            className="btn"
            disabled={off || formError !== null}
            title={formError ?? undefined}
            onClick={() => void issue()}
          >
            {busy ? "Issuing…" : "Issue agent"}
          </button>
          {formError && gate.canSign && <span className="hint">{formError}</span>}
        </div>
        {!gate.canSign && <p className="role-gate">{gate.reason}</p>}
        <OutcomeLine outcome={outcome} txUrl={signer?.txUrl} />
      </div>
    </section>
  );
}
