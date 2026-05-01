/**
 * Radar chart for the Comparator — single-Run multi-dimensional profile.
 *
 * Complements ParallelCoordinates: the parallel view shows axis-by-axis
 * trade-offs across many runs; the radar view shows the "shape" of one
 * run vs another. A round polygon = balanced profile; a spike → one
 * dimension dominates. Useful for "DeepSeek-V3 has good MFU but is hot
 * on power" kind of holistic reads.
 *
 * Direction-normalized so the outer edge of every axis is "better".
 * min-direction KPIs (cost, latency, kW) are inverted before plotting,
 * matching the ParallelCoordinates convention.
 *
 * Pure SVG, no chart library. Cap at 6 simultaneous polygons before
 * the visual gets unreadable; sort recommended last so it draws on top.
 */
import type { Run } from "../../api/runs";

type PlanSlot = {
  slot: string;
  run_id: string;
  added_at: string;
  run?: Run;
};

type Axis = {
  key: string;
  label: string;
  dir: "max" | "min";
  fallbackRange: [number, number];
  /** Read from Run.confidence rather than Run.kpis. */
  fromTopLevel?: boolean;
};

const AXES: Axis[] = [
  { key: "mfu_pct",             label: "MFU",       dir: "max", fallbackRange: [0, 100] },
  { key: "cost_per_m_tok_usd",  label: "成本",      dir: "min", fallbackRange: [0, 1] },
  { key: "ttft_p99_ms",         label: "TTFT",      dir: "min", fallbackRange: [0, 300] },
  { key: "peak_kw",             label: "kW",        dir: "min", fallbackRange: [0, 1000] },
  { key: "confidence",          label: "置信",      dir: "max", fallbackRange: [0, 1],
    fromTopLevel: true },
];

const MAX_POLYGONS = 6;

const SLOT_COLORS = [
  "#7ab8ff", "#ffb854", "#7cdf90", "#d49bf7",
  "#8fe1ff", "#ff7a70", "#f5d76e", "#a3a3a3",
];

const W = 360;
const H = 320;
const CX = W / 2;
const CY = H / 2 + 6;
const R = 110;

