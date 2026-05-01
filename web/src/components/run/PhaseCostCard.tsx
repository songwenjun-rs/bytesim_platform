/**
 * S4.4 — Per-phase cost attribution.
 *
 * `phase_breakdown` already tells us where step_ms went; `useRunTco`
 * tells us the total cost. This card multiplies them: cost-per-phase =
 * total × (phase.ms / Σms). Answers "if I optimize comm, how many
 * dollars do I save".
 *
 * Pricing assumption baked in: time-share is a fair proxy for
 * cost-share when GPUs are the dominant resource. That's true for the
 * surrogate-driven runs ByteSim primarily handles. If a run's TCO has
 * heavy network/storage components (rare), the time-share allocation
 * over-attributes those buckets to compute phases — the card surfaces
 * total agreement with TcoSummaryCard and lets the architect drill in
 * via the anchor. Future S4.5 may swap in resource-aware allocation.
 */
import { useRunTco } from "../../api/tco";
import { getPhaseBreakdown } from "../../api/runs";
import type { Run } from "../../api/runs";

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

const colorFor = (p: string) => PHASE_COLOR[p] ?? FALLBACK_COLOR;
const labelFor = (p: string) => PHASE_LABEL[p] ?? p;

export function PhaseCostCard({ run }: { run: Run }) {
  const phases = getPhaseBreakdown(run);
  const { data: tco } = useRunTco(run.id);

  // Both signals required. Either missing ⇒ skip silently. The
  // PhaseBreakdownBar above us already shows the time view; the
  // TcoSummaryCard below shows the bucket view. This card is the
  // bridge — only valuable when we have both.
  if (!phases || phases.length === 0) return null;
  if (!tco || tco.total_usd <= 0) return null;

  const totalMs = phases.reduce((a, p) => a + Math.max(0, p.ms), 0);
  if (totalMs <= 0) return null;

  const total = tco.total_usd;

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="phase-cost-card">
      <div className="card-head">
        <div className="card-t">阶段成本分摊</div>
        <div className="card-x">
          按时间占比映射 · 总 ${total.toLocaleString()}
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
          const ratio = Math.max(0, p.ms) / totalMs;
          const pct = ratio * 100;
          if (pct < 0.1) return null;
          const dollars = total * ratio;
          return (
            <div
              key={p.phase}
              data-testid={`phase-cost-slice-${p.phase}`}
              data-pct={pct.toFixed(2)}
              data-usd={dollars.toFixed(4)}
              title={`${labelFor(p.phase)} · $${dollars.toFixed(2)} (${pct.toFixed(1)}%)`}
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
              {pct >= 12 ? `$${dollars.toFixed(2)}` : ""}
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 10,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 8,
          fontSize: 11,
          color: "var(--t3)",
        }}
        data-testid="phase-cost-legend"
      >
        {phases.map((p) => {
          const ratio = Math.max(0, p.ms) / totalMs;
          const dollars = total * ratio;
          return (
            <div
              key={p.phase}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
              data-testid={`phase-cost-row-${p.phase}`}
            >
              <span style={{
                width: 10, height: 10, borderRadius: 2,
                background: colorFor(p.phase), display: "inline-block",
              }} />
              <span style={{ flex: 1 }}>{labelFor(p.phase)}</span>
              <span className="mono" style={{ color: "var(--t1)" }}>
                ${dollars.toFixed(2)}
              </span>
              <span className="mono" style={{ color: "var(--t3)", minWidth: 36, textAlign: "right" }}>
                {(ratio * 100).toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
