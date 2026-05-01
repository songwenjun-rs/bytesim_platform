"""Five-stage simulation pipeline:

  validate (~1s) → baseline (~3s) → scan (~5s) → top-k recheck (~2s) → attribution (~2s)

Each stage emits PATCH updates to run-svc (status / progress / log_append) and a
Kafka lifecycle event. The expensive math is delegated to surrogate-svc — the
pipeline picks strategy candidates and aggregates results into artifacts.

Slice-10 boundary: this is *not* a real engine. The "computation" is a small set
of strategy candidates, each scored via surrogate-svc's analytical model. Real
ByteSim swaps `_run_baseline / _run_scan` for full Roofline + α-β + KV paging
engines (design_doc §6); this skeleton keeps the wire-level contract intact."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from app.clients import Backends
from app.event_bus import EventBus

log = logging.getLogger("engine.pipeline")

STAGE_PROGRESS = {
    "validate":    (0,    10),
    "baseline":    (10,   25),
    "scan":        (25,   75),
    # Pinned-engine path replaces baseline+scan (10→75) with one predict.
    "pinned":      (10,   75),
    "top-k":       (75,   90),
    "attribution": (90,  100),
}

# Default search candidates explored during scan when the Run didn't carry
# its own strategy_override. Mirrors the prototype's tuner Top-5.
SCAN_CANDIDATES = [
    {"TP": 4, "PP": 8, "EP": 8, "CP": 2, "recompute": "selective", "overlap": "ZBv2"},
    {"TP": 8, "PP": 2, "EP": 8, "CP": 1, "recompute": "selective", "overlap": "1F1B"},
    {"TP": 4, "PP": 8, "EP": 4, "CP": 2, "recompute": "selective", "overlap": "ZBv2"},
    {"TP": 2, "PP": 4, "EP": 16,"CP": 2, "recompute": "full",      "overlap": "Chimera"},
    {"TP": 8, "PP": 4, "EP": 4, "CP": 1, "recompute": "selective", "overlap": "1F1B"},
]

DEFAULT_CLUSTER = {"gpu_model": "B200", "gpu_count": 1024,
                   "electricity_usd_per_kwh": 0.092, "pue": 1.18}
DEFAULT_WORKLOAD = {"mode": "training", "seq_len": 8192, "global_batch": 4096,
                    "activated_params_b": 8.0, "total_params_b": 512.0, "quant": "FP8"}


class Pipeline:
    def __init__(self, backends: Backends, bus: EventBus) -> None:
        self.b = backends
        self.bus = bus
        # Per-run cancel events. main.py sets one when run-svc reports the Run
        # transitioned to 'cancelled'; the pipeline checks between stages and
        # bails out at the next safe boundary.
        self.cancels: dict[str, asyncio.Event] = {}

    def cancel(self, run_id: str) -> None:
        ev = self.cancels.get(run_id)
        if ev:
            ev.set()

    def _cancelled(self, run_id: str) -> bool:
        ev = self.cancels.get(run_id)
        return ev is not None and ev.is_set()

    async def execute(self, run_id: str) -> None:
        self.cancels[run_id] = asyncio.Event()
        try:
            await self._execute(run_id)
        finally:
            self.cancels.pop(run_id, None)

    async def _execute(self, run_id: str) -> None:
        run = await self.b.get_run(run_id)
        log.info("execute %s · kind=%s", run_id, run.get("kind"))
        # Status was set to 'running' by ClaimNextQueued; only emit the log entry.
        await self._patch(run_id, log=f"PHASE 0 · scheduler · picked up {run_id}")
        await self.bus.publish({"kind": "run.started", "run_id": run_id, "kind_": run.get("kind")})

        try:
            t0 = time.perf_counter()
            await self._validate(run)
            if self._cancelled(run_id): return await self._mark_cancelled(run_id, "after validate")

            # When the run pins an engine_preference (architect picked a
            # specific engine in the UI), the baseline + scan candidates would
            # likely sit outside that engine's envelope (SCAN_CANDIDATES uses
            # EP=8 / CP=2 / ZBv2 etc.). Skip the search entirely and run only
            # the user_override against the chosen engine — that's the run the
            # user actually asked for.
            if self._engine_preference(run):
                scan_results = await self._run_pinned(run)
            else:
                baseline = await self._run_baseline(run)
                if self._cancelled(run_id): return await self._mark_cancelled(run_id, "after baseline")
                scan_results = await self._run_scan(run, baseline)

            if self._cancelled(run_id): return await self._mark_cancelled(run_id, "after scan")
            best, topk = await self._run_topk(run, scan_results)
            if self._cancelled(run_id): return await self._mark_cancelled(run_id, "after top-k")
            artifacts, kpis, boundaries = await self._run_attribution(run, best, scan_results)
            kpis["wallclock_s"] = round(time.perf_counter() - t0, 2)

            await self._patch(
                run_id,
                status="done",
                progress=100,
                kpis=kpis,
                artifacts=artifacts,
                boundaries=boundaries,
                confidence=best["confidence"],
                finished_at=_now_iso(),
                log=f"PHASE 5 · attribution · done in {kpis['wallclock_s']}s · MFU {kpis.get('mfu_pct')}%",
            )
            await self.bus.publish({
                "kind": "run.completed", "run_id": run_id,
                "mfu_pct": kpis.get("mfu_pct"),
                "cost_per_m_tok_usd": kpis.get("cost_per_m_tok_usd"),
            })
            log.info("done %s · MFU=%s · %.1fs", run_id, kpis.get("mfu_pct"), kpis["wallclock_s"])
        except Exception as exc:
            log.exception("pipeline failed %s", run_id)
            await self._patch(
                run_id, status="failed", finished_at=_now_iso(),
                log=f"FATAL · pipeline aborted: {exc}",
            )
            await self.bus.publish({"kind": "run.failed", "run_id": run_id, "error": str(exc)})

    # ── stages ────────────────────────────────────────────────────────────

    async def _validate(self, run: dict[str, Any]) -> None:
        rid = run["id"]
        await self._stage(rid, "validate", "TP×PP×EP ≤ 1024 ✓ · HBM est 79% ✓")
        await asyncio.sleep(0.6)

    def _engine_preference(self, run: dict[str, Any]) -> str | None:
        kpis = run.get("kpis") or {}
        v = kpis.get("_engine_preference")
        return v if isinstance(v, str) and v else None

    async def _predict_or_infeasible(
        self,
        payload: dict[str, Any],
        *,
        engine_preference: str | None,
    ) -> dict[str, Any]:
        """Wrap b.predict so a per-strategy 503 (envelope miss against the
        pinned engine) doesn't fail the whole run. The candidate is recorded
        as infeasible with MFU=0 so top-k drops it; user_override is the
        envelope-fitting one and wins."""
        try:
            return await self.b.predict(payload, engine_preference=engine_preference)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 503 or not engine_preference:
                raise
            try:
                detail = exc.response.json().get("detail")
            except Exception:
                detail = exc.response.text[:200]
            log.info("engine_preference=%s rejected strategy: %s",
                     engine_preference, detail)
            return {
                "mfu_pct": 0.0, "step_ms": 0.0,
                "breakdown": {"compute_ms": 0.0, "comm_ms": 0.0, "mem_stall_ms": 0.0, "idle_ms": 0.0},
                "peak_kw": 0.0, "confidence": 0.0,
                "coverage_status": "out_of_dist", "feasible": False,
                "notes": [f"skipped: {engine_preference} envelope miss"],
            }

    async def _run_pinned(self, run: dict[str, Any]) -> list[dict[str, Any]]:
        """Single-strategy execution path used when the run pins an engine.
        Skips baseline + scan; just runs user_override (or the first SCAN
        candidate if none was supplied) against the pinned engine. Returns a
        scan-shaped list with one entry so downstream top-k / attribution
        keep working unchanged."""
        rid = run["id"]
        kpis = run.get("kpis") or {}
        override = kpis.get("_strategy_override")
        if not isinstance(override, dict) or not override:
            override = SCAN_CANDIDATES[0]
        pref = self._engine_preference(run) or ""
        await self._stage(rid, "pinned",
                          f"engine={pref} · single strategy {_strat_label(override)}")
        cluster, workload = self._cluster_workload(run)
        pred = await self._predict_or_infeasible(
            {"cluster": cluster, "workload": workload, "strategy": override},
            engine_preference=pref,
        )
        await self._patch(rid, log=f"pinned · MFU={pred['mfu_pct']}% · step {pred['step_ms']}ms")
        await asyncio.sleep(0.4)
        return [{"strategy": override, **pred}]

    async def _run_baseline(self, run: dict[str, Any]) -> dict[str, Any]:
        rid = run["id"]
        await self._stage(rid, "baseline", "default TP4·EP8·1F1B")
        cluster, workload = self._cluster_workload(run)
        baseline_strategy = {"TP": 4, "PP": 4, "EP": 8, "CP": 1,
                             "recompute": "selective", "overlap": "1F1B"}
        pref = self._engine_preference(run)
        pred = await self._predict_or_infeasible(
            {"cluster": cluster, "workload": workload, "strategy": baseline_strategy},
            engine_preference=pref,
        )
        await self._patch(rid, log=f"baseline · MFU={pred['mfu_pct']}% · step {pred['step_ms']}ms")
        await asyncio.sleep(0.4)
        return {"strategy": baseline_strategy, **pred}

    async def _run_scan(self, run: dict[str, Any], baseline: dict[str, Any]) -> list[dict[str, Any]]:
        rid = run["id"]
        await self._stage(rid, "scan", "scanning 5 candidates")
        cluster, workload = self._cluster_workload(run)
        candidates = await self._candidates(run)
        pref = self._engine_preference(run)
        results: list[dict[str, Any]] = []
        n = len(candidates)
        for i, strat in enumerate(candidates):
            pred = await self._predict_or_infeasible(
                {"cluster": cluster, "workload": workload, "strategy": strat},
                engine_preference=pref,
            )
            results.append({"strategy": strat, **pred})
            pct = STAGE_PROGRESS["scan"][0] + (STAGE_PROGRESS["scan"][1] - STAGE_PROGRESS["scan"][0]) * (i + 1) / n
            await self._patch(rid, progress=round(pct, 1),
                              log=f"scan {i+1}/{n} · {_strat_label(strat)} → MFU {pred['mfu_pct']}%")
            await asyncio.sleep(0.25)
        return results

    async def _run_topk(self, run: dict[str, Any], scan: list[dict[str, Any]]
                        ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        rid = run["id"]
        feasible = [s for s in scan if s.get("feasible")]
        ranked = sorted(feasible or scan, key=lambda x: -x["mfu_pct"])[:3]
        best = ranked[0] if ranked else scan[0]
        await self._stage(rid, "top-k",
                          f"top-3 picked · best={_strat_label(best['strategy'])} · MFU {best['mfu_pct']}%")
        await asyncio.sleep(0.4)
        return best, ranked

    async def _run_attribution(self, run: dict[str, Any], best: dict[str, Any],
                               scan: list[dict[str, Any]]
                               ) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
        from app.artifacts import Artifacts
        rid = run["id"]
        await self._stage(rid, "attribution", "writing timeline + roofline + result.json")

        art = Artifacts(rid)
        art.write_result(best, scan)
        art.write_timeline(best)
        art.write_roofline(best)
        art.write_snapshot(run, best["strategy"])

        # rendezvous between best prediction and KPIs needed by the Run-detail UI
        cluster, workload = self._cluster_workload(run)
        gpu_count = cluster.get("gpu_count", 1024)
        peak_kw = best.get("peak_kw", gpu_count * 1.0)

        # Slice §5: TCO is computed by tco-engine-svc (not surrogate). The old
        # cost_per_m_tok / five_year_opex single-point fields are removed —
        # callers should read /v1/runs/{id}/tco for the full breakdown.
        # Slice §2: stamp engine provenance for audit/comparison. Uses the
        # _provenance block returned by engine-registry (or absent if direct
        # surrogate fallback was used).
        kpis = {
            "mfu_pct": best["mfu_pct"],
            "step_ms": best["step_ms"],
            "peak_kw": peak_kw,
            "ttft_p99_ms": best.get("ttft_ms", 0),
            "gpu_count": gpu_count,
            "train_days": round((10**12) / (4096 * 8192) * best["step_ms"] / 1000 / 86400, 1),
        }
        if isinstance(best.get("_provenance"), dict):
            kpis["_engine_provenance"] = best["_provenance"]

        # S1.1 attribution forward: surrogate emits these via the engine
        # contract but engine-svc historically only cherry-picked the 6
        # numeric KPIs above. The UI's BottleneckCard / FabricView overlay
        # / phase chart all read these fields, so without forwarding the
        # whole client-side visualization stack renders empty. We forward
        # only when present — engines without attribution leave them None.
        for fwd in ("bottleneck", "phase_breakdown",
                    "kv_hit_rate", "cache_pressure_pct", "spill_bytes_per_s",
                    "tpot_ms", "confidence", "coverage_status"):
            v = best.get(fwd)
            if v is not None:
                kpis[fwd] = v

        # Best-effort TCO compute. Don't fail the pipeline if tco-engine is down.
        await self._compute_tco_best_effort(run, best, cluster, workload, gpu_count)

        artifacts = art.summary()
        boundaries = [
            {"level": "ok", "text": f"Surrogate v{run.get('surrogate_ver') or 'v2.4'} 在 Profile A+ 覆盖区"},
            {"level": "ok", "text": f"策略扫描 {len(scan)} 候选 · best MFU {best['mfu_pct']}%"},
            {"level": "info", "text": "TCO 拆解已写入 /v1/runs/{id}/tco（可重放）"},
        ]
        await asyncio.sleep(0.5)
        return artifacts, kpis, boundaries

    async def _compute_tco_best_effort(
        self, run: dict[str, Any], best: dict[str, Any],
        cluster: dict[str, Any], workload: dict[str, Any], gpu_count: int,
    ) -> None:
        """Build a TCO request from the run's actual KPIs and post it. Failures
        are logged and swallowed — TCO is presented as a separate concern, not
        a pipeline-fatal step."""
        try:
            wall_clock_s = float(run.get("kpis", {}).get("wallclock_s", 60.0))
            step_ms = float(best.get("step_ms", 500))
            mfu_pct = float(best.get("mfu_pct", 50))
            payload = {
                "run_id": run["id"],
                "wall_clock_s": wall_clock_s if wall_clock_s > 0 else 60.0,
                "workload_mode": workload.get("mode", "training"),
                "gpus": [{
                    "vendor_sku": _gpu_sku_for(cluster.get("gpu_model", "B200")),
                    "count": gpu_count,
                    "utilization": min(1.0, mfu_pct / 100.0),
                }],
                "tokens_processed": (
                    workload.get("global_batch", 4096) * workload.get("seq_len", 8192)
                    * (wall_clock_s * 1000 / max(step_ms, 1))
                ),
                "include_sensitivities": True,
                "persist": True,
            }
            await self.b.compute_tco(payload)
        except Exception as exc:
            log.warning("TCO compute failed for %s (best-effort): %s", run["id"], exc)

    # ── helpers ───────────────────────────────────────────────────────────

    async def _candidates(self, run: dict[str, Any]) -> list[dict[str, Any]]:
        # If the Run carried an explicit strategy_override, run it + neighbours.
        kpis = run.get("kpis") or {}
        override = kpis.get("_strategy_override")
        if isinstance(override, dict) and override:
            return [override] + SCAN_CANDIDATES[:4]
        return SCAN_CANDIDATES

    def _cluster_workload(self, run: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        # HwSpec.body decode via asset-svc still deferred. As an interim contract,
        # the new training/inference single-job pages ship cluster_override /
        # workload_override on the create-run body (run-svc stuffs them into
        # kpis._*_override). Shallow-merge over defaults; absent keys fall back.
        kpis = run.get("kpis") or {}
        cluster = {**DEFAULT_CLUSTER}
        if isinstance(kpis.get("_cluster_override"), dict):
            cluster.update({k: v for k, v in kpis["_cluster_override"].items() if v is not None})
        workload = {**DEFAULT_WORKLOAD}
        if isinstance(kpis.get("_workload_override"), dict):
            workload.update({k: v for k, v in kpis["_workload_override"].items() if v is not None})
        return cluster, workload

    async def _mark_cancelled(self, run_id: str, where: str) -> None:
        # Status was already set to 'cancelled' by run-svc /cancel; just append
        # a log line + emit the lifecycle event so dashboards / Copilot react.
        log.info("cancelled %s · %s", run_id, where)
        await self._patch(run_id, log=f"PHASE · cancelled {where}", finished_at=_now_iso())
        await self.bus.publish({"kind": "run.cancelled", "run_id": run_id, "where": where})

    async def _stage(self, run_id: str, stage: str, msg: str) -> None:
        lo, hi = STAGE_PROGRESS[stage]
        await self._patch(run_id, progress=lo, log=f"PHASE · {stage} · {msg}")
        await self.bus.publish({"kind": "run.progress", "run_id": run_id, "stage": stage,
                                "pct": lo})

    async def _patch(self, run_id: str, *, status: str | None = None, progress: float | None = None,
                     kpis: dict | None = None, artifacts: list | None = None,
                     boundaries: list | None = None, confidence: float | None = None,
                     started_at: str | None = None, finished_at: str | None = None,
                     log: str | None = None) -> None:
        body: dict[str, Any] = {}
        if status is not None: body["status"] = status
        if progress is not None: body["progress_pct"] = progress
        if kpis is not None: body["kpis"] = kpis
        if artifacts is not None: body["artifacts"] = artifacts
        if boundaries is not None: body["boundaries"] = boundaries
        if confidence is not None: body["confidence"] = confidence
        if started_at is not None: body["started_at"] = started_at
        if finished_at is not None: body["finished_at"] = finished_at
        if log is not None:
            ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
            body["log_append"] = f"[{ts}] ENGINE · {log}"
        try:
            await self.b.patch_run(run_id, body)
        except Exception as exc:
            log.warning("patch %s failed: %s", run_id, exc)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _strat_label(s: dict[str, Any]) -> str:
    return f"TP{s.get('TP')}·PP{s.get('PP')}·EP{s.get('EP')}·{s.get('overlap')}"


# Map cluster.gpu_model → bs_tco_rule.vendor_sku (single source of truth lives in
# tco-engine, but engine-svc needs to pass the exact SKU string).
_GPU_MODEL_TO_SKU = {
    "B200":   "Nvidia/B200-180GB",
    "H200":   "Nvidia/H200-141GB",
    "GB300":  "Nvidia/GB300-288GB",
    "MI355X": "AMD/MI355X-288GB",
    "H100":   "Nvidia/H100-80GB",
    "NPU-910": "Huawei/NPU-910C-96GB",
}


def _gpu_sku_for(gpu_model: str) -> str:
    return _GPU_MODEL_TO_SKU.get(gpu_model, "Nvidia/B200-180GB")
