import type { Run } from "../../api/runs";
import { getPhaseBreakdown } from "../../api/runs";

/**
 * S4.2 — Horizontal stacked-bar of where step_ms went.
 *
 * `phase_breakdown` comes from the engine; for surrogate today it's the
 * 4-bucket breakdown (compute/comm/mem_stall/idle) re-shaped as a list.
 * Engines with finer traces (astra-sim) will surface attn / ffn /
 * comm_tp / etc. The chart copes with whatever phase strings come back —
 * unknown phases get a fallback color.
 *
 * Why a single stacked bar (not pie / multi-bar): step_ms IS one whole;
 * the architect wants to see "where did my 500ms go" relative to a known
 * total. A stacked bar makes the total visible AND each slice's share.
 */

const PHASE_COLOR: Record<string, string> = {
  compute:   "var(--teal)",
  attn:      "var(--teal)",
  ffn:       "var(--blue)",
  comm:      "var(--orange)",
  comm_tp:   "var(--orange)",
  comm_pp:   "var(--orange)",
  comm_ep:   "var(--purple)",
  mem_stall: "var(--purple)",
  idle:      "var(--t4)",
};
const FALLBACK_COLOR = "var(--t4)";

const PHASE_LABEL: Record<string, string> = {
  compute:   "计算",
  attn:      "Attention",
  ffn:       "FFN",
  comm:      "通信",
  comm_tp:   "TP 通信",
  comm_pp:   "PP 通信",
  comm_ep:   "EP 通信",
  mem_stall: "显存等待",
  idle:      "PP 气泡",
};

function colorFor(phase: string): string {
  return PHASE_COLOR[phase] ?? FALLBACK_COLOR;
}

function labelFor(phase: string): string {
  return PHASE_LABEL[phase] ?? phase;
}

export function PhaseBreakdownBar({ run }: { run: Run }) {
  const phases = getPhaseBreakdown(run);

  if (!phases || phases.length === 0) {
    return null;  // No breakdown ⇒ render nothing; do not show empty card
  }

  const total = phases.reduce((a, p) => a + Math.max(0, p.ms), 0);
  if (total <= 0) return null;

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="phase-breakdown">
      <div className="card-head">
        <div className="card-t">单步耗时分解</div>
        <div className="card-x">
          总 {total.toFixed(1)} ms · {phases.length} 阶段
        </div>
      </div>

      <div
        style={{
          display: "flex",
          width: "100%",
          height: 28,
          borderRadius: 4,
          overflow: "hidden",
          border: "1px solid var(--hairline)",
        }}
      >
        {phases.map((p) => {
          const pct = (Math.max(0, p.ms) / total) * 100;
          if (pct < 0.1) return null;  // Hide invisibly-thin slices
          return (
            <div
              key={p.phase}
              data-testid={`phase-slice-${p.phase}`}
              data-pct={pct.toFixed(2)}
              title={`${labelFor(p.phase)} · ${p.ms.toFixed(1)} ms · ${pct.toFixed(1)}%`}
              style={{
                width: `${pct}%`,
                background: colorFor(p.phase),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10.5,
                color: "rgba(0,0,0,0.7)",
                fontWeight: 600,
                overflow: "hidden",
                whiteSpace: "nowrap",
              }}
            >
              {pct >= 8 ? `${pct.toFixed(0)}%` : ""}
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 10,
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          fontSize: 11,
          color: "var(--t3)",
        }}
        data-testid="phase-legend"
      >
        {phases.map((p) => (
          <div key={p.phase} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              width: 10, height: 10, borderRadius: 2,
              background: colorFor(p.phase), display: "inline-block",
            }} />
            <span>{labelFor(p.phase)}</span>
            <span className="mono" style={{ color: "var(--t2)" }}>
              {p.ms.toFixed(1)}ms
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
