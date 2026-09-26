import { useEffect, useState } from "react";
import { AgentFeed } from "./components/AgentFeed";
import { Cards } from "./components/Cards";
import { Controls } from "./components/Controls";
import { LeashBar } from "./components/LeashBar";
import { Logo } from "./components/Logo";
import { Settings } from "./components/Settings";
import { StatusPill } from "./components/StatusPill";
import { SwapTable } from "./components/SwapTable";
import { computeStatus, type LeashStatus } from "./lib/leash";
import { useDashboard } from "./useDashboard";

/// Chain time estimate: last block timestamp plus the wall clock elapsed since it was fetched.
function useChainNow(blockTimestamp: bigint | null, fetchedAt: number | null): bigint | null {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (blockTimestamp === null || fetchedAt === null) return null;
  return blockTimestamp + BigInt(Math.floor((Date.now() - fetchedAt) / 1000));
}

export function App() {
  const dash = useDashboard();
  const { config, deployments, snapshot } = dash;
  const [settingsOpen, setSettingsOpen] = useState(false);

  const now = useChainNow(snapshot?.blockTimestamp ?? null, snapshot?.fetchedAt ?? null);
  const expiry = snapshot?.expiry.value ?? null;
  const status: LeashStatus =
    snapshot && now !== null
      ? computeStatus({ expiry, now, revokedByHook: snapshot.revokedByHook })
      : "unknown";

  const fullName = deployments ? `${config.label}.${deployments.parentName}` : config.label;
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
          <h1 className="name" title={snapshot ? `node ${snapshot.node}` : undefined}>
            {fullName}
          </h1>
          <div className="header-right">
            <StatusPill status={status} />
            <button
              className="ghost"
              onClick={() => setSettingsOpen((o) => !o)}
              aria-expanded={settingsOpen}
            >
              Settings
            </button>
          </div>
        </div>
      </header>

      <main className="app">
        {dash.deploymentsError && (
          <div className="banner error">
            deployments: {dash.deploymentsError}
            <button className="ghost" onClick={() => setSettingsOpen(true)}>
              Paste JSON
            </button>
          </div>
        )}
        {dash.pollError && <div className="banner error">rpc: {dash.pollError}</div>}
        {!snapshot && !dash.deploymentsError && !dash.pollError && (
          <div className="banner">Connecting to {config.rpc}…</div>
        )}

        {settingsOpen && (
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
          <AgentFeed onActivity={dash.refreshNow} />
          <Controls onChanged={dash.refreshNow} revoked={status === "revoked"} />
        </div>

        <Cards snapshot={snapshot} deployments={deployments} />

        <SwapTable
          swaps={snapshot?.swaps ?? []}
          error={snapshot?.swapsError ?? null}
          scannedTo={snapshot?.scannedTo ?? null}
        />

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
