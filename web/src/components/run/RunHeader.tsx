import { useCancelRun } from "../../api/runs";
import type { Run } from "../../api/runs";
import { PrintReportButton } from "./PrintReportButton";

const KIND_LABEL: Record<Run["kind"], string> = {
  train: "训练仿真",
  infer: "推理仿真",
  batch: "批处理",
  agent: "Agent",
  tco: "运营成本估算",
  calibration: "校准",
};

const STATUS_DOT: Record<Run["status"], string> = {
  queued: "status-wait",
  running: "status-run",
  done: "status-ok",
  failed: "status-fail",
  cancelled: "status-idle",
};

export function RunHeader({ run, selfStale }: { run: Run; selfStale: boolean }) {
  const cancel = useCancelRun(run.id);
  const cancellable = run.status === "queued" || run.status === "running";
  const statusLabel =
    run.status === "running" && run.progress_pct != null
      ? `运行中 · ${Math.round(run.progress_pct)}%`
      : run.status;
  return (
    <div className="page-hd">
      <div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <h1 className="page-ttl">
            <span className="mono" style={{ color: "#7ab8ff", marginRight: 8 }}>{run.id}</span>
            · {run.title}
          </h1>
          <span className="tag tag-teal">
            <span className={`status-dot ${STATUS_DOT[run.status]}`} style={{ marginRight: 4 }} />
            {statusLabel}
          </span>
          <span className="tag tag-blue">{KIND_LABEL[run.kind]}</span>
          {run.surrogate_ver && (
            <span className="tag tag-purple">
              代理 {run.surrogate_ver}
              {run.confidence != null && ` · conf ${run.confidence.toFixed(2)}`}
            </span>
          )}
          {selfStale && <span className="tag tag-orange">⚠ 上游版本已变 · stale</span>}
        </div>
      </div>
      <div className="page-act">
        <PrintReportButton runId={run.id} />
        {cancellable && (
          <button
            className="btn btn-ghost"
            style={{ color: "var(--red)" }}
            onClick={() => {
              if (confirm(`终止 Run ${run.id}？已跑过的阶段保留，但不再继续执行。`)) {
                cancel.mutate();
              }
            }}
            disabled={cancel.isPending}
          >
            {cancel.isPending ? "终止中…" : "⏹ 终止"}
          </button>
        )}
      </div>
    </div>
  );
}
