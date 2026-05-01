/**
 * S6.7 — Pick a recent run to overlay on the Topology view.
 *
 * Reads the local ring buffer (sim/recentRuns.ts) populated each time
 * the architect submits a Sim run. Selecting a run updates the URL's
 * `?overlay=run:<id>` param so the page's existing overlay loader picks
 * it up — no new state plumbing on the Topology side.
 *
 * Server-side run listing would need a new BFF endpoint. The local
 * history covers the dominant "what was I just looking at" case and
 * works offline; cross-device history is a separate problem (project
 * history page) that doesn't block this slice.
 */
import { useEffect, useState } from "react";
import { readRecentRuns, type RecentRun } from "../sim/recentRuns";

type Props = {
  /** Currently active overlay run id (parsed from URL). */
  selectedRunId: string | null;
  /** Caller updates the URL ?overlay=run:<id>. Pass null to clear. */
  onPick: (runId: string | null) => void;
};

export function OverlayRunPicker({ selectedRunId, onPick }: Props) {
  // Read once on mount; further re-reads are user-driven via the
  // dropdown. Background mutations from other tabs won't sync — that's
  // acceptable for a personal-history feature.
  const [recents, setRecents] = useState<RecentRun[]>([]);
  useEffect(() => { setRecents(readRecentRuns()); }, []);

  // If the selected run isn't in our local history (came from a deep
  // link), prepend a synthetic entry so the dropdown shows what's
  // actually rendering. Avoids the disorienting "URL says X but
  // dropdown shows Y" mismatch.
  const augmented: RecentRun[] = (() => {
    if (!selectedRunId || recents.some((r) => r.runId === selectedRunId)) {
      return recents;
    }
    return [
      { runId: selectedRunId, kind: "外部", savedAt: new Date().toISOString() },
      ...recents,
    ];
  })();

  if (augmented.length === 0) {
    return (
      <span style={{ fontSize: 11, color: "var(--t3)" }}>
        本会话无历史 run · 在 Sim 页提交后回到此处
      </span>
    );
  }

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8 }}
      data-testid="overlay-run-picker"
    >
      <label
        htmlFor="overlay-run-picker-select"
        style={{ fontSize: 11, color: "var(--t3)" }}
      >
        切换 run:
      </label>
      <select
        id="overlay-run-picker-select"
        data-testid="overlay-run-picker-select"
        value={selectedRunId ?? ""}
        onChange={(e) => onPick(e.target.value || null)}
        style={{
          padding: "4px 8px", borderRadius: "var(--r-sm)",
          background: "var(--surface-2)", border: "1px solid var(--hairline)",
          color: "var(--t1)", fontSize: 11.5, minWidth: 220,
        }}
      >
        <option value="">— 不叠加 —</option>
        {augmented.map((r) => (
          <option key={r.runId} value={r.runId}>
            {r.runId} · {r.kind}
            {r.title ? ` · ${truncate(r.title, 30)}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
