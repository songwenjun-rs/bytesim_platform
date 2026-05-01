/**
 * S5.3 — Business-level constraint checks.
 *
 * Tier semantics matter as much as the rules themselves:
 *   - error blocks submit
 *   - warn permits submit (fires anyway, with caution)
 *   - info is purely advisory
 *
 * Tests cover the contract for each rule individually + the panel
 * rendering tiers in correct order.
 */
import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import {
  checkInference, checkTraining, hasErrors,
} from "../components/sim/constraints";
import { ConstraintsPanel } from "../components/sim/ConstraintsPanel";
import type {
  InferencePresetForm, TrainingPresetForm,
} from "../components/sim/presets";

const baseInfer = (over: Partial<InferencePresetForm> = {}): InferencePresetForm => ({
  title: "x",
  gpu_model: "H200", gpu_count: 32,
  electricity_usd_per_kwh: 0.092, pue: 1.18,
  activated_params_b: 37, total_params_b: 671,
  seq_len: 4096, quant: "FP8",
  kv_size_gb_per_seq: 0.020, prefix_share_ratio: 0.7,
  page_size_kb: 16, avg_active_seqs: 256,
  TP: 8, PP: 1, EP: 4, CP: 1,
  slo_ttft_p99_ms: 200, slo_tpot_ms: 40,
  ...over,
});

const baseTrain = (over: Partial<TrainingPresetForm> = {}): TrainingPresetForm => ({
  title: "x",
  gpu_model: "B200", gpu_count: 1024,
  electricity_usd_per_kwh: 0.092, pue: 1.18,
  activated_params_b: 405, total_params_b: 405,
  seq_len: 8192, global_batch: 4096, quant: "FP8",
  TP: 8, PP: 8, EP: 1, CP: 2,
  recompute: "selective", overlap: "ZBv2",
  ...over,
});

// ── Inference rules ────────────────────────────────────────────────────────

describe("checkInference", () => {
  it("baseline preset is clean (no constraints)", () => {
    const cs = checkInference(baseInfer());
    expect(cs).toEqual([]);
    expect(hasErrors(cs)).toBe(false);
  });

  it("flags TP×PP×EP×CP > gpu_count as error", () => {
    const cs = checkInference(baseInfer({ TP: 8, PP: 8, EP: 1, CP: 1, gpu_count: 32 }));
    const c = cs.find((c) => c.id === "parallel_overcommit")!;
    expect(c.level).toBe("error");
    expect(c.msg).toContain("TP×PP×EP×CP = 64");
  });

  it("flags KV working set > total HBM as error", () => {
    // 32 × H200 = 32 × 141 GB = 4512 GB total
    // 1024 active × 5 GB/seq = 5120 GB > 4512 → error
    const cs = checkInference(baseInfer({ avg_active_seqs: 1024, kv_size_gb_per_seq: 5.0 }));
    const c = cs.find((c) => c.id === "kv_exceeds_total_hbm")!;
    expect(c.level).toBe("error");
  });

  it("flags KV working set > 80% HBM as warn", () => {
    // Working set ≈ 80% of HBM ⇒ warn but not error
    // 32 × 141 = 4512 GB, 80% ≈ 3610 GB
    // 256 active × 14.2 GB ≈ 3635 GB
    const cs = checkInference(baseInfer({ avg_active_seqs: 256, kv_size_gb_per_seq: 14.2 }));
    const c = cs.find((c) => c.id === "kv_near_hbm");
    expect(c?.level).toBe("warn");
    expect(hasErrors(cs)).toBe(false);
  });

  it("flags TP > NVLink domain as warn (cross-machine TP perf cliff)", () => {
    // H200 nvlink_domain = 32. TP=64 > 32.
    // gpu_count=64 to keep parallel capacity feasible.
    const cs = checkInference(baseInfer({ TP: 64, gpu_count: 64, EP: 1, PP: 1 }));
    const c = cs.find((c) => c.id === "tp_cross_nvlink")!;
    expect(c.level).toBe("warn");
    expect(c.msg).toContain("NVLink 域 32");
  });

  it("flags prefix=0 + chat-level SLO as warn", () => {
    const cs = checkInference(baseInfer({
      prefix_share_ratio: 0.0, slo_ttft_p99_ms: 200,
    }));
    const c = cs.find((c) => c.id === "prefix_zero_chat_slo")!;
    expect(c.level).toBe("warn");
  });

  it("does NOT flag prefix=0 with batch-level SLO (TTFT > 250ms)", () => {
    const cs = checkInference(baseInfer({
      prefix_share_ratio: 0.0, slo_ttft_p99_ms: 600,
    }));
    expect(cs.find((c) => c.id === "prefix_zero_chat_slo")).toBeUndefined();
  });

  it("flags seq ≥ 8k with CP=1 as info", () => {
    const cs = checkInference(baseInfer({ seq_len: 8192, CP: 1 }));
    const c = cs.find((c) => c.id === "seq_long_low_cp")!;
    expect(c.level).toBe("info");
    expect(hasErrors(cs)).toBe(false);
  });

  it("returns multiple constraints simultaneously (does not stop at first)", () => {
    // TP=64 exceeds NVLink (warn) AND prefix=0 with chat SLO (warn)
    const cs = checkInference(baseInfer({
      TP: 64, gpu_count: 64, EP: 1, PP: 1,
      prefix_share_ratio: 0.0, slo_ttft_p99_ms: 180,
    }));
    expect(cs.find((c) => c.id === "tp_cross_nvlink")).toBeDefined();
    expect(cs.find((c) => c.id === "prefix_zero_chat_slo")).toBeDefined();
  });
});

