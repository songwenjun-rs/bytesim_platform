/**
 * S5.3 — Render constraint check results below the Sim form.
 *
 * Three tiers stack vertically; `error`s come first so the user sees
 * blockers without scrolling. An empty constraint list renders a compact
 * "no issues" banner so the panel slot doesn't disappear/reappear and
 * cause layout jank during form editing.
 */
import type { Constraint, ConstraintLevel } from "./constraints";

const TIER_CLASS: Record<ConstraintLevel, string> = {
  error: "boundary-warn",  // boundary-warn = orange/red surface; reserved for blocking
  warn:  "boundary-info",  // mild — yellow tint via tokens already defined
  info:  "boundary-info",
};

const TIER_PREFIX: Record<ConstraintLevel, string> = {
  error: "✗",
  warn:  "⚠",
  info:  "ⓘ",
};

const TIER_LABEL: Record<ConstraintLevel, string> = {
  error: "阻塞",
  warn:  "警告",
  info:  "建议",
};

const TIER_ORDER: ConstraintLevel[] = ["error", "warn", "info"];

type Props = {
  constraints: Constraint[];
  /**
   * S5.4 — when supplied, renders a quick-fix button for each
   * constraint that defines a `fix`. Click invokes onFix(patch); the
   * page spreads the patch into form state. Omit to suppress all
   * quick-fix buttons (read-only display).
   */
  onFix?: (patch: Record<string, unknown>) => void;
};

export function ConstraintsPanel({ constraints, onFix }: Props) {
  if (constraints.length === 0) {
    return (
      <div
        className="boundary-ok"
        style={{ marginTop: 10, fontSize: 11.5 }}
        data-testid="constraints-empty"
      >
        ✓ 当前配置无明显问题
      </div>
    );
  }

  // Group by tier so all errors render before all warnings, etc.
  const grouped: Record<ConstraintLevel, Constraint[]> = {
    error: [], warn: [], info: [],
  };
  for (const c of constraints) grouped[c.level].push(c);

  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}
         data-testid="constraints-panel">
      {TIER_ORDER.map((tier) =>
        grouped[tier].map((c) => (
          <div
            key={c.id}
            className={TIER_CLASS[tier]}
            style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 8 }}
            data-testid={`constraint-${c.id}`}
            data-level={tier}
          >
            <span style={{ fontWeight: 600, flexShrink: 0 }}>
              {TIER_PREFIX[tier]} {TIER_LABEL[tier]}
            </span>
            <span style={{ flex: 1 }}>{c.msg}</span>
            {c.fix && onFix && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 10.5, padding: "2px 8px", flexShrink: 0 }}
                onClick={() => onFix(c.fix!.patch)}
                data-testid={`constraint-fix-${c.id}`}
              >
                {c.fix.label}
              </button>
            )}
          </div>
        )),
      )}
    </div>
  );
}
