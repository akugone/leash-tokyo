/// Line icons, 24x24, stroke only, colour from `currentColor`. Used by the hero drift and the sections.
import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "robot"
  | "key"
  | "shield"
  | "coin"
  | "chart"
  | "link"
  | "lock"
  | "scissors"
  | "clock"
  | "swap"
  | "building"
  | "signature"
  | "user"
  | "code"
  | "terminal"
  | "arrow";

const paths: Record<IconName, ReactNode> = {
  robot: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 8V5" />
      <circle cx="12" cy="4" r="1" />
      <circle cx="9.5" cy="13" r="1.2" />
      <circle cx="14.5" cy="13" r="1.2" />
      <path d="M10 16.5h4M3 12v3M21 12v3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8-8M16 7l2 2M14 9l2 2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  coin: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M14.5 9.5c-.5-.9-1.4-1.3-2.5-1.3-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.4 5 4 0 1.1-1 1.9-2.5 1.9-1.1 0-2-.4-2.5-1.3M12 6.5v1.7M12 15.8v1.7" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V4M4 20h16" />
      <path d="M7 15l4-4 3 3 5-6" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M8 7.5L20 18M8 16.5L20 6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  swap: (
    <>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </>
  ),
  building: (
    <>
      <path d="M4 20h16M6 20V9l6-4 6 4v11" />
      <path d="M10 20v-5h4v5M9 11h.01M15 11h.01" />
    </>
  ),
  signature: (
    <>
      <path d="M3 17c3-6 5-9 6-8s-2 7 0 7 3-4 4-4 0 3 2 3 3-2 6-2" />
      <path d="M3 21h18" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </>
  ),
  code: (
    <>
      <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 10l3 2-3 2M12 15h5" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};

export function Icon({ name, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
