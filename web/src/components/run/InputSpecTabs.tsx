import { useState } from "react";
import type { SpecRef } from "../../api/runs";

const KIND_LABEL: Record<SpecRef["kind"], string> = {
  hwspec: "HwSpec",
  model: "ModelDef",
  strategy: "StrategySpace",
  workload: "WorkloadCfg",
};

function bodyToYAML(body: unknown, indent = 0): string {
  if (body === null || body === undefined) return "null";
  if (typeof body === "string") return body;
  if (typeof body === "number" || typeof body === "boolean") return String(body);
  if (Array.isArray(body)) return JSON.stringify(body);
  if (typeof body === "object") {
    return Object.entries(body as Record<string, unknown>)
      .map(([k, v]) => {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          return `${"  ".repeat(indent)}${k}:\n${bodyToYAML(v, indent + 1)}`;
        }
        return `${"  ".repeat(indent)}${k}: ${bodyToYAML(v, indent)}`;
      })
      .join("\n");
  }
  return String(body);
}

export function InputSpecTabs({ specs }: { specs: SpecRef[] }) {
  const [active, setActive] = useState<SpecRef["kind"]>("hwspec");
  const current = specs.find((s) => s.kind === active);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <div className="card-t">输入规格 · Inputs</div>
        <div className="spec-tabs">
          {specs.map((s) => (
            <button
              key={s.kind}
              className={`spec-tab ${active === s.kind ? "on" : ""}`}
              onClick={() => setActive(s.kind)}
            >
              {KIND_LABEL[s.kind]}
              {s.stale && <span className="spec-stale">⚠ stale</span>}
            </button>
          ))}
        </div>
      </div>
      {current ? (
        <pre className="run-code">{`# ${KIND_LABEL[current.kind]} · ${current.name} @ ${current.version_tag}\n# hash: ${current.hash}\n${current.stale ? "# ⚠ stale: latest version has moved past this snapshot\n" : ""}\n${bodyToYAML(current.body)}`}</pre>
      ) : (
        <div style={{ color: "var(--t3)", fontSize: 12 }}>缺少 {KIND_LABEL[active]}</div>
      )}
    </div>
  );
}
