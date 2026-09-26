/// The Leash mark: a collar and its line. Shared by the landing and the dashboard; the cut-out follows `--logo-cut`.
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <rect width="16" height="16" rx="3.5" fill="currentColor" />
      <circle cx="4.5" cy="8" r="2" fill="var(--logo-cut, #fff)" />
      <rect x="6.5" y="7.2" width="7" height="1.6" rx="0.8" fill="var(--logo-cut, #fff)" />
    </svg>
  );
}
