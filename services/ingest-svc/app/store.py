"""asyncpg wrapper for bs_production_snapshot + bs_snapshot_consumed_by."""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any

import asyncpg


class Store:
    def __init__(self) -> None:
        self.pool: asyncpg.Pool | None = None
        self.dsn = os.environ.get("PG_DSN", "postgres://bytesim:bytesim@localhost:5432/bytesim")

    async def open(self) -> None:
        # asyncpg returns JSONB columns as str by default; register a codec
        # so reads come back as Python dict/list directly. Encoder accepts
        # both dict (newly written) and str (back-compat with existing call
        # sites that already json.dumps before passing — stays a no-op there).
        async def _init(conn: asyncpg.Connection) -> None:
            for typ in ("json", "jsonb"):
                await conn.set_type_codec(
                    typ,
                    encoder=lambda v: v if isinstance(v, str) else json.dumps(v),
                    decoder=json.loads,
                    schema="pg_catalog",
                )
            # NUMERIC → float (asyncpg defaults to Decimal which trips json.dumps
            # in audit writes / mixed-type arithmetic in trainer code paths).
            await conn.set_type_codec(
                "numeric",
                encoder=str,
                decoder=float,
                schema="pg_catalog",
                format="text",
            )

        self.pool = await asyncpg.create_pool(self.dsn, init=_init, min_size=1, max_size=4)

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()

    async def insert_snapshot(
        self, *, snapshot_id: str, project_id: str, name: str,
        source_kind: str, source_adapter: str,
        storage_uri: str, sha256: str, row_count: int, bytes_: int,
        period_start: datetime, period_end: datetime,
        hardware_scope: dict[str, Any], workload_scope: dict[str, Any],
        redaction: dict[str, Any], imported_by: str,
        retention_until: datetime | None, notes: str | None,
    ) -> dict[str, Any]:
        assert self.pool
        await self.pool.execute(
            """INSERT INTO bs_production_snapshot
               (id, project_id, name, source_kind, source_adapter, storage_uri,
                sha256, row_count, bytes, covers_period,
                hardware_scope, workload_scope, redaction,
                imported_by, retention_until, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                       tstzrange($10,$11,'[]'),
                       $12::jsonb,$13::jsonb,$14::jsonb,
                       $15,$16,$17)""",
            snapshot_id, project_id, name, source_kind, source_adapter, storage_uri,
            sha256, row_count, bytes_, period_start, period_end,
            json.dumps(hardware_scope), json.dumps(workload_scope), json.dumps(redaction),
            imported_by, retention_until, notes,
        )
        return await self.get_snapshot(snapshot_id)  # type: ignore[return-value]

    async def get_snapshot(self, snapshot_id: str) -> dict[str, Any] | None:
        assert self.pool
        r = await self.pool.fetchrow(
            "SELECT * FROM bs_production_snapshot WHERE id=$1", snapshot_id,
        )
        return _norm(r) if r else None

    async def list_snapshots(
        self, *, project_id: str | None = None, status: str | None = None,
        source_kind: str | None = None, limit: int = 50,
    ) -> list[dict[str, Any]]:
        assert self.pool
        q = "SELECT * FROM bs_production_snapshot WHERE 1=1"
        args: list[Any] = []
        if project_id:
            q += f" AND project_id=${len(args)+1}"
            args.append(project_id)
        if status:
            q += f" AND status=${len(args)+1}"
            args.append(status)
        if source_kind:
            q += f" AND source_kind=${len(args)+1}"
            args.append(source_kind)
        q += f" ORDER BY imported_at DESC LIMIT ${len(args)+1}"
        args.append(limit)
        rows = await self.pool.fetch(q, *args)
        return [_norm(r) for r in rows]

    async def approve(self, snapshot_id: str, approved_by: str) -> bool:
        assert self.pool
        result = await self.pool.execute(
            "UPDATE bs_production_snapshot "
            "SET status='approved', approved_by=$1, approved_at=now() "
            "WHERE id=$2 AND status='pending_review'",
            approved_by, snapshot_id,
        )
        return result.endswith(" 1")

    async def reject(self, snapshot_id: str, approved_by: str, reason: str | None) -> bool:
        assert self.pool
        notes_addendum = f"rejected by {approved_by}: {reason or '(no reason)'}"
        result = await self.pool.execute(
            "UPDATE bs_production_snapshot "
            "SET status='rejected', approved_by=$1, approved_at=now(), "
            "    notes=COALESCE(notes,'') || E'\\n' || $2 "
            "WHERE id=$3 AND status='pending_review'",
            approved_by, notes_addendum, snapshot_id,
        )
        return result.endswith(" 1")

    async def record_consumer(
        self, snapshot_id: str, consumer_kind: str, consumer_id: str,
    ) -> None:
        assert self.pool
        await self.pool.execute(
            "INSERT INTO bs_snapshot_consumed_by "
            "(snapshot_id, consumer_kind, consumer_id) "
            "VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            snapshot_id, consumer_kind, consumer_id,
        )

    async def list_consumers(self, snapshot_id: str) -> list[dict[str, Any]]:
        assert self.pool
        rows = await self.pool.fetch(
            "SELECT * FROM bs_snapshot_consumed_by WHERE snapshot_id=$1 "
            "ORDER BY consumed_at DESC",
            snapshot_id,
        )
        return [_norm(r) for r in rows]


def _norm(r: asyncpg.Record | None) -> dict[str, Any] | None:
    if r is None:
        return None
    out: dict[str, Any] = {}
    for k, v in dict(r).items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        elif hasattr(v, "lower") and hasattr(v, "upper") and not isinstance(v, str):
            # tstzrange — render as {lower, upper}
            out[k] = {
                "lower": v.lower.isoformat() if v.lower else None,
                "upper": v.upper.isoformat() if v.upper else None,
            }
        elif isinstance(v, str) and v.startswith(("{", "[")):
            try:
                out[k] = json.loads(v)
            except Exception:
                out[k] = v
        else:
            out[k] = v
    return out
