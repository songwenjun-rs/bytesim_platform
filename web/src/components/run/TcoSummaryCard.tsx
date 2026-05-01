/**
 * S4.3 — Top-of-RunDetail TCO summary card.
 *
 * The full TcoBreakdown card lives near the bottom of the page; on first
 * visit the architect scrolls past KPIs / bottleneck / phase chart before
 * even seeing cost composition. This compact card surfaces the headlines
 * up top:
 *
 *   - per-Mtoken price (the operational decision input)
 *   - top contributor (the one bucket worth optimizing first)
 *   - a thin 6-segment bar so the eye sees the shape of cost
 *
 * Clicking the bar / "完整拆解 →" link anchors to the full TcoBreakdown
 * (id="tco-breakdown") so we don't render two big charts.
 */
import { useRunTco, type TcoBreakdown } from "../../api/tco";

const BUCKETS: { key: keyof TcoBreakdown; label: string; color: string }[] = [
  { key: "hw_capex_amortized_usd", label: "硬件 CapEx", color: "var(--blue)" },
  { key: "power_opex_usd",         label: "电力",        color: "var(--orange)" },
  { key: "cooling_opex_usd",       label: "冷却",        color: "var(--teal)" },
  { key: "network_opex_usd",       label: "网络",        color: "var(--purple)" },
  { key: "storage_opex_usd",       label: "存储",        color: "var(--indigo)" },
  { key: "failure_penalty_usd",    label: "故障惩罚",    color: "var(--red)" },
];

function topContributor(tco: TcoBreakdown): { label: string; pct: number } | null {
  const total = tco.total_usd;
  if (total <= 0) return null;
  let best = { label: "—", pct: 0 };
  for (const b of BUCKETS) {
    const v = (tco[b.key] as number) ?? 0;
    const pct = (v / total) * 100;
    if (pct > best.pct) best = { label: b.label, pct };
  }
  return best;
}

export function TcoSummaryCard({ runId }: { runId: string }) {
  const { data, isLoading, error } = useRunTco(runId);

  // 404 / error / no data → silently skip. Don't compete with the full
  // TcoBreakdown's "no data" message at the bottom.
  if (isLoading) return null;
  if (error || !data) return null;
  if (data.total_usd <= 0) return null;

  const top = topContributor(data);

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="tco-summary-card">
      <div className="card-head">
        <div className="card-t">成本概览</div>
        <div className="card-x">
          <a
            href="#tco-breakdown"
            data-testid="tco-summary-link"
            style={{ fontSize: 11 }}
          >
            完整拆解 ↓
          </a>
        </div>
      </div>

      {/* Headline metrics row: top contributor + per-Mtoken + total */}
      <div
        className="grid g3"
        style={{ marginBottom: 12 }}
        data-testid="tco-summary-metrics"
      >
        <Metric
          label="顶部贡献"
          value={top ? `${top.label} · ${top.pct.toFixed(0)}%` : "—"}
          accent="var(--orange)"
          testId="tco-top-contributor"
        />
        <Metric
          label="每百万 Token"
          value={data.per_m_token_usd != null
            ? `$${data.per_m_token_usd.toFixed(4)}`
            : "—"}
          accent="var(--t1)"
          testId="tco-per-mtoken"
        />
        <Metric
          label="边际总成本"
          value={`$${data.total_usd.toLocaleString()}`}
          accent="var(--t1)"
          testId="tco-total"
        />
      </div>

      {/* Compact stacked bar — same color scale as TcoBreakdown so visual
          continuity holds. Thin (10px) to keep the card glanceable. */}
      <div
        style={{
          display: "flex", height: 10, borderRadius: 5, overflow: "hidden",
          border: "1px solid var(--hairline)",
        }}
        data-testid="tco-summary-bar"
      >
        {BUCKETS.map((b) => {
          const v = (data[b.key] as number) ?? 0;
          const pct = (v / data.total_usd) * 100;
          if (pct < 0.1) return null;
          return (
            <div
              key={b.key}
              data-testid={`tco-segment-${b.key}`}
              data-pct={pct.toFixed(2)}
              style={{ width: `${pct}%`, background: b.color }}
              title={`${b.label}: $${v.toFixed(2)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
    </div>
  );
}

function Metric({
  label, value, accent, testId,
}: { label: string; value: string; accent: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <div style={{ fontSize: 11, color: "var(--t3)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: accent }}>{value}</div>
    </div>
  );
}
