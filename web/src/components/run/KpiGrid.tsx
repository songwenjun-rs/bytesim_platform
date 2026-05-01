import type { Run } from "../../api/runs";

type KpiSpec = { key: string; label: string; unit?: string; fmt?: (n: number) => string };

const TRAIN_KPIS: KpiSpec[] = [
  { key: "mfu_pct", label: "MFU", unit: " %" },
  { key: "step_ms", label: "单步耗时", fmt: (n) => `${(n / 1000).toFixed(2)} s` },
  { key: "cost_per_m_tok_usd", label: "每百万 Token 成本", fmt: (n) => `$${n.toFixed(2)}` },
  { key: "train_days", label: "端到端训练天数", unit: " 天" },
];

const INFER_KPIS: KpiSpec[] = [
  { key: "ttft_ms", label: "TTFT", unit: " ms" },
  { key: "tpot_ms", label: "TPOT", unit: " ms" },
  { key: "qps_at_slo", label: "QPS @ SLO", unit: " req/s" },
  { key: "cost_per_m_tok_usd", label: "每百万 Token 成本", fmt: (n) => `$${n.toFixed(2)}` },
];

const TCO_KPIS: KpiSpec[] = [
  { key: "five_year_opex_musd", label: "5 年运营成本估算", fmt: (n) => `$${n.toFixed(1)}M` },
];

function pickKpis(kind: Run["kind"]): KpiSpec[] {
  switch (kind) {
    case "infer": return INFER_KPIS;
    case "tco":   return TCO_KPIS;
    default:      return TRAIN_KPIS;
  }
}

export function KpiGrid({ run }: { run: Run }) {
  const specs = pickKpis(run.kind);
  return (
    <div className="grid g4" style={{ marginBottom: 14 }}>
      {specs.map((s) => {
        const raw = run.kpis[s.key];
        const display = raw == null
          ? "—"
          : (s.fmt ? s.fmt(raw) : raw.toString());
        return (
          <div className="card kpi" key={s.key}>
            <div className="kpi-lab">{s.label}</div>
            <div className="kpi-val">
              {display}
              {raw != null && s.unit && !s.fmt && (
                <span style={{ fontSize: 13, color: "var(--t3)" }}>{s.unit}</span>
              )}
            </div>
            <div className="kpi-delta">{raw == null ? "尚无数据" : "来自 result.json"}</div>
          </div>
        );
      })}
    </div>
  );
}
