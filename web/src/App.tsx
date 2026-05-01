import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { Dashboard } from "./pages/Dashboard";
import { RunDetail } from "./pages/RunDetail";
import { Topology } from "./pages/Topology";
import { ToastHost } from "./components/shell/Toast";
import { Catalog } from "./pages/Catalog";
import { Engines } from "./pages/Engines";
import { TrainingSim } from "./pages/TrainingSim";
import { InferenceSim } from "./pages/InferenceSim";
import { Reports } from "./pages/Reports";
import { ReportsCompare } from "./pages/ReportsCompare";
import { Tuner, Calibration, Production, KVCacheSim } from "./pages/Placeholders";

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <div>
        <Topbar />
        <main className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/login" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/sim/reports/:runId" element={<RunDetail />} />
            <Route path="/sim/cluster/:specId" element={<Topology />} />
            <Route path="/sim/cluster" element={<Navigate to="/sim/cluster/hwspec_topo_b1" replace />} />
            {/* /comparator → unified into 仿真报告对比 (Reports → 勾选 → 对比). */}
            <Route path="/comparator/*" element={<Navigate to="/sim/reports" replace />} />
            <Route path="/sim/training" element={<TrainingSim />} />
            <Route path="/sim/inference" element={<InferenceSim />} />
            <Route path="/sim/kvcache" element={<KVCacheSim />} />
            <Route path="/sim/tuner" element={<Tuner />} />
            <Route path="/sim/reports" element={<Reports />} />
            <Route path="/sim/reports/compare" element={<ReportsCompare />} />
            <Route path="/registry/parts" element={<Catalog />} />
            <Route path="/registry/parts/:rootId" element={<Catalog />} />
            <Route path="/registry/engines" element={<Engines />} />
            <Route path="/sim/calibration" element={<Calibration />} />
            <Route path="/registry/production" element={<Production />} />
          </Routes>
        </main>
      </div>
      <ToastHost />
    </div>
  );
}
