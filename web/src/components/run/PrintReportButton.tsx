/**
 * PDF export — RunDetail report.
 *
 * Triggers `window.print()`; the @media print CSS in global.css hides
 * shell chrome (sidebar / topbar), action buttons, and live elements
 * (engine log stream) so the printed page is a clean snapshot.
 *
 * Pure-client implementation: no server-side render, no PDF library.
 * The browser's "Save as PDF" handles the file output. Trade-off: the
 * resulting PDF is one continuous page (no real pagination control),
 * but it's free, dependency-free, and works on every architect's
 * machine without IT setup.
 */
type Props = {
  runId: string;
};

export function PrintReportButton({ runId }: Props) {
  const handleClick = () => {
    // Defer to next tick so any in-flight CSS transitions settle and
    // the print preview reflects the final layout.
    setTimeout(() => window.print(), 0);
  };

  return (
    <button
      type="button"
      className="btn btn-ghost no-print"
      onClick={handleClick}
      data-testid="print-report-btn"
      title={`导出 ${runId} 报告 (PDF)`}
      style={{ fontSize: 11.5, padding: "4px 12px" }}
    >
      📄 导出 PDF
    </button>
  );
}

/**
 * Print-only header injected at the top of RunDetail. Hidden during
 * normal viewing; only visible when @media print is active. Carries
 * the contextual identifiers the printed page needs to stand alone:
 * project / run id / generation timestamp.
 */
export function PrintReportHeader({ runId, runTitle }: { runId: string; runTitle: string }) {
  return (
    <div
      className="print-only print-header"
      data-testid="print-report-header"
      style={{ display: "none" }}
    >
      <div style={{ fontSize: 11, color: "#666" }}>
        ByteSim · 仿真报告
      </div>
      <h1 style={{ margin: "4px 0", fontSize: 18 }}>{runTitle}</h1>
      <div style={{ fontSize: 10, color: "#888" }}>
        Run · {runId} · 生成于 {new Date().toLocaleString()}
      </div>
      <hr style={{ margin: "8px 0" }} />
    </div>
  );
}
