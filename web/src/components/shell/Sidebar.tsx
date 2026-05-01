import { NavLink } from "react-router-dom";

type Item = { ico: string; label: string; to?: string; disabled?: boolean };
type Group = { title: string; items: Item[] };

const NAV: Group[] = [
  {
    title: "系统概览",
    items: [
      { ico: "📊", label: "Dashboard", to: "/dashboard" },
    ],
  },
  {
    title: "仿真工作台",
    items: [
      { ico: "🏢", label: "集群配置", to: "/sim/cluster/hwspec_topo_b1" },
      { ico: "🎓", label: "训练仿真", to: "/sim/training" },
      { ico: "💬", label: "推理仿真", to: "/sim/inference" },
      { ico: "🧠", label: "KVCache", to: "/sim/kvcache" },
      { ico: "🎯", label: "自动寻优", to: "/sim/tuner" },
      { ico: "🎚", label: "校准中心", to: "/sim/calibration" },
      { ico: "📋", label: "仿真报告", to: "/sim/reports" },
    ],
  },
  {
    title: "资源仓库",
    items: [
      { ico: "🔩", label: "硬件部件", to: "/registry/parts" },
      { ico: "⚙", label: "仿真引擎", to: "/registry/engines" },
      { ico: "📡", label: "生产数据", to: "/registry/production" },
    ],
  },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">β</div>
        <div>
          <div className="brand-name">ByteSim-2.0</div>
          <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 1 }}>AI Factory Digital Twin</div>
        </div>
      </div>
      {NAV.map((g) => (
        <div className="nav-group" key={g.title}>
          <div className="nav-title">{g.title}</div>
          {g.items.map((it) => {
            if (it.disabled || !it.to) {
              return (
                <div key={it.label} className="nav-item" style={{ opacity: 0.4, cursor: "not-allowed" }}
                     title="后续切片实现">
                  <span className="nav-ico">{it.ico}</span>{it.label}
                </div>
              );
            }
            return (
              <NavLink
                key={it.label}
                to={it.to}
                className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              >
                <span className="nav-ico">{it.ico}</span>{it.label}
              </NavLink>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
