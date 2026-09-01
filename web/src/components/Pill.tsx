import type { ReactNode } from "react";

export type PillTone = "idle" | "recording" | "match" | "no-match" | "uncertain";

interface PillProps {
  tone: PillTone;
  children: ReactNode;
  /** Show the little status dot. */
  dot?: boolean;
  size?: "sm" | "md";
}

export function Pill({ tone, children, dot = true, size = "md" }: PillProps) {
  return (
    <span className={`pill pill--${tone} pill--${size}`}>
      {dot && <span className="pill__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
