import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { AgentFeed } from "./components/AgentFeed";
import { AgentTabs } from "./components/AgentTabs";
import { Cards } from "./components/Cards";
import { IssueAgent } from "./components/IssueAgent";
import { LeashBar } from "./components/LeashBar";
import { Logo } from "./components/Logo";
import { OrgBar } from "./components/OrgBar";
import { RoleCards } from "./components/RoleCards";
import { Settings } from "./components/Settings";
import { SignerProvider, type IssueForm } from "./components/signer";
import { StatusPill } from "./components/StatusPill";
import { SwapTable } from "./components/SwapTable";
import { nextAgentLabel } from "./lib/actions";
import { chainNow, type ChainClock } from "./lib/chain";
import { childNode, computeStatus, LOCKED, type LeashStatus } from "./lib/leash";
import { useActivity } from "./useActivity";
import { useAgents } from "./useAgents";
import { useDashboard } from "./useDashboard";

/// Chain time, ticking every second between polls. Never moves backwards, see `advanceClock`.
function useChainNow(clock: ChainClock | null): bigint | null {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return chainNow(clock, Date.now());
}

export function App() {
  const dash = useDashboard();
  const { config, deployments, snapshot } = dash;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { agents, refresh: refreshAgents } = useAgents(dash.client, deployments);
  const activity = useActivity(dash.client, deployments);
  // The "+ New agent" tab, with the form it opens prefilled.
  const [draft, setDraft] = useState<IssueForm | null>(null);

  const now = useChainNow(snapshot?.clock ?? null);
  const expiry = snapshot?.expiry.value ?? null;
  const status: LeashStatus =
    snapshot && now !== null
      ? computeStatus({ expiry, now, revokedByHook: snapshot.revokedByHook })
      : "unknown";

  const fullName = deployments ? `${config.label}.${deployments.parentName}` : config.label;
  const creating = draft !== null;

  const select = (label: string) => {
    setDraft(null);
    if (label !== config.label) dash.setConfig({ ...config, label });
  };
  const newAgent = () =>
    setDraft({
      label: nextAgentLabel(agents.map((a) => a.label)),
      agent: deployments?.agent ?? "",
      cap: "100",
      bps: "50",
      duration: "7",
      unit: "days",
    });
  // A cut name comes back with its last policy, read from the resolver.
  const reissue = () => {
    const p = snapshot?.policy.value;
    setDraft({
      label: config.label,
      agent: p?.agent ?? deployments?.agent ?? "",
      cap: p ? formatUnits(p.cap, 18) : "100",
      bps: p?.maxSlippageBps?.toString() ?? "50",
      duration: "7",
      unit: "days",
    });
  };
  const changed = () => {
    dash.refreshNow();
    refreshAgents();
    activity.refresh();
  };
  const node = deployments ? childNode(deployments.parentNode, config.label) : null;
  // Etherscan links for the live Sepolia record, none for a local fork.
  const txUrl =
    deployments?.chainId === "11155111" && !/localhost|127\.0\.0\.1/.test(config.rpc)
      ? "https://sepolia.etherscan.io/tx/"
      : undefined;
  const lastUpdate = snapshot ? new Date(snapshot.fetchedAt).toLocaleTimeString() : "never";

  return (
    <div className={`page status-${status}`}>
      <header className="topbar">
        <div className="topbar-row">
          <a className="brand" href="/" title="Back to the home page">
            <Logo className="logo" /> Leash
          </a>
          <span className="crumb" aria-hidden="true">
            /
          </span>
          <h1 className="name" title={snapshot && !creating ? `node ${snapshot.node}` : undefined}>
            {creating ? `new agent of ${deployments?.parentName ?? "the org"}` : fullName}
          </h1>
          <div className="header-right">
            {!creating && <StatusPill status={status} />}
            {!LOCKED && (
              <button
                className="ghost"
                onClick={() => setSettingsOpen((o) => !o)}
                aria-expanded={settingsOpen}
              >
                Settings
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="app">
        {dash.deploymentsError && (
          <div className="banner error">
            deployments: {dash.deploymentsError}
            {!LOCKED && (
              <button className="ghost" onClick={() => setSettingsOpen(true)}>
                Paste JSON
              </button>
            )}
          </div>
        )}
        {dash.pollError && <div className="banner error">rpc: {dash.pollError}</div>}
        {!snapshot && !dash.deploymentsError && !dash.pollError && (
          <div className="banner">Connecting to {config.rpc}…</div>
        )}

        {!LOCKED && settingsOpen && (
          <Settings
            config={config}
            source={dash.deploymentsSource}
            onApply={(next) => {
              dash.setConfig(next);
              dash.reloadDeployments();
            }}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        <SignerProvider deployments={deployments} label={config.label} rpc={config.rpc}>
          <OrgBar
            deployments={deployments}
            holdings={snapshot?.vault?.value ?? null}
            onChanged={dash.refreshNow}
          />
          <AgentTabs
            agents={agents}
            now={now}
            current={config.label}
            creating={creating}
            onSelect={select}
            onNew={newAgent}
          />

          {creating && deployments ? (
            <IssueAgent
              key={JSON.stringify(draft)}
              parentName={deployments.parentName}
              draft={draft}
              onIssued={(label) => {
                refreshAgents();
                select(label);
              }}
            />
          ) : (
            <>
              <LeashBar
                cap={snapshot?.policy.value?.cap ?? null}
                spent={snapshot?.spentToday.value ?? null}
                left={snapshot?.remainingToday.value ?? null}
                expiry={expiry}
                now={now}
                status={status}
                symbol="lUSD"
              />

              <div className="ops">
                <AgentFeed
                  onActivity={changed}
                  chain={{ items: activity.items, latest: activity.latest, now, node, txUrl }}
                />
                <RoleCards
                  revoked={status === "revoked"}
                  onChanged={changed}
                  onReissue={reissue}
                  currentCap={
                    snapshot?.policy.value ? formatUnits(snapshot.policy.value.cap, 18) : null
                  }
                  currentBps={snapshot?.policy.value?.maxSlippageBps?.toString() ?? null}
                />
              </div>

              <Cards snapshot={snapshot} deployments={deployments} />

              <SwapTable
                swaps={snapshot?.swaps ?? []}
                error={snapshot?.swapsError ?? null}
                scannedTo={snapshot?.scannedTo ?? null}
                txUrl={txUrl}
              />
            </>
          )}
        </SignerProvider>

        <footer className="footer">
          <span>
            chain <b className="num">{deployments?.chainId ?? "?"}</b>
          </span>
          <span>
            block <b className="num">{snapshot?.blockNumber?.toString() ?? "?"}</b>
          </span>
          <span>
            rpc <b title={config.rpc}>{shortUrl(config.rpc)}</b>
          </span>
          <span className={dash.polling ? "pulse" : ""}>
            updated <b className="num">{lastUpdate}</b>, every 5s
          </span>
          <button className="ghost small" onClick={dash.refreshNow} disabled={!deployments}>
            Refresh now
          </button>
          {snapshot && (
            <span className="node" title={snapshot.node}>
              node <b className="num">{snapshot.node.slice(0, 10)}…</b>
            </span>
          )}
        </footer>
      </main>
    </div>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}
