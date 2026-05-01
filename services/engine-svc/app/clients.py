from __future__ import annotations

import os
from typing import Any

import httpx

from app._obs import traced_async_client


class Backends:
    def __init__(self) -> None:
        self.run = traced_async_client(
            base_url=os.environ.get("RUN_SVC_URL", "http://localhost:8081"),
            timeout=10.0,
        )
        # §2: predict() now goes through engine-registry, not surrogate-svc directly.
        # SURROGATE_URL kept as a fallback when ENGINE_REGISTRY_URL is unset
        # (single-engine deployments / tests).
        # Astra-sim's TP=16 PP=8 405B path can hit 60–90s end-to-end (chakra
        # gen + sim + parse). 180s gives ~2× margin so a slightly slow run
        # doesn't trip ReadTimeout and fail the whole pipeline.
        self.engine_registry = traced_async_client(
            base_url=os.environ.get(
                "ENGINE_REGISTRY_URL",
                os.environ.get("SURROGATE_URL", "http://localhost:8083"),
            ),
            timeout=180.0,
        )
        self.tco = traced_async_client(
            base_url=os.environ.get("TCO_SVC_URL", "http://localhost:8088"),
            timeout=5.0,
        )

    async def close(self) -> None:
        for c in (self.run, self.engine_registry, self.tco):
            await c.aclose()

    # ── run-svc helpers ──
    async def list_queued(self, limit: int = 5) -> list[dict[str, Any]]:
        r = await self.run.get("/v1/runs", params={"status": "queued", "limit": str(limit)})
        r.raise_for_status()
        return r.json()

    async def claim_next(self, project: str = "p_default") -> dict[str, Any] | None:
        """Atomically pick the next queued Run via SQL `UPDATE ... RETURNING`.
        Multiple workers race here safely; None when queue is empty."""
        r = await self.run.post("/v1/runs/claim", params={"project": project})
        if r.status_code == 204:
            return None
        r.raise_for_status()
        return r.json()

    async def get_run(self, run_id: str) -> dict[str, Any]:
        r = await self.run.get(f"/v1/runs/{run_id}")
        r.raise_for_status()
        return r.json()

    async def patch_run(self, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        r = await self.run.request("PATCH", f"/v1/runs/{run_id}", json=body)
        r.raise_for_status()
        return r.json()

    # ── §2 (RFC-001 v2): prediction via engine-registry ──────────────────
    async def predict(
        self,
        payload: dict[str, Any],
        *,
        engine_preference: str | None = None,
    ) -> dict[str, Any]:
        """Route through engine-registry-svc /v1/predict.

        `payload` is the engine-facing EnginePredictRequest body (cluster +
        workload + strategy). The registry wraps it in a routing envelope and
        forwards to the chosen engine; the response is an EnginePredictResponse
        with a `_provenance` block stamped on (RFC-001 §2.5).

        `engine_preference` pins the registry to a specific engine name. When
        the preferred engine's envelope doesn't cover the request, registry
        returns 503 — callers handle this per-call (e.g. mark a scan candidate
        as infeasible rather than failing the whole run)."""
        body: dict[str, Any] = {"payload": payload}
        if engine_preference:
            body["engine_preference"] = engine_preference
        r = await self.engine_registry.post("/v1/predict", json=body)
        r.raise_for_status()
        return r.json()

    # ── §5 TCO ──
    async def compute_tco(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Best-effort: pipeline runs to completion even if TCO svc is down."""
        r = await self.tco.post("/v1/tco/compute", json=payload)
        r.raise_for_status()
        return r.json()
