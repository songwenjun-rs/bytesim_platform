import { Link, useParams } from "react-router-dom";
import { useRunFull } from "../api/runs";
import { RunHeader } from "../components/run/RunHeader";
import { KpiGrid } from "../components/run/KpiGrid";
import { BottleneckCard } from "../components/run/BottleneckCard";
import { EnginePhases } from "../components/run/EnginePhases";
import { PrevRunDeltaCard } from "../components/run/PrevRunDeltaCard";
import { PrintReportHeader } from "../components/run/PrintReportButton";
import { PhaseBreakdownBar } from "../components/run/PhaseBreakdownBar";
import { PhaseCostCard } from "../components/run/PhaseCostCard";
import { KvPressureCard } from "../components/run/KvPressureCard";
import { TcoSummaryCard } from "../components/run/TcoSummaryCard";
import { InputSpecTabs } from "../components/run/InputSpecTabs";
import { EngineLog } from "../components/run/EngineLog";
import { LineageGraph } from "../components/run/LineageGraph";
import { ArtifactsList } from "../components/run/ArtifactsList";
import { ConfidenceCard } from "../components/run/ConfidenceCard";
import { TcoBreakdown } from "../components/run/TcoBreakdown";

export function RunDetail() {
  const { runId = "" } = useParams();
  const { data, isLoading, error } = useRunFull(runId);

  if (isLoading) return <div className="card">加载中…</div>;
  if (error)     return <div className="card boundary-warn">加载失败：{String(error)}</div>;
  if (!data)     return null;

  const { run, specs, lineage, derived } = data;
  // S6.4 — feed BottleneckCard the run's hwspec id so it can render a
  // "在拓扑视图查看" deep link. Falls back to undefined if no hwspec on
  // the lineage (shouldn't happen for normal runs, but BottleneckCard
  // omits the link gracefully).
  const hwspecId = specs.find((s) => s.kind === "hwspec")?.spec_id;

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <Link
          to="/sim/reports"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: "var(--r-sm)",
            background: "var(--surface-2)", border: "1px solid var(--hairline)",
            color: "var(--t2)", fontSize: 12, textDecoration: "none",
          }}
        >
          ← 返回
        </Link>
      </div>
      <PrintReportHeader runId={run.id} runTitle={run.title} />
      <RunHeader run={run} selfStale={derived.self_stale} />
      <EnginePhases runId={run.id} runStatus={run.status} />
      <KpiGrid run={run} />
      <PrevRunDeltaCard run={run} hwspecId={hwspecId} />
      <BottleneckCard run={run} hwspecId={hwspecId} />
      <TcoSummaryCard runId={run.id} />
      <PhaseBreakdownBar run={run} />
      <PhaseCostCard run={run} />
      <KvPressureCard run={run} />
      <InputSpecTabs specs={specs} />
      <div className="grid g2-3" style={{ marginBottom: 14 }}>
        <EngineLog runId={run.id} />
        <LineageGraph lineage={lineage} />
      </div>
      <div className="grid g2" style={{ marginBottom: 14 }}>
        <ArtifactsList runId={run.id} artifacts={run.artifacts} />
        <ConfidenceCard boundaries={run.boundaries} confidence={run.confidence ?? null} />
      </div>
      <div id="tco-breakdown">
        <TcoBreakdown runId={run.id} />
      </div>
    </>
  );
}
