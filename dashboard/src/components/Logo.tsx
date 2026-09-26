/// The Leash mark: a collar with its tag, the line and its handle. Shared by the landing and the dashboard; the cut-out follows `--logo-cut`, the tag `--logo-tag`.
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="112" fill="currentColor" />
      <circle
        cx="170"
        cy="256"
        r="66"
        fill="none"
        stroke="var(--logo-cut, #fff)"
        strokeWidth="30"
      />
      <circle cx="170" cy="256" r="16" fill="var(--logo-tag, #3fb8a4)" />
      <rect x="236" y="241" width="118" height="30" rx="15" fill="var(--logo-cut, #fff)" />
      <circle
        cx="378"
        cy="256"
        r="38"
        fill="none"
        stroke="var(--logo-cut, #fff)"
        strokeWidth="22"
      />
    </svg>
  );
}
