/**
 * S5.6 — Render live KPI predictions next to the Sim form.
 *
 * Compact 4-cell grid showing what the engine would return for the
 * current form values. Reuses surrogate's prediction surface so what
 * the architect sees here matches what they'll see after submit (modulo
 * scan/top-k re-ranking, which only the full pipeline runs).
 *
 * Visual language matches KpiGrid so the eye doesn't have to relearn
 * "where is MFU" between this card and the post-submit RunDetail.
 */
import { useLivePredict, type LivePredictPayload } from "../../api/livePredict";

type Props = {
  payload: LivePredictPayload;
  enabled: boolean;
};

export function LivePredictCard({ payload, enabled }: Props) {
  const { data, isFetching, error } = useLivePredict(payload, enabled);

  if (!enabled) return null;

  const mode = payload.workload.mode;

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="live-predict-card">
      <div className="card-head">
        <div className="card-t">实时预估</div>
        <div className="card-x">
          {error
            ? "预测不可用"
            : isFetching
              ? "重新计算中…"
              : data?.feasible === false
                ? "✗ 当前组合不可行"
                : data
                  ? "提交前所见即所得 · 按 baseline 配置"
                  : "等待引擎…"}
        </div>
      </div>

      <div className="grid g4" style={{ gap: 10 }}>
        {mode === "training" ? (
          <>
            <Cell
              label="MFU"
              value={data?.mfu_pct != null
                ? `${data.mfu_pct.toFixed(1)}%` : "—"}
              testId="live-mfu"
            />
            <Cell
              label="单步耗时"
              value={data?.step_ms != null
                ? `${(data.step_ms / 1000).toFixed(2)}s` : "—"}
              testId="live-step-ms"
            />
            <Cell
              label="峰值"
              value={data?.peak_kw != null
                ? `${data.peak_kw.toFixed(0)}kW` : "—"}
              testId="live-peak-kw"
            />
            <Cell
              label="置信度"
              value={data?.confidence != null
                ? data.confidence.toFixed(2) : "—"}
              testId="live-confidence"
            />
          </>
        ) : (
          <>
            <Cell
              label="TTFT"
              value={data?.ttft_ms != null
                ? `${data.ttft_ms.toFixed(0)}ms` : "—"}
              testId="live-ttft"
            />
            <Cell
              label="TPOT"
              value={data?.tpot_ms != null
                ? `${data.tpot_ms.toFixed(1)}ms` : "—"}
              testId="live-tpot"
            />
            <Cell
              label="MFU"
              value={data?.mfu_pct != null
                ? `${data.mfu_pct.toFixed(1)}%` : "—"}
              testId="live-mfu"
            />
            <Cell
              label="置信度"
              value={data?.confidence != null
                ? data.confidence.toFixed(2) : "—"}
              testId="live-confidence"
            />
          </>
        )}
      </div>

      {data?.notes && data.notes.length > 0 && (
        <div
          style={{
            marginTop: 8, fontSize: 11, color: "var(--t3)",
          }}
          data-testid="live-notes"
        >
          {data.notes.slice(0, 2).map((n, i) => (
            <div key={i}>· {n}</div>
          ))}
          {data.notes.length > 2 && (
            <div>· +{data.notes.length - 2} 条</div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <div style={{ fontSize: 11, color: "var(--t3)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--t1)" }}>{value}</div>
    </div>
  );
}
