"""asyncpg wrapper for bs_engine — RFC-001 v2 (M2 cutover, no v1 compat).

Reads/writes only the v2 columns (`fidelity`, `coverage_envelope`,
`kpi_outputs`, `calibration`). The v1 columns (`domain`, `granularity`,
`capabilities`) are dropped by migration 021. Bootstrap rows from 011/019
are removed; engines self-register on boot via shared.engine_runtime.
"""
from __future__ import annotations

import json
import os
from typing import Any

import asyncpg


class Store:
    def __init__(self) -> None:
        self.pool: asyncpg.Pool | None = None
        self.dsn = os.environ.get("PG_DSN", "postgres://bytesim:bytesim@localhost:5432/bytesim")

    async def open(self) -> None:
        async def _init(conn: asyncpg.Connection) -> None:
            for typ in ("json", "jsonb"):
                await conn.set_type_codec(
                    typ,
                    encoder=lambda v: v if isinstance(v, str) else json.dumps(v),
                    decoder=json.loads,
                    schema="pg_catalog",
                )
            await conn.set_type_codec(
                "numeric", encoder=str, decoder=float,
                schema="pg_catalog", format="text",
            )

        self.pool = await asyncpg.create_pool(self.dsn, init=_init, min_size=1, max_size=4)

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()

    # ── Reads ────────────────────────────────────────────────────────────

    async def list_engines(self, *, status: str | None = "active") -> list[dict[str, Any]]:
        assert self.pool
        q = "SELECT * FROM bs_engine"
        args: list[Any] = []
        if status:
            q += f" WHERE status = ${len(args) + 1}"
            args.append(status)
        q += " ORDER BY fidelity DESC, sla_p99_ms ASC, name"
        rows = await self.pool.fetch(q, *args)
        return [_norm(r) for r in rows]

    async def get_engine(self, name: str) -> dict[str, Any] | None:
        assert self.pool
        r = await self.pool.fetchrow("SELECT * FROM bs_engine WHERE name=$1", name)
        return _norm(r) if r else None

    # ── Writes ───────────────────────────────────────────────────────────

    async def upsert_engine(
        self, *,
        name: str, version: str, fidelity: str, sla_p99_ms: int,
        endpoint: str, predict_path: str,
        coverage_envelope: dict[str, Any],
        kpi_outputs: list[str],
        calibration: dict[str, Any] | None = None,
        notes: str | None = None,
    ) -> dict[str, Any]:
        """Idempotent registration. Same name → updates fields + flips
        status to 'active' + bumps last_seen_at. Used by the SDK
        register-on-boot path."""
        assert self.pool
        await self.pool.execute(
            """INSERT INTO bs_engine
                 (name, version, fidelity, sla_p99_ms, endpoint, predict_path,
                  coverage_envelope, kpi_outputs, calibration, notes,
                  status, last_seen_at)
               VALUES ($1,$2,$3,$4,$5,$6, $7::jsonb, $8::text[], $9::jsonb, $10,
                       'active', now())
               ON CONFLICT (name) DO UPDATE SET
                 version           = EXCLUDED.version,
                 fidelity          = EXCLUDED.fidelity,
                 sla_p99_ms        = EXCLUDED.sla_p99_ms,
                 endpoint          = EXCLUDED.endpoint,
                 predict_path      = EXCLUDED.predict_path,
                 coverage_envelope = EXCLUDED.coverage_envelope,
                 kpi_outputs       = EXCLUDED.kpi_outputs,
                 calibration       = EXCLUDED.calibration,
                 notes             = EXCLUDED.notes,
                 status            = 'active',
                 last_seen_at      = now()""",
            name, version, fidelity, sla_p99_ms, endpoint, predict_path,
            json.dumps(coverage_envelope), list(kpi_outputs),
            json.dumps(calibration or {}), notes,
        )
        return await self.get_engine(name)  # type: ignore[return-value]

    async def deprecate(self, name: str) -> bool:
        assert self.pool
        result = await self.pool.execute(
            "UPDATE bs_engine SET status='deprecated' WHERE name=$1 AND status='active'",
            name,
        )
        return result.endswith(" 1")

    async def heartbeat(self, name: str) -> bool:
        """Refresh last_seen_at. Returns True if an active row was touched.
        404 from the HTTP layer when False so the engine knows to re-register."""
        assert self.pool
        result = await self.pool.execute(
            "UPDATE bs_engine SET last_seen_at=now() WHERE name=$1 AND status='active'",
            name,
        )
        return result.endswith(" 1")

    async def set_calibration(self, name: str, calibration: dict[str, Any]) -> bool:
        """RFC-004 — calibration-svc PATCHes here after each reconcile so the
        selector's mape tiebreaker stops using a default `99.0`. Returns
        False if the engine is unknown (caller emits 404)."""
        assert self.pool
        result = await self.pool.execute(
            "UPDATE bs_engine SET calibration=$2::jsonb WHERE name=$1",
            name, json.dumps(calibration),
        )
        return result.endswith(" 1")

    async def disable_stale(self, threshold_seconds: int = 90) -> list[str]:
        """Sweep engines whose last_seen_at is older than threshold; mark
        disabled and return their names. Called by the registry's background
        task every 30s."""
        assert self.pool
        rows = await self.pool.fetch(
            """UPDATE bs_engine SET status='disabled'
                WHERE status='active'
                  AND (last_seen_at IS NULL
                       OR last_seen_at < now() - ($1 || ' seconds')::interval)
              RETURNING name""",
            str(threshold_seconds),
        )
        return [r["name"] for r in rows]


def _norm(r: asyncpg.Record | None) -> dict[str, Any] | None:
    if r is None:
        return None
    out: dict[str, Any] = {}
    for k, v in dict(r).items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        elif isinstance(v, str) and v.startswith(("{", "[")):
            try:
                out[k] = json.loads(v)
            except Exception:
                out[k] = v
        else:
            out[k] = v
    return out
