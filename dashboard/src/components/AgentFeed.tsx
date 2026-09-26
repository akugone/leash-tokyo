import { useEffect, useRef, useState } from "react";

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

/// What the agent and the humans did, newest first. Fed by the dev server's /api/agent-events.
export function AgentFeed({ onActivity }: { onActivity?: () => void }) {
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
        <span className="hint">
          {HOSTED
            ? "Live during the local demo. Swaps below are read from Sepolia."
            : available === false
              ? "Feed offline. Start the dashboard with bun run dev."
              : rows.length === 0
                ? "Waiting for the agent"
                : `${rows.length} events`}
        </span>
      </div>
      <ol className="feed-list">
        {rows.length === 0 && available !== false && (
          <li className="feed-row empty">
            Nothing yet. Open the agent terminal with <code>script/demo.sh agent</code> and give it
            an order.
          </li>
        )}
        {rows.map((e) => (
          <li key={e.id} className={`feed-row kind-${e.kind}`}>
            <span className="feed-time num">
              {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className={`feed-src src-${e.source}`}>{SOURCE_LABEL[e.source] ?? e.source}</span>
            <span className="feed-text">{shortenHashes(e.text)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/// 66 char tx hashes take a whole line in the feed: show head and tail only.
function shortenHashes(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{64}/g, (h) => `${h.slice(0, 10)}…${h.slice(-6)}`);
}
