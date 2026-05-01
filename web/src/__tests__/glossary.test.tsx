/**
 * S5.2 — Glossary catalog + SimField popover.
 *
 * Locks:
 *   - Catalog covers the 13 keys actually used by Sim pages today.
 *     New keys must come with content; missing-content drift will fail
 *     this test instead of silently degrading the UI to "no popover".
 *   - SimField with `term=` renders ⓘ icon; click toggles popover.
 *   - Unknown term silently degrades to no icon (typo-tolerant).
 *   - Popover content includes title + desc + typical when present.
 */
import { describe, it, expect } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { SimField } from "../components/sim/SimForm";
import { GLOSSARY, getGlossary } from "../components/sim/glossary";

// ── Catalog integrity ─────────────────────────────────────────────────────

describe("glossary catalog", () => {
  // The keys Sim pages actively pass via `term=`. Anyone removing one
  // here without removing the SimField usage would degrade the popover
  // silently — this test catches that.
  const REQUIRED_KEYS = [
    "TP", "PP", "EP", "CP", "recompute", "overlap",
    "kv_size_gb_per_seq", "prefix_share_ratio", "page_size_kb",
    "avg_active_seqs", "slo_ttft_p99_ms", "slo_tpot_ms", "global_batch",
  ];

  it("contains every key used in the Sim forms", () => {
    for (const k of REQUIRED_KEYS) {
      expect(GLOSSARY[k], `glossary missing key '${k}'`).toBeDefined();
    }
  });

  it("every entry has a non-empty title and description", () => {
    for (const [k, e] of Object.entries(GLOSSARY)) {
      expect(e.title.length, `${k} title empty`).toBeGreaterThan(0);
      expect(e.desc.length, `${k} desc empty`).toBeGreaterThan(20);
    }
  });

  it("getGlossary returns null for unknown / empty keys", () => {
    expect(getGlossary(undefined)).toBeNull();
    expect(getGlossary("")).toBeNull();
    expect(getGlossary("does_not_exist")).toBeNull();
  });

  it("getGlossary returns the entry for known keys", () => {
    const e = getGlossary("TP")!;
    expect(e).not.toBeNull();
    expect(e.title).toContain("张量并行");
    expect(e.english).toBe("Tensor Parallelism");
  });
});

// ── SimField popover ──────────────────────────────────────────────────────

describe("<SimField> glossary popover", () => {
  it("does not render ⓘ icon when no term prop", () => {
    render(<SimField label="GPU 数量"><input /></SimField>);
    expect(screen.queryByLabelText(/查看/)).toBeNull();
  });

  it("renders ⓘ icon when term resolves in catalog", () => {
    render(<SimField label="TP" term="TP"><input /></SimField>);
    expect(screen.getByTestId("sim-glossary-toggle-TP")).toBeInTheDocument();
  });

  it("silently degrades for unknown term (typo tolerance)", () => {
    render(<SimField label="X" term="nonexistent_key"><input /></SimField>);
    // No icon, no popover slot
    expect(screen.queryByTestId("sim-glossary-toggle-nonexistent_key")).toBeNull();
  });

  it("toggle button shows the popover with title/desc/typical", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<SimField label="TP" term="TP"><input /></SimField>);
    expect(screen.queryByTestId("sim-glossary-popover-TP")).toBeNull();

    await act(async () => {
      await user.click(screen.getByTestId("sim-glossary-toggle-TP"));
    });

    const popover = screen.getByTestId("sim-glossary-popover-TP");
    expect(popover.textContent).toContain("张量并行");
    expect(popover.textContent).toContain("Tensor Parallelism");
    expect(popover.textContent).toContain("intra-layer");
    expect(popover.textContent).toContain("典型值");
  });

  it("toggle button collapses the popover on second click", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<SimField label="TP" term="TP"><input /></SimField>);
    const toggle = screen.getByTestId("sim-glossary-toggle-TP");
    await act(async () => { await user.click(toggle); });
    expect(screen.getByTestId("sim-glossary-popover-TP")).toBeInTheDocument();
    await act(async () => { await user.click(toggle); });
    expect(screen.queryByTestId("sim-glossary-popover-TP")).toBeNull();
  });

  it("hint and term coexist (hint on right of icon)", () => {
    render(<SimField label="EP" term="EP" hint="dense 用 1"><input /></SimField>);
    expect(screen.getByTestId("sim-glossary-toggle-EP")).toBeInTheDocument();
    expect(screen.getByText(/dense 用 1/)).toBeInTheDocument();
  });
});
