/**
 * S2.2b — In-place progress panel for the just-submitted run.
 *
 * Default flow before this slice: submit → toast → navigate to /sim/reports/:id.
 * The architect loses the form, can't iterate, and waits in another view.
 *
 * New flow: submit → page stays put → this panel renders the run's live
 * phase stepper, then KPI summary + bottleneck card when the run finishes.
 * The architect can tweak the form and submit again without leaving.
 *
 * The panel manages its own polling via React Query (useRunFull) so it
 * picks up status transitions from `running` → `done` automatically. The
 * EnginePhases sub-component opens its own WebSocket for live PHASE
 * markers; this panel waits on the run row to settle for KPI display.
 */
import { Link } from "react-router-dom";
import { useRunFull } from "../../api/runs";
import { EnginePhases } from "../run/EnginePhases";
import { BottleneckCard } from "../run/BottleneckCard";
import { KpiGrid } from "../run/KpiGrid";
import { PhaseBreakdownBar } from "../run/PhaseBreakdownBar";
import { PhaseCostCard } from "../run/PhaseCostCard";
import { KvPressureCard } from "../run/KvPressureCard";
import { TcoSummaryCard } from "../run/TcoSummaryCard";

type Props = {
  runId: string;
  /** Caller-provided "dismiss" — typically wipes the parent's local state. */
  onReset: () => void;
};

export function SubmittedRunPanel({ runId, onReset }: Props) {
  const { data, isLoading } = useRunFull(runId);

  return (
    <div className="card" style={{ marginBottom: 14, padding: 16 }} data-testid="submitted-run-panel">
      <div className="card-head" style={{ marginBottom: 14 }}>
        <div className="card-t">本次提交 · {runId}</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link to={`/sim/reports/${runId}`} data-testid="submitted-run-link">查看完整结果 →</Link>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 11, padding: "4px 10px" }}
            onClick={onReset}
            data-testid="submitted-run-reset"
          >
            重置
          </button>
        </div>
      </div>

      {/* Phase stepper drives off the WebSocket — visible immediately. */}
      <EnginePhases runId={runId} runStatus={data?.run.status} />

      {isLoading && (
        <div className="boundary-info" style={{ marginTop: 8, fontSize: 11.5 }}>
          run 元数据加载中…
        </div>
      )}

      {data?.run && data.run.status === "done" && (
        <>
          <KpiGrid run={data.run} />
          <TcoSummaryCard runId={data.run.id} />
          <BottleneckCard run={data.run} />
          <PhaseBreakdownBar run={data.run} />
          <PhaseCostCard run={data.run} />
          <KvPressureCard run={data.run} />
        </>
      )}

      {data?.run && data.run.status === "failed" && (
        <div className="boundary-warn" style={{ marginTop: 8 }} data-testid="submitted-run-failed">
          仿真失败 — 详情见日志，或点击「查看完整结果」
        </div>
      )}
    </div>
  );
}
