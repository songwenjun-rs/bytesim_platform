/**
 * SVG-anchored tooltip rendered via foreignObject. Caller positions it at
 * the data point and supplies content. Auto-flips edges to stay in canvas.
 */
import { type ReactNode } from "react";

export function Tooltip({
  x, y, canvasWidth, canvasHeight,
  width = 220, height = 80,
  children,
}: {
  x: number; y: number;
  canvasWidth: number; canvasHeight: number;
  width?: number; height?: number;
  children: ReactNode;
}) {
  // Flip horizontally if too close to right edge
  const tx = x + width + 12 > canvasWidth ? Math.max(0, x - width - 12) : x + 12;
  // Flip vertically if too close to bottom
  const ty = y + height + 8 > canvasHeight ? Math.max(0, y - height - 8) : y + 8;
  return (
    <foreignObject x={tx} y={ty} width={width} height={height} style={{ pointerEvents: "none" }}>
      <div className="pareto-tooltip" style={{
        background: "var(--bg-3)",
        border: "1px solid var(--hairline-2)",
        borderRadius: "var(--r-sm)",
        padding: "6px 8px",
        fontSize: 11,
        color: "var(--t1)",
        boxShadow: "var(--sh-sm)",
      }}>
        {children}
      </div>
    </foreignObject>
  );
}
