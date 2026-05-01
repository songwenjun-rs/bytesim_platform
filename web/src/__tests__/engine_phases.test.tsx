/**
 * S4.1 — Pipeline phase stepper.
 *
 * Two layers:
 *   - `derivePhaseStatus` is pure; we drive it with crafted event sequences
 *     to lock the state-machine semantics. These are the contract:
 *        * first marker → active
 *        * subsequent marker → previous done, new active
 *        * err level → current failed, downstream pending
 *        * EOF + runStatus → reconciliation rules
 *        * cancelled marker → current cancelled
 *   - `<EnginePhases>` accepts an `events` prop as a test seam so we can
 *     render specific states without standing up a WebSocket.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  EnginePhases,
  PHASES,
  derivePhaseStatus,
  type Phase,
} from "../components/run/EnginePhases";

const ev = (msg: string, level: "info" | "warn" | "err" = "info") =>
  ({ type: "log" as const, msg, level });
const eof = () => ({ type: "eof" as const });

// ── Pure parser ────────────────────────────────────────────────────────────

describe("derivePhaseStatus", () => {
  it("returns all-pending for empty events", () => {
    const { status, activeIdx } = derivePhaseStatus([]);
    PHASES.forEach((p) => expect(status[p]).toBe("pending"));
    expect(activeIdx).toBeNull();
  });

  it("first PHASE marker activates that phase", () => {
    const { status, activeIdx } = derivePhaseStatus([
      ev("PHASE · validate · TP×PP×EP ≤ 1024 ✓"),
    ]);
    expect(status.validate).toBe("active");
    expect(status.baseline).toBe("pending");
    expect(activeIdx).toBe(0);
  });

  it("transitioning marker finalizes previous phase as done", () => {
    const { status, activeIdx } = derivePhaseStatus([
      ev("PHASE · validate · ✓"),
      ev("PHASE · baseline · default TP4·EP8"),
    ]);
    expect(status.validate).toBe("done");
    expect(status.baseline).toBe("active");
    expect(status.scan).toBe("pending");
    expect(activeIdx).toBe(1);
  });

  it("walks all five phases in order", () => {
    const { status, activeIdx } = derivePhaseStatus([
      ev("PHASE · validate · ok"),
      ev("PHASE · baseline · TP4"),
      ev("PHASE · scan · 5 candidates"),
      ev("PHASE · top-k · re-checking"),
      ev("PHASE · attribution · writing artifacts"),
    ]);
    expect(status.validate).toBe("done");
    expect(status.baseline).toBe("done");
    expect(status.scan).toBe("done");
    expect(status["top-k"]).toBe("done");
    expect(status.attribution).toBe("active");
    expect(activeIdx).toBe(4);
  });

  it("EOF + runStatus=done finalizes the last active to done", () => {
    const { status } = derivePhaseStatus(
      [
        ev("PHASE · validate · ok"),
        ev("PHASE · baseline · TP4"),
        ev("PHASE · attribution · done"),
        eof(),
      ],
      "done",
    );
    expect(status.attribution).toBe("done");
    // Phases the engine never started stay pending — UI shows "未触发"
    // rather than fabricating "done".
    expect(status.scan).toBe("pending");
    expect(status["top-k"]).toBe("pending");
  });

  it("err-level event marks current active as failed", () => {
    const { status } = derivePhaseStatus([
      ev("PHASE · validate · ok"),
      ev("PHASE · baseline · TP4"),
      ev("baseline KPI worker crashed", "err"),
    ]);
    expect(status.validate).toBe("done");
    expect(status.baseline).toBe("failed");
    expect(status.scan).toBe("pending");
  });

  it("post-error PHASE markers do not flip a failed phase back to active", () => {
    const { status } = derivePhaseStatus([
      ev("PHASE · validate · ok"),
      ev("baseline crashed", "err"),
      ev("PHASE · baseline · retry"),
    ]);
    // Once we've seen err, downstream PHASE markers paint failed, not active
    expect(status.baseline).toBe("failed");
  });

  it("cancelled marker downgrades active phase and clears downstream", () => {
    const { status, activeIdx } = derivePhaseStatus([
      ev("PHASE · validate · ok"),
      ev("PHASE · scan · 5 candidates"),
      ev("PHASE · cancelled · user requested"),
    ]);
    expect(status.scan).toBe("cancelled");
    expect(status["top-k"]).toBe("pending");
    expect(activeIdx).toBeNull();
  });

  it("runStatus=cancelled at EOF flips active phase to cancelled", () => {
    const { status } = derivePhaseStatus(
      [ev("PHASE · scan · 5 candidates"), eof()],
      "cancelled",
    );
    expect(status.scan).toBe("cancelled");
  });
});

// ── Component ──────────────────────────────────────────────────────────────

describe("<EnginePhases>", () => {
  it("renders all 5 phase tiles in pending state when no events", () => {
    render(<EnginePhases runId="r1" events={[]} />);
    PHASES.forEach((p: Phase) => {
      const tile = screen.getByTestId(`phase-${p}`);
      expect(tile.dataset.state).toBe("pending");
    });
    expect(screen.getByText("未开始")).toBeInTheDocument();
  });

  it("renders header with current phase progress", () => {
    render(<EnginePhases runId="r1" events={[
      ev("PHASE · validate · ok"),
      ev("PHASE · scan · 5"),
    ]} />);
    expect(screen.getByText(/阶段 3 \/ 5 · 扫描候选/)).toBeInTheDocument();
    expect(screen.getByTestId("phase-validate").dataset.state).toBe("done");
    expect(screen.getByTestId("phase-baseline").dataset.state).toBe("pending");
    expect(screen.getByTestId("phase-scan").dataset.state).toBe("active");
  });

  it("renders failed state when run errored mid-phase", () => {
    render(<EnginePhases
      runId="r1"
      runStatus="failed"
      events={[
        ev("PHASE · validate · ok"),
        ev("PHASE · baseline · TP4"),
        ev("crash", "err"),
        eof(),
      ]}
    />);
    expect(screen.getByTestId("phase-validate").dataset.state).toBe("done");
    expect(screen.getByTestId("phase-baseline").dataset.state).toBe("failed");
  });
});
