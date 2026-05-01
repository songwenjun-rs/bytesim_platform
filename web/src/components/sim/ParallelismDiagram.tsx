/**
 * L1.1 — Visualize TP×PP×EP×CP parallelism layout.
 *
 * Architects know what TP=4 PP=8 means in theory, but understanding the
 * actual GPU layout — "this is 32 GPUs forming one replica, repeated N
 * times across DP" — is faster from a picture than from numbers.
 *
 * Convention rendered here:
 *   - Each cell = 1 GPU.
 *   - Rows = PP stages (top to bottom).
 *   - Columns = TP ranks within each stage.
 *   - Cell color = EP group (cycle through 8 hues).
 *   - Dashed border = CP group (same CP group → same dash pattern).
 *   - One block of TP×PP × max(EP, CP) per replica; a small "× N replicas"
 *     annotation tells the architect this layout repeats across DP.
 *
 * Bounded rendering: if TP > 16 or PP > 16 we collapse to 16 with a "+…"
 * indicator. The diagram is for intuition, not pixel-perfect mapping.
 */

const MAX_DIM = 16;

const EP_COLORS = [
  "var(--teal)", "var(--orange)", "var(--green)", "var(--purple)",
  "var(--blue)", "var(--red)", "var(--indigo)", "var(--pink)",
];

type Props = {
  TP: number;
  PP: number;
  EP: number;
  CP: number;
  gpu_count: number;
};

export function ParallelismDiagram({ TP, PP, EP, CP, gpu_count }: Props) {
  const perReplica = TP * PP;
  const replicas = perReplica > 0 ? Math.floor(gpu_count / perReplica) : 0;
  const totalCovered = perReplica * replicas;

  const tpCols = Math.min(TP, MAX_DIM);
  const ppRows = Math.min(PP, MAX_DIM);
  const tpTrunc = TP > MAX_DIM;
  const ppTrunc = PP > MAX_DIM;

  // The block represents one replica. If perReplica = 0 (e.g. TP=0
  // mid-edit), render a placeholder.
  if (perReplica === 0) {
    return (
      <div
        className="card boundary-info"
        style={{ marginBottom: 14, fontSize: 12 }}
        data-testid="parallelism-diagram-empty"
      >
        并行示意图：先填入 TP / PP（≥ 1）
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{ marginBottom: 14 }}
      data-testid="parallelism-diagram"
      data-replicas={replicas}
    >
      <div className="card-head">
        <div className="card-t">并行布局示意</div>
        <div className="card-x">
          {perReplica} GPU/replica · 占 {totalCovered}/{gpu_count} GPU
          {replicas > 1 && ` · × ${replicas} replicas (DP/EP/CP 维度)`}
          {totalCovered < gpu_count && (
            <span style={{ color: "var(--orange)" }}>
              {" "} · {gpu_count - totalCovered} 未编排
            </span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {/* PP labels column */}
        <div style={{
          display: "flex", flexDirection: "column",
          gap: 3, paddingTop: 18,
        }}>
          {Array.from({ length: ppRows }).map((_, p) => (
            <div key={p} style={{
              fontSize: 10, color: "var(--t3)",
              height: 24, display: "flex", alignItems: "center",
              fontFamily: "var(--mono)",
            }}>
              PP{p}
            </div>
          ))}
          {ppTrunc && (
            <div style={{ fontSize: 10, color: "var(--t4)" }}>+{PP - MAX_DIM}…</div>
          )}
        </div>

        {/* The grid itself */}
        <div style={{ flex: 1 }}>
          {/* TP labels row */}
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${tpCols}, minmax(20px, 1fr))`,
            gap: 3, marginBottom: 3,
          }}>
            {Array.from({ length: tpCols }).map((_, t) => (
              <div
                key={t}
                style={{
                  fontSize: 10, color: "var(--t3)", textAlign: "center",
                  fontFamily: "var(--mono)",
                }}
              >
                TP{t}
              </div>
            ))}
          </div>

          {/* GPU cells */}
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${tpCols}, minmax(20px, 1fr))`,
            gap: 3,
          }}>
            {Array.from({ length: ppRows }).flatMap((_, p) =>
              Array.from({ length: tpCols }).map((_, t) => {
                // Synthetic GPU index within replica
                const gIdx = p * TP + t;
                // Group by EP (mod EP) and CP (mod CP), purely visual
                const epGroup = EP > 1 ? gIdx % EP : 0;
                const cpGroup = CP > 1 ? Math.floor(gIdx / EP) % CP : 0;
                const color = EP_COLORS[epGroup % EP_COLORS.length];
                const borderStyle = CP > 1 && cpGroup > 0 ? "dashed" : "solid";
                return (
                  <div
                    key={`${p}-${t}`}
                    data-testid={`gpu-cell-${p}-${t}`}
                    data-ep-group={epGroup}
                    data-cp-group={cpGroup}
                    style={{
                      height: 24,
                      background: color,
                      opacity: 0.55,
                      border: `1.5px ${borderStyle} ${color}`,
                      borderRadius: 3,
                      fontSize: 9,
                      color: "var(--t1)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: "var(--mono)",
                    }}
                    title={`PP${p} · TP${t} · EP${epGroup}${CP > 1 ? ` · CP${cpGroup}` : ""}`}
                  >
                    {gIdx}
                  </div>
                );
              }),
            )}
          </div>
          {tpTrunc && (
            <div style={{ marginTop: 4, fontSize: 10, color: "var(--t4)", textAlign: "right" }}>
              TP 列只显示前 {MAX_DIM} 个，实际 {TP}
            </div>
          )}
        </div>
      </div>

      {EP > 1 && (
        <div style={{
          marginTop: 10, fontSize: 11, color: "var(--t3)",
          display: "flex", flexWrap: "wrap", gap: 10,
        }} data-testid="parallelism-ep-legend">
          <span style={{ marginRight: 4 }}>EP 组：</span>
          {Array.from({ length: Math.min(EP, EP_COLORS.length) }).map((_, e) => (
            <div key={e} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{
                width: 10, height: 10, borderRadius: 2,
                background: EP_COLORS[e], opacity: 0.8,
                display: "inline-block",
              }} />
              <span className="mono" style={{ fontSize: 10 }}>EP{e}</span>
            </div>
          ))}
          {EP > EP_COLORS.length && (
            <span style={{ color: "var(--t4)" }}>+{EP - EP_COLORS.length} 组循环色</span>
          )}
        </div>
      )}
    </div>
  );
}
