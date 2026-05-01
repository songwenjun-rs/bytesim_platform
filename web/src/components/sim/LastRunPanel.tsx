/**
 * S2.2a — Show last submitted run's bottleneck on the Sim page.
 *
 * The Sim form, in isolation, has no memory across sessions. The architect
 * iterates: tweak prefix_share_ratio → submit → look at TTFT → tweak again.
 * Today they jump to RunDetail and back. This panel makes the previous
 * run's bottleneck visible alongside the form so they can read "last time
 * was NVLink-bound, this round let me drop TP".
 *
 * Storage is localStorage (per-browser). No backend list-runs hook is
 * needed — we just remember the most recent run id at submit time. When
 * run-svc grows a typed list-runs hook (S1.2 follow-up), this component
 * will widen to "last 3 runs" without changing its public API.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useRunFull } from "../../api/runs";
import { BottleneckCard } from "../run/BottleneckCard";

type Kind = "infer" | "train";

const STORAGE_KEY_PREFIX = "bytesim:lastRun:";

export function rememberLastRun(kind: Kind, runId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + kind, JSON.stringify({
      runId, savedAt: new Date().toISOString(),
    }));
  } catch { /* QuotaExceeded / disabled storage — silent */ }
}

export function readLastRun(kind: Kind): { runId: string; savedAt: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + kind);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.runId === "string") return parsed;
    return null;
  } catch { return null; }
}

export function clearLastRun(kind: Kind): void {
  try { localStorage.removeItem(STORAGE_KEY_PREFIX + kind); } catch { /* */ }
}

export function LastRunPanel({ kind }: { kind: Kind }) {
  // Read once on mount — re-rendering the form should not re-pull
  // localStorage; users who submit a new run get their fresh state via
  // navigate() to /sim/reports/:id, not via this panel updating in place.
  const [last, setLast] = useState<{ runId: string; savedAt: string } | null>(null);
  useEffect(() => { setLast(readLastRun(kind)); }, [kind]);

  if (!last) return null;
  return <LastRunInner kind={kind} runId={last.runId} />;
}

// Inner component is only mounted when there *is* a run id, so the
// `useRunFull` hook is never called with an empty string (which would hit
// `/v1/runs//full`). We can't gate the hook with `enabled` because
// useRunFull doesn't expose that knob — splitting components is the
// minimum-blast-radius alternative.
function LastRunInner({ kind, runId }: { kind: Kind; runId: string }) {
  const { data, isLoading, isError } = useRunFull(runId);

  // Clean up the local-storage entry on a settled fetch with no data —
  // typically a 404 from a deleted run. Side-effect lives in useEffect
  // (not render) so the cleanup is observable across renders and the
  // test can waitFor it.
  useEffect(() => {
    if (!isLoading && (isError || !data)) {
      clearLastRun(kind);
    }
  }, [isLoading, isError, data, kind]);

  if (isLoading) {
    return (
      <div className="card" style={{ marginBottom: 14 }} data-testid="lastrun-loading">
        <div className="card-head">
          <div className="card-t">上次仿真</div>
          <div className="card-x">{runId} · 加载中…</div>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const { run } = data;
  return (
    <div data-testid="lastrun-panel" style={{ marginBottom: 14 }}>
      <div className="card" style={{ marginBottom: 8 }}>
        <div className="card-head">
          <div className="card-t">
            上次{kind === "infer" ? "推理" : "训练"}仿真 · {run.title}
          </div>
          <div className="card-x" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className={
              run.status === "done"   ? "tag tag-green" :
              run.status === "failed" ? "tag tag-red" :
              run.status === "running" ? "tag tag-teal" :
              "tag tag-white"
            }>{run.status}</span>
            <Link to={`/sim/reports/${run.id}`}>查看完整结果 →</Link>
          </div>
        </div>
      </div>
      <BottleneckCard run={run} />
    </div>
  );
}
