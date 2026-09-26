import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex, PublicClient } from "viem";
import {
  buildActivity,
  fetchActivityLogs,
  txsNeedingSender,
  type ActivityItem,
} from "./lib/activity";
import { AGENT_LOG_CHUNK, LOG_LOOKBACK, rescanFrom } from "./lib/chain";
import { blockRanges, lookbackStart, type Deployments } from "./lib/leash";

const ACTIVITY_POLL_MS = 10_000;

/// The org's on-chain activity, scanned incrementally from the registry's deployment block. A failed poll keeps
/// the last feed and retries.
export function useActivity(client: PublicClient | null, deployments: Deployments | null) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [latest, setLatest] = useState<bigint | null>(null);
  const [tick, setTick] = useState(0);
  const logs = useRef<Awaited<ReturnType<typeof fetchActivityLogs>>>([]);
  const senders = useRef(new Map<Hex, Address>());
  const scannedTo = useRef<bigint | null>(null);
  const seen = useRef(new Set<string>());
  // Each agent's own resolver, found as the scan goes.
  const resolvers = useRef(new Set<Address>());

  useEffect(() => {
    logs.current = [];
    seen.current = new Set();
    resolvers.current = new Set();
    senders.current = new Map();
    scannedTo.current = null;
    setItems([]);
  }, [client, deployments?.orgRegistry, deployments?.vault]);

  useEffect(() => {
    if (!client || !deployments) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const head = await client.getBlockNumber();
        const from =
          scannedTo.current !== null
            ? rescanFrom(scannedTo.current)
            : deployments.orgRegistryBlock
              ? BigInt(deployments.orgRegistryBlock)
              : lookbackStart(head, LOG_LOOKBACK);
        for (const range of from <= head ? blockRanges(from, head, AGENT_LOG_CHUNK) : []) {
          // The scan overlaps its last blocks (rescanFrom): keep each log once.
          const found = await fetchActivityLogs(
            client,
            deployments,
            range.from,
            range.to,
            resolvers.current,
          );
          for (const log of found) {
            const key = `${log.transactionHash}:${log.logIndex}`;
            if (seen.current.has(key)) continue;
            seen.current.add(key);
            logs.current.push(log);
          }
          scannedTo.current = range.to;
        }
        // Who wrote each policy change: one lookup per transaction, cached.
        const missing = txsNeedingSender(logs.current).filter((h) => !senders.current.has(h));
        const txs = await Promise.all(missing.map((hash) => client.getTransaction({ hash })));
        txs.forEach((tx) => senders.current.set(tx.hash, tx.from));
        if (!cancelled) {
          setItems(buildActivity(logs.current, deployments, senders.current));
          setLatest(head);
        }
      } catch {
        // Rate limit or network: keep the feed, retry on the next poll.
      } finally {
        if (!cancelled) timer = setTimeout(run, ACTIVITY_POLL_MS);
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, deployments, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { items, latest, refresh };
}
