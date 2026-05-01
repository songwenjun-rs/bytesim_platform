/**
 * Interactive legend: click an entry to toggle visibility.
 * Caller maintains the visible-set in their own state and passes onToggle.
 */

export type LegendItem = { key: string; label: string; color: string; meta?: string };

export function Legend({
  items, hidden, onToggle,
  align = "start",
}: {
  items: LegendItem[];
  hidden: Set<string>;
  onToggle?: (key: string) => void;
  align?: "start" | "center" | "end";
}) {
  return (
    <div style={{
      display: "flex", gap: 14, marginTop: 8, fontSize: 11, color: "var(--t3)",
      flexWrap: "wrap", justifyContent: align,
    }}>
      {items.map((it) => {
        const off = hidden.has(it.key);
        const clickable = !!onToggle;
        return (
          <span
            key={it.key}
            onClick={clickable ? () => onToggle!(it.key) : undefined}
            style={{
              cursor: clickable ? "pointer" : "default",
              opacity: off ? 0.4 : 1,
              userSelect: "none",
              display: "inline-flex", alignItems: "center", gap: 4,
            }}
            title={clickable ? "点击切换显示" : undefined}
          >
            <span style={{
              width: 10, height: 10, borderRadius: 2, background: it.color,
              display: "inline-block",
            }} />
            <span>{it.label}</span>
            {it.meta && <span style={{ color: "var(--t4)", marginLeft: 2 }}>({it.meta})</span>}
          </span>
        );
      })}
    </div>
  );
}
