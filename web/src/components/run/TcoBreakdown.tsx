/**
 * §5 TCO breakdown — bar chart of cost components for a Run.
 *
 * Reads from /v1/runs/{runId}/tco. Gracefully handles 404 (Run completed
 * before §5 was wired, or TCO compute failed silently — same UI as "no data").
 */
import { useRunTco } from "../../api/tco";

const BUCKETS: { key: keyof BucketMap; label: string; color: string }[] = [
  { key: "hw_capex_amortized_usd", label: "硬件 CapEx (摊销)", color: "var(--blue)" },
  { key: "power_opex_usd", label: "电力", color: "var(--orange)" },
  { key: "cooling_opex_usd", label: "冷却", color: "var(--teal)" },
  { key: "network_opex_usd", label: "网络", color: "var(--purple)" },
  { key: "storage_opex_usd", label: "存储（含 KV 缓存）", color: "var(--indigo)" },
  { key: "failure_penalty_usd", label: "故障惩罚", color: "var(--red)" },
];

type BucketMap = {
  hw_capex_amortized_usd: number;
  power_opex_usd: number;
  cooling_opex_usd: number;
  network_opex_usd: number;
  storage_opex_usd: number;
  failure_penalty_usd: number;
};

export function TcoBreakdown({ runId }: { runId: string }) {
  const { data, isLoading, error } = useRunTco(runId);

  if (isLoading) {
    return (
      <div className="card">
        <div className="card-t">TCO 拆解</div>
        <div style={{ color: "var(--t3)", fontSize: 12, marginTop: 8 }}>加载中…</div>
      </div>
    );
  }

  // 404 = no TCO computed yet; not an error, just informational.
  if (error || !data) {
    return (
      <div className="card">
        <div className="card-t">TCO 拆解</div>
        <div style={{ color: "var(--t3)", fontSize: 12, marginTop: 8 }}>
          此 Run 尚无 TCO 数据。可能原因：Run 在 §5 接入前完成，或 tco-engine-svc 当时不可达。
        </div>
      </div>
    );
  }

  const total = data.total_usd || 1;  // avoid /0
  const buckets = BUCKETS.map((b) => ({
    ...b,
    value: (data[b.key] as number) ?? 0,
    pct: ((data[b.key] as number) ?? 0) / total * 100,
  }));

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-t">TCO 拆解 · 边际成本</div>
        <div style={{ color: "var(--t3)", fontSize: 11 }}>
          ${data.total_usd.toLocaleString()}
        </div>
      </div>

      {/* 100%-stacked bar */}
      <div style={{
        display: "flex", height: 14, borderRadius: 7,
        overflow: "hidden", border: "1px solid var(--hairline)",
      }}>
        {buckets.map((b) => (
          b.pct > 0 && (
            <div
              key={b.key}
              style={{ width: `${b.pct}%`, background: b.color }}
              title={`${b.label}: $${b.value.toFixed(2)} (${b.pct.toFixed(1)}%)`}
            />
          )
        ))}
      </div>

      {/* Legend table */}
      <div style={{ marginTop: 10 }}>
        {buckets.map((b) => (
          <div key={b.key}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "4px 0", fontSize: 11.5,
              opacity: b.pct < 0.1 ? 0.5 : 1,
            }}>
              <span style={{
                width: 10, height: 10, background: b.color, borderRadius: 2, flexShrink: 0,
              }} />
              <span style={{ color: "var(--t2)", flex: 1 }}>{b.label}</span>
              <span className="mono" style={{ color: "var(--t1)", minWidth: 80, textAlign: "right" }}>
                ${b.value.toFixed(2)}
              </span>
              <span className="mono" style={{ color: "var(--t3)", minWidth: 50, textAlign: "right" }}>
                {b.pct.toFixed(1)}%
              </span>
            </div>
            {/* P-Domain-1: surface KV cache sub-portion under "存储" row */}
            {b.key === "storage_opex_usd" && (data.kvcache_storage_opex_usd ?? 0) > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "2px 0 2px 28px", fontSize: 10.5, color: "var(--t3)",
              }}>
                <span>↳ 其中 KV 缓存层级</span>
                <span className="mono" style={{ marginLeft: "auto" }}>
                  ${(data.kvcache_storage_opex_usd ?? 0).toFixed(2)}
                </span>
                <span className="mono" style={{ minWidth: 50, textAlign: "right" }}>
                  {(((data.kvcache_storage_opex_usd ?? 0) / total) * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Per-unit prices */}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
        {data.per_m_token_usd != null && (
          <PerUnit label="每百万 Token" value={`$${data.per_m_token_usd.toFixed(4)}`} />
        )}
        {data.per_gpu_hour_usd != null && (
          <PerUnit label="每 GPU·小时" value={`$${data.per_gpu_hour_usd.toFixed(3)}`} />
        )}
        {data.per_inference_request_usd != null && (
          <PerUnit label="每推理请求" value={`$${data.per_inference_request_usd.toFixed(6)}`} />
        )}
      </div>

      {/* Sensitivities — guidance for Tuner */}
      {Object.keys(data.sensitivities).length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
          <div className="card-t" style={{ marginBottom: 6 }}>∂TCO/∂x · 敏感度</div>
          {Object.entries(data.sensitivities).map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span className="mono" style={{ color: "var(--t3)" }}>{k}</span>
              <span className="mono" style={{ color: v > 0 ? "var(--orange)" : "var(--green)" }}>
                {v > 0 ? "+" : ""}${v.toFixed(4)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Provenance: which TCO ruleset version was used */}
      {Object.keys(data.rule_versions).length > 0 && (
        <div className="boundary-info" style={{ marginTop: 12, padding: 8, fontSize: 10.5 }}>
          📋 ruleset:{" "}
          {Object.entries(data.rule_versions)
            .map(([k, v]) => `${k}=${v}`)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

function PerUnit({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12 }}>
      <span style={{ color: "var(--t3)" }}>{label}</span>
      <span className="mono" style={{ color: "var(--t1)" }}>{value}</span>
    </div>
  );
}
