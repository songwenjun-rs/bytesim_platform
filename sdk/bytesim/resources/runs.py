"""Runs — the most-touched resource. Mirrors BFF /v1/runs/* and /v1/plans/*."""
from __future__ import annotations

from typing import Any, Iterator, TYPE_CHECKING

if TYPE_CHECKING:
    from ..client import Client


class Runs:
    def __init__(self, client: "Client") -> None:
        self._c = client

    def list(
        self,
        *,
        status: str | None = None,
        kind: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """List runs in the active project. `status` accepts comma-separated
        values like 'running,queued'."""
        # /v1/runs is on run-svc, but we hit BFF — there is no BFF wrapper for
        # bare list yet, so go via dashboard-equivalent: BFF's dashboard
        # already runs the project-scoped list; for direct access we'd need a
        # dedicated /v1/runs proxy. For slice 16 we expose the dashboard
        # aggregator here; can split later.
        d = self._c.get("/v1/dashboard")
        items = d.get("recent", []) if status is None else (
            d.get("running", []) if "running" in status or "queued" in status else d.get("failed", [])
        )
        if kind:
            items = [r for r in items if r.get("kind") == kind]
        return items[:limit]

    def get(self, run_id: str) -> dict[str, Any]:
        """Single run, raw row only (no specs/lineage)."""
        return self._c.get(f"/v1/runs/{run_id}")

    def get_full(self, run_id: str) -> dict[str, Any]:
        """Run + specs + lineage in one round-trip — what the detail page uses."""
        return self._c.get(f"/v1/runs/{run_id}/full")

    def create(
        self,
        *,
        hwspec_hash: str,
        model_hash: str,
        strategy_hash: str | None = None,
        workload_hash: str | None = None,
        kind: str = "train",
        title: str | None = None,
        parent_run_id: str | None = None,
        derived_from_study: str | None = None,
        derived_from_trial: int | None = None,
        strategy_override: dict[str, Any] | None = None,
        surrogate_ver: str | None = None,
        budget_gpuh: float | None = None,
        created_by: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"hwspec_hash": hwspec_hash, "model_hash": model_hash, "kind": kind}
        if strategy_hash: body["strategy_hash"] = strategy_hash
        if workload_hash: body["workload_hash"] = workload_hash
        if title: body["title"] = title
        if parent_run_id: body["parent_run_id"] = parent_run_id
        if derived_from_study: body["derived_from_study"] = derived_from_study
        if derived_from_trial is not None: body["derived_from_trial"] = derived_from_trial
        if strategy_override: body["strategy_override"] = strategy_override
        if surrogate_ver: body["surrogate_ver"] = surrogate_ver
        if budget_gpuh is not None: body["budget_gpuh"] = budget_gpuh
        if created_by or self._c.actor_id:
            body["created_by"] = created_by or self._c.actor_id
        return self._c.post("/v1/runs", body)

    def cancel(self, run_id: str) -> dict[str, Any]:
        """Cancel a queued or running run. Returns {was_running: bool, ...}.
        engine-svc workers see the Kafka event within ~1 round-trip."""
        return self._c.post(f"/v1/runs/{run_id}/cancel")

    def kick(self, run_id: str) -> dict[str, Any]:
        """Nudge engine-svc to pick up this run immediately (otherwise it
        polls every ~2s). Idempotent."""
        return self._c.post(f"/v1/runs/{run_id}/kick")

    def tail(self, run_id: str) -> Iterator[str]:
        """Stream engine.log line-by-line. Blocks until the run finishes or
        the connection is closed."""
        path = f"/v1/streams/runs/{run_id}/log"
        # SSE-style stream — yield raw lines.
        yield from self._c.stream_lines("GET", path)
