import { computeStatus, type LeashStatus } from "../lib/leash";
import type { AgentEntry } from "../useAgents";

type Props = {
  agents: AgentEntry[];
  /// Chain time in seconds, null until the first block is read.
  now: bigint | null;
  current: string;
  /// True while the "+ New agent" tab is open.
  creating: boolean;
  onSelect: (label: string) => void;
  onNew: () => void;
};

const STATUS_LABEL: Record<LeashStatus, string> = {
  live: "live",
  expiring: "expiring",
  revoked: "revoked",
  unknown: "…",
};

/// One tab per agent name the org registry issued. Live and expiring names first, in issue order; cut or
/// expired ones greyed at the end, still openable to re-issue them. The selected name is always shown, even
/// one the registry never issued.
export function AgentTabs({ agents, now, current, creating, onSelect, onNew }: Props) {
  const entries = agents.some((a) => a.label === current)
    ? agents
    : [...agents, { label: current, expiry: null }];
  const withStatus = entries.map((a) => ({
    ...a,
    status:
      a.expiry === null || now === null
        ? ("unknown" as const)
        : computeStatus({ expiry: a.expiry, now, revokedByHook: false }),
  }));
  const ordered = [
    ...withStatus.filter((a) => a.status !== "revoked"),
    ...withStatus.filter((a) => a.status === "revoked"),
  ];

  return (
    <nav className="agent-tabs" aria-label="agents">
      <div className="agent-tabs-row" role="tablist">
        {ordered.map((a) => {
          const selected = !creating && a.label === current;
          return (
            <button
              key={a.label}
              role="tab"
              aria-selected={selected}
              className={`agent-tab tone-${a.status} ${selected ? "selected" : ""}`}
              onClick={() => onSelect(a.label)}
            >
              <span className="agent-tab-name">{a.label}</span>
              <span className="agent-tab-status">{STATUS_LABEL[a.status]}</span>
            </button>
          );
        })}
        <button
          role="tab"
          aria-selected={creating}
          className={`agent-tab new ${creating ? "selected" : ""}`}
          onClick={onNew}
        >
          + New agent
        </button>
      </div>
    </nav>
  );
}
