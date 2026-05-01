/** Public surface of the chart-primitives toolkit. */
export { ChartCanvas, DEFAULT_PAD, innerBox, type Pad } from "./ChartCanvas";
export { XAxis, YAxis } from "./Axis";
export { Tooltip } from "./Tooltip";
export { Legend, type LegendItem } from "./Legend";
export {
  linearScale, linearScaleFromZero, niceTicks, timeTicks, rangeOf,
  type Scale, type Range,
} from "./scale";
export {
  utilizationColor, mapeColor, sequentialColor, categoricalColor,
} from "./colors";

/** Convenience: download a CSV from in-memory rows. Used by chart "⬇ CSV" buttons. */
export function downloadCSV(filename: string, rows: Record<string, any>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => escape(r[h])).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
