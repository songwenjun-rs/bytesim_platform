/** Tiny shared shells used by TrainingSim + InferenceSim — kept minimal so
 *  the two pages stay self-evident; no abstraction beyond layout. */
import { useState } from "react";
import { getGlossary } from "./glossary";

export const simInputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 10px", borderRadius: "var(--r-sm)",
  background: "var(--surface)", border: "1px solid var(--hairline-2)",
  color: "var(--t1)", fontSize: 12,
};

export function SimSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: "var(--t3)", letterSpacing: ".05em",
                    marginBottom: 8, textTransform: "uppercase" }}>{title}</div>
      <div className="grid g4" style={{ gap: 10 }}>{children}</div>
    </div>
  );
}

export function SimField({
  label, hint, term, children,
}: {
  label: string;
  hint?: string;
  /**
   * S5.2 — glossary key. When set AND the key resolves in glossary.ts,
   * an ⓘ icon appears next to the label and click toggles an inline
   * definition card below the field. Unknown keys silently degrade
   * to no icon (so a typo never breaks the form).
   */
  term?: string;
  children: React.ReactNode;
}) {
  const entry = getGlossary(term);
  const [open, setOpen] = useState(false);

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--t3)", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
        <span>{label}</span>
        {entry && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            data-testid={`sim-glossary-toggle-${term}`}
            aria-label={`查看 ${label} 释义`}
            style={{
              all: "unset",
              cursor: "pointer",
              fontSize: 11,
              color: open ? "var(--blue)" : "var(--t4)",
              border: `1px solid ${open ? "var(--blue)" : "var(--hairline)"}`,
              borderRadius: "50%",
              width: 14, height: 14,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            ⓘ
          </button>
        )}
        {hint && <span style={{ color: "var(--t4)", marginLeft: 4 }}>· {hint}</span>}
      </div>
      {children}
      {entry && open && (
        <div
          data-testid={`sim-glossary-popover-${term}`}
          style={{
            marginTop: 6, padding: 8,
            background: "var(--surface-2)",
            border: "1px solid var(--hairline)",
            borderRadius: "var(--r-sm)",
            fontSize: 11, lineHeight: 1.5, color: "var(--t2)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--t1)", marginBottom: 4 }}>
            {entry.title}
            {entry.english && (
              <span style={{ color: "var(--t3)", fontWeight: 400, marginLeft: 6 }}>
                · {entry.english}
              </span>
            )}
          </div>
          <div style={{ marginBottom: entry.typical ? 4 : 0 }}>{entry.desc}</div>
          {entry.typical && (
            <div style={{ color: "var(--t3)", fontSize: 10.5 }}>
              典型值 · {entry.typical}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
