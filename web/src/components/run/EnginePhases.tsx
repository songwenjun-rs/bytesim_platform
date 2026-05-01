/**
 * S4.1 — Engine pipeline phase stepper.
 *
 * The five-stage pipeline (validate → baseline → scan → top-k → attribution)
 * already emits `PHASE · <stage> · <msg>` markers into the WebSocket log
 * stream (see services/engine-svc/app/pipeline.py:_stage). This component
 * subscribes to the same stream, parses markers client-side, and renders
 * the progress as a stepper so the user isn't staring at a flat scrolling
 * log to figure out where the run is.
 *
 * No backend change required — the markers are already there. If a future
 * pipeline change adds/renames stages, only the PHASES list and parser
 * here move; the WS contract stays.
 */
import { useEffect, useState } from "react";
import { wsURL } from "../../api/client";

export const PHASES = [
  "validate", "baseline", "scan", "top-k", "attribution",
] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseState =
  | "pending" | "active" | "done" | "failed" | "cancelled";

const PHASE_LABEL: Record<Phase, string> = {
  validate:    "校验",
  baseline:    "基线",
  scan:        "扫描候选",
  "top-k":     "Top-K 重核",
  attribution: "归因汇总",
};

type LogEvent = {
  type?: "log" | "eof";
  msg?: string;
  level?: "info" | "warn" | "err";
};

const PHASE_RE = /PHASE\s+·\s+([a-z\-]+)/i;

/**
 * Pure parser — no React state, fully testable. Walks events in order,
 * transitions phases, and applies stream-end / cancellation rules:
 *
 *   - First `PHASE · X` marker sets X to "active".
 *   - Subsequent `PHASE · Y` (Y ≠ X) finalizes X to "done", Y to "active".
 *   - `PHASE · cancelled` marks the current active phase "cancelled".
 *   - On EOF (`type === "eof"`), if `runStatus === "done"` ⇒ all phases up
 *     to and including the last active flip to "done"; "failed" ⇒ last
 *     active flips to "failed".
 *   - Any `level === "err"` event flips the current active phase "failed"
 *     and stops upgrading subsequent phases.
 */
export function derivePhaseStatus(
  events: LogEvent[],
  runStatus?: "queued" | "running" | "done" | "failed" | "cancelled" | string,
): { status: Record<Phase, PhaseState>; activeIdx: number | null } {
  const status: Record<Phase, PhaseState> = {
    validate: "pending", baseline: "pending", scan: "pending",
    "top-k": "pending", attribution: "pending",
  };
  let activeIdx: number | null = null;
  let sawError = false;
  let sawEof = false;

  for (const ev of events) {
    if (ev.type === "eof") { sawEof = true; continue; }
    const msg = ev.msg ?? "";
    const m = msg.match(PHASE_RE);

    if (m) {
      const stage = m[1].toLowerCase();
      if (stage === "cancelled" && activeIdx !== null) {
        status[PHASES[activeIdx]] = "cancelled";
        for (let i = activeIdx + 1; i < PHASES.length; i++) {
          status[PHASES[i]] = "pending";
        }
        activeIdx = null;
        continue;
      }
      const idx = (PHASES as readonly string[]).indexOf(stage);
      if (idx >= 0) {
        // Finalize previous active as done (unless it errored)
        if (activeIdx !== null && activeIdx !== idx) {
          status[PHASES[activeIdx]] = sawError ? "failed" : "done";
        }
        status[PHASES[idx]] = sawError ? "failed" : "active";
        activeIdx = idx;
      }
    } else if (ev.level === "err" && activeIdx !== null) {
      // Mark current active as failed; downstream phases stay pending.
      status[PHASES[activeIdx]] = "failed";
      sawError = true;
    }
  }

  // Apply stream-end / runStatus reconciliation.
  if (sawEof || runStatus === "done" || runStatus === "failed" || runStatus === "cancelled") {
    if (activeIdx !== null) {
      const cur = status[PHASES[activeIdx]];
      if (cur === "active") {
        if (runStatus === "failed") status[PHASES[activeIdx]] = "failed";
        else if (runStatus === "cancelled") status[PHASES[activeIdx]] = "cancelled";
        else status[PHASES[activeIdx]] = "done";
      }
    }
    if (runStatus === "done") {
      // Run finished; everything we touched is done. Phases we never saw
      // a marker for (engine skipped a stage) we leave pending — better to
      // show "skipped/未触发" via pending than to lie about it.
      for (let i = 0; i <= (activeIdx ?? PHASES.length - 1); i++) {
        if (status[PHASES[i]] === "active") status[PHASES[i]] = "done";
      }
    }
  }

  return { status, activeIdx };
}

// ── Component ──────────────────────────────────────────────────────────────

const STATE_DOT: Record<PhaseState, string> = {
  pending: "status-idle",
  active:  "status-run",
  done:    "status-ok",
  failed:  "status-fail",
  cancelled: "status-wait",
};

const STATE_LABEL: Record<PhaseState, string> = {
  pending: "等待",
  active:  "进行中",
  done:    "完成",
  failed:  "失败",
  cancelled: "取消",
};

type Props = {
  runId: string;
  runStatus?: string;
  /** Test seam: pass events directly instead of opening a WebSocket. */
  events?: LogEvent[];
};

export function EnginePhases({ runId, runStatus, events: overrideEvents }: Props) {
  const [events, setEvents] = useState<LogEvent[]>([]);

  useEffect(() => {
    if (overrideEvents !== undefined) return;  // test mode
    setEvents([]);
    const ws = new WebSocket(wsURL(`/v1/streams/run/${runId}/log`));
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as LogEvent;
        setEvents((prev) => [...prev, ev]);
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, [runId, overrideEvents]);

  const usedEvents = overrideEvents ?? events;
  const { status, activeIdx } = derivePhaseStatus(usedEvents, runStatus);

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="engine-phases">
      <div className="card-head">
        <div className="card-t">仿真进度</div>
        <div className="card-x">
          {activeIdx === null
            ? "未开始"
            : `阶段 ${activeIdx + 1} / ${PHASES.length} · ${PHASE_LABEL[PHASES[activeIdx]]}`}
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${PHASES.length}, 1fr)`,
          gap: 8,
        }}
      >
        {PHASES.map((p, i) => {
          const st = status[p];
          const dim = st === "pending";
          return (
            <div
              key={p}
              data-testid={`phase-${p}`}
              data-state={st}
              style={{
                padding: "10px 12px",
                background: "var(--surface-2)",
                border: "1px solid var(--hairline)",
                borderRadius: 6,
                opacity: dim ? 0.55 : 1,
                position: "relative",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span className={`status-dot ${STATE_DOT[st]}`} />
                <span style={{ fontSize: 11, color: "var(--t3)" }}>步骤 {i + 1}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{PHASE_LABEL[p]}</div>
              <div style={{ fontSize: 10.5, color: "var(--t3)", marginTop: 2 }}>
                {STATE_LABEL[st]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
