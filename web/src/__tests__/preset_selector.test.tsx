/**
 * S5.1 — PresetSelector + presets data integrity.
 *
 * Lock:
 *   - Each preset id is unique and stable (URL state / e2e refer by id).
 *   - Inference / Training each have ≥ 5 presets.
 *   - Selecting a preset fires onApply with the full form payload.
 *   - "— 不使用模板 —" option does NOT call onApply (clears selection).
 *   - desc text appears next to the dropdown post-selection.
 *   - Presets pass an internal sanity check: TP×PP×EP×CP ≤ gpu_count.
 */
import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { PresetSelector } from "../components/sim/PresetSelector";
import {
  INFERENCE_PRESETS,
  TRAINING_PRESETS,
  type InferencePresetForm,
} from "../components/sim/presets";

// ── Data integrity ─────────────────────────────────────────────────────────

describe("preset catalogue", () => {
  it("inference has at least 5 presets with unique ids", () => {
    expect(INFERENCE_PRESETS.length).toBeGreaterThanOrEqual(5);
    const ids = INFERENCE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("training has at least 4 presets with unique ids", () => {
    // Curated to the 4 Astra-sim-compatible Llama-3.1 dense scenarios; the
    // floor was originally 5 (5 mixed-MoE legacy presets) but trimmed when
    // we standardised on dense-only training scenarios.
    expect(TRAINING_PRESETS.length).toBeGreaterThanOrEqual(4);
    const ids = TRAINING_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every inference preset's parallelism fits within gpu_count", () => {
    for (const p of INFERENCE_PRESETS) {
      const cap = p.form.TP * p.form.PP * p.form.EP * p.form.CP;
      expect(cap, `${p.id} has TP×PP×EP×CP=${cap} > ${p.form.gpu_count}`)
        .toBeLessThanOrEqual(p.form.gpu_count);
    }
  });

  it("every training preset's parallelism fits within gpu_count", () => {
    for (const p of TRAINING_PRESETS) {
      const cap = p.form.TP * p.form.PP * p.form.EP * p.form.CP;
      expect(cap, `${p.id} has TP×PP×EP×CP=${cap} > ${p.form.gpu_count}`)
        .toBeLessThanOrEqual(p.form.gpu_count);
    }
  });

  it("every preset has a non-empty desc and name", () => {
    for (const p of [...INFERENCE_PRESETS, ...TRAINING_PRESETS]) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.desc.length).toBeGreaterThan(0);
    }
  });
});

// ── Component ──────────────────────────────────────────────────────────────

// Pick a stable target preset (deepseek-v3-671b-moe — H200 64-GPU MoE).
// Tests assert on its known fields rather than hardcoding "MoE in desc"
// so future preset wording tweaks don't trip the suite.
const TARGET_ID = "deepseek-v3-671b-moe";
const TARGET = INFERENCE_PRESETS.find((p) => p.id === TARGET_ID)!;

describe("<PresetSelector>", () => {
  it("renders all presets as options + a 'no template' default", () => {
    render(<PresetSelector<InferencePresetForm>
      presets={INFERENCE_PRESETS}
      onApply={() => {}}
    />);
    const sel = screen.getByTestId("preset-select") as HTMLSelectElement;
    // +1 for the "no template" option
    expect(sel.options.length).toBe(INFERENCE_PRESETS.length + 1);
    expect(sel.options[0].value).toBe("");
  });

  it("calls onApply with the full form payload when a preset is selected", async () => {
    const onApply = vi.fn();
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<PresetSelector<InferencePresetForm>
      presets={INFERENCE_PRESETS}
      onApply={onApply}
    />);
    const sel = screen.getByTestId("preset-select");
    await act(async () => {
      await user.selectOptions(sel, TARGET_ID);
    });
    expect(onApply).toHaveBeenCalledOnce();
    const arg = onApply.mock.calls[0][0];
    expect(arg.gpu_model).toBe(TARGET.form.gpu_model);
    expect(arg.gpu_count).toBe(TARGET.form.gpu_count);
    expect(arg.prefix_share_ratio).toBe(TARGET.form.prefix_share_ratio);
  });

  it("shows the preset's info grid after selection", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<PresetSelector<InferencePresetForm>
      presets={INFERENCE_PRESETS}
      onApply={() => {}}
    />);
    expect(screen.queryByTestId("preset-info-grid")).toBeNull();
    await act(async () => {
      await user.selectOptions(screen.getByTestId("preset-select"), TARGET_ID);
    });
    const grid = screen.getByTestId("preset-info-grid");
    // Grid renders the preset's TP/PP/EP/CP, GPU model+count etc.
    expect(grid.textContent).toContain(String(TARGET.form.gpu_count));
    expect(grid.textContent).toContain(TARGET.form.gpu_model);
  });

  it("re-selecting the empty option does NOT call onApply (intent: clear UI only)", async () => {
    const onApply = vi.fn();
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<PresetSelector<InferencePresetForm>
      presets={INFERENCE_PRESETS}
      onApply={onApply}
    />);
    const sel = screen.getByTestId("preset-select");
    await act(async () => {
      await user.selectOptions(sel, TARGET_ID);   // 1 call
      await user.selectOptions(sel, "");          // should NOT call again
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("preset-info-grid")).toBeNull();
  });
});
