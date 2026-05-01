"""asyncpg wrapper for bs_tco_rule / bs_tco_breakdown."""
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

    async def get_rule(self, rule_id: str) -> dict[str, Any] | None:
        assert self.pool
        r = await self.pool.fetchrow("SELECT * FROM bs_tco_rule WHERE id=$1", rule_id)
        return dict(r) if r else None

    async def find_rule(self, resource_kind: str, vendor_sku: str | None) -> dict[str, Any] | None:
        """Pick the most-recent effective rule for a (kind, sku). Falls back to
        kind-only match when sku is None or unmatched."""
        assert self.pool
        if vendor_sku:
            r = await self.pool.fetchrow(
                "SELECT * FROM bs_tco_rule WHERE resource_kind=$1 AND vendor_sku=$2 "
                "ORDER BY created_at DESC LIMIT 1",
                resource_kind, vendor_sku,
            )
            if r:
                return dict(r)
        r = await self.pool.fetchrow(
            "SELECT * FROM bs_tco_rule WHERE resource_kind=$1 ORDER BY created_at DESC LIMIT 1",
            resource_kind,
        )
        return dict(r) if r else None

    async def list_rules(self, resource_kind: str | None = None) -> list[dict[str, Any]]:
        assert self.pool
        if resource_kind:
            rows = await self.pool.fetch(
                "SELECT * FROM bs_tco_rule WHERE resource_kind=$1 ORDER BY id", resource_kind,
            )
        else:
            rows = await self.pool.fetch("SELECT * FROM bs_tco_rule ORDER BY resource_kind, id")
        return [dict(r) for r in rows]

    async def upsert_breakdown(self, run_id: str, body: dict[str, Any]) -> None:
        """Idempotent: re-running TCO compute on the same run replaces the row."""
        assert self.pool
        await self.pool.execute(
            """INSERT INTO bs_tco_breakdown
               (run_id, hw_capex_amortized_usd, power_opex_usd, cooling_opex_usd,
                network_opex_usd, storage_opex_usd, kvcache_storage_opex_usd,
                failure_penalty_usd, total_usd,
                per_m_token_usd, per_gpu_hour_usd, per_inference_request_usd,
                rule_versions, sensitivities)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)
               ON CONFLICT (run_id) DO UPDATE SET
                 hw_capex_amortized_usd = EXCLUDED.hw_capex_amortized_usd,
                 power_opex_usd         = EXCLUDED.power_opex_usd,
                 cooling_opex_usd       = EXCLUDED.cooling_opex_usd,
                 network_opex_usd       = EXCLUDED.network_opex_usd,
                 storage_opex_usd       = EXCLUDED.storage_opex_usd,
                 kvcache_storage_opex_usd = EXCLUDED.kvcache_storage_opex_usd,
                 failure_penalty_usd    = EXCLUDED.failure_penalty_usd,
                 total_usd              = EXCLUDED.total_usd,
                 per_m_token_usd        = EXCLUDED.per_m_token_usd,
                 per_gpu_hour_usd       = EXCLUDED.per_gpu_hour_usd,
                 per_inference_request_usd = EXCLUDED.per_inference_request_usd,
                 rule_versions          = EXCLUDED.rule_versions,
                 sensitivities          = EXCLUDED.sensitivities,
                 computed_at            = now()""",
            run_id,
            body["hw_capex_amortized_usd"], body["power_opex_usd"], body["cooling_opex_usd"],
            body["network_opex_usd"], body["storage_opex_usd"],
            body.get("kvcache_storage_opex_usd", 0.0),
            body["failure_penalty_usd"],
            body["total_usd"], body["per_m_token_usd"], body["per_gpu_hour_usd"],
            body["per_inference_request_usd"],
            json.dumps(body["rule_versions"]),
            json.dumps(body.get("sensitivities", {})),
        )

    async def get_breakdown(self, run_id: str) -> dict[str, Any] | None:
        assert self.pool
        r = await self.pool.fetchrow("SELECT * FROM bs_tco_breakdown WHERE run_id=$1", run_id)
        if not r:
            return None
        out = dict(r)
        # asyncpg returns numeric as Decimal; convert for JSON
        for k, v in list(out.items()):
            if hasattr(v, "isoformat"):
                out[k] = v.isoformat()
            elif isinstance(v, (int, float)) or v is None:
                pass
            elif hasattr(v, "__float__"):
                out[k] = float(v)
            elif isinstance(v, str) and v.startswith(("{", "[")):
                try:
                    out[k] = json.loads(v)
                except Exception:
                    pass
        return out