// ── Training rules ─────────────────────────────────────────────────────────

describe("checkTraining", () => {
  it("default preset is clean", () => {
    const cs = checkTraining(baseTrain());
    expect(cs).toEqual([]);
  });

  it("flags overcommit as error", () => {
    const cs = checkTraining(baseTrain({ TP: 32, PP: 32, EP: 1, CP: 1, gpu_count: 256 }));
    expect(cs.find((c) => c.id === "parallel_overcommit")?.level).toBe("error");
  });

  it("flags TP > NVLink (B200 domain = 72) only when actually exceeded", () => {
    // TP=72 OK on B200; TP=128 not OK
    const okCs = checkTraining(baseTrain({ TP: 8, gpu_count: 1024 }));
    expect(okCs.find((c) => c.id === "tp_cross_nvlink")).toBeUndefined();
    const badCs = checkTraining(baseTrain({ TP: 128, gpu_count: 1024, EP: 1, PP: 1, CP: 1 }));
    expect(badCs.find((c) => c.id === "tp_cross_nvlink")?.level).toBe("warn");
  });

  it("flags large cluster + PP=1 as info (idiomatic hint)", () => {
    const cs = checkTraining(baseTrain({ PP: 1, TP: 8, EP: 1, CP: 1, gpu_count: 64 }));
    expect(cs.find((c) => c.id === "large_cluster_no_pp")?.level).toBe("info");
  });

  it("does NOT flag PP=1 on small cluster (single-node training)", () => {
    const cs = checkTraining(baseTrain({ PP: 1, TP: 8, EP: 1, CP: 1, gpu_count: 8 }));
    expect(cs.find((c) => c.id === "large_cluster_no_pp")).toBeUndefined();
  });
});

// ── Panel rendering ────────────────────────────────────────────────────────

describe("<ConstraintsPanel>", () => {
  it("shows the empty-state banner when no constraints", () => {
    render(<ConstraintsPanel constraints={[]} />);
    expect(screen.getByTestId("constraints-empty")).toBeInTheDocument();
    expect(screen.getByText(/无明显问题/)).toBeInTheDocument();
  });

  it("orders error → warn → info regardless of input order", () => {
    render(<ConstraintsPanel constraints={[
      { level: "info",  id: "a", msg: "info-a" },
      { level: "error", id: "b", msg: "err-b" },
      { level: "warn",  id: "c", msg: "warn-c" },
    ]} />);
    const panel = screen.getByTestId("constraints-panel");
    const ids = Array.from(panel.children).map(
      (el) => (el as HTMLElement).getAttribute("data-testid"),
    );
    expect(ids).toEqual([
      "constraint-b",  // error first
      "constraint-c",  // warn next
      "constraint-a",  // info last
    ]);
  });

  it("data-level attribute matches each constraint's tier", () => {
    render(<ConstraintsPanel constraints={[
      { level: "error", id: "x", msg: "x" },
      { level: "warn",  id: "y", msg: "y" },
      { level: "info",  id: "z", msg: "z" },
    ]} />);
    expect(screen.getByTestId("constraint-x").dataset.level).toBe("error");
    expect(screen.getByTestId("constraint-y").dataset.level).toBe("warn");
    expect(screen.getByTestId("constraint-z").dataset.level).toBe("info");
  });
});

