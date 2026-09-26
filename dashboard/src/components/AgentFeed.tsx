import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import type { ActivityItem, ActivityKind } from "../lib/activity";

export type FeedEvent = {
  id: number;
  ts: number;
  source: "agent" | "risk" | "owner" | "system" | string;
  kind: string;
  text: string;
  txHash?: string;
};

const FEED_POLL_MS = 1_000;
/// The hosted build has no dev server behind it, so no feed: do not poll, say where the feed lives instead.
const HOSTED = import.meta.env.PROD;
const MAX_ROWS = 40;
const SOURCE_LABEL: Record<string, string> = {
  agent: "agent",
  risk: "risk-manager",
  owner: "owner",
  system: "system",
};

/// Sepolia block interval, to date a block from the chain clock without fetching it.
const BLOCK_SECONDS = 12n;

const CHAIN_SOURCE: Record<ActivityKind, string> = {
  swap: "agent",
  refused: "agent",
  policy: "system",
  issued: "owner",
  cut: "owner",
  funded: "owner",
};

const CHAIN_TONE: Record<ActivityKind, string> = {
  swap: "ok",
  refused: "revert",
  policy: "policy",
  issued: "ok",
  cut: "cut",
  funded: "ok",
};

type ChainFeed = {
  items: ActivityItem[];
  /// Block the activity was scanned to, and chain time now: together they date each item.
  latest: bigint | null;
  now: bigint | null;
  /// Selected agent's node: its items and the org level ones are shown.
  node: Hex | null;
  txUrl?: string;
};

/// What the agent and the humans did, newest first. "On chain" reads the contracts' events and works anywhere;
/// "Agent log" is the dev server's live feed (/api/agent-events), with the agent's signed intents and simulated
/// refusals, and exists only under `bun run dev`.
export function AgentFeed({ onActivity, chain }: { onActivity?: () => void; chain: ChainFeed }) {
  const [mode, setMode] = useState<"chain" | "agent">(HOSTED ? "chain" : "agent");
  const [rows, setRows] = useState<FeedEvent[]>([]);
  const [available, setAvailable] = useState<boolean | null>(HOSTED ? false : null);
  const [lastAgentAt, setLastAgentAt] = useState<number | null>(null);
  const after = useRef(0);
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;

  useEffect(() => {
    if (HOSTED) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await fetch(`/api/agent-events?after=${after.current}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { events: FeedEvent[]; latest: number };
        if (cancelled) return;
        setAvailable(true);
        if (body.events.length > 0) {
          after.current = body.latest;
          // Copy before reversing: React StrictMode runs updaters twice in dev.
          setRows((prev) => [...[...body.events].reverse(), ...prev].slice(0, MAX_ROWS));
          const agentEvents = body.events.filter((e) => e.source === "agent");
          if (agentEvents.length > 0) setLastAgentAt(Date.now());
          // A state change on chain: ask the dashboard to refresh now instead of waiting for the next poll.
          if (body.events.some((e) => ["ok", "cut", "revert", "denied"].includes(e.kind)))
            onActivityRef.current?.();
        }
      } catch {
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) timer = setTimeout(poll, FEED_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const active = lastAgentAt !== null && Date.now() - lastAgentAt < 6_000;

  return (
    <section className="feed" aria-label="activity">
      <div className="section-head">
        <h2>
          Activity <span className={`feed-dot ${active ? "on" : ""}`} aria-hidden="true" />
        </h2>
        {!HOSTED && (
          <span className="feed-modes" role="tablist">
            <button
              role="tab"
              aria-selected={mode === "chain"}
              className={mode === "chain" ? "selected" : ""}
              onClick={() => setMode("chain")}
            >
              On chain
            </button>
            <button
              role="tab"
              aria-selected={mode === "agent"}
              className={mode === "agent" ? "selected" : ""}
              onClick={() => setMode("agent")}
            >
              Agent log
            </button>
          </span>
        )}
        <span className="hint">
          {mode === "chain"
            ? "Read from the contracts' events, every line is a transaction"
            : available === false
              ? "Feed offline. Start the dashboard with bun run dev."
              : rows.length === 0
                ? "Waiting for the agent"
                : `${rows.length} events`}
        </span>
      </div>
      {mode === "chain" ? (
        <ChainList {...chain} />
      ) : (
        <ol className="feed-list">
          {rows.length === 0 && available !== false && (
            <li className="feed-row empty">
              Nothing yet. Open the agent terminal with <code>script/demo.sh agent</code> and give
              it an order.
            </li>
          )}
          {rows.map((e) => (
            <li key={e.id} className={`feed-row kind-${e.kind}`}>
              <span className="feed-time num">
                {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={`feed-src src-${e.source}`}>
                {SOURCE_LABEL[e.source] ?? e.source}
              </span>
              <span className="feed-text">{shortenHashes(e.text)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/// 66 char tx hashes take a whole line in the feed: show head and tail only.
function shortenHashes(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{64}/g, (h) => `${h.slice(0, 10)}…${h.slice(-6)}`);
}

function ChainList({ items, latest, now, node, txUrl }: ChainFeed) {
  const shown = items.filter((i) => i.node === null || i.node === node);
  const time = (block: bigint) => {
    if (latest === null || now === null) return `#${block}`;
    const ts = now - (latest - block) * BLOCK_SECONDS;
    return new Date(Number(ts) * 1000).toLocaleTimeString([], { hour12: false });
  };
  return (
    <ol className="feed-list">
      {shown.length === 0 && (
        <li className="feed-row empty">Nothing on chain yet for this agent.</li>
      )}
      {shown.map((i) => (
        <li key={`${i.txHash}-${i.logIndex}`} className={`feed-row kind-${CHAIN_TONE[i.kind]}`}>
          <span className="feed-time num" title={`block ${i.block}, time estimated from the block`}>
            {time(i.block)}
          </span>
          <span className={`feed-src src-${sourceOf(i)}`}>{SOURCE_LABEL[sourceOf(i)]}</span>
          <span className="feed-text">
            {i.text}{" "}
            {txUrl ? (
              <a href={`${txUrl}${i.txHash}`} target="_blank" rel="noreferrer">
                {shortenHashes(i.txHash)}
              </a>
            ) : (
              shortenHashes(i.txHash)
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/// Policy writes are signed by the risk manager or the owner: the item's text starts with the role.
function sourceOf(i: ActivityItem): string {
  if (i.kind !== "policy") return CHAIN_SOURCE[i.kind];
  if (i.text.startsWith("risk manager")) return "risk";
  if (i.text.startsWith("owner")) return "owner";
  return "system";
}
