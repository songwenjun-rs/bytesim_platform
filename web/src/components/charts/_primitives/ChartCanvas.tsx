/**
 * ChartCanvas — wraps an SVG with consistent padding + viewBox.
 * Children render inside the chart area; absolute pixel coords go
 * relative to the canvas top-left (NOT the inner area).
 *
 *   <ChartCanvas width={720} height={300} pad={{l:50, r:16, t:16, b:36}}>
 *     <XAxis scale={...} ticks={...} y={300-36} pixelStart={50} pixelEnd={720-16} />
 *     <Series ... />
 *   </ChartCanvas>
 */
import { type ReactNode } from "react";

export type Pad = { l: number; r: number; t: number; b: number };
export const DEFAULT_PAD: Pad = { l: 50, r: 16, t: 16, b: 36 };

export function ChartCanvas({
  width, height, children,
  ariaLabel,
}: {
  width: number; height: number; pad?: Pad;
  children: ReactNode; ariaLabel?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      aria-label={ariaLabel}
    >
      {children}
    </svg>
  );
}

/** Inner area helpers — caller can use these to know where to render. */
export function innerBox(width: number, height: number, pad: Pad = DEFAULT_PAD) {
  return {
    x0: pad.l, y0: pad.t,
    x1: width - pad.r, y1: height - pad.b,
    width: width - pad.l - pad.r, height: height - pad.t - pad.b,
  };
}
