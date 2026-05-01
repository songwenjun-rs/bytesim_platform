/**
 * XAxis / YAxis SVG primitives. Caller passes a Scale + tick array;
 * components draw the line, tick marks, and labels in dark-mode-aware colors.
 */
import type { Scale } from "./scale";

type Common = {
  scale: Scale;
  ticks: number[];
  format?: (v: number) => string;
  /** Pixel coords for the area the axis spans (relative to chart canvas). */
  pixelStart: number;
  pixelEnd: number;
};

export function XAxis({
  scale, ticks, format = String, y, pixelStart, pixelEnd,
  label,
}: Common & { y: number; label?: string }) {
  return (
    <g>
      <line x1={pixelStart} y1={y} x2={pixelEnd} y2={y} stroke="var(--hairline)" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={scale(t)} y1={y} x2={scale(t)} y2={y + 4} stroke="var(--t4)" />
          <text
            x={scale(t)} y={y + 16}
            fontSize={10} fill="var(--t3)" textAnchor="middle"
          >{format(t)}</text>
        </g>
      ))}
      {label && (
        <text
          x={(pixelStart + pixelEnd) / 2} y={y + 32}
          fontSize={10} fill="var(--t3)" textAnchor="middle"
        >{label}</text>
      )}
    </g>
  );
}

export function YAxis({
  scale, ticks, format = String, x, pixelStart, pixelEnd,
  label, gridWidth,
}: Common & { x: number; label?: string; gridWidth?: number }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          {gridWidth && gridWidth > 0 && (
            <line
              x1={x} y1={scale(t)}
              x2={x + gridWidth} y2={scale(t)}
              stroke="var(--hairline)"
            />
          )}
          <line x1={x - 4} y1={scale(t)} x2={x} y2={scale(t)} stroke="var(--t4)" />
          <text
            x={x - 8} y={scale(t) + 3}
            fontSize={10} fill="var(--t3)" textAnchor="end"
          >{format(t)}</text>
        </g>
      ))}
      {label && (
        <text
          x={12} y={(pixelStart + pixelEnd) / 2}
          fontSize={10} fill="var(--t3)" textAnchor="middle"
          transform={`rotate(-90 12 ${(pixelStart + pixelEnd) / 2})`}
        >{label}</text>
      )}
    </g>
  );
}
