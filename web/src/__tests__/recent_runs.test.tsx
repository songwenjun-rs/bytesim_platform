/**
 * S6.7 — recentRuns ring buffer + OverlayRunPicker UI.
 *
 * Locks:
 *   - push: newest first; duplicates de-duped to front.
 *   - cap at 10 entries — older drop off.
 *   - Picker reflects the buffer; selecting calls onPick(runId).
 *   - Selecting "— 不叠加 —" calls onPick(null).
 *   - selectedRunId not in history is prepended as synthetic "外部"
 *     entry so the dropdown matches the URL state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import {
  pushRecentRun, readRecentRuns, clearRecentRuns,
} from "../components/sim/recentRuns";
import { OverlayRunPicker } from "../components/topology/OverlayRunPicker";

beforeEach(() => {
  window.localStorage.clear();
});

// ── Storage helpers ───────────────────────────────────────────────────────

describe("recentRuns ring buffer", () => {
  it("push + read round-trip with newest first", () => {
    pushRecentRun({ runId: "r1", kind: "infer", title: "first" });
    pushRecentRun({ runId: "r2", kind: "train", title: "second" });
    const got = readRecentRuns();
    expect(got.map((r) => r.runId)).toEqual(["r2", "r1"]);
  });

  it("dedupes by runId, promoting to front", () => {
    pushRecentRun({ runId: "r1", kind: "infer" });
    pushRecentRun({ runId: "r2", kind: "infer" });
    pushRecentRun({ runId: "r1", kind: "infer", title: "updated" });
    const got = readRecentRuns();
    expect(got.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(got[0].title).toBe("updated");
  });

  it("caps at 10 entries — oldest drops off", () => {
    for (let i = 0; i < 15; i++) {
      pushRecentRun({ runId: `r${i}`, kind: "infer" });
    }
    const got = readRecentRuns();
    expect(got.length).toBe(10);
    expect(got[0].runId).toBe("r14");  // newest
    expect(got[9].runId).toBe("r5");   // 10th-newest
  });

  it("readRecentRuns returns [] when storage empty / malformed", () => {
    expect(readRecentRuns()).toEqual([]);
    window.localStorage.setItem("bytesim:recentRuns", "{not json");
    expect(readRecentRuns()).toEqual([]);
    window.localStorage.setItem("bytesim:recentRuns", JSON.stringify("not array"));
    expect(readRecentRuns()).toEqual([]);
  });

  it("filters malformed entries (defensive)", () => {
    window.localStorage.setItem("bytesim:recentRuns", JSON.stringify([
      { runId: "ok-1", savedAt: "2026-01-01T00:00:00Z", kind: "infer" },
      { foo: "bar" },                       // missing runId
      { runId: 42, savedAt: "x" },         // wrong type
      { runId: "ok-2", savedAt: "2026-01-02T00:00:00Z", kind: "train" },
    ]));
    const got = readRecentRuns();
    expect(got.map((r) => r.runId)).toEqual(["ok-1", "ok-2"]);
  });

  it("clearRecentRuns wipes the buffer", () => {
    pushRecentRun({ runId: "r1", kind: "infer" });
    clearRecentRuns();
    expect(readRecentRuns()).toEqual([]);
  });
});

// ── Picker ─────────────────────────────────────────────────────────────────

describe("<OverlayRunPicker>", () => {
  it("renders empty-state hint when no recent runs", () => {
    render(<OverlayRunPicker selectedRunId={null} onPick={() => {}} />);
    expect(screen.getByText(/本会话无历史 run/)).toBeInTheDocument();
    expect(screen.queryByTestId("overlay-run-picker")).toBeNull();
  });

  it("renders one option per recent run plus the empty option", () => {
    pushRecentRun({ runId: "r1", kind: "infer", title: "first" });
    pushRecentRun({ runId: "r2", kind: "train", title: "second" });
    render(<OverlayRunPicker selectedRunId={null} onPick={() => {}} />);
    const sel = screen.getByTestId("overlay-run-picker-select") as HTMLSelectElement;
    expect(sel.options.length).toBe(3);  // empty + 2 recents
    expect(sel.options[0].value).toBe("");
  });

  it("selecting a run calls onPick(runId)", async () => {
    pushRecentRun({ runId: "r1", kind: "infer" });
    pushRecentRun({ runId: "r2", kind: "train" });
    const onPick = vi.fn();
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<OverlayRunPicker selectedRunId={null} onPick={onPick} />);
    await act(async () => {
      await user.selectOptions(screen.getByTestId("overlay-run-picker-select"), "r1");
    });
    expect(onPick).toHaveBeenCalledWith("r1");
  });

  it("selecting the empty option calls onPick(null)", async () => {
    pushRecentRun({ runId: "r1", kind: "infer" });
    const onPick = vi.fn();
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<OverlayRunPicker selectedRunId="r1" onPick={onPick} />);
    await act(async () => {
      await user.selectOptions(screen.getByTestId("overlay-run-picker-select"), "");
    });
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("prepends a synthetic '外部' entry when selectedRunId not in history", () => {
    pushRecentRun({ runId: "r1", kind: "infer" });
    render(<OverlayRunPicker selectedRunId="external-run" onPick={() => {}} />);
    const sel = screen.getByTestId("overlay-run-picker-select") as HTMLSelectElement;
    // 1 empty + 1 synthetic + 1 history = 3 options
    expect(sel.options.length).toBe(3);
    expect(sel.options[1].textContent).toContain("external-run");
    expect(sel.options[1].textContent).toContain("外部");
  });
});