// ── S5.4 quick-fix ─────────────────────────────────────────────────────────

describe("constraint quick-fix actions", () => {
  it("seq>=8k + CP=1 emits an info constraint with CP=2 fix patch", () => {
    const cs = checkInference(baseInfer({ seq_len: 8192, CP: 1 }));
    const c = cs.find((c) => c.id === "seq_long_low_cp")!;
    expect(c.fix).toBeDefined();
    expect(c.fix!.label).toContain("CP=2");
    expect(c.fix!.patch).toEqual({ CP: 2 });
  });

  it("TP > NVLink (H200=32) emits TP=<domain> fix patch", () => {
    const cs = checkInference(baseInfer({ TP: 64, gpu_count: 64, EP: 1, PP: 1 }));
    const c = cs.find((c) => c.id === "tp_cross_nvlink")!;
    expect(c.fix!.patch).toEqual({ TP: 32 });  // H200 nvlink_domain
  });

  it("prefix=0 + chat SLO emits prefix=0.5 fix patch", () => {
    const cs = checkInference(baseInfer({
      prefix_share_ratio: 0.0, slo_ttft_p99_ms: 200,
    }));
    const c = cs.find((c) => c.id === "prefix_zero_chat_slo")!;
    expect(c.fix!.patch).toEqual({ prefix_share_ratio: 0.5 });
  });

  it("training large-cluster + PP=1 emits PP=4 fix patch", () => {
    const cs = checkTraining(baseTrain({ PP: 1, TP: 8, EP: 1, CP: 1, gpu_count: 64 }));
    const c = cs.find((c) => c.id === "large_cluster_no_pp")!;
    expect(c.fix!.patch).toEqual({ PP: 4 });
  });

  it("error-level constraints have no fix (no single-button remedy)", () => {
    const cs = checkInference(baseInfer({ TP: 8, PP: 8, EP: 1, CP: 1, gpu_count: 32 }));
    const c = cs.find((c) => c.id === "parallel_overcommit")!;
    expect(c.level).toBe("error");
    expect(c.fix).toBeUndefined();
  });

  it("ConstraintsPanel renders fix button only when fix + onFix both supplied", async () => {
    const onFix = vi.fn();
    render(<ConstraintsPanel
      constraints={[
        { level: "info", id: "with_fix", msg: "x",
          fix: { label: "应用 CP=2", patch: { CP: 2 } } },
        { level: "info", id: "no_fix", msg: "y" },
      ]}
      onFix={onFix}
    />);
    expect(screen.getByTestId("constraint-fix-with_fix")).toBeInTheDocument();
    expect(screen.queryByTestId("constraint-fix-no_fix")).toBeNull();
  });

  it("clicking fix button invokes onFix with the patch", async () => {
    const onFix = vi.fn();
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<ConstraintsPanel
      constraints={[
        { level: "info", id: "x", msg: "y",
          fix: { label: "应用 CP=2", patch: { CP: 2 } } },
      ]}
      onFix={onFix}
    />);
    await act(async () => {
      await user.click(screen.getByTestId("constraint-fix-x"));
    });
    expect(onFix).toHaveBeenCalledWith({ CP: 2 });
  });

  it("ConstraintsPanel without onFix renders no fix buttons even when fix set", () => {
    render(<ConstraintsPanel constraints={[
      { level: "info", id: "x", msg: "y",
        fix: { label: "应用 CP=2", patch: { CP: 2 } } },
    ]} />);
    expect(screen.queryByTestId("constraint-fix-x")).toBeNull();
  });
});
