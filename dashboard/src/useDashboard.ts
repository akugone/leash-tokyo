// Config loading + 5 second polling. Keeps the last good snapshot when a poll fails.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicClient } from "viem";
import { fetchSnapshot, makeClient, POLL_MS, type Snapshot } from "./lib/chain";
import {
  configToSearch,
  parseConfig,
  parseDeployments,
  type DashboardConfig,
  type Deployments,
} from "./lib/leash";

const OVERRIDE_KEY = "leash.deployments.override";

export function readOverride(): string | null {
  try {
    return localStorage.getItem(OVERRIDE_KEY);
  } catch {
    return null;
  }
}

export function writeOverride(json: string | null) {
  try {
    if (json === null) localStorage.removeItem(OVERRIDE_KEY);
    else localStorage.setItem(OVERRIDE_KEY, json);
  } catch {
    // storage unavailable: ignore, the override just does not persist
  }
}

export type DashboardState = {
  /// Read client for the configured RPC, null until the deployments load.
  client: PublicClient | null;
  config: DashboardConfig;
  setConfig: (next: DashboardConfig) => void;
  deployments: Deployments | null;
  deploymentsError: string | null;
  deploymentsSource: "override" | "url" | null;
  snapshot: Snapshot | null;
  pollError: string | null;
  polling: boolean;
  refreshNow: () => void;
  reloadDeployments: () => void;
};

export function useDashboard(): DashboardState {
  const [config, setConfigState] = useState<DashboardConfig>(() =>
    parseConfig(window.location.search),
  );
  const [deployments, setDeployments] = useState<Deployments | null>(null);
  const [deploymentsError, setDeploymentsError] = useState<string | null>(null);
  const [deploymentsSource, setDeploymentsSource] = useState<"override" | "url" | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [tick, setTick] = useState(0);
  const [depsTick, setDepsTick] = useState(0);
  const previous = useRef<Snapshot | null>(null);

  const setConfig = useCallback((next: DashboardConfig) => {
    setConfigState(next);
    const search = configToSearch(next);
    window.history.replaceState(null, "", `${window.location.pathname}${search}`);
    previous.current = null;
    setSnapshot(null);
  }, []);

  // Load deployments: pasted override first, then the configured URL.
  useEffect(() => {
    let cancelled = false;
    setDeploymentsError(null);
    const override = readOverride();
    if (override) {
      try {
        setDeployments(parseDeployments(JSON.parse(override)));
        setDeploymentsSource("override");
        return;
      } catch (err) {
        setDeploymentsError(`pasted deployments: ${(err as Error).message}`);
      }
    }
    fetch(config.deployments, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${config.deployments}`);
        return parseDeployments(await res.json());
      })
      .then((d) => {
        if (cancelled) return;
        setDeployments(d);
        setDeploymentsSource("url");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setDeployments(null);
        setDeploymentsError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [config.deployments, depsTick]);

  const client = useMemo(
    () => (deployments ? makeClient(config.rpc, Number(deployments.chainId)) : null),
    [config.rpc, deployments],
  );

  // Poll loop.
  useEffect(() => {
    if (!client || !deployments) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      setPolling(true);
      try {
        const snap = await fetchSnapshot(client, deployments, config.label, previous.current);
        if (cancelled) return;
        previous.current = snap;
        setSnapshot(snap);
        setPollError(null);
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setPolling(false);
          timer = setTimeout(run, POLL_MS);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, deployments, config.label, tick]);

  return {
    client,
    config,
    setConfig,
    deployments,
    deploymentsError,
    deploymentsSource,
    snapshot,
    pollError,
    polling,
    refreshNow: () => setTick((t) => t + 1),
    reloadDeployments: () => setDepsTick((t) => t + 1),
  };
}