function getKpi(s: PlanSlot, axis: Axis): number | undefined {
  if (axis.fromTopLevel) {
    return s.run?.confidence ?? undefined;
  }
  const k = (s.run?.kpis ?? {}) as Record<string, number>;
  const v = k[axis.key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function axisRange(slots: PlanSlot[], axis: Axis): [number, number] {
  const vals = slots
    .map((s) => getKpi(s, axis))
    .filter((v): v is number => typeof v === "number");
  if (vals.length === 0) return axis.fallbackRange;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) {
    const pad = Math.max(Math.abs(lo) * 0.1, 1);
    lo -= pad; hi += pad;
  }
  return [lo, hi];
}

function score(v: number, axis: Axis, range: [number, number]): number {
  const [lo, hi] = range;
  const t = (v - lo) / (hi - lo);
  return axis.dir === "max" ? t : 1 - t;
}

/** Vertex i around the radar. i=0 at top, clockwise. */
function vertex(i: number, length: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + i * (2 * Math.PI / AXES.length);
  return {
    x: CX + length * Math.cos(angle),
    y: CY + length * Math.sin(angle),
  };
}

export function RadarChart({
  slots, recommendedRunId,
}: {
  slots: PlanSlot[];
  recommendedRunId?: string | null;
}) {
  if (slots.length === 0) return null;

  const ranges = AXES.map((a) => axisRange(slots, a));
  const drawn = slots.slice(0, MAX_POLYGONS);

  // Sort recommended to last so it renders on top.
  const ordered = [...drawn].sort((a, b) => {
    const ar = a.run_id === recommendedRunId ? 1 : 0;
    const br = b.run_id === recommendedRunId ? 1 : 0;
    return ar - br;
  });

  return (
    <div
      className="card"
      style={{ marginBottom: 14 }}
      data-testid="radar-chart"
    >
      <div className="card-head">
        <div className="card-t">多维画像</div>
        <div className="card-x">
          {drawn.length}/{slots.length} 方案 · {AXES.length} 维 · 外圈 = 越好
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: "60%", height: H }}
          aria-label="radar chart of plan slots"
        >
          {/* Concentric grid rings (0.25 .. 1.0) */}
          {[0.25, 0.5, 0.75, 1].map((r) => (
            <polygon
              key={r}
              points={AXES.map((_, i) => {
                const v = vertex(i, R * r);
                return `${v.x},${v.y}`;
              }).join(" ")}
              fill="none"
              stroke="var(--hairline)"
              strokeWidth={r === 1 ? 1.5 : 0.6}
            />
          ))}

          {/* Spokes */}
          {AXES.map((_, i) => {
            const tip = vertex(i, R);
            return (
              <line
                key={i}
                x1={CX} y1={CY} x2={tip.x} y2={tip.y}
                stroke="var(--hairline)"
                strokeWidth={0.6}
              />
            );
          })}

          {/* Axis labels */}
          {AXES.map((a, i) => {
            const tip = vertex(i, R + 16);
            return (
              <text
                key={a.key}
                x={tip.x} y={tip.y}
                fontSize={11} fontWeight={600}
                fill="var(--t2)"
                textAnchor="middle"
                dominantBaseline="central"
              >
                {a.label}
              </text>
            );
          })}

          {/* Polygons per slot */}
          {ordered.map((s) => {
            const isRec = s.run_id === recommendedRunId;
            const colorIdx = drawn.findIndex((q) => q.slot === s.slot);
            const color = SLOT_COLORS[colorIdx % SLOT_COLORS.length];
            // Build the polygon — only include vertices we have data for.
            // Missing axes collapse to 0 (center) so an incomplete profile
            // visually deflates, distinguishing it from a balanced one.
            const points = AXES.map((a, i) => {
              const v = getKpi(s, a);
              const sc = v != null ? score(v, a, ranges[i]) : 0;
              const clamped = Math.max(0, Math.min(1, sc));
              const vert = vertex(i, R * clamped);
              return `${vert.x},${vert.y}`;
            }).join(" ");
            return (
              <polygon
                key={s.slot}
                data-testid={`radar-polygon-${s.slot}`}
                data-recommended={isRec || undefined}
                points={points}
                fill={color}
                fillOpacity={isRec ? 0.32 : 0.18}
                stroke={color}
                strokeWidth={isRec ? 2.5 : 1.5}
                strokeOpacity={isRec ? 1 : 0.7}
              >
                <title>{`${s.slot}${isRec ? " · 推荐" : ""} · ${s.run_id}`}</title>
              </polygon>
            );
          })}
        </svg>

        <div
          style={{
            flex: 1, display: "flex", flexDirection: "column", gap: 6,
            fontSize: 11,
          }}
          data-testid="radar-legend"
        >
          {drawn.map((s, i) => {
            const color = SLOT_COLORS[i % SLOT_COLORS.length];
            const isRec = s.run_id === recommendedRunId;
            return (
              <div
                key={s.slot}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
                data-testid={`radar-legend-${s.slot}`}
              >
                <span style={{
                  width: 12, height: 12, borderRadius: 2,
                  background: color, opacity: isRec ? 1 : 0.7,
                  display: "inline-block",
                }} />
                <span style={{
                  color: isRec ? "var(--t1)" : "var(--t3)",
                  fontWeight: isRec ? 600 : 400,
                  whiteSpace: "nowrap", overflow: "hidden",
                  textOverflow: "ellipsis", maxWidth: 140,
                }}>
                  {s.slot}{isRec && " ★"}
                </span>
              </div>
            );
          })}
          {slots.length > MAX_POLYGONS && (
            <div style={{ color: "var(--t4)", fontSize: 10 }}>
              + {slots.length - MAX_POLYGONS} 方案未画 · 见对比表
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
