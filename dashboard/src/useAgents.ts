import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicClient } from "viem";
import { fetchAgentLabels, fetchExpiries, LOG_LOOKBACK, rescanFrom } from "./lib/chain";
import { lookbackStart, type Deployments } from "./lib/leash";

/// One agent name of the org and its current expiry (zero once cut, null until read).
export type AgentEntry = { label: string; expiry: bigint | null };

const AGENTS_POLL_MS = 10_000;

/// Every agent the org registry ever issued, from its `LabelRegistered` events, with each expiry refreshed on
/// every poll. The log scan is incremental; a failed poll keeps the last list on screen.
export function useAgents(client: PublicClient | null, deployments: Deployments | null) {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [tick, setTick] = useState(0);
  const labels = useRef<string[]>([]);
  const scannedTo = useRef<bigint | null>(null);

  // A new registry (or a new record) starts from scratch.
  useEffect(() => {
    labels.current = [];
    scannedTo.current = null;
    setAgents([]);
  }, [client, deployments?.orgRegistry]);

  useEffect(() => {
    if (!client || !deployments) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const registry = deployments.orgRegistry;

    const run = async () => {
      try {
        const latest = await client.getBlockNumber();
        const from =
          scannedTo.current !== null
            ? rescanFrom(scannedTo.current)
            : deployments.orgRegistryBlock
              ? BigInt(deployments.orgRegistryBlock)
              : lookbackStart(latest, LOG_LOOKBACK);
        if (from <= latest) {
          for (const label of await fetchAgentLabels(client, registry, from, latest)) {
            if (!labels.current.includes(label)) labels.current.push(label);
          }
          scannedTo.current = latest;
        }
        const expiries = await fetchExpiries(client, registry, labels.current);
        if (!cancelled) {
          setAgents(labels.current.map((label, i) => ({ label, expiry: expiries[i] ?? null })));
        }
      } catch {
        // Rate limit or network: keep the last list, retry on the next poll.
      } finally {
        if (!cancelled) timer = setTimeout(run, AGENTS_POLL_MS);
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, deployments, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { agents, refresh };
}
