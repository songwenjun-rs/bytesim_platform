import type { Run } from "../../api/runs";

/**
 * S4.2 — KV cache health dashboard for inference runs.
 *
 * Three numbers the architect cares about, sourced from
 * `EnginePredictResponse` and now forwarded by engine-svc into run.kpis:
 *
 *   - kv_hit_rate (0..1)        — cached/total. >0.85 healthy chat.
 *   - cache_pressure_pct        — working_set / HBM. >100 ⇒ spilling.
 *   - spill_bytes_per_s         — bytes leaving HBM per second.
 *
 * Render each as a labeled bar with thresholds the surrogate's docstrings
 * encode (≥100% pressure ⇒ spill, hit rate <0.6 ⇒ poor batch behavior).
 * Hides itself entirely when no KV fields are present (training runs).
 */

type KvSnapshot = {
  hitRate: number | null;
  pressurePct: number | null;
  spillBps: number | null;
};

function readKv(run: Run): KvSnapshot {
  const k = run.kpis as unknown as Record<string, unknown> | undefined;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    hitRate: num(k?.kv_hit_rate),
    pressurePct: num(k?.cache_pressure_pct),
    spillBps: num(k?.spill_bytes_per_s),
  };
}

function fmtBytes(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function severityFromHitRate(r: number): "high" | "med" | "low" {
  if (r < 0.5) return "high";   // poor — engine effectively can't share KV
  if (r < 0.75) return "med";   // ok-ish
  return "low";                 // healthy
}
function severityFromPressure(p: number): "high" | "med" | "low" {
  if (p >= 100) return "high";  // spilling
  if (p >= 80)  return "med";   // close to limit
  return "low";
}
function severityFromSpill(bps: number): "high" | "med" | "low" {
  if (bps >= 1e9) return "high";
  if (bps > 0)    return "med";
  return "low";
}

const SEV_COLOR: Record<"high" | "med" | "low", string> = {
  high: "var(--red)",
  med:  "var(--orange)",
  low:  "var(--green)",
};

export function KvPressureCard({ run }: { run: Run }) {
  const kv = readKv(run);

  // Hide for runs with no KV signal — typically training runs without
  // kvcache_config. Avoid rendering a blank card.
  if (kv.hitRate === null && kv.pressurePct === null && kv.spillBps === null) {
    return null;
  }

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="kv-pressure">
      <div className="card-head">
        <div className="card-t">KV Cache 健康度</div>
        <div className="card-x">推理工作负载</div>
      </div>

      <div className="grid g3" style={{ gap: 12 }}>
        {kv.hitRate !== null && (
          <KvMetric
            label="命中率"
            unit=""
            value={`${(kv.hitRate * 100).toFixed(1)}%`}
            barPct={kv.hitRate * 100}
            barMaxPct={100}
            severity={severityFromHitRate(kv.hitRate)}
            hint={kv.hitRate >= 0.75 ? "健康（chat 类负载典型）" : "较低（接近批量推理）"}
            testId="kv-hit-rate"
          />
        )}
        {kv.pressurePct !== null && (
          <KvMetric
            label="工作集占 HBM"
            unit=""
            value={`${kv.pressurePct.toFixed(0)}%`}
            barPct={Math.min(150, kv.pressurePct)}
            barMaxPct={150}
            severity={severityFromPressure(kv.pressurePct)}
            hint={
              kv.pressurePct >= 100
                ? "超出 HBM，需 spill 到下层"
                : kv.pressurePct >= 80
                ? "接近上限，关注 spill 风险"
                : "舒适区"
            }
            redLine={100}
            testId="kv-pressure-pct"
          />
        )}
        {kv.spillBps !== null && (
          <KvMetric
            label="Spill 速率"
            unit=""
            value={fmtBytes(kv.spillBps)}
            barPct={kv.spillBps > 0 ? Math.min(100, Math.log10(kv.spillBps + 1) * 10) : 0}
            barMaxPct={100}
            severity={severityFromSpill(kv.spillBps)}
            hint={
              kv.spillBps >= 1e9
                ? "高 spill — 显存能力不足"
                : kv.spillBps > 0
                ? "有 spill，关注延迟"
                : "无 spill"
            }
            testId="kv-spill-bps"
          />
        )}
      </div>
    </div>
  );
}

function KvMetric({
  label, value, unit, barPct, barMaxPct, severity, hint, redLine, testId,
}: {
  label: string;
  value: string;
  unit: string;
  barPct: number;
  barMaxPct: number;
  severity: "high" | "med" | "low";
  hint: string;
  redLine?: number;
  testId: string;
}) {
  const widthPct = (barPct / barMaxPct) * 100;
  return (
    <div data-testid={testId} data-severity={severity}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "var(--t3)" }}>{label}</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: SEV_COLOR[severity] }}>
          {value}<span style={{ fontSize: 11, color: "var(--t3)" }}>{unit}</span>
        </span>
      </div>
      <div
        style={{
          position: "relative",
          height: 8,
          background: "var(--surface-2)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${widthPct}%`,
            height: "100%",
            background: SEV_COLOR[severity],
            transition: "width 240ms ease-out",
          }}
        />
        {redLine !== undefined && (
          <div
            data-testid={`${testId}-redline`}
            style={{
              position: "absolute",
              top: 0, bottom: 0,
              left: `${(redLine / barMaxPct) * 100}%`,
              width: 1.5,
              background: "var(--red)",
              opacity: 0.7,
            }}
            title={`阈值 ${redLine}%`}
          />
        )}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--t3)", marginTop: 4 }}>{hint}</div>
    </div>
  );
}
