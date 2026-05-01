/**
 * Scale primitives — pure functions, no React. Each returns
 * `(domainValue) => pixel`. Used by Axis + Series for consistent mapping.
 */

export type Scale = (v: number) => number;

export type Range = { min: number; max: number };

export function rangeOf(values: number[], pad = 0): Range {
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { min: min - 1, max: max + 1 };
  const span = max - min;
  return { min: min - span * pad, max: max + span * pad };
}

export function linearScale(domain: Range, pixelRange: [number, number]): Scale {
  const [a, b] = pixelRange;
  const span = Math.max(domain.max - domain.min, 1e-12);
  return (v: number) => a + ((v - domain.min) / span) * (b - a);
}

/** Same shape as linearScale but the min is forced to 0 — useful for
 *  count-like KPIs where bars below baseline are meaningless. */
export function linearScaleFromZero(maxValue: number, pixelRange: [number, number]): Scale {
  return linearScale({ min: 0, max: Math.max(maxValue, 1e-9) }, pixelRange);
}

/**
 * "Nice" tick generator. Pick ~targetCount evenly-spaced values over
 * [min, max], snapping to powers of 10/5/2 so labels read cleanly.
 */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (max <= min) return [min];
  const span = max - min;
  const roughStep = span / Math.max(targetCount - 1, 1);
  const exp = Math.floor(Math.log10(roughStep));
  const base = Math.pow(10, exp);
  const candidates = [1, 2, 2.5, 5, 10];
  const step = candidates.map((c) => c * base).find((s) => s >= roughStep) ?? base * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) {
    out.push(Number(v.toFixed(12)));    // kill float noise
  }
  return out;
}

/** Time-axis ticks: pick the most-natural granularity for the given window. */
export function timeTicks(minMs: number, maxMs: number, targetCount = 5): number[] {
  if (maxMs <= minMs) return [minMs];
  const span = maxMs - minMs;
  // Choose step from a fixed list of "nice" durations
  const HOUR = 3600_000;
  const steps = [
    HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
    24 * HOUR, 2 * 24 * HOUR, 7 * 24 * HOUR,
  ];
  const roughStep = span / Math.max(targetCount - 1, 1);
  const step = steps.find((s) => s >= roughStep) ?? steps[steps.length - 1];
  const start = Math.ceil(minMs / step) * step;
  const out: number[] = [];
  for (let v = start; v <= maxMs + step * 0.5; v += step) out.push(v);
  return out;
}
