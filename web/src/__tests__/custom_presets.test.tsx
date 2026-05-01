/**
 * S5.5 — Custom preset save/delete + PresetSelector integration.
 *
 * Locks:
 *   - Storage: save/load/delete round-trip; partition by kind.
 *   - Trim + reject empty names.
 *   - Cap at 20 per kind.
 *   - PresetSelector renders 💾 button only when both kind+currentForm
 *     supplied (read-only mode hides it).
 *   - Custom presets render in optgroup distinct from hardcoded.
 *   - Selecting a custom preset reveals 🗑 delete button.
 *   - Delete removes the preset and clears the selection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import {
  saveCustomPreset, loadCustomPresets, deleteCustomPreset,
} from "../components/sim/customPresets";
import { PresetSelector } from "../components/sim/PresetSelector";
import type { Preset } from "../components/sim/presets";

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Storage ───────────────────────────────────────────────────────────────

describe("customPresets storage", () => {
  it("save + load round-trip with newest first", () => {
    saveCustomPreset("infer", "alpha", { foo: 1 });
    saveCustomPreset("infer", "beta", { foo: 2 });
    const got = loadCustomPresets("infer");
    expect(got.map((p) => p.name)).toEqual(["beta", "alpha"]);
    expect(got[0].form).toEqual({ foo: 2 });
  });

  it("partitions by kind — infer doesn't leak into train", () => {
    saveCustomPreset("infer", "infer-1", { x: 1 });
    saveCustomPreset("train", "train-1", { y: 2 });
    expect(loadCustomPresets("infer").map((p) => p.name)).toEqual(["infer-1"]);
    expect(loadCustomPresets("train").map((p) => p.name)).toEqual(["train-1"]);
  });

  it("rejects empty names; trims whitespace", () => {
    expect(saveCustomPreset("infer", "", { x: 1 })).toBeNull();
    expect(saveCustomPreset("infer", "   ", { x: 1 })).toBeNull();
    const ok = saveCustomPreset("infer", "  hello  ", { x: 1 });
    expect(ok?.name).toBe("hello");
  });

  it("caps at 20 entries per kind", () => {
    for (let i = 0; i < 25; i++) saveCustomPreset("infer", `p${i}`, { i });
    const got = loadCustomPresets("infer");
    expect(got.length).toBe(20);
    expect(got[0].name).toBe("p24");  // newest
  });

  it("delete removes the entry", () => {
    const a = saveCustomPreset("infer", "alpha", {})!;
    saveCustomPreset("infer", "beta", {});
    deleteCustomPreset("infer", a.id);
    expect(loadCustomPresets("infer").map((p) => p.name)).toEqual(["beta"]);
  });

  it("loadCustomPresets tolerates malformed storage", () => {
    window.localStorage.setItem("bytesim:customPresets:infer", "{not json");
    expect(loadCustomPresets("infer")).toEqual([]);
    window.localStorage.setItem(
      "bytesim:customPresets:infer",
      JSON.stringify([
        { id: "ok", name: "ok", form: {}, savedAt: "x", desc: "" },
        { id: 42 },        // bad
        "not even an object",
      ]),
    );
    expect(loadCustomPresets("infer").map((p) => p.id)).toEqual(["ok"]);
  });
});

// ── PresetSelector integration ─────────────────────────────────────────────

const HARDCODED: Preset<{ x: number }>[] = [
  { id: "hc-1", name: "Hardcoded A", desc: "首选", form: { x: 1 } },
];

describe("<PresetSelector> custom preset UI", () => {
  it("save button hidden when no kind/currentForm (read-only mode)", () => {
    render(<PresetSelector
      presets={HARDCODED}
      onApply={() => {}}
    />);
    expect(screen.queryByTestId("preset-save")).toBeNull();
    expect(screen.queryByTestId("preset-delete")).toBeNull();
  });

  it("save button visible when kind+currentForm supplied", () => {
    render(<PresetSelector
      presets={HARDCODED}
      onApply={() => {}}
      kind="infer"
      currentForm={{ x: 99 }}
    />);
    expect(screen.getByTestId("preset-save")).toBeInTheDocument();
  });

  it("save button writes to localStorage and selects the new preset", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("My Saved"));
    render(<PresetSelector
      presets={HARDCODED}
      onApply={() => {}}
      kind="infer"
      currentForm={{ x: 99 }}
    />);
    await act(async () => {
      await user.click(screen.getByTestId("preset-save"));
    });
    const stored = loadCustomPresets("infer");
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("My Saved");
    expect(stored[0].form).toEqual({ x: 99 });
    // Newly saved preset auto-selected — verify its id is the active option.
    const sel = screen.getByTestId("preset-select") as HTMLSelectElement;
    expect(sel.value).toBe(stored[0].id);
  });

  it("user cancelling the prompt aborts save", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    vi.stubGlobal("prompt", vi.fn().mockReturnValue(null));  // cancel
    render(<PresetSelector
      presets={HARDCODED}
      onApply={() => {}}
      kind="infer"
      currentForm={{ x: 99 }}
    />);
    await act(async () => {
      await user.click(screen.getByTestId("preset-save"));
    });
    expect(loadCustomPresets("infer")).toEqual([]);
  });

  it("delete button appears only when a custom preset is selected", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    saveCustomPreset("infer", "Existing", { x: 5 });
    const stored = loadCustomPresets("infer");
    render(<PresetSelector
      presets={HARDCODED}
      onApply={() => {}}
      kind="infer"
      currentForm={{ x: 99 }}
    />);
    // Initially nothing selected → no delete button
    expect(screen.queryByTestId("preset-delete")).toBeNull();
    // Select hardcoded → still no delete (it's not custom)
    await act(async () => {
      await user.selectOptions(screen.getByTestId("preset-select"), "hc-1");
    });
    expect(screen.queryByTestId("preset-delete")).toBeNull();
    // Select custom → delete appears
    await act(async () => {
      await user.selectOptions(screen.getByTestId("preset-select"), stored[0].id);
    });
    expect(screen.getByTestId("preset-delete")).toBeInTheDocument();
  });

  it("delete confirms and removes the preset, clears selection", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    saveCustomPreset("infer", "ToDelete", { x: 5 });
    const stored = loadCustomPresets("infer");
    render(<PresetSelector
      presets={HARDCODED}
      onApply={() => {}}
      kind="infer"
      currentForm={{ x: 99 }}
    />);
    await act(async () => {
      await user.selectOptions(screen.getByTestId("preset-select"), stored[0].id);
    });
    await act(async () => {
      await user.click(screen.getByTestId("preset-delete"));
    });
    expect(loadCustomPresets("infer")).toEqual([]);
    expect(screen.queryByTestId("preset-delete")).toBeNull();
  });

  it("custom presets render under '自定义模板' optgroup", async () => {
    saveCustomPreset("infer", "Mine", { x: 1 });
    render(<PresetSelector
      presets={HARDCODED}
      onApply={() => {}}
      kind="infer"
      currentForm={{ x: 99 }}
    />);
    const sel = screen.getByTestId("preset-select") as HTMLSelectElement;
    const groups = Array.from(sel.querySelectorAll("optgroup"));
    expect(groups.map((g) => g.label)).toContain("自定义模板");
    expect(groups.map((g) => g.label)).toContain("预置场景");
  });
});
