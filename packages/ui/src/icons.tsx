import type { ReactNode } from "react";

/** Small inline icon set (24px grid, 1.75 stroke, currentColor). No icon
 *  library: the dashboard needs about a dozen glyphs. Icons are decorative —
 *  the text next to them carries the meaning — so they are aria-hidden. */
const paths: Record<string, ReactNode> = {
  overview: <path d="M4 13h7V4H4v9Zm9 7h7V11h-7v9ZM4 20h7v-5H4v5Zm9-9h7V4h-7v7Z" />,
  transactions: <path d="M7 7h13m0 0-3-3m3 3-3 3M17 17H4m0 0 3-3m-3 3 3 3" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />,
  webhook: <path d="M9 17a4 4 0 1 1 3-6.6M12 7a3 3 0 1 1 2.6 4.5H9m5 5.5a3 3 0 1 0 2.6-4.5" />,
  settlement: <path d="M3 10 12 4l9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18" />,
  reconcile: <path d="M9 12l2 2 4-4M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />,
  merchants: <path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6" />,
  credits: <path d="M3 7h18v10H3V7Zm0 4h18M7 15h3" />,
  upload: <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v4h16v-4" />,
  replay: <path d="M4 12a8 8 0 1 0 3-6.2M4 4v5h5" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4m-4-4h11" />,
  copy: <path d="M9 9h11v11H9V9Zm-5 6V4h11" />,
  check: <path d="M5 12.5 10 17.5 19 7" />,
  alert: <path d="M12 4 2.5 20h19L12 4Zm0 6v5m0 2.5v.01" />,
  info: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v6m0-9v.01" />,
  search: <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4 4" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  lock: <path d="M6 11h12v9H6v-9Zm3 0V8a3 3 0 0 1 6 0v3" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="fp-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
