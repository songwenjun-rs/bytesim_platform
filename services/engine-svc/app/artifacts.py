"""Artifact writer. Mirrors slice-1's `infra/artifacts/sim-7f2a/*` shape so the
Run-detail UI can consume any engine-produced Run unchanged."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


ARTIFACTS_ROOT = Path(os.environ.get("ARTIFACTS_DIR", "/artifacts"))


class Artifacts:
    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.dir = ARTIFACTS_ROOT / run_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self._files: list[tuple[str, str, int, str]] = []  # (label, file, bytes, icon)

    def write_result(self, best: dict[str, Any], scan: list[dict[str, Any]]) -> None:
        # RFC-001 v2 dropped cost_per_m_tok_usd from the EnginePredictResponse
        # contract — TCO is tco-engine-svc's job, not the engine's. Use .get()
        # with 0 default so this writer keeps working against any engine
        # (analytical or cycle-accurate). UI's TCO breakdown reads from the
        # /v1/runs/{id}/tco endpoint, not from this artifact.
        body = {
            "run_id": self.run_id,
            "best_strategy": best["strategy"],
            "best_prediction": {k: v for k, v in best.items() if k != "strategy"},
            "topk": [
                {
                    "rank": i + 1,
                    **s["strategy"],
                    "mfu_pct": s["mfu_pct"],
                    "cost_per_m_tok_usd": s.get("cost_per_m_tok_usd", 0.0),
                    "feasible": s.get("feasible"),
                    "violations": s.get("notes"),
                }
                for i, s in enumerate(sorted(scan, key=lambda x: -x["mfu_pct"])[:5])
            ],
        }
        self._dump("result.json", body, label="结果 JSON（完整）", icon="🧾")

    def write_timeline(self, best: dict[str, Any]) -> None:
        # Synthetic 1F1B timeline: 4 stages × 4 microbatches with overlapped comm.
        step = best["step_ms"]
        per_microbatch = step / 4
        events = []
        for stage in range(4):
            for mb in range(4):
                t = (stage + mb) * per_microbatch / 2
                events.append({
                    "stage": f"pp{stage}", "microbatch": mb,
                    "phase": "fwd", "t_start": round(t, 2),
                    "t_end": round(t + per_microbatch * 0.4, 2),
                })
                events.append({
                    "stage": f"pp{stage}", "microbatch": mb,
                    "phase": "bwd", "t_start": round(t + per_microbatch * 0.5, 2),
                    "t_end": round(t + per_microbatch * 0.9, 2),
                })
        self._dump("timeline.json", {"events": events, "step_ms": step,
                                     "synthetic": True, "engine": "slice-10-1F1B"},
                   label="Timeline 切片 (Perfetto JSON)", icon="📈")

    def write_roofline(self, best: dict[str, Any]) -> None:
        # 6 sample kernels — half compute-bound, half bandwidth-bound.
        kernels = [
            {"name": "flash_attn_bwd_d128", "tflops": 5.1, "hbm_gb": 18.4, "bound": "compute"},
            {"name": "grouped_gemm_bf16",   "tflops": 6.8, "hbm_gb":  8.2, "bound": "compute"},
            {"name": "fused_moe_a2a",       "tflops": 0.3, "hbm_gb": 42.1, "bound": "comm"},
            {"name": "layernorm_bwd",       "tflops": 0.2, "hbm_gb": 12.1, "bound": "memory"},
            {"name": "rope_fwd",            "tflops": 0.1, "hbm_gb":  6.4, "bound": "memory"},
            {"name": "softmax_bwd",         "tflops": 0.4, "hbm_gb":  9.8, "bound": "memory"},
        ]
        self._dump("roofline.json",
                   {"kernels": kernels, "best_mfu_pct": best["mfu_pct"]},
                   label="Roofline 数据集", icon="📐")

    def write_snapshot(self, run: dict[str, Any], strategy: dict[str, Any]) -> None:
        snap = {
            "inputs_hash": run.get("inputs_hash"),
            "strategy_used": strategy,
            "surrogate_version": run.get("surrogate_ver"),
            "engine": "slice-10-pipeline",
        }
        self._dump("snapshot.json", snap, label="输入快照（hash）", icon="🔁")

    def summary(self) -> list[dict[str, Any]]:
        return [
            {"name": label, "file": fname, "bytes": size, "icon": icon}
            for label, fname, size, icon in self._files
        ]

    # ── internals ────────────────────────────────────────────────────────

    def _dump(self, fname: str, body: Any, *, label: str, icon: str = "📄") -> None:
        path = self.dir / fname
        text = json.dumps(body, ensure_ascii=False, indent=2)
        path.write_text(text, encoding="utf-8")
        size = path.stat().st_size
        self._files.append((label, fname, size, icon))
