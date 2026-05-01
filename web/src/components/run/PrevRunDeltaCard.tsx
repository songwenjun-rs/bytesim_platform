/**
 * S4.6 — KPI delta vs the previous run on the same hwspec.
 *
 * The architect's iteration loop is "tweak → submit → check vs previous".
 * Without delta context the architect has to remember (or re-open) the
 * previous run's numbers to know if this round improved things. This
 * card lifts the comparison automatically:
 *
 *   ΔMFU = +2.5pp ↑   Δstep = -120ms ↓   ΔTTFT = +5ms ↑(bad)
 *
 * Direction-aware coloring: max-direction KPIs (MFU, confidence) green
 * when up, min-direction (step_ms, TTFT, peak_kw, cost) green when down.
 *
 * Source of "previous run": local recentRuns ring (S6.7). Filter by
 * hwspecId match, exclude the current run, take newest. Loads that
 * run's full payload via useRunFull and computes delta in JS.
 */
import { Link } from "react-router-dom";
import { useRunFull } from "../../api/runs";
import type { Run } from "../../api/runs";
import { readRecentRuns } from "../sim/recentRuns";

type FieldDir = "max" | "min";
type Field = {
  key: string;
  label: string;
  dir: FieldDir;
  fmt: (v: number) => string;
  /** Custom delta formatter (e.g. "+2.5pp" instead of percentage). */
  fmtDelta?: (delta: number) => string;
  /** Read confidence from Run.confidence (top-level), not kpis. */
  fromTopLevel?: boolean;
};

const TRAIN_FIELDS: Field[] = [
  { key: "mfu_pct", label: "MFU", dir: "max",
    fmt: (v) => `${v.toFixed(1)}%`,
    fmtDelta: (d) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}pp` },
  { key: "step_ms", label: "step", dir: "min",
    fmt: (v) => `${(v / 1000).toFixed(2)}s`,
    fmtDelta: (d) => `${d >= 0 ? "+" : ""}${(d / 1000).toFixed(2)}s` },
  { key: "peak_kw", label: "kW", dir: "min",
    fmt: (v) => `${v.toFixed(0)}kW`,
    fmtDelta: (d) => `${d >= 0 ? "+" : ""}${d.toFixed(0)}kW` },
  { key: "confidence", label: "conf", dir: "max", fromTopLevel: true,
    fmt: (v) => v.toFixed(2),
    fmtDelta: (d) => `${d >= 0 ? "+" : ""}${d.toFixed(2)}` },
];

const INFER_FIELDS: Field[] = [
  { key: "ttft_p99_ms", label: "TTFT p99", dir: "min",
    fmt: (v) => `${v.toFixed(0)}ms`,
    fmtDelta: (d) => `${d >= 0 ? "+" : ""}${d.toFixed(0)}ms` },
  { key: "tpot_ms", label: "TPOT", dir: "min",
    fmt: (v) => `${v.toFixed(1)}ms`,
    fmtDelta: (d) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}ms` },
  { key: "mfu_pct", label: "MFU", dir: "max",
    fmt: (v) => `${v.toFixed(1)}%`,
    fmtDelta: (d) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}pp` },
  { key: "confidence", label: "conf", dir: "max", fromTopLevel: true,
    fmt: (v) => v.toFixed(2),
    fmtDelta: (d) => `${d >= 0 ? "+" : ""}${d.toFixed(2)}` },
];

function getKpi(run: Run, key: string, fromTopLevel?: boolean): number | undefined {
  if (fromTopLevel) {
    const v = (run as unknown as Record<string, unknown>)[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  }
  const k = (run.kpis ?? {}) as Record<string, number>;
  const v = k[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

type Props = {
  run: Run;
  hwspecId?: string;
};

export function PrevRunDeltaCard({ run, hwspecId }: Props) {
  // Only fire when status is final — there's no useful delta against an
  // in-flight run. Also gate on hwspecId presence.
  const enabled = run.status === "done"
    && !!hwspecId;

  // Identify "previous on same spec": newest recentRun with matching
  // hwspecId, excluding the current run id. We resolve outside of the
  // hook so the gate fires before we issue any fetch.
  const prevRunId = (() => {
    if (!enabled) return null;
    const recents = readRecentRuns();
    return recents.find(
      (r) => r.hwspecId === hwspecId && r.runId !== run.id,
    )?.runId ?? null;
  })();

  // useRunFull tolerates empty id via enabled gate; OK if prevRunId null.
  const { data, isLoading } = useRunFull(prevRunId ?? "", { enabled: !!prevRunId });

  if (!enabled || !prevRunId) return null;
  if (isLoading || !data || data.run.status !== "done") {
    return null;
  }
  const prev = data.run;

  const fields = run.kind === "infer" ? INFER_FIELDS : TRAIN_FIELDS;

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="prev-run-delta">
      <div className="card-head">
        <div className="card-t">vs 上次同 spec run</div>
        <div className="card-x" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link to={`/sim/reports/${prev.id}`} data-testid="prev-run-link">
            {prev.id} →
          </Link>
        </div>
      </div>

      <div
        className="grid g4"
        style={{ gap: 10 }}
        data-testid="prev-run-delta-grid"
      >
        {fields.map((f) => {
          const cur = getKpi(run, f.key, f.fromTopLevel);
          const old = getKpi(prev, f.key, f.fromTopLevel);
          const both = cur != null && old != null;
          const delta = both ? cur - old : null;
          // direction-aware: green = improvement
          const sign: "up" | "down" | "none" =
            !both || delta === 0 ? "none"
            : f.dir === "max" ? (delta! > 0 ? "up" : "down")
            : (delta! < 0 ? "up" : "down");
          const color =
            sign === "up" ? "var(--green)"
            : sign === "down" ? "var(--red)"
            : "var(--t3)";
          const arrow =
            sign === "up" ? "↑" : sign === "down" ? "↓" : "—";
          return (
            <div
              key={f.key}
              data-testid={`prev-run-delta-${f.key}`}
              data-sign={sign}
            >
              <div style={{ fontSize: 11, color: "var(--t3)", marginBottom: 4 }}>
                {f.label}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--t1)" }}>
                {cur != null ? f.fmt(cur) : "—"}
              </div>
              <div style={{ fontSize: 11, color, marginTop: 2, fontFamily: "var(--mono)" }}>
                {delta != null ? `${arrow} ${f.fmtDelta!(delta)}` : "无 baseline"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
