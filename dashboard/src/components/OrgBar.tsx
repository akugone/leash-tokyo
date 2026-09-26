import { useState } from "react";
import { FUND_AMOUNT } from "../lib/actions";
import type { VaultHolding } from "../lib/chain";
import { formatAmount, shortHex, type Deployments } from "../lib/leash";
import { OutcomeLine } from "./RoleCards";
import { errorText, useSigner, type Outcome } from "./signer";

type Props = {
  deployments: Deployments | null;
  holdings: VaultHolding[] | null;
  onChanged: () => void;
};

/// Org level facts, above the agent tabs: the parent name and the one vault every agent trades from.
export function OrgBar({ deployments, holdings, onChanged }: Props) {
  const signer = useSigner();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  if (!deployments) return null;

  const fund = async () => {
    if (!signer) return;
    setBusy(true);
    setOutcome({ tone: "info", text: "Minting test tokens to the vault…" });
    try {
      setOutcome(await signer.actions.fund());
      onChanged();
    } catch (err) {
      setOutcome({ tone: "bad", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const gate = signer?.ownerGate;

  return (
    <section className="org-bar" aria-label="organisation">
      <div className="org-row">
        <span className="org-name">{deployments.parentName}</span>
        {deployments.vault && (
          <span className="org-vault">
            <span className="org-label">org vault</span>
            <span className="addr num" title={deployments.vault}>
              {shortHex(deployments.vault, 6, 4)}
            </span>
            <span className="org-holdings num">
              {holdings
                ? holdings.map((h) => `${formatAmount(h.balance)} ${h.symbol}`).join(" · ")
                : "…"}
            </span>
          </span>
        )}
        {signer && deployments.vault && (
          <button
            className="ghost small"
            disabled={busy || !gate?.canSign}
            title={
              gate?.canSign
                ? `Mint ${FUND_AMOUNT} lUSD and ${FUND_AMOUNT} lETH test tokens to the vault`
                : gate?.reason
            }
            onClick={() => void fund()}
          >
            {busy ? "Funding…" : "Fund vault"}
          </button>
        )}
      </div>
      <p className="org-hint">
        One treasury for every agent of the org. Each agent spends from it within its own daily cap.
      </p>
      <OutcomeLine outcome={outcome} txUrl={signer?.txUrl} />
    </section>
  );
}
