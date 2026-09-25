import type { LeashStatus } from "../lib/leash";

const LABELS: Record<LeashStatus, string> = {
  live: "Live",
  expiring: "Expiring",
  revoked: "Revoked",
  unknown: "…",
};

export function StatusPill({ status }: { status: LeashStatus }) {
  return (
    <span className={`pill pill-${status}`} role="status" aria-live="polite">
      <span className="dot" />
      {LABELS[status]}
    </span>
  );
}
