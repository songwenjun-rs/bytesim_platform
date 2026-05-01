/**
 * L1.2 — Visualize KV cache working-set vs total HBM.
 *
 * KV cache parameters (avg_active_seqs × kv_size_gb_per_seq) are abstract
 * numbers in the InferenceSim form; the architect doesn't know whether
 * "256 active × 0.020 GB = 5.1 GB" is a problem until they cross-check
 * against the cluster's HBM ceiling. This bar makes that check visual:
 *
 *   [████████  used GB  ][ free  ]│        100% red line
 *                                ^ where the working set crosses HBM
 *
 * Color tracks severity (green / orange / red) using the same thresholds
 * as constraints.ts checkKvWorkingSet so the bar and the constraints
 * panel agree on what "near limit" means.
 */
import { gpuFacts } from "./constraints";

type Props = {
  gpu_model: string;
  gpu_count: number;
  avg_active_seqs: number;
  kv_size_gb_per_seq: number;
};

const LIMIT_PCT = 100;       // red line
const SQUEEZE_PCT = 80;      // orange threshold (matches constraints rule)

export function KvFootprintBar({
  gpu_model, gpu_count, avg_active_seqs, kv_size_gb_per_seq,
}: Props) {
  const totalHbm = gpu_count * gpuFacts(gpu_model).hbm_gb;
  const usedGb = avg_active_seqs * kv_size_gb_per_seq;

  if (totalHbm <= 0) return null;  // mid-edit, gpu_count = 0 etc.

  const pct = (usedGb / totalHbm) * 100;
  // Bar can extend up to 150% so over-allocation is visually obvious
  // without an absurd horizontal stretch.
  const displayMax = 150;
  const usedDisplayPct = Math.min(pct, displayMax);
  const usedColor =
    pct >= LIMIT_PCT ? "var(--red)"
    : pct >= SQUEEZE_PCT ? "var(--orange)"
    : "var(--teal)";

  const status: "ok" | "warn" | "fail" =
    pct >= LIMIT_PCT ? "fail"
    : pct >= SQUEEZE_PCT ? "warn"
    : "ok";

  return (
    <div
      className="card"
      style={{ marginBottom: 14 }}
      data-testid="kv-footprint-bar"
      data-status={status}
    >
      <div className="card-head">
        <div className="card-t">KV 工作集 vs HBM</div>
        <div className="card-x">
          <span className="mono" style={{ color: usedColor, fontWeight: 600 }}>
            {usedGb.toFixed(0)} / {totalHbm.toFixed(0)} GB
          </span>
          <span style={{ color: "var(--t3)", marginLeft: 8 }}>
            ({pct.toFixed(0)}%)
          </span>
        </div>
      </div>

      <div
        style={{
          position: "relative",
          height: 22,
          borderRadius: 4,
          background: "var(--surface-2)",
          border: "1px solid var(--hairline)",
          overflow: "hidden",
        }}
        data-testid="kv-footprint-bar-rail"
      >
        {/* Used portion */}
        <div
          data-testid="kv-footprint-used"
          data-pct={pct.toFixed(2)}
          style={{
            position: "absolute", top: 0, bottom: 0, left: 0,
            width: `${(usedDisplayPct / displayMax) * 100}%`,
            background: usedColor,
            transition: "width 200ms ease-out, background 200ms",
          }}
        />
        {/* 100% red line marker */}
        <div
          data-testid="kv-footprint-redline"
          style={{
            position: "absolute", top: -2, bottom: -2,
            left: `${(LIMIT_PCT / displayMax) * 100}%`,
            width: 2, background: "var(--red)",
          }}
          title="100% HBM 上限"
        />
        {/* 80% squeeze line marker */}
        <div
          style={{
            position: "absolute", top: 0, bottom: 0,
            left: `${(SQUEEZE_PCT / displayMax) * 100}%`,
            width: 1, background: "var(--orange)", opacity: 0.6,
          }}
          title="80% 安全阈值"
        />
      </div>

      <div style={{
        marginTop: 6, fontSize: 11, color: "var(--t3)",
        display: "flex", justifyContent: "space-between",
      }}>
        <span>0</span>
        <span style={{ color: "var(--orange)" }}>80% 安全</span>
        <span style={{ color: "var(--red)" }}>100% HBM</span>
        <span>150%</span>
      </div>

      <div
        style={{ marginTop: 6, fontSize: 11, color: "var(--t3)" }}
        data-testid="kv-footprint-hint"
      >
        {avg_active_seqs} 活跃 seq × {kv_size_gb_per_seq.toFixed(3)} GB ={" "}
        <span className="mono" style={{ color: "var(--t2)" }}>
          {usedGb.toFixed(1)} GB
        </span>{" "}
        on {gpu_count}× {gpu_model} (
        <span className="mono">{gpuFacts(gpu_model).hbm_gb} GB / GPU</span>)
      </div>
    </div>
  );
}
