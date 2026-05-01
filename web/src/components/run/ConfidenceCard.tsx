import type { Boundary } from "../../api/runs";

const CLS: Record<Boundary["level"], string> = {
  ok: "boundary-ok",
  warn: "boundary-warn",
  err: "boundary-warn",
  info: "boundary-info",
};

const PREFIX: Record<Boundary["level"], string> = {
  ok: "✓ ",
  warn: "⚠ ",
  err: "✗ ",
  info: "",
};

export function ConfidenceCard({
  boundaries,
  confidence,
}: {
  boundaries: Boundary[];
  confidence?: number | null;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-t">置信度与边界</div>
        {confidence != null && (
          <span className="tag tag-green">conf {confidence.toFixed(2)}</span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
        {boundaries.map((b, i) => (
          <div key={i} className={CLS[b.level]}>
            {PREFIX[b.level]}
            {b.text}
          </div>
        ))}
        {boundaries.length === 0 && (
          <div className="boundary-info">未提供边界声明</div>
        )}
      </div>
    </div>
  );
}
