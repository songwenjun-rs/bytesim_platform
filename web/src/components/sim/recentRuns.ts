/**
 * S6.7 — Local ring buffer of recent runs the user has interacted with.
 *
 * Used by:
 *   - InferenceSim/TrainingSim: push on submit (alongside rememberLastRun)
 *   - Topology overlay run picker: read to populate the dropdown
 *
 * Why localStorage: server-side run listing would require a new BFF
 * endpoint with project/spec filtering. For per-architect "what was I
 * just looking at" the local history is sufficient and works offline.
 *
 * Cap of 10 — enough to span a normal iteration session without UI
 * scroll. Insertion-order: newest first; duplicates de-duped to the
 * front so re-submitting the same run promotes it.
 */

const STORAGE_KEY = "bytesim:recentRuns";
const MAX_ENTRIES = 10;

export type RecentRun = {
  runId: string;
  kind: "infer" | "train" | string;
  title?: string;
  /**
   * S4.6 — hwspec the run was launched against. Used by
   * PrevRunDeltaCard to find the most recent run on the same hardware
   * for KPI delta. Optional because older entries (pre-S4.6) won't
   * have it; readers must tolerate undefined.
   */
  hwspecId?: string;
  savedAt: string;
};

export function pushRecentRun(entry: Omit<RecentRun, "savedAt">): void {
  try {
    const current = readRecentRuns();
    const filtered = current.filter((r) => r.runId !== entry.runId);
    const next: RecentRun[] = [
      { ...entry, savedAt: new Date().toISOString() },
      ...filtered,
    ].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* QuotaExceeded / disabled — silent */ }
}

export function readRecentRuns(): RecentRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentRun =>
        e && typeof e.runId === "string" && typeof e.savedAt === "string",
    );
  } catch {
    return [];
  }
}

export function clearRecentRuns(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}
