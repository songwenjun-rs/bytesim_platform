import type { Artifact } from "../../api/runs";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function ArtifactsList({ runId, artifacts }: { runId: string; artifacts: Artifact[] }) {
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-t">产物 · Artifacts</div>
        <span className="tag tag-white">{artifacts.length} 项</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        {artifacts.map((a) => (
          <a
            key={a.file}
            className="art-row"
            href={`/v1/artifacts/${runId}/${a.file}`}
            target="_blank"
            rel="noreferrer"
          >
            <span>{a.icon} {a.name}</span>
            <span className="mono" style={{ color: "var(--t3)" }}>{fmtBytes(a.bytes)}</span>
          </a>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--t3)", marginTop: 8 }}>
        切片-1 仅 sim-7f2a 的 engine.log / result.json / snapshot.json 实际可下载；其余条目为占位元数据
      </div>
    </div>
  );
}
