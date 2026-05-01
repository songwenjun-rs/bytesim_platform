/**
 * Experiment JSON serialize/parse + PresetSelector export/import buttons.
 *
 * Locks:
 *   - Round-trip: serialize then parse yields the original form.
 *   - Schema rejects: missing $schema, version too high, wrong kind, no form.
 *   - PresetSelector renders 📤 only when canSave; 📂 always (when kind given).
 *   - Import file with mismatched kind shows a toast and does NOT apply.
 *   - Import success calls onApply with the form payload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import {
  serializeExperiment, parseExperiment,
} from "../components/sim/experimentJson";
import { PresetSelector } from "../components/sim/PresetSelector";

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Pure serialize/parse ───────────────────────────────────────────────────

describe("experimentJson", () => {
  it("round-trip: serialize → parse yields equivalent form", () => {
    const json = serializeExperiment("infer", "DeepSeek-V3 32xH200", {
      gpu_count: 32, prefix_share_ratio: 0.7,
    });
    const r = parseExperiment(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.experiment.kind).toBe("infer");
      expect(r.experiment.title).toBe("DeepSeek-V3 32xH200");
      expect(r.experiment.form.gpu_count).toBe(32);
      expect(r.experiment.form.prefix_share_ratio).toBe(0.7);
    }
  });

  it("rejects malformed JSON", () => {
    const r = parseExperiment("{not valid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("解析失败");
  });

  it("rejects payload without $schema", () => {
    const r = parseExperiment(JSON.stringify({ version: 1, kind: "infer", form: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("schema");
  });

  it("rejects payload with future version", () => {
    const r = parseExperiment(JSON.stringify({
      $schema: "bytesim.experiment.v1", version: 99,
      kind: "infer", form: {},
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("版本");
  });

  it("rejects payload with bad kind", () => {
    const r = parseExperiment(JSON.stringify({
      $schema: "bytesim.experiment.v1", version: 1,
      kind: "training",  // wrong (should be 'train')
      form: {},
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kind");
  });

  it("rejects payload missing form", () => {
    const r = parseExperiment(JSON.stringify({
      $schema: "bytesim.experiment.v1", version: 1, kind: "infer",
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("form");
  });
});

// ── PresetSelector buttons ─────────────────────────────────────────────────

describe("<PresetSelector> JSON buttons", () => {
  it("📤 button only renders when canSave (kind + currentForm)", () => {
    render(<PresetSelector
      presets={[]}
      onApply={() => {}}
      kind="infer"
      currentForm={{ x: 1 }}
    />);
    expect(screen.getByTestId("preset-export-json")).toBeInTheDocument();
  });

  it("📂 button renders whenever kind is provided (even read-only)", () => {
    render(<PresetSelector
      presets={[]}
      onApply={() => {}}
      kind="infer"
    />);
    expect(screen.queryByTestId("preset-export-json")).toBeNull();  // no currentForm
    expect(screen.getByTestId("preset-import-json")).toBeInTheDocument();
  });

  it("clicking 📤 triggers a download (anchor click on a Blob URL)", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const clickSpy = vi.fn();
    // Intercept the synthetic anchor created by downloadExperiment.
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") (el as HTMLAnchorElement).click = clickSpy;
      return el;
    });
    // Stub URL.createObjectURL — happy-dom may not implement it.
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:fake", revokeObjectURL: () => {} });

    render(<PresetSelector
      presets={[]}
      onApply={() => {}}
      kind="infer"
      currentForm={{ title: "demo", x: 1 }}
    />);
    await act(async () => {
      await user.click(screen.getByTestId("preset-export-json"));
    });
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it("import: valid JSON with matching kind calls onApply", async () => {
    const onApply = vi.fn();
    render(<PresetSelector
      presets={[]}
      onApply={onApply}
      kind="infer"
      currentForm={{ x: 1 }}
    />);
    const input = screen.getByTestId("preset-import-input") as HTMLInputElement;
    const json = serializeExperiment("infer", "imported", { gpu_count: 64, foo: "bar" });
    const file = new File([json], "exp.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], writable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // wait a microtask for FileReader resolution
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0][0]).toEqual({ gpu_count: 64, foo: "bar" });
  });

  it("import: kind mismatch does NOT call onApply", async () => {
    const onApply = vi.fn();
    render(<PresetSelector
      presets={[]}
      onApply={onApply}
      kind="infer"
      currentForm={{ x: 1 }}
    />);
    const input = screen.getByTestId("preset-import-input") as HTMLInputElement;
    // Export as 'train' but page is 'infer' — mismatch
    const json = serializeExperiment("train", "wrong-kind", { gpu_count: 1024 });
    const file = new File([json], "exp.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], writable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(onApply).not.toHaveBeenCalled();
  });

  it("import: malformed JSON does NOT call onApply", async () => {
    const onApply = vi.fn();
    render(<PresetSelector
      presets={[]}
      onApply={onApply}
      kind="infer"
      currentForm={{ x: 1 }}
    />);
    const input = screen.getByTestId("preset-import-input") as HTMLInputElement;
    const file = new File(["not-json"], "exp.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], writable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(onApply).not.toHaveBeenCalled();
  });
});
