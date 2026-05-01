import { useNavigate } from "react-router-dom";
import type { Lineage } from "../../api/runs";

// Mini DAG layout: parents on the left, self in the middle, children on the right.
// SVG positions follow the prototype's lineage drawer aesthetic.
const W = 380, H = 240;
const COL_X = { parent: 60, self: 190, child: 320 };

export function LineageGraph({ lineage }: { lineage: Lineage }) {
  const navigate = useNavigate();
  // run-svc returns null (not []) when a run has no parents/children; coalesce
  // here so older renderers and the .length / .map calls below don't crash.
  const parents  = lineage.parents  ?? [];
  const children = lineage.children ?? [];
  const parentY = layoutColumn(parents.length, H);
  const childY  = layoutColumn(children.length, H);
  const selfY   = H / 2;

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-t">血缘 · Lineage</div>
        <span className="tag tag-white">
          {parents.length} 父 · {children.length} 子
        </span>
      </div>
      <svg className="lin-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {parents.map((p, i) => (
          <line
            key={`pl-${p.id}`}
            x1={COL_X.parent + 40} y1={parentY[i]}
            x2={COL_X.self} y2={selfY}
            stroke="var(--t4)" strokeWidth={1.5}
          />
        ))}
        {children.map((c, i) => (
          <line
            key={`cl-${c.id}`}
            x1={COL_X.self + 40} y1={selfY}
            x2={COL_X.child} y2={childY[i]}
            stroke={c.stale ? "var(--orange)" : "var(--purple)"}
            strokeWidth={1.5}
            strokeDasharray={c.stale ? "3 2" : "3 2"}
          />
        ))}

        {parents.map((p, i) => (
          <Node
            key={p.id}
            x={COL_X.parent} y={parentY[i]}
            node={p}
            label={p.kind === "study" ? "study" : "父"}
            kind={p.kind}
            onClick={() => navigate(p.kind === "study" ? `/tuner/${p.id}` : `/sim/reports/${p.id}`)}
          />
        ))}

        <Node
          x={COL_X.self} y={selfY}
          node={lineage.self}
          label="当前"
          current
        />

        {children.map((c, i) => (
          <Node
            key={c.id}
            x={COL_X.child} y={childY[i]}
            node={c}
            label="子"
            onClick={() => navigate(`/sim/reports/${c.id}`)}
          />
        ))}

        <g transform="translate(10,222)">
          <circle cx="4" cy="4" r="3" fill="var(--blue)" />
          <text x="12" y="7" fill="var(--t3)" fontSize="9">当前</text>
          <circle cx="58" cy="4" r="3" fill="var(--t4)" />
          <text x="66" y="7" fill="var(--t3)" fontSize="9">父/派生链</text>
          <circle cx="138" cy="4" r="3" fill="var(--orange)" />
          <text x="146" y="7" fill="var(--t3)" fontSize="9">stale</text>
        </g>
      </svg>
      <div style={{ fontSize: 10.5, color: "var(--t3)", marginTop: 4 }}>
        点击节点跳转 · 虚线表示该分支依赖的配置版本已过期
      </div>
    </div>
  );
}

function layoutColumn(count: number, h: number): number[] {
  if (count === 0) return [];
  if (count === 1) return [h / 2];
  const margin = 20;
  const step = (h - margin * 2) / (count - 1);
  return Array.from({ length: count }, (_, i) => margin + step * i);
}

function Node({
  x, y, node, label, current, kind, onClick,
}: {
  x: number; y: number;
  node: { id: string; title?: string; status?: string; stale: boolean };
  label: string; current?: boolean; kind?: string; onClick?: () => void;
}) {
  const stroke = kind === "study" ? "var(--purple)" : current ? "var(--blue)" : "var(--t4)";
  const fill = kind === "study" ? "var(--purple-s)" : current ? "var(--blue-s)" : "var(--surface)";
  return (
    <g
      className={`lin-node ${current ? "cur" : ""} ${node.stale ? "stale" : ""}`}
      transform={`translate(${x - 40}, ${y - 16})`}
      style={{ cursor: onClick ? "pointer" : "default" }}
      onClick={onClick}
    >
      <rect width={80} height={32} rx={8} fill={fill} stroke={stroke} strokeWidth={current ? 1.5 : 1} />
      <text x={40} y={14} textAnchor="middle" fill={current ? "var(--t1)" : "var(--t2)"} fontSize="10" fontFamily="SF Mono" fontWeight={current ? 700 : 400}>
        {node.id}
      </text>
      <text x={40} y={26} textAnchor="middle" fill={node.stale ? "var(--orange)" : "var(--t3)"} fontSize="8">
        {label}{node.status ? ` · ${node.status}` : ""}
      </text>
    </g>
  );
}
