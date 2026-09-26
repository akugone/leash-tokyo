import { useState } from "react";
import { parseDeployments, type DashboardConfig } from "../lib/leash";
import { readOverride, writeOverride } from "../useDashboard";

type Props = {
  config: DashboardConfig;
  source: "override" | "url" | null;
  onApply: (next: DashboardConfig) => void;
  onClose: () => void;
};

export function Settings({ config, source, onApply, onClose }: Props) {
  const [rpc, setRpc] = useState(config.rpc);
  const [label, setLabel] = useState(config.label);
  const [deploymentsUrl, setDeploymentsUrl] = useState(config.deployments);
  const [blob, setBlob] = useState(readOverride() ?? "");
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    setError(null);
    const trimmed = blob.trim();
    if (trimmed) {
      try {
        parseDeployments(JSON.parse(trimmed));
        writeOverride(trimmed);
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    } else {
      writeOverride(null);
    }
    onApply({
      rpc: rpc.trim() || config.rpc,
      label: label.trim() || config.label,
      deployments: deploymentsUrl.trim() || config.deployments,
    });
    onClose();
  };

  return (
    <section className="drawer">
      <div className="section-head">
        <h2>Settings</h2>
        <span className="hint">deployments from {source ?? "nowhere yet"}</span>
      </div>
      <label>
        rpc url
        <input value={rpc} onChange={(e) => setRpc(e.target.value)} spellCheck={false} />
      </label>
      <label>
        label
        <input value={label} onChange={(e) => setLabel(e.target.value)} spellCheck={false} />
      </label>
      <label>
        deployments url
        <input
          value={deploymentsUrl}
          onChange={(e) => setDeploymentsUrl(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label>
        or paste deployments JSON (overrides the url, stored in this browser)
        <textarea
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder='{"chainId":"11155111","parentName":"leash.eth", ...}'
        />
      </label>
      {error && <div className="card-error">{error}</div>}
      <div className="row">
        <button className="btn" onClick={apply}>
          Apply
        </button>
        <button
          className="ghost"
          onClick={() => {
            setBlob("");
            writeOverride(null);
          }}
        >
          Clear pasted JSON
        </button>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
