/**
 * Color scales used across viz. Reuses CSS tokens from styles/tokens.css so
 * dark/light mode (when added) flows through.
 */

/** 4-step utilization (green → red) — used by FabricView, heatmaps. */
export function utilizationColor(pct: number): string {
  if (pct >= 80) return "var(--red)";
  if (pct >= 60) return "var(--orange)";
  if (pct >= 40) return "var(--teal)";
  return "var(--green)";
}

/** 3-step MAPE (green = good ≤ 5%, orange ≤ 10%, red > 10%). */
export function mapeColor(mape: number): string {
  if (mape <= 5) return "var(--green)";
  if (mape <= 10) return "var(--orange)";
  return "var(--red)";
}

/**
 * 5-step sequential scale (light → dark). For continuous heatmaps where
 * "more = darker". Returns inline rgba; 0 = empty, 1 = saturated.
 */
export function sequentialColor(t: number): string {
  // Clamp + apply gentle gamma for perceptual evenness
  const v = Math.max(0, Math.min(1, t));
  const eased = Math.pow(v, 0.7);
  // Teal ramp: low = subtle, high = saturated teal-blue
  const r = Math.round(20 + (10 - 20) * eased);
  const g = Math.round(40 + (132 - 40) * eased);
  const b = Math.round(60 + (255 - 60) * eased);
  const a = 0.15 + 0.6 * eased;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Categorical 8-color palette for series legends. Cycles for >8. */
const CATEGORICAL = [
  "var(--blue)", "var(--green)", "var(--orange)",
  "var(--purple)", "var(--teal)", "var(--pink)",
  "var(--yellow)", "var(--indigo)",
];
export function categoricalColor(i: number): string {
  return CATEGORICAL[i % CATEGORICAL.length];
}
